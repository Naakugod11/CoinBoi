// Helius RPC read layer — tx confirmation polling and on-chain swap parsing.
// Read-only; no key material touches this module. See spec §2.8.
import { z } from 'zod';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PollStatus = 'FINALIZED' | 'FAILED' | 'UNKNOWN';

export interface PollResult {
  status: PollStatus;
  slot?: number;
  err?: unknown;
}

export interface ParsedSwap {
  usdcAmount: number;   // USDC side of the swap (absolute, positive)
  tokenAmount: number;  // Token side of the swap (absolute, positive)
  feeUsdc: number;      // Estimated fee in USDC equivalent
}

// ── RPC primitives ─────────────────────────────────────────────────────────────

// Minimal zod shapes for what we actually read from the Helius RPC responses.
// We only parse what we need; extra fields are stripped.

const signatureStatusSchema = z.object({
  confirmationStatus: z.enum(['processed', 'confirmed', 'finalized']).nullable().optional(),
  err: z.unknown().optional(),
});

const getSignatureStatusesResponseSchema = z.object({
  result: z.object({
    value: z.array(signatureStatusSchema.nullable()),
  }),
});

const transactionSchema = z.object({
  result: z.object({
    meta: z.object({
      err: z.unknown().nullable(),
      preBalances: z.array(z.number()),
      postBalances: z.array(z.number()),
      preTokenBalances: z.array(z.object({
        accountIndex: z.number(),
        mint: z.string(),
        uiTokenAmount: z.object({ uiAmount: z.number().nullable() }),
      })),
      postTokenBalances: z.array(z.object({
        accountIndex: z.number(),
        mint: z.string(),
        uiTokenAmount: z.object({ uiAmount: z.number().nullable() }),
      })),
      fee: z.number(),
    }),
    transaction: z.object({
      message: z.object({
        accountKeys: z.array(z.string()),
      }),
    }),
  }).nullable(),
});

// ── RPC client factory ────────────────────────────────────────────────────────

// Accept an injectable fetch for test mocking; defaults to global fetch.
export interface HeliusClientOptions {
  rpcUrl?: string;
  fetchFn?: typeof fetch;
}

function getRpcUrl(opts?: HeliusClientOptions): string {
  const url = opts?.rpcUrl ?? process.env['HELIUS_RPC_URL'];
  if (!url) throw new Error('HELIUS_RPC_URL not set');
  return url;
}

async function rpcCall(
  method: string,
  params: unknown[],
  opts?: HeliusClientOptions
): Promise<unknown> {
  const fetchFn = opts?.fetchFn ?? fetch;
  const url = getRpcUrl(opts);
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`Helius RPC ${method} HTTP ${res.status}`);
  return res.json();
}

// ── pollUntilFinalized — spec §2.8 ───────────────────────────────────────────

export async function pollUntilFinalized(
  sig: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } & HeliusClientOptions = {}
): Promise<PollResult> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const raw = await rpcCall(
      'getSignatureStatuses',
      [[sig], { searchTransactionHistory: true }],
      opts
    );

    const parsed = getSignatureStatusesResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // Malformed response — wait and retry
      await sleep(pollIntervalMs);
      continue;
    }

    const statusEntry = parsed.data.result.value[0];
    if (statusEntry === null || statusEntry === undefined) {
      // Not yet seen by the node
      await sleep(pollIntervalMs);
      continue;
    }

    if (statusEntry.err) {
      return { status: 'FAILED', err: statusEntry.err };
    }

    if (statusEntry.confirmationStatus === 'finalized') {
      return { status: 'FINALIZED' };
    }

    // Still processing — keep polling
    await sleep(pollIntervalMs);
  }

  return { status: 'UNKNOWN' };
}

// ── parseSwap — extract actual on-chain amounts from a confirmed swap tx ──────
// Parses token balance deltas for the wallet's USDC and the swapped token.
// The USDC mint address is hard-coded (mainnet only). See spec §2.8.

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_PRICE_USDC_FALLBACK = 150; // conservative fallback for fee estimation

export async function parseSwap(
  sig: string,
  opts: HeliusClientOptions = {}
): Promise<ParsedSwap> {
  const raw = await rpcCall(
    'getTransaction',
    [sig, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }],
    opts
  );

  const parsed = transactionSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.result) {
    throw new Error(`parseSwap: could not decode transaction ${sig}: ${JSON.stringify(parsed.error ?? 'null result')}`);
  }

  const { meta, transaction } = parsed.data.result;

  if (meta.err) {
    throw new Error(`parseSwap: transaction ${sig} failed on-chain: ${JSON.stringify(meta.err)}`);
  }

  // Find the wallet's USDC balance change (index 0 = fee payer = our wallet)
  const walletIndex = 0;

  const preUsdc = meta.preTokenBalances.find(
    b => b.accountIndex === walletIndex && b.mint === USDC_MINT
  )?.uiTokenAmount.uiAmount ?? 0;
  const postUsdc = meta.postTokenBalances.find(
    b => b.accountIndex === walletIndex && b.mint === USDC_MINT
  )?.uiTokenAmount.uiAmount ?? 0;

  const usdcDelta = postUsdc - preUsdc;

  // Find the non-USDC token balance change for the wallet
  const walletTokenPre = meta.preTokenBalances.filter(
    b => b.accountIndex === walletIndex && b.mint !== USDC_MINT
  );
  const walletTokenPost = meta.postTokenBalances.filter(
    b => b.accountIndex === walletIndex && b.mint !== USDC_MINT
  );

  // Match by mint address
  const allMints = new Set([
    ...walletTokenPre.map(b => b.mint),
    ...walletTokenPost.map(b => b.mint),
  ]);
  allMints.delete(USDC_MINT);

  let tokenAmount = 0;
  for (const mint of allMints) {
    const pre = walletTokenPre.find(b => b.mint === mint)?.uiTokenAmount.uiAmount ?? 0;
    const post = walletTokenPost.find(b => b.mint === mint)?.uiTokenAmount.uiAmount ?? 0;
    const delta = post - pre;
    if (Math.abs(delta) > Math.abs(tokenAmount)) {
      tokenAmount = delta;
    }
  }

  // SOL fee in USDC equivalent (rough — used only for cost-basis tracking)
  const lamportFee = meta.fee;
  const feeUsdc = (lamportFee / LAMPORTS_PER_SOL) * SOL_PRICE_USDC_FALLBACK;

  return {
    usdcAmount: Math.abs(usdcDelta),
    tokenAmount: Math.abs(tokenAmount),
    feeUsdc,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
