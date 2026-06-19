# Projections, Calculations, and the Scoring Model

This document explains **how the engine turns raw data into decisions**, how each weight is
derived, and — most importantly — **how those calculations must serve this league's specific
scoring model**. Every weight in the system should be traceable either to the scoring model or to
published evidence. Where a weight is currently a hand-set "magic number," this document says so and
cites what it _should_ be.

Companion docs: [`league-model.md`](./league-model.md) is the source of truth for league rules.
This doc is the source of truth for _math and projections_.

---

## 1. The Scoring Model (read this first — everything flows from it)

### 1.1 Format

- **12-team Yahoo head-to-head categories** (`scoring_type=head`, `H2H Cat`).
  Source: `docs/league-model.md`, and hardcoded as `scoringFormat: "cumulative-category-h2h"`
  in `src/services/LeagueState.ts:175`.
- **13 scoring categories:**
  - Batting (7): `R`, `H`, `HR`, `RBI`, `SB`, `TB`, `OBP`
  - Pitching (6): `OUT`, `K`, `ERA`, `WHIP`, `QS`, `SV+H`
  - `IP` and `H/AB` are display-only (`is_only_display_stat=1`), but **`IP` matters operationally**:
    failing the **20 IP/week minimum forfeits all pitching categories**.
- Weekly add limit **6**; rolling waivers (`waiver_type=R`, 2-day); 6 of 12 teams make playoffs (Week 24).

### 1.2 How standings actually work — and why it changes the math

> **Every category result is a standings unit.** A `4-9` week is 4 category wins and 9 losses;
> those roll directly into the season record (currently `36-83-11`, 12th). A team does **not** earn one
> standings win for winning the week — it earns up to 13 category outcomes per week.
> (`docs/league-model.md:77-90`)

This has three hard consequences that the math must respect:

1. **There is no weekly-majority threshold.** In "win-the-week" formats, an 8-5 and a 7-6 are both
   "1 win," so you stop caring once you've clinched 7 categories. **Not here.** Turning a `4-9` into a
   `5-8` is worth exactly one standings point. _Every category, every week, has equal standing value._
2. **The correct objective is to maximize expected category _wins_, not expected category _output_.**
   `docs/league-model.md:95` already states this: _"Maximize expected cumulative category wins and
   ties."_ A category win is **binary** — you either beat your one opponent that week or you don't.
   The expected number of category wins is therefore **the sum of per-category win probabilities**:

   ```
   E[category wins this week] = Σ_c  P(win category c)
   ```

   Maximizing this is **not** the same as maximizing total projected stats. Adding a 30th home run to a
   category you already win 99% of the time adds ~0 expected wins; nudging a coin-flip category from
   48% → 58% adds 0.10 expected wins. **The engine must rank moves by Δ(win probability), not Δ(output).**

3. **Soft-punt, never hard-punt.** Because every category counts toward standings, _fully_ conceding a
   winnable category is strictly worse than in win-the-week formats. The literature on H2H-each-category
   converges on _soft-punting_ — down-weighting low-probability categories, not zeroing them
   (arXiv 2409.09884, see §6). Our current `lock/lost = 0.2` weight (not 0.0) is directionally correct;
   the bucketing is the crude part (§4.2).

### 1.3 The marginal-value principle (the single most important idea)

The marginal value of one unit of a stat is **proportional to how close that category is to a
coin-flip** — formally, the value of the probability density of the win-probability curve near 50%.

- Category at ~50% win prob → **maximum** marginal value (every unit swings a real contest).
- Category at ~95% (locked) or ~5% (lost) → **near-zero** marginal value.

And the corollary that matters because we are currently an **underdog** (36-83-11):

- **If you project to LOSE a category, seek variance** (high-ceiling streamers, boom/bust bats):
  raising σ raises your tail probability of an upset win even if it lowers expected output.
- **If you project to WIN a category, seek floor** (reliable producers): lock it in.

This is standard decision theory (underdog maximizes variance: arXiv 1111.0693) and is confirmed for
fantasy categories specifically (arXiv 2409.09884, 2501.00933). See §6.

