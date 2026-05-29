// Daily Opus retrospective at 22:00 UTC. See spec §4.2.
// Waits up to 60s for the trade mutex (doesn't hold it — just ensures no trade
// is mid-flight before starting). Stores markdown in logs/reviews/, sends summary.
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { withTimeout, E_TIMEOUT } from 'async-mutex';
import { tradeMutex } from './mutex.js';
import { getDb, nowUtc } from '../observability/db.js';
import { CLAUDE_REVIEW_MODEL } from '../config.js';

export interface ReviewDeps {
  sendAlert(msg: string): Promise<void>;
  clientFactory?(): Anthropic;
  lockTimeoutMs?: number;
  reviewsDir?: string;
}

// ── Build the §4.2 prompt ─────────────────────────────────────────────────────

function buildReviewPrompt(): string {
  const db = getDb();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const decisions = db.prepare(
    `SELECT timestamp_utc, action, token, thesis, invalidation,
            expected_move_pct, confidence, skip_reason, executed
     FROM decisions WHERE timestamp_utc >= ? ORDER BY timestamp_utc ASC`,
  ).all(since) as Array<Record<string, unknown>>;

  const trades = db.prepare(
    `SELECT t.timestamp_utc, t.token, t.side, t.size_usdc, t.price,
            t.slippage_pct, t.fee_usdc, t.tx_signature
     FROM trades t WHERE t.timestamp_utc >= ? ORDER BY t.timestamp_utc ASC`,
  ).all(since) as Array<Record<string, unknown>>;

  const snapshot = (db.prepare(
    `SELECT * FROM portfolio_snapshots ORDER BY timestamp_utc DESC LIMIT 1`,
  ).get() ?? { total_value_usdc: 30, peak_value_usdc: 30, drawdown_from_peak_usdc: 0 }) as
    Record<string, unknown>;

  const startSnap = (db.prepare(
    `SELECT total_value_usdc FROM portfolio_snapshots WHERE timestamp_utc >= ?
     ORDER BY timestamp_utc ASC LIMIT 1`,
  ).get(since) ?? { total_value_usdc: snapshot['total_value_usdc'] }) as
    Record<string, unknown>;

  const tradeCount = db.prepare(
    `SELECT COUNT(*) as n FROM trades WHERE timestamp_utc >= ?`,
  ).get(since) as { n: number };

  const openCount = db.prepare(
    `SELECT COUNT(*) as n FROM positions WHERE status = 'OPEN'`,
  ).get() as { n: number };

  const slippageStats = db.prepare(
    `SELECT AVG(slippage_pct) as avg_slip,
            COUNT(*) FILTER (WHERE slippage_pct > 0.015) as skipped_slip,
            COUNT(*) FILTER (WHERE tx_signature IS NOT NULL) as failed
     FROM trades WHERE timestamp_utc >= ?`,
  ).get(since) as { avg_slip: number | null; skipped_slip: number; failed: number };

  const mismatches = db.prepare(
    `SELECT COUNT(*) as n FROM errors WHERE context = 'reconciler' AND timestamp_utc >= ?`,
  ).get(since) as { n: number };

  const fullDecisionLog = decisions.length > 0
    ? JSON.stringify(decisions, null, 2)
    : '(no decisions in the last 24h)';

  const tradesWithPnl = trades.length > 0
    ? JSON.stringify(trades, null, 2)
    : '(no trades in the last 24h)';

  return `You are reviewing 24h of autonomous trading decisions to find performance improvements. The agent manages real capital. Goal: compound under a strict cost structure (~3% round-trip).

YESTERDAY'S DECISIONS (with full prompts and responses):
${fullDecisionLog}

YESTERDAY'S TRADES (with on-chain confirmations and slippage):
${tradesWithPnl}

PORTFOLIO STATE:
- Starting value: $${Number(startSnap['total_value_usdc']).toFixed(2)} USDC
- Current value: $${Number(snapshot['total_value_usdc']).toFixed(2)} USDC
- Peak value: $${Number(snapshot['peak_value_usdc']).toFixed(2)} USDC
- Drawdown from peak: $${Number(snapshot['drawdown_from_peak_usdc']).toFixed(2)}
- Trades executed: ${tradeCount.n} / 12 cap
- Open positions: ${openCount.n} / 3 max

EXECUTION QUALITY:
- Avg slippage per trade: ${slippageStats.avg_slip != null ? slippageStats.avg_slip.toFixed(3) : 'n/a'}%
- Trades skipped due to slippage budget: ${slippageStats.skipped_slip}
- Quote-to-execution price delta: n/a (paper mode)
- Failed/unknown transactions: ${slippageStats.failed}
- Reconciler mismatches: ${mismatches.n}

Analyze:
1. EDGE: which decisions produced edge net of fees? Which destroyed value? Distinguish "bad decisions" from "good decisions with bad execution".
2. INVALIDATION QUALITY: were yesterday's stated invalidations actually testable against the data? Flag fuzzy invalidations like "if sentiment turns negative" without specifics.
3. MISSED SETUPS: were there universe tokens with clear catalysts the agent ignored? What signal would have caught them?
4. SIZING: were positions sized appropriately for stated confidence?
5. OVER/UNDER-TRADING: is the agent firing on weak setups or freezing on clear ones?
6. CONFIDENCE CALIBRATION: do high-confidence trades actually outperform low-confidence ones?
7. UNIVERSE QUALITY: did the filter let in any token that turned out to be a trap or pump-in-progress?
8. PROMPT CHANGES: if you would change exactly one line of the prompt to improve next-day performance, what line and what change?

Output a structured retrospective (markdown, ~600 words). Logged for Naaku review; NOT auto-applied.`;
}

