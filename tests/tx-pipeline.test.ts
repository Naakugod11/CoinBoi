// tx-pipeline tests — idempotency, status transitions, crash-safety.
// See spec §2.8. All network calls are mocked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import {
  initDb, closeDb, getIntent, getPendingIntents, nowUtc,
  insertDecision, getDb,
} from '../src/observability/db.js';
import { execute, type TxPipelineDeps, type TxRequest } from '../src/execution/tx-pipeline.js';
import type { SwapExecutor, QuoteResult, SwapResult } from '../src/execution/sol-cli.js';
import type { Quote } from '../src/execution/jupiter-quote.js';
import type { HeliusClientOptions } from '../src/signals/helius.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

function tempDb(): string {
  return join(tmpdir(), `coinboi-txpipe-test-${process.pid}-${Date.now()}.db`);
}

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK
    inputAmount: 5,
    outputAmount: 4.925,
    priceImpactPct: 0.1,
    totalCostPct: 0.0075,
    routerName: 'test',
    withinBudget: true,
    rawSnapshot: '{"test":true}',
    fetchedAtUtc: new Date().toISOString(),
    ...overrides,
  };
}

function makeExecutor(overrides: Partial<SwapExecutor> = {}): SwapExecutor {
  return {
    quote: vi.fn(async (): Promise<QuoteResult> => ({
      inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      outputMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      inputAmount: 5,
      outputAmount: 4.925,
      priceImpactPct: 0.1,
      totalCostPct: 0.0075,
      routerName: 'test',
      rawSnapshot: '{}',
    })),
    swap: vi.fn(async (): Promise<SwapResult> => ({
      signature: 'test_sig_' + Date.now(),
      inputAmount: 5,
      outputAmount: 990000,
      explorerUrl: 'https://solscan.io/tx/test',
    })),
    ...overrides,
  };
}

// Mock helius fetch: builds fake RPC responses
function makeHeliusFetch(opts: {
  finalizeAfterPolls?: number;
  shouldFail?: boolean;
  timeoutAll?: boolean;
}): typeof fetch {
  let pollCount = 0;
  const finalizeAfter = opts.finalizeAfterPolls ?? 1;

  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse((init?.body ?? '{}') as string) as { method: string };

    if (body.method === 'getSignatureStatuses') {
      if (opts.timeoutAll) {
        return new Response(JSON.stringify({ result: { value: [null] } }));
      }
      pollCount++;
      if (opts.shouldFail) {
        return new Response(JSON.stringify({
          result: { value: [{ confirmationStatus: 'finalized', err: { msg: 'InstructionError' } }] },
        }));
      }
      if (pollCount >= finalizeAfter) {
        return new Response(JSON.stringify({
          result: { value: [{ confirmationStatus: 'finalized', err: null }] },
        }));
      }
      return new Response(JSON.stringify({
        result: { value: [{ confirmationStatus: 'confirmed', err: null }] },
      }));
    }

    if (body.method === 'getTransaction') {
      return new Response(JSON.stringify({
        result: {
          meta: {
            err: null,
            preBalances: [1_000_000_000],
            postBalances: [999_800_000],
            fee: 5000,
            preTokenBalances: [
              {
                accountIndex: 0,
                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                uiTokenAmount: { uiAmount: 10.0 },
              },
            ],
            postTokenBalances: [
              {
                accountIndex: 0,
                mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                uiTokenAmount: { uiAmount: 4.975 },
              },
              {
                accountIndex: 0,
                mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
                uiTokenAmount: { uiAmount: 990000 },
              },
            ],
          },
          transaction: {
            message: {
              accountKeys: ['WalletPubkey111111111111111111111111111111111'],
            },
          },
        },
      }));
    }

    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
}

function makeRequest(decisionId: number, overrides: Partial<TxRequest> = {}): TxRequest {
  return {
    decisionId,
    token: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    side: 'BUY',
    walletName: 'coinboi',
    amountUsdc: 5,
    quote: makeQuote(),
    ...overrides,
  };
}

