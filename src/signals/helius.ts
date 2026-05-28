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
  // Wallet public key used to identify OUR accounts in a transaction.
  // Falls back to process.env.WALLET_PUBLIC_KEY if omitted.
  walletPublicKey?: string;
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
// Identifies OUR accounts by cross-referencing transaction.message.accountKeys
// against WALLET_PUBLIC_KEY (from opts or env). This is safe when we are not
// the fee payer (e.g., Jupiter fee-payer abstraction puts a program at index 0).

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const LAMPORTS_PER_SOL = 1_000_000_000;
const SOL_PRICE_USDC_FALLBACK = 150; // rough fallback for cost-basis fee estimation

export async function parseSwap(
  sig: string,
  opts: HeliusClientOptions = {}
): Promise<ParsedSwap> {
  const walletPubkey = opts.walletPublicKey ?? process.env['WALLET_PUBLIC_KEY'];
  if (!walletPubkey) {
    throw new Error('parseSwap: WALLET_PUBLIC_KEY not set — cannot identify wallet accounts');
  }

  const raw = await rpcCall(
    'getTransaction',
    [sig, { encoding: 'json', commitment: 'finalized', maxSupportedTransactionVersion: 0 }],
    opts
  );

  const parsed = transactionSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.result) {
    throw new Error(
      `parseSwap: could not decode transaction ${sig}: ` +
      JSON.stringify(parsed.error ?? 'null result')
    );
  }

  const { meta, transaction } = parsed.data.result;

  if (meta.err) {
    throw new Error(`parseSwap: transaction ${sig} failed on-chain: ${JSON.stringify(meta.err)}`);
  }

  // Find every account index belonging to our wallet.
  // accountKeys is an array of base58 public keys; our wallet may appear at
  // multiple indices (main account + ATAs can share the owner's pubkey in the
  // preTokenBalances owner field, but here we match by the key list position).
  const accountKeys: string[] = transaction.message.accountKeys;
  const walletIndices = new Set<number>();
  accountKeys.forEach((key, idx) => {
    if (key === walletPubkey) walletIndices.add(idx);
  });

  if (walletIndices.size === 0) {
    // Wallet not in account list at all — should never happen for a swap we sent
    throw new Error(
      `parseSwap: wallet ${walletPubkey} not found in transaction account keys for ${sig}`
    );
  }

  // Sum USDC deltas across all our wallet indices
  let preUsdcTotal = 0;
  let postUsdcTotal = 0;
  for (const idx of walletIndices) {
    preUsdcTotal += meta.preTokenBalances.find(
      b => b.accountIndex === idx && b.mint === USDC_MINT
    )?.uiTokenAmount.uiAmount ?? 0;
    postUsdcTotal += meta.postTokenBalances.find(
      b => b.accountIndex === idx && b.mint === USDC_MINT
    )?.uiTokenAmount.uiAmount ?? 0;
  }
  const usdcDelta = postUsdcTotal - preUsdcTotal;

  // Sum non-USDC token deltas across our wallet indices
  const walletTokenPre = meta.preTokenBalances.filter(
    b => walletIndices.has(b.accountIndex) && b.mint !== USDC_MINT
  );
  const walletTokenPost = meta.postTokenBalances.filter(
    b => walletIndices.has(b.accountIndex) && b.mint !== USDC_MINT
  );

  // Find the mint with the largest absolute change — that's the swapped token
  const allMints = new Set([
    ...walletTokenPre.map(b => b.mint),
    ...walletTokenPost.map(b => b.mint),
  ]);

  let tokenAmount = 0;
  for (const mint of allMints) {
    const pre = walletTokenPre
      .filter(b => b.mint === mint)
      .reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
    const post = walletTokenPost
      .filter(b => b.mint === mint)
      .reduce((s, b) => s + (b.uiTokenAmount.uiAmount ?? 0), 0);
    const delta = post - pre;
    if (Math.abs(delta) > Math.abs(tokenAmount)) tokenAmount = delta;
  }

  // SOL fee in USDC equivalent — rough, for cost-basis only
  const feeUsdc = (meta.fee / LAMPORTS_PER_SOL) * SOL_PRICE_USDC_FALLBACK;

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
