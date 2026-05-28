// DB layer tests. See spec §5.1, §2.9.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import {
  initDb, closeDb, nowUtc, getDb,
  getFlag, setFlag, isPaused, setPaused, getPauseReason,
  isKillSwitchTriggered, setKillSwitchTriggered,
  upsertAndGetPeak,
  openPosition, recordTick, lastNTicks,
  insertTrade, countTradesInWindow,
  insertDecision, insertIntent,
  listOpenPositions, closePosition,
} from '../src/observability/db.js';

function tempDb(): string {
  return join(tmpdir(), `coinboi-test-${process.pid}-${Date.now()}.db`);
}

describe('db layer', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
  });

  // ── Schema ────────────────────────────────────────────────────────────────

  it('creates all tables on first init', () => {
    const db = getDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r) => (r as { name: string }).name);

    expect(tables).toContain('decisions');
    expect(tables).toContain('intents');
    expect(tables).toContain('trades');
    expect(tables).toContain('positions');
    expect(tables).toContain('position_ticks');
    expect(tables).toContain('portfolio_peak');
    expect(tables).toContain('portfolio_snapshots');
    expect(tables).toContain('heartbeats');
    expect(tables).toContain('errors');
    expect(tables).toContain('flags');
  });

  it('is idempotent — second initDb on same file does not throw', () => {
    closeDb();
    expect(() => initDb(dbPath)).not.toThrow();
  });

  // ── Peak seeding — spec §2.9 ──────────────────────────────────────────────

  it('seeds portfolio_peak with 30 on first init', () => {
    const row = getDb()
      .prepare('SELECT peak_value_usdc FROM portfolio_peak WHERE id = 1')
      .get() as { peak_value_usdc: number };
    expect(row.peak_value_usdc).toBe(30);
  });

  it('does NOT overwrite peak on re-init after it has been raised', () => {
    upsertAndGetPeak(35); // agent earns money

    // Close and re-open same file
    closeDb();
    initDb(dbPath);

    const row = getDb()
      .prepare('SELECT peak_value_usdc FROM portfolio_peak WHERE id = 1')
      .get() as { peak_value_usdc: number };
    expect(row.peak_value_usdc).toBe(35);
  });

  it('upsertAndGetPeak raises but never lowers', () => {
    expect(upsertAndGetPeak(40)).toBe(40);
    expect(upsertAndGetPeak(25)).toBe(40); // drawdown — peak stays
    expect(upsertAndGetPeak(50)).toBe(50);
  });

  // ── Flags round-trip ──────────────────────────────────────────────────────

  it('flag get/set round-trips string values', () => {
    expect(getFlag('missing')).toBeNull();
    setFlag('my_flag', 'hello', 'some reason');
    expect(getFlag('my_flag')).toBe('hello');
    setFlag('my_flag', 'world');
    expect(getFlag('my_flag')).toBe('world');
  });

  it('paused flag round-trips through convenience helpers', () => {
    expect(isPaused()).toBe(false);
    expect(getPauseReason()).toBeNull();

    setPaused(true, 'soft_drawdown');
    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('soft_drawdown');

    setPaused(false, null);
    expect(isPaused()).toBe(false);
    expect(getPauseReason()).toBeNull();
  });

  it('kill_switch_triggered round-trips', () => {
    expect(isKillSwitchTriggered()).toBe(false);
    setKillSwitchTriggered('hard_stop_drawdown');
    expect(isKillSwitchTriggered()).toBe(true);
    expect(getFlag('kill_switch_reason')).toBe('hard_stop_drawdown');
  });

  // ── countTradesInWindow rolling window ────────────────────────────────────

  it('countTradesInWindow counts only trades within the window', () => {
    // Seed a decision + intent to satisfy FK constraints
    const decId = insertDecision({
      timestamp_utc: nowUtc(),
      action: 'OPEN',
      validated: true,
      executed: true,
    });
    const intId = insertIntent({
      decision_id: decId,
      token: 'BONK',
      side: 'BUY',
      quote_snapshot: '{}',
      status: 'CONFIRMED',
      created_at_utc: nowUtc(),
    });

    // Insert a trade right now
    insertTrade({
      intent_id: intId,
      decision_id: decId,
      timestamp_utc: nowUtc(),
      token: 'BONK',
      side: 'BUY',
      size_usdc: 5,
      size_tokens: 1000,
      price: 0.005,
      tx_signature: 'sig-recent',
    });

    // Insert a trade 2 hours ago (manufactured timestamp)
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    insertTrade({
      intent_id: intId,
      decision_id: decId,
      timestamp_utc: twoHoursAgo,
      token: 'BONK',
      side: 'SELL',
      size_usdc: 5,
      size_tokens: 1000,
      price: 0.005,
      tx_signature: 'sig-old',
    });

    // 1-hour window: only the recent trade
    expect(countTradesInWindow(3600)).toBe(1);
    // 3-hour window: both trades
    expect(countTradesInWindow(3 * 3600)).toBe(2);
  });

  // ── recordTick + lastNTicks ───────────────────────────────────────────────

  it('lastNTicks(2) returns the two most recent ticks in DESC order', async () => {
    const posId = openPosition({
      token: 'WIF',
      opened_at_utc: nowUtc(),
      cost_basis_total_usdc: 5,
      size_tokens: 100,
    });

    // Insert three ticks with enforced ordering via distinct timestamps
    recordTick(posId, 0.05, -0.0);
    await new Promise(r => setTimeout(r, 5)); // ensure distinct ms
    recordTick(posId, 0.04, -0.2);
    await new Promise(r => setTimeout(r, 5));
    recordTick(posId, 0.03, -0.4);

    const ticks = lastNTicks(posId, 2);
    expect(ticks).toHaveLength(2);
    // Most recent first
    expect(ticks[0]!.price).toBe(0.03);
    expect(ticks[1]!.price).toBe(0.04);
  });

  it('lastNTicks stop-loss scenario: both below -40% triggers', async () => {
    const posId = openPosition({
      token: 'BONK',
      opened_at_utc: nowUtc(),
      cost_basis_total_usdc: 5,
      size_tokens: 1_000_000,
    });

    recordTick(posId, 0.000003, -0.40);
    await new Promise(r => setTimeout(r, 5));
    recordTick(posId, 0.000002, -0.60);

    const ticks = lastNTicks(posId, 2);
    const bothBelow = ticks.length === 2 && ticks.every(t => t.loss_pct <= -0.40);
    expect(bothBelow).toBe(true);
  });

  // ── Position CRUD ─────────────────────────────────────────────────────────

  it('openPosition + listOpenPositions + closePosition', () => {
    const id = openPosition({
      token: 'BOME',
      opened_at_utc: nowUtc(),
      cost_basis_total_usdc: 5,
      size_tokens: 200,
    });

    let open = listOpenPositions();
    expect(open).toHaveLength(1);
    expect(open[0]!.token).toBe('BOME');

    closePosition(id, {
      exit_proceeds_usdc: 5.5,
      pnl_usdc: 0.5,
      closed_at_utc: nowUtc(),
    });

    open = listOpenPositions();
    expect(open).toHaveLength(0);
  });

  // ── nowUtc format ─────────────────────────────────────────────────────────

  it('nowUtc() returns a valid ISO-8601 UTC string', () => {
    const ts = nowUtc();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});
