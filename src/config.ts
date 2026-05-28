// Constants, env loading, safety-bound enforcement. See spec §1.
// Hard rules are exported as `as const` — these are the authoritative values.
// .env / environment variables are for ops convenience only.
// If an env value tries to LOOSEN a safety bound, it is silently ignored
// and the hard-coded constant is used. See enforceNotLooser() below.
import 'dotenv/config';
import { z } from 'zod';

// ── IMMUTABLE SAFETY BOUNDS — spec §1 ────────────────────────────────────────
// These values are enforced in code paths that bypass the LLM.
// Claude can never reason past these. Do not weaken them.

export const SAFETY = {
  // Per-position entry cap. Hard maximum — no env override allowed.
  MAX_POSITION_SIZE_USDC: 5,
  // Maximum concurrent open positions.
  MAX_CONCURRENT_POSITIONS: 3,
  // Stop-loss threshold (fractional). −40% from cost basis, 2-tick confirm.
  STOP_LOSS_PCT: 0.40,
  // Portfolio soft pause: blocks OPEN/ADD; EXIT still allowed.
  SOFT_PAUSE_DRAWDOWN_USDC: 8,
  // Portfolio hard stop: full liquidation, then agent halts.
  HARD_STOP_DRAWDOWN_USDC: 13,
  // Daily trade cap — rolling 24h window.
  DAILY_TRADE_CAP: 12,
  // SOL gas reserve floor in SOL. Below this → auto-pause.
  SOL_RESERVE_FLOOR: 0.015,
  // Max one-way execution cost (fees + slippage) at quote time.
  // Trade is SKIPPED (not executed) if quote exceeds this.
  SLIPPAGE_BUDGET_ONE_WAY: 0.015,
  // Jupiter slippageBps passed on every swap — hard cap: swap reverts on-chain
  // if execution would exceed this.
  JUPITER_SLIPPAGE_BPS: 150,
  // Minimum expected move for OPEN/ADD. Below this, fee drag dominates.
  MIN_EXPECTED_MOVE_PCT: 5,
  // Starting capital (informational; used only for peak seeding in db init).
  STARTING_CAPITAL_USDC: 30,
} as const;

// ── EXECUTION MODE ────────────────────────────────────────────────────────────
// Two explicit gates required for live mode:
//   1. PAPER_TRADE must be explicitly "false"
//   2. LIVE_CONFIRMED must be explicitly "true"
// Any other combination → paper mode. Live can never be the accidental default.

export type ExecutionMode = 'paper' | 'live';

function resolveExecutionMode(): ExecutionMode {
  const paperTrade = process.env['PAPER_TRADE'];
  const liveConfirmed = process.env['LIVE_CONFIRMED'];
  if (paperTrade === 'false' && liveConfirmed === 'true') return 'live';
  return 'paper';
}

export const EXECUTION_MODE: ExecutionMode = resolveExecutionMode();

// ── ENV SCHEMA — zod validates and coerces ────────────────────────────────────

const envSchema = z.object({
  // Required for live/agent use; optional in paper mode
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  HELIUS_API_KEY: z.string().min(1).optional(),
  HELIUS_RPC_URL: z.string().url().optional(),

  WALLET_PUBLIC_KEY: z.string().optional(),

  // Telegram — optional (paper mode runs without it)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_AUTHORIZED_USER_ID: z.string().optional(),

  // Claude models
  CLAUDE_DECISION_MODEL: z.string().default('claude-haiku-4-5-20251001'),
  CLAUDE_REVIEW_MODEL: z.string().default('claude-opus-4-7'),

  // Ops
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DB_PATH: z.string().default('./data/trading.db'),
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3000),
  DASHBOARD_HOST: z.string().default('127.0.0.1'),

  // Loop cadences (ms) — ops can tune, safety can never be loosened via env
  DECISION_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(180_000),
  DECISION_LOOP_JITTER_MS: z.coerce.number().int().nonnegative().default(30_000),
  SAFETY_LOOP_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  RECONCILER_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  HEARTBEAT_MAX_AGE_HOURS: z.coerce.number().positive().default(12),

  // Mode flags
  PAPER_TRADE: z.string().optional(),
  LIVE_CONFIRMED: z.string().optional(),

  // Market data
  DEXSCREENER_BASE_URL: z.string().url().default('https://api.dexscreener.com'),
  LUNARCRUSH_API_KEY: z.string().optional(),

  HELIUS_REGION: z.string().default('fra'),
});

function parseEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}

export const ENV = parseEnv();

// ── Safety-bound enforcement ──────────────────────────────────────────────────
// Validate that any env-supplied safety value is NOT looser than the hard code
// constant. If it is, warn loudly and use the constant. This makes it impossible
// to accidentally deploy with a weakened safety boundary from a misconfigured env.

