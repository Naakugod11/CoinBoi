// Position math — normative implementation of spec §2.7.
// These definitions are the source of truth. Any test that disagrees is wrong.
import {
  openPosition, updatePosition, closePosition,
  getPositionByToken, listOpenPositions,
  nowUtc, type PositionRow,
} from '../observability/db.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OpenedPosition {
  positionId: number;
  token: string;
  sizeTokens: number;
  costBasisTotalUsdc: number;
}

export interface ClosedPosition {
  positionId: number;
  token: string;
  saleProceedsUsdc: number;
  pnlUsdc: number;
}

export interface StopCheckResult {
  lossPct: number;
  currentValueUsdc: number;
}

export interface PortfolioValue {
  walletUsdc: number;
  positionsValueUsdc: number;
  totalUsdc: number;
  // NOTE: SOL balance intentionally excluded — spec §2.7, gas reserve only.
}

// ── OPEN — spec §2.7 ─────────────────────────────────────────────────────────
// size_tokens  = amount_received_from_swap_onchain
// cost_basis   = usdc_spent_onchain (in_amount + sol_fee_usdc_equivalent)

export function applyOpen(
  token: string,
  amountReceivedOnchain: number,  // tokens received
  usdcSpentOnchain: number,       // USDC out + sol_fee_usdc_equivalent
): OpenedPosition {
  const positionId = openPosition({
    token,
    opened_at_utc: nowUtc(),
    size_tokens: amountReceivedOnchain,
    cost_basis_total_usdc: usdcSpentOnchain,
  });
  return {
    positionId,
    token,
    sizeTokens: amountReceivedOnchain,
    costBasisTotalUsdc: usdcSpentOnchain,
  };
}

// ── ADD — spec §2.7 ──────────────────────────────────────────────────────────
// size_tokens         += amount_received_from_swap_onchain
// cost_basis_total    += usdc_spent_onchain
// Weighted average price falls out of these sums — NOT stored separately.

export function applyAdd(
  token: string,
  amountReceivedOnchain: number,
  usdcSpentOnchain: number,
): OpenedPosition {
  const pos = getPositionByToken(token);
  if (!pos) throw new Error(`applyAdd: no open position for ${token}`);

  const newSizeTokens = pos.size_tokens + amountReceivedOnchain;
  const newCostBasis = pos.cost_basis_total_usdc + usdcSpentOnchain;

  updatePosition(pos.id, {
    size_tokens: newSizeTokens,
    cost_basis_total_usdc: newCostBasis,
  });

  return {
    positionId: pos.id,
    token,
    sizeTokens: newSizeTokens,
    costBasisTotalUsdc: newCostBasis,
  };
}

// ── EXIT — spec §2.7 ─────────────────────────────────────────────────────────
// sale_proceeds_usdc = amount_received_from_swap_onchain (net of fees)
// pnl_usdc           = sale_proceeds_usdc - position.cost_basis_total_usdc
// Sells FULL wallet balance; dust residual absorbed into cost basis.

export function applyExit(
  token: string,
  saleProceedsUsdc: number,   // USDC received on-chain, net of fees
): ClosedPosition {
  const pos = getPositionByToken(token);
  if (!pos) throw new Error(`applyExit: no open position for ${token}`);

  const pnlUsdc = saleProceedsUsdc - pos.cost_basis_total_usdc;

  closePosition(pos.id, {
    exit_proceeds_usdc: saleProceedsUsdc,
    pnl_usdc: pnlUsdc,
    closed_at_utc: nowUtc(),
  });

  return {
    positionId: pos.id,
    token,
    saleProceedsUsdc,
    pnlUsdc,
  };
}

// ── Stop-loss check — spec §2.7 ───────────────────────────────────────────────
// current_value_usdc = size_tokens × canonical_price(token)
// loss_pct = (current_value_usdc - cost_basis_total_usdc) / cost_basis_total_usdc
// Uses COMBINED cost basis — never individual entry prices.

export function computeStopCheck(pos: PositionRow, canonicalPrice: number): StopCheckResult {
  const currentValueUsdc = pos.size_tokens * canonicalPrice;
  const lossPct = (currentValueUsdc - pos.cost_basis_total_usdc) / pos.cost_basis_total_usdc;
  return { lossPct, currentValueUsdc };
}

// ── Portfolio total value — spec §2.7 ─────────────────────────────────────────
// portfolio_value = wallet_usdc + Σ(size_tokens × canonical_price)
// SOL is NOT included — it's a gas reserve, valued separately.

export function computePortfolioValue(
  walletUsdc: number,
  positions: PositionRow[],
  priceMap: Map<string, number>,  // token mint → canonical price
): PortfolioValue {
  const positionsValueUsdc = positions.reduce((sum, pos) => {
    const price = priceMap.get(pos.token);
    if (price == null) return sum; // no price → skip; safety loop handles null prices
    return sum + pos.size_tokens * price;
  }, 0);

  return {
    walletUsdc,
    positionsValueUsdc,
    totalUsdc: walletUsdc + positionsValueUsdc,
  };
}

// ── applyTradeToPosition — wires the Day-1 tx-pipeline stub ──────────────────
// Routes BUY (OPEN or ADD) / SELL (EXIT) using on-chain parsed amounts.
// Called by tx-pipeline.execute() after a confirmed swap.

export function applyTradeToPosition(
  _intentId: number,
  side: 'BUY' | 'SELL',
  token: string,
  usdcAmount: number,   // absolute USDC (spent for buy, received for sell)
  tokenAmount: number,  // absolute tokens (received for buy, sold/closed for sell)
): void {
  if (side === 'BUY') {
    const existing = getPositionByToken(token);
    if (existing) {
      applyAdd(token, tokenAmount, usdcAmount);
    } else {
      applyOpen(token, tokenAmount, usdcAmount);
    }
  } else {
    applyExit(token, usdcAmount);
  }
}

// ── Convenience loader ────────────────────────────────────────────────────────

export function loadOpenPositions(): PositionRow[] {
  return listOpenPositions();
}
