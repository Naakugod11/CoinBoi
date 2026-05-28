# Live Trading Agent — Build Spec (v3, final)

> An autonomous Solana spot trading agent. $30 starting capital on established memecoins, full observability, hard safety constraints enforced in code, public build-in-public. Designed to compound within tight bounds — and to feed Agent Bazaar's design with real operational data on how autonomous agents behave with real money.
>
> **Stance:** spot first (perps is a separate future build). Open-ended timeline. Hosted 24/7, fully observable, hard-stopped, *idempotent on every code path that touches the chain*.
>
> **Changes from v2:** cost-basis math made explicit and unambiguous; removed incoherent R/R rule; loosened vol and CEX gates that were emptying the universe; simplified process supervision; added manual halt command, SOL gas reserve check, partial-fill handling, dust tolerance, pause-semantics clarity; resolved timezone (all UTC); resolved universe-API partial-failure handling; clarified pause vs kill-switch interaction; documented quote-staleness handling; clarified EXIT-always-sells-wallet-balance to prevent dust accumulation.

---

## 0. Why this exists

Naaku is building Agent Bazaar — a Solana protocol for autonomous AI agent commerce. Operating a real autonomous agent with real capital is the fastest path to sharpening the protocol's design: stake sizing, slashing thresholds, reputation primitives, recursion guards all benefit from real operational data instead of theoretical reasoning.

The agent itself is built to perform. Quality of decisions, quality of execution, and quality of risk management are the design priorities — in that order of glamour, but in inverse order of how much they matter at $30. **Execution quality and risk management dominate at this size.** Decision quality matters at scale; at $30 you mostly need to not blow up from bugs, slippage, and front-running.

The build-in-public narrative compounds with results: a well-performing or well-failing-with-clean-postmortem agent is the strongest possible artifact for the Agent Bazaar story.

---

## 1. Constraints and rules (immutable, enforced in code)

| Constraint | Value | Why |
|---|---|---|
| Starting capital | 30 USDC + ~5 SOL ($5) for gas | Small enough that loss is data, not pain |
| Max per-position size | $5 USDC notional at entry | Forces diversification, bounds single-trade blast radius |
| Max concurrent positions | 3 | Keeps decision space manageable, leaves cash for opportunities |
| Per-position stop loss | −40% from total cost basis, confirmed over 2 consecutive ticks | Cost basis = total USDC spent acquiring current token balance. Two-tick confirmation prevents oracle-flicker stop-outs. Math defined in §2.7 |
| Per-trade execution cost budget | ≤ 1.5% one-way (fees + slippage) at quote time | Trades quoting above budget are skipped, not executed. Round-trip ceiling ~3% |
| Min expected move to OPEN | `expected_move_pct >= 5` AND named invalidation | Below 5% expected move, fee drag dominates. No formal R/R requirement — the −40% mechanical stop and the LLM's contextual exit logic operate on different time horizons |
| Portfolio soft pause threshold | −$8 from peak portfolio value | Stop opening new positions; existing positions held subject to stops |
| Portfolio hard stop threshold | −$13 from peak portfolio value | Triggers full liquidation. Targeted realized loss ~−$14 after exit slippage |
| Daily trade cap | 12 trades / rolling 24h | Single window. Circuit breaker against runaway loops |
| SOL gas reserve floor | 0.015 SOL (~$3) | Below this, agent auto-pauses. Refunding required to resume |
| Token universe | Liquidity + adversarial gates (see §3) | Filters rugs, illiquid traps, and obvious wash-traded bait |
| No perps | Spot only | Perps are a separate experiment with separate rules |
| Decision cadence | 3 min ± 30s jitter | Jitter reduces front-runnability of on-chain pattern |
| Safety cadence | 15 seconds | Memecoin candles move fast; LLM-free deterministic checks |
| Heartbeat | Naaku pings `/heartbeat` to TG bot every ≤12h | Missed heartbeat (>12h) → auto-pause new entries. Stops and kill switches remain active |
| Manual halt | Naaku's `/halt` on TG triggers immediate full liquidation | The "I just woke up at 3am" button |
| Timestamps | All UTC, ISO-8601 | No timezone confusion in logs or DB |

**Critical:** all safety rules are enforced in code paths that bypass the LLM. Claude can never reason its way past a kill switch. Belt and suspenders.

**Pause semantics (clarified):**

- **Soft pause** (`paused = true, reason = 'soft_drawdown' | 'heartbeat_missing' | 'trade_cap' | 'sol_low' | 'reconciler_mismatch'`): blocks new OPEN and ADD actions. Allows EXIT actions (agent can still reduce exposure). All per-position stops, hard stops, and manual halt remain active.
- **Hard stop / kill switch** (`kill_switch_triggered = true`): blocks all decision-loop actions. Safety loop continues to market-sell-all with retry until flat. Once flat, agent halts (PM2 does not restart).
- **Manual halt** (`/halt`): equivalent to hard stop. Triggers full liquidation, then halts.

---

## 2. Architecture

### 2.1 Tech stack

| Layer | Tech | Reason |
|---|---|---|
| Language | TypeScript (Node 20+) | Matches Solana ecosystem and future Bazaar agents |
| Runtime | Long-running Node process | 24/7 uptime |
| Process supervision | Docker `restart: unless-stopped` only | Single layer. PM2 + systemd was overkill |
| LLM (cycle decisions) | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) | Cheap, fast, sufficient for constrained decisions |
| LLM (daily review) | Claude Opus 4.7 (`claude-opus-4-7`) | Better reasoning for retrospective analysis |
| Anthropic SDK | `@anthropic-ai/sdk` | Standard |
| JSON validation | `zod` schemas on every LLM response | Malformed output → treat as HOLD_ALL, log error |
| Solana execution | Sol CLI tool (Solana Payments & Trading skill) → Jupiter Ultra v3 | Best-in-class spot routing + MEV protection |
| RPC provider | Helius (existing 0xpilot account), Frankfurt endpoint | Reliable, supports complex queries |
| Tx confirmation | Helius `getSignatureStatuses` poll, finalized commitment | Don't trust "sent" — only trust finalized |
| Market data | Dexscreener API (free) | Reuse 0xpilot knowledge |
| On-chain signals | Helius (holders, smart-money wallets, LP status) | Already paying for it |
| Social sentiment | LunarCrush free tier (Week 1); evaluate paid tier ($24/mo) for Week 2 | Cheapest reasonable source |
| Canonical price (stops) | Jupiter Quote API → Pyth fallback | Only price source that matters for "what would I get on sell" |
| Database | SQLite (`better-sqlite3`, synchronous, WAL mode) | Single-process atomicity for loop coordination |
| Concurrency | In-process `async-mutex` + SQLite WAL | Mutex around critical sections, WAL for crash safety |
| Alerts + control | Telegram bot (`node-telegram-bot-api`) | Reuse 0xpilot/Bazaar patterns; also receives `/heartbeat` and `/halt` |
| Dashboard | Express + plain HTML, served over Tailscale | 15-second refresh, simple |
| Container | Docker + docker-compose | Reproducible deploy, single restart policy |
| Hosting | Hetzner CX21 in Frankfurt (€5.83/mo, 4GB RAM, 2 vCPU) | Headroom for Node + tx polling; Frankfurt → Helius FRA |
| Access | Tailscale only; no public ports | Dashboard not on open internet |

