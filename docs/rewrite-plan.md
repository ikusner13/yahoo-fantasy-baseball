# Rewrite Plan

How we get from [current-state.md](./current-state.md) to the product objective in [league-model.md](./league-model.md), using the tactics in [strategy.md](./strategy.md). The engine math is specified separately in [decision-engine.md](./decision-engine.md); the stack (**Effect v4 + Alchemy**) is specified in [tech-stack.md](./tech-stack.md).

This is a plan, not a spec dump. It is ordered by leverage: fix what's losing us standings points fastest, with the least risk, first.

---

## Guiding principles

1. **Maximize expected cumulative category points, every week** — not binary matchup wins. This is the objective function; every component serves it. (See [league-model.md](./league-model.md) §Standings Model.)
2. **Yahoo is the source of truth for state.** Roster, empty slots, adds-used, waiver priority, matchup scores, IL usage, week boundaries — always read live, never inferred from KV. This alone fixes most of the original failure pattern.
3. **Greenfield on Effect v4 + Alchemy, porting proven logic.** This is a full rewrite in a new codebase ([tech-stack.md](./tech-stack.md)), not an in-place fix. The old `src/` is reference only — port the _algorithms_ (Monte Carlo, opponent scout, data fetchers, prompts, SGP), not the structure or the bugs.
4. **Recommend autonomously, act with guardrails.** Read-only analysis and lineup/IL moves can be automatic (per league-model §Safety); adds, drops, waiver claims, and trades require explicit approval.
5. **No monolith — services + Layers.** Each concern is an Effect service behind a `Layer`; routines are thin Effects composing services, unit-tested with test Layers. The old `gm.ts` (~71KB, all 8 routines inline) is what we're replacing, not extending. Boundaries get `Schema` decoders; external calls get typed errors + `Schedule` retries + `Effect.timeout`.
6. **Every behavioral claim gets a test** encoding this league's 13 categories and cumulative standings model.

---

## Target architecture

```
                    ┌──────────────────────────────────────────┐
                    │  Worker (Hono)  — HTTP + scheduled()       │
                    └───────────────┬──────────────────────────┘
                                    │ dispatch(routine)
                    ┌───────────────▼──────────────────────────┐
                    │  Orchestrator (thin)                       │
                    │  one routine = compose services + notify   │
                    └───────────────┬──────────────────────────┘
        ┌───────────────────────────┼───────────────────────────────┐
        ▼                           ▼                                 ▼
┌───────────────┐         ┌──────────────────┐              ┌──────────────────┐
│ LeagueState   │         │ DecisionEngine    │              │ ActionLayer       │
│ (Yahoo truth) │────────▶│ (marginal cat EV) │─────────────▶│ recommend/execute │
│ snapshot      │         │ SGP × P(flip)     │   ranked     │ + approval gating │
└──────┬────────┘         └─────────┬─────────┘   moves      └─────────┬────────┘
       │                            │                                   │
       ▼                            ▼                                   ▼
┌───────────────┐         ┌──────────────────┐              ┌──────────────────┐
│ DataServices  │         │ Projection model  │              │ Notify (Telegram) │
│ MLB/FG/Odds/  │         │ blend → prorate → │              │ + Yahoo writes    │
│ Savant + cache│         │ distributions     │              │ + decision log    │
└───────────────┘         └──────────────────┘              └──────────────────┘
```

Everything in the boxes is an **Effect service** behind a `Layer`; the whole thing — infra resources + handlers — is one **Alchemy stack** (`alchemy.run.ts`), with D1/KV/R2 exposed as typed `.bind()` clients. See [tech-stack.md](./tech-stack.md) for canonical patterns.

**Core services:**

- **`LeagueState` snapshot** — single object built from Yahoo each run: roster + computed empty slots, IL usage, **real adds-used & limit**, **real waiver priority**, matchup category scores, week start/end, days & games remaining. Everything downstream reads this; nothing re-derives state from KV.
- **`DecisionEngine`** — the [decision-engine.md](./decision-engine.md) pipeline: blended prorated projections → per-player per-category distributions → Monte-Carlo `P(win)` per category vs the opponent → marginal value of each candidate move = `α·ΔWeeklyExpCatPoints + (1−α)·ΔSeasonSGP`. Emits a ranked, typed move list.
- **`ActionLayer`** — turns ranked moves into typed recommendations (add-only / add-drop / waiver-claim / lineup / IL / trade), each naming affected categories and rationale; executes the allowed classes via Yahoo writes behind approval gates and an idempotency ledger.

