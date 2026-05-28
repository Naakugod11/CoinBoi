// Entry point: reconcile (blocking) → safety loop → decision loop → log ready.
// See spec §2.3, §2.4. Both loops share tradeMutex from mutex.ts.
// Paper mode: no wallet funded, no real swaps. All safety logic still runs.
import { initDb, nowUtc, listOpenPositions, getRecentDecisions } from './observability/db.js';
import { scheduleLoop } from './agent/scheduler.js';
import { runSafetyCycle } from './agent/safety-loop.js';
import { runDecisionCycle } from './agent/decision-loop.js';
import { runReconciler } from './agent/reconciler.js';
import { recordHeartbeat } from './agent/heartbeat.js';
import { askDecision } from './agent/claude-client.js';
import { buildDecisionPrompt, formatPortfolioForPrompt } from './agent/prompts.js';
import {
  EXECUTION_MODE, DB_PATH,
  DECISION_LOOP_INTERVAL_MS, DECISION_LOOP_JITTER_MS,
  SAFETY_LOOP_INTERVAL_MS, RECONCILER_INTERVAL_MS,
  SAFETY, HEARTBEAT_MAX_AGE_HOURS,
} from './config.js';
import type { DecisionCycleDeps } from './agent/decision-loop.js';
import type { SafetyLoopDeps } from './agent/safety-loop.js';
import type { ReconcilerDeps } from './agent/reconciler.js';

// ── Paper-mode stubs (Day 4a — no wallet, no mainnet) ────────────────────────

const paperSafetyDeps: SafetyLoopDeps = {
  canonicalPrice: async (_mint, _size) => null, // no price in paper mode yet
  getSolBalance: async () => 1.0,               // pretend we have SOL
  getUsdcBalance: async () => 25.0,             // pretend $25 cash
  marketSellPosition: async (pos) => {
    // eslint-disable-next-line no-console
    console.log(`[paper] would sell position ${pos.token}`);
  },
  marketSellAllWithRetry: async () => {
    // eslint-disable-next-line no-console
    console.log('[paper] would market-sell-all');
  },
  alert: async (msg) => {
    // eslint-disable-next-line no-console
    console.log(`[alert] ${msg}`);
  },
};

const paperReconcilerDeps: ReconcilerDeps = {
  getWalletBalances: async () => ({ usdcBalance: 25, solBalance: 1.0, tokens: [] }),
  checkTxStatus: async () => 'unknown',
  parseSwap: async () => ({ usdcAmount: 0, tokenAmount: 0, feeUsdc: 0 }),
  canonicalPrice: async () => null,
  alert: async (msg) => {
    // eslint-disable-next-line no-console
    console.log(`[reconciler] ${msg}`);
  },
};

function paperDecisionDeps(): DecisionCycleDeps {
  return {
    getSolBalance: async () => 1.0,
    getWalletTokenBalance: async () => 0,
    buildUniverse: async () => [],            // no universe in paper mode yet
    getSignals: async () => '{}',
    getRecentDecisions: (n) => {
      const rows = getRecentDecisions(n);
      if (rows.length === 0) return 'No previous decisions.';
      return rows.map(r => `${r.timestamp_utc}: ${r.action} ${r.token ?? ''} — ${r.skip_reason ?? 'validated'}`).join('\n');
    },
    askClaude: async (prompt) => askDecision(prompt),
    getQuote: async (_token, _sizeUsdc, _sizeTokens) => {
      throw new Error('paper mode: no real quotes');
    },
    executeTx: async (_decisionId, decision, _quote) => {
      // eslint-disable-next-line no-console
      console.log(`[paper] would execute ${decision.action} ${decision.token ?? ''} $${decision.size_usdc ?? ''}`);
    },
    alert: async (msg) => {
      // eslint-disable-next-line no-console
      console.log(`[alert] ${msg}`);
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[main] CoinBoi starting — mode=${EXECUTION_MODE} db=${DB_PATH}`);

  initDb(DB_PATH);

  // Startup: blocking reconcile (agent does not start trading until clean)
  const reconcileResult = await runReconciler(paperReconcilerDeps);
  if (!reconcileResult.clean) {
    // eslint-disable-next-line no-console
    console.error('[main] Reconciler found mismatches at startup. Fix via scripts/reconcile.ts before restarting.');
    process.exit(1);
  }

  // Safety loop — 15s, no jitter (must be tight)
  scheduleLoop(
    'safety',
    () => runSafetyCycle(paperSafetyDeps),
    SAFETY_LOOP_INTERVAL_MS,
  );

  // Decision loop — 3 min ± 30s jitter (spec §1)
  scheduleLoop(
    'decision',
    () => runDecisionCycle(paperDecisionDeps()),
    DECISION_LOOP_INTERVAL_MS,
    { jitterMs: DECISION_LOOP_JITTER_MS },
  );

  // Periodic reconciler — every 5 min
  scheduleLoop(
    'reconciler',
    () => runReconciler(paperReconcilerDeps).then(() => {}),
    RECONCILER_INTERVAL_MS,
  );

  // eslint-disable-next-line no-console
  console.log(`[main] agent running — paper mode, no live swaps. ${nowUtc()}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[main] fatal error:', err);
  process.exit(1);
});