### 2.2 Repo structure

```
trading-agent/
├── src/
│   ├── agent/
│   │   ├── scheduler.ts          # Recursive setTimeout + per-loop running guard
│   │   ├── decision-loop.ts      # 3min ± 30s: fetch state → ask Claude → act
│   │   ├── safety-loop.ts        # 15s: kill switches, stops, gas reserve, heartbeat
│   │   ├── reconciler.ts         # Startup + periodic on-chain ↔ DB diff
│   │   ├── heartbeat.ts          # Tracks user heartbeats and missed-heartbeat pause
│   │   ├── halt-handler.ts       # /halt command handler
│   │   ├── prompts.ts            # Claude prompt templates
│   │   ├── schemas.ts            # zod schemas for LLM output
│   │   └── review.ts             # Daily Opus retrospective
│   ├── execution/
│   │   ├── sol-cli.ts            # Wrapper around Sol CLI subprocess calls
│   │   ├── jupiter-quote.ts      # Pre-trade quote + slippage budget check
│   │   ├── tx-pipeline.ts        # intent → send → confirm → reconcile
│   │   ├── universe.ts           # Liquidity + adversarial filters
│   │   └── portfolio.ts          # Positions, P&L, cost-basis math
│   ├── signals/
│   │   ├── dexscreener.ts        # Price, volume, liquidity
│   │   ├── helius.ts             # On-chain (holders, smart money, LP)
│   │   ├── lunarcrush.ts         # Social sentiment
│   │   └── price-oracle.ts       # Canonical price source for stops + valuation
│   ├── observability/
│   │   ├── db.ts                 # SQLite schema + helpers (sync API)
│   │   ├── logger.ts             # Structured logging (UTC timestamps)
│   │   ├── telegram.ts           # Alert bot + receives /heartbeat and /halt
│   │   └── dashboard.ts          # Express server + HTML
│   ├── config.ts                 # Constants, env loading, version pinning
│   └── main.ts                   # Entry: reconcile → start loops
├── data/
│   ├── trading.db                # SQLite (gitignored)
│   └── trading.db-wal            # WAL file (gitignored)
├── logs/                         # Container logs via Docker, rotated (gitignored)
├── docker/
│   ├── Dockerfile                # Pinned base image, checksummed Sol CLI install
│   └── docker-compose.yml        # restart: unless-stopped
├── tests/
│   ├── safety.test.ts            # Kill switch tests (incl. concurrent triggers)
│   ├── universe.test.ts          # Filter tests + adversarial scenarios
│   ├── portfolio.test.ts         # Cost-basis math, P&L, ADD weighting
│   ├── tx-pipeline.test.ts       # Idempotency under crash injection
│   ├── reconciler.test.ts        # Mismatch detection, dust handling
│   └── scheduler.test.ts         # No overlap under slow cycles
├── scripts/
│   ├── setup-wallet.ts           # Generate fresh wallet
│   ├── fund-check.ts             # Verify wallet balance + SOL reserve
│   ├── reconcile.ts              # Manual reconciliation tool
│   ├── halt.ts                   # Local kill switch (in case Telegram down)
│   └── paper-trade.ts            # Simulate without execution
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

### 2.3 Two-loop architecture with proper coordination

The agent runs **two cooperating loops** sharing state through SQLite (WAL mode) and a single in-process mutex:

**Decision loop (3 min ± 30s jitter)** — calls Claude Haiku, makes trading decisions, executes via the tx pipeline.

**Safety loop (15 seconds)** — pure code, no LLM. Checks portfolio P&L vs peak, per-position stops (with 2-tick confirmation), daily trade count, gas reserve, heartbeat freshness. If any threshold trips, takes the mutex and acts immediately.

Why separated: kill switches need to fire in seconds, not minutes. They cannot wait for the next decision cycle. They also cannot depend on an LLM (slow, fallible, reason-around-able).

**Why a mutex (the v1 race condition fix):** both loops can want to send a transaction at the same instant. The decision loop is mid-ADD on BONK; the safety loop sees BONK at −41% (confirmed two ticks) and wants to stop-out. Without coordination, you buy a token that's simultaneously being dumped. The mutex serializes trade-issuing critical sections only — reads remain concurrent.

```
┌──────────────────────────────────────────────────────────────┐
│         SQLite WAL (shared state, sync writes)               │
│ positions · decisions · intents · trades · portfolio_peak ·  │
│ flags · heartbeats · position_ticks · errors                 │
└──────────────────────────────────────────────────────────────┘
         ▲                                       ▲
         │            ┌─────────────┐            │
         │            │  TradeMutex │            │
         │            │ (in-proc)   │            │
         │            └─────────────┘            │
         │                  ▲ ▲                  │
┌────────┴─────────┐        │ │       ┌─────────┴──────────┐
│  Decision Loop   │────────┘ └───────│   Safety Loop      │
│  (3 min ± 30s)   │                  │   (15 sec)         │
│                  │                  │                    │
│ 1. fetch state   │                  │ 1. read positions  │
│ 2. check pause/  │                  │ 2. canonical price │
│    cap/heartbeat │                  │ 3. record tick     │
│ 3. build universe│                  │ 4. 2-tick stop chk │
│ 4. fetch signals │                  │ 5. peak/drawdown   │
│ 5. ask Claude    │                  │ 6. trade cap chk   │
│ 6. validate JSON │                  │ 7. SOL reserve chk │
│ 7. quote+budget  │                  │ 8. heartbeat chk   │
│ 8. ACQUIRE MUTEX │                  │ 9. ACQUIRE MUTEX   │
│ 9. recheck gates │                  │ 10. fire kills     │
│ 10. tx pipeline  │                  │ 11. release        │
│ 11. release      │                  │                    │
└──────────────────┘                  └────────────────────┘
         ▲                                       ▲
         └────────── Reconciler (5 min) ─────────┘
                    On-chain wallet ↔ DB diff
                    Mismatch → pause + alert

         /halt and /heartbeat received via Telegram → halt-handler.ts
         /halt acquires mutex and triggers market_sell_all_with_retry
