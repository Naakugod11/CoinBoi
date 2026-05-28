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
