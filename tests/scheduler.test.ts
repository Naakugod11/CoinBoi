// Scheduler tests — §2.4 properties: no-overlap, self-heal, jitter.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { scheduleLoop } from '../src/agent/scheduler.js';

// Use fake timers so we don't have to actually wait.
afterEach(() => { vi.useRealTimers(); });

describe('scheduler §2.4', () => {

  // ── No-overlap guarantee ───────────────────────────────────────────────────
  // A slow cycle that runs longer than the interval must NOT start a second
  // concurrent execution. The next tick must log a skip and reschedule.

  it('skips second tick while first cycle is still running', async () => {
    vi.useFakeTimers();

    const concurrentRuns = { count: 0, max: 0 };
    const skips: string[] = [];

    let resolveSlow!: () => void;
    const slowCycle = vi.fn(async () => {
      concurrentRuns.count++;
      concurrentRuns.max = Math.max(concurrentRuns.max, concurrentRuns.count);
      // Stay "running" until the test unblocks it
      await new Promise<void>(r => { resolveSlow = r; });
      concurrentRuns.count--;
    });

    const handle = scheduleLoop('test-loop', slowCycle, 100, {
      onSkip: (_name, reason) => skips.push(reason),
    });

    // Fire first tick
    await vi.advanceTimersByTimeAsync(100);
    // First cycle is now "running" (awaiting resolveSlow).
    expect(slowCycle).toHaveBeenCalledTimes(1);

    // Fire what would be the second tick — should skip because running=true
    await vi.advanceTimersByTimeAsync(100);
    expect(slowCycle).toHaveBeenCalledTimes(1); // still 1
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatch(/previous cycle still running/);

    // Unblock first cycle
    resolveSlow();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // Now a third interval fires — should run because first is done
    await vi.advanceTimersByTimeAsync(100);
    expect(slowCycle).toHaveBeenCalledTimes(2);

    // Max concurrency was ALWAYS 1
    expect(concurrentRuns.max).toBe(1);

    handle.stop();
  });

  // ── Self-heal after exception ──────────────────────────────────────────────
  // An exception in fn must NOT kill the loop. The next tick must still fire.

  it('continues scheduling after fn throws', async () => {
    vi.useFakeTimers();

    const errors: unknown[] = [];
    const callLog: string[] = [];

    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('cycle exploded');
      callLog.push('ok');
    });

    const handle = scheduleLoop('error-loop', fn, 50, {
      onError: (_name, err) => errors.push(err),
    });

    // First tick — throws
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);

    // Second tick — must fire despite error
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(callLog).toContain('ok');

    handle.stop();
  });

  // ── Stop cancels future ticks ──────────────────────────────────────────────

  it('stop() prevents further ticks', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => { /* fast */ });

    const handle = scheduleLoop('stop-test', fn, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(fn).toHaveBeenCalledTimes(1);

    handle.stop();
    await vi.advanceTimersByTimeAsync(500);
    // No further calls after stop
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // ── Jitter is applied ──────────────────────────────────────────────────────
  // We can't assert the exact delay, but we can assert onCycleDone fires
  // (proving the tick ran) within a reasonable window that accounts for jitter.

  it('fires within intervalMs ± jitterMs with jitter configured', async () => {
    vi.useFakeTimers();
    let fired = false;

    const handle = scheduleLoop('jitter-test', async () => { fired = true; }, 100, {
      jitterMs: 30,
    });

    // Should fire somewhere in [70, 130]ms. Advance to 130ms.
    await vi.advanceTimersByTimeAsync(130);
    expect(fired).toBe(true);

    handle.stop();
  });

  // ── Multiple independent loops don't interfere ────────────────────────────

  it('two independent loops run concurrently without interference', async () => {
    vi.useFakeTimers();

    const loopA: number[] = [];
    const loopB: number[] = [];

    const handleA = scheduleLoop('a', async () => { loopA.push(Date.now()); }, 50);
    const handleB = scheduleLoop('b', async () => { loopB.push(Date.now()); }, 70);

    await vi.advanceTimersByTimeAsync(200);

    handleA.stop();
    handleB.stop();

    // Both fired multiple times independently
    expect(loopA.length).toBeGreaterThanOrEqual(3);
    expect(loopB.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Day 5 chaos tests ─────────────────────────────────────────────────────────

describe('scheduler chaos §Day5', () => {

  // ── 4-min cycle in a 3-min schedule ──────────────────────────────────────
  // Chaos: decision cycle takes longer than its own interval.
  // The second tick MUST detect the overlap and log a skip, not execute.

  it('chaos: 4-min cycle in 3-min schedule — skip logged, no concurrent execution', async () => {
    vi.useFakeTimers();

    const INTERVAL_MS = 180_000;  // 3 min
    const CYCLE_DURATION_MS = 240_000;  // 4 min (longer than interval)

    const concurrentRuns = { count: 0, max: 0 };
    const skips: string[] = [];
    let resolveCycle!: () => void;

    const fn = vi.fn(async () => {
      concurrentRuns.count++;
      concurrentRuns.max = Math.max(concurrentRuns.max, concurrentRuns.count);
      await new Promise<void>(r => { resolveCycle = r; });
      concurrentRuns.count--;
    });

    const handle = scheduleLoop('decision', fn, INTERVAL_MS, {
      onSkip: (_name, reason) => skips.push(reason),
    });

    // Fire first cycle (3-min mark)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fn).toHaveBeenCalledTimes(1);

    // 3 more minutes pass — second tick fires but cycle is still running
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(fn).toHaveBeenCalledTimes(1); // still 1 — second tick was skipped
    expect(skips.length).toBeGreaterThanOrEqual(1);
    expect(skips[0]).toMatch(/previous cycle still running/);

    // Unblock the 4-min cycle
    resolveCycle();
    await vi.advanceTimersByTimeAsync(0);

    // Concurrency was always serialized
    expect(concurrentRuns.max).toBe(1);

    handle.stop();
  });

  // ── onCycleDone fires with elapsed time on every tick ─────────────────────
  // Observability: §2.4 requires elapsed time to be logged.

  it('onCycleDone fires with positive elapsedMs after every tick', async () => {
    vi.useFakeTimers();

    const elapsed: number[] = [];
    const handle = scheduleLoop(
      'obs-test',
      async () => {
        // Real work takes some time (simulated via fake time advance in test)
      },
      50,
      { onCycleDone: (_name, ms) => elapsed.push(ms) },
    );

    await vi.advanceTimersByTimeAsync(250);
    handle.stop();

    expect(elapsed.length).toBeGreaterThanOrEqual(4);
    // elapsed time is always a non-negative number
    for (const ms of elapsed) {
      expect(ms).toBeGreaterThanOrEqual(0);
      expect(typeof ms).toBe('number');
    }
  });

  // ── Jitter is bounded over many cycles ────────────────────────────────────
  // Tests: (a) all 10 cycles fire, (b) total time is within expected bounds,
  // (c) jitter never causes more than ~2 fires per 2×interval window.

  it('jitter bounded: at least N ticks fire in N×MAX_DELAY ms, no tick is skipped', async () => {
    vi.useFakeTimers();

    const INTERVAL = 100;
    const JITTER = 30;
    const MAX_DELAY = INTERVAL + JITTER; // 130ms per tick at worst
    const MIN_DELAY = INTERVAL - JITTER; // 70ms per tick at best
    const N = 10;
    let cycleCount = 0;

    const handle = scheduleLoop(
      'jitter-bound',
      async () => { cycleCount++; },
      INTERVAL,
      { jitterMs: JITTER },
    );

    // Advance exactly N × MAX_DELAY: guarantees at least N ticks fired
    await vi.advanceTimersByTimeAsync(N * MAX_DELAY);
    handle.stop();

    // Property 1: at least N ticks fired — jitter never causes a miss
    expect(cycleCount).toBeGreaterThanOrEqual(N);

    // Property 2: at most ceil(N*MAX_DELAY / MIN_DELAY) — no spurious extra fires
    // 10 × 130 / 70 ≈ 18.6 → at most 18 ticks
    const maxPossible = Math.ceil((N * MAX_DELAY) / MIN_DELAY);
    expect(cycleCount).toBeLessThanOrEqual(maxPossible);
  });

  // ── Self-heal after exception: loop continues ─────────────────────────────
  // Chaos: fn throws on odd cycles. Even cycles must still run.

  it('chaos: fn throws every other tick — loop self-heals without missing ticks', async () => {
    vi.useFakeTimers();

    const results: Array<'ok' | 'error'> = [];
    let call = 0;

    const handle = scheduleLoop(
      'flaky-loop',
      async () => {
        call++;
        if (call % 2 === 1) throw new Error(`chaos error on call ${call}`);
        results.push('ok');
      },
      50,
      { onError: () => results.push('error') },
    );

    // 6 ticks = 3 errors + 3 successes
    await vi.advanceTimersByTimeAsync(300);
    handle.stop();

    expect(results.filter(r => r === 'error').length).toBe(3);
    expect(results.filter(r => r === 'ok').length).toBe(3);
  });
});
