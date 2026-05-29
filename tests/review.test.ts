// Daily Opus review tests. See spec §4.2.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import { tradeMutex } from '../src/agent/mutex.js';
import {
  initDb, closeDb, nowUtc, insertDecision, insertIntent, insertTrade,
} from '../src/observability/db.js';
import { runDailyReview } from '../src/agent/review.js';
import type { ReviewDeps } from '../src/agent/review.js';
import Anthropic from '@anthropic-ai/sdk';

function tempDb() {
  return join(tmpdir(), `coinboi-review-test-${process.pid}-${Date.now()}.db`);
}

function tempDir() {
  return join(tmpdir(), `coinboi-reviews-${process.pid}-${Date.now()}`);
}

function makeClient(responseText: string): () => Anthropic {
  const mockCreate = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: responseText }],
  });
  const mockClient = { messages: { create: mockCreate } } as unknown as Anthropic;
  return () => mockClient;
}

describe('runDailyReview()', () => {
  let dbPath: string;
  let reviewsDir: string;

  beforeEach(() => {
    dbPath = tempDb();
    reviewsDir = tempDir();
    initDb(dbPath);
  });

  afterEach(() => {
    closeDb();
    if (existsSync(reviewsDir)) {
      rmSync(reviewsDir, { recursive: true });
    }
  });

  // ── Lock semantics ─────────────────────────────────────────────────────────

  it('skips review if trade mutex cannot be acquired within lockTimeoutMs', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const deps: ReviewDeps = {
      sendAlert,
      clientFactory: makeClient('review text'),
      lockTimeoutMs: 100, // very short timeout
      reviewsDir,
    };

    // Hold the mutex throughout
    const release = await tradeMutex.acquire();
    try {
      const result = await runDailyReview(deps);
      expect(result).toBe('skipped');
      expect(sendAlert).not.toHaveBeenCalled();
    } finally {
      release();
    }
  }, 10_000);

  it('proceeds when trade mutex is free (acquired and released immediately)', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const deps: ReviewDeps = {
      sendAlert,
      clientFactory: makeClient('# Review\n\nAll good today.'),
      lockTimeoutMs: 1000,
      reviewsDir,
    };

    // Mutex is free
    const result = await runDailyReview(deps);
    expect(result).toBe('completed');
    expect(sendAlert).toHaveBeenCalledOnce();
  });

  it('waits for the lock then proceeds when released before timeout', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const deps: ReviewDeps = {
      sendAlert,
      clientFactory: makeClient('# Review\n\nGood trading day.'),
      lockTimeoutMs: 2000,
      reviewsDir,
    };

    // Hold the mutex briefly then release
    const release = await tradeMutex.acquire();
    setTimeout(() => release(), 300);

    const result = await runDailyReview(deps);
    expect(result).toBe('completed');
  }, 10_000);

  // ── Markdown artifact ──────────────────────────────────────────────────────

  it('produces a non-empty markdown file given decisions and trades in DB', async () => {
    // Seed the DB with a decision, intent, and trade
    const decisionId = insertDecision({
      timestamp_utc: nowUtc(),
      action: 'HOLD_ALL',
      thesis: 'No clear edge',
      invalidation: 'Any strong breakout',
      expected_move_pct: 0,
      confidence: 50,
      validated: true,
      executed: false,
    });

    const intentId = insertIntent({
      decision_id: decisionId,
      token: 'BONK',
      side: 'BUY',
      size_usdc: 3.0,
      quote_snapshot: '{}',
      status: 'CONFIRMED',
      created_at_utc: nowUtc(),
    });

    insertTrade({
      intent_id: intentId,
      decision_id: decisionId,
      timestamp_utc: nowUtc(),
      token: 'BONK',
      side: 'BUY',
      size_usdc: 3.0,
      size_tokens: 100_000,
      price: 0.00003,
      tx_signature: 'abc123',
      slippage_pct: 0.5,
      fee_usdc: 0.01,
    });

    const reviewText = '# Daily Review\n\n## Edge\nHOLD_ALL was correct given low confidence.\n\n## Summary\nNo trades today.';
    const deps: ReviewDeps = {
      sendAlert: vi.fn().mockResolvedValue(undefined),
      clientFactory: makeClient(reviewText),
      lockTimeoutMs: 1000,
      reviewsDir,
    };

    const result = await runDailyReview(deps);
    expect(result).toBe('completed');

    // File must exist and be non-empty
    const files = readdirSync(reviewsDir).filter((f) => f.endsWith('.md'));
    expect(files.length).toBe(1);

    const { readFileSync } = await import('node:fs');
    const content = readFileSync(join(reviewsDir, files[0]!), 'utf-8');
    expect(content.length).toBeGreaterThan(100);
    expect(content).toContain('# Daily Review');
    expect(content).toContain('Edge');
  });

  it('sends a Telegram summary alert after completing', async () => {
    const sendAlert = vi.fn().mockResolvedValue(undefined);
    const deps: ReviewDeps = {
      sendAlert,
      clientFactory: makeClient('## Summary\nGood day overall.'),
      lockTimeoutMs: 1000,
      reviewsDir,
    };

    await runDailyReview(deps);

    expect(sendAlert).toHaveBeenCalledOnce();
    const msg = sendAlert.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Daily review complete');
  });
});
