// SQLite layer — schema, helpers, sync API. See spec §5.1, §2.7, §2.9.
import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ── UTC timestamp helper ────────────────────────────────────────────────────

export function nowUtc(): string {
  return new Date().toISOString();
}

// ── DB singleton ─────────────────────────────────────────────────────────────

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB not initialised — call initDb() first');
  return _db;
}

export function initDb(dbPath?: string): Database.Database {
  const path = dbPath ?? process.env['DB_PATH'] ?? './data/trading.db';
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(path);

  // PRAGMAs — spec §5.1
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  applySchema(db);
  seedPeak(db);

  _db = db;
  return db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

// ── Schema ────────────────────────────────────────────────────────────────────

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY,
      timestamp_utc TEXT NOT NULL,
      action TEXT NOT NULL,
      token TEXT,
      size_usdc REAL,
      thesis TEXT,
      invalidation TEXT,
      expected_move_pct REAL,
      confidence INTEGER,
      prompt_snapshot TEXT,
      response_raw TEXT,
      validated BOOLEAN NOT NULL,
      executed BOOLEAN NOT NULL,
      skip_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS intents (
      id INTEGER PRIMARY KEY,
      decision_id INTEGER NOT NULL REFERENCES decisions(id),
      token TEXT NOT NULL,
      side TEXT NOT NULL,
      size_usdc REAL,
      size_tokens REAL,
      quote_snapshot TEXT NOT NULL,
      tx_signature TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at_utc TEXT NOT NULL,
      resolved_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      intent_id INTEGER NOT NULL REFERENCES intents(id),
      decision_id INTEGER NOT NULL REFERENCES decisions(id),
      timestamp_utc TEXT NOT NULL,
      token TEXT NOT NULL,
      side TEXT NOT NULL,
      size_usdc REAL NOT NULL,
      size_tokens REAL NOT NULL,
      price REAL NOT NULL,
      tx_signature TEXT NOT NULL UNIQUE,
      slippage_pct REAL,
      fee_usdc REAL
    );

    CREATE TABLE IF NOT EXISTS positions (
      id INTEGER PRIMARY KEY,
      token TEXT NOT NULL,
      opened_at_utc TEXT NOT NULL,
      closed_at_utc TEXT,
      cost_basis_total_usdc REAL NOT NULL,
      size_tokens REAL NOT NULL,
      exit_proceeds_usdc REAL,
      pnl_usdc REAL,
      status TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS position_ticks (
      position_id INTEGER NOT NULL REFERENCES positions(id),
      timestamp_utc TEXT NOT NULL,
      price REAL NOT NULL,
      loss_pct REAL NOT NULL,
      PRIMARY KEY (position_id, timestamp_utc)
    );

    CREATE TABLE IF NOT EXISTS portfolio_peak (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      peak_value_usdc REAL NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS portfolio_snapshots (
      timestamp_utc TEXT PRIMARY KEY,
      total_value_usdc REAL NOT NULL,
      cash_usdc REAL NOT NULL,
      positions_value_usdc REAL NOT NULL,
      sol_balance REAL NOT NULL,
      peak_value_usdc REAL NOT NULL,
      drawdown_from_peak_usdc REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      id INTEGER PRIMARY KEY,
      received_at_utc TEXT NOT NULL,
      source TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS errors (
      id INTEGER PRIMARY KEY,
      timestamp_utc TEXT NOT NULL,
      context TEXT NOT NULL,
      error_message TEXT NOT NULL,
      stack TEXT
    );

    CREATE TABLE IF NOT EXISTS flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      reason TEXT,
      updated_at_utc TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp_utc);
    CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp_utc);
    CREATE INDEX IF NOT EXISTS idx_intents_status ON intents(status);
    CREATE INDEX IF NOT EXISTS idx_position_ticks_lookup
      ON position_ticks(position_id, timestamp_utc DESC);
  `);
}

// ── Peak seeding — spec §2.9: seed once with 30 USDC, never overwrite ────────

function seedPeak(db: Database.Database): void {
  const existing = db.prepare('SELECT id FROM portfolio_peak WHERE id = 1').get();
  if (!existing) {
    db.prepare(
      'INSERT INTO portfolio_peak (id, peak_value_usdc, updated_at_utc) VALUES (1, 30, ?)'
    ).run(nowUtc());
  }
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DecisionRow {
  id?: number;
  timestamp_utc: string;
  action: string;
  token?: string | null;
  size_usdc?: number | null;
  thesis?: string | null;
  invalidation?: string | null;
  expected_move_pct?: number | null;
  confidence?: number | null;
  prompt_snapshot?: string | null;
  response_raw?: string | null;
  validated: boolean;
  executed: boolean;
  skip_reason?: string | null;
}

export interface IntentRow {
  id?: number;
  decision_id: number;
  token: string;
  side: 'BUY' | 'SELL';
  size_usdc?: number | null;
  size_tokens?: number | null;
  quote_snapshot: string;
  tx_signature?: string | null;
  status: IntentStatus;
  error?: string | null;
  created_at_utc: string;
  resolved_at_utc?: string | null;
}

export type IntentStatus =
  | 'PENDING'
  | 'SENT'
  | 'CONFIRMED'
  | 'CHAIN_FAILED'
  | 'SEND_FAILED'
  | 'UNKNOWN_TIMEOUT'
  | 'STUCK';

export interface TradeRow {
  id?: number;
  intent_id: number;
  decision_id: number;
  timestamp_utc: string;
  token: string;
  side: 'BUY' | 'SELL';
  size_usdc: number;
  size_tokens: number;
  price: number;
  tx_signature: string;
  slippage_pct?: number | null;
  fee_usdc?: number | null;
}

export interface PositionRow {
  id: number;
  token: string;
  opened_at_utc: string;
  closed_at_utc: string | null;
  cost_basis_total_usdc: number;
  size_tokens: number;
  exit_proceeds_usdc: number | null;
  pnl_usdc: number | null;
  status: 'OPEN' | 'CLOSED';
}

export interface TickRow {
  position_id: number;
  timestamp_utc: string;
  price: number;
  loss_pct: number;
}

// ── Decisions ─────────────────────────────────────────────────────────────────

export function insertDecision(d: Omit<DecisionRow, 'id'>): number {
  const stmt = getDb().prepare(`
    INSERT INTO decisions
      (timestamp_utc, action, token, size_usdc, thesis, invalidation,
       expected_move_pct, confidence, prompt_snapshot, response_raw,
       validated, executed, skip_reason)
    VALUES
      (@timestamp_utc, @action, @token, @size_usdc, @thesis, @invalidation,
       @expected_move_pct, @confidence, @prompt_snapshot, @response_raw,
       @validated, @executed, @skip_reason)
  `);
  // better-sqlite3 requires all named params present; coerce booleans to int
  const row = {
    token: null, size_usdc: null, thesis: null, invalidation: null,
    expected_move_pct: null, confidence: null, prompt_snapshot: null,
    response_raw: null, skip_reason: null,
    ...d,
    validated: d.validated ? 1 : 0,
    executed: d.executed ? 1 : 0,
  };
  return Number(stmt.run(row).lastInsertRowid);
}

// ── Intents ───────────────────────────────────────────────────────────────────

export function insertIntent(i: Omit<IntentRow, 'id'>): number {
  const stmt = getDb().prepare(`
    INSERT INTO intents
      (decision_id, token, side, size_usdc, size_tokens, quote_snapshot,
       tx_signature, status, error, created_at_utc, resolved_at_utc)
    VALUES
      (@decision_id, @token, @side, @size_usdc, @size_tokens, @quote_snapshot,
       @tx_signature, @status, @error, @created_at_utc, @resolved_at_utc)
  `);
  // better-sqlite3 requires all named params present
  const row = {
    size_usdc: null, size_tokens: null, tx_signature: null,
    error: null, resolved_at_utc: null,
    ...i,
  };
  return Number(stmt.run(row).lastInsertRowid);
}

export function updateIntent(
  id: number,
  changes: Partial<Pick<IntentRow, 'status' | 'tx_signature' | 'error' | 'resolved_at_utc'>>
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(changes)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (sets.length === 0) return;
  getDb().prepare(`UPDATE intents SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function getIntent(id: number): IntentRow | undefined {
  return getDb().prepare('SELECT * FROM intents WHERE id = ?').get(id) as IntentRow | undefined;
}

export function getPendingIntents(): IntentRow[] {
  return getDb()
    .prepare(`SELECT * FROM intents WHERE status IN ('PENDING','SENT','UNKNOWN_TIMEOUT')`)
    .all() as IntentRow[];
}

// ── Trades ────────────────────────────────────────────────────────────────────

export function insertTrade(t: Omit<TradeRow, 'id'>): number {
  const stmt = getDb().prepare(`
    INSERT INTO trades
      (intent_id, decision_id, timestamp_utc, token, side, size_usdc,
       size_tokens, price, tx_signature, slippage_pct, fee_usdc)
    VALUES
      (@intent_id, @decision_id, @timestamp_utc, @token, @side, @size_usdc,
       @size_tokens, @price, @tx_signature, @slippage_pct, @fee_usdc)
  `);
  // better-sqlite3 requires all named params present
  const row = { slippage_pct: null, fee_usdc: null, ...t };
  return Number(stmt.run(row).lastInsertRowid);
}

// ── Positions ─────────────────────────────────────────────────────────────────

export function openPosition(p: {
  token: string;
  opened_at_utc: string;
  cost_basis_total_usdc: number;
  size_tokens: number;
}): number {
  const stmt = getDb().prepare(`
    INSERT INTO positions (token, opened_at_utc, cost_basis_total_usdc, size_tokens, status)
    VALUES (@token, @opened_at_utc, @cost_basis_total_usdc, @size_tokens, 'OPEN')
  `);
  return Number(stmt.run(p).lastInsertRowid);
}

export function updatePosition(
  id: number,
  changes: Partial<Pick<PositionRow, 'cost_basis_total_usdc' | 'size_tokens'>>
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [k, v] of Object.entries(changes)) {
    sets.push(`${k} = @${k}`);
    params[k] = v;
  }
  if (sets.length === 0) return;
  getDb().prepare(`UPDATE positions SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function closePosition(
  id: number,
  d: { exit_proceeds_usdc: number; pnl_usdc: number; closed_at_utc: string }
): void {
  getDb().prepare(`
    UPDATE positions
    SET status = 'CLOSED',
        exit_proceeds_usdc = @exit_proceeds_usdc,
        pnl_usdc = @pnl_usdc,
        closed_at_utc = @closed_at_utc
    WHERE id = @id
  `).run({ id, ...d });
}

export function listOpenPositions(): PositionRow[] {
  return getDb()
    .prepare(`SELECT * FROM positions WHERE status = 'OPEN'`)
    .all() as PositionRow[];
}

export function getPositionByToken(token: string): PositionRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM positions WHERE token = ? AND status = 'OPEN'`)
    .get(token) as PositionRow | undefined;
}

// ── Position ticks ─────────────────────────────────────────────────────────────

export function recordTick(positionId: number, price: number, lossPct: number): void {
  // INSERT OR REPLACE: same (position_id, timestamp_utc) PK within same millisecond is
  // vanishingly rare in prod but guard against it in tests.
  getDb().prepare(`
    INSERT OR REPLACE INTO position_ticks (position_id, timestamp_utc, price, loss_pct)
    VALUES (?, ?, ?, ?)
  `).run(positionId, nowUtc(), price, lossPct);
}

export function lastNTicks(positionId: number, n: number): TickRow[] {
  return getDb().prepare(`
    SELECT * FROM position_ticks
    WHERE position_id = ?
    ORDER BY timestamp_utc DESC
    LIMIT ?
  `).all(positionId, n) as TickRow[];
}

// ── Portfolio peak — spec §2.9 ─────────────────────────────────────────────────

export function upsertAndGetPeak(currentValue: number): number {
  // Atomic single-row update: only raises the peak, never lowers it
  getDb().prepare(`
    UPDATE portfolio_peak
    SET peak_value_usdc = MAX(peak_value_usdc, ?),
        updated_at_utc  = ?
    WHERE id = 1
  `).run(currentValue, nowUtc());

  const row = getDb()
    .prepare('SELECT peak_value_usdc FROM portfolio_peak WHERE id = 1')
    .get() as { peak_value_usdc: number };
  return row.peak_value_usdc;
}

// ── Flags ─────────────────────────────────────────────────────────────────────

export function getFlag(key: string): string | null {
  const row = getDb()
    .prepare('SELECT value FROM flags WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setFlag(key: string, value: string, reason?: string | null): void {
  getDb().prepare(`
    INSERT INTO flags (key, value, reason, updated_at_utc)
    VALUES (@key, @value, @reason, @updated_at_utc)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      reason = excluded.reason,
      updated_at_utc = excluded.updated_at_utc
  `).run({ key, value, reason: reason ?? null, updated_at_utc: nowUtc() });
}

// Convenience wrappers for the flags read most often by safety/decision loops

export function isPaused(): boolean {
  return getFlag('paused') === 'true';
}

export function getPauseReason(): string | null {
  const r = getFlag('pause_reason');
  return r === '' ? null : r;
}

export function setPaused(paused: boolean, reason: string | null): void {
  setFlag('paused', String(paused), reason);
  setFlag('pause_reason', reason ?? '', reason);
}

export function isKillSwitchTriggered(): boolean {
  return getFlag('kill_switch_triggered') === 'true';
}

export function setKillSwitchTriggered(reason: string): void {
  setFlag('kill_switch_triggered', 'true', reason);
  setFlag('kill_switch_reason', reason, reason);
}

// ── Errors ────────────────────────────────────────────────────────────────────

export function insertError(context: string, message: string, stack?: string): void {
  getDb().prepare(`
    INSERT INTO errors (timestamp_utc, context, error_message, stack)
    VALUES (?, ?, ?, ?)
  `).run(nowUtc(), context, message, stack ?? null);
}

// ── Trade window counter — spec §1 rolling 24h cap ───────────────────────────

export function countTradesInWindow(windowSeconds: number): number {
  const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = getDb()
    .prepare(`SELECT COUNT(*) as cnt FROM trades WHERE timestamp_utc >= ?`)
    .get(cutoff) as { cnt: number };
  return row.cnt;
}

// ── Heartbeats ─────────────────────────────────────────────────────────────────

export function insertHeartbeat(source: string): void {
  getDb().prepare(
    'INSERT INTO heartbeats (received_at_utc, source) VALUES (?, ?)'
  ).run(nowUtc(), source);
}

export function latestHeartbeatUtc(): string | null {
  const row = getDb()
    .prepare('SELECT received_at_utc FROM heartbeats ORDER BY received_at_utc DESC LIMIT 1')
    .get() as { received_at_utc: string } | undefined;
  return row?.received_at_utc ?? null;
}

// ── Portfolio snapshot ────────────────────────────────────────────────────────

export function insertPortfolioSnapshot(s: {
  total_value_usdc: number;
  cash_usdc: number;
  positions_value_usdc: number;
  sol_balance: number;
  peak_value_usdc: number;
  drawdown_from_peak_usdc: number;
}): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO portfolio_snapshots
      (timestamp_utc, total_value_usdc, cash_usdc, positions_value_usdc,
       sol_balance, peak_value_usdc, drawdown_from_peak_usdc)
    VALUES (@timestamp_utc, @total_value_usdc, @cash_usdc, @positions_value_usdc,
            @sol_balance, @peak_value_usdc, @drawdown_from_peak_usdc)
  `).run({ timestamp_utc: nowUtc(), ...s });
}
