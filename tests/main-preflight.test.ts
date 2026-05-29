// Pre-flight check tests. See src/preflight.ts and spec §6.2.
// These are the gates that catch "I forgot to set X" before any loop ticks.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { runPreflightChecks, type PreflightConfig } from '../src/preflight.js';
import { PaperSwapExecutor, type SwapExecutor } from '../src/execution/sol-cli.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tempDb() {
  return join(tmpdir(), `coinboi-preflight-test-${process.pid}-${Date.now()}.db`);
}

// Full valid paper-mode config — individual tests override one field at a time
function validPaperConfig(dbPath: string): PreflightConfig {
  return {
    executionMode: 'paper',
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      HELIUS_API_KEY: 'helius-test-key',
      TELEGRAM_BOT_TOKEN: 'bot:token',
      TELEGRAM_CHAT_ID: '-1001234567890',
      TELEGRAM_AUTHORIZED_USER_ID: '123456789',
      WALLET_PUBLIC_KEY: 'WalletPubkey111111111111111111111111111111111',
      LUNARCRUSH_API_KEY: 'lc-key',
    },
    executor: new PaperSwapExecutor(),
    dbPath,
    decisionModel: 'claude-haiku-4-5-20251001',
    reviewModel: 'claude-opus-4-7',
    dashboardHost: '127.0.0.1',
    dashboardPort: 3000,
  };
}

describe('preflight checks', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = tempDb();
  });

  afterEach(() => {
    for (const ext of ['', '-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) rmSync(p);
    }
    vi.restoreAllMocks();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it('paper mode + PaperSwapExecutor + all keys → passes without throwing', () => {
    expect(() => runPreflightChecks(validPaperConfig(dbPath))).not.toThrow();
  });

  it('prints startup banner on success', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    runPreflightChecks(validPaperConfig(dbPath));
    const calls = spy.mock.calls.flat().join(' ');
    expect(calls).toContain('preflight');
    expect(calls).toContain('mode=paper');
    expect(calls).toContain('Wallet'); // first 6 chars of the test wallet key
  });

  // ── a. Executor–mode consistency ──────────────────────────────────────────

  it('paper mode but executor is NOT PaperSwapExecutor → throws', () => {
    const fakeExecutor: SwapExecutor = {
      quote: async () => { throw new Error('should not be called'); },
      swap:  async () => { throw new Error('should not be called'); },
    };
    const cfg = { ...validPaperConfig(dbPath), executor: fakeExecutor };
    expect(() => runPreflightChecks(cfg)).toThrow(/PaperSwapExecutor/);
  });

  it('live mode without LIVE_CONFIRMED → throws naming the flag', () => {
    const cfg: PreflightConfig = {
      ...validPaperConfig(dbPath),
      executionMode: 'live',
      executor: new PaperSwapExecutor(), // type-check only (live executor can't construct here)
      env: {
        ...validPaperConfig(dbPath).env,
        PAPER_TRADE: 'false',
        // LIVE_CONFIRMED deliberately omitted
      },
    };
    expect(() => runPreflightChecks(cfg)).toThrow(/LIVE_CONFIRMED/);
  });

  it('live mode without PAPER_TRADE=false → throws naming the flag', () => {
    const cfg: PreflightConfig = {
      ...validPaperConfig(dbPath),
      executionMode: 'live',
      executor: new PaperSwapExecutor(),
      env: {
        ...validPaperConfig(dbPath).env,
        LIVE_CONFIRMED: 'true',
        // PAPER_TRADE deliberately omitted (defaults to undefined → not 'false')
      },
    };
    expect(() => runPreflightChecks(cfg)).toThrow(/PAPER_TRADE/);
  });

  // ── b. Required env keys ──────────────────────────────────────────────────

  it('missing ANTHROPIC_API_KEY → throws naming the key', () => {
    const cfg = {
      ...validPaperConfig(dbPath),
      env: { ...validPaperConfig(dbPath).env, ANTHROPIC_API_KEY: '' },
    };
    expect(() => runPreflightChecks(cfg)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('missing HELIUS_API_KEY → throws naming the key', () => {
    const cfg = {
      ...validPaperConfig(dbPath),
      env: { ...validPaperConfig(dbPath).env, HELIUS_API_KEY: undefined },
    };
    expect(() => runPreflightChecks(cfg)).toThrow(/HELIUS_API_KEY/);
  });

  it('missing TELEGRAM_BOT_TOKEN → throws naming the key', () => {
    const cfg = {
      ...validPaperConfig(dbPath),
      env: { ...validPaperConfig(dbPath).env, TELEGRAM_BOT_TOKEN: '  ' }, // whitespace only
    };
    expect(() => runPreflightChecks(cfg)).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('missing WALLET_PUBLIC_KEY → throws naming the key', () => {
    const cfg = {
      ...validPaperConfig(dbPath),
      env: { ...validPaperConfig(dbPath).env, WALLET_PUBLIC_KEY: undefined },
    };
    expect(() => runPreflightChecks(cfg)).toThrow(/WALLET_PUBLIC_KEY/);
  });

  it('missing LUNARCRUSH_API_KEY → does NOT throw, logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const env = { ...validPaperConfig(dbPath).env };
    delete env['LUNARCRUSH_API_KEY'];

    expect(() => runPreflightChecks({ ...validPaperConfig(dbPath), env })).not.toThrow();

    const warnMessages = warnSpy.mock.calls.flat().join(' ');
    expect(warnMessages).toContain('LUNARCRUSH');
  });

  // ── c. DB path writable ───────────────────────────────────────────────────

  it('unwritable DB path → throws with the path in the message', () => {
    const badPath = '/proc/non_existent_dir/trading.db';
    const cfg = { ...validPaperConfig(dbPath), dbPath: badPath };
    expect(() => runPreflightChecks(cfg)).toThrow(badPath);
  });

  // ── d. Banner truncates wallet key ────────────────────────────────────────

  it('startup banner shows truncated wallet key (first 6 + last 4), never full key', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const fullKey = 'WalletPubkey111111111111111111111111111111111';
    const cfg = {
      ...validPaperConfig(dbPath),
      env: { ...validPaperConfig(dbPath).env, WALLET_PUBLIC_KEY: fullKey },
    };

    runPreflightChecks(cfg);

    const banner = logSpy.mock.calls.flat().join(' ');
    // First 6 chars present
    expect(banner).toContain(fullKey.slice(0, 6));
    // Last 4 chars present
    expect(banner).toContain(fullKey.slice(-4));
    // Full key NOT present
    expect(banner).not.toContain(fullKey);
  });
});