**Status in code today:** The engine _computes_ this — `DecisionEngine.ts` runs ~5,000 Monte Carlo
sims and produces category win probabilities and lock/coin-flip/lost-cause tags. **F1** ranks moves by
Δ(expected category wins+ties), and **F2** makes that ranking variance-aware: each weekly line carries
an optional `volatility` σ-multiplier on its sampling, so a high-σ candidate raises team σ (helping an
underdog category, hurting a favorite one) and the existing Δ(win-prob) re-sim rewards/penalizes it
automatically — no separate variance scoring branch. `volatility` currently **defaults to neutral (1.0)**;
wiring a real per-player source (boom/bust, role uncertainty, projection spread) is future work and ties
into F3 stabilization. (`simulateMatchup` now also exposes per-category `marginMean`/`marginStdDev`
diagnostics that document the variance the ranking uses.)

---

## 2. The Calculation Pipeline (data → decision)

```
Yahoo API ──┐
            ├─ identity crosswalk (Yahoo ↔ MLBAM ↔ FanGraphs)
FanGraphs ──┤
MLB Stats ──┤        ┌───────────────────────────────────────────────┐
Baseball   ─┤        │ ProjectionModel.ts                            │
 Savant     ├──────▶ │  blend systems → prorate to week →            │
The Odds API┘        │  ×Statcast ×Vegas ×park ×batting-order        │
                     └───────────────┬───────────────────────────────┘
                                     ▼
                     ┌───────────────────────────────────────────────┐
                     │ DecisionEngine.ts                              │
                     │  Monte Carlo (~5k) → category win prob,        │
                     │  SGP deltas, category weights, add ranking     │
                     └───────────────┬───────────────────────────────┘
                                     ▼
                     ┌───────────────────────────────────────────────┐
                     │ TransactionPlanner.ts                          │
                     │  replacement value, guardrails, timing         │
                     └───────────────┬───────────────────────────────┘
                                     ▼
                     ManagerBriefing.ts → human-readable plan + confidence
```

**Data sources:** Yahoo Fantasy API (roster, matchup, settings, standings), FanGraphs (4 projection
systems), MLB Stats API (schedule, probable pitchers, confirmed lineups, batting order), Baseball
Savant (Statcast), The Odds API (Vegas implied runs). Park factors and SGP denominators are stored
internally.

---

## 3. How Projections Are Calculated

Each subsection lists the **current code**, the **research-backed target**, and a **verdict**.

### 3.1 Projection-system blend — `ProjectionModel.ts`

**Current:** weighted mean of four FanGraphs systems.

- Batters: TheBatX `0.40`, Steamer `0.25`, RAT/DC `0.25`, ZiPS DC `0.10`
- Pitchers: RAT/DC `0.40`, Steamer `0.25`, ZiPS DC `0.20`, TheBatX `0.15`

**Evidence:**

- Blending multiple systems **beats any single system** — this is robust across years
  (Hardball Times 2014; RotoGraphs 2024 reviews; SABR _AggPro_).
- By FantasyPros accuracy rankings 2023–2025, **ATC** and **THE BAT / THE BAT X** are consistently the
  most accurate; **ZiPS DC is consistently bottom-tier**.