const HELIUS_URL = 'https://fake-helius.example.com/';
const WALLET_PUBKEY = 'WalletPubkey111111111111111111111111111111111';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('tx-pipeline', () => {
  let dbPath: string;
  let decisionId: number;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
    decisionId = insertDecision({
      timestamp_utc: nowUtc(),
      action: 'OPEN',
      token: 'BONK',
      validated: true,
      executed: true,
    });
  });

  afterEach(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
  });

  // ── Intent written BEFORE send ────────────────────────────────────────────

  it('writes intent row with PENDING status before the swap call', async () => {
    let pendingBeforeSend = 0;
    const executor = makeExecutor({
      swap: vi.fn(async () => {
        pendingBeforeSend = getPendingIntents().length;
        return {
          signature: 'sig_before_send_test',
          inputAmount: 5,
          outputAmount: 990000,
          explorerUrl: '',
        };
      }),
    });

    const deps: TxPipelineDeps = {
      executor,
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY, fetchFn: makeHeliusFetch({}) },
    };

    await execute(makeRequest(decisionId), deps);
    expect(pendingBeforeSend).toBeGreaterThanOrEqual(1);
  });

  // ── Happy path: PENDING → SENT → CONFIRMED ────────────────────────────────

  it('transitions intent PENDING → SENT → CONFIRMED on happy path', async () => {
    const deps: TxPipelineDeps = {
      executor: makeExecutor(),
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY, fetchFn: makeHeliusFetch({}) },
    };

    const result = await execute(makeRequest(decisionId), deps);
    expect(result.outcome).toBe('CONFIRMED');
    expect(result.tradeId).toBeGreaterThan(0);

    const intent = getIntent(result.intentId);
    expect(intent?.status).toBe('CONFIRMED');
    expect(intent?.tx_signature).toBeTruthy();
    expect(intent?.resolved_at_utc).toBeTruthy();
  });

  // ── Trade row records parsed on-chain amounts, not quote amounts ──────────

  it('trade row records on-chain amounts, not quote amounts', async () => {
    const deps: TxPipelineDeps = {
      executor: makeExecutor(),
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY, fetchFn: makeHeliusFetch({}) },
    };

    const result = await execute(makeRequest(decisionId), deps);
    expect(result.outcome).toBe('CONFIRMED');

    // Mocked on-chain parse: 10.0 - 4.975 = 5.025 USDC; 990000 tokens
    expect(result.parsedSwap?.usdcAmount).toBeCloseTo(5.025, 3);
    expect(result.parsedSwap?.tokenAmount).toBe(990000);

    // Quote said inputAmount=5 but on-chain was 5.025
    const trade = getDb()
      .prepare('SELECT size_usdc, size_tokens FROM trades WHERE id = ?')
      .get(result.tradeId) as { size_usdc: number; size_tokens: number } | undefined;
    expect(trade?.size_usdc).toBeCloseTo(5.025, 3);
    expect(trade?.size_tokens).toBe(990000);
  });

  // ── Timeout → UNKNOWN_TIMEOUT, zero retries ───────────────────────────────

  it('marks UNKNOWN_TIMEOUT on poll timeout and does NOT retry', async () => {
    const executor = makeExecutor();
    const alerts: string[] = [];
    const deps: TxPipelineDeps = {
      executor,
      heliusOpts: {
        rpcUrl: HELIUS_URL,
        walletPublicKey: WALLET_PUBKEY,
        fetchFn: makeHeliusFetch({ timeoutAll: true }),
        timeoutMs: 80,
        pollIntervalMs: 20,
      } as HeliusClientOptions & { timeoutMs: number; pollIntervalMs: number },
      alertFn: async (msg) => { alerts.push(msg); },
    };

    const result = await execute(makeRequest(decisionId), deps);
    expect(result.outcome).toBe('UNKNOWN_TIMEOUT');

    // swap() called exactly once — no retries by execute()
    expect((executor.swap as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

    const intent = getIntent(result.intentId);
    expect(intent?.status).toBe('UNKNOWN_TIMEOUT');
    // resolved_at_utc NOT set — reconciler owns this
    expect(intent?.resolved_at_utc).toBeNull();

    expect(alerts.some(a => a.includes('UNKNOWN'))).toBe(true);
  });

  // ── SEND_FAILED ───────────────────────────────────────────────────────────

  it('records SEND_FAILED intent when swap throws', async () => {
    const executor = makeExecutor({
      swap: vi.fn(async () => { throw new Error('network timeout'); }),
    });
    const deps: TxPipelineDeps = {
      executor,
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY },
    };

    const result = await execute(makeRequest(decisionId), deps);
    expect(result.outcome).toBe('SEND_FAILED');

    const intent = getIntent(result.intentId);
    expect(intent?.status).toBe('SEND_FAILED');
    expect(intent?.error).toContain('network timeout');
  });

  // ── Network error during poll → UNKNOWN_TIMEOUT (not throw) ─────────────
  // After the bug fix: poll network errors are caught and set UNKNOWN_TIMEOUT.
  // The intent is left in a state the reconciler can resolve.

  it('network error during poll → UNKNOWN_TIMEOUT (not thrown), reconciler-resolvable', async () => {
    const swapSig = 'crash_test_sig_' + Date.now();
    const executor = makeExecutor({
      swap: vi.fn(async () => ({
        signature: swapSig,
        inputAmount: 5,
        outputAmount: 990000,
        explorerUrl: '',
      })),
    });

    // Helius throws — simulates network partition after swap is sent
    const crashFetch = vi.fn(async () => {
      throw new Error('simulated network error during poll');
    }) as unknown as typeof fetch;

    const deps: TxPipelineDeps = {
      executor,
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY, fetchFn: crashFetch },
    };

    // After fix: does NOT throw — returns UNKNOWN_TIMEOUT
    const result = await execute(makeRequest(decisionId), deps);
    expect(result.outcome).toBe('UNKNOWN_TIMEOUT');
    expect(result.txSignature).toBe(swapSig);

    // Intent is in UNKNOWN_TIMEOUT with the signature preserved — reconciler can resolve
    const intent = getIntent(result.intentId);
    expect(intent?.status).toBe('UNKNOWN_TIMEOUT');
    expect(intent?.tx_signature).toBe(swapSig);
  });

  // ── CHAIN_FAILED ──────────────────────────────────────────────────────────

  it('marks CHAIN_FAILED when chain confirms a failure', async () => {
    const deps: TxPipelineDeps = {
      executor: makeExecutor(),
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY, fetchFn: makeHeliusFetch({ shouldFail: true }) },
    };

    const result = await execute(makeRequest(decisionId), deps);
    expect(result.outcome).toBe('CHAIN_FAILED');

    const intent = getIntent(result.intentId);
    expect(intent?.status).toBe('CHAIN_FAILED');
    expect(intent?.resolved_at_utc).toBeTruthy();
  });
});

