// Token universe — rebuilt every decision cycle. All gates from spec §3.
// Partial-failure tolerant: one token's fetch error drops only that token.
// ALL sources down → universe = ∅, fail closed. See spec §3.3.
import { insertError } from '../observability/db.js';
import type { DexscreenerToken } from '../signals/dexscreener.js';

// ── Spec §3.1 liquidity gate thresholds (EXACT — do not change) ──────────────

export const LIQUIDITY_GATES = {
  MIN_MARKET_CAP_USD: 50_000_000,     // ≥ $50M
  MIN_VOLUME_24H_USD: 5_000_000,      // ≥ $5M
  MIN_AGE_DAYS: 30,                   // ≥ 30 days since launch
  MIN_LP_LOCK_DAYS: 90,               // LP locked or burned ≥ 90 days
} as const;

// ── Spec §3.2 adversarial gate thresholds (EXACT — note loosened vol gate) ───

export const ADVERSARIAL_GATES = {
  MAX_TOP10_HOLDER_PCT: 0.40,         // top-10 holders ≤ 40% of supply
  MIN_UNIQUE_TRADERS_24H: 500,        // ≥ 500 unique active traders
  // Loose: 600% annualized (NOT 200%). Filters blow-off-tops only.
  // Typical Solana memecoin baseline: 300-500% annualized.
  MAX_ANNUALIZED_VOL_PCT: 600,
} as const;

// ── Removed gates (spec §3.2) — never re-add without spec change ─────────────
// - CEX listing requirement
// - Top-20 holder concentration
// - Wallet-to-volume ratio
// - 200% annualized vol cap

// ── Hard-coded rug blocklist ──────────────────────────────────────────────────

export const KNOWN_RUGS = new Set<string>([
  // Add mint addresses as known rugs are identified.
  // Empty at launch — maintained during operation.
]);

// ── Token record passed to the decision loop ──────────────────────────────────

export interface UniverseToken {
  mint: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  volume24hUsd: number;
  ageDays: number;
  lpLocked: boolean;
  lpLockedDays: number;
  top10HolderPct: number;
  uniqueTraders24h: number;
  annualizedVolPct: number;
  jupiterListed: boolean;
}

// ── Dependency interface — injected in tests and wired in production ──────────

export interface UniverseDeps {
  fetchDexscreenerTokens(): Promise<DexscreenerToken[]>;
  checkJupiterListed(mint: string): Promise<boolean>;
  fetchTokenAge(mint: string): Promise<number | null>; // days since launch
  fetchHolderConcentration(mint: string): Promise<number | null>; // top-10 %
  fetchUniqueTraders(mint: string): Promise<number | null>;
  fetchAnnualizedVol(mint: string): Promise<number | null>; // % annualized
  fetchLpStatus(mint: string): Promise<{ locked: boolean; lockedDays: number } | null>;
}

// ── buildUniverse — spec §3 ───────────────────────────────────────────────────
// Rebuilt every decision cycle. Never caches across calls.
// Returns ∅ on total outage (fail closed).

export async function buildUniverse(deps: UniverseDeps): Promise<UniverseToken[]> {
  let candidates: DexscreenerToken[];
  try {
    candidates = await deps.fetchDexscreenerTokens();
  } catch (err) {
    // All signal sources down — fail closed per spec §3.3
    insertError('universe.buildUniverse', 'Dexscreener fetch failed — returning empty universe', String(err));
    return [];
  }

  if (candidates.length === 0) return [];

  const results: UniverseToken[] = [];

  for (const candidate of candidates) {
    // Blocklist check (fast, no I/O)
    if (KNOWN_RUGS.has(candidate.mint)) continue;

    // §3.1 Liquidity gates (Dexscreener data already in hand)
    if (candidate.marketCapUsd < LIQUIDITY_GATES.MIN_MARKET_CAP_USD) continue;
    if (candidate.volume24hUsd < LIQUIDITY_GATES.MIN_VOLUME_24H_USD) continue;

    // Per-token gating — each failure excludes only this token (spec §3.3)
    try {
      // §3.1 Age gate (on-chain via Helius)
      const ageDays = await deps.fetchTokenAge(candidate.mint);
      if (ageDays === null || ageDays < LIQUIDITY_GATES.MIN_AGE_DAYS) continue;

      // §3.1 Jupiter listing
      const jupiterListed = await deps.checkJupiterListed(candidate.mint);
      if (!jupiterListed) continue;

      // §3.1 LP status
      const lp = await deps.fetchLpStatus(candidate.mint);
      if (!lp || !lp.locked || lp.lockedDays < LIQUIDITY_GATES.MIN_LP_LOCK_DAYS) continue;

      // §3.2 Holder concentration
      const top10 = await deps.fetchHolderConcentration(candidate.mint);
      if (top10 === null || top10 > ADVERSARIAL_GATES.MAX_TOP10_HOLDER_PCT) continue;

      // §3.2 Unique traders
      const traders = await deps.fetchUniqueTraders(candidate.mint);
      if (traders === null || traders < ADVERSARIAL_GATES.MIN_UNIQUE_TRADERS_24H) continue;

      // §3.2 Annualized volatility (600% cap — filters blow-off-tops only)
      const vol = await deps.fetchAnnualizedVol(candidate.mint);
      if (vol === null || vol > ADVERSARIAL_GATES.MAX_ANNUALIZED_VOL_PCT) continue;

      results.push({
        mint: candidate.mint,
        symbol: candidate.symbol,
        name: candidate.name,
        marketCapUsd: candidate.marketCapUsd,
        volume24hUsd: candidate.volume24hUsd,
        ageDays,
        lpLocked: lp.locked,
        lpLockedDays: lp.lockedDays,
        top10HolderPct: top10,
        uniqueTraders24h: traders,
        annualizedVolPct: vol,
        jupiterListed,
      });
    } catch (err) {
      // Single-token failure: exclude and continue (spec §3.3)
      insertError(
        'universe.buildUniverse',
        `Per-token gate failed for ${candidate.mint} (${candidate.symbol}) — excluded`,
        String(err)
      );
    }
  }

  return results;
}

// ── Gate predicates (exported for unit tests) ─────────────────────────────────

export function passesLiquidityGates(t: Pick<UniverseToken, 'marketCapUsd' | 'volume24hUsd' | 'ageDays' | 'lpLocked' | 'lpLockedDays' | 'jupiterListed'>): boolean {
  return (
    t.marketCapUsd >= LIQUIDITY_GATES.MIN_MARKET_CAP_USD &&
    t.volume24hUsd >= LIQUIDITY_GATES.MIN_VOLUME_24H_USD &&
    t.ageDays >= LIQUIDITY_GATES.MIN_AGE_DAYS &&
    t.jupiterListed &&
    t.lpLocked &&
    t.lpLockedDays >= LIQUIDITY_GATES.MIN_LP_LOCK_DAYS
  );
}

export function passesAdversarialGates(t: Pick<UniverseToken, 'top10HolderPct' | 'uniqueTraders24h' | 'annualizedVolPct'>): boolean {
  return (
    t.top10HolderPct <= ADVERSARIAL_GATES.MAX_TOP10_HOLDER_PCT &&
    t.uniqueTraders24h >= ADVERSARIAL_GATES.MIN_UNIQUE_TRADERS_24H &&
    t.annualizedVolPct <= ADVERSARIAL_GATES.MAX_ANNUALIZED_VOL_PCT
  );
}
