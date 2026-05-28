// Pre-trade quote + slippage/fee budget enforcement. See spec §2.5, §2.8.
// totalCostPct > SLIPPAGE_BUDGET_ONE_WAY → trade is SKIPPED, never executed.
import { z } from 'zod';
import { SLIPPAGE_BUDGET_ONE_WAY, SAFETY } from '../config.js';
import type { SwapExecutor, QuoteRequest } from './sol-cli.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Quote {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  totalCostPct: number;    // fees + slippage, one-way fraction
  routerName: string;
  withinBudget: boolean;   // totalCostPct <= SLIPPAGE_BUDGET_ONE_WAY
  rawSnapshot: string;     // JSON for DB storage in intents.quote_snapshot
  fetchedAtUtc: string;
}

export class SlippageBudgetExceededError extends Error {
  constructor(
    public readonly totalCostPct: number,
    public readonly budgetPct: number,
    public readonly inputMint: string,
    public readonly outputMint: string,
  ) {
    super(
      `Quote cost ${(totalCostPct * 100).toFixed(3)}% exceeds ` +
      `${(budgetPct * 100).toFixed(3)}% one-way budget ` +
      `(${inputMint} → ${outputMint})`
    );
    this.name = 'SlippageBudgetExceededError';
  }
}

// ── Main: fetch quote and enforce budget ──────────────────────────────────────

export async function fetchAndCheckQuote(
  executor: SwapExecutor,
  req: QuoteRequest,
): Promise<Quote> {
  const slippageBps = req.slippageBps ?? SAFETY.JUPITER_SLIPPAGE_BPS;

  const result = await executor.quote({ ...req, slippageBps });

  const quote: Quote = {
    inputMint: result.inputMint,
    outputMint: result.outputMint,
    inputAmount: result.inputAmount,
    outputAmount: result.outputAmount,
    priceImpactPct: result.priceImpactPct,
    totalCostPct: result.totalCostPct,
    routerName: result.routerName,
    withinBudget: result.totalCostPct <= SLIPPAGE_BUDGET_ONE_WAY,
    rawSnapshot: result.rawSnapshot,
    fetchedAtUtc: new Date().toISOString(),
  };

  return quote;
}

// ── Convenience: fetch + throw if over budget ─────────────────────────────────
// Use this at the decision-loop call site; the caller logs SlippageBudgetExceededError
// as a skip (not an error).

export async function requireWithinBudget(
  executor: SwapExecutor,
  req: QuoteRequest,
): Promise<Quote> {
  const quote = await fetchAndCheckQuote(executor, req);
  if (!quote.withinBudget) {
    throw new SlippageBudgetExceededError(
      quote.totalCostPct,
      SLIPPAGE_BUDGET_ONE_WAY,
      quote.inputMint,
      quote.outputMint,
    );
  }
  return quote;
}