---

## Phased execution

Per global CLAUDE.md: phases are ≤5 files of real change, each verified (`vp check` + `vp test`) and committed before the next. Multi-file phases use parallel sub-agents. Because this is a greenfield build, "deliver value" means **reaching parity then surpassing it** — Phases 1–4 stand up the trustworthy-state + engine that the old app never had.

### Phase 0 — Scaffold the stack

_Goal: a deployable skeleton on the new stack before any domain logic._

- New Alchemy v2 project: `alchemy.run.ts` stack with `Worker`, `D1Database`, `KVNamespace` (+ `R2` if needed); `Cloudflare.providers()`; dev/prod **stages**; commit local state files.
- Effect v4 baseline: pin exact beta versions; `vp` (Vite+) toolchain; service/`Layer` skeleton; `Schema` at boundaries; CI runs `vp check` + `vp test`.
- Port the DB schema (drizzle over the D1 binding, wrapped in a `Db` service) and a hello-world `fetch` handler; deploy to a `dev` stage.
- **⚠ Resolve the blocking opens first** ([tech-stack.md](./tech-stack.md) risks): confirm Alchemy v2 supports **Cloudflare cron/scheduled triggers** and a **secrets** pattern. If cron isn't supported, choose the fallback (external scheduler → HTTP route, or Workflows/Queues) now.
- Keep old `src/` as `legacy/` reference until parity.
- **Exit:** `alchemy deploy --stage dev` ships a worker; a scheduled trigger fires a stub routine; secrets resolve.

### Phase 1 — Truth: `LeagueState` from Yahoo (highest leverage)

_Goal: make state trustworthy — the root fix for the known bugs._

- `YahooClient` service: OAuth refresh-on-401; **`Schema`-decoded reads** (replacing positional-index parsing); typed errors (`YahooAuthError`/`YahooRateLimit`/`YahooParseError`); hand-built XML for writes (defer execution to Phase 5).
- `LeagueState` service: real `number_of_moves`/`max_weekly_adds`, real `waiver_priority`/`faab_balance`, **computed empty slots** (diff roster vs settings `roster_positions`), IL usage, matchup scores, week boundaries, days/games remaining.
- KV is a **cache of the Yahoo read**, never the source of truth; no every-run budget reset.
- Confirm Yahoo field tags & write XML against **live API responses** (UNVERIFIED in [strategy.md §4](./strategy.md)).
- **Exit:** the app's view of state provably equals Yahoo's (asserted in tests against a live read).

### Phase 2 — Projection model (real inputs)

_Goal: feed the engine correct numbers._ (See [decision-engine.md §1–2](./decision-engine.md).)

- **Blend** ROS projections (THE BAT X + Steamer + ZiPS DC + ATC), per-category weighting; replace single-Steamer fetch.
- **Prorate to the scoring period**: counting stats by expected PA (hitters) / starts (pitchers) from the MLB schedule + probables; rate stats by accumulating numerator/denominator. Wire the already-built `computeGameCountMultiplier`/games-remaining.
- Wire **Vegas implied totals into batter scoring** (currently streaming-only) and keep park/platoon.
- **Exit:** per-player weekly expected stat lines exist for our roster, the opponent's roster, and free agents.

### Phase 3 — Decision engine online

_Goal: replace snapshot-margin heuristics with marginal category EV._ (See [decision-engine.md §3–5](./decision-engine.md).)

- **Wire `simulateMatchup`** against **real opponent projections** (Phase 2) — fix the OBP math and drop the naive pace-extrapolation fallback. Produce per-category `P(win)+0.5·P(tie)`.
- Implement **SGP denominators from our standings history** (`SLOPE` over 12 teams per category) for the season backbone; keep z-scores only as a fallback ranker.
- Revive **opponent scouting** as the Locks/Coin-flips/Lost-causes tagger driven by `P(win)` (not z-score sums).
- Make `optimizeLineup` actually consume category weights on the primary scoring path (fix the [current-state.md §4](./current-state.md) bug where swing weights are ignored).
- Move score = `α·ΔWeeklyExpCatPoints + (1−α)·ΔSeasonSGP`; concentrate effort where `P(win)≈0.5`.
- **Exit:** every recommendation is justified by a category-EV delta, not a fixed threshold.

