// Entry point. Sequence: reconcile (blocking) → telegram bot → dashboard →
// safety loop → decision loop → reconciler loop → schedule daily review.
// Paper mode: no wallet funded, no real swaps. All safety logic still runs.
// See spec §2.3, §2.4, §5.2, §5.3, §4.2.
import { initDb, nowUtc, getDb, listOpenPositions, getRecentDecisions } from './observability/db.js';
import { scheduleLoop } from './agent/scheduler.js';
import { runSafetyCycle } from './agent/safety-loop.js';
import { runDecisionCycle } from './agent/decision-loop.js';
import { runReconciler } from './agent/reconciler.js';
import { recordHeartbeat } from './agent/heartbeat.js';
import { askDecision } from './agent/claude-client.js';
import { buildDecisionPrompt, formatPortfolioForPrompt } from './agent/prompts.js';
import { scheduleDailyReview } from './agent/review.js';
import { createAndLaunchBot, makeBotAlert } from './observability/telegram.js';
import { startDashboard } from './observability/dashboard.js';
import { runPreflightChecks } from './preflight.js';
import { createSwapExecutor } from './execution/sol-cli.js';
import {
  EXECUTION_MODE, DB_PATH, ENV,
  CLAUDE_DECISION_MODEL, CLAUDE_REVIEW_MODEL,
  DECISION_LOOP_INTERVAL_MS, DECISION_LOOP_JITTER_MS,
  SAFETY_LOOP_INTERVAL_MS, RECONCILER_INTERVAL_MS,
  SAFETY, HEARTBEAT_MAX_AGE_HOURS,
} from './config.js';
import type { DecisionCycleDeps } from './agent/decision-loop.js';
import type { SafetyLoopDeps } from './agent/safety-loop.js';
import type { ReconcilerDeps } from './agent/reconciler.js';
import type { HaltDeps } from './agent/halt-handler.js';

// ── Alert stub — replaced by real Telegram once bot is live ──────────────────

let alertFn: (msg: string) => Promise<void> = async (msg) => {
  // eslint-disable-next-line no-console
  console.log(`[alert] ${msg}`);
};

// ── Paper-mode stubs (no wallet, no mainnet) ──────────────────────────────────

const paperSafetyDeps: SafetyLoopDeps = {
  canonicalPrice: async (_mint, _size) => null,
  getSolBalance: async () => 1.0,
  getUsdcBalance: async () => 25.0,
  marketSellPosition: async (pos) => {
    // eslint-disable-next-line no-console
    console.log(`[paper] would sell position ${pos.token}`);
  },
  marketSellAllWithRetry: async () => {
    // eslint-disable-next-line no-console
    console.log('[paper] would market-sell-all');
  },
  alert: async (msg) => alertFn(msg),
};

const paperReconcilerDeps: ReconcilerDeps = {
  getWalletBalances: async () => ({ usdcBalance: 25, solBalance: 1.0, tokens: [] }),
  checkTxStatus: async () => 'unknown',
  parseSwap: async () => ({ usdcAmount: 0, tokenAmount: 0, feeUsdc: 0 }),
  canonicalPrice: async () => null,
  alert: async (msg) => alertFn(msg),
};

