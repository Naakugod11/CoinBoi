// Heartbeat tracking — records /heartbeat pings and computes age.
// The safety loop calls heartbeatAgeHours() to decide pause/resume.
// See spec §2.6.
import { insertHeartbeat, latestHeartbeatUtc } from '../observability/db.js';
import { ENV } from '../config.js';

// ── Record a heartbeat (called by Telegram handler in Day 4) ─────────────────

export function recordHeartbeat(source = 'telegram_user'): void {
  insertHeartbeat(source);
}

// ── Age of the most recent heartbeat, in fractional hours ────────────────────
// Returns Infinity when no heartbeat has ever been received (agent just started).
// The safety loop compares this against HEARTBEAT_MAX_AGE_HOURS (12h).

export function heartbeatAgeHours(): number {
  const latest = latestHeartbeatUtc();
  if (!latest) return Infinity; // no heartbeat yet — treat as stale

  const ageMs = Date.now() - new Date(latest).getTime();
  return ageMs / (1000 * 60 * 60);
}

// ── Convenience re-export of the max-age constant ────────────────────────────

export const HEARTBEAT_MAX_AGE_HOURS = ENV.HEARTBEAT_MAX_AGE_HOURS;