```

### 2.4 Scheduler

```typescript
// scheduler.ts
export function scheduleLoop(
  name: string,
  fn: () => Promise<void>,
  intervalMs: number,
  opts: { jitterMs?: number } = {}
) {
  let running = false;

  async function tick() {
    if (running) {
      await logSkip(name, 'previous cycle still running');
      schedule();
      return;
    }
    running = true;
    const started = Date.now();
    try {
      await fn();
    } catch (err) {
      await logError(name, err);
    } finally {
      running = false;
      const elapsed = Date.now() - started;
      await logCycleDuration(name, elapsed);
      schedule();
    }
  }

  function schedule() {
    const jitter = opts.jitterMs
      ? (Math.random() * 2 - 1) * opts.jitterMs
      : 0;
    setTimeout(tick, Math.max(0, intervalMs + jitter));
  }

  schedule();
}
```

Properties: (a) cycles never overlap with themselves, (b) self-heals after exceptions, (c) jitter is built-in per loop.

### 2.5 Decision loop

```typescript
async function decisionCycle() {
  // --- read-only phase, no mutex ---
  if (isKillSwitchTriggered()) return logSkip('kill switch triggered');
  if (isPaused()) {
    // Pause blocks OPEN/ADD but allows EXIT. Continue to decision but constrain action set.
  }
  if (await dailyTradeCapHit()) return logSkip('trade cap');
  if (heartbeatStale()) return logSkip('heartbeat stale');
  if (await solBalanceBelowReserve()) return logSkip('SOL reserve low');

  const portfolio = loadPortfolio();
  const universe = await buildLiquidityFilteredUniverse();
  if (universe.length === 0 && portfolio.positions.length === 0) {
    return logSkip('universe empty (fail-closed) and no positions to manage');
  }

  const signals = await Promise.all([
    fetchPriceData(universe),
    fetchOnChainSignals(universe),
    fetchSentiment(universe),
  ]);

  const allowedActions = isPaused() 
    ? ['HOLD_ALL', 'EXIT'] 
    : ['HOLD_ALL', 'EXIT', 'OPEN', 'ADD'];

  const raw = await askClaude({
    portfolio, universe, signals, allowedActions,
    recentDecisions: getLastNDecisionsWithOutcomes(5),
    currentUtcTime: new Date().toISOString(),
  });

  // Validate JSON strictly. Malformed → HOLD_ALL.
  const decision = DecisionSchema.safeParse(raw);
  if (!decision.success) {
    await logBadResponse(raw, decision.error);
    return;
  }
  logDecision(decision.data);

  if (decision.data.action === 'HOLD_ALL') return;

  // Verify action is allowed under current pause state
  if (!allowedActions.includes(decision.data.action)) {
    return logSkip(`action ${decision.data.action} not allowed (paused)`);
  }

  // EXIT requires token; we sell full wallet balance, not the recorded size
  // (prevents dust accumulation if previous trade had higher slippage)
  if (decision.data.action === 'EXIT') {
    const wallet = await getWalletBalance(decision.data.token);
    if (wallet.amount === 0) {
      return logError('EXIT on token with zero balance', decision.data);
    }
    decision.data.size_tokens = wallet.amount; // sell ALL
  }

  // OPEN requires no existing position on that token
  if (decision.data.action === 'OPEN') {
    if (portfolio.positions.find(p => p.token === decision.data.token)) {
      return logError('OPEN on token with existing position; agent should have used ADD', decision.data);
    }
    if (portfolio.positions.length >= 3) {
      return logSkip('max positions');
    }
  }

  // ADD requires existing position on that token
  if (decision.data.action === 'ADD') {
    if (!portfolio.positions.find(p => p.token === decision.data.token)) {
      return logError('ADD on token without existing position; agent should have used OPEN', decision.data);
    }
  }

  // Verify token is in current universe (defense-in-depth) — only for OPEN/ADD
  // (EXIT must always be allowed regardless of universe membership)
  if ((decision.data.action === 'OPEN' || decision.data.action === 'ADD') &&
      !universe.find(t => t.symbol === decision.data.token)) {
    return logError('token not in universe for entry', decision.data);
  }

  // Pre-trade quote: enforce slippage+fee budget BEFORE locking
  const quote = await jupiterQuote(decision.data);
  if (quote.totalCostPct > 0.015) {
    return logSkip(`quote cost ${quote.totalCostPct} > 1.5%`);
  }

  // --- write phase: take the mutex ---
  await tradeMutex.runExclusive(async () => {
    // Re-check ALL gates INSIDE the mutex — safety loop may have flipped any of them
    if (isKillSwitchTriggered()) return logSkip('kill switch (recheck)');
    if (await dailyTradeCapHit()) return logSkip('trade cap (recheck)');
    if (await solBalanceBelowReserve()) return logSkip('SOL reserve (recheck)');
    
    if (decision.data.action === 'OPEN') {
      if (isPaused()) return logSkip('paused (recheck, OPEN blocked)');
      if (loadPortfolio().positions.length >= 3) return logSkip('max positions (recheck)');
      if (!await universeStillContains(decision.data.token)) {
        return logSkip('token left universe between decision and execution');
      }
    }
    if (decision.data.action === 'ADD') {
      if (isPaused()) return logSkip('paused (recheck, ADD blocked)');
      if (!await universeStillContains(decision.data.token)) {
        return logSkip('token left universe between decision and execution');
      }
    }

    await txPipeline.execute(decision.data, quote);
  });

  updatePortfolioState();
}
```

Critical properties: (1) the pause/cap/position checks are repeated inside the mutex right before execution — v1 TOCTOU window is closed; (2) the quote is fetched and budget-checked before mutex is taken so we don't hold the lock during a slow Jupiter RPC; (3) JSON output is validated via zod; (4) universe membership is re-verified at execution time; (5) EXIT always sells the wallet balance (dust-safe); (6) action-state consistency is enforced (no OPEN on existing, no ADD on missing).

### 2.6 Safety loop

```typescript
async function safetyCycle() {
  // Continues even if paused — pause does not disable safety
  const portfolio = await loadPortfolioWithCurrentValuation();
  const peak = upsertAndGetPeak(portfolio.totalValue);  // atomic
  const ddFromPeak = peak - portfolio.totalValue;

  // Per-position stops — TWO-TICK confirmation
  for (const position of portfolio.positions) {
    const price = await canonicalPrice(position.token);
    if (price === null) {
      logError('price unavailable for position', position.token);
      continue; // skip this position this cycle, do not stop on missing data
    }
    const currentValue = position.sizeTokens * price;
    const lossPct = (currentValue - position.costBasisTotalUsdc) / position.costBasisTotalUsdc;
    recordTick(position.id, price, lossPct);
    
    const lastTwo = lastNTicks(position.id, 2);
    const bothBelow = lastTwo.length === 2
                      && lastTwo.every(t => t.lossPct <= -0.40);
    if (bothBelow) {
      await tradeMutex.runExclusive(async () => {
        await txPipeline.marketSellWithRetry(position);
      });
      await alert(`STOP HIT: ${position.token} sold (2-tick confirm) at ${(lossPct*100).toFixed(1)}% loss`);
    }
  }

  // Soft pause from drawdown
  if (ddFromPeak >= 8 && getPauseReason() !== 'soft_drawdown') {
    setPaused(true, 'soft_drawdown');
    await alert(`SOFT PAUSE: -$${ddFromPeak.toFixed(2)} from peak. New entries blocked, exits allowed.`);
  }

  // Hard stop — TIGHTENED to -$13 to leave room for exit slippage
  if (ddFromPeak >= 13 && !isKillSwitchTriggered()) {
    setKillSwitchTriggered('hard_stop_drawdown');
    setPaused(true, 'hard_stop');
    await tradeMutex.runExclusive(async () => {
      await txPipeline.marketSellAllWithRetry();  // retries until flat
    });
    await alert(`HARD STOP: -$${ddFromPeak.toFixed(2)} from peak. All positions liquidating.`);
  }

  // Trade cap — rolling 24h only
  const rolling = countTradesInWindow(24 * 3600);
  if (rolling >= 12 && getPauseReason() !== 'trade_cap') {
    setPaused(true, 'trade_cap');
    await alert(`TRADE CAP: ${rolling}/12 in rolling 24h. Paused.`);
  } else if (rolling < 12 && getPauseReason() === 'trade_cap') {
    setPaused(false, null);  // auto-resume when below cap
    await alert(`Trade cap cleared. Resuming.`);
  }

  // SOL gas reserve check
  const solBalance = await getSolBalance();
  if (solBalance < 0.015 && getPauseReason() !== 'sol_low') {
    setPaused(true, 'sol_low');
    await alert(`SOL LOW: ${solBalance.toFixed(4)} SOL (<0.015). Refund required.`);
  }

  // Heartbeat watchdog
  if (heartbeatAgeHours() > 12 && getPauseReason() !== 'heartbeat_missing') {
    setPaused(true, 'heartbeat_missing');
    await alert('HEARTBEAT MISSED >12h. New entries paused. Stops + manual halt still active.');
  } else if (heartbeatAgeHours() < 12 && getPauseReason() === 'heartbeat_missing') {
    setPaused(false, null);
    await alert('Heartbeat received. Resuming.');
  }
}
```

### 2.7 Position math (cost basis, P&L, stops)

Storage:
- `position.size_tokens`: total tokens currently held in this position (real number, not lamports)
- `position.cost_basis_total_usdc`: total USDC spent acquiring `size_tokens` (sum of all buy notionals including realized fees)

OPEN math (creating new position):
```
position.size_tokens = amount_received_from_swap_onchain
position.cost_basis_total_usdc = usdc_spent_onchain (= quote.in_amount + sol_fee_usdc_equivalent)
```

ADD math (adding to existing position):
```
position.size_tokens += amount_received_from_swap_onchain
position.cost_basis_total_usdc += usdc_spent_onchain
```

EXIT math (selling full position):
```
sale_proceeds_usdc = amount_received_from_swap_onchain (net of fees)
pnl_usdc = sale_proceeds_usdc - position.cost_basis_total_usdc
position.status = 'CLOSED', position.closed_at = now
```

Stop loss check (in safety loop):
```
current_value_usdc = position.size_tokens * canonical_price(token)
loss_pct = (current_value_usdc - position.cost_basis_total_usdc) / position.cost_basis_total_usdc
if loss_pct <= -0.40 for 2 consecutive ticks: trigger stop
```

Portfolio total value (for peak / drawdown):
```
portfolio_value_usdc = wallet_usdc_balance 
                     + sum(position.size_tokens * canonical_price(token) for each open position)
