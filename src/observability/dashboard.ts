// Express dashboard — 127.0.0.1:DASHBOARD_PORT only (Tailscale). See spec §5.3.
// NEVER bind to 0.0.0.0 — dashboard would be on the open internet.
import express from 'express';
import type { Server } from 'node:http';
import { SAFETY, ENV } from '../config.js';
import { getDb, isPaused, getPauseReason, latestHeartbeatUtc, nowUtc } from './db.js';

// ── State query — reads everything from SQLite at request time ────────────────

function buildState() {
  const db = getDb();
  const snapshot = (db.prepare(
    'SELECT * FROM portfolio_snapshots ORDER BY timestamp_utc DESC LIMIT 1',
  ).get() ?? {
    timestamp_utc: nowUtc(),
    total_value_usdc: SAFETY.STARTING_CAPITAL_USDC,
    cash_usdc: SAFETY.STARTING_CAPITAL_USDC,
    positions_value_usdc: 0,
    sol_balance: 0,
    peak_value_usdc: SAFETY.STARTING_CAPITAL_USDC,
    drawdown_from_peak_usdc: 0,
  }) as {
    timestamp_utc: string;
    total_value_usdc: number;
    cash_usdc: number;
    positions_value_usdc: number;
    sol_balance: number;
    peak_value_usdc: number;
    drawdown_from_peak_usdc: number;
  };

  const positions = (db.prepare(
    `SELECT * FROM positions WHERE status = 'OPEN'`,
  ).all() as Array<Record<string, unknown>>).map((p) => {
    const ticks = db.prepare(
      `SELECT price, loss_pct, timestamp_utc FROM position_ticks
       WHERE position_id = ? ORDER BY timestamp_utc DESC LIMIT 2`,
    ).all(p['id'] as number);
    return { ...p, last_ticks: ticks };
  });

  const decisions = db.prepare(
    `SELECT timestamp_utc, action, token, thesis, invalidation, confidence,
            expected_move_pct, skip_reason
     FROM decisions ORDER BY timestamp_utc DESC LIMIT 10`,
  ).all();

  const trades = db.prepare(
    `SELECT timestamp_utc, token, side, size_usdc, slippage_pct, fee_usdc, tx_signature
     FROM trades ORDER BY timestamp_utc DESC LIMIT 5`,
  ).all();

  const pendingIntents = db.prepare(
    `SELECT * FROM intents WHERE status NOT IN ('CONFIRMED','CHAIN_FAILED','SEND_FAILED')`,
  ).all();

  const reconcilerLastRun = (db.prepare(
    `SELECT value FROM flags WHERE key = 'reconciler_last_run'`,
  ).get() as { value: string } | undefined)?.value ?? null;

  const errors = db.prepare(
    `SELECT timestamp_utc, context, error_message FROM errors ORDER BY timestamp_utc DESC LIMIT 5`,
  ).all();

  const lastHeartbeat = latestHeartbeatUtc();
  const maxAgeMs = ENV.HEARTBEAT_MAX_AGE_HOURS * 3_600_000;
  const heartbeatAgeMs = lastHeartbeat
    ? Date.now() - new Date(lastHeartbeat).getTime()
    : Infinity;
  const secondsUntilPause = lastHeartbeat
    ? Math.max(0, Math.round((maxAgeMs - heartbeatAgeMs) / 1000))
    : 0;

  return {
    portfolio: {
      ...snapshot,
      distance_to_soft_usdc: +(SAFETY.SOFT_PAUSE_DRAWDOWN_USDC - snapshot.drawdown_from_peak_usdc).toFixed(2),
      distance_to_hard_usdc: +(SAFETY.HARD_STOP_DRAWDOWN_USDC - snapshot.drawdown_from_peak_usdc).toFixed(2),
    },
    positions,
    decisions,
    trades,
    pendingIntents,
    reconciler: { lastRun: reconcilerLastRun },
    heartbeat: { lastReceived: lastHeartbeat, secondsUntilPause },
    pauseStatus: { paused: isPaused(), reason: getPauseReason() },
    errors,
  };
}

// ── HTML renderer ─────────────────────────────────────────────────────────────

