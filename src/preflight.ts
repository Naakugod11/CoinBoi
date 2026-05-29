// Pre-flight sanity checks — run before any loop starts. See spec §6.2.
// All checks are synchronous and throw with a descriptive message on failure.
// Runs BEFORE Telegram is wired so config errors don't blast alerts.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { PaperSwapExecutor, type SwapExecutor } from './execution/sol-cli.js';

// ── Keys required in all execution modes ──────────────────────────────────────

const REQUIRED_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'HELIUS_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_AUTHORIZED_USER_ID',
  'WALLET_PUBLIC_KEY',
] as const;

// ── Preflight config (injected for testability) ───────────────────────────────

export interface PreflightConfig {
  executionMode: 'paper' | 'live';
  env: Partial<Record<string, string>>;
  executor: SwapExecutor;
  dbPath: string;
  decisionModel: string;
  reviewModel: string;
  dashboardHost: string;
  dashboardPort: number;
}

// ── runPreflightChecks ────────────────────────────────────────────────────────

export function runPreflightChecks(cfg: PreflightConfig): void {
  const { executionMode, env, executor, dbPath } = cfg;

  // ── a. Executor–mode consistency ──────────────────────────────────────────

  if (executionMode === 'paper') {
    if (!(executor instanceof PaperSwapExecutor)) {
      throw new Error(
        'Execution mode is PAPER but executor is not PaperSwapExecutor. ' +
        'This would fire real swaps in paper mode. Aborting.',
      );
    }
  }

  if (executionMode === 'live') {
    if (env['PAPER_TRADE'] !== 'false') {
      throw new Error(
        'Live mode requires PAPER_TRADE=false — flag is missing or not set to "false". ' +
        'Set PAPER_TRADE=false explicitly before going live.',
      );
    }
    if (env['LIVE_CONFIRMED'] !== 'true') {
      throw new Error(
        'Live mode requires LIVE_CONFIRMED=true — flag is missing or not set to "true". ' +
        'Set LIVE_CONFIRMED=true explicitly before going live.',
      );
    }
  }

  // ── b. Required env keys ──────────────────────────────────────────────────

  for (const key of REQUIRED_ENV_KEYS) {
    const val = env[key];
    if (!val || val.trim() === '') {
      throw new Error(
        `Required env key ${key} is missing or empty. Set it in .env before starting the agent.`,
      );
    }
  }

  if (!env['LUNARCRUSH_API_KEY']) {
    // eslint-disable-next-line no-console
    console.warn('[preflight] LUNARCRUSH_API_KEY not set — sentiment signal will be unavailable');
  }

  // ── c. DB path writable ───────────────────────────────────────────────────

  try {
    const db = new Database(dbPath);
    db.close();
  } catch (e) {
    throw new Error(`DB path "${dbPath}" is not writable: ${e}`);
  }

  // ── d. Startup banner ─────────────────────────────────────────────────────

  const walletKey = env['WALLET_PUBLIC_KEY'] ?? '';
  const truncatedKey =
    walletKey.length >= 10
      ? `${walletKey.slice(0, 6)}…${walletKey.slice(-4)}`
      : walletKey;

  const version = readPackageVersion();

  // eslint-disable-next-line no-console
  console.log(
    `[preflight] CoinBoi v${version} — mode=${executionMode}` +
    ` | decision=${cfg.decisionModel} review=${cfg.reviewModel}` +
    ` | dashboard=${cfg.dashboardHost}:${cfg.dashboardPort}` +
    ` | wallet=${truncatedKey}`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readPackageVersion(): string {
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(__dir, '../package.json'), 'utf-8');
    return (JSON.parse(raw) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