// ── Day 5 chaos tests ─────────────────────────────────────────────────────────

describe('tx-pipeline chaos §Day5', () => {
  let dbPath: string;
  let decisionId: number;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
    decisionId = insertDecision({
      timestamp_utc: nowUtc(),
      action: 'OPEN',
      token: 'BONK',
      validated: true,
      executed: true,
    });
  });

  afterEach(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
  });

  // ── Bug found and fixed: poll fetch error → UNKNOWN_TIMEOUT (not throw) ────
  // Chaos: network error mid-poll. Swap was sent, sig is recorded.
  // Before fix: execute() threw and left intent in SENT.
  // After fix: UNKNOWN_TIMEOUT is set, reconciler resolves.

  it('chaos: network error during poll → UNKNOWN_TIMEOUT, not thrown, reconciler path left clean', async () => {
    const swapSig = 'poll-fetch-error-sig-' + Date.now();
    const executor = makeExecutor({
      swap: vi.fn(async () => ({
        signature: swapSig,
        inputAmount: 5,
        outputAmount: 990_000,
        explorerUrl: '',
      })),
    });

    let callCount = 0;
    const fetchThatErrors: typeof fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse((init?.body ?? '{}') as string) as { method: string };
      if (body.method === 'getSignatureStatuses') {
        callCount++;
        if (callCount >= 1) throw new Error('network partition — RPC unreachable');
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const alerts: string[] = [];
    const deps: TxPipelineDeps = {
      executor,
      heliusOpts: {
        rpcUrl: HELIUS_URL,
        walletPublicKey: WALLET_PUBKEY,
        fetchFn: fetchThatErrors,
      },
      alertFn: async (msg) => { alerts.push(msg); },
    };

    // Must NOT throw — must return UNKNOWN_TIMEOUT
    const result = await execute(makeRequest(decisionId), deps);

    expect(result.outcome).toBe('UNKNOWN_TIMEOUT');
    expect(result.txSignature).toBe(swapSig);

    const intent = getIntent(result.intentId);
    expect(intent?.status).toBe('UNKNOWN_TIMEOUT');
    expect(intent?.tx_signature).toBe(swapSig); // sig is preserved for reconciler

    // Alert must fire so operator knows
    expect(alerts.some(a => a.includes('UNKNOWN_TIMEOUT'))).toBe(true);
  });

  // ── Crash-then-restart: SENT intent resolved by reconciler ────────────────
  // Chaos: process crashes between swap send and poll.
  // On restart, reconciler finds the SENT intent and applies the finalized tx.

  it('chaos: crash after SENT → reconciler resolves to CONFIRMED and creates position', async () => {
    const { runReconciler } = await import('../src/agent/reconciler.js');
    const { applyTradeToPosition } = await import('../src/execution/portfolio.js');

    const swapSig = 'crash-restart-sig-' + Date.now();
    const executor = makeExecutor({
      swap: vi.fn(async () => ({
        signature: swapSig,
        inputAmount: 5,
        outputAmount: 990_000,
        explorerUrl: '',
      })),
    });

    const crashFetch = vi.fn(async () => {
      throw new Error('simulated crash');
    }) as unknown as typeof fetch;

    // "Crash" — intent written SENT but poll throws
    const pipeResult = await execute(makeRequest(decisionId), {
      executor,
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY, fetchFn: crashFetch },
    });

    // After fix, this is UNKNOWN_TIMEOUT (not a throw), not SENT
    // But the sig is written and reconciler can work
    expect(['UNKNOWN_TIMEOUT', 'SEND_FAILED']).toContain(pipeResult.outcome);
    expect(pipeResult.txSignature).toBe(swapSig);

    // "Restart": reconciler runs, sees the unresolved intent, tx is finalized
    const { getPositionByToken } = await import('../src/observability/db.js');

    const reconcilerDeps = {
      getWalletBalances: vi.fn(async () => ({
        usdcBalance: 20,
        solBalance: 0.5,
        tokens: [{ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', uiBalance: 990_000 }],
      })),
      checkTxStatus: vi.fn(async () => 'finalized' as const),
      parseSwap: vi.fn(async () => ({ usdcAmount: 5.025, tokenAmount: 990_000, feeUsdc: 0.001 })),
      canonicalPrice: vi.fn(async (_mint: string, size: number) => 5.0 / size),
      alert: vi.fn(async () => {}),
      applyTradeToPosition,
    };

    const recon = await runReconciler(reconcilerDeps);
    expect(recon.clean).toBe(true);
    expect(recon.pendingIntentsResolved).toBe(1);

    // Position must exist after reconciler applied the trade
    const pos = getPositionByToken('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
    expect(pos).toBeDefined();
    expect(pos?.size_tokens).toBe(990_000);
  });

  // ── Concurrent execute() on same decisionId creates two intents ───────────
  // Chaos: two threads both pass all gates and call execute() concurrently.
  // Documents: the pipeline has NO DB-level uniqueness guard on decision_id.
  // The mutex in decision-loop.ts is the ONLY guard. If bypassed, two swaps fire.

  it('chaos: concurrent execute() on same decisionId — two intent rows created (relies on mutex)', async () => {
    const swapCount = { n: 0 };
    const executor = makeExecutor({
      swap: vi.fn(async () => {
        swapCount.n++;
        return {
          signature: `concurrent-sig-${swapCount.n}-${Date.now()}`,
          inputAmount: 5,
          outputAmount: 990_000,
          explorerUrl: '',
        };
      }),
    });

    const deps: TxPipelineDeps = {
      executor,
      heliusOpts: {
        rpcUrl: HELIUS_URL,
        walletPublicKey: WALLET_PUBKEY,
        fetchFn: makeHeliusFetch({}),
      },
    };

    // Fire both concurrently — no mutex here
    const [r1, r2] = await Promise.all([
      execute(makeRequest(decisionId), deps),
      execute(makeRequest(decisionId), deps),
    ]);

    // Two intent rows were created (pipeline has no decision_id uniqueness guard)
    // This is expected behavior — the guard lives in decision-loop.ts mutex
    expect(r1.intentId).not.toBe(r2.intentId);

    // Both swaps fired (double-spend scenario if mutex bypassed)
    expect(swapCount.n).toBe(2);

    // Verify: this IS the failure mode the mutex prevents
    const { getPendingIntents } = await import('../src/observability/db.js');
    // All intents for this decision should be resolved now
    const pending = getPendingIntents().filter(i => i.decision_id === decisionId);
    expect(pending).toHaveLength(0); // both resolved (confirmed)
  });
});