function enforceNotLooser<T extends number>(
  envValue: T | undefined,
  hardBound: T,
  name: string,
  looserWhen: (env: T, bound: T) => boolean,
): T {
  if (envValue === undefined) return hardBound;
  if (looserWhen(envValue, hardBound)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[config] WARNING: ${name} env value ${envValue} is looser than safety bound ` +
      `${hardBound}. Using hard-coded bound.`
    );
    return hardBound;
  }
  return envValue;
}

// These are the values the rest of the code actually uses.
// For safety bounds, env can only tighten (smaller position, tighter stop, lower cap).

/** Max position size in USDC — cannot exceed SAFETY.MAX_POSITION_SIZE_USDC */
export const MAX_POSITION_SIZE_USDC = enforceNotLooser(
  z.coerce.number().optional().parse(process.env['MAX_POSITION_SIZE_USDC']),
  SAFETY.MAX_POSITION_SIZE_USDC,
  'MAX_POSITION_SIZE_USDC',
  (env, bound) => env > bound,
);

/** Max concurrent positions — cannot exceed SAFETY.MAX_CONCURRENT_POSITIONS */
export const MAX_CONCURRENT_POSITIONS = enforceNotLooser(
  z.coerce.number().int().optional().parse(process.env['MAX_CONCURRENT_POSITIONS']),
  SAFETY.MAX_CONCURRENT_POSITIONS,
  'MAX_CONCURRENT_POSITIONS',
  (env, bound) => env > bound,
);

/** Stop-loss fraction — cannot be smaller (looser) than SAFETY.STOP_LOSS_PCT */
export const STOP_LOSS_PCT = enforceNotLooser(
  z.coerce.number().optional().parse(process.env['STOP_LOSS_PCT']),
  SAFETY.STOP_LOSS_PCT,
  'STOP_LOSS_PCT',
  (env, bound) => env < bound,
);

/** Soft-pause drawdown — cannot be larger (looser) than SAFETY bound */
export const SOFT_PAUSE_DRAWDOWN_USDC = enforceNotLooser(
  z.coerce.number().optional().parse(process.env['SOFT_PAUSE_DRAWDOWN_USDC']),
  SAFETY.SOFT_PAUSE_DRAWDOWN_USDC,
  'SOFT_PAUSE_DRAWDOWN_USDC',
  (env, bound) => env > bound,
);

/** Hard-stop drawdown — cannot be larger (looser) than SAFETY bound */
export const HARD_STOP_DRAWDOWN_USDC = enforceNotLooser(
  z.coerce.number().optional().parse(process.env['HARD_STOP_DRAWDOWN_USDC']),
  SAFETY.HARD_STOP_DRAWDOWN_USDC,
  'HARD_STOP_DRAWDOWN_USDC',
  (env, bound) => env > bound,
);

/** Daily trade cap — cannot be larger (looser) than SAFETY bound */
export const DAILY_TRADE_CAP = enforceNotLooser(
  z.coerce.number().int().optional().parse(process.env['DAILY_TRADE_CAP']),
  SAFETY.DAILY_TRADE_CAP,
  'DAILY_TRADE_CAP',
  (env, bound) => env > bound,
);

/** SOL reserve floor — cannot be smaller (looser) than SAFETY bound */
export const SOL_RESERVE_FLOOR = enforceNotLooser(
  z.coerce.number().optional().parse(process.env['SOL_RESERVE_FLOOR']),
  SAFETY.SOL_RESERVE_FLOOR,
  'SOL_RESERVE_FLOOR',
  (env, bound) => env < bound,
);

/** Slippage budget one-way — cannot be larger (looser) than SAFETY bound */
export const SLIPPAGE_BUDGET_ONE_WAY = enforceNotLooser(
  z.coerce.number().optional().parse(process.env['SLIPPAGE_BUDGET_ONE_WAY']),
  SAFETY.SLIPPAGE_BUDGET_ONE_WAY,
  'SLIPPAGE_BUDGET_ONE_WAY',
  (env, bound) => env > bound,
);

// ── Convenience re-exports ────────────────────────────────────────────────────

export const CLAUDE_DECISION_MODEL = ENV.CLAUDE_DECISION_MODEL;
export const CLAUDE_REVIEW_MODEL = ENV.CLAUDE_REVIEW_MODEL;
export const DB_PATH = ENV.DB_PATH;
export const LOG_LEVEL = ENV.LOG_LEVEL;
export const DECISION_LOOP_INTERVAL_MS = ENV.DECISION_LOOP_INTERVAL_MS;
export const DECISION_LOOP_JITTER_MS = ENV.DECISION_LOOP_JITTER_MS;
export const SAFETY_LOOP_INTERVAL_MS = ENV.SAFETY_LOOP_INTERVAL_MS;
export const RECONCILER_INTERVAL_MS = ENV.RECONCILER_INTERVAL_MS;
export const HEARTBEAT_MAX_AGE_HOURS = ENV.HEARTBEAT_MAX_AGE_HOURS;
