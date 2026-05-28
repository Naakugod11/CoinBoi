// Safety loop tests — spec §2.6, §2.3.
// The concurrent ADD-vs-stop mutex test is the §2.3 race-condition fix.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import {
  initDb, closeDb, nowUtc,
  openPosition as dbOpenPosition,
  listOpenPositions, lastNTicks,
  isPaused, getPauseReason, setPaused,
  isKillSwitchTriggered, setFlag,
  type PositionRow,
} from '../src/observability/db.js';
import { runSafetyCycle, type SafetyLoopDeps } from '../src/agent/safety-loop.js';
import { tradeMutex } from '../src/agent/mutex.js';
import { recordHeartbeat } from '../src/agent/heartbeat.js';

// ── DB helpers ────────────────────────────────────────────────────────────────

function tempDb() {
  return join(tmpdir(), `coinboi-safety-test-${process.pid}-${Date.now()}.db`);
}

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/** Open a position and return the full PositionRow shape for testing. */
function seedPosition(
  token = BONK,
  costBasis = 5.0,
  sizeTokens = 1_000_000,
): PositionRow {
  const id = dbOpenPosition({
    token,
    opened_at_utc: nowUtc(),
    cost_basis_total_usdc: costBasis,
    size_tokens: sizeTokens,
  });
  return {
    id,
    token,
    opened_at_utc: nowUtc(),
    closed_at_utc: null,
    cost_basis_total_usdc: costBasis,
    size_tokens: sizeTokens,
    exit_proceeds_usdc: null,
    pnl_usdc: null,
    status: 'OPEN',
  };
}