SOL balance is NOT counted in portfolio value — it's a gas reserve, valued separately.
```

These definitions are normative. Any test that disagrees with these is wrong, not the definitions.

### 2.8 Transaction pipeline (idempotency)

Every state-changing chain call goes through the same pipeline:

```typescript
// tx-pipeline.ts
export async function execute(decision: Decision, quote: Quote) {
  // 1. Write intent BEFORE sending — survives crash
  const intentId = db.insertIntent({
    decisionId: decision.id,
    token: decision.token,
    side: decision.action === 'EXIT' ? 'SELL' : 'BUY',
    sizeUsdc: decision.size_usdc,
    sizeTokens: decision.size_tokens ?? null,  // set for EXIT (full wallet balance)
    quoteSnapshot: JSON.stringify(quote),
    status: 'PENDING',
    createdAt: nowUtc(),
  });

  let sig: string;
  try {
    sig = await solCli.swap(quote);  // returns tx signature
    db.updateIntent(intentId, { txSignature: sig, status: 'SENT' });
  } catch (err) {
    db.updateIntent(intentId, { status: 'SEND_FAILED', error: String(err) });
    throw err;  // Caller decides whether to alert
  }

  // 2. Poll for finalized confirmation
  const result = await helius.pollUntilFinalized(sig, { timeoutMs: 90_000 });
  if (result.status === 'FINALIZED') {
    // Parse on-chain transaction to get actual amounts (may differ from quote)
    const parsed = await helius.parseSwap(sig);
    db.updateIntent(intentId, { 
      status: 'CONFIRMED', 
      resolvedAt: nowUtc() 
    });
    db.insertTrade({
      intentId,
      decisionId: decision.id,
      timestamp: nowUtc(),
      token: decision.token,
      side: decision.action === 'EXIT' ? 'SELL' : 'BUY',
      sizeUsdc: parsed.usdcAmount,
      sizeTokens: parsed.tokenAmount,
      price: parsed.usdcAmount / parsed.tokenAmount,
      txSignature: sig,
      slippagePct: (quote.expectedOutput - parsed.actualOutput) / quote.expectedOutput,
      feeUsdc: parsed.feeUsdc,
    });
    applyTradeToPosition(parsed, decision);  // updates positions table per §2.7
    incrementTradeCounter();
  } else if (result.status === 'FAILED') {
    db.updateIntent(intentId, { status: 'CHAIN_FAILED', resolvedAt: nowUtc() });
    await alert(`Trade FAILED on chain: ${sig}`);
  } else {
    // Timeout — DO NOT retry. Reconciler will resolve.
    db.updateIntent(intentId, { status: 'UNKNOWN_TIMEOUT' });
    await alert(`Trade UNKNOWN after 90s: ${sig}. Reconciler will resolve next cycle.`);
  }
}
```

**Never retry a trade without reconciling first.** A timeout doesn't mean the tx didn't land — it means we don't know yet. Retrying blindly double-buys.

**Quote staleness:** there is a 100-500ms window between quote fetch and tx submission. For $5 trades on memecoins, this is acceptable (worst case is paying ~0.5% more than quoted, absorbed by the 1.5% budget). Jupiter's `slippageBps` parameter is set to 150 (1.5%) on every swap as a hard cap — if execution exceeds that, the swap reverts. Documented as a known tradeoff, not a bug.

### 2.9 Atomic peak tracking

```sql
-- single-row table; updated atomically every safety cycle
UPDATE portfolio_peak
SET peak_value = MAX(peak_value, ?),
    updated_at = ?
