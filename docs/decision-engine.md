# Decision Engine Spec

The quantitative core: how the app converts raw data into a **per-category marginal-value score** for every candidate move, and ranks moves to maximize expected cumulative category points. This is the formal version of [strategy.md](./strategy.md) Part 3, scoped to implementation. Consumed by Phase 2–3 of [rewrite-plan.md](./rewrite-plan.md).

**Objective (restated):** maximize expected **cumulative category wins + ties** across the season. Each week contributes up to 13 independent W/L/T results to the standings record, every one an equal, linear point. So the engine optimizes a blend of _this week's_ category flips and _season-long_ category accrual.

---

## Pipeline overview

```
(1) Blend ROS projections        THE BAT X + Steamer + ZiPS DC + ATC, per-category weights
        │
(2) Prorate to scoring period    × expected PA (hitters) / starts (pitchers); accumulate num/denom for rates
        │
(3) Per-player per-category       outcome DISTRIBUTIONS (not point estimates)
    distributions
        │
(4) Monte-Carlo the matchup       simulate our roster vs opponent's projected roster, N≥5000
        │                          → P(win_c)+0.5·P(tie_c) per category
        │
(5) Marginal value of a move      ΔWeeklyExpCatPoints (re-sim with candidate) +  ΔSeasonSGP backbone
        │
(6) Rank & constrain              respect roster/positions/IL/20-IP/6-add; concentrate where P(win)≈0.5
```

Inputs come from `LeagueState` (Yahoo truth) and `DataServices` (MLB/FG/Odds/Savant). Output is a ranked list of typed moves with per-category rationale.

---

## 1. Projection blend

Pull **rest-of-season** variants from FanGraphs (`steamerr`, `rthebatx`, `ratcdc`/ATC DC, `zipsdc`). Blend **per category**, weighting toward the system that's historically best for that side:

- **Hitting categories** → lean THE BAT X (best 2024 hitter accuracy).
- **Pitching categories** → lean ATC / consensus.

A simple per-category weighted mean already beats most single systems. Store the blend; refresh daily (sources update daily). Replaces today's single-Steamer fetch ([current-state.md §5](./current-state.md)).

---

## 2. Prorate ROS → scoring period