function baseDeps(overrides: Partial<SafetyLoopDeps> = {}): SafetyLoopDeps {
  return {
    // Price at cost basis → 0% loss by default
    canonicalPrice: vi.fn(async (_mint, sizeTokens) => 5.0 / sizeTokens),
    getSolBalance: vi.fn(async () => 1.0),   // well above 0.015 reserve
    getUsdcBalance: vi.fn(async () => 0),    // 0 by default; override for heartbeat tests
    marketSellPosition: vi.fn(async () => {}),
    marketSellAllWithRetry: vi.fn(async () => {}),
    alert: vi.fn(async () => {}),
    ...overrides,
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

describe('safety loop §2.6', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
    // Seed a heartbeat so the heartbeat watchdog doesn't fire in unrelated tests
    recordHeartbeat('test');
  });

  afterEach(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
    vi.clearAllMocks();
  });

  // ── 2-tick confirmation ───────────────────────────────────────────────────
  // ONE tick below -40% must NOT trigger. TWO consecutive must trigger.

  it('single tick below -40% does NOT trigger stop', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    const sell = vi.fn(async () => {});

    // Price at -50% of cost: value = 0.5 × 5.0 = 2.5 → price = 2.5/1e6
    const deps = baseDeps({
      canonicalPrice: vi.fn(async () => 2.5 / 1_000_000),
      marketSellPosition: sell,
    });

    await runSafetyCycle(deps);
    expect(sell).not.toHaveBeenCalled();

    const ticks = lastNTicks(1, 10);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.loss_pct).toBeCloseTo(-0.5, 5);
  });

  it('two consecutive ticks both below -40% trigger stop', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    const sell = vi.fn(async () => {});
    const alerts: string[] = [];

    const deps = baseDeps({
      canonicalPrice: vi.fn(async () => 2.5 / 1_000_000), // -50% every cycle
      marketSellPosition: sell,
      alert: vi.fn(async (msg) => { alerts.push(msg); }),
    });

    // Tick 1 — records but does NOT stop
    await runSafetyCycle(deps);
    expect(sell).not.toHaveBeenCalled();

    await new Promise(r => setTimeout(r, 5)); // ensure distinct ISO timestamps

    // Tick 2 — both ticks below → stop fires
    await runSafetyCycle(deps);
    expect(sell).toHaveBeenCalledTimes(1);
    expect(alerts.some(a => a.includes('STOP HIT'))).toBe(true);
  });

  it('tick1 below, tick2 above -40% → no stop on second cycle', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    const sell = vi.fn(async () => {});

    let cycle = 0;
    const deps = baseDeps({
      canonicalPrice: vi.fn(async () => {
        cycle++;
        // Tick 1: -50%. Tick 2: -10% (recovered).
        return cycle === 1 ? 2.5 / 1_000_000 : 4.5 / 1_000_000;
      }),
      marketSellPosition: sell,
    });

    await runSafetyCycle(deps);
    await new Promise(r => setTimeout(r, 5));
    await runSafetyCycle(deps);

    expect(sell).not.toHaveBeenCalled();
    const ticks = lastNTicks(1, 2);
    // Most recent tick is above threshold
    expect(ticks[0]!.loss_pct).toBeCloseTo(-0.1, 4);
  });

  // ── null price skips without stopping ─────────────────────────────────────
  // §2.6: never stop on missing data

  it('null canonical price skips the tick without recording or stopping', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    const sell = vi.fn(async () => {});

    const deps = baseDeps({
      canonicalPrice: vi.fn(async () => null),
      marketSellPosition: sell,
    });

    await runSafetyCycle(deps);
    await runSafetyCycle(deps);

    expect(sell).not.toHaveBeenCalled();
    expect(lastNTicks(1, 10)).toHaveLength(0); // no ticks recorded
  });

  // ── Soft pause at -$8 ─────────────────────────────────────────────────────
  // Peak = 30 (DB seed). Portfolio value = 22 → dd = 8 → soft pause.

  it('sets soft_drawdown pause when drawdown reaches $8', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    // 1,000,000 × 0.000022 = 22 USDC → dd = 30 - 22 = 8
    const deps = baseDeps({ canonicalPrice: vi.fn(async () => 0.000022) });
    await runSafetyCycle(deps);

    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('soft_drawdown');
    expect(isKillSwitchTriggered()).toBe(false); // soft ≠ hard
  });

  it('soft pause does not call marketSellAllWithRetry', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    const sellAll = vi.fn(async () => {});
    const deps = baseDeps({
      canonicalPrice: vi.fn(async () => 0.000022),
      marketSellAllWithRetry: sellAll,
    });
    await runSafetyCycle(deps);
    expect(sellAll).not.toHaveBeenCalled();
  });

  // ── Hard stop at -$13 ─────────────────────────────────────────────────────

  it('hard stop fires kill switch and liquidates all positions', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    const sellAll = vi.fn(async () => {});
    const alerts: string[] = [];

    // 1,000,000 × 0.000017 = 17 USDC → dd = 30 - 17 = 13
    const deps = baseDeps({
      canonicalPrice: vi.fn(async () => 0.000017),
      marketSellAllWithRetry: sellAll,
      alert: vi.fn(async (msg) => { alerts.push(msg); }),
    });

    await runSafetyCycle(deps);

    expect(isKillSwitchTriggered()).toBe(true);
    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('hard_stop');
    expect(sellAll).toHaveBeenCalledTimes(1);
    expect(alerts.some(a => a.includes('HARD STOP'))).toBe(true);
  });

  it('hard stop does not fire twice when kill switch is already set', async () => {
    seedPosition(BONK, 5.0, 1_000_000);
    setFlag('kill_switch_triggered', 'true');
    const sellAll = vi.fn(async () => {});

    const deps = baseDeps({
      canonicalPrice: vi.fn(async () => 0.000017),
      marketSellAllWithRetry: sellAll,
    });

    await runSafetyCycle(deps);
    expect(sellAll).not.toHaveBeenCalled();
  });

  // ── Trade cap ─────────────────────────────────────────────────────────────

  it('pauses with trade_cap when rolling 24h trades ≥ 12', async () => {
    // Seed 12 trade rows in the rolling window
    const decId = (await import('../src/observability/db.js'))
      .insertDecision({ timestamp_utc: nowUtc(), action: 'OPEN', validated: true, executed: true });

    const { insertIntent: ins, insertTrade: insTrade } = await import('../src/observability/db.js');
    for (let i = 0; i < 12; i++) {
      const iid = ins({ decision_id: decId, token: BONK, side: 'BUY', quote_snapshot: '{}', status: 'CONFIRMED', created_at_utc: nowUtc() });
      insTrade({ intent_id: iid, decision_id: decId, timestamp_utc: nowUtc(), token: BONK, side: 'BUY', size_usdc: 1, size_tokens: 100, price: 0.01, tx_signature: `sig${i}` });
    }

    const deps = baseDeps();
    await runSafetyCycle(deps);

    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('trade_cap');
  });

  // ── SOL reserve ───────────────────────────────────────────────────────────

  it('pauses sol_low when SOL balance is below reserve floor', async () => {
    const deps = baseDeps({ getSolBalance: vi.fn(async () => 0.010) });
    await runSafetyCycle(deps);

    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('sol_low');
  });

  // ── Heartbeat watchdog ────────────────────────────────────────────────────

  it('pauses heartbeat_missing when last heartbeat was >12h ago', async () => {
    // Plant a stale heartbeat by directly inserting an old timestamp
    const staleTime = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
    const { getDb } = await import('../src/observability/db.js');
    // Clear all and insert only the stale one
    getDb().prepare('DELETE FROM heartbeats').run();
    getDb().prepare('INSERT INTO heartbeats (received_at_utc, source) VALUES (?, ?)').run(staleTime, 'test');

    // Provide USDC balance so portfolioUsdc = $25 → dd = $5, below both pause thresholds
    const deps = baseDeps({ getUsdcBalance: vi.fn(async () => 25) });
    await runSafetyCycle(deps);

    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('heartbeat_missing');
  });

  it('resumes heartbeat_missing once a fresh heartbeat is recorded', async () => {
    setPaused(true, 'heartbeat_missing');
    recordHeartbeat('test'); // fresh heartbeat just now

    // Provide USDC balance so portfolioUsdc = $25 → dd = $5, below pause thresholds;
    // otherwise the empty-portfolio value (0) would trigger a hard stop and overwrite
    // the pause reason before the heartbeat resume branch runs.
    const deps = baseDeps({ getUsdcBalance: vi.fn(async () => 25) });
    await runSafetyCycle(deps);

    expect(isPaused()).toBe(false);
    expect(getPauseReason()).toBeNull();
  });

  // ── §2.3: Concurrent ADD-vs-stop mutex serialization ─────────────────────
  // The race condition fix: decision loop ADD and safety loop STOP on the same
  // position must not interleave. Whichever gets the mutex first runs fully
  // before the other starts.

  it('decision-loop ADD and safety-loop stop serialize completely via mutex', async () => {
    const executionLog: string[] = [];

    // Decision loop: holds mutex (simulating mid-ADD), then releases
    let resolveDecisionLoop!: () => void;
    const decisionLoopHeld = tradeMutex.runExclusive(async () => {
      executionLog.push('decision-ADD-start');
      await new Promise<void>(r => { resolveDecisionLoop = r; });
      executionLog.push('decision-ADD-end');
    });

    // Safety loop: queued on the mutex immediately after
    const safetyStopQueued = tradeMutex.runExclusive(async () => {
      executionLog.push('safety-stop-start');
      executionLog.push('safety-stop-end');
    });

    // Give decision loop a moment to actually take the lock
    await new Promise(r => setTimeout(r, 2));

    // At this point: decision loop holds lock, safety queued
    expect(executionLog).toEqual(['decision-ADD-start']);
    expect(executionLog).not.toContain('safety-stop-start');

    // Unblock the decision loop
    resolveDecisionLoop();
    await decisionLoopHeld;
    await safetyStopQueued;

    // Strict serialization: ADD completed fully before STOP started
    expect(executionLog).toEqual([
      'decision-ADD-start',
      'decision-ADD-end',
      'safety-stop-start',
      'safety-stop-end',
    ]);
  });
});
