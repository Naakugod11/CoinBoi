// Recursive setTimeout scheduler. See spec §2.4.
// Properties: (a) cycles never overlap with themselves, (b) self-heals after
// exceptions, (c) jitter is per-loop. Exact implementation from spec §2.4.

export interface ScheduleLoopOpts {
  jitterMs?: number;
  onSkip?: (name: string, reason: string) => void;
  onError?: (name: string, err: unknown) => void;
  onCycleDone?: (name: string, elapsedMs: number) => void;
}

export interface LoopHandle {
  /** Cancel the next scheduled tick. Does not interrupt a running cycle. */
  stop(): void;
}

export function scheduleLoop(
  name: string,
  fn: () => Promise<void>,
  intervalMs: number,
  opts: ScheduleLoopOpts = {},
): LoopHandle {
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const onSkip = opts.onSkip ?? defaultSkip;
  const onError = opts.onError ?? defaultError;
  const onCycleDone = opts.onCycleDone ?? (() => { /* no-op */ });

  async function tick() {
    if (stopped) return;

    // §2.4: schedule next tick immediately — this way the interval is measured
    // from when THIS tick fires, not when fn() completes. Critically, it means
    // the next tick is scheduled even while fn() is still in flight, so the
    // running guard below can actually detect the overlap and log a skip.
    schedule();

    if (running) {
      onSkip(name, 'previous cycle still running');
      return;
    }

    running = true;
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      // §2.4: self-heal — log but never propagate; next tick still fires
      onError(name, err);
    } finally {
      running = false;
      const elapsed = Date.now() - started;
      onCycleDone(name, elapsed);
    }
  }

  function schedule() {
    if (stopped) return;
    const jitter = opts.jitterMs
      ? (Math.random() * 2 - 1) * opts.jitterMs
      : 0;
    timer = setTimeout(tick, Math.max(0, intervalMs + jitter));
  }

  schedule();

  return {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

// ── Defaults (replaced by real logger wired in Day 4) ─────────────────────────

function defaultSkip(name: string, reason: string): void {
  // eslint-disable-next-line no-console
  console.warn(`[scheduler] ${name}: skip — ${reason}`);
}

function defaultError(name: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.error(`[scheduler] ${name}: unhandled error —`, err);
}
