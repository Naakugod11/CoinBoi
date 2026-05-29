// Reconciler — startup-blocking + 5-min periodic. See spec §2.10.
// "The single most important safety mechanism after the hard stop."
// Resolves pending intents, diffs DB positions vs on-chain wallet balances.
// Any mismatch → pause + alert. Never trades on dirty state.
import {
  getPendingIntents, getIntent, updateIntent,
  listOpenPositions, getPositionByToken,
  nowUtc, insertError, setPaused, setFlag,
  type IntentRow, type PositionRow,
} from '../observability/db.js';
import { applyTradeToPosition } from '../execution/portfolio.js';

// ── Dust threshold (spec §2.10) ───────────────────────────────────────────────

const DUST_VALUE_USDC = 0.50;

// ── Injectable dependencies ───────────────────────────────────────────────────

export interface WalletBalance {
  /** USDC balance in wallet */
  usdcBalance: number;
  /** SOL balance */
  solBalance: number;
  /** All SPL token balances */
  tokens: Array<{ mint: string; uiBalance: number }>;
}

export interface ReconcilerDeps {
  /** Fetch on-chain wallet balances. */
  getWalletBalances(): Promise<WalletBalance>;
  /** Query tx status from Helius. Returns 'finalized' | 'failed' | 'unknown'. */
  checkTxStatus(sig: string): Promise<'finalized' | 'failed' | 'unknown'>;
  /** Parse on-chain swap to get actual amounts (same as tx-pipeline). */
  parseSwap(sig: string): Promise<{ usdcAmount: number; tokenAmount: number; feeUsdc: number }>;
  /** Canonical price for a token (for dust evaluation). Returns null if unavailable. */
  canonicalPrice(mint: string, sizeTokens: number): Promise<number | null>;
  /** Alert function. */
  alert(msg: string): Promise<void>;
}

export interface ReconcileResult {
  pendingIntentsResolved: number;
  stuckIntentsFound: number;
  positionMismatches: number;
  untrackedTokens: string[];
  clean: boolean;
}

// ── STUCK threshold (spec §2.10) ──────────────────────────────────────────────
const STUCK_AFTER_MS = 10 * 60 * 1000; // 10 minutes

// ── runReconciler — spec §2.10 ────────────────────────────────────────────────

export async function runReconciler(deps: ReconcilerDeps): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    pendingIntentsResolved: 0,
    stuckIntentsFound: 0,
    positionMismatches: 0,
    untrackedTokens: [],
    clean: true,
  };

  // ── Step 3: Resolve pending intents ───────────────────────────────────────
  const pendingIntents = getPendingIntents();
  for (const intent of pendingIntents) {
    await resolvePendingIntent(intent, deps, result);
  }

  // ── Steps 4–5: Diff positions vs wallet ──────────────────────────────────
  let wallet: WalletBalance;
  try {
    wallet = await deps.getWalletBalances();
  } catch (err) {
    insertError('reconciler', 'Failed to fetch wallet balances', String(err));
    await triggerMismatch(deps, 'Could not fetch wallet balances — treating as mismatch', result);
    return result;
  }

  // Step 4: every open position must match wallet balance within dust tolerance
  const openPositions = listOpenPositions();
  for (const pos of openPositions) {
    const walletToken = wallet.tokens.find(t => t.mint === pos.token);
    const walletBalance = walletToken?.uiBalance ?? 0;

    // Compute $0.50 tolerance in token units
    const price = await deps.canonicalPrice(pos.token, pos.size_tokens);
    const toleranceTokens = price && price > 0 ? DUST_VALUE_USDC / price : 0;

    const diff = Math.abs(pos.size_tokens - walletBalance);
    if (diff > toleranceTokens + 1e-9) {
      result.positionMismatches++;
      result.clean = false;
      await triggerMismatch(
        deps,
        `Position ${pos.token}: DB=${pos.size_tokens.toFixed(6)} tokens, wallet=${walletBalance.toFixed(6)} tokens (diff=${diff.toFixed(6)} > dust=$${DUST_VALUE_USDC})`,
        result
      );
    }
  }

  // Collect tokens that still have an active in-flight intent after resolution.
  // PENDING/SENT/UNKNOWN_TIMEOUT → suppresses the untracked check (resolution pending).
  // STUCK → does NOT suppress: the intent path has given up; wallet tokens are
  // evidence of an unresolved physical state and mismatch pause is correct. See §2.10.
  const stillPendingTokens = new Set(
    getPendingIntents()
      .filter(i => i.status !== 'STUCK')
      .map(i => i.token),
  );

  // Step 5: every non-dust wallet token must be tracked as an open position
  for (const token of wallet.tokens) {
    if (token.uiBalance <= 0) continue;

    // In-flight: a SENT intent exists for this token — resolution is pending
    if (stillPendingTokens.has(token.mint)) continue;

    // Dust check: skip tokens worth < $0.50
    const price = await deps.canonicalPrice(token.mint, token.uiBalance);
    const valueUsdc = price ? token.uiBalance * price : null;
    if (valueUsdc !== null && valueUsdc < DUST_VALUE_USDC) continue;

    // Check if tracked
    const pos = getPositionByToken(token.mint);
    if (!pos) {
      result.untrackedTokens.push(token.mint);
      result.clean = false;
      await triggerMismatch(
        deps,
        `Untracked token in wallet: ${token.mint} balance=${token.uiBalance} (value≈$${(valueUsdc ?? 0).toFixed(2)})`,
        result
      );
    }
  }

  if (result.clean) {
    // Mark reconciler as clean
    setFlag('reconciler_status', 'ok');
    setFlag('last_reconciler_run_utc', nowUtc());
  }

  return result;
}

