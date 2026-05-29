// Telegram auth gate and alert routing tests. See spec §5.2, §2.11.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  alert, handleHaltCmd, handleHeartbeatCmd, handleStatusCmd, handlePositionsCmd,
  isAuthorized, type AlertLevel, type CmdCtx, type SendFn,
} from '../src/observability/telegram.js';
import { initDb, closeDb } from '../src/observability/db.js';
import type { HaltDeps } from '../src/agent/halt-handler.js';

function tempDb() {
  return join(tmpdir(), `coinboi-tg-test-${process.pid}-${Date.now()}.db`);
}

const AUTH_ID = '12345';
const WRONG_ID = 99999;
const AUTH_ID_NUM = 12345;

function makeCtx(userId?: number): { from?: { id: number }; reply: ReturnType<typeof vi.fn> } {
  return {
    ...(userId !== undefined ? { from: { id: userId } } : {}),
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeHaltDeps(): { deps: HaltDeps; sellSpy: ReturnType<typeof vi.fn>; haltSpy: () => never } {
  const sellSpy = vi.fn().mockResolvedValue(undefined);
  let haltCalled = false;
  const haltSpy = vi.fn(() => { haltCalled = true; }) as unknown as () => never;
  void haltCalled;
  return {
    deps: { marketSellAllWithRetry: sellSpy, alert: vi.fn(), halt: haltSpy },
    sellSpy,
    haltSpy,
  };
}

// ── isAuthorized ─────────────────────────────────────────────────────────────

describe('isAuthorized()', () => {
  it('returns true for matching string IDs', () => {
    expect(isAuthorized(12345, '12345')).toBe(true);
  });

  it('returns false for non-matching IDs', () => {
    expect(isAuthorized(99999, '12345')).toBe(false);
  });

  it('returns false when userId is undefined', () => {
    expect(isAuthorized(undefined, '12345')).toBe(false);
  });

  it('returns false when authorizedId is empty', () => {
    expect(isAuthorized(12345, '')).toBe(false);
  });
});

// ── alert() priority levels ───────────────────────────────────────────────────

describe('alert()', () => {
  const levels: AlertLevel[] = ['critical', 'high', 'normal'];

  levels.forEach((level) => {
    it(`${level} → disable_notification=${level === 'normal'}`, async () => {
      const sendSpy: SendFn = vi.fn().mockResolvedValue(undefined);
      await alert(level, 'test message', sendSpy, 'chat-123');

      expect(sendSpy).toHaveBeenCalledOnce();
      const [chatId, text, opts] = (sendSpy as ReturnType<typeof vi.fn>).mock.calls[0] as [
        string, string, { disable_notification: boolean }
      ];
      expect(chatId).toBe('chat-123');
      expect(text).toContain(level.toUpperCase());
      expect(opts.disable_notification).toBe(level === 'normal');
    });
  });

  it('critical → sound (disable_notification=false)', async () => {
    const sendSpy: SendFn = vi.fn().mockResolvedValue(undefined);
    await alert('critical', 'HALT FIRED', sendSpy, 'chat-1');
    const opts = (sendSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as { disable_notification: boolean };
    expect(opts.disable_notification).toBe(false);
  });

  it('normal → silent (disable_notification=true)', async () => {
    const sendSpy: SendFn = vi.fn().mockResolvedValue(undefined);
    await alert('normal', 'Trade confirmed', sendSpy, 'chat-1');
    const opts = (sendSpy as ReturnType<typeof vi.fn>).mock.calls[0]?.[2] as { disable_notification: boolean };
    expect(opts.disable_notification).toBe(true);
  });
});

// ── /halt auth gate — the critical property ───────────────────────────────────

describe('/halt auth gate', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('wrong user_id → handler NOT invoked, no reply sent', async () => {
    const ctx = makeCtx(WRONG_ID) as CmdCtx;
    const { deps, sellSpy } = makeHaltDeps();
    const executeHaltSpy = vi.fn().mockResolvedValue(undefined) as unknown as
      (d: HaltDeps) => Promise<never>;

    await handleHaltCmd(ctx, AUTH_ID, deps, executeHaltSpy);

    expect(executeHaltSpy).not.toHaveBeenCalled();
    expect(sellSpy).not.toHaveBeenCalled();
    expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).not.toHaveBeenCalled();
  });

  it('no from field → handler NOT invoked, no reply sent', async () => {
    const ctx = makeCtx(undefined) as CmdCtx;
    const { deps } = makeHaltDeps();
    const executeHaltSpy = vi.fn().mockResolvedValue(undefined) as unknown as
      (d: HaltDeps) => Promise<never>;

    await handleHaltCmd(ctx, AUTH_ID, deps, executeHaltSpy);

    expect(executeHaltSpy).not.toHaveBeenCalled();
  });

  it('authorized user_id → handler invoked', async () => {
    const ctx = makeCtx(AUTH_ID_NUM) as CmdCtx;
    const { deps } = makeHaltDeps();
    const executeHaltSpy = vi.fn().mockResolvedValue(undefined) as unknown as
      (d: HaltDeps) => Promise<never>;

    await handleHaltCmd(ctx, AUTH_ID, deps, executeHaltSpy);

    expect(executeHaltSpy).toHaveBeenCalledOnce();
    expect(executeHaltSpy).toHaveBeenCalledWith(deps);
  });

  it('authorized user_id passes the haltDeps through unchanged', async () => {
    const ctx = makeCtx(AUTH_ID_NUM) as CmdCtx;
    const { deps } = makeHaltDeps();
    let capturedDeps: HaltDeps | undefined;
    const executeHaltSpy = vi.fn(async (d: HaltDeps) => {
      capturedDeps = d;
    }) as unknown as (d: HaltDeps) => Promise<never>;

    await handleHaltCmd(ctx, AUTH_ID, deps, executeHaltSpy);

    expect(capturedDeps).toBe(deps);
  });
});

// ── /heartbeat ────────────────────────────────────────────────────────────────

describe('/heartbeat', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('records heartbeat and replies', () => {
    const ctx = makeCtx(AUTH_ID_NUM) as CmdCtx;
    handleHeartbeatCmd(ctx);
    expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledOnce();
  });
});

// ── /status and /positions — read-only auth gate ──────────────────────────────

describe('/status auth gate', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('wrong user_id → no reply', async () => {
    const ctx = makeCtx(WRONG_ID) as CmdCtx;
    await handleStatusCmd(ctx, AUTH_ID);
    expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).not.toHaveBeenCalled();
  });

  it('authorized user_id → replies with status', async () => {
    const ctx = makeCtx(AUTH_ID_NUM) as CmdCtx;
    await handleStatusCmd(ctx, AUTH_ID);
    expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledOnce();
  });
});

describe('/positions auth gate', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
  });

  it('wrong user_id → no reply', async () => {
    const ctx = makeCtx(WRONG_ID) as CmdCtx;
    await handlePositionsCmd(ctx, AUTH_ID);
    expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).not.toHaveBeenCalled();
  });

  it('authorized user_id → replies (empty positions)', async () => {
    const ctx = makeCtx(AUTH_ID_NUM) as CmdCtx;
    await handlePositionsCmd(ctx, AUTH_ID);
    expect((ctx as { reply: ReturnType<typeof vi.fn> }).reply).toHaveBeenCalledOnce();
    const msg = (ctx as { reply: ReturnType<typeof vi.fn> }).reply.mock.calls[0]?.[0] as string;
    expect(msg).toContain('No open positions');
  });
});
