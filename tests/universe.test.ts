// Universe filter tests — spec §3.1, §3.2, §3.3 gates.
// All thresholds are the EXACT spec values, not test-convenient approximations.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { initDb, closeDb } from '../src/observability/db.js';
import {
  buildUniverse, passesLiquidityGates, passesAdversarialGates,
  LIQUIDITY_GATES, ADVERSARIAL_GATES, KNOWN_RUGS,
  type UniverseDeps, type UniverseToken,
} from '../src/execution/universe.js';
import type { DexscreenerToken } from '../src/signals/dexscreener.js';

// ── DB setup (buildUniverse calls insertError) ────────────────────────────────

function tempDb() { return join(tmpdir(), `coinboi-univ-test-${process.pid}-${Date.now()}.db`); }

let dbPath: string;
beforeEach(() => { dbPath = tempDb(); initDb(dbPath); });
afterEach(() => {
  closeDb();
  for (const ext of ['', '-wal', '-shm']) {
    const p = dbPath + ext;
    if (existsSync(p)) rmSync(p);
  }
});

// ── Fixtures ─────────────────────────────────────────────────────────────────

const GOOD_TOKEN: DexscreenerToken = {
  mint: 'GoodMint1111111111111111111111111111111111111',
  symbol: 'GOOD',
  name: 'GoodCoin',
  marketCapUsd: 100_000_000,  // $100M ≥ $50M ✓
  volume24hUsd: 10_000_000,   // $10M  ≥ $5M  ✓
};

function goodDeps(overrides: Partial<UniverseDeps> = {}): UniverseDeps {
  return {
    fetchDexscreenerTokens: vi.fn(async () => [GOOD_TOKEN]),
    checkJupiterListed: vi.fn(async () => true),
    fetchTokenAge: vi.fn(async () => 60),                // 60 days ≥ 30 ✓
    fetchHolderConcentration: vi.fn(async () => 0.25),   // 25% ≤ 40% ✓
    fetchUniqueTraders: vi.fn(async () => 800),          // 800 ≥ 500 ✓
    fetchAnnualizedVol: vi.fn(async () => 400),          // 400% ≤ 600% ✓
    fetchLpStatus: vi.fn(async () => ({ locked: true, lockedDays: 120 })), // ≥ 90 ✓
    ...overrides,
  };
}

// ── §3.1 Liquidity gate tests ─────────────────────────────────────────────────