Never use full-season numbers directly (today's bug). Convert each player's ROS line to **expected production for this scoring period** using the MLB schedule + probables from `LeagueState`.

**Hitter counting stats** (R, H, HR, RBI, SB, TB):

```
PA_week   = (ROS_PA / G_ros) × G_week        # G_week = expected games started this period
Stat_week = (ROS_Stat / ROS_PA) × PA_week
```

`G_week` from the team schedule (games remaining); only count expected starts (platoon/lineup-spot aware).

**Starting pitcher counting stats** (K, OUT, QS) — unit is the _start_:

```
Starts_week = probable starts in the period (two-start weeks ≈ 2×)
IP_week     = (ROS_IP / ROS_GS) × Starts_week
K_week      = (ROS_K / ROS_IP) × IP_week
OUT_week    = IP_week × 3
```

**Rate stats — accumulate components, never average rates:**

```
OBP_week  = Σ(H+BB+HBP) / Σ(AB+BB+HBP+SF)
ERA_week  = 9·ΣER / ΣIP
WHIP_week = (ΣBB+ΣH) / ΣIP
```

Each player weighted by expected denominator (PA / IP): a low-IP reliever barely moves weekly ratios; a two-start ace dominates them.

**SV+H:** `E[SV+H]_week ≈ E[appearances] · P(opportunity | role) · P(convert)`, with `P(opportunity|role)` from gmLI + bullpen depth charts and convert ≈ 0.85–0.90 (calibrate). **QS:** map projected WHIP/ERA → QS probability per start (≈1.15 WHIP → ~68% QS), adjust by opponent implied total + park; `E[QS] = Σ_starts P(QS|start)`.

**Matchup multipliers** applied to expectations (ranked by predictive value, [strategy.md §3.3](./strategy.md)): Vegas implied team totals (highest signal — also wire into batter scoring, not just streaming), platoon/handedness, park (handed, half-weight). **Statcast overlay:** shrink toward expected stats where actual−expected gap is large (>.030 xwOBA hitters, >0.50 xERA pitchers) at 200+ PA/BF.

---

## 3. Standings Gain Points (season backbone)

SGP converts a stat into standings-rung movement, calibrated to **our** league.

**Counting stats:**

```
SGP_cat(player) = (player_stat − replacement) / SGP_denominator_cat
```

Derive each `SGP_denominator_cat` as the **slope of (category total vs final rank)** across all 12 teams (Excel `SLOPE` / linear regression), using our standings history — _not_ first-vs-last (which overstates it). This is an **open item**: compute from real league data before trusting SGP magnitudes.

**Rate stats (OBP, ERA, WHIP) — model the player's effect on a full team ratio** (can be negative). Team-minus-one at league average, add the player, recompute, divide by the ratio's SGP factor. ERA/WHIP use team **IP** as the denominator — which is exactly why a single ratio add's SGP is tiny and ratios are "sticky."

**Total season value** = `Σ_cat SGP_cat`. (Z-scores are kept only as a fallback ranker; SGP is preferred because its denominator is calibrated to our standings.)

---

## 4. Monte-Carlo flip probability (weekly weighting)

Point estimates can't answer the real question. For the current matchup:

1. Per player/category, build an **outcome distribution** — Poisson/neg-binomial around the prorated counting mean; numerator/denominator draws for rates. (`monte-carlo.ts` already does most of this — Phase 3 wires it to real opponent projections and fixes the OBP draw at `:523`.)
2. Simulate the full scoring period **N ≥ 5000×** for **our roster vs the opponent's prorated roster** (built via the same §1–2 pipeline — _not_ the dead naive pace-extrapolation).
3. Per category: `P(win_c) = #(we > opp)/N`, plus `P(tie_c)`.
4. `WeeklyExpCatPoints = Σ_c [P(win_c) + 0.5·P(tie_c)]`.

**Triage** (revived `opponent-scout` driven by `P(win)`, not z-sums): Lock (`P(win)≳0.85`), Coin-flip (`~0.35–0.65`), Lost-cause (`≲0.15`). All add/stream/lineup effort targets **Coin-flips**.

---

## 5. Marginal value of a move

For each candidate (add / drop / start / sit / stream), re-simulate with the candidate swapped in:

```
ΔWeeklyExpCatPoints(move) = E[catpoints | roster+move] − E[catpoints | roster]
```

A move that raises mean HR is worth ~0 if `P(win HR)` is already 0.02 or 0.98 — value concentrates where `P(win)≈0.5`. High-variance categories (SB, SV+H, weekly HR) have the most flippable outcomes.

**Combine weekly flips with the season backbone:**

```
MoveScore = α · ΔWeeklyExpCatPoints  +  (1−α) · ΔSeasonSGP
```

- `ΔSeasonSGP` = change in `Σ_cat SGP` from rostering the player rest-of-season (keeps us accruing category wins all season, not over-fitting one week).
- **α** rises late-season and in tight matchups; lower early when accumulation dominates. Tune empirically (Phase 6).

---

## 6. Ranking & hard constraints

Rank candidate moves by `MoveScore`, subject to:

- **Roster/position/IL eligibility** and open-slot availability (from `LeagueState` computed empty slots).
- **20-IP weekly floor first** — never let a pitching plan drop below it (forfeits all 6 pitching categories).
- **6-add budget** (real count from Yahoo) with sequencing: reserve 2–3 adds for late-week coin-flips; 6th add highest-value Sat/Sun.
- **Ratio protection**: a streaming start that risks ERA _and_ WHIP in coin-flip weeks must clear K-rate + park filters or be rejected (a dud is a −2 swing).
- **Transaction type** routed correctly: free-agent add (priority-free) vs waiver claim (burns real priority) vs add/drop.

Output: ranked, typed moves, each naming the affected categories and the `MoveScore` breakdown (weekly Δ vs season Δ).

---

## Reused vs new code

| Stage         | Existing code                                                           | Action                                                 |
| ------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| 1 Blend       | `data/projections.ts` (Steamer only)                                    | Extend to multi-source blend                           |
| 2 Prorate     | `game-count.ts` multipliers (DEAD), `mlb.ts` schedule/probables (wired) | Wire multipliers; add proration                        |
| 3 SGP         | none (only `valuations.ts` z-scores)                                    | New; compute denominators from standings               |
| 4 Monte-Carlo | `monte-carlo.ts` (DEAD, OBP bug, naive opp fallback)                    | Wire to real opp projections; fix math                 |
| 4 Triage      | `opponent-scout.ts` (DEAD, z-sum based)                                 | Revive driven by `P(win)`                              |
| 5 Marginal    | `compareLineupOptions` (DEAD)                                           | Generalize to all move types                           |
| 6 Constraints | `add-budget.ts`, `streaming.ts`, `il-manager.ts` (wired, partial)       | Source budget/priority from Yahoo; enforce 20-IP first |

---

## Confidence flags (carried from research)

- **High:** SGP/ratio math, projection accuracy ranking, proration formulas, Monte-Carlo method, Vegas/Statcast thresholds.
- **Medium / calibrate from data:** QS%↔WHIP map (single-model example), SV+H conversion ≈0.85–0.90 (illustrative), α weighting.
- **Open before trusting magnitudes:** our league's actual SGP denominators (compute from standings history); ATC's per-category weights are proprietary (approximate).