function renderHtml(state: ReturnType<typeof buildState>): string {
  const { portfolio: pf, positions, decisions, trades, pendingIntents,
    reconciler, heartbeat, pauseStatus, errors } = state;

  const esc = (s: unknown) =>
    String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const row = (...cells: unknown[]) =>
    `<tr>${cells.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`;

  const table = (headers: string[], rows: string[]) => `
    <table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table>`;

  const dd = pf.drawdown_from_peak_usdc.toFixed(2);
  const pauseBadge = pauseStatus.paused
    ? `<span class="bad">PAUSED — ${esc(pauseStatus.reason)}</span>`
    : `<span class="ok">RUNNING</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="15">
  <title>CoinBoi Dashboard</title>
  <style>
    body { font-family: monospace; background: #111; color: #ddd; margin: 1rem 2rem; }
    h2 { color: #aaa; margin: 1.5rem 0 0.5rem; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
    th, td { border: 1px solid #333; padding: 4px 8px; text-align: left; font-size: 0.85rem; }
    th { background: #222; }
    .ok { color: #4f4; } .bad { color: #f44; } .warn { color: #fa4; }
    .metric { display: inline-block; margin: 0 1rem 0.5rem 0; }
    .metric .val { font-size: 1.4rem; font-weight: bold; }
  </style>
</head>
<body>
<h1>CoinBoi ${pauseBadge}</h1>

<h2>Portfolio</h2>
<div>
  <span class="metric"><div>Value</div><div class="val">$${pf.total_value_usdc.toFixed(2)}</div></span>
  <span class="metric"><div>Peak</div><div class="val">$${pf.peak_value_usdc.toFixed(2)}</div></span>
  <span class="metric"><div>Drawdown</div><div class="val ${parseFloat(dd) > 0 ? 'bad' : 'ok'}">-$${dd}</div></span>
  <span class="metric"><div>→ Soft pause</div><div class="val">$${pf.distance_to_soft_usdc}</div></span>
  <span class="metric"><div>→ Hard stop</div><div class="val">$${pf.distance_to_hard_usdc}</div></span>
  <span class="metric"><div>SOL balance</div><div class="val">${pf.sol_balance.toFixed(4)}</div></span>
</div>

<h2>Open Positions (${positions.length} / 3)</h2>
${positions.length === 0 ? '<p>None</p>' : table(
  ['Token', 'Cost basis', 'Tokens', 'Opened', 'Last tick price', 'Last loss%'],
  (positions as Array<Record<string, unknown>>).map((p) => {
    const ticks = (p['last_ticks'] as Array<Record<string, unknown>>) ?? [];
    return row(
      p['token'], `$${Number(p['cost_basis_total_usdc']).toFixed(2)}`,
      p['size_tokens'], p['opened_at_utc'],
      ticks[0]?.['price'] ?? '—', ticks[0]?.['loss_pct'] != null ? `${Number(ticks[0]['loss_pct']).toFixed(1)}%` : '—',
    );
  }),
)}

<h2>Heartbeat</h2>
<p>Last: ${esc(heartbeat.lastReceived ?? 'never')} — ${heartbeat.secondsUntilPause}s until auto-pause</p>

<h2>Last 10 Decisions</h2>
${table(
  ['Time', 'Action', 'Token', 'Confidence', 'Expected%', 'Thesis', 'Invalidation'],
  (decisions as Array<Record<string, unknown>>).map((d) =>
    row(d['timestamp_utc'], d['action'], d['token'] ?? '—', d['confidence'] ?? '—',
        d['expected_move_pct'] ?? '—', d['thesis'] ?? d['skip_reason'] ?? '—', d['invalidation'] ?? '—')),
)}

<h2>Last 5 Trades</h2>
${table(
  ['Time', 'Token', 'Side', 'Size USDC', 'Slippage%', 'Fee USDC'],
  (trades as Array<Record<string, unknown>>).map((t) =>
    row(t['timestamp_utc'], t['token'], t['side'], t['size_usdc'],
        t['slippage_pct'] ?? '—', t['fee_usdc'] ?? '—')),
)}

<h2>Pending Intents</h2>
${pendingIntents.length === 0 ? '<p>None</p>' : table(
  ['ID', 'Token', 'Side', 'Status', 'Created'],
  (pendingIntents as Array<Record<string, unknown>>).map((i) =>
    row(i['id'], i['token'], i['side'], i['status'], i['created_at_utc'])),
)}

<h2>Reconciler</h2>
<p>Last run: ${esc(reconciler.lastRun ?? 'never')}</p>

<h2>Last 5 Errors</h2>
${errors.length === 0 ? '<p>None</p>' : table(
  ['Time', 'Context', 'Message'],
  (errors as Array<Record<string, unknown>>).map((e) =>
    row(e['timestamp_utc'], e['context'], e['error_message'])),
)}

<p style="color:#555;font-size:0.75rem">Generated ${new Date().toISOString()}</p>
</body></html>`;
}

// ── Express app factory ───────────────────────────────────────────────────────

export function createDashboardApp() {
  const app = express();

  app.get('/api/state', (_req, res) => {
    try {
      res.json(buildState());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  app.get('/', (_req, res) => {
    try {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderHtml(buildState()));
    } catch (e) {
      res.status(500).send(`<pre>${String(e)}</pre>`);
    }
  });

  return app;
}

// ── Start server — always 127.0.0.1 ─────────────────────────────────────────

export async function startDashboard(
  opts: { port?: number; host?: string } = {},
): Promise<Server> {
  const host = opts.host ?? ENV.DASHBOARD_HOST;
  const port = opts.port ?? ENV.DASHBOARD_PORT;

  // Guard: refuse 0.0.0.0 — spec §5.3
  if (host === '0.0.0.0') {
    throw new Error('Dashboard must not bind to 0.0.0.0 — use 127.0.0.1 (Tailscale only)');
  }

  const app = createDashboardApp();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}
