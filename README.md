# CoinBoi

**Autonomous Solana spot trading agent with hard safety constraints enforced below the LLM.**

$30 starting capital. Three positions max. Claude Haiku decides; code enforces the kill switches. Built in public to stress-test the design of [Agent Bazaar](https://github.com/naaku11) — running a real autonomous agent with real money is the fastest way to sharpen a protocol meant to coordinate them.

> Status: **Day 0 — scaffold.** Not live. Not funded.

## What this is

A long-running Node process that:

- Decides every 3 min (± 30s jitter) via Claude Haiku
- Enforces stops, drawdown limits, and daily trade caps every 15s in pure code — no LLM in the path
- Reconciles on-chain wallet state against its own DB every 5 min
- Liquidates everything on `/halt`, hard-stop, or unresolvable mismatch
- Logs every decision, intent, trade, tick, and error to SQLite
- Reports to Telegram and a Tailscale-only Express dashboard

The whole design philosophy is that **execution and risk dominate at $30** — decision quality matters at scale, but at this size you mostly need to not blow up from bugs, slippage, or front-running.

## Hard rules (immutable, enforced in code)

| Rule | Value |
|---|---|
| Starting capital | 30 USDC + ~5 SOL gas |
| Max position size | $5 USDC notional |
| Max concurrent positions | 3 |
| Per-position stop | −40% from cost basis, 2-tick confirm |
| Soft pause | −$8 from peak portfolio value |
| Hard stop | −$13 from peak (full liquidation) |
| Trade cap | 12 / rolling 24h |
| SOL gas floor | 0.015 SOL |
| Slippage budget | ≤ 1.5% one-way at quote time |
| Spot only | No perps, no leverage, no bridging |

Full spec lives in `docs/spec.md` (added in a later commit).

## Stack

TypeScript / Node 20+ · Claude Haiku 4.5 (decisions) · Claude Opus 4.7 (daily review) · Jupiter Ultra v3 (execution) · Helius (RPC + tx parsing) · Dexscreener (market data) · SQLite WAL (state) · `async-mutex` (loop coordination) · Telegram (alerts + control) · Docker on Hetzner CX21 / Frankfurt · Tailscale-only access.

## Local setup

```bash
git clone https://github.com/naaku11/coinboi.git
cd coinboi
cp .env.example .env   # fill in keys; never commit
npm install
npm run typecheck
npm test
```

Don't run `npm start` yet — there's nothing to run. Build sequence below.

## Build sequence

- [x] Day 0 — scaffold, repo, license
- [ ] Day 1 — tx pipeline + Sol CLI wrapper, $1 test swap
- [ ] Day 2 — universe filters, signals, portfolio with cost-basis math
- [ ] Day 3 — scheduler, decision loop, safety loop, reconciler, halt handler
- [ ] Day 4 — observability (SQLite, Telegram, dashboard)
- [ ] Day 5 — chaos tests
- [ ] Day 6 — paper trade 24h
- [ ] Day 7 — fund wallet, go live

Daily updates on Twitter as positions close. Tag: `#buildinpublic #solana #aiagents`.

## License

MIT — see `LICENSE`.

## Safety

If you fork this and run it with real money, you accept that bugs in this code can lose your funds. The author runs it at $30 because at that size the loss is data, not pain. Choose your own size accordingly.