### Phase 4 — Transaction intelligence

_Goal: spend the 6 adds like a winning manager._ (See [strategy.md §2.5–2.8](./strategy.md).)

- **Separate decision paths**: free-agent add (priority-free), waiver claim (burns real priority), add/drop — each surfaced distinctly with affected categories.
- **Empty-slot urgency** scoring (open active slot on a game day = quantified lost volume → urgent add).
- **Add-budget sequencing**: reserve 2–3 adds for late-week coin-flips; value the 6th add highest Sat/Sun; target near-full weekly utilization.
- **SV+H program**: reliever module using gmLI + bullpen depth charts; setup-men-for-holds; closer handcuffs.
- **Streaming guardrails**: matchup/skills/park filters; two-start planning Friday; ratio protection gated on coin-flip state; **20-IP floor enforced first**. IL stash-and-stream that frees active slots.
- **Exit:** the app proposes a full, sequenced weekly transaction plan targeting the closest categories.

### Phase 5 — Execution layer (act, with guardrails)

_Goal: close the loop on Yahoo._

- Implement real Yahoo writes (hand-rolled `fetch` + XML per [strategy.md §4.3–4.4](./strategy.md)): `setLineup`, `addDrop`, `claimWaiver`, IL moves, trade propose/accept.
- **Approval gating**: auto-apply lineup + IL-for-confirmed-injury; require Telegram approval for adds/drops/claims/trades. Wire the existing trade approve/reject buttons to actual execution (the current TODO).
- **Idempotency**: re-read Yahoo + check a D1 ledger keyed by `(date, player_key, action)` before any write; confirm by re-reading state after.
- **Exit:** approved moves are applied to Yahoo and verified.

### Phase 6 — Learning loop (make it improve)

_Goal: the retrospective actually teaches._

- Fill decision **outcomes** (currently always "unknown"); stop auto-crediting swing predictions.
- Score predicted `P(win)` vs realized category results (calibration); feed misses into memory/`gmReflections`.
- Tune **α**, SGP denominators, and streaming thresholds from real outcomes.
- **Exit:** weekly retro changes next week's parameters.

---

## Cross-cutting cleanups (fold into the phase that touches them)

- Cron **UTC/ET mismatch** — verify against intended local times ([current-state.md §2](./current-state.md)).
- IL slots, season start date, `AVG_GAMES_PER_WEEK`, `DEFAULT_REMAINING_WEEKS`, variance CVs — move hardcoded constants into `tuning.ts` or derive from `LeagueState`.
- Park factors — keep the constant table as a fallback but allow a dynamic source.
- Reconcile **README** with reality at the end (out of scope for this doc; tracked separately).

---

## What we are explicitly NOT doing (yet)

- Full auto-trading (social/irreversible — approval-only).
- A bespoke projection system (we blend public ones).
- Multi-league support (single league, ids in `LeagueState`).

---

## Open items to resolve before/while building

- **Compute this league's SGP denominators** from standings history — sharpens every marginal-value calc ([decision-engine.md §3](./decision-engine.md)).
- **Verify Yahoo field tags + write XML** on live responses (Phase 0 gate): `number_of_moves`, `max_weekly_adds`, `waiver_priority`, `faab_balance`, IL position codes, transaction bodies, `SVHD` stat id, refresh-token lifetime, rate limits, ToS for automated writes.
- **Decide which old algorithms to port** vs leave in `legacy/` (port: Monte Carlo, opponent scout, SGP, data fetchers, prompts; defer/skip: volatility, playoff optimizer until needed).
- **Resolve the blocking stack opens** in Phase 0: Alchemy v2 cron/scheduled support and secrets pattern ([tech-stack.md](./tech-stack.md)).
- **Calibrate** QS%↔WHIP map and SV+H conversion rate from data, not the illustrative defaults.
- **Tune α** (weekly-flip vs season-SGP weight); expect higher late-season.