// ── Main review function ──────────────────────────────────────────────────────

export async function runDailyReview(deps: ReviewDeps): Promise<'completed' | 'skipped'> {
  const lockTimeoutMs = deps.lockTimeoutMs ?? 60_000;

  // Attempt to acquire the trade mutex — just a "coast is clear" check.
  // If it can't acquire within timeout, a trade has been stuck for too long → skip.
  const timedMutex = withTimeout(tradeMutex, lockTimeoutMs);
  let release: (() => void) | undefined;
  try {
    release = await timedMutex.acquire();
  } catch (e) {
    if (e === E_TIMEOUT) {
      console.warn('[review] Trade mutex held >lockTimeoutMs — skipping daily review');
      return 'skipped';
    }
    throw e;
  }
  // Release immediately — we just verified no trade is in flight.
  release();

  const reviewsDir = deps.reviewsDir ?? 'logs/reviews';
  mkdirSync(reviewsDir, { recursive: true });

  const prompt = buildReviewPrompt();

  const client = deps.clientFactory ? deps.clientFactory() : new Anthropic();
  const response = await client.messages.create({
    model: CLAUDE_REVIEW_MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  const markdown =
    response.content[0]?.type === 'text' ? response.content[0].text : '(empty response)';

  const filename = `review-${nowUtc().replace(/[:.]/g, '-')}.md`;
  const filepath = join(reviewsDir, filename);
  await writeFile(filepath, `# Daily Review — ${nowUtc()}\n\n${markdown}\n`);

  const summary = markdown.split('\n').slice(0, 4).join(' ').slice(0, 280);
  await deps.sendAlert(`Daily review complete. ${summary}…`);

  console.log(`[review] Saved to ${filepath}`);
  return 'completed';
}

// ── Scheduler: fire at next 22:00 UTC, then every 24h ────────────────────────

export function scheduleDailyReview(deps: ReviewDeps): void {
  const now = new Date();
  const next22 = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 22, 0, 0, 0,
  ));
  if (next22 <= now) next22.setUTCDate(next22.getUTCDate() + 1);

  const delayMs = next22.getTime() - now.getTime();

  setTimeout(() => {
    runDailyReview(deps).catch((e) => console.error('[review] error:', e));
    setInterval(() => {
      runDailyReview(deps).catch((e) => console.error('[review] error:', e));
    }, 24 * 60 * 60 * 1000);
  }, delayMs);

  console.log(`[review] Scheduled daily review at ${next22.toISOString()}`);
}
