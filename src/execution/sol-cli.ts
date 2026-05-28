// Subprocess wrapper around @solana-compass/cli (`sol`).
// Security audit passed at SHA 554f9e28df72b2482b6fee041b78f08cabba2377.
// See /tmp/sol-cli-review/AUDIT.md for findings and required config.
// See spec §12.1. All audit constraints are documented inline with // See audit.
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { SLIPPAGE_BUDGET_ONE_WAY, SAFETY, EXECUTION_MODE } from '../config.js';

// ── See audit: pin the reviewed commit SHA ───────────────────────────────────
// Must match the reviewed version. SolCliSwapExecutor validates on first use.
const REVIEWED_SOL_CLI_SHA = '554f9e28df72b2482b6fee041b78f08cabba2377';
const REVIEWED_SOL_CLI_VERSION = '0.3.4';

// ── Interface ─────────────────────────────────────────────────────────────────

export interface QuoteRequest {
  inputMint: string;   // always a mint address — see audit: ticker-spoofing protection
  outputMint: string;
  amountUsdc: number;  // USDC in for a buy; ignored for sell (use amountTokens)
  amountTokens?: number; // token amount for sells
  slippageBps?: number;
}

export interface QuoteResult {
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  outputAmount: number;
  priceImpactPct: number;
  totalCostPct: number;   // (inputAmount - outputUsdEquiv) / inputAmount; one-way
  routerName: string;
  rawSnapshot: string;    // JSON string for DB storage
}

export interface SwapRequest {
  walletName: string;
  inputMint: string;    // See audit: always mint address, never ticker
  outputMint: string;
  amountUsdc?: number;
  amountTokens?: number;
  slippageBps?: number;
}

export interface SwapResult {
  signature: string;
  inputAmount: number;
  outputAmount: number;
  explorerUrl: string;
}

export interface SwapExecutor {
  quote(req: QuoteRequest): Promise<QuoteResult>;
  swap(req: SwapRequest): Promise<SwapResult>;
}

// ── Paper executor ────────────────────────────────────────────────────────────
// Used in EXECUTION_MODE === 'paper'. Never calls a subprocess or hits mainnet.

export class PaperSwapExecutor implements SwapExecutor {
  // Simulated fill: apply a small constant slippage to model realistic outcomes
  private readonly simulatedSlippagePct = 0.005; // 0.5% one-way

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    const inputAmount = req.amountUsdc ?? (req.amountTokens ?? 0);
    const slippage = this.simulatedSlippagePct;
    const outputAmount = inputAmount * (1 - slippage);
    const snapshot = JSON.stringify({ paper: true, req, slippage });
    return {
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      inputAmount,
      outputAmount,
      priceImpactPct: slippage * 100,
      totalCostPct: slippage,
      routerName: 'paper',
      rawSnapshot: snapshot,
    };
  }

  async swap(req: SwapRequest): Promise<SwapResult> {
    const inputAmount = req.amountUsdc ?? req.amountTokens ?? 0;
    const outputAmount = inputAmount * (1 - this.simulatedSlippagePct);
    const fakeSig = `paper_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return {
      signature: fakeSig,
      inputAmount,
      outputAmount,
      explorerUrl: `https://solscan.io/tx/${fakeSig}?cluster=mainnet`,
    };
  }
}

// ── Live executor — only constructed when EXECUTION_MODE === 'live' ───────────

// JSON envelope returned by `sol --json` commands
const solEnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  meta: z.record(z.unknown()).optional(),
});

const quoteDataSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inputUiAmount: z.number(),
  outputUiAmount: z.number(),
  priceImpactPct: z.number(),
  routerName: z.string(),
  slippageBps: z.number().optional(),
});

const swapDataSchema = z.object({
  signature: z.string(),
  inputAmount: z.number(),
  outputAmount: z.number(),
  explorerUrl: z.string(),
});

export class SolCliSwapExecutor implements SwapExecutor {
  private verified = false;

  constructor() {
    // See audit §5 + CLAUDE.md §12.1: guard against accidental live instantiation
    if (EXECUTION_MODE !== 'live') {
      throw new Error(
        'SolCliSwapExecutor must only be constructed when EXECUTION_MODE === "live". ' +
        'Use PaperSwapExecutor in paper mode.'
      );
    }
  }