WHERE id = 1;
```

Initial seed at first boot: `peak_value = 30` (USDC starting capital; SOL not counted). The decision loop only *reads* peak — never writes.

### 2.10 Reconciler

Runs blocking at startup (agent does not start trading until clean) and every 5 minutes thereafter:

1. Read wallet balances on-chain: USDC + SOL + every SPL token with balance above dust threshold ($0.50 USDC equivalent).
2. Read open positions and pending intents from DB.
3. **Resolve pending intents:** for each intent in PENDING / SENT / UNKNOWN_TIMEOUT status, query the tx signature against Helius. If finalized, apply the trade (per §2.8 happy path). If failed, mark CHAIN_FAILED. If still unknown after 10 minutes from intent creation, mark `STUCK` and alert.
4. **Diff positions:** for every open position, does `position.size_tokens` match the wallet balance for that token within dust tolerance (±$0.50 USDC equivalent)?
5. **Diff wallet tokens vs DB:** is every non-dust token in the wallet represented as an open position?
6. Any unresolved mismatch → `setPaused(true, 'reconciler_mismatch')`, alert, halt new trades until manual `scripts/reconcile.ts` is run.

**Dust handling:** tokens with wallet balance worth < $0.50 USDC at canonical price are ignored. Solana wallets accumulate small amounts from swaps; treating these as positions creates noise.

**This is the single most important safety mechanism after the hard stop.** Without it, one crash between "tx sent" and "tx confirmed" silently corrupts every subsequent decision.

### 2.11 Manual halt (`/halt` Telegram command)

```typescript
// halt-handler.ts
bot.on('/halt', async (msg) => {
  if (msg.from.id !== NAAKU_TELEGRAM_USER_ID) return;  // only Naaku
  
  setKillSwitchTriggered('manual_halt');
  setPaused(true, 'manual_halt');
  await tradeMutex.runExclusive(async () => {
    await txPipeline.marketSellAllWithRetry();
  });
  await alert('MANUAL HALT executed. All positions liquidated. Agent halted.');
});
```

Equivalent escape hatch from the host via `scripts/halt.ts` in case Telegram is unreachable.

---

## 3. Token universe

The agent does NOT receive a hand-picked list. Every decision cycle, code rebuilds the universe from on-chain queries. Tokens must pass all gates.

### 3.1 Liquidity gates

| Gate | Threshold | Source |
|---|---|---|
| Market cap | ≥ $50M | Dexscreener |
| 24h volume | ≥ $5M | Dexscreener |
| Token age | ≥ 30 days since launch | On-chain via Helius |
| Jupiter listing | Listed on Jupiter aggregator | Jupiter API |
| LP status | Locked or burned ≥ 90 days | Dexscreener flag, verified on-chain |
| Manual blocklist | Not in `KNOWN_RUGS` list | Hard-coded |

### 3.2 Adversarial gates

Volume and holder concentration are gameable. These gates raise the cost of attack above the value of attacking a $30 agent:

| Gate | Threshold | Why |
|---|---|---|
| Top-10 holder concentration | ≤ 40% of circulating supply | Filters whale-controlled tokens |
| Unique active traders (24h) | ≥ 500 | Wash trading needs counterparty diversity; harder to fake |
| 7-day realized volatility | ≤ 600% annualized | Filters tokens in obvious blow-off-top phase. Note: typical Solana memecoin baseline is 300-500% annualized — this gate filters extreme outliers only |

Removed from v2:
- ~~CEX listing requirement~~ — would reduce universe to 3-4 tokens; most quality Solana memes aren't on Tier-1 CEXes
- ~~Top-20 concentration~~ — redundant with top-10
- ~~Wallet-to-volume ratio~~ — redundant with 500-unique-traders gate
- ~~200% annualized vol cap~~ — would filter every memecoin

Universe size is expected to be 5-20 tokens on most days.

### 3.3 Partial signal API failure handling

If a single token's data fetch fails (e.g. Dexscreener returns 500 for one token), that token is excluded from the universe for this cycle, error logged. The universe build continues with remaining tokens.

If ALL signal sources fail for ALL candidate tokens (broad outage), universe = ∅. Decision loop returns HOLD_ALL. No trades on stale data.

### 3.4 Canonical price source

All stop-loss evaluations AND portfolio valuations use one price source, with explicit fallback:

1. **Primary:** Jupiter Quote API, route `TOKEN → USDC`, amount = position's `size_tokens`. This is the price you'd actually get if you sold right now.
2. **Fallback (Jupiter down):** Pyth pull via Helius. If diverges from last successful Jupiter quote by >5%, treat as suspicious — log and return `null` (skip this tick; do not stop on stale data).
3. **Never use Dexscreener for stop evaluation.** It's fine for the LLM's market summary (aggregated mid-price), but lags during fast moves.

Universe is recomputed every decision cycle (3 min). Cached between cycles. On any catastrophic signal API failure (all sources down), fail closed: universe = ∅, decision loop returns HOLD_ALL.

---

## 4. Claude prompts

### 4.1 Decision prompt (Haiku, every 3 min ± 30s)

```
You are an autonomous spot trading agent on Solana managing ~$30 USDC,
trading established memecoins. Your job is to compound capital through
disciplined entries, well-sized positions, and decisive exits.

HARD RULES (enforced in code; you cannot violate them):
- Max position size: $5 USDC notional at entry
- Max concurrent positions: 3
- Per-position stop loss: -40% from cost basis (auto-triggered, 2-tick confirm)
- Spot only, no perps
- Universe is filtered; you can only OPEN/ADD on listed tokens
- EXIT is allowed on any position regardless of universe membership
- Round-trip cost ~3% (1.5% one-way fees + slippage)

ALLOWED ACTIONS THIS CYCLE: {allowed_actions}
(If "EXIT" only, the portfolio is in soft-pause state: no new entries.)

WHAT THIS MEANS:
You need expected upside of at least 5% to justify a trade — below that,
fees and slippage eat the edge. Required for OPEN/ADD: specific edge,
named catalyst, defined invalidation, expected_move_pct >= 5.

The -40% mechanical stop is a backstop, not a target. Your contextual
exit (EXIT action) should fire well before then if the thesis breaks.

CURRENT UTC TIME: {current_utc_time}
(Memecoin volume peaks during US trading hours 14:00-22:00 UTC.)

CURRENT PORTFOLIO:
{portfolio_json}
(Each position: token, size_tokens, cost_basis_total_usdc, current_price,
unrealized_pnl_usdc, time_held_minutes.)

CURRENT UNIVERSE (passed liquidity + adversarial gates):
{universe_json}

MARKET SIGNALS:
{signals_json}

YOUR LAST 5 DECISIONS AND THEIR OUTCOMES:
{recent_decisions_with_pnl}
(Including currently-open positions shown as "still open, current P&L X%".)

Decide what to do RIGHT NOW. Output strict JSON only — no preamble,
no markdown, no commentary outside the JSON:
{
  "action": "HOLD_ALL" | "EXIT" | "OPEN" | "ADD",
  "token": "<symbol if action != HOLD_ALL>",
  "size_usdc": <number if action == OPEN | ADD; ignored if EXIT (full balance sold)>,
  "thesis": "<one sentence: the specific edge, the catalyst, why now>",
  "invalidation": "<one sentence: a TESTABLE condition that would prove this wrong>",
  "expected_move_pct": <number: realistic upside if right>,
  "confidence": <1-10>
}

An OPEN/ADD requires: specific edge, named catalyst, testable invalidation,
expected_move_pct >= 5. Anything short of that is HOLD_ALL. EXIT requires
a specific reason (thesis invalidated, take profit, structural change).
HOLD_ALL is not failure — it's the correct answer most of the time.
```

Cost estimate: ~800 input + ~150 output tokens. ~$0.003 per call. ~6,720 calls over 2 weeks = $15-22.

### 4.2 Daily review prompt (Opus, once per day, 22:00 UTC)

Scheduled to run at 22:00 UTC, but checks for the decision loop's lock first — if a decision cycle is in flight, waits up to 60s before proceeding.

```
You are reviewing 24h of autonomous trading decisions to find performance
improvements. The agent manages real capital. Goal: compound under a strict
cost structure (~3% round-trip).

YESTERDAY'S DECISIONS (with full prompts and responses):
{full_decision_log}

