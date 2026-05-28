
# CoinBoi — Agent Context

Autonomous Solana spot trading agent. $30 capital. Claude Haiku decides every
3 min; pure-code safety loop enforces kill switches every 15s. Built in public.

**The full build spec is `docs/spec.md`. It is normative.** Read the relevant
section before implementing — section numbers are referenced throughout the code
as `// See spec §X`. Don't reproduce the whole spec into context; open the
section you need.

## Where things are (spec §2.2)

- `src/agent/` — scheduler, decision-loop, safety-loop, reconciler, heartbeat,
  halt-handler, prompts, schemas, review
- `src/execution/` — sol-cli, jupiter-quote, tx-pipeline, universe, portfolio
- `src/signals/` — dexscreener, helius, lunarcrush, price-oracle
- `src/observability/` — db, logger, telegram, dashboard
- `src/config.ts`, `src/main.ts`
- `tests/` — vitest; `scripts/` — wallet/reconcile/halt/paper-trade

## Hard rules — NEVER violate (full table in spec §1)

These are enforced in code paths that bypass the LLM. Do not weaken them.

- Max position size: $5 USDC at entry. Max 3 concurrent positions.
- Per-position stop: −40% from cost basis, confirmed over 2 consecutive ticks.
- Soft pause −$8 from peak (blocks OPEN/ADD, allows EXIT). Hard stop −$13 (full
  liquidation, agent halts).
- Slippage budget ≤ 1.5% one-way at quote time; over budget → skip, don't trade.
- Daily cap 12 trades / rolling 24h. SOL gas floor 0.015.
- Spot only. No perps, leverage, lending, staking, bridging (spec §10).
- Cost-basis math (spec §2.7) is normative. Any test disagreeing with it is wrong.
- tx pipeline is idempotent; NEVER retry a trade without reconciling first (§2.8).
- All timestamps UTC ISO-8601.

## Safety gate (spec §12.1)

The external `@solana-compass/cli` (`sol`) tool signs trades with our wallet key.
It MUST pass security review and have a pinned commit SHA before any wallet is
funded or any real swap fires. Until then, `sol-cli.ts` uses a mock/paper impl.
Real mainnet execution stays gated behind an explicit flag defaulting to OFF.

## Conventions

- Strict TypeScript, no `any`. ESM. Node 20+. npm.
- zod-validate every external input (LLM responses, API payloads). Malformed
  LLM output → treat as HOLD_ALL.
- better-sqlite3, synchronous, WAL mode. SQLite is the source of truth for
  loop coordination.
- Run `npm run typecheck` and `npm test` before declaring a task done.

## Build order (spec §14, end of doc)

DB → tx-pipeline/sol-cli/helius → portfolio → reconciler → scheduler/safety-loop
→ universe/signals → decision-loop → halt/heartbeat → dashboard/telegram →
chaos tests → paper-trade 24h → go live. Don't build ahead of the current day.