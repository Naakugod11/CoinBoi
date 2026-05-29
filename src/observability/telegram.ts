// Alert bot (telegraf) + inbound commands. See spec §5.2, §2.11.
// Auth gate: only TELEGRAM_AUTHORIZED_USER_ID may invoke /halt, /status, /positions.
import { Telegraf } from 'telegraf';
import { insertHeartbeat, listOpenPositions, isPaused, getPauseReason } from './db.js';
import { executeHalt, type HaltDeps } from '../agent/halt-handler.js';

export type AlertLevel = 'critical' | 'high' | 'normal';

// ── Send abstraction — injected in tests so no real HTTP connection needed ────

export type SendFn = (
  chatId: string,
  text: string,
  opts: { disable_notification: boolean },
) => Promise<unknown>;

// ── alert() ───────────────────────────────────────────────────────────────────
// critical/high → sound (disable_notification=false); normal → silent.

export async function alert(
  level: AlertLevel,
  msg: string,
  send: SendFn,
  chatId: string,
): Promise<void> {
  const silent = level === 'normal';
  await send(chatId, `[${level.toUpperCase()}] ${msg}`, { disable_notification: silent });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export function isAuthorized(userId: number | undefined, authorizedId: string): boolean {
  if (!userId || !authorizedId) return false;
  return String(userId) === authorizedId;
}

// ── Minimal context shape used by handlers ────────────────────────────────────

export interface CmdCtx {
  from?: { id: number };
  reply(text: string): Promise<unknown>;
}

// ── Command handlers — pure functions, injectable, fully testable ─────────────

export async function handleHaltCmd(
  ctx: CmdCtx,
  authorizedId: string,
  haltDeps: HaltDeps,
  // injectable so tests can spy without mocking the module
  doExecuteHalt: (deps: HaltDeps) => Promise<never> = executeHalt,
): Promise<void> {
  if (!isAuthorized(ctx.from?.id, authorizedId)) {
    // Silently ignore — spec §2.11: don't reveal to unauthorized callers
    console.warn('[telegram] Unauthorized /halt attempt from user', ctx.from?.id);
    return;
  }
  await doExecuteHalt(haltDeps);
}

export function handleHeartbeatCmd(ctx: CmdCtx): void {
  insertHeartbeat('telegram');
  ctx.reply('Heartbeat recorded.');
}

export async function handleStatusCmd(ctx: CmdCtx, authorizedId: string): Promise<void> {
  if (!isAuthorized(ctx.from?.id, authorizedId)) return;
  const paused = isPaused();
  const reason = getPauseReason();
  const positions = listOpenPositions();
  await ctx.reply(
    [
      `Paused: ${paused}${reason ? ` (${reason})` : ''}`,
      `Open positions: ${positions.length} / 3`,
    ].join('\n'),
  );
}

export async function handlePositionsCmd(ctx: CmdCtx, authorizedId: string): Promise<void> {
  if (!isAuthorized(ctx.from?.id, authorizedId)) return;
  const positions = listOpenPositions();
  if (positions.length === 0) {
    await ctx.reply('No open positions.');
    return;
  }
  const lines = positions.map(
    (p) => `${p.token}: cost=$${p.cost_basis_total_usdc.toFixed(2)}, tokens=${p.size_tokens}`,
  );
  await ctx.reply(lines.join('\n'));
}

// ── Bot wiring ─────────────────────────────────────────────────────────────────

export interface BotWireConfig {
  chatId: string;
  authorizedUserId: string;
  haltDeps: HaltDeps;
}

export function wireBotCommands(bot: Telegraf, cfg: BotWireConfig): void {
  bot.command('heartbeat', (ctx) => {
    handleHeartbeatCmd(ctx);
  });

  bot.command('halt', (ctx) => {
    handleHaltCmd(ctx, cfg.authorizedUserId, cfg.haltDeps).catch((e) => {
      console.error('[telegram] /halt error:', e);
    });
  });

  bot.command('status', (ctx) => {
    handleStatusCmd(ctx, cfg.authorizedUserId).catch((e) => {
      console.error('[telegram] /status error:', e);
    });
  });

  bot.command('positions', (ctx) => {
    handlePositionsCmd(ctx, cfg.authorizedUserId).catch((e) => {
      console.error('[telegram] /positions error:', e);
    });
  });
}

// ── Factory: alert() bound to a live bot ─────────────────────────────────────

export function makeSendFn(bot: Telegraf): SendFn {
  return (chatId, text, opts) =>
    bot.telegram.sendMessage(chatId, text, {
      disable_notification: opts.disable_notification,
    });
}

export function makeBotAlert(bot: Telegraf, chatId: string) {
  const send = makeSendFn(bot);
  return (level: AlertLevel, msg: string): Promise<void> => alert(level, msg, send, chatId);
}

// ── Create and start bot (real usage only) ────────────────────────────────────

export function createAndLaunchBot(token: string, cfg: BotWireConfig): Telegraf {
  const bot = new Telegraf(token);
  wireBotCommands(bot, cfg);
  bot.launch().catch((e) => console.error('[telegram] bot launch error:', e));
  return bot;
}
