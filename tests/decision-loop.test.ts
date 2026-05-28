// Decision loop tests — spec §2.5: gate checks, action-state consistency,
// the §2.3 TOCTOU recheck-after-acquire, and the concurrent kill-switch test.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import {
  initDb, closeDb, nowUtc,
  openPosition,
  isKillSwitchTriggered, setKillSwitchTriggered,
  isPaused, setPaused,
} from '../src/observability/db.js';
import { runDecisionCycle, type DecisionCycleDeps } from '../src/agent/decision-loop.js';
import { recordHeartbeat } from '../src/agent/heartbeat.js';
import type { UniverseToken } from '../src/execution/universe.js';
import type { Quote } from '../src/execution/jupiter-quote.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempDb() {
  return join(tmpdir(), `coinboi-decision-test-${process.pid}-${Date.now()}.db`);
}

// Use symbol 'BONK' as the token identifier throughout decision loop tests.
// The decision loop uses token as an opaque string; production wiring does
// symbol→mint conversion when calling wallet/quote APIs.
const BONK = 'BONK';

const bonkToken: UniverseToken = {
  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  symbol: BONK,
  name: 'Bonk',
  marketCapUsd: 100_000_000,
  volume24hUsd: 10_000_000,
  ageDays: 365,
  lpLocked: true,
  lpLockedDays: 365,
  top10HolderPct: 0.25,
  uniqueTraders24h: 1000,
  annualizedVolPct: 300,
  jupiterListed: true,
};

const WITHIN_BUDGET_QUOTE: Quote = {
  inputMint: 'USDC_MINT',
  outputMint: bonkToken.mint,
  inputAmount: 5.0,
  outputAmount: 1_000_000,
  priceImpactPct: 0.001,
  totalCostPct: 0.01,   // 1% — within the 1.5% budget
  routerName: 'Jupiter',
  withinBudget: true,
  rawSnapshot: '{}',
  fetchedAtUtc: new Date().toISOString(),
};

function openDecision(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    action: 'OPEN',
    token: BONK,
    size_usdc: 5.0,
    thesis: 'Strong momentum with volume surge',
    invalidation: 'Price drops below 30-day MA on 4h close',
    expected_move_pct: 10,
    confidence: 7,
    ...overrides,
  });
}