- **ATC** (the frequent #1) is itself an _accuracy-weighted_ average that weights each constituent
  system **differently per stat category**.

**Verdict:** Blending is correct. But (a) we are **missing ATC** entirely, (b) **ZiPS is overweighted**
relative to its recent accuracy, and (c) a single fixed weight per system is cruder than ATC's
per-category weighting. _Recommendation:_ add ATC, reduce ZiPS, and move toward per-category blend
weights fit from backtest (§7).

**Status (F5 done):** ATC was _not_ actually missing — the existing `ratcdc` source key **is RoS ATC
DC** (Ariel Cohen's rest-of-season ATC), which is the correct in-season variant, so no full-season
`type=atc` source was added (it would double-count). ZiPS DC weight was cut (batters 0.10→0.05,
pitchers 0.20→0.10) and redistributed to the top-tier systems. Blend weights are now **per-(source,
category)**: a source base weight plus optional per-category overrides (lean THE BAT X for power/K,
ATC for rate/role). Weights are hand-set priors to fit via F8.

### 3.2 Playing time (the #1 error source) — currently unmodeled

**Current:** the engine trusts each system's projected PA / IP, then prorates by schedule.

**Evidence:** **All projection systems systematically over-project playing time** — PA by ~47–79 per
hitter, IP by ~20 per pitcher — because none model injury-probability distributions. "Correctly
guessing playing time allows a projection to dominate accuracy rankings." Marcel (which regresses PT
hard) is the most accurate at PA precisely for this reason. (RotoGraphs 2024 PT review.)

**Verdict:** ❌ **Biggest accuracy gap.** Apply a downward injury/role discount to PA and IP for
high-risk players. Cheap to build, high ROI.

**Status (F4 done):** Yahoo player `status` now threads into the projection sources and a
playing-time discount is applied to **weekly volume** during proration (DTD 0.90, out 0.30,
IL\*/NA/SUSP 0.05, healthy 1.0). It scales PA/IP and counting stats while leaving rates (OBP, ERA,
WHIP) invariant. Tiers are research-informed priors to fit via backtest. The systematic ~47–79 PA /
~20 IP over-projection for _healthy_ players is intentionally **not** haircut yet — deferred to F8
calibration to avoid a hardcoded guess.

### 3.3 Statcast skill adjustments — `ProjectionModel.ts`

**Current:** fixed threshold bumps, e.g. batter power: barrel% ≥ 12 → +0.08, ≤ 5 → −0.05; hard-hit% ≥
45 → +0.04; clamped to `[0.85, 1.15]`. Similar ad-hoc tables for contact, speed, pitcher run-prevention,
and strikeouts.

**Evidence:** the _principled_ way to fold in-season Statcast into a projection is **Bayesian shrinkage
toward the projection prior**, governed by each metric's **stabilization point** M:

```
blended_rate = (n · observed + M · projection) / (n + M)          B = M / (M + n)
```

Stabilization points (reliability = 0.5; Carleton / FanGraphs):

| Metric                        | M       | Unit                                               |
| ----------------------------- | ------- | -------------------------------------------------- |
| Bat speed                     | ~3      | swings (fastest known)                             |
| Exit velo / hard-hit / barrel | ~50–100 | batted-ball events                                 |
| xwOBA / xwOBAcon              | ~50–60  | BBE                                                |
| K% (hitter)                   | 60      | PA                                                 |
| BB% (hitter)                  | 120     | PA                                                 |
| HR rate                       | 170     | PA                                                 |
| ISO                           | 160     | AB                                                 |
| BABIP                         | 820     | BIP (≈ noise in-season)                            |
| K% (pitcher)                  | 70      | BF                                                 |
| BB% (pitcher)                 | 170     | BF                                                 |
| Whiff/SwStr                   | ~400    | pitches                                            |
| **ERA (pitcher)**             | —       | **never stabilizes in-season; use FIP/xFIP/SIERA** |
| BABIP (pitcher)               | ~2000   | BIP (noise)                                        |

A "stabilization point" means reliability = 0.5 — _not_ "now trustworthy." It is exactly the
pseudo-count for shrinkage. (Carleton, BP; FanGraphs Sabermetrics Library; probabilaball derivation.)

**Verdict:** ⚠️ The metrics chosen (barrel, hard-hit, EV, K%) are the _right, fastest-stabilizing_
signals. But the ad-hoc thresholds/clamps should be **replaced by the shrinkage formula** so the
weight on observed data scales correctly with sample size. This also subsumes the dormant
`legacy/analysis/recent-performance.ts` recency module (its barrel/hard-hit/EV/K weights are sensible;
wire it in _through_ shrinkage rather than as a separate ±15% nudge).

**Status (F3 done):** the ad-hoc threshold tables and tight `[0.85,1.15]` clamps in
`ProjectionModel.ts` are replaced by a continuous deviation from a league-average baseline, shrunk
toward neutral by reliability `w = n/(n+M)`; only a loose `[0.7,1.3]` safety bound remains. The
recency nudge is now subsumed by this shrinkage (in-season data weighted by sample size). The
stabilization points M are converted from BBE to PA-equivalent via BBE/PA ≈ 0.65 (an approximation
to refine via backtest). In-season sample size `n` (`pa`, `p_total_pitches`) is now pulled from
Baseball Savant. Run-prevention stabilizes on xwOBA-against (+barrel), _never ERA_; FIP/xFIP/SIERA
are not yet ingested (future work).

### 3.4 Vegas run environment — `ProjectionModel.ts`

**Current:** `vegasMultiplier = clamp(impliedRuns / 4.5, 0.75, 1.30)`.

**Evidence:** Vegas implied team totals are **the best single game-environment signal** — roughly
calibrated (±0.3 run avg error) and they already bake in park, weather, and opposing starter. Hitter
output scales ~**+22% per +1 implied run** above league average (~4.5). (RotoGrinders; FantasyLabs.)

**Verdict:** ✅ Sound — keep as-is. Note it **partially double-counts** opposing-pitcher quality and
weather (both already priced into the line); adjust those only residually.

### 3.5 Park factors — `ProjectionModel.ts` / `parkFactors` table

**Current:** static hardcoded per-park run/HR factors.

**Evidence:** Use **3-year regressed** factors with **handedness splits**. One-year factors swing ±8–12
points from sampling noise alone (FanGraphs regresses 1-yr by ~40%). Effects are large at the extremes
(Coors ≈ +28% runs; some parks ±34% HR; LHB/RHB splits differ wildly, e.g. Cincinnati vs Oracle).
(FanGraphs Library; Baseball Savant park factors; FantasyPros 2025.)

**Verdict:** ⚠️ Upgrade static factors → 3-yr regressed + handedness. For a single game, apply the full
factor (both teams hit in that park).

**Status (F6 done):** the static table is replaced with **3-yr regressed** (deviation × 0.8, FanGraphs
methodology), 1.0-centered factors sourced from Baseball Savant / RotoWire 2024 and dated 2026-06.
`ParkFactorContext` gained optional `hrFactorLHB`/`hrFactorRHB`; a `parkHrFactor(park, bats)` selector
applies the **handedness split** when a batter's `bats` is known, else the overall factor. Two
follow-ups remain: (1) **no batter-handedness source is wired** (`bats` is undefined everywhere today —
needs MLB Stats `batSide`, as legacy does for pitcher hand), so the split is dormant until then; (2)
park is still the batter's _own_ home park as a season proxy — **per-game/opponent-park application**
("both teams hit there") is not yet done.

### 3.6 Batting-order → PA — `ProjectionModel.ts`

**Current:** `battingOrderPa(order) = clamp(4.9 − (order−1)·0.18, 3.4, 4.9)` → 4.9 (leadoff) … 3.5 (#9).

**Evidence (2023 actuals):** leadoff **4.63** → #9 **3.75**, ~16 PA/season (~0.10 PA/game) per slot.
R/RBI opportunity also differs by slot (leadoff highest R/PA, cleanup highest RBI/PA).
(Spaeder 2023; FanGraphs Ottoneu; Smart Fantasy Baseball.)

**Verdict:** ⚠️ Our slope is close but **overweights leadoff** (4.9 vs 4.63) and the range is too wide.
Re-fit to the empirical curve; consider slot-specific R-vs-RBI opportunity as a second-order effect.

**Status (F7 done):** `battingOrderPa` is re-fit to the empirical curve —
`clamp(4.63 − (order−1)·0.11, 3.75, 4.63)` → leadoff 4.63 … #9 3.75. The three figures are named
constants (`LEADOFF_PA_PER_GAME`, `PA_PER_GAME_PER_SLOT`, `NINTH_SLOT_PA_PER_GAME`) sourced from
Spaeder 2023 actuals (latest PA-by-slot dataset as of 2026-06; structural, so re-verify each
preseason). Slot-specific R-vs-RBI opportunity is still **not** modeled (deferred second-order effect).

---

## 4. How Decisions Are Scored

### 4.1 Season value: SGP denominators — `DecisionEngine.ts`

Standings-Gained-Points denominators convert a stat delta into "how much it moves the season standings."
Defaults (overridable by standings-history slopes): `R 35, H 45, HR 12, RBI 35, SB 10, TB 75, OBP 0.01,
OUT 120, K 55, ERA 0.12, WHIP 0.035, QS 6, SV+H 10`. When real slopes are unavailable, the briefing
flags **degraded confidence** (`ManagerBriefing.ts:778`).

### 4.2 Category importance weights — `DecisionEngine.ts`

**Current:** three buckets by win probability — coin-flip (`0.35–0.65`) `1.75`, lean `1.0`,
lock (`≥0.85`)/lost-cause (`≤0.15`) `0.2`.

**Evidence (§1.3, §6):** the correct weight is **continuous** and proportional to the win-probability
gradient (pdf near 50%), not three steps. The bucketing approximates the right shape but introduces
cliffs (a 0.34 vs 0.36 win-prob category jumps 1.0 → 1.75).

**Verdict:** ⚠️ Replace buckets with a smooth weight derived from each category's simulated win-prob
distribution. Keep lock/lost weight **non-zero** (soft-punt — §1.2.3).

**Status (F7 done):** the three buckets are replaced by a continuous `categoryWeight(p)` =
`FLOOR + (PEAK − FLOOR)·φ(z)/φ(0)` where `z = Φ⁻¹(p)` — i.e. the win-prob gradient (pdf at the 0/0
margin threshold). It peaks at a coin-flip (`PEAK = CATEGORY_WEIGHT_PEAK = 1.75`, the old coin-flip
value, so the scale is unchanged) and decays smoothly to a non-zero soft-punt floor
(`FLOOR = CATEGORY_WEIGHT_FLOOR = 0.2`, the old lock/lost value) — no cliff at the old 0.35/0.65
or 0.85/0.15 boundaries. `Φ⁻¹` is Acklam's inverse-normal-CDF approximation (fixed algorithm
constants, not tunable). PEAK/FLOOR remain hand-set priors to fit via F8.

### 4.3 Monte Carlo win probabilities — `DecisionEngine.ts`

~5,000 simulations produce per-category win probabilities and the lock/coin-flip/lost-cause tags. **This
is the engine's most valuable and most underused asset** — it already contains exactly the distribution
needed for §1.3 win-probability ranking and underdog/favorite variance logic.

### 4.4 Add ranking blend (`WEEKLY_WEIGHT_ALPHA`) — `DecisionEngine.ts`

**Current:** `score = 0.75 · weeklyDelta + 0.25 · seasonSgpDelta`.

**Interpretation w.r.t. the scoring model:** the `0.75` weekly term is correct in spirit — standings
_are_ the sum of weekly category outcomes, so this-week impact dominates. The `0.25` season term is the
mechanism for _"don't sacrifice the long-term team"_ (it protects rest-of-season roster value).

**Verdict:** ⚠️ Two fixes. (1) `weeklyDelta` should be **Δ(win probability)**, not Δ(expected output)
(§1.2.2). (2) The split should be **dynamic**: lean more weekly as the week closes / when chasing
flips; lean more season-value early-week and when a category is already locked or hopeless.

### 4.5 Replacement value & guardrails — `TransactionPlanner.ts`

Replacement value is a linear combination of projected weekly stats with ~15 hand-set per-stat
coefficients (e.g. HR `1.4`, SB `0.8`, OBP term `×1.1`), each multiplied by the §4.2 category weight.
Transaction guardrails are hand-set thresholds: `WEEKLY_IP_FLOOR 20`, reserve adds `3`/`2` early/mid
week, drop edges `1.25` (bench) / `3` (active) / `6` (scarce position), streaming ratio limits
(ERA `4.5`/coin-flip `3.95`, WHIP `1.35`/`1.24`), `EMPTY_SLOT_VOLUME_MULTIPLIER 0.35`, etc.

**Verdict:** These encode reasonable baseball judgment (e.g. tighter ratio limits when ERA/WHIP is a
coin-flip is exactly right). They are **the prime candidates for the hybrid backtest calibration** in
§7 — measure, don't guess.

---

## 5. Where the Math Diverges From the Evidence — Roadmap

Priority order by (leverage × confidence):

| #   | Change                                                                                           | File(s)                                                  | Why                                                                                             |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | **Rank by Δ(category win-prob), not Δ(output)**; add underdog/favorite variance logic            | `DecisionEngine.ts`                                      | Directly implements the scoring model; uses sims we already run. Biggest gain, least new infra. |
| 2   | **Stabilization shrinkage** for in-season/Statcast vs projection; wire in dormant recency module | `ProjectionModel.ts`, `legacy/.../recent-performance.ts` | Replaces magic-number multipliers with defensible Bayesian blend.                               |
| 3   | **Playing-time / injury discount** on PA & IP                                                    | `ProjectionModel.ts`                                     | The #1 projection error source; nobody models it.                                               |
| 4   | **Projection blend fix**: add ATC, cut ZiPS, per-category weights                                | `ProjectionModel.ts`, `ProjectionData.ts`                | Top systems are ATC/TheBatX; ZiPS is bottom-tier.                                               |
| 5   | **Park factors**: 3-yr regressed + handedness                                                    | `ProjectionModel.ts`, `parkFactors`                      | 1-yr is noise; handedness splits are large.                                                     |
| 6   | **Continuous category weights** (replace 3 buckets)                                              | `DecisionEngine.ts`                                      | Removes win-prob cliffs; matches marginal-value theory.                                         |
| 7   | **Re-fit batting-order PA curve** to 4.63→3.75                                                   | `ProjectionModel.ts`                                     | Overweights leadoff today.                                                                      |
| 8   | **Backtest + calibrate** all coefficients                                                        | new harness + `decisions`/`retrospectives`/`daily_stats` | Turns "magic numbers" into fitted parameters.                                                   |

---

## 6. Strategy Theory Backing the Scoring Model

- **Marginal value ∝ win-prob gradient; lock/lost ≈ 0 value.** (arXiv 2409.09884 — _Dynamic
  Quantification of Player Value for Fantasy Basketball_; objective `V = Σ_c P(win c)`,
  `P = ½[1 + erf(μ/(√2σ))]` — identical math for baseball categories.)
- **Soft-punt > hard-punt in each-category formats.** Simulation converged to down-weighting, not
  zeroing, because every category contributes to the objective. (arXiv 2409.09884.) Mainstream consensus
  still endorses punting _correlated_ low-value pairs (SB+Saves) at the draft level
  (FantasyPros; TheScore; RotoGraphs).
- **Underdog maximizes variance, favorite minimizes it.** (arXiv 1111.0693; applied to fantasy
  categories in arXiv 2501.00933 — raising σ_D makes μ_D/σ_D less negative for a trailing team, raising
  win prob.) Directly relevant given our 36-83-11 underdog position.
- **Two-start pitchers are the biggest weekly leverage move**; stream risky arms only when the ERA/WHIP
  lead can absorb a bad start (no quantified break-even exists in the literature — a calibration
  opportunity). (FantasyPros; Pitcher List; Mastersball.)

---

## 7. Calibration Approach & AI Roles

**Calibration = hybrid.** Start from the research-informed priors above, then **refine empirically**.
The infrastructure already exists: `decisions`, `retrospectives`, and `daily_stats` tables. A backtest
harness should score predicted-vs-actual weekly category outcomes and **fit** the coefficients in
§3–§4 (blend weights, shrinkage priors, category-weight curve, `WEEKLY_WEIGHT_ALPHA` schedule,
guardrail thresholds) rather than leaving them hand-set.

**AI roles (all three, bounded):**

- **Offline tuner/analyst** — proposes and explains weight changes, runs weekly retrospectives,
  surfaces what the algorithm missed. Lives in the backtest loop; never silently overrides a live move.
- **Runtime override** — may override the engine when contextual signals are strong, gated by
  `config/tuning.json` `llm.overrideEnabled`, with guardrails on _when_ override is allowed.
- **Narrative** — writes the human-readable briefing.

(The LLM layer is currently **wired-for but inactive** — `llm.overrideEnabled: true` exists, evals
exist, but there are zero model calls in `/src`.)

---

## 8. References

**Projection accuracy & blending**

- FantasyPros, Most Accurate Projections — 2023 / 2024 / 2025 results.
- RotoGraphs (FanGraphs): The ATC Projection System; 2024 Projection Reviews (playing time, batter roto,
  pitcher rate/counting stats).
- Hardball Times, _Evaluating the 2014 Projection Systems_.
- SABR, _AggPro: The Aggregate Projection System_.
- MLB Data Warehouse, 2024 Regular Season Projection Scoring.

**Stabilization & regression**

- Russell Carleton (Baseball Prospectus), _It's a Small Sample Size After All_.
- FanGraphs Sabermetrics Library — Sample Size; Regression toward the Mean.
- probabilaball, _Stabilization, Regression, Shrinkage, and Bayes_ (derivation of `B = M/(M+n)`).
- Smart Fantasy Baseball, cautionary notes on stabilization points.
- Pitcher List, relative value of FIP/xFIP/SIERA/xERA.

**Context multipliers**

- RotoGrinders, _How Accurate Are Vegas Implied Totals_; FantasyLabs, Vegas team implied totals &
  pitcher wOBA-allowed.
- FanGraphs Library, Park Factors (5-year regressed) & principles; Baseball Savant Statcast Park Factors;
  FantasyPros 2025 park factors.
- Ryan Spaeder (2023) PA by batting-order slot; FanGraphs Ottoneu PA-by-slot; Smart Fantasy Baseball,
  batting order R/RBI.

**Strategy / decision theory**

- arXiv 2409.09884, _Dynamic Quantification of Player Value for Fantasy Basketball_.
- arXiv 2501.00933, _Optimizing for Rotisserie Fantasy Basketball_.
- arXiv 1111.0693, underdog-variance principle in sports.
- FantasyPros, TheScore, RotoGraphs — punting categories; Mastersball — Marmol (all-RP) strategy.

> URLs for all sources are recorded in the agent research notes; this list is the citation index.
> Findings gathered 2026-06. Re-verify accuracy rankings each preseason (they shift year to year).