YESTERDAY'S TRADES (with on-chain confirmations and slippage):
{trades_with_pnl}

PORTFOLIO STATE:
- Starting value: ${start} USDC
- Current value: ${current} USDC
- Peak value: ${peak} USDC
- Drawdown from peak: ${dd}
- Trades executed: {n} / 12 cap
- Open positions: {n} / 3 max

EXECUTION QUALITY:
- Avg slippage per trade: {avg_slip}%
- Trades skipped due to slippage budget: {skipped_slip}
- Quote-to-execution price delta: {quote_delta}%
- Failed/unknown transactions: {failed}
- Reconciler mismatches: {mismatches}

Analyze:
1. EDGE: which decisions produced edge net of fees? Which destroyed value?
   Distinguish "bad decisions" from "good decisions with bad execution".
2. INVALIDATION QUALITY: were yesterday's stated invalidations actually
   testable against the data? Flag fuzzy invalidations like "if sentiment
   turns negative" without specifics.
3. MISSED SETUPS: were there universe tokens with clear catalysts the
   agent ignored? What signal would have caught them?
4. SIZING: were positions sized appropriately for stated confidence?
5. OVER/UNDER-TRADING: is the agent firing on weak setups or freezing
   on clear ones?
6. CONFIDENCE CALIBRATION: do high-confidence trades actually outperform
   low-confidence ones?
7. UNIVERSE QUALITY: did the filter let in any token that turned out to
   be a trap or pump-in-progress?
8. PROMPT CHANGES: if you would change exactly one line of the prompt
   to improve next-day performance, what line and what change?

Output a structured retrospective (markdown, ~600 words). Logged for
Naaku review; NOT auto-applied.
```

Cost: ~$0.50-1.00 per review. ~$10-15 over 2 weeks.

**Total expected LLM spend: $25-40 over 2 weeks.**

---

## 5. Observability

### 5.1 SQLite schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  timestamp_utc TEXT NOT NULL,
  action TEXT NOT NULL,                 -- HOLD_ALL | EXIT | OPEN | ADD
  token TEXT,
  size_usdc REAL,
  thesis TEXT,
  invalidation TEXT,
  expected_move_pct REAL,
  confidence INTEGER,
  prompt_snapshot TEXT,
  response_raw TEXT,
  validated BOOLEAN NOT NULL,
  executed BOOLEAN NOT NULL,
  skip_reason TEXT
);

CREATE TABLE intents (
  id INTEGER PRIMARY KEY,
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  token TEXT NOT NULL,
  side TEXT NOT NULL,                   -- BUY | SELL
  size_usdc REAL,                       -- nullable for SELL (use size_tokens)
  size_tokens REAL,                     -- nullable for BUY (use size_usdc)
  quote_snapshot TEXT NOT NULL,
  tx_signature TEXT,
  status TEXT NOT NULL,                 -- PENDING|SENT|CONFIRMED|CHAIN_FAILED|SEND_FAILED|UNKNOWN_TIMEOUT|STUCK
  error TEXT,
  created_at_utc TEXT NOT NULL,
  resolved_at_utc TEXT
);

CREATE TABLE trades (
  id INTEGER PRIMARY KEY,
  intent_id INTEGER NOT NULL REFERENCES intents(id),
  decision_id INTEGER NOT NULL REFERENCES decisions(id),
  timestamp_utc TEXT NOT NULL,
  token TEXT NOT NULL,
  side TEXT NOT NULL,
  size_usdc REAL NOT NULL,              -- from on-chain parse, not quote
  size_tokens REAL NOT NULL,
  price REAL NOT NULL,                  -- size_usdc / size_tokens
  tx_signature TEXT NOT NULL UNIQUE,
  slippage_pct REAL,
  fee_usdc REAL
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL,
  opened_at_utc TEXT NOT NULL,
  closed_at_utc TEXT,
  cost_basis_total_usdc REAL NOT NULL,  -- total USDC spent acquiring current size_tokens
  size_tokens REAL NOT NULL,
  exit_proceeds_usdc REAL,
  pnl_usdc REAL,
  status TEXT NOT NULL                  -- OPEN | CLOSED
);

CREATE TABLE position_ticks (
  position_id INTEGER NOT NULL REFERENCES positions(id),
  timestamp_utc TEXT NOT NULL,
  price REAL NOT NULL,
  loss_pct REAL NOT NULL,
  PRIMARY KEY (position_id, timestamp_utc)
);

CREATE TABLE portfolio_peak (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  peak_value_usdc REAL NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE portfolio_snapshots (
  timestamp_utc TEXT PRIMARY KEY,
  total_value_usdc REAL NOT NULL,
  cash_usdc REAL NOT NULL,
  positions_value_usdc REAL NOT NULL,
  sol_balance REAL NOT NULL,
  peak_value_usdc REAL NOT NULL,
  drawdown_from_peak_usdc REAL NOT NULL
);

CREATE TABLE heartbeats (
  id INTEGER PRIMARY KEY,
  received_at_utc TEXT NOT NULL,
  source TEXT NOT NULL                  -- 'telegram_user'
);

CREATE TABLE errors (
  id INTEGER PRIMARY KEY,
  timestamp_utc TEXT NOT NULL,
  context TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack TEXT
);

CREATE TABLE flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  reason TEXT,
  updated_at_utc TEXT NOT NULL
);
-- flags include:
--   paused (true/false)
--   pause_reason ('soft_drawdown' | 'trade_cap' | 'sol_low' | 'heartbeat_missing' | 'reconciler_mismatch' | 'manual_halt' | 'hard_stop')
--   kill_switch_triggered (true/false)
--   kill_switch_reason
--   reconciler_status ('ok' | 'mismatch' | 'running')
--   last_reconciler_run_utc

CREATE INDEX idx_decisions_timestamp ON decisions(timestamp_utc);
CREATE INDEX idx_trades_timestamp ON trades(timestamp_utc);
CREATE INDEX idx_intents_status ON intents(status);
CREATE INDEX idx_position_ticks_lookup ON position_ticks(position_id, timestamp_utc DESC);
```

### 5.2 Telegram alerts

Alert priority levels:

**Critical** (sound + persistent notification):
- Reconciler mismatch
- Hard stop / manual halt fired
- `UNKNOWN_TIMEOUT` or `STUCK` intent
- Send failure on tx

**High** (sound):
- Soft pause triggered (with reason)
- SOL reserve low
- Heartbeat missing (10h warning, 12h pause)

**Normal** (silent):
- Trade confirmed on-chain
- Trade skipped due to slippage budget
- P&L milestones ($3 increments)
- Daily summary at 22:00 UTC