describe('universe §3.1 liquidity gates', () => {
  it('token passing all gates is included', async () => {
    const universe = await buildUniverse(goodDeps());
    expect(universe).toHaveLength(1);
    expect(universe[0]!.symbol).toBe('GOOD');
  });

  it('market cap below $50M is excluded', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => [{
        ...GOOD_TOKEN, marketCapUsd: 49_999_999,
      }]),
    });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('market cap exactly $50M passes', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => [{
        ...GOOD_TOKEN, marketCapUsd: 50_000_000,
      }]),
    });
    expect(await buildUniverse(deps)).toHaveLength(1);
  });

  it('volume below $5M is excluded', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => [{
        ...GOOD_TOKEN, volume24hUsd: 4_999_999,
      }]),
    });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('token age < 30 days is excluded', async () => {
    expect(await buildUniverse(goodDeps({ fetchTokenAge: vi.fn(async () => 29) }))).toHaveLength(0);
  });

  it('token age exactly 30 days passes', async () => {
    expect(await buildUniverse(goodDeps({ fetchTokenAge: vi.fn(async () => 30) }))).toHaveLength(1);
  });

  it('not on Jupiter is excluded', async () => {
    expect(await buildUniverse(goodDeps({ checkJupiterListed: vi.fn(async () => false) }))).toHaveLength(0);
  });

  it('LP not locked is excluded', async () => {
    const deps = goodDeps({
      fetchLpStatus: vi.fn(async () => ({ locked: false, lockedDays: 0 })),
    });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('LP locked but < 90 days is excluded', async () => {
    const deps = goodDeps({
      fetchLpStatus: vi.fn(async () => ({ locked: true, lockedDays: 89 })),
    });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('LP locked exactly 90 days passes', async () => {
    const deps = goodDeps({
      fetchLpStatus: vi.fn(async () => ({ locked: true, lockedDays: 90 })),
    });
    expect(await buildUniverse(deps)).toHaveLength(1);
  });

  it('token in KNOWN_RUGS blocklist is excluded', async () => {
    KNOWN_RUGS.add(GOOD_TOKEN.mint);
    try {
      expect(await buildUniverse(goodDeps())).toHaveLength(0);
    } finally {
      KNOWN_RUGS.delete(GOOD_TOKEN.mint);
    }
  });
});

// ── §3.2 Adversarial gate tests ───────────────────────────────────────────────

describe('universe §3.2 adversarial gates', () => {
  it('top-10 holder concentration > 40% is excluded', async () => {
    const deps = goodDeps({ fetchHolderConcentration: vi.fn(async () => 0.41) });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('top-10 holder concentration exactly 40% passes', async () => {
    const deps = goodDeps({ fetchHolderConcentration: vi.fn(async () => 0.40) });
    expect(await buildUniverse(deps)).toHaveLength(1);
  });

  it('unique traders < 500 is excluded', async () => {
    const deps = goodDeps({ fetchUniqueTraders: vi.fn(async () => 499) });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('unique traders exactly 500 passes', async () => {
    const deps = goodDeps({ fetchUniqueTraders: vi.fn(async () => 500) });
    expect(await buildUniverse(deps)).toHaveLength(1);
  });

  it('annualized vol > 600% is excluded (blow-off-top filter)', async () => {
    const deps = goodDeps({ fetchAnnualizedVol: vi.fn(async () => 601) });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('annualized vol exactly 600% passes', async () => {
    const deps = goodDeps({ fetchAnnualizedVol: vi.fn(async () => 600) });
    expect(await buildUniverse(deps)).toHaveLength(1);
  });

  it('annualized vol 500% (normal memecoin) passes — gates are loose enough', async () => {
    // Spec note: typical Solana memecoin baseline is 300-500% — must NOT filter these
    const deps = goodDeps({ fetchAnnualizedVol: vi.fn(async () => 500) });
    expect(await buildUniverse(deps)).toHaveLength(1);
  });
});

// ── §3.3 Partial-failure handling ─────────────────────────────────────────────

describe('universe §3.3 partial-failure handling', () => {
  it('single-token fetch failure drops only that token; others continue', async () => {
    const BAD_MINT = 'BadMint22222222222222222222222222222222222222';
    const BAD_TOKEN: DexscreenerToken = {
      mint: BAD_MINT,
      symbol: 'BAD',
      name: 'BadToken',
      marketCapUsd: 100_000_000,
      volume24hUsd: 10_000_000,
    };

    // fetchTokenAge throws for BAD but succeeds for GOOD
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => [GOOD_TOKEN, BAD_TOKEN]),
      fetchTokenAge: vi.fn(async (mint: string) => {
        if (mint === BAD_MINT) throw new Error('Helius returned 500 for this token');
        return 60;
      }),
    });

    const universe = await buildUniverse(deps);
    // Only GOOD passes; BAD was excluded due to error
    expect(universe).toHaveLength(1);
    expect(universe[0]!.symbol).toBe('GOOD');
  });

  it('total Dexscreener outage returns empty universe (fail closed)', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => { throw new Error('timeout'); }),
    });
    const universe = await buildUniverse(deps);
    expect(universe).toHaveLength(0);
  });

  it('all per-token fetches fail → empty universe', async () => {
    const deps = goodDeps({
      fetchTokenAge: vi.fn(async () => { throw new Error('all RPC down'); }),
    });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });

  it('empty Dexscreener response returns empty universe', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => []),
    });
    expect(await buildUniverse(deps)).toHaveLength(0);
  });
});

// ── Day 5 chaos tests ─────────────────────────────────────────────────────────

