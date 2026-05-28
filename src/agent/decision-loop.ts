// Decision loop — 3 min ± 30s. See spec §2.5.
// Read-only phase → ask Claude → validate → quote → ACQUIRE MUTEX → recheck all gates → execute.
// The recheck-after-acquire is the §2.3 TOCTOU fix: safety loop may flip any gate
// between the pre-mutex checks and execution. Reads stay concurrent; only trade-issuing
// sections hold the lock.
import {
  isKillSwitchTriggered, isPaused,
  countTradesInWindow, listOpenPositions,
  insertDecision, insertError, nowUtc,
  type PositionRow,
} from '../observability/db.js';
import { SAFETY, HEARTBEAT_MAX_AGE_HOURS } from '../config.js';
import { heartbeatAgeHours } from './heartbeat.js';
import { tradeMutex } from './mutex.js';
import { DecisionSchema, type Decision } from './schemas.js';
import { buildDecisionPrompt, formatPortfolioForPrompt } from './prompts.js';
import type { UniverseToken } from '../execution/universe.js';
import type { Quote } from '../execution/jupiter-quote.js';

// ── Injectable dependencies ────────────────────────────────────────────────────
// All async I/O (network, LLM, wallet) is injected so tests can run without
// real APIs and can control timing for concurrency scenarios.

export interface DecisionCycleDeps {
  /** Current SOL balance for gas reserve check. */
  getSolBalance(): Promise<number>;
  /** Token balance in wallet (tokens, not USDC). Used for EXIT sizing. */
  getWalletTokenBalance(token: string): Promise<number>;
  /** Rebuild the liquidity+adversarial-filtered universe. Called twice: once
   *  outside mutex (fast path) and once inside (recheck for OPEN/ADD). */
  buildUniverse(): Promise<UniverseToken[]>;
  /** Fetch market signals for the universe. Returns pre-formatted string. */
  getSignals(universe: UniverseToken[]): Promise<string>;
  /** Recent decisions formatted for the prompt. Returns plain text. */
  getRecentDecisions(n: number): string;
  /** Call Claude — returns raw response string (markdown-fences stripped). */
  askClaude(prompt: string): Promise<string>;
  /** Fetch pre-trade quote. sizeTokens non-null on EXIT (sell exact balance). */
  getQuote(token: string, sizeUsdc: number | undefined, sizeTokens: number | undefined): Promise<Quote>;
  /** Execute the trade inside the mutex. Throws on pipeline failure. */
  executeTx(decisionId: number, decision: Decision, quote: Quote): Promise<void>;
  /** Alert / log (Telegram Day 4b / console fallback). */
  alert(msg: string): Promise<void>;
}

// ── One decision cycle — spec §2.5 ───────────────────────────────────────────

