// Dashboard tests: binding, /api/state shape, HTML on empty DB. See spec §5.3.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import { initDb, closeDb } from '../src/observability/db.js';
import { startDashboard } from '../src/observability/dashboard.js';

function tempDb() {
  return join(tmpdir(), `coinboi-dash-test-${process.pid}-${Date.now()}.db`);
}

async function fetchLocal(server: Server, path: string): Promise<Response> {
  const addr = server.address() as { port: number };
  return fetch(`http://127.0.0.1:${addr.port}${path}`);
}

describe('Dashboard server', () => {
  let server: Server;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = tempDb();
    initDb(dbPath);
    // port: 0 → OS picks a free port; host always 127.0.0.1
    server = await startDashboard({ port: 0, host: '127.0.0.1' });
  });

  afterEach(() => {
    closeDb();
    server.close();
  });

  // ── Critical safety property ─────────────────────────────────────────────────

  it('binds to 127.0.0.1, NOT 0.0.0.0', () => {
    const addr = server.address() as { address: string; port: number };
    expect(addr.address).toBe('127.0.0.1');
    expect(addr.port).toBeGreaterThan(0);
  });

  it('refuses to start if host is 0.0.0.0', async () => {
    await expect(
      startDashboard({ port: 0, host: '0.0.0.0' }),
    ).rejects.toThrow(/0\.0\.0\.0/);
  });

  // ── /api/state ───────────────────────────────────────────────────────────────

  it('/api/state returns 200 with correct shape on fresh DB', async () => {
    const res = await fetchLocal(server, '/api/state');
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;

    // Required top-level keys
    expect(body).toHaveProperty('portfolio');
    expect(body).toHaveProperty('positions');
    expect(body).toHaveProperty('decisions');
    expect(body).toHaveProperty('trades');
    expect(body).toHaveProperty('pendingIntents');
    expect(body).toHaveProperty('reconciler');
    expect(body).toHaveProperty('heartbeat');
    expect(body).toHaveProperty('pauseStatus');
    expect(body).toHaveProperty('errors');

    // Portfolio shape
    const pf = body['portfolio'] as Record<string, unknown>;
    expect(typeof pf['total_value_usdc']).toBe('number');
    expect(typeof pf['peak_value_usdc']).toBe('number');
    expect(typeof pf['drawdown_from_peak_usdc']).toBe('number');
    expect(typeof pf['distance_to_soft_usdc']).toBe('number');
    expect(typeof pf['distance_to_hard_usdc']).toBe('number');

    // Arrays
    expect(Array.isArray(body['positions'])).toBe(true);
    expect(Array.isArray(body['decisions'])).toBe(true);
    expect(Array.isArray(body['trades'])).toBe(true);
    expect(Array.isArray(body['pendingIntents'])).toBe(true);
    expect(Array.isArray(body['errors'])).toBe(true);

    // Pause status
    const ps = body['pauseStatus'] as Record<string, unknown>;
    expect(typeof ps['paused']).toBe('boolean');
  });

  it('/api/state returns empty arrays on fresh DB', async () => {
    const res = await fetchLocal(server, '/api/state');
    const body = await res.json() as Record<string, unknown>;

    expect((body['positions'] as unknown[]).length).toBe(0);
    expect((body['decisions'] as unknown[]).length).toBe(0);
    expect((body['trades'] as unknown[]).length).toBe(0);
    expect((body['errors'] as unknown[]).length).toBe(0);
  });

  // ── HTML ──────────────────────────────────────────────────────────────────────

  it('GET / returns HTML without throwing on empty DB', async () => {
    const res = await fetchLocal(server, '/');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('CoinBoi');
    // Should not contain an error stack trace
    expect(html).not.toContain('Error:');
    expect(html.length).toBeGreaterThan(500);
  });

  it('HTML includes expected section headers', async () => {
    const res = await fetchLocal(server, '/');
    const html = await res.text();
    expect(html).toContain('Portfolio');
    expect(html).toContain('Heartbeat');
    expect(html).toContain('Decisions');
    expect(html).toContain('Trades');
    expect(html).toContain('Errors');
  });
});