describe('universe chaos §Day5', () => {

  // ── Malformed / unexpected Dexscreener response ───────────────────────────
  // Chaos: Dexscreener returns data with missing/null required fields.
  // The universe builder must handle gracefully: token is excluded, not thrown.

  it('chaos: Dexscreener returns token with null marketCap — excluded, not thrown', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => [
        { ...GOOD_TOKEN },                            // valid
        { mint: 'Mal1111111111111111111111111111111111111111',
          symbol: 'MAL', name: 'Malformed',
          marketCapUsd: null as unknown as number,    // null instead of number
          volume24hUsd: 10_000_000 },
      ]),
    });

    const universe = await buildUniverse(deps);
    // Malformed token excluded; GOOD still included
    expect(universe).toHaveLength(1);
    expect(universe[0]!.symbol).toBe('GOOD');
  });

  it('chaos: Dexscreener returns empty array (no candidates) — universe is empty, no throw', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => []),
    });
    const universe = await buildUniverse(deps);
    expect(universe).toHaveLength(0);
  });

  // ── Token fails a gate between cycles (mcap drops below $50M) ─────────────
  // Chaos: a token that passed in cycle N fails in cycle N+1.
  // Universe for N+1 must be empty; existing position can still be managed.

  it('chaos: token mcap drops below $50M between cycles — disappears cleanly', async () => {
    // Cycle 1: GOOD token passes all gates
    const firstCycle = await buildUniverse(goodDeps());
    expect(firstCycle).toHaveLength(1);

    // Cycle 2: same token, mcap dropped to $40M (below $50M threshold)
    const secondCycle = await buildUniverse(goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => [{
        ...GOOD_TOKEN,
        marketCapUsd: 40_000_000, // dropped below gate
      }]),
    }));
    expect(secondCycle).toHaveLength(0);

    // The universe cleanly disappears — no error, no stale entry
    // Decision loop can still EXIT positions regardless (universe only gates OPEN/ADD)
  });

  // ── Single Dexscreener 500 for one token via adversarial gate failure ──────
  // Chaos: one token's adversarial data fetch fails (simulates per-token API error).
  // Others in universe continue.

  it('chaos: adversarial gate fetch fails for one token — others continue', async () => {
    const SECOND_MINT = 'Second111111111111111111111111111111111111111';
    const SECOND_TOKEN = { ...GOOD_TOKEN, mint: SECOND_MINT, symbol: 'SECOND' };

    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => [GOOD_TOKEN, SECOND_TOKEN]),
      // Holder concentration fetch fails for SECOND only
      fetchHolderConcentration: vi.fn(async (mint: string) => {
        if (mint === SECOND_MINT) throw new Error('API 500 for this token');
        return 0.25;
      }),
    });

    const universe = await buildUniverse(deps);
    // SECOND excluded due to error; GOOD still present
    expect(universe).toHaveLength(1);
    expect(universe[0]!.symbol).toBe('GOOD');
    expect(universe[0]!.mint).toBe(GOOD_TOKEN.mint);
  });

  // ── Total Dexscreener outage: decision loop still alive for existing positions ─
  // Chaos: Dexscreener throws. Universe = ∅. Decision loop can still EXIT.
  // This tests the fail-closed + EXIT-always-allowed property of the spec.

  it('chaos: total Dexscreener outage returns empty universe (fail closed)', async () => {
    const deps = goodDeps({
      fetchDexscreenerTokens: vi.fn(async () => { throw new Error('503 Service Unavailable'); }),
    });
    const universe = await buildUniverse(deps);
    // Fail closed: empty universe, no throw
    expect(universe).toHaveLength(0);
    // EXIT is decided by the decision loop based on open positions, not universe membership
    // (universe membership only gates OPEN/ADD — spec §2.5)
  });
});

// ── Gate predicate unit tests (fast, no I/O) ──────────────────────────────────

describe('universe gate predicates', () => {
  const goodLiq: Parameters<typeof passesLiquidityGates>[0] = {
    marketCapUsd: 50_000_000, volume24hUsd: 5_000_000,
    ageDays: 30, jupiterListed: true, lpLocked: true, lpLockedDays: 90,
  };
  const goodAdv: Parameters<typeof passesAdversarialGates>[0] = {
    top10HolderPct: 0.40, uniqueTraders24h: 500, annualizedVolPct: 600,
  };

  it('passesLiquidityGates: all at threshold → true', () => {
    expect(passesLiquidityGates(goodLiq)).toBe(true);
  });

  it('passesLiquidityGates: one field below threshold → false', () => {
    expect(passesLiquidityGates({ ...goodLiq, marketCapUsd: 49_999_999 })).toBe(false);
    expect(passesLiquidityGates({ ...goodLiq, volume24hUsd: 4_999_999 })).toBe(false);
    expect(passesLiquidityGates({ ...goodLiq, ageDays: 29 })).toBe(false);
    expect(passesLiquidityGates({ ...goodLiq, jupiterListed: false })).toBe(false);
    expect(passesLiquidityGates({ ...goodLiq, lpLocked: false })).toBe(false);
    expect(passesLiquidityGates({ ...goodLiq, lpLockedDays: 89 })).toBe(false);
  });

  it('passesAdversarialGates: all at threshold → true', () => {
    expect(passesAdversarialGates(goodAdv)).toBe(true);
  });

  it('passesAdversarialGates: one field out of bound → false', () => {
    expect(passesAdversarialGates({ ...goodAdv, top10HolderPct: 0.41 })).toBe(false);
    expect(passesAdversarialGates({ ...goodAdv, uniqueTraders24h: 499 })).toBe(false);
    expect(passesAdversarialGates({ ...goodAdv, annualizedVolPct: 601 })).toBe(false);
  });

  it('gate constants match spec exactly', () => {
    expect(LIQUIDITY_GATES.MIN_MARKET_CAP_USD).toBe(50_000_000);
    expect(LIQUIDITY_GATES.MIN_VOLUME_24H_USD).toBe(5_000_000);
    expect(LIQUIDITY_GATES.MIN_AGE_DAYS).toBe(30);
    expect(LIQUIDITY_GATES.MIN_LP_LOCK_DAYS).toBe(90);
    expect(ADVERSARIAL_GATES.MAX_TOP10_HOLDER_PCT).toBe(0.40);
    expect(ADVERSARIAL_GATES.MIN_UNIQUE_TRADERS_24H).toBe(500);
    expect(ADVERSARIAL_GATES.MAX_ANNUALIZED_VOL_PCT).toBe(600);
  });
});