export async function runDecisionCycle(deps: DecisionCycleDeps): Promise<void> {

  // ── Read-only phase: fast gates (no mutex) ──────────────────────────────────

  if (isKillSwitchTriggered()) {
    logSkip('kill switch triggered');
    return;
  }

  if (countTradesInWindow(24 * 3600) >= SAFETY.DAILY_TRADE_CAP) {
    logSkip('daily trade cap hit');
    return;
  }

  if (heartbeatAgeHours() > HEARTBEAT_MAX_AGE_HOURS) {
    logSkip('heartbeat stale (>12h)');
    return;
  }

  const solBalance = await deps.getSolBalance();
  if (solBalance < SAFETY.SOL_RESERVE_FLOOR) {
    logSkip(`SOL reserve low (${solBalance.toFixed(4)} < ${SAFETY.SOL_RESERVE_FLOOR})`);
    return;
  }

  const positions: PositionRow[] = listOpenPositions();
  const universe = await deps.buildUniverse();

  // Fail-closed: no universe AND no positions to manage → nothing to do
  if (universe.length === 0 && positions.length === 0) {
    logSkip('universe empty (fail-closed) and no open positions');
    return;
  }

  const signals = await deps.getSignals(universe);
  const recentDecisions = deps.getRecentDecisions(5);

  // Pause blocks OPEN/ADD but still allows EXIT (§1 pause semantics)
  const allowedActions: string[] = isPaused()
    ? ['HOLD_ALL', 'EXIT']
    : ['HOLD_ALL', 'EXIT', 'OPEN', 'ADD'];

  const prompt = buildDecisionPrompt({
    portfolioJson: formatPortfolioForPrompt(positions),
    universeJson: JSON.stringify(universe.map(t => ({ symbol: t.symbol, mint: t.mint, marketCapUsd: t.marketCapUsd, volume24hUsd: t.volume24hUsd })), null, 2),
    signalsJson: signals,
    allowedActions,
    recentDecisionsWithPnl: recentDecisions,
    currentUtcTime: nowUtc(),
  });

  // ── Ask Claude ────────────────────────────────────────────────────────────

  let rawResponse: string;
  try {
    rawResponse = await deps.askClaude(prompt);
  } catch (err) {
    insertError('decision-loop', `Claude API error: ${String(err)}`);
    return;
  }

  // Parse JSON. Malformed → HOLD_ALL (never throw).
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    insertError('decision-loop', `Malformed JSON from LLM: ${rawResponse.slice(0, 200)}`);
    return;
  }

  const result = DecisionSchema.safeParse(parsed);
  if (!result.success) {
    insertError('decision-loop', `Schema validation failed: ${JSON.stringify(result.error.issues)}`);
    return;
  }

  const decision = result.data;

  // Record decision in DB (executed=false until trade fires)
  const decisionId = insertDecision({
    timestamp_utc: nowUtc(),
    action: decision.action,
    token: decision.token ?? null,
    size_usdc: decision.size_usdc ?? null,
    thesis: decision.thesis,
    invalidation: decision.invalidation,
    expected_move_pct: decision.expected_move_pct,
    confidence: decision.confidence,
    validated: true,
    executed: false,
  });

  if (decision.action === 'HOLD_ALL') return;

  // Verify action is allowed under current pause state
  if (!allowedActions.includes(decision.action)) {
    logSkip(`action ${decision.action} not allowed under current pause state`);
    return;
  }

  // ── Action-state consistency checks ─────────────────────────────────────

  const token = decision.token!;

  // EXIT: must have non-zero wallet balance (sells full balance — dust-safe)
  let exitWalletTokens: number | undefined;
  if (decision.action === 'EXIT') {
    exitWalletTokens = await deps.getWalletTokenBalance(token);
    if (exitWalletTokens === 0) {
      insertError('decision-loop', `EXIT on ${token} with zero wallet balance`);
      return;
    }
  }

  // OPEN: no existing position on this token; not at max positions
  if (decision.action === 'OPEN') {
    if (positions.find(p => p.token === token)) {
      insertError('decision-loop', `OPEN on ${token}: position already exists — should have used ADD`);
      return;
    }
    if (positions.length >= SAFETY.MAX_CONCURRENT_POSITIONS) {
      logSkip('max concurrent positions reached');
      return;
    }
  }

  // ADD: existing position required
  if (decision.action === 'ADD') {
    if (!positions.find(p => p.token === token)) {
      insertError('decision-loop', `ADD on ${token}: no existing position — should have used OPEN`);
      return;
    }
  }

  // Universe membership check for OPEN/ADD — EXIT always allowed regardless
  if (decision.action === 'OPEN' || decision.action === 'ADD') {
    if (!universe.find(t => t.symbol === token)) {
      insertError('decision-loop', `Token ${token} not in current universe for entry`);
      return;
    }
  }

  // ── Pre-trade quote (outside mutex — don't hold lock during slow RPC) ────

  let quote: Quote;
  try {
    quote = await deps.getQuote(
      token,
      decision.action === 'EXIT' ? undefined : decision.size_usdc,
      decision.action === 'EXIT' ? exitWalletTokens : undefined,
    );
  } catch (err) {
    insertError('decision-loop', `Quote fetch failed for ${token}: ${String(err)}`);
    return;
  }

  if (!quote.withinBudget) {
    logSkip(`quote cost ${(quote.totalCostPct * 100).toFixed(3)}% exceeds 1.5% one-way budget`);
    return;
  }

  // ── Write phase: acquire mutex and recheck all gates (§2.3 TOCTOU fix) ────
  // Safety loop runs every 15s and may have flipped any gate since the reads above.
  // Everything inside runExclusive is serialized against the safety loop's trade actions.

  await tradeMutex.runExclusive(async () => {
    // Recheck: gates that could have been tripped by the safety loop
    if (isKillSwitchTriggered()) {
      logSkip('kill switch triggered (recheck inside mutex)');
      return;
    }
    if (countTradesInWindow(24 * 3600) >= SAFETY.DAILY_TRADE_CAP) {
      logSkip('daily trade cap hit (recheck inside mutex)');
      return;
    }
    if (await deps.getSolBalance() < SAFETY.SOL_RESERVE_FLOOR) {
      logSkip('SOL reserve low (recheck inside mutex)');
      return;
    }

    // OPEN/ADD rechecks (pause + universe membership)
    if (decision.action === 'OPEN' || decision.action === 'ADD') {
      if (isPaused()) {
        logSkip(`${decision.action} blocked — paused (recheck inside mutex)`);
        return;
      }
      const recheckUniverse = await deps.buildUniverse();
      if (!recheckUniverse.find(t => t.symbol === token)) {
        logSkip(`token ${token} left universe between decision and execution`);
        return;
      }
    }

    // OPEN additional recheck: max positions (another cycle may have added one)
    if (decision.action === 'OPEN') {
      if (listOpenPositions().length >= SAFETY.MAX_CONCURRENT_POSITIONS) {
        logSkip('max positions (recheck inside mutex)');
        return;
      }
    }

    await deps.executeTx(decisionId, decision, quote);
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function logSkip(reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[decision-loop] skip — ${reason}`);
}
