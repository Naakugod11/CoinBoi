// Safety loop — pure code, no LLM. Runs every 15s even when paused.
// See spec §2.6. All trade-issuing actions take the shared trade mutex.
import {
  listOpenPositions, recordTick, lastNTicks,
  upsertAndGetPeak, countTradesInWindow,
  isPaused, getPauseReason, setPaused,
  isKillSwitchTriggered, setKillSwitchTriggered,
  insertError, type PositionRow,
} from '../observability/db.js';
import { computeStopCheck } from '../execution/portfolio.js';
import { heartbeatAgeHours } from './heartbeat.js';
import { tradeMutex } from './mutex.js';
import { SAFETY, HEARTBEAT_MAX_AGE_HOURS } from '../config.js';

// ── Injectable dependencies ────────────────────────────────────────────────────

export interface SafetyLoopDeps {
  /** Canonical price for a token mint. Returns null when unavailable. */
  canonicalPrice(tokenMint: string, sizeTokens: number): Promise<number | null>;
  /** Current SOL wallet balance. */
  getSolBalance(): Promise<number>;
  /** USDC cash in wallet (Day 4: wired to real balance; required for correct drawdown). */
  getUsdcBalance(): Promise<number>;
  /** Sell a single position at market. */
  marketSellPosition(position: PositionRow): Promise<void>;
  /** Liquidate all open positions. Called inside mutex. */
  marketSellAllWithRetry(): Promise<void>;
  /** Alert function (Telegram Day 4 / console fallback now). */
  alert(msg: string): Promise<void>;
}

// ── One safety cycle — spec §2.6 ─────────────────────────────────────────────

export async function runSafetyCycle(deps: SafetyLoopDeps): Promise<void> {
  const positions = listOpenPositions();

  // ── Per-position stops with TWO-TICK confirmation ─────────────────────────
  for (const position of positions) {
    const price = await deps.canonicalPrice(position.token, position.size_tokens);

    if (price === null) {
      // §2.6: null price → skip this tick, NEVER stop on missing data
      insertError('safety-loop', `Price unavailable for ${position.token} — skipping tick`);
      continue;
    }

    const { lossPct } = computeStopCheck(position, price);
    recordTick(position.id, price, lossPct);

    const lastTwo = lastNTicks(position.id, 2);
    const bothBelow = lastTwo.length === 2
      && lastTwo.every(t => t.loss_pct <= -SAFETY.STOP_LOSS_PCT);

    if (bothBelow) {
      await tradeMutex.runExclusive(async () => {
        await deps.marketSellPosition(position);
      });
      await deps.alert(
        `STOP HIT: ${position.token} sold (2-tick confirm) at ${(lossPct * 100).toFixed(1)}% loss`
      );
    }
  }

  // ── Portfolio value for peak / drawdown ───────────────────────────────────
  const updatedPositions = listOpenPositions(); // may have shrunk if stops fired
  let positionsValueUsdc = 0;
  for (const pos of updatedPositions) {
    const price = await deps.canonicalPrice(pos.token, pos.size_tokens);
    if (price !== null) positionsValueUsdc += pos.size_tokens * price;
  }
  const cashUsdc = await deps.getUsdcBalance();
  const portfolioUsdc = positionsValueUsdc + cashUsdc;

  const peak = upsertAndGetPeak(portfolioUsdc);
  const ddFromPeak = peak - portfolioUsdc;

  // ── Soft pause at −$8 ─────────────────────────────────────────────────────
  if (ddFromPeak >= SAFETY.SOFT_PAUSE_DRAWDOWN_USDC && getPauseReason() !== 'soft_drawdown') {
    setPaused(true, 'soft_drawdown');
    await deps.alert(
      `SOFT PAUSE: -$${ddFromPeak.toFixed(2)} from peak. New entries blocked, exits allowed.`
    );
  }

  // ── Hard stop at −$13 ─────────────────────────────────────────────────────
  if (ddFromPeak >= SAFETY.HARD_STOP_DRAWDOWN_USDC && !isKillSwitchTriggered()) {
    setKillSwitchTriggered('hard_stop_drawdown');
    setPaused(true, 'hard_stop');
    await tradeMutex.runExclusive(async () => {
      await deps.marketSellAllWithRetry();
    });
    await deps.alert(
      `HARD STOP: -$${ddFromPeak.toFixed(2)} from peak. All positions liquidating.`
    );
  }

  // ── Trade cap — rolling 24h ────────────────────────────────────────────────
  const rollingTrades = countTradesInWindow(24 * 3600);
  if (rollingTrades >= SAFETY.DAILY_TRADE_CAP && getPauseReason() !== 'trade_cap') {
    setPaused(true, 'trade_cap');
    await deps.alert(`TRADE CAP: ${rollingTrades}/${SAFETY.DAILY_TRADE_CAP} in rolling 24h. Paused.`);
  } else if (rollingTrades < SAFETY.DAILY_TRADE_CAP && getPauseReason() === 'trade_cap') {
    setPaused(false, null);
    await deps.alert('Trade cap cleared. Resuming.');
  }

  // ── SOL gas reserve ───────────────────────────────────────────────────────
  const solBalance = await deps.getSolBalance();
  if (solBalance < SAFETY.SOL_RESERVE_FLOOR && getPauseReason() !== 'sol_low') {
    setPaused(true, 'sol_low');
    await deps.alert(`SOL LOW: ${solBalance.toFixed(4)} SOL (<${SAFETY.SOL_RESERVE_FLOOR}). Refund required.`);
  }

  // ── Heartbeat watchdog ────────────────────────────────────────────────────
  const hbAge = heartbeatAgeHours();
  if (hbAge > HEARTBEAT_MAX_AGE_HOURS && getPauseReason() !== 'heartbeat_missing') {
    setPaused(true, 'heartbeat_missing');
    await deps.alert('HEARTBEAT MISSED >12h. New entries paused. Stops + manual halt still active.');
  } else if (hbAge < HEARTBEAT_MAX_AGE_HOURS && getPauseReason() === 'heartbeat_missing') {
    setPaused(false, null);
    await deps.alert('Heartbeat received. Resuming.');
  }
}

// ── Soft-pause-awareness (for decision loop to call) ─────────────────────────
// Safety loop itself never blocks on pause — it always runs.
export { isPaused, isKillSwitchTriggered };
