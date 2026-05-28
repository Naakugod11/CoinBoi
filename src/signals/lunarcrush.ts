// LunarCrush social sentiment — free tier, Week 1.
// Graceful degradation: on rate-limit OR any error → return null (no signal).
// Decision loop treats null as "sentiment absent" and continues without it.
// See spec §2.1, open question §12.5.
import { z } from 'zod';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenSentiment {
  symbol: string;
  galaxyScore: number;         // 0-100 overall sentiment/activity
  altRank: number;             // rank vs all tracked assets (lower = better)
  socialVolume: number;        // social mentions volume
  sentiment: 'bullish' | 'bearish' | 'neutral';
}

// ── Zod schema (LunarCrush free API v4) ──────────────────────────────────────

const lcCoinSchema = z.object({
  symbol: z.string(),
  galaxy_score: z.number().optional(),
  alt_rank: z.number().optional(),
  social_volume: z.number().optional(),
  sentiment: z.number().optional(),  // 0-100 where >60 bullish, <40 bearish
});

const lcResponseSchema = z.object({
  data: z.array(lcCoinSchema),
});

// ── Client options ────────────────────────────────────────────────────────────

export interface LunarCrushOptions {
  fetchFn?: typeof fetch;
  baseUrl?: string;
  apiKey?: string;
}

function getApiKey(opts?: LunarCrushOptions): string | undefined {
  return opts?.apiKey ?? process.env['LUNARCRUSH_API_KEY'];
}

// ── fetchSentiment — graceful no-signal on any failure ───────────────────────
// Returns null when rate-limited, API key missing, network error, or bad data.
// The decision loop must treat null as "no sentiment signal available".

export async function fetchSentiment(
  symbol: string,
  opts: LunarCrushOptions = {},
): Promise<TokenSentiment | null> {
  const apiKey = getApiKey(opts);
  if (!apiKey) return null; // no key → no signal, not an error

  const fetchFn = opts.fetchFn ?? fetch;
  const base = opts.baseUrl ?? 'https://lunarcrush.com/api4/public';

  try {
    const url = `${base}/coins/${symbol.toLowerCase()}/v1`;
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    // 429 = rate limit, 403 = key expired, 404 = unknown symbol
    // All → no signal, never throw
    if (!res.ok) return null;

    const raw = await res.json();
    const parsed = lcResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.data.length === 0) return null;

    const coin = parsed.data.data[0]!;
    return mapSentiment(coin);
  } catch {
    // Network error, JSON parse error, etc. — return no signal
    return null;
  }
}

// ── fetchBatchSentiment — fetch multiple symbols, skip failures individually ──

export async function fetchBatchSentiment(
  symbols: string[],
  opts: LunarCrushOptions = {},
): Promise<Map<string, TokenSentiment>> {
  const results = new Map<string, TokenSentiment>();
  await Promise.all(
    symbols.map(async (sym) => {
      const sentiment = await fetchSentiment(sym, opts);
      if (sentiment) results.set(sym, sentiment);
    })
  );
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapSentiment(coin: z.infer<typeof lcCoinSchema>): TokenSentiment {
  const sentimentScore = coin.sentiment ?? 50;
  const sentiment: TokenSentiment['sentiment'] =
    sentimentScore > 60 ? 'bullish' :
    sentimentScore < 40 ? 'bearish' :
    'neutral';

  return {
    symbol: coin.symbol,
    galaxyScore: coin.galaxy_score ?? 0,
    altRank: coin.alt_rank ?? 9999,
    socialVolume: coin.social_volume ?? 0,
    sentiment,
  };
}
