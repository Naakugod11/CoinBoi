// Manual halt handler. See spec §2.11.
// Callable from Telegram (/halt, Day 4 wiring) and scripts/halt.ts.
// Auth: only TELEGRAM_AUTHORIZED_USER_ID may trigger halt via Telegram.
// Sequence: set kill switch → set paused → liquidate inside mutex → halt.
import { setKillSwitchTriggered, setPaused } from '../observability/db.js';
import { tradeMutex } from './mutex.js';
import { ENV } from '../config.js';

// ── Injectable dependencies ────────────────────────────────────────────────────

export interface HaltDeps {
  marketSellAllWithRetry(): Promise<void>;
  alert(msg: string): Promise<void>;
  /** Called after liquidation to stop the process. Default: process.exit(0). */
  halt?(): never;
}

// ── Core halt logic (auth-gate stripped out here; caller must auth) ───────────

export async function executeHalt(deps: HaltDeps): Promise<never> {
  setKillSwitchTriggered('manual_halt');
  setPaused(true, 'manual_halt');

  await tradeMutex.runExclusive(async () => {
    await deps.marketSellAllWithRetry();
  });

  await deps.alert('MANUAL HALT executed. All positions liquidated. Agent halted.');

  const haltFn = deps.halt ?? defaultHalt;
  return haltFn();
}

// ── Telegram auth gate ────────────────────────────────────────────────────────
// Called by the Telegram message handler (Day 4). Returns true if the sender
// is authorized, false otherwise (message ignored).

export function isAuthorizedHaltSender(telegramUserId: number | string): boolean {
  const authorizedId = ENV.TELEGRAM_AUTHORIZED_USER_ID;
  if (!authorizedId) return false;
  return String(telegramUserId) === String(authorizedId);
}

// ── Telegram handler stub (wired to actual bot in Day 4) ─────────────────────

export async function handleHaltCommand(
  telegramUserId: number | string,
  deps: HaltDeps,
): Promise<void> {
  if (!isAuthorizedHaltSender(telegramUserId)) {
    // Silently ignore — spec §2.11: only Naaku
    return;
  }
  await executeHalt(deps);
}

// ── Default halt: stop the process ───────────────────────────────────────────

function defaultHalt(): never {
  // eslint-disable-next-line no-console
  console.error('[halt-handler] Agent halted by /halt command. Exiting.');
  process.exit(0);
}