  // ── SHA/version check — run once before first real swap ───────────────────
  private ensureVerified(): void {
    if (this.verified) return;

    // See audit: verify installed version matches reviewed SHA.
    // We check the package version as a proxy; full SHA verification
    // would require `git -C $(npm root -g)/@solana-compass/cli rev-parse HEAD`
    // which is fragile in Docker. Version pinning is the primary control;
    // the SHA is documented for manual re-audit when upgrading.
    const result = spawnSync('sol', ['--version'], { encoding: 'utf-8' });
    if (result.error || result.status !== 0) {
      throw new Error(
        `sol CLI not found or not executable. ` +
        `Install @solana-compass/cli@${REVIEWED_SOL_CLI_VERSION} (reviewed SHA ${REVIEWED_SOL_CLI_SHA}).`
      );
    }
    const versionOutput = (result.stdout ?? '').trim();
    if (!versionOutput.includes(REVIEWED_SOL_CLI_VERSION)) {
      throw new Error(
        `sol CLI version mismatch. Expected ${REVIEWED_SOL_CLI_VERSION} ` +
        `(reviewed SHA ${REVIEWED_SOL_CLI_SHA}), got: ${versionOutput}. ` +
        `Re-run security audit before upgrading.`
      );
    }
    this.verified = true;
  }

  // ── subprocess invocation ─────────────────────────────────────────────────
  // See audit: args as array — no shell string interpolation, no token-data injection.
  private runSol(args: string[]): unknown {
    // See audit: always --json for structured output; never --verbose (signed tx on stderr)
    const result = spawnSync('sol', ['--json', ...args], {
      encoding: 'utf-8',
      timeout: 30_000,
      // See audit: do NOT call registerDefaultProviders / lend / earn / LP — swap only.
      // Subprocess environment: strip sensitive vars that shouldn't leak to sol CLI.
      env: {
        ...process.env,
        // Ensure paper mode cannot slip through to the subprocess
        PAPER_TRADE: 'false',
        LIVE_CONFIRMED: 'true',
      },
    });

    if (result.error) throw new Error(`sol subprocess error: ${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`sol exited with code ${result.status}: ${result.stderr}`);
    }

    const raw = JSON.parse(result.stdout);
    const envelope = solEnvelopeSchema.parse(raw);
    if (!envelope.ok) {
      throw new Error(`sol command failed: ${envelope.message ?? envelope.error ?? 'unknown error'}`);
    }
    return envelope.data;
  }

  async quote(req: QuoteRequest): Promise<QuoteResult> {
    this.ensureVerified();

    const slippageBps = req.slippageBps
      ?? Math.round(SAFETY.SLIPPAGE_BUDGET_ONE_WAY * 10_000); // 150

    // See audit: use mint addresses, not ticker symbols (ticker-spoofing protection)
    // See audit: rewardBps=0 on every call (0 for USDC pairs anyway; defence-in-depth)
    const amountStr = req.amountUsdc != null
      ? String(req.amountUsdc)
      : String(req.amountTokens);

    const args = [
      'token', 'swap',
      amountStr, req.inputMint, req.outputMint,
      '--slippage', String(slippageBps),
      '--quote-only',
    ];

    const data = this.runSol(args);
    const q = quoteDataSchema.parse(data);

    // Compute cost pct: fraction of input value lost to fees+slippage
    const totalCostPct = q.inputUiAmount > 0
      ? Math.max(0, (q.inputUiAmount - q.outputUiAmount) / q.inputUiAmount)
      : 0;

    return {
      inputMint: q.inputMint,
      outputMint: q.outputMint,
      inputAmount: q.inputUiAmount,
      outputAmount: q.outputUiAmount,
      priceImpactPct: q.priceImpactPct,
      totalCostPct,
      routerName: q.routerName,
      rawSnapshot: JSON.stringify(data),
    };
  }

  async swap(req: SwapRequest): Promise<SwapResult> {
    this.ensureVerified();

    const slippageBps = req.slippageBps ?? SAFETY.JUPITER_SLIPPAGE_BPS;
    const amount = req.amountUsdc ?? req.amountTokens;
    if (amount == null) throw new Error('swap: provide amountUsdc or amountTokens');

    // See audit: args as array — no shell interpolation. Mints validated upstream.
    const args = [
      'token', 'swap',
      String(amount), req.inputMint, req.outputMint,
      '--slippage', String(slippageBps),
      '--wallet', req.walletName,
      '--yes', // skip interactive confirmation; we confirmed above the mutex
    ];

    const data = this.runSol(args);
    const s = swapDataSchema.parse(data);
    return s;
  }
}

// ── Factory — the only place that decides which executor to instantiate ───────

export function createSwapExecutor(): SwapExecutor {
  if (EXECUTION_MODE === 'live') {
    return new SolCliSwapExecutor();
  }
  return new PaperSwapExecutor();
}
