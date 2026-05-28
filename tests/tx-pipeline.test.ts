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

  // ── Crash between SENT and confirm leaves resolvable SENT intent ──────────

  it('crash after SENT leaves a SENT intent for the reconciler', async () => {
    const swapSig = 'crash_test_sig_' + Date.now();
    const executor = makeExecutor({
      swap: vi.fn(async () => ({
        signature: swapSig,
        inputAmount: 5,
        outputAmount: 990000,
        explorerUrl: '',
      })),
    });

    // Helius throws after the swap is sent (simulating a process crash)
    const crashFetch = vi.fn(async () => {
      throw new Error('simulated crash during poll');
    }) as unknown as typeof fetch;

    const deps: TxPipelineDeps = {
      executor,
      heliusOpts: { rpcUrl: HELIUS_URL, walletPublicKey: WALLET_PUBKEY, fetchFn: crashFetch },
    };

    await expect(execute(makeRequest(decisionId), deps)).rejects.toThrow('simulated crash');

    // Intent must be SENT (written before crash) — reconciler can pick it up
    const pending = getPendingIntents();
    const sentIntent = pending.find(i => i.tx_signature === swapSig);
    expect(sentIntent).toBeDefined();
    expect(sentIntent?.status).toBe('SENT');
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