function baseDeps(overrides: Partial<DecisionCycleDeps> = {}): DecisionCycleDeps {
  return {
    getSolBalance: vi.fn(async () => 1.0),
    getWalletTokenBalance: vi.fn(async () => 0),
    buildUniverse: vi.fn(async () => [bonkToken]),
    getSignals: vi.fn(async () => '{}'),
    getRecentDecisions: vi.fn(() => 'No prior decisions.'),
    askClaude: vi.fn(async () => openDecision()),
    getQuote: vi.fn(async () => WITHIN_BUDGET_QUOTE),
    executeTx: vi.fn(async () => {}),
    alert: vi.fn(async () => {}),
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

describe('decision loop §2.5', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
    recordHeartbeat('test'); // ensure heartbeat watchdog doesn't trip
  });

  afterEach(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
    vi.clearAllMocks();
  });

  // ── Kill switch: gate before anything else ────────────────────────────────

  it('kill switch active → cycle exits before asking Claude', async () => {
    setKillSwitchTriggered('test');
    const deps = baseDeps();
    await runDecisionCycle(deps);
    expect(deps.askClaude).not.toHaveBeenCalled();
    expect(deps.executeTx).not.toHaveBeenCalled();
  });

  // ── Happy path: valid OPEN fires executeTx ────────────────────────────────

  it('valid OPEN decision with clean state → executeTx called once', async () => {
    const exec = vi.fn();
    const deps = baseDeps({ executeTx: exec });
    await runDecisionCycle(deps);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  // ── Pause state → OPEN/ADD rejected; EXIT allowed ────────────────────────
  // §1: soft pause blocks OPEN/ADD but EXIT is always allowed.

  it('paused → OPEN returned by Haiku → rejected (not in allowed_actions)', async () => {
    setPaused(true, 'soft_drawdown');
    const exec = vi.fn();
    const deps = baseDeps({ executeTx: exec });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  it('paused → ADD returned by Haiku → rejected', async () => {
    openPosition({ token: BONK, opened_at_utc: nowUtc(), cost_basis_total_usdc: 5.0, size_tokens: 1_000_000 });
    setPaused(true, 'soft_drawdown');
    const exec = vi.fn();
    const deps = baseDeps({
      askClaude: vi.fn(async () => openDecision({ action: 'ADD', size_usdc: 2.0, expected_move_pct: 8 })),
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  it('paused → EXIT allowed → executeTx called', async () => {
    openPosition({ token: BONK, opened_at_utc: nowUtc(), cost_basis_total_usdc: 5.0, size_tokens: 1_000_000 });
    setPaused(true, 'soft_drawdown');
    const exec = vi.fn();
    const deps = baseDeps({
      askClaude: vi.fn(async () => JSON.stringify({
        action: 'EXIT', token: BONK,
        thesis: 'Thesis invalidated', invalidation: 'Price reclaims resistance',
        expected_move_pct: 0, confidence: 8,
      })),
      getWalletTokenBalance: vi.fn(async () => 1_000_000),
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  // ── Action-state consistency ──────────────────────────────────────────────

  it('OPEN on a token already held → rejected (should have been ADD)', async () => {
    openPosition({ token: BONK, opened_at_utc: nowUtc(), cost_basis_total_usdc: 5.0, size_tokens: 1_000_000 });
    const exec = vi.fn();
    const deps = baseDeps({ executeTx: exec });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  it('ADD on a token NOT held → rejected (should have been OPEN)', async () => {
    const exec = vi.fn();
    const deps = baseDeps({
      askClaude: vi.fn(async () => openDecision({ action: 'ADD', size_usdc: 2.0, expected_move_pct: 8 })),
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  it('EXIT on token with zero wallet balance → rejected', async () => {
    openPosition({ token: BONK, opened_at_utc: nowUtc(), cost_basis_total_usdc: 5.0, size_tokens: 1_000_000 });
    const exec = vi.fn();
    const deps = baseDeps({
      askClaude: vi.fn(async () => JSON.stringify({
        action: 'EXIT', token: BONK,
        thesis: 'exit', invalidation: 'n/a',
        expected_move_pct: 0, confidence: 8,
      })),
      getWalletTokenBalance: vi.fn(async () => 0), // zero → no tokens to sell
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  // ── Quote budget ──────────────────────────────────────────────────────────

  it('quote cost > 1.5% → skipped before mutex, executeTx not called', async () => {
    const exec = vi.fn();
    const overBudgetQuote: Quote = { ...WITHIN_BUDGET_QUOTE, totalCostPct: 0.016, withinBudget: false };
    const deps = baseDeps({
      getQuote: vi.fn(async () => overBudgetQuote),
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  // ── Malformed LLM response ────────────────────────────────────────────────

  it('malformed JSON from Claude → treated as HOLD_ALL, no trade', async () => {
    const exec = vi.fn();
    const deps = baseDeps({
      askClaude: vi.fn(async () => 'sorry I cannot help with trading decisions'),
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  it('valid JSON but fails schema (expected_move_pct < 5) → no trade', async () => {
    const exec = vi.fn();
    const deps = baseDeps({
      askClaude: vi.fn(async () => openDecision({ expected_move_pct: 2 })),
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
  });

  // ── Universe membership ───────────────────────────────────────────────────

  it('token not in pre-mutex universe → rejected before quote', async () => {
    const exec = vi.fn();
    const deps = baseDeps({
      buildUniverse: vi.fn(async () => []),  // empty universe
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
    // universe empty AND no positions → should bail even before askClaude
    expect(deps.askClaude).not.toHaveBeenCalled();
  });

  // ── §2.3 TOCTOU recheck: token leaves universe between decision and mutex ─
  // Pre-mutex universe has BONK (decision proceeds to quote). Inside the mutex,
  // the universe is rechecked and BONK is gone → skip, no trade.

  it('token leaves universe between decision and mutex recheck → no trade', async () => {
    let buildCallCount = 0;
    const exec = vi.fn();
    const deps = baseDeps({
      buildUniverse: vi.fn(async () => {
        buildCallCount++;
        // First call (read-only phase): BONK present → cycle proceeds
        // Second call (inside mutex recheck): empty → skip
        return buildCallCount === 1 ? [bonkToken] : [];
      }),
      executeTx: exec,
    });
    await runDecisionCycle(deps);
    expect(exec).not.toHaveBeenCalled();
    expect(buildCallCount).toBe(2); // both calls happened
  });

  // ── §2.3 TOCTOU: kill switch tripped during read-only phase ──────────────
  // This is the main concurrent test. Timeline:
  //   1. Decision cycle passes all pre-mutex gates (kill switch is clear)
  //   2. Cycle reaches getQuote — slow RPC, no mutex held yet
  //   3. Safety loop fires: sets kill switch (simulated by the test)
  //   4. Cycle acquires mutex, rechecks kill switch → sees it triggered → skip
  //   5. executeTx never called — TOCTOU window closed

  it('§2.3: kill switch tripped during slow quote → recheck inside mutex catches it, no trade', async () => {
    let resolveQuote!: () => void;
    const quotePending = new Promise<void>(r => { resolveQuote = r; });

    const exec = vi.fn();
    const deps = baseDeps({
      getQuote: vi.fn(async () => {
        // Simulate slow Jupiter RPC — decision cycle is in the window where
        // it has passed all gates but not yet acquired the mutex.
        await quotePending;
        return WITHIN_BUDGET_QUOTE;
      }),
      executeTx: exec,
    });

    // Start the cycle — it will suspend at the slow getQuote call
    const cyclePromise = runDecisionCycle(deps);

    // Let the cycle run far enough to reach getQuote (past all pre-mutex gates)
    await new Promise(r => setTimeout(r, 10));

    // Safety loop fires: trips the kill switch while the decision loop has no mutex
    setKillSwitchTriggered('concurrent_safety_trip');

    // Unblock the quote — cycle continues to the mutex
    resolveQuote();
    await cyclePromise;

    // The recheck-inside-mutex caught the kill switch → no trade fired
    expect(exec).not.toHaveBeenCalled();
    expect(isKillSwitchTriggered()).toBe(true);
  });

  // ── Recheck: pause set between decision and mutex (OPEN blocked) ──────────

  it('pause set during slow quote → OPEN blocked at mutex recheck', async () => {
    let resolveQuote!: () => void;
    const quotePending = new Promise<void>(r => { resolveQuote = r; });

    const exec = vi.fn();
    const deps = baseDeps({
      getQuote: vi.fn(async () => {
        await quotePending;
        return WITHIN_BUDGET_QUOTE;
      }),
      executeTx: exec,
    });

    const cyclePromise = runDecisionCycle(deps);
    await new Promise(r => setTimeout(r, 10));

    // Safety loop trips soft pause while decision cycle is pre-mutex
    setPaused(true, 'soft_drawdown');

    resolveQuote();
    await cyclePromise;

    expect(exec).not.toHaveBeenCalled();
    expect(isPaused()).toBe(true);
  });
});
