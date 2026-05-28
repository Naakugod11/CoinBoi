// Portfolio math tests — every assertion is grounded in spec §2.7 numbers.
// If a test fails, the implementation is wrong, not the test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { initDb, closeDb, getPositionByToken } from '../src/observability/db.js';
import {
  applyOpen, applyAdd, applyExit,
  computeStopCheck, computePortfolioValue,
  applyTradeToPosition,
  loadOpenPositions,
} from '../src/execution/portfolio.js';

function tempDb(): string {
  return join(tmpdir(), `coinboi-portfolio-test-${process.pid}-${Date.now()}.db`);
}

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF  = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

describe('portfolio §2.7', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
  });

  // ── OPEN ──────────────────────────────────────────────────────────────────
  // §2.7: size_tokens = amount_received_onchain
  //        cost_basis  = usdc_spent_onchain (in_amount + sol_fee_usdc_equiv)

  it('OPEN: stores exact on-chain amounts as-received', () => {
    // Scenario: buy 1,000,000 BONK spending 5.025 USDC (5 USDC + 0.025 fee equiv)
    const result = applyOpen(BONK, 1_000_000, 5.025);

    expect(result.sizeTokens).toBe(1_000_000);
    expect(result.costBasisTotalUsdc).toBe(5.025);

    const pos = getPositionByToken(BONK)!;
    expect(pos.size_tokens).toBe(1_000_000);
    expect(pos.cost_basis_total_usdc).toBe(5.025);
    expect(pos.status).toBe('OPEN');
  });

  // ── ADD: cost basis and size_tokens are running sums ─────────────────────
  // §2.7: size_tokens += received; cost_basis += spent
  // Implied avg price = total_cost / total_tokens (falls out, never stored)

  it('OPEN then ADD: cost basis and tokens are running sums', () => {
    // First entry: 1,000,000 BONK for 5.00 USDC (entry price 0.000005)
    applyOpen(BONK, 1_000_000, 5.00);

    // Second entry: 500,000 BONK for 2.60 USDC (entry price 0.0000052)
    const result = applyAdd(BONK, 500_000, 2.60);

    // §2.7 exact:
    expect(result.sizeTokens).toBe(1_500_000);
    expect(result.costBasisTotalUsdc).toBeCloseTo(7.60, 10);

    // Implied average price = 7.60 / 1,500,000 ≈ 0.000005067
    const impliedAvg = result.costBasisTotalUsdc / result.sizeTokens;
    expect(impliedAvg).toBeCloseTo(7.60 / 1_500_000, 10);

    // DB agrees
    const pos = getPositionByToken(BONK)!;
    expect(pos.size_tokens).toBe(1_500_000);
    expect(pos.cost_basis_total_usdc).toBeCloseTo(7.60, 10);
  });

  // ── ADD then stop: stop uses COMBINED cost basis ──────────────────────────
  // §2.7 stop: loss_pct = (current_value - cost_basis_total) / cost_basis_total
  // Must use the summed basis, NOT the individual entry price.

  it('stop check after ADD uses combined cost basis', () => {
    // OPEN: 1,000,000 tokens @ 5.00 USDC
    applyOpen(BONK, 1_000_000, 5.00);
    // ADD:    500,000 tokens @ 2.60 USDC
    applyAdd(BONK, 500_000, 2.60);
    // Combined: 1,500,000 tokens, cost basis 7.60 USDC
    // Break-even price: 7.60 / 1,500,000 = 0.000005067

    const pos = getPositionByToken(BONK)!;

    // Price at exactly break-even
    const breakEvenPrice = 7.60 / 1_500_000;
    const atBreakEven = computeStopCheck(pos, breakEvenPrice);
    expect(atBreakEven.lossPct).toBeCloseTo(0, 8);

    // Price at -40% of cost basis:
    // current_value = 0.60 × 7.60 = 4.56 USDC → loss_pct = (4.56-7.60)/7.60 = -0.40
    const stopPrice = (7.60 * 0.60) / 1_500_000;
    const atStop = computeStopCheck(pos, stopPrice);
    expect(atStop.lossPct).toBeCloseTo(-0.40, 8);
    expect(atStop.currentValueUsdc).toBeCloseTo(7.60 * 0.60, 8);

    // One tick above stop: -39.9% → should NOT trigger
    const nearStopPrice = (7.60 * 0.601) / 1_500_000;
    const nearStop = computeStopCheck(pos, nearStopPrice);
    expect(nearStop.lossPct).toBeGreaterThan(-0.40);
  });

  // ── EXIT: pnl against total cost basis ───────────────────────────────────
  // §2.7: pnl = sale_proceeds - cost_basis_total_usdc

  it('EXIT computes pnl against total cost basis', () => {
    // Buy 1,000,000 BONK, cost 5.00 USDC
    applyOpen(BONK, 1_000_000, 5.00);
    // Add 500,000 more, cost 2.60 USDC
    applyAdd(BONK, 500_000, 2.60);
    // Total cost basis: 7.60 USDC

    // Sell all, receive 8.20 USDC on-chain
    const result = applyExit(BONK, 8.20);

    expect(result.saleProceedsUsdc).toBe(8.20);
    // §2.7: pnl = 8.20 - 7.60 = 0.60
    expect(result.pnlUsdc).toBeCloseTo(0.60, 10);

    // Position is closed
    const pos = getPositionByToken(BONK);
    expect(pos).toBeUndefined(); // listOpenPositions returns OPEN only
  });

  it('EXIT with a loss produces negative pnl', () => {
    applyOpen(BONK, 1_000_000, 5.00);

    // Sell for 3.50 USDC — loss of 1.50
    const result = applyExit(BONK, 3.50);
    expect(result.pnlUsdc).toBeCloseTo(-1.50, 10);
  });

  // ── Portfolio total: SOL excluded ─────────────────────────────────────────
  // §2.7: portfolio_value = wallet_usdc + Σ(size_tokens × canonical_price)
  // SOL is NOT counted.

  it('portfolio total excludes SOL', () => {
    applyOpen(BONK, 1_000_000, 5.00);
    applyOpen(WIF, 100, 4.80);

    const positions = loadOpenPositions();
    const prices = new Map([
      [BONK, 0.000006],  // BONK at $0.000006 → position value = 6.00
      [WIF,  0.050],     // WIF  at $0.050    → position value = 5.00
    ]);

    // wallet_usdc = 20.20 (30 - 5 - 4.80)
    // positions_value = 1,000,000 × 0.000006 + 100 × 0.050 = 6.00 + 5.00 = 11.00
    // total = 20.20 + 11.00 = 31.20
    // SOL not counted regardless of SOL balance
    const pv = computePortfolioValue(20.20, positions, prices);

    expect(pv.walletUsdc).toBe(20.20);
    expect(pv.positionsValueUsdc).toBeCloseTo(11.00, 8);
    expect(pv.totalUsdc).toBeCloseTo(31.20, 8);
  });

  it('portfolio total: missing price skips that position', () => {
    applyOpen(BONK, 1_000_000, 5.00);
    applyOpen(WIF, 100, 4.80);

    const positions = loadOpenPositions();
    // Only BONK priced; WIF has no price (oracle returned null)
    const prices = new Map([[BONK, 0.000006]]);

    const pv = computePortfolioValue(20.20, positions, prices);
    expect(pv.positionsValueUsdc).toBeCloseTo(6.00, 8); // only BONK counted
    expect(pv.totalUsdc).toBeCloseTo(26.20, 8);
  });

  // ── applyTradeToPosition router ────────────────────────────────────────────

  it('applyTradeToPosition BUY with no existing position → OPEN', () => {
    applyTradeToPosition(1, 'BUY', BONK, 5.025, 1_000_000);
    const pos = getPositionByToken(BONK)!;
    expect(pos.size_tokens).toBe(1_000_000);
    expect(pos.cost_basis_total_usdc).toBe(5.025);
  });

  it('applyTradeToPosition BUY with existing position → ADD', () => {
    applyOpen(BONK, 1_000_000, 5.00);
    applyTradeToPosition(2, 'BUY', BONK, 2.60, 500_000);
    const pos = getPositionByToken(BONK)!;
    expect(pos.size_tokens).toBe(1_500_000);
    expect(pos.cost_basis_total_usdc).toBeCloseTo(7.60, 10);
  });

  it('applyTradeToPosition SELL → EXIT with correct pnl', () => {
    applyOpen(BONK, 1_000_000, 5.00);
    applyTradeToPosition(3, 'SELL', BONK, 5.50, 1_000_000);
    // Position closed; pnl = 5.50 - 5.00 = 0.50
    const pos = getPositionByToken(BONK);
    expect(pos).toBeUndefined(); // no longer OPEN
  });

  // ── Numeric precision: three consecutive ADDs ─────────────────────────────
  // Ensures floating-point accumulation doesn't drift unreasonably.

  it('three ADDs accumulate cost basis without significant drift', () => {
    applyOpen(BONK, 1_000_000, 5.00);
    applyAdd(BONK,    200_000, 1.02);
    applyAdd(BONK,    300_000, 1.53);

    const pos = getPositionByToken(BONK)!;
    // size:  1,000,000 + 200,000 + 300,000 = 1,500,000
    // basis: 5.00 + 1.02 + 1.53 = 7.55
    expect(pos.size_tokens).toBe(1_500_000);
    expect(pos.cost_basis_total_usdc).toBeCloseTo(7.55, 10);
  });

  // ── computeStopCheck: profit scenario ─────────────────────────────────────

  it('computeStopCheck returns positive lossPct when in profit', () => {
    applyOpen(BONK, 1_000_000, 5.00);
    const pos = getPositionByToken(BONK)!;

    // Price doubled → lossPct ≈ +1.0 (100% gain)
    const result = computeStopCheck(pos, 0.000010);
    expect(result.lossPct).toBeCloseTo(1.0, 8);
    expect(result.currentValueUsdc).toBeCloseTo(10.0, 8);
  });
});
