// Reconciler tests — spec §2.10: intent resolution, position diff, dust handling.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import {
  initDb, closeDb, nowUtc,
  openPosition, getPositionByToken,
  insertDecision, insertIntent, getIntent,
  isPaused, getPauseReason,
} from '../src/observability/db.js';
import { runReconciler, type ReconcilerDeps } from '../src/agent/reconciler.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempDb() {
  return join(tmpdir(), `coinboi-recon-test-${process.pid}-${Date.now()}.db`);
}

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF  = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function makeDecisionAndIntent(
  token: string,
  sig: string,
  side: 'BUY' | 'SELL' = 'BUY',
  createdAtOverride?: string,
): number {
  const decId = insertDecision({ timestamp_utc: nowUtc(), action: 'OPEN', validated: true, executed: true });
  return insertIntent({
    decision_id: decId,
    token,
    side,
    quote_snapshot: '{}',
    tx_signature: sig,
    status: 'SENT',
    created_at_utc: createdAtOverride ?? nowUtc(),
  });
}

function baseDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps {
  return {
    getWalletBalances: vi.fn(async () => ({
      usdcBalance: 20,
      solBalance: 0.5,
      tokens: [],
    })),
    checkTxStatus: vi.fn(async () => 'unknown' as const),
    parseSwap: vi.fn(async () => ({ usdcAmount: 5.0, tokenAmount: 1_000_000, feeUsdc: 0.001 })),
    canonicalPrice: vi.fn(async (_mint, size) => size > 0 ? 5.0 / size : null),
    alert: vi.fn(async () => {}),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('reconciler §2.10', () => {
  let dbPath: string;

  beforeEach(() => { dbPath = tempDb(); initDb(dbPath); });

  afterEach(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
    vi.clearAllMocks();
  });

  // ── SENT intent that finalized gets applied ───────────────────────────────

  it('SENT intent with finalized tx gets CONFIRMED and position opened', async () => {
    const iid = makeDecisionAndIntent(BONK, 'finalized-sig');

    // Wallet reflects the tokens received from the finalized swap; omitting them
    // would trigger a false position-diff mismatch immediately after intent application.
    const deps = baseDeps({
      checkTxStatus: vi.fn(async () => 'finalized' as const),
      parseSwap: vi.fn(async () => ({ usdcAmount: 5.025, tokenAmount: 990_000, feeUsdc: 0.001 })),
      getWalletBalances: vi.fn(async () => ({
        usdcBalance: 20,
        solBalance: 0.5,
        tokens: [{ mint: BONK, uiBalance: 990_000 }],
      })),
    });

    const result = await runReconciler(deps);

    expect(result.pendingIntentsResolved).toBe(1);
    expect(result.clean).toBe(true);

    const intent = getIntent(iid);
    expect(intent?.status).toBe('CONFIRMED');
    expect(intent?.resolved_at_utc).toBeTruthy();

    // Position should have been created via applyTradeToPosition
    const pos = getPositionByToken(BONK);
    expect(pos).toBeDefined();
    expect(pos?.size_tokens).toBe(990_000);
    expect(pos?.cost_basis_total_usdc).toBe(5.025);
  });

  it('SENT intent with failed tx gets CHAIN_FAILED', async () => {
    const iid = makeDecisionAndIntent(BONK, 'failed-sig');

    const deps = baseDeps({
      checkTxStatus: vi.fn(async () => 'failed' as const),
    });

    await runReconciler(deps);

    const intent = getIntent(iid);
    expect(intent?.status).toBe('CHAIN_FAILED');
    expect(intent?.resolved_at_utc).toBeTruthy();
  });

  it('intent unknown but young stays as SENT (no STUCK yet)', async () => {
    const iid = makeDecisionAndIntent(BONK, 'young-unknown-sig');

    const deps = baseDeps({
      checkTxStatus: vi.fn(async () => 'unknown' as const),
    });

    await runReconciler(deps);

    const intent = getIntent(iid);
    expect(intent?.status).toBe('SENT'); // unchanged — not yet 10 min old
  });

  it('intent unknown and >10 min old becomes STUCK + alert', async () => {
    const oldTime = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    const iid = makeDecisionAndIntent(BONK, 'stuck-sig', 'BUY', oldTime);

    const alerts: string[] = [];
    const deps = baseDeps({
      checkTxStatus: vi.fn(async () => 'unknown' as const),
      alert: vi.fn(async (msg) => { alerts.push(msg); }),
    });

    const result = await runReconciler(deps);

    expect(result.stuckIntentsFound).toBe(1);
    const intent = getIntent(iid);
    expect(intent?.status).toBe('STUCK');
    expect(alerts.some(a => a.includes('STUCK'))).toBe(true);
  });

  // ── Dust handling — tokens worth < $0.50 ignored ──────────────────────────

  it('wallet token worth < $0.50 is not flagged as untracked (dust)', async () => {
    // BONK in wallet with tiny balance worth $0.10
    const deps = baseDeps({
      getWalletBalances: vi.fn(async () => ({
        usdcBalance: 25,
        solBalance: 0.5,
        tokens: [{ mint: BONK, uiBalance: 100 }], // 100 tokens
      })),
      // 100 tokens × $0.001 = $0.10 → below $0.50 dust threshold
      canonicalPrice: vi.fn(async () => 0.001),
    });

    const result = await runReconciler(deps);

    expect(result.untrackedTokens).toHaveLength(0);
    expect(result.clean).toBe(true);
  });

  it('wallet token worth > $0.50 with no DB position triggers mismatch', async () => {
    // BONK in wallet but no open position in DB
    const deps = baseDeps({
      getWalletBalances: vi.fn(async () => ({
        usdcBalance: 25,
        solBalance: 0.5,
        tokens: [{ mint: BONK, uiBalance: 1_000_000 }],
      })),
      // $5.00 value — above dust threshold
      canonicalPrice: vi.fn(async () => 5.0 / 1_000_000),
    });

    const result = await runReconciler(deps);

    expect(result.untrackedTokens).toContain(BONK);
    expect(result.clean).toBe(false);
    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('reconciler_mismatch');
  });

  // ── Position matching wallet within tolerance → clean ─────────────────────

  it('position matching wallet balance exactly → clean reconcile', async () => {
    // Open a position for 1,000,000 BONK
    openPosition({ token: BONK, opened_at_utc: nowUtc(), cost_basis_total_usdc: 5.0, size_tokens: 1_000_000 });

    const deps = baseDeps({
      getWalletBalances: vi.fn(async () => ({
        usdcBalance: 25,
        solBalance: 0.5,
        tokens: [{ mint: BONK, uiBalance: 1_000_000 }],
      })),
      canonicalPrice: vi.fn(async () => 5.0 / 1_000_000),
    });

    const result = await runReconciler(deps);
    expect(result.positionMismatches).toBe(0);
    expect(result.clean).toBe(true);
  });

  it('position matching wallet within dust tolerance → clean', async () => {
    // Position says 1,000,000; wallet has 999,900 (diff = 100 tokens = $0.0005 at price 5e-6)
    openPosition({ token: BONK, opened_at_utc: nowUtc(), cost_basis_total_usdc: 5.0, size_tokens: 1_000_000 });

    const deps = baseDeps({
      getWalletBalances: vi.fn(async () => ({
        usdcBalance: 25,
        solBalance: 0.5,
        tokens: [{ mint: BONK, uiBalance: 999_900 }], // 100 token diff
      })),
      // Price: 5e-6 → 100 tokens = $0.0005, well below $0.50 dust
      canonicalPrice: vi.fn(async () => 5.0 / 1_000_000),
    });

    const result = await runReconciler(deps);
    expect(result.positionMismatches).toBe(0);
    expect(result.clean).toBe(true);
  });

  it('position significantly different from wallet → mismatch + pause', async () => {
    // Position says 1,000,000 but wallet only has 500,000 (diff = $2.50 > $0.50 dust)
    openPosition({ token: BONK, opened_at_utc: nowUtc(), cost_basis_total_usdc: 5.0, size_tokens: 1_000_000 });

    const deps = baseDeps({
      getWalletBalances: vi.fn(async () => ({
        usdcBalance: 25,
        solBalance: 0.5,
        tokens: [{ mint: BONK, uiBalance: 500_000 }],
      })),
      canonicalPrice: vi.fn(async () => 5.0 / 1_000_000),
    });

    const result = await runReconciler(deps);
    expect(result.positionMismatches).toBe(1);
    expect(result.clean).toBe(false);
    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('reconciler_mismatch');
  });

  // ── Wallet fetch failure → mismatch ───────────────────────────────────────

  it('wallet balance fetch failure triggers mismatch pause', async () => {
    const deps = baseDeps({
      getWalletBalances: vi.fn(async () => { throw new Error('RPC down'); }),
    });

    const result = await runReconciler(deps);
    expect(result.clean).toBe(false);
    expect(isPaused()).toBe(true);
    expect(getPauseReason()).toBe('reconciler_mismatch');
  });
});