**Bot also receives:**
- `/heartbeat` from Naaku resets heartbeat clock
- `/halt` triggers manual liquidation (only from Naaku's verified TG user ID)
- `/status` returns current portfolio + pause state (read-only)
- `/positions` returns current open positions (read-only)

### 5.3 Dashboard

Express server on `localhost:3000`, accessed via Tailscale. Refreshes every 15s.

Shows:
- **Portfolio:** current value, peak, drawdown, distance to soft pause / hard stop, SOL balance
- **Open positions:** token, cost basis, current price, P&L, P&L%, time held, last 2 ticks (for stop monitoring)
- **Last 10 decisions:** UTC timestamp, action, thesis, invalidation, confidence, expected vs realized move if closed
- **Last 5 trades:** with slippage and fees
- **Pending intents:** anything not in CONFIRMED status
- **Reconciler:** last run time, status
- **Heartbeat:** last received, countdown to auto-pause
- **Pause status:** boolean + reason
- **Last 5 errors**

---

## 6. Hosting and deploy

### 6.1 Server

- Provider: Hetzner Cloud
- Plan: CX21 (€5.83/mo, 4GB RAM, 2 vCPU, 40GB SSD)
- Location: Frankfurt (Helius FRA endpoint)
- OS: Ubuntu 24.04 LTS
- Hardening:
  - SSH key only, root login disabled
  - UFW (allow 22 from Tailscale CIDR only)
  - fail2ban
  - Unattended security upgrades
- Access: Tailscale only; no public ports

### 6.2 Deploy

- Docker Compose: single `agent` service (dashboard runs inside the same process on localhost:3000, exposed only via Tailscale)
- Docker restart policy: `unless-stopped` (sufficient; no need for PM2 inside container)
- Pinned base image SHA, pinned npm lockfile, **pinned Sol CLI version with checksum verification on container build**
- Environment via `.env` (gitignored); secrets never in image
- Backup: cron rsyncs SQLite + WAL to a second Hetzner location nightly
- Deploy gate: CI must pass `tests/` including chaos tests before image is tagged for deploy

### 6.3 Wallet

- Fresh keypair generated for this experiment only
- Private key in `.env` on VPS, never committed, never shared
- Funded with 30 USDC + 5 SOL via personal wallet
- Wallet address shared publicly (for dashboard)
- **Front-running mitigation:** $5 max position size is intentionally below the threshold worth front-running given Solana priority-fee economics. Combined with 3-min ± 30s jitter, the on-chain pattern is not cheaply exploitable.

---

## 7. Build sequence (7-9 days)

### Day 0 — Rules and infrastructure
- Lock all rules from §1 (this doc is the lock)
- Spin up Hetzner CX21, harden, install Docker, Tailscale
- Create GitHub repo, set up TypeScript scaffold
- Generate fresh wallet, fund with test amounts only (not $30 yet)
- Set up Telegram bot, verify Naaku's user ID for `/halt` auth

### Day 1 — Execution layer + tx pipeline
- Install Sol CLI (pin version, verify checksum), verify swap on Jupiter
- Build `sol-cli.ts` wrapper
- Build `tx-pipeline.ts` with intent → send → confirm flow
- Build `helius.parseSwap()` to extract actual on-chain amounts
- Test: $1 swap USDC → BONK → USDC; verify intent + trade rows match on-chain reality

### Day 2 — Universe + signals + portfolio + cost basis
- Build liquidity + adversarial filters with partial-failure tolerance
- Build canonical price oracle (`price-oracle.ts`)
- Build signal fetchers (Dexscreener, Helius, free LunarCrush)
- Build portfolio tracker with cost-basis math (§2.7)
- Tests: cost basis under ADD, dust handling, portfolio valuation includes SOL-as-gas-reserve correctly (excluded from peak/drawdown)

### Day 3 — Scheduler + loops + reconciler + halt
- Build mutex-aware scheduler (`scheduler.ts`)
- Build decision loop with Claude Haiku + zod validation + allowed_actions
- Build safety loop with 2-tick stop confirmation + all kill switches
- Build reconciler (startup blocking + 5-min interval)
- Build `/halt` and `/heartbeat` handlers
- Test: paper-trade mode (simulated execution, real decisions)

### Day 4 — Observability
- SQLite schema + helpers (WAL mode, sync API)
- Telegram bot wired to alerts + receiving commands
- Express dashboard with live data
- Verify all timestamps are UTC ISO-8601

### Day 5 — Chaos tests
- `scheduler.test.ts`: inject 4-min cycle into 3-min schedule, verify no overlap
- `tx-pipeline.test.ts`: kill process between `intent SENT` and confirmation, restart, verify reconciler resolves correctly  
- `safety.test.ts`: simulate concurrent decision-loop ADD + safety-loop stop on same position; verify mutex serializes
- `universe.test.ts`: simulate single-token API failure, verify rest of universe builds
- `reconciler.test.ts`: simulate dust accumulation, verify ignored; simulate untracked wallet token, verify mismatch
- `portfolio.test.ts`: ADD then stop, verify cost basis used correctly

### Day 6 — Paper trading shakedown
- Run paper-trade for 24h
- Verify decisions look sane and theses+invalidations are specific
- Verify alerts fire correctly
- Verify dashboard updates with valid UTC timestamps
- Verify `/heartbeat` and `/halt` work
- Fix any bugs

### Day 7 — Go live
- Fund wallet with 30 USDC + 5 SOL
- Verify reconciler-on-startup passes with the funded wallet
- Start agent
- Set up daily review cron (22:00 UTC)
- Send initial heartbeat
- Monitor closely first 24h for execution issues — not decision quality

### Day 8+ — Iterate
- Read daily Opus reviews carefully
- Apply prompt changes only when reviews surface clear, structural issues (not single bad trades)
- Tune universe gates if consistently too narrow (0 candidates) or too broad (>25 candidates)
- Tweet outcomes after positions close (never during)
- Compound learnings into the next iteration

---

## 8. Build-in-public stance

**Public from day one.**

- Live dashboard URL (read-only, sanitized) shared on Twitter/X
- Daily summary thread at ~22:00 UTC after Opus review
- Trades tweeted *after* positions close, never during (front-running protection)
- Weekly write-up: what surprised, what would change in Agent Bazaar based on what was seen
- All code public from launch (`github.com/naaku11/trading-agent` or similar)

**Hashtags / framing:** `#buildinpublic` `#solana` `#aiagents`. Lean into the "Agent Bazaar dogfooding" narrative — this is the first real consumer agent for the protocol being built.

**What NOT to post:**
- Open positions in real time
- Specific entry signals before they're stale  
- Wallet private key (obviously)
- Live dashboard with unsanitized state (positions shown only after close)

---

## 9. Time-boxing and exit conditions

Open-ended timeline, week-to-week decisions based on performance and operational quality.

**After Week 1 — questions to answer honestly:**
- Is decision quality net of execution producing edge? (`alpha = pnl + fees + slippage`)
- Is the universe filter producing real candidates or noise?
- Are there bugs that required manual intervention? How many?
- Is the prompt or strategy under-performing in a specific, fixable way?
- Continue, iterate, or stop?

**After Week 2:**
- Profit > $30 (doubled): scale considerations come on the table (larger capital, additional strategies, perps as separate parallel agent). **Do not scale on luck — only scale if the trade log shows ≥10 trades with documented edge.**
- Loss > $13 (hard stop hit): stop, full retrospective, decide if there's a v2 with structural changes
- Anywhere in between: continue if there's a clear path to improvement, stop if performance is structurally bad (e.g. agent is right on direction but bleeding on slippage every trade)

**Hard end conditions (no negotiation):**
- Hard stop at -$13 from peak: agent halts, retrospective written
- Reconciler mismatch unresolvable: agent halts until manual reconciliation
- Real bug discovered that compromises safety: pause, debug, decide whether to resume
- Heartbeat missed for >24h: agent already auto-paused at 12h, remains paused
- Manual `/halt` invoked: agent halts, full retrospective written

---

## 10. Out of scope

- Perpetual futures, leveraged products of any kind (separate future build)
- New launches, pre-sales, tokens that haven't passed the universe gates
- Cross-chain, bridging, anything off Solana
- Yield farming, lending, staking
- Connection to Agent Bazaar (deferred — see §11)
- Limit orders, TWAP entries (market orders only at this scale)
- Multi-wallet, multi-strategy parallelism
- Auto-application of LLM-suggested prompt changes (always human-in-the-loop for prompt edits)

---

## 11. Connection to Agent Bazaar (future, not now)

Once Agent Bazaar v1 ships and the trading agent has run standalone for 2+ weeks, *consider* refactoring it to be a Bazaar consumer agent: instead of having signal logic baked in, it hires Bazaar providers (sentiment, rug detection, smart-money tracking) via on-chain escrow.

Running standalone first means:
- Cleaner observation of single-agent behavior
- Bugs are clearly the trading agent's, not Bazaar's
- The "Bazaar version" becomes a v2 milestone with its own learnings — and a much stronger demo for the protocol

---

## 12. Open questions to resolve before launch

1. **Sol CLI security review.** Read the source, verify it doesn't phone home with private keys. The OpenClaw incident ($250K lost to malicious skills) is real. Pin a specific commit SHA after review. Required before funding the wallet.
2. **Jupiter `slippageBps` parameter.** Set to 150 (1.5%) on every swap. Verify Sol CLI exposes this; if not, work around it. Trades exceeding slippage revert on-chain rather than fill at bad prices.
3. **Priority fees.** Use Jupiter's dynamic fee recommendation, cap at $0.02 per tx (~0.5% of a $5 trade). If congestion sustained, the SOL reserve check will pause the agent before the wallet drains.
4. **Universe gate tuning.** Validate against Day 1 actual output. If universe is consistently 0-2 tokens, loosen the unique-traders or volatility gates. If consistently 25+, tighten. Don't tune mid-experiment based on a single bad trade — only on structural patterns.
5. **LunarCrush free tier rate limits.** Confirm what's actually available before depending on it. Fall back to "no sentiment signal" gracefully if rate-limited (decision loop continues; sentiment treated as absent).
6. **Reconciler dust threshold.** $0.50 is a guess. Verify against actual wallet dust accumulation in week 1; adjust if needed.
7. **Daily review scheduling collision.** If 22:00 UTC happens to land mid-decision-cycle, the review waits up to 60s for the loop to finish. Verify this works under load.

---

## 13. What changed from v2 (audit trail)

For anyone reading both versions back-to-back:

1. **Cost basis math made explicit and unambiguous.** `cost_basis_total_usdc` is the total USDC spent acquiring the current `size_tokens`. Stop math formalized in §2.7.
2. **R/R rule removed.** v2's "5% target with 1.5:1 R/R" was incoherent against the -40% mechanical stop. Replaced with `expected_move_pct >= 5` plus testable invalidation. The mechanical stop and contextual exit operate on different time scales — documented.
3. **Vol gate loosened.** v2's 200% annualized vol cap would empty the universe. Raised to 600% (filters extreme blow-off-tops only).
4. **CEX listing gate removed.** Too restrictive — would limit universe to 3-4 tokens. Quality Solana memes routinely lack Tier-1 CEX listings.
5. **Top-20 holder and wallet-to-volume gates removed.** Redundant with top-10 and 500-unique-traders.
6. **Dual trade cap collapsed to rolling 24h only.** Calendar-day UTC reset at midnight in Europe was creating the exact failure mode it tried to prevent.
7. **Process supervision simplified.** Docker `restart: unless-stopped` only. PM2 inside container + systemd watching container was overkill.
8. **AppArmor profile dropped.** Wrong threat model for $30 budget; effort better spent on Sol CLI source review.
9. **Backups reduced to nightly.** 6-hour cadence was excessive for ~50KB of trade data.
10. **Manual `/halt` command added.** Critical missing escape hatch for "wake up at 3am" scenario. Equivalent local script as fallback.
11. **SOL gas reserve check added.** Below 0.015 SOL auto-pauses; refund required to resume.
12. **EXIT semantics clarified.** Always sells full wallet balance (not recorded position size). Prevents dust accumulation from prior-trade slippage.
13. **Pause semantics clarified.** Soft pause blocks OPEN/ADD but allows EXIT. Heartbeat-miss does not disable safety loop. Trade-cap auto-resumes when below cap.
14. **OPEN/ADD consistency enforced.** OPEN on existing position → error. ADD on missing position → error. Action set passed to LLM so it knows what's available.
15. **Universe re-verification at execution time.** Token may have left universe between decision and trade; checked inside mutex.
16. **All timestamps UTC.** No more timezone confusion across logs, DB, and dashboard.
17. **Partial signal API failure handling.** Single-token fetch failure excludes only that token; full universe build continues.
18. **Quote staleness documented.** 100-500ms window between quote and tx submit accepted as known tradeoff; `slippageBps` hard cap protects against worst case.
19. **On-chain amount parsing.** Trade table records actual amounts from `helius.parseSwap()`, not quote values. Cost basis derived from on-chain reality.
20. **Daily review collision handling.** Waits for decision loop lock up to 60s.
21. **STUCK intent state added.** For intents in UNKNOWN_TIMEOUT >10 min from creation.
22. **Confidence calibration added to daily review.** Tracks whether high-confidence trades actually outperform low-confidence ones.

---

## 14. Reference

- Sol CLI / Solana Payments & Trading skill: https://mcpmarket.com/tools/skills/solana-payments-trading-cli
- Jupiter Ultra v3 docs: https://station.jup.ag/
- Helius docs: https://docs.helius.dev/
- Dexscreener API: https://docs.dexscreener.com/
- LunarCrush API: https://lunarcrush.com/developers
- Anthropic SDK: https://docs.claude.com/
- async-mutex: https://github.com/DirtyHairy/async-mutex
- zod: https://zod.dev/
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3

---

**End of spec v3 (final).**

**Implementation order for the new Claude Code chat:**

1. Scaffold project structure (§2.2)
2. SQLite schema + DB helpers (§5.1) — everything else needs this
3. `tx-pipeline.ts` + `sol-cli.ts` + `helius.parseSwap()` — verify with a $1 test swap
4. `portfolio.ts` with the cost-basis math from §2.7 (test heavily)
5. `reconciler.ts` — agent does not start without this passing
6. `scheduler.ts` and `safety-loop.ts` with all kill switches
7. `universe.ts` + signal sources
8. `decision-loop.ts` with prompts, zod validation, allowed_actions
9. `halt-handler.ts` + heartbeat
10. Dashboard + Telegram bot
11. Chaos tests — gate for deploy
12. Paper trade 24h, then go live

Do not skip the chaos tests. They are the difference between an agent that runs and an agent that desyncs on day 3.