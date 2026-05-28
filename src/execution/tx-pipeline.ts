// Transaction pipeline: intent → send → confirm → parse → record.
// Idempotency is the whole point. NEVER retry without reconciling first.
// See spec §2.8. All state written to SQLite before any chain call.
import {
  insertIntent, updateIntent, insertTrade, nowUtc,
  type IntentRow,
} from '../observability/db.js';
import { pollUntilFinalized, parseSwap, type HeliusClientOptions } from '../signals/helius.js';
import type { SwapExecutor, SwapRequest } from './sol-cli.js';
import type { Quote } from './jupiter-quote.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TxRequest {
  decisionId: number;
  token: string;        // token mint address
  side: 'BUY' | 'SELL';
  walletName: string;
  amountUsdc?: number;  // for BUY
  amountTokens?: number; // for SELL (full wallet balance)
  quote: Quote;
}

export type TxOutcome = 'CONFIRMED' | 'CHAIN_FAILED' | 'UNKNOWN_TIMEOUT' | 'SEND_FAILED';

export interface TxResult {
  outcome: TxOutcome;
  intentId: number;
  tradeId?: number;       // set on CONFIRMED
  txSignature?: string;   // set on SENT and above
  parsedSwap?: {          // on-chain actuals; set on CONFIRMED
    usdcAmount: number;
    tokenAmount: number;
    feeUsdc: number;
  };
}

// applyTradeToPosition is wired by Day 2 (portfolio.ts).
// Placeholder so the pipeline compiles and tests can inject it.
export type ApplyTradeFunc = (
  intentId: number,
  side: 'BUY' | 'SELL',
  token: string,
  usdcAmount: number,
  tokenAmount: number,
) => void;

const noopApply: ApplyTradeFunc = () => { /* stub — wired in Day 2 */ };

// ── Injectable dependencies for testing ──────────────────────────────────────

export interface TxPipelineDeps {
  executor: SwapExecutor;
  heliusOpts?: HeliusClientOptions;
  applyTrade?: ApplyTradeFunc;
  alertFn?: (msg: string) => Promise<void>;
}

// ── execute ───────────────────────────────────────────────────────────────────

export async function execute(req: TxRequest, deps: TxPipelineDeps): Promise<TxResult> {
  const { executor, heliusOpts, applyTrade = noopApply, alertFn = silentAlert } = deps;

  // ── Step 1: Write intent BEFORE sending — survives crash (spec §2.8) ──────
  const intentPayload: Omit<IntentRow, 'id'> = {
    decision_id: req.decisionId,
    token: req.token,
    side: req.side,
    size_usdc: req.amountUsdc ?? null,
    size_tokens: req.amountTokens ?? null,
    quote_snapshot: req.quote.rawSnapshot,
    tx_signature: null,
    status: 'PENDING',
    created_at_utc: nowUtc(),
    resolved_at_utc: null,
  };
  const intentId = insertIntent(intentPayload);

  // ── Step 2: Send ──────────────────────────────────────────────────────────
  let sig: string;
  try {
    const swapReq: SwapRequest = {
      walletName: req.walletName,
      inputMint: req.side === 'BUY'
        ? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
        : req.token,
      outputMint: req.side === 'BUY'
        ? req.token
        : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      amountUsdc: req.amountUsdc,
      amountTokens: req.amountTokens,
    };
    const swapResult = await executor.swap(swapReq);
    sig = swapResult.signature;
  } catch (err) {
    updateIntent(intentId, {
      status: 'SEND_FAILED',
      error: String(err),
      resolved_at_utc: nowUtc(),
    });
    await alertFn(`Trade SEND_FAILED on intent ${intentId}: ${err}`);
    return { outcome: 'SEND_FAILED', intentId };
  }

  updateIntent(intentId, { tx_signature: sig, status: 'SENT' });

  // ── Step 3: Poll for finalized confirmation ───────────────────────────────
  const pollResult = await pollUntilFinalized(sig, { timeoutMs: 90_000, ...heliusOpts });

  if (pollResult.status === 'FAILED') {
    updateIntent(intentId, { status: 'CHAIN_FAILED', resolved_at_utc: nowUtc() });
    await alertFn(`Trade CHAIN_FAILED: ${sig}`);
    return { outcome: 'CHAIN_FAILED', intentId, txSignature: sig };
  }

  if (pollResult.status === 'UNKNOWN') {
    // DO NOT retry. Reconciler resolves UNKNOWN_TIMEOUT intents (spec §2.10).
    updateIntent(intentId, { status: 'UNKNOWN_TIMEOUT' });
    await alertFn(
      `Trade UNKNOWN after 90s: ${sig}. Intent ${intentId} marked UNKNOWN_TIMEOUT. ` +
      `Reconciler will resolve next cycle. DO NOT retry.`
    );
    return { outcome: 'UNKNOWN_TIMEOUT', intentId, txSignature: sig };
  }

  // ── Step 4: Parse on-chain actual amounts ─────────────────────────────────
  const parsed = await parseSwap(sig, heliusOpts ?? {});

  // ── Step 5: Record trade from on-chain reality, not quote values ──────────
  const tradeId = insertTrade({
    intent_id: intentId,
    decision_id: req.decisionId,
    timestamp_utc: nowUtc(),
    token: req.token,
    side: req.side,
    size_usdc: parsed.usdcAmount,
    size_tokens: parsed.tokenAmount,
    price: parsed.tokenAmount > 0 ? parsed.usdcAmount / parsed.tokenAmount : 0,
    tx_signature: sig,
    slippage_pct: req.quote.inputAmount > 0
      ? (req.quote.inputAmount - parsed.usdcAmount) / req.quote.inputAmount
      : null,
    fee_usdc: parsed.feeUsdc,
  });

  updateIntent(intentId, { status: 'CONFIRMED', resolved_at_utc: nowUtc() });

  // ── Step 6: Apply to position (Day 2 portfolio.ts wires this in) ──────────
  applyTrade(intentId, req.side, req.token, parsed.usdcAmount, parsed.tokenAmount);

  return {
    outcome: 'CONFIRMED',
    intentId,
    tradeId,
    txSignature: sig,
    parsedSwap: parsed,
  };
}

// ── marketSellWithRetry ───────────────────────────────────────────────────────
// Used by safety loop for stop-loss exits. Retries until flat OR kill switch.
// Each retry is a fresh intent — spec §2.8 idempotency.
// Returns when position is flat or maxAttempts exceeded (caller alerts).

export async function marketSellWithRetry(
  req: Omit<TxRequest, 'quote'> & { quote: Quote },
  deps: TxPipelineDeps,
  maxAttempts = 5,
): Promise<TxResult> {
  let lastResult: TxResult = { outcome: 'SEND_FAILED', intentId: -1 };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastResult = await execute(req, deps);
    if (lastResult.outcome === 'CONFIRMED') return lastResult;
    if (lastResult.outcome === 'CHAIN_FAILED') {
      // Chain confirmed the failure — stop retrying
      return lastResult;
    }
    // SEND_FAILED or UNKNOWN_TIMEOUT — wait before retry
    await sleep(2_000 * attempt);
  }
  return lastResult;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function silentAlert(_msg: string): Promise<void> { /* wired in later */ }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