// ── Resolve a single pending intent ───────────────────────────────────────────

async function resolvePendingIntent(
  intent: IntentRow,
  deps: ReconcilerDeps,
  result: ReconcileResult,
): Promise<void> {
  if (!intent.tx_signature) {
    // No tx sig yet (PENDING without send) — may have been created but crashed
    // before swap. Mark STUCK if old enough.
    const ageMs = Date.now() - new Date(intent.created_at_utc).getTime();
    if (ageMs > STUCK_AFTER_MS) {
      updateIntent(intent.id!, { status: 'STUCK' });
      result.stuckIntentsFound++;
      await deps.alert(`STUCK intent ${intent.id} (no tx sig, ${Math.round(ageMs / 60_000)}min old)`);
    }
    return;
  }

  const sig = intent.tx_signature;
  let txStatus: 'finalized' | 'failed' | 'unknown';
  try {
    txStatus = await deps.checkTxStatus(sig);
  } catch {
    return; // RPC unavailable — leave for next reconcile cycle
  }

  if (txStatus === 'finalized') {
    let parsed: { usdcAmount: number; tokenAmount: number; feeUsdc: number };
    try {
      parsed = await deps.parseSwap(sig);
    } catch (err) {
      insertError('reconciler', `parseSwap failed for ${sig}`, String(err));
      return;
    }

    // Apply to portfolio (OPEN or ADD for BUY; EXIT for SELL)
    applyTradeToPosition(
      intent.id!,
      intent.side,
      intent.token,
      parsed.usdcAmount,
      parsed.tokenAmount,
    );

    updateIntent(intent.id!, { status: 'CONFIRMED', resolved_at_utc: nowUtc() });
    result.pendingIntentsResolved++;

  } else if (txStatus === 'failed') {
    updateIntent(intent.id!, { status: 'CHAIN_FAILED', resolved_at_utc: nowUtc() });

  } else {
    // Still unknown
    const ageMs = Date.now() - new Date(intent.created_at_utc).getTime();
    if (ageMs > STUCK_AFTER_MS) {
      updateIntent(intent.id!, { status: 'STUCK' });
      result.stuckIntentsFound++;
      await deps.alert(`STUCK intent ${intent.id} tx=${sig} (${Math.round(ageMs / 60_000)}min unknown)`);
    }
  }
}

// ── Trigger mismatch pause ────────────────────────────────────────────────────

async function triggerMismatch(
  deps: ReconcilerDeps,
  detail: string,
  result: ReconcileResult,
): Promise<void> {
  setPaused(true, 'reconciler_mismatch');
  setFlag('reconciler_status', 'mismatch');
  insertError('reconciler', detail);
  await deps.alert(`RECONCILER MISMATCH: ${detail}. New trades halted until manual reconcile.`);
  result.clean = false;
}
