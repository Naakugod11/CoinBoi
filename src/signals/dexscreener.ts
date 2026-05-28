// Dexscreener market data: price, volume, liquidity, market cap, LP status.
// Per-token failure isolation — one bad token never kills the whole cycle.
// See spec §3.1, §3.3.
import { z } from 'zod';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DexscreenerToken {
  mint: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  volume24hUsd: number;
}

export interface DexscreenerTokenDetail extends DexscreenerToken {
  priceUsd: number;
  liquidityUsd: number;
  lpLocked: boolean;    // Dexscreener lock/burn flag (verify on-chain separately)
  priceChange24hPct: number;
}

// ── Zod schemas ───────────────────────────────────────────────────────────────

const pairSchema = z.object({
  baseToken: z.object({
    address: z.string(),
    symbol: z.string(),
    name: z.string(),
  }),
  priceUsd: z.string().optional(),
  volume: z.object({ h24: z.number() }).optional(),
  liquidity: z.object({ usd: z.number().optional() }).optional(),
  fdv: z.number().optional(),         // fully diluted value ≈ market cap proxy
  marketCap: z.number().optional(),
  priceChange: z.object({ h24: z.number().optional() }).optional(),
  // Dexscreener lock flags (not always present)
  liquidity_locked: z.boolean().optional(),
  lp_locked: z.boolean().optional(),
});

const pairsResponseSchema = z.object({
  pairs: z.array(pairSchema).nullable(),
});

const searchResponseSchema = z.object({
  pairs: z.array(pairSchema).nullable(),
});

// ── Client options ────────────────────────────────────────────────────────────

export interface DexscreenerOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
}

function getBaseUrl(opts?: DexscreenerOptions): string {
  return opts?.baseUrl ?? process.env['DEXSCREENER_BASE_URL'] ?? 'https://api.dexscreener.com';
}

// ── fetchTokensByMints — primary data source for universe building ────────────
// Batches up to 30 addresses per request (Dexscreener limit).
// Returns tokens for which data was available; silently drops failures.

export async function fetchTokensByMints(
  mints: string[],
  opts: DexscreenerOptions = {},
): Promise<DexscreenerTokenDetail[]> {
  if (mints.length === 0) return [];

  const fetchFn = opts.fetchFn ?? fetch;
  const base = getBaseUrl(opts);
  const BATCH = 30;
  const results: DexscreenerTokenDetail[] = [];

  for (let i = 0; i < mints.length; i += BATCH) {
    const batch = mints.slice(i, i + BATCH);
    try {
      const url = `${base}/latest/dex/tokens/${batch.join(',')}`;
      const res = await fetchFn(url);
      if (!res.ok) continue; // skip batch on HTTP error

      const raw = await res.json();
      const parsed = pairsResponseSchema.safeParse(raw);
      if (!parsed.success || !parsed.data.pairs) continue;

      for (const pair of parsed.data.pairs) {
        const token = extractTokenDetail(pair);
        if (token) results.push(token);
      }
    } catch {
      // Batch failure: continue with remaining batches
    }
  }

  return results;
}

// ── fetchTrendingSolanaTokens — candidate list for universe ───────────────────
// Returns top Solana pairs by volume. Used to seed the universe candidate list.

export async function fetchTrendingSolanaTokens(
  opts: DexscreenerOptions = {},
  limit = 50,
): Promise<DexscreenerToken[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const base = getBaseUrl(opts);

  try {
    const url = `${base}/latest/dex/search?q=solana`;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`Dexscreener search HTTP ${res.status}`);

    const raw = await res.json();
    const parsed = searchResponseSchema.safeParse(raw);
    if (!parsed.success || !parsed.data.pairs) return [];

    const tokens: DexscreenerToken[] = [];
    const seen = new Set<string>();

    for (const pair of parsed.data.pairs.slice(0, limit * 2)) {
      const mint = pair.baseToken.address;
      if (seen.has(mint)) continue;
      seen.add(mint);

      const mcap = pair.marketCap ?? pair.fdv ?? 0;
      const vol = pair.volume?.h24 ?? 0;

      tokens.push({
        mint,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name,
        marketCapUsd: mcap,
        volume24hUsd: vol,
      });

      if (tokens.length >= limit) break;
    }

    return tokens;
  } catch {
    return [];
  }
}

// ── fetchTokenDetail — single token detail (used for per-token gate checks) ───

export async function fetchTokenDetail(
  mint: string,
  opts: DexscreenerOptions = {},
): Promise<DexscreenerTokenDetail | null> {
  const results = await fetchTokensByMints([mint], opts);
  return results[0] ?? null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractTokenDetail(pair: z.infer<typeof pairSchema>): DexscreenerTokenDetail | null {
  const priceUsd = parseFloat(pair.priceUsd ?? '0');
  if (!isFinite(priceUsd) || priceUsd <= 0) return null;

  const mcap = pair.marketCap ?? pair.fdv ?? 0;
  const vol = pair.volume?.h24 ?? 0;
  const liquidity = pair.liquidity?.usd ?? 0;
  const priceChange24h = pair.priceChange?.h24 ?? 0;
  const lpLocked = pair.liquidity_locked ?? pair.lp_locked ?? false;

  return {
    mint: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    priceUsd,
    marketCapUsd: mcap,
    volume24hUsd: vol,
    liquidityUsd: liquidity,
    lpLocked,
    priceChange24hPct: priceChange24h,
  };
}
