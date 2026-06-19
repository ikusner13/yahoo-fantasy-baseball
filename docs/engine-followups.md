# Engine Follow-Ups & Handoff

**Purpose:** a self-contained work queue for improving the decision/projection engine. Written so a
fresh agent (or human) can pick up any item without prior conversation context.

**Read these first (they are the source of truth):**

- [`league-model.md`](./league-model.md) — league rules, roster, standings model.
- [`projections-and-scoring-model.md`](./projections-and-scoring-model.md) — how every calculation
  works, current constants, research-backed targets, and citations. **Every task below maps to a
  section there.**

---

## Locked decisions (do not re-litigate)

These were settled with the league owner; build to them.

1. **League format:** 12-team Yahoo H2H **each-category**, `cumulative-category-h2h`. Standings = sum of
   per-category outcomes across the season. There is **no weekly-majority threshold** — every category
   every week is worth one standings point. (`docs/league-model.md`, `LeagueState.ts:175`.)
2. **Objective:** maximize **expected category wins + ties** = `Σ_c P(win category c)`. Rank moves by
   **Δ(win probability), not Δ(expected output).**
3. **Risk model:** **variance-aware.** Underdog in a category → seek variance/ceiling; favorite → seek
   floor. (We are currently 36-83-11, 12th — mostly underdog, so variance-seeking is live.)
4. **Punting:** **soft-punt only** (down-weight, never zero a winnable category) — every category counts.
5. **Calibration:** **hybrid** — research-informed priors now, empirical backtest fitting later.
6. **AI roles:** all three — offline tuner, bounded runtime override (`config/tuning.json`
   `llm.overrideEnabled`), narrative. LLM layer is currently **wired-for but inactive** (zero model
   calls in `/src`).

---

## Key files (orientation map)

