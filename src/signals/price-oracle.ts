// Canonical price source for stop-loss evaluation and portfolio valuation.
// See spec §3.4. NEVER use Dexscreener for stops — it lags during fast moves.
//
// Priority:
//   1. Jupiter Quote API: TOKEN → USDC for position.size_tokens (real sell price)
//   2. Pyth via Helius: fallback; rejected if >5% divergent from last Jupiter price
//   3. null → safety loop SKIPS the tick; never stops on stale/missing data
import { z } from 'zod';
import { getFlag, setFlag } from '../observability/db.js';

// ── Injectable fetch for testing ──────────────────────────────────────────────

export interface PriceOracleOptions {
  fetchFn?: typeof fetch;
  jupiterBaseUrl?: string;
  heliusRpcUrl?: string;
}

// ── Jupiter Quote API response (minimal) ─────────────────────────────────────

const jupiterQuoteSchema = z.object({
  outAmount: z.string(),
  inAmount: z.string(),
});

// ── Pyth feed response via Helius ─────────────────────────────────────────────

const pythPriceSchema = z.object({
  result: z.object({
    value: z.object({
      data: z.object({
        parsed: z.object({
          info: z.object({
            price: z.object({
              price: z.string(),
              exponent: z.number(),
            }),
          }),
        }),
      }),
    }),
  }),
});

// ── Persistent last-known-good Jupiter price (flags table) ────────────────────
// Used to detect suspicious Pyth divergence. Key: `oracle_last_jupiter_<mint>`.

const JUPITER_PRICE_FLAG_PREFIX = 'oracle_last_jupiter_';

function storeLastJupiterPrice(tokenMint: string, price: number): void {
  setFlag(`${JUPITER_PRICE_FLAG_PREFIX}${tokenMint}`, String(price));
}

function loadLastJupiterPrice(tokenMint: string): number | null {
  const raw = getFlag(`${JUPITER_PRICE_FLAG_PREFIX}${tokenMint}`);
  if (!raw) return null;
  const n = parseFloat(raw);
  return isFinite(n) ? n : null;
}

// ── canonicalPrice — spec §3.4 ────────────────────────────────────────────────
// Returns the price you would ACTUALLY receive selling size_tokens right now,
// or null if price is unavailable or suspicious.

export async function canonicalPrice(
  tokenMint: string,
  sizeTokens: number,        // position.size_tokens — how many we're pricing
  tokenDecimals: number,     // needed to convert raw lamport amounts
  opts: PriceOracleOptions = {},
): Promise<number | null> {
  // 1. Try Jupiter Quote API (primary)
  const jupiterPrice = await fetchJupiterPrice(tokenMint, sizeTokens, tokenDecimals, opts);
  if (jupiterPrice !== null) {
    storeLastJupiterPrice(tokenMint, jupiterPrice);
    return jupiterPrice;
  }

  // 2. Fallback: Pyth via Helius
  const pythPrice = await fetchPythPrice(tokenMint, opts);
  if (pythPrice === null) return null;

  // Divergence guard: if Pyth diverges >5% from last good Jupiter price, reject
  const lastJupiter = loadLastJupiterPrice(tokenMint);
  if (lastJupiter !== null) {
    const divergence = Math.abs(pythPrice - lastJupiter) / lastJupiter;
    if (divergence > 0.05) {
      // Suspicious divergence — skip this tick, do not stop on stale data
      return null;
    }
  }

  return pythPrice;
}

// ── Jupiter: TOKEN → USDC quote for position.size_tokens ─────────────────────

async function fetchJupiterPrice(
  tokenMint: string,
  sizeTokens: number,
  tokenDecimals: number,
  opts: PriceOracleOptions,
): Promise<number | null> {
  try {
    const fetchFn = opts.fetchFn ?? fetch;
    const baseUrl = opts.jupiterBaseUrl ?? 'https://lite-api.jup.ag';
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDC_DECIMALS = 6;

    // Raw token units — this is the real sell-side price
    const rawAmount = Math.floor(sizeTokens * Math.pow(10, tokenDecimals));
    const url = `${baseUrl}/swap/v1/quote?inputMint=${tokenMint}&outputMint=${USDC_MINT}&amount=${rawAmount}&slippageBps=0`;

    const res = await fetchFn(url);
    if (!res.ok) return null;

    const data = await res.json();
    const parsed = jupiterQuoteSchema.safeParse(data);
    if (!parsed.success) return null;

    const usdcOut = Number(parsed.data.outAmount) / Math.pow(10, USDC_DECIMALS);
    const tokenIn = Number(parsed.data.inAmount) / Math.pow(10, tokenDecimals);
    if (tokenIn === 0) return null;

    return usdcOut / tokenIn;
  } catch {
    return null;
  }
}

// ── Pyth: fallback price via Helius getAccountInfo ────────────────────────────
// Pyth price accounts are fetched by their on-chain address.
// Only called when Jupiter is unavailable.

async function fetchPythPrice(
  tokenMint: string,
  opts: PriceOracleOptions,
): Promise<number | null> {
  try {
    const fetchFn = opts.fetchFn ?? fetch;
    const rpcUrl = opts.heliusRpcUrl ?? process.env['HELIUS_RPC_URL'];
    if (!rpcUrl) return null;

    const pythAccount = PYTH_PRICE_ACCOUNTS[tokenMint];
    if (!pythAccount) return null; // no Pyth feed for this token

    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getAccountInfo',
        params: [pythAccount, { encoding: 'jsonParsed' }],
      }),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const parsed = pythPriceSchema.safeParse(data);
    if (!parsed.success) return null;

    const { price, exponent } = parsed.data.result.value.data.parsed.info.price;
    return parseFloat(price) * Math.pow(10, exponent);
  } catch {
    return null;
  }
}

// ── Pyth price account map — mainnet addresses ─────────────────────────────────
// Extend as tokens are added to the universe.
export const PYTH_PRICE_ACCOUNTS: Record<string, string> = {
  // SOL/USD — useful for gas reserve valuation
  'So11111111111111111111111111111111111111112': 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG',
  // BONK/USD
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': '8ihFLu5FimgTQ1Unh4dVyEHUGodJ738YyXiyVDoExtra',
  // WIF/USD
  'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm': '6B23K3tkb51vLZA14jcEQVCA1pfHptzEHFA93V5dYwbT',
};