function paperDecisionDeps(): DecisionCycleDeps {
  return {
    getSolBalance: async () => 1.0,
    getWalletTokenBalance: async () => 0,
    buildUniverse: async () => [],
    getSignals: async () => '{}',
    getRecentDecisions: (n) => {
      const rows = getRecentDecisions(n);
      if (rows.length === 0) return 'No previous decisions.';
      return rows
        .map((r) => `${r.timestamp_utc}: ${r.action} ${r.token ?? ''} — ${r.skip_reason ?? 'validated'}`)
        .join('\n');
    },
    askClaude: async (prompt) => askDecision(prompt),
    getQuote: async (_token, _sizeUsdc, _sizeTokens) => {
      throw new Error('paper mode: no real quotes');
    },
    executeTx: async (_decisionId, decision, _quote) => {
      // eslint-disable-next-line no-console
      console.log(`[paper] would execute ${decision.action} ${decision.token ?? ''} $${decision.size_usdc ?? ''}`);
    },
    alert: async (msg) => alertFn(msg),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Pre-flight: catch config errors before any loop or alert fires ────────
  runPreflightChecks({
    executionMode: EXECUTION_MODE,
    env: process.env as Record<string, string>,
    executor: createSwapExecutor(),
    dbPath: DB_PATH,
    decisionModel: CLAUDE_DECISION_MODEL,
    reviewModel: CLAUDE_REVIEW_MODEL,
    dashboardHost: ENV.DASHBOARD_HOST,
    dashboardPort: ENV.DASHBOARD_PORT,
  });

  initDb(DB_PATH);

  // Startup: blocking reconcile (agent does not start trading until clean)
  const reconcileResult = await runReconciler(paperReconcilerDeps);
  if (!reconcileResult.clean) {
    // eslint-disable-next-line no-console
    console.error('[main] Reconciler found mismatches at startup. Fix via scripts/reconcile.ts before restarting.');
    process.exit(1);
  }

  // ── Telegram bot ──────────────────────────────────────────────────────────

  const tgToken = ENV.TELEGRAM_BOT_TOKEN;
  const tgChatId = ENV.TELEGRAM_CHAT_ID ?? '';
  const tgAuthId = ENV.TELEGRAM_AUTHORIZED_USER_ID ?? '';

  if (tgToken) {
    const paperHaltDeps: HaltDeps = {
      marketSellAllWithRetry: paperSafetyDeps.marketSellAllWithRetry,
      alert: async (msg) => alertFn(msg),
    };

    const bot = createAndLaunchBot(tgToken, {
      chatId: tgChatId,
      authorizedUserId: tgAuthId,
      haltDeps: paperHaltDeps,
    });

    // Upgrade alertFn to real Telegram — wrap to normal priority by default
    const botAlert = makeBotAlert(bot, tgChatId);
    alertFn = async (msg) => botAlert('normal', msg);

    // eslint-disable-next-line no-console
    console.log('[main] Telegram bot launched');
  } else {
    // eslint-disable-next-line no-console
    console.warn('[main] TELEGRAM_BOT_TOKEN not set — alerts are console-only');
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  const dashServer = await startDashboard({
    port: ENV.DASHBOARD_PORT,
    host: ENV.DASHBOARD_HOST,
  });
  const dashAddr = dashServer.address() as { address: string; port: number };
  // eslint-disable-next-line no-console
  console.log(`[main] Dashboard on http://${dashAddr.address}:${dashAddr.port}`);

  // ── Safety loop — 15s, no jitter ─────────────────────────────────────────

  scheduleLoop(
    'safety',
    () => runSafetyCycle(paperSafetyDeps),
    SAFETY_LOOP_INTERVAL_MS,
  );

  // ── Decision loop — 3 min ± 30s jitter ───────────────────────────────────

  scheduleLoop(
    'decision',
    () => runDecisionCycle(paperDecisionDeps()),
    DECISION_LOOP_INTERVAL_MS,
    { jitterMs: DECISION_LOOP_JITTER_MS },
  );

  // ── Periodic reconciler — every 5 min ────────────────────────────────────

  scheduleLoop(
    'reconciler',
    () => runReconciler(paperReconcilerDeps).then(() => {}),
    RECONCILER_INTERVAL_MS,
  );

  // ── Daily review at 22:00 UTC ─────────────────────────────────────────────

  scheduleDailyReview({
    sendAlert: async (msg) => alertFn(msg),
  });

  // eslint-disable-next-line no-console
  console.log(
    `[main] Agent running — ${EXECUTION_MODE} mode. ` +
    `Dashboard: http://${dashAddr.address}:${dashAddr.port} — ${nowUtc()}`,
  );

  void recordHeartbeat;
  void SAFETY;
  void HEARTBEAT_MAX_AGE_HOURS;
  void buildDecisionPrompt;
  void formatPortfolioForPrompt;
  void listOpenPositions;
  void getDb;
  void nowUtc;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[main] fatal error:', err);
  process.exit(1);
});