| File                                                   | Role                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/ProjectionModel.ts`                      | Blends projection systems; applies Statcast/Vegas/park/batting-order multipliers; prorates to the week. **Most magic numbers live here.** |
| `src/services/ProjectionData.ts`                       | Fetches FanGraphs projections, MLB schedule/lineups, Savant Statcast, The Odds API.                                                       |
| `src/services/DecisionEngine.ts`                       | ~5,000-sample Monte Carlo → category win probabilities, SGP deltas, category weights, free-agent add ranking.                             |
| `src/services/TransactionPlanner.ts`                   | Replacement value, transaction guardrails, timing, candidate ranking.                                                                     |
| `src/services/ManagerBriefing.ts`                      | Turns the plan into a human-readable briefing + confidence.                                                                               |
| `src/services/LeagueState.ts`                          | League settings, roster, standings from Yahoo.                                                                                            |
| `config/tuning.json`                                   | Strategy parameters incl. `llm.overrideEnabled`.                                                                                          |
| `legacy/analysis/recent-performance.ts`                | **Dormant** hot/cold Statcast recency module — good metrics, not wired in.                                                                |
| DB tables `decisions`, `retrospectives`, `daily_stats` | Raw material for the backtest/calibration loop.                                                                                           |

Verify line numbers before editing — they drift. Run `vp check` and `vp test` after changes
(per `CLAUDE.md`; this repo uses Vite+ / `vp`, **not** npm/pnpm directly).

---

## Follow-up tasks (priority order)

Priority = leverage × confidence. Each task: what, where, why, acceptance.

### F1 — Rank moves by Δ(category win probability) _(highest leverage)_

- **Where:** `DecisionEngine.ts` (add ranking, ~`WEEKLY_WEIGHT_ALPHA` blend); flows into
  `TransactionPlanner.ts` scoring and `ManagerBriefing.ts` confidence.
- **What:** The Monte Carlo already produces per-category win probabilities. Change the weekly term of
  the add/lineup score from Δ(expected output) to **Δ(P(win category))** — i.e. re-run (or
  delta-approximate) win probability _with_ the candidate's projected line and score the change.
- **Why:** Directly implements the locked objective (§1.2–1.3 of the scoring-model doc). We currently
  compute the distribution then collapse it to the mean.
- **Acceptance:** a move that pads a locked/lost category scores ≈0; a move that nudges a coin-flip
  category scores high. Add a unit test with a synthetic matchup (one locked, one coin-flip, one lost)
  asserting the ordering.

### F2 — Variance-aware candidate selection

- **Where:** `DecisionEngine.ts` / `TransactionPlanner.ts`, after F1.
- **What:** When a category's win prob < ~50% (underdog), prefer higher-variance options (ceiling) for
  that category; when > ~50% (favorite), prefer lower-variance (floor). Use the per-sim spread already
  available from the Monte Carlo.
- **Why:** Locked decision #3; mathematically, raising σ raises an underdog's win prob.
- **Acceptance:** given two candidates with equal mean contribution to a losing category, the
  higher-variance one ranks higher; reversed for a winning category. Unit test both directions.

### F3 — Stabilization shrinkage for in-season / Statcast vs projection

- **Where:** `ProjectionModel.ts` (replace ad-hoc Statcast multiplier tables); fold in
  `legacy/analysis/recent-performance.ts`.
- **What:** Blend observed in-season rates toward the projection prior via
  `blended = (n·observed + M·projection)/(n+M)`, using the stabilization points table in
  `projections-and-scoring-model.md` §3.3 (K% 60 PA, barrel/hard-hit/EV ~50–100 BBE, etc.).
  Drop the fixed `±0.05/0.08` bumps and `[0.85,1.15]` clamps in favor of this.
- **Why:** Replaces magic numbers with a defensible Bayesian blend; weight on observed data scales
  correctly with sample size.
- **Acceptance:** at n=0 the projection is unchanged; at n=M the blend is 50/50; ERA is **not** used as
  a stabilizing input (use FIP/xFIP/SIERA). Unit test the boundary cases.

### F4 — Playing-time / injury discount on PA & IP

- **Where:** `ProjectionModel.ts` (after blend, before proration).
- **What:** Apply a downward haircut to projected PA/IP for injury-prone / unsettled-role players (all
  systems over-project PA ~47–79, IP ~20). Start with a simple risk tier; refine via backtest later.
- **Why:** The single largest projection-accuracy error source (§3.2). Cheap, high ROI.
- **Acceptance:** flagged high-risk players receive reduced PA/IP; aggregate projected PA across the
  roster trends below the raw system sum. Document the discount source.

### F5 — Projection blend fix (add ATC, cut ZiPS, per-category weights)

- **Where:** `ProjectionData.ts` (fetch), `ProjectionModel.ts` (weights).
- **What:** Add **ATC** as a source; reduce **ZiPS DC** weight (bottom-tier in 2023–25); move toward
  **per-category** blend weights (ATC's approach) instead of one weight per system.
- **Why:** ATC/THE BAT X are the most accurate; blending beats any single system (§3.1).
- **Acceptance:** ATC ingested and crosswalked; weights documented; ideally weights chosen by backtest
  (F8) rather than hand-set. Check ATC availability/licensing on FanGraphs before committing.

### F6 — Park factors: 3-year regressed + handedness splits

- **Where:** `ProjectionModel.ts`, `parkFactors` table / loader.
- **What:** Replace static single-year factors with 3-yr regressed values and L/R handedness splits
  (Baseball Savant). For a single game apply the full factor (both teams hit there).
- **Why:** 1-yr factors are noise (±8–12 pts); handedness splits are large (§3.5).
- **Acceptance:** factors carry a handedness dimension; sourced/dated; extreme parks (Coors, GABP)
  reflect expected magnitudes.

### F7 — Continuous category weights + re-fit batting-order PA curve

- **Where:** `DecisionEngine.ts` (category weights), `ProjectionModel.ts` (`battingOrderPa`).
- **What:** (a) Replace the 3-bucket category weight (coin-flip 1.75 / lean 1.0 / lock-or-lost 0.2) with
  a smooth function of win-prob (proportional to the pdf near 50%), keeping lock/lost **non-zero**.
  (b) Re-fit `battingOrderPa` from `4.9−(order−1)·0.18` to the empirical curve (leadoff 4.63 → #9 3.75).
- **Why:** Removes win-prob cliffs; current curve overweights leadoff (§3.6, §4.2).
- **Acceptance:** no discontinuity in category weight across the 0.34/0.36 boundary; leadoff PA ≈4.63.
- **Status: DONE.** (a) `categoryWeight(p) = FLOOR + (PEAK−FLOOR)·exp(−probit(p)²/2)` (φ(z)/φ(0),
  the win-prob-gradient pdf) replaces the buckets; PEAK 1.75 / FLOOR 0.2 are named priors, smooth
  with a non-zero soft-punt floor. (b) `battingOrderPa = clamp(4.63−(order−1)·0.11, 3.75, 4.63)`,
  named constants sourced from Spaeder 2023. Tests assert weight continuity across 0.34/0.36 +
  non-zero floor, and leadoff PA ≈4.63 / #9 ≈3.75. (See §4.2, §3.6.)

### F8 — Backtest & calibration harness _(unlocks fitting all of the above)_

- **Where:** new module; consumes `decisions`, `retrospectives`, `daily_stats`.
- **What:** Score predicted-vs-actual weekly category outcomes; **fit** coefficients (blend weights,
  shrinkage priors, category-weight curve, `WEEKLY_WEIGHT_ALPHA` schedule, guardrail thresholds) instead
  of hand-setting. This is also where the **AI offline-tuner** role lives.
- **Why:** Turns the whole engine from "magic numbers" into measured parameters (locked decision #5).
- **Acceptance:** harness reports a calibration metric (e.g. Brier score on category-win predictions)
  over historical weeks and supports a single-coefficient sweep. Note: needs enough history — may be
  thin early-season.

### F9 — Activate the AI layer (after F8)

- **Where:** wire `@effect/ai-*`; honor `config/tuning.json` `llm.overrideEnabled`.
- **What:** Offline tuner (F8), bounded runtime override (with guardrails on _when_ override is allowed),
  and narrative briefing generation. Use the latest Claude models (see `claude-api` skill / repo
  guidance).
- **Acceptance:** override is logged, bounded, and explainable; narrative reads from the structured plan;
  evals (already scaffolded via `evalite`) pass.

---

## Open questions for the owner

1. **First build target:** F1 (win-prob ranking, fastest strategic win) or F8 (backtest harness, proves
   every later change)? Owner leaning undecided as of handoff.
2. **ATC access:** is ATC available on the current FanGraphs data feed / plan? (F5 blocker.)
3. **`WEEKLY_WEIGHT_ALPHA` dynamics:** confirm the desired schedule (more weekly as the week closes /
   when chasing flips; more season-value early-week and for locked/hopeless categories).

---

## Conventions / gotchas

- Use **Vite+ (`vp`)** for everything: `vp check`, `vp test`, `vp add <pkg>`. Do **not** call npm/pnpm
  or run `vp vitest`/`vp oxlint` directly. Import test utils from `vite-plus/test`. (See `CLAUDE.md`.)
- Don't over-comment; match surrounding style; keep changes concise.
- Re-verify projection-system accuracy rankings each preseason — they shift year to year.
- Research findings here were gathered 2026-06; citation index is in
  `projections-and-scoring-model.md` §8.
