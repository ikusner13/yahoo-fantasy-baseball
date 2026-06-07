# Current-State Audit

A faithful map of what the app **actually does today**, produced by reading the codebase (not the README, which is partly aspirational). Companion to [league-model.md](./league-model.md) (rules), [strategy.md](./strategy.md) (how to win), and [rewrite-plan.md](./rewrite-plan.md) (where we go next).

Method: four parallel read-only audits across all ~40 source files, each tracing callers (WIRED / PARTIAL / DEAD) with `file:line` evidence and flagging mismatches vs the league model. Honesty over generosity — "DEAD" means no callers found.

---

## TL;DR — three structural truths

1. **It's a read-only recommender, not a GM.** Every Yahoo _write_ is dead code. `setLineup()` is reachable only through the test harness with `?apply=1`; `addDrop()`, `claimWaiver()`, `proposeTrade()` have **zero callers**. The app analyzes, formats a Telegram message, logs a decision row, and stops. Nothing is ever applied to Yahoo.

2. **The marginal-value decision engine the strategy calls for exists in pieces but is mostly dead.** `monte-carlo.ts` (per-category flip probability), `opponent-scout.ts` (Locks/Coin-flips/Lost-causes triage), `volatility.ts`, and `playoff-optimizer.ts` are **all DEAD — zero callers**. What actually runs is a daily lineup optimizer scoring players by **z-score (not SGP)** against **snapshot category margins** with static %-thresholds and hand-tuned heuristics.

3. **League state is inferred locally instead of read from Yahoo** — exactly the failure pattern in [league-model.md](./league-model.md). Add budget lives in KV (and resets on every run, not just Monday); waiver priority is **hardcoded to `5`**; empty roster slots are **never computed**; the opponent's roster is **fetched but never parsed** (`getTeamRosters()` result discarded behind a TODO).

Everything below is the evidence.

---

## 1. Architecture as-built

```
Cloudflare Worker (Hono)  — src/worker.tsx
  ├─ HTTP: /auth, /auth/callback, /telegram (webhook), /run/:routine, /preview/:routine, /test
  ├─ scheduled() → src/cron.ts dispatchCron(pattern)
  │
  ├─ src/gm.ts  ← THE MONOLITH (~71KB, 8 routines, all orchestration inline)
  │     reads Yahoo state → fetches data → z-score valuations → analysis → Telegram + decision log
  │
  ├─ Yahoo API     — src/yahoo/{client,auth}.ts   (reads WIRED; writes DEAD except test-harness)
  ├─ Data layer    — src/data/*                    (FanGraphs Steamer, MLB Stats API, Odds API, Savant)
  ├─ Analysis      — src/analysis/*  (17 files)    (much of it DEAD — see §4)
  ├─ AI            — src/ai/*                       (OpenRouter + Anthropic fallback, memory) — WIRED
  ├─ Notifications — src/notifications/*            (Telegram out + webhook) — WIRED
  ├─ Persistence   — D1 (src/db/schema.ts) + KV
  └─ Observability — src/observability/log.ts       (structured logs) — WIRED
```

**Posture:** analyze → recommend → notify. No execution, no closed loop on Yahoo.

---

## 2. Cron cadence (what runs when)

Cron patterns from `src/cron.ts` (Cloudflare crons fire in **UTC** — the README describes them as ET, so there is a **UTC/ET mismatch to verify**; patterns as written below):

| Pattern              | Routine (`gm.ts`)                                                                                                           | Does                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `0 13 * * *`         | `runDailyMorning`                                                                                                           | The workhorse — roster, projections, streaks, lineup, IL, waivers, streaming, summary |
| `0 22 * * *`         | `runLateScratchCheck`                                                                                                       | Re-optimize for late scratches in active slots                                        |
| `0 14 * * 1,5,6,SUN` | day-multiplexed: Mon→`runWeeklyMatchupAnalysis`, Fri→`runTwoStartPreview`, Sat→`runTradeEvaluation`, Sun→`runSundayTactics` | Weekly strategy beats                                                                 |
| `0 19 * * 3`         | `runMidWeekAdjustment`                                                                                                      | Wed category re-check, IP status                                                      |
| `15,45 13-23 * * *`  | `runNewsMonitor`                                                                                                            | Every 30 min — injury/closer/callup alerts, KV-deduped                                |

All 8 routines are WIRED (invoked by both `cron.ts` and the `/run/:routine` HTTP route). `logDecision`/`logDecisionEvent` writes a row to D1 after each action.

---

## 3. Yahoo integration (`src/yahoo/`)

**Auth (`auth.ts`) — WIRED, healthy.** OAuth2: `getAuthUrl`, `handleCallback`, `refreshTokens`, `getValidToken` (auto-refresh with 60s buffer on every request). Tokens in KV (`yahoo-tokens`).

**Reads (`client.ts`) — WIRED:** `getRoster(date?)`, `getMatchup(week?)`, `getStandings()`, `getFreeAgents(pos?, count?)`, `getTeamRosters()`. `getRecentTransactions()` exists but is **DEAD** (no callers).

**Writes (`client.ts`) — effectively DEAD:**
| Method | Callers |
|---|---|
| `setLineup(date, moves)` | test-harness only, gated on `?apply=1` |
| `addDrop(add, drop)` | **none** |
| `claimWaiver(add, drop)` | **none** |
| `proposeTrade(proposal)` | **none** |

**Fragility — positional-index JSON parsing.** Yahoo's XML-shaped JSON is parsed by array position, e.g. `p.player[0]` / `p.player[1].selected_position[1].selected_position.position` (`client.ts:136`), with `// TODO: verify exact shape against live response` at `client.ts:127` and `:262`. Brittle if Yahoo's shape shifts. (Matches [strategy.md §4 gotcha #1](./strategy.md).)

---

## 4. Analysis layer — wired vs dead

This is where the gap between intent and reality is widest. The strategy doc's engine (SGP × Monte-Carlo flip probability) is largely **coded but unwired**.

### WIRED (actually runs)

| Module                  | Role today                                                                                                                             | Notes / issues                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `matchup.ts`            | Classifies each category winning/swing/losing; time-aware `analyzeMatchupDetailed`                                                     | **Static %-thresholds** (counting 15%, rate 5%), **not** flip-probability. `projectedWins = safe.length` (a count, not a probability). `DAILY_PRODUCTION` constants hardcoded. `shouldProtectRatios()` is **DEAD**. Correctly treats each category as 1 point ✓ |
| `valuations.ts`         | `computeZScores`, `applyVarianceAdjustment` (Poisson-CV consistency tweak)                                                             | **Z-scores, not SGP.** Non-standard time-weighted OBP formula `(OBP−avg)×PA`. `DEFAULT_REMAINING_WEEKS=22` hardcoded. `applyPositionalScarcity()` is **DEAD**.                                                                                                  |
| `lineup.ts`             | `optimizeLineup` greedy slot fill + contextual multipliers (BvP, platoon, park, Vegas, streak, marginal rate impact)                   | **Category weights (swing 2.0×/lost 0×) are computed but never applied to the primary z-score path** (`lineup.ts:166` ignores them; only the fallback path uses them) — so "tilt toward swing cats" is aspirational. Many multiplier constants hardcoded.       |
| `streaming.ts`          | `scoreStreamingPitcher`, `rankStreamingOptions`, `shouldStream`, `estimateStreamingImpact`, `getIPStatus`                              | `shouldStream` is a boolean gate (protect-ratios on/off), not a graded risk. Ratio impact estimated _after_ selection, not as a pre-filter.                                                                                                                     |
| `pitcher-pickups.ts`    | `rankPitcherPickups` — multi-start scoring, confidence discount (confirmed 1.0 / probable 0.85 / projected 0.65), 1.5× two-start bonus | Matchup impact is optional and often not passed. No 20-IP/ratio gating. Rotation projection brittle.                                                                                                                                                            |
| `two-start.ts`          | `getTwoStartPitchers` for the week                                                                                                     | `getTwoStartCalendar` (multi-week) **DEAD**. Rotation inference from last-10-days probables fails silently for callups/injuries.                                                                                                                                |
| `il-manager.ts`         | `getILMoves`, `countILSlots`, `getInjuredActivePlayers`                                                                                | Hardcoded 4 IL slots. Uses **ownership% as value proxy** (lags reality). No stash-and-stream. Doesn't distinguish IL-eligible vs DTD.                                                                                                                           |
| `game-count.ts`         | `getWeekSchedule`, `findGameCountEdge` (≥7-game teams)                                                                                 | `analyzeRosterGameCount` and `computeGameCountMultiplier` **DEAD** — games-remaining is **not used to prorate projections**. `AVG_GAMES_PER_WEEK=6.2` hardcoded.                                                                                                |
| `recent-performance.ts` | `computeStreaks`, `getStreakSummary` from Statcast (barrel/HardHit/EV/K%)                                                              | Uses season Statcast, not a recent window. No pitcher-side streaks. Structural-change flags not fed into urgency.                                                                                                                                               |
| `retrospective.ts`      | `buildRetrospective`, `formatRetrospectiveForTelegram`                                                                                 | **Decision-outcome tracking is a stub — always "unknown."** Swing predictions auto-count as "correct," inflating accuracy.                                                                                                                                      |
| `trades.ts`             | `identifyCategoryNeeds`, `identifySurplus`                                                                                             | `findTradeTargets()` (the actual proposal pipeline) is **DEAD**. Trade eval is one-sided (our needs only).                                                                                                                                                      |

### DEAD (zero callers — the missing engine)

| Module                 | What it would do                                                                               | Status                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `monte-carlo.ts`       | `simulateMatchup` → per-category `P(win)`; `compareLineupOptions` → ΔP(win)                    | **DEAD.** Accepts `opponentProjections` but nothing ever passes them; the unused fallback `extrapolateOpponentStats` does naive pace extrapolation (`35 PA/day` hardcoded). Suspicious OBP math at `:523` (`remaining.H / remaining.OBP`). This is the flip-probability core from [strategy.md §3.5](./strategy.md) — coded, never run. |
| `opponent-scout.ts`    | `scoutOpponent`, `getWeeklyMatchupProjection`, `recommendCategoryTilt`                         | **All DEAD.** The Locks/Coin-flips/Lost-causes triage ([strategy.md §2.1](./strategy.md)). Uses z-score sums + arbitrary thresholds (untargetable=3.0).                                                                                                                                                                                 |
| `volatility.ts`        | `analyzeRosterVolatility`, `recommendApproach`, `getVolatilityAdjustedWeights`                 | **All DEAD.** Hardcoded CV/base constants and win thresholds.                                                                                                                                                                                                                                                                           |
| `playoff-optimizer.ts` | `getPlayoffSchedule`, `computePlayoffValues`, `getPlayoffTargets`, `shouldActivatePlayoffMode` | **All DEAD.** Fragile team-name regex; hardcoded `2026-03-30` season start and ±5% buy/sell bands.                                                                                                                                                                                                                                      |

**Consequence:** the live decision path never computes a flip probability, never models the opponent's future production, and never uses SGP. It ranks players by pool-relative z-score and classifies the _current_ scoreboard by fixed margins.

---

## 5. Data layer (`src/data/`)

| Module            | Source / endpoint                                                                                                                         | State                                                                                                                                                                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projections.ts`  | FanGraphs `type=steamerr` (batters + pitchers), 12h cache                                                                                 | **Single-source Steamer only** — not the Steamer/ZiPS/THE BAT/ATC blend the strategy wants. **Full-season ROS, not prorated to the scoring week.** `storeProjections()` is **DEAD** (only `apiCache` is used; the `projections` D1 table isn't populated). |
| `mlb.ts`          | MLB Stats API: `getTodaysGames` (schedule + `hydrate=probablePitcher`), `getInjuries` (14d IL txns), `getTeamSchedule`; 2h schedule cache | WIRED. Also defines the hardcoded `PARK_FACTORS`.                                                                                                                                                                                                          |
| `matchup-data.ts` | MLB Stats API: BvP, platoon splits (`vl/vr`), pitcher hand, team batting stats                                                            | WIRED for our lineup context. `getBatchBvP` is **DEAD**. **Park factors hardcoded** (`PARK_FACTORS`, ~lines 200–231), not dynamic. No caching (live calls each run). Falls back to constants on API failure (K%=.22 etc.).                                 |
| `vegas.ts`        | The Odds API `h2h,totals` → implied team runs → multiplier                                                                                | **PARTIAL.** Implied runs are used **only** to estimate opponent wOBA for _streaming_ (`gm.ts:~542`). `computeVegasMultiplier` is **not wired into daily batter lineup scoring** (the `lineup.ts` Vegas hook receives `undefined`).                        |
| `statcast.ts`     | Baseball Savant leaderboard CSV (xwOBA, barrel%, HardHit%, EV, K%, sprint; pitcher whiff/xwOBA-against), daily cache                      | WIRED → feeds `recent-performance` streaks.                                                                                                                                                                                                                |
| `player-match.ts` | 3-pass name+team matcher (exact → name-only → fuzzy)                                                                                      | WIRED. Confidence is computed but **not consumed** downstream.                                                                                                                                                                                             |
| `player-ids.ts`   | D1 `player_ids` cross-ID store (Yahoo↔MLB↔FG)                                                                                             | WIRED; preserves ids on update.                                                                                                                                                                                                                            |
| `cache.ts`        | D1 `apiCache` generic TTL cache                                                                                                           | WIRED.                                                                                                                                                                                                                                                     |

---

## 6. AI layer (`src/ai/`) — WIRED and reasonably solid

- **`llm.ts`** — `askLLM` / `askLLMJson` / `summarizeForTelegram`. Primary: **OpenRouter** (per-touchpoint model), 15s timeout. Fallback: **Anthropic Claude Haiku**. Final fallback: `[LLM unavailable]`. All logged via `logLLM`.
- **`prompts.ts`** — per-touchpoint system prompts + model routing: lineup/waiver/matchup/summary → **Qwen** (rules-follower); trade → **DeepSeek V3** (tone); injury → **Llama 3.3 70B** (terse). All T=0.3, small token caps.
- **`briefing.ts`** — structures engine output into LLM briefings (matchup/waiver/trade/injury/lineup), appends memory. No API calls; pure formatting.
- **`memory.ts`** — `buildMemoryContext` pulls last ~20 decisions (touchpoint-filtered) + 2 weeks retrospectives + last 2 `gmReflections`; `generateReflection` compresses decisions weekly. WIRED.

**Role:** the engine computes signals; the **LLM is the synthesizer/explainer** and may "override" via narrative — but since nothing executes, "override" only changes the Telegram text.

---

## 7. Persistence (`src/db/schema.ts` + KV)

**D1 tables:** `playerIds`, `projections` (defined but **not populated** — `storeProjections` dead), `decisions` (audit trail), `dailyStats` (unused), `apiCache`, `retrospectives`, `feedback` (`/feedback` command), `gmReflections`, `parkFactors` (**DEAD — never populated or queried**).

**KV keys:** `yahoo-tokens`; `add-budget` (weekly add counters — **local source of truth, the bug**); `sent-alert-keys` (news dedup, 24h TTL).

---

## 8. Notifications (`src/notifications/`) — WIRED

- **`telegram.ts`** — `sendMessage` (4000-char splitting; preview-buffer mode for tests), `handleTelegramWebhook` (`/status`, `/roster`, `/feedback`, trade approve/reject buttons). The trade-approval callback has a **TODO: execute via Yahoo API** — i.e., even the one interactive write path is unimplemented.
- **`action-messages.ts`** — HTML formatters for lineup/IL/pickup/streaming/late-scratch, with Yahoo deep links.

---

## 9. The known bugs, confirmed with evidence

These are the [league-model.md](./league-model.md) "Current Failure Pattern" items, now pinned to code:

1. **Add budget tracked in KV, not read from Yahoo.** `add-budget.ts` `readState()` reads only the `add-budget` KV key; `recordAdd()` increments locally and assumes success. Desyncs on rejected transactions, manual moves, or double-runs. → This is why the app thought adds were used when Yahoo showed `0 of 6`.
2. **`resetWeeklyBudget()` runs every invocation, not just Monday** (`gm.ts:~1264` calls it unconditionally) — mid-week runs can reset the counter.
3. **Waiver priority hardcoded to `5`** (`gm.ts:~789` → `shouldUseWaiverPriority(rec, 5)`). Real rolling priority is never read from Yahoo.
4. **Empty roster slots never computed.** No diff of `ROSTER_SLOTS` totals vs actual entries; logic assumes a full roster → drop-centric waiver behavior even when Yahoo shows open slots.
5. **Opponent roster fetched but discarded.** `getTeamRosters()` is called in `runTradeEvaluation` but the result isn't parsed into valuations (`gm.ts` TODO ~`:1504` / "fetch opponent roster once API parsing is improved"). Trade and matchup analysis are one-sided.
6. **No projection blend, no week-proration** (§5): single Steamer source, full-season numbers used as-is.
7. **Monte-Carlo / opponent / volatility / playoff engines are dead** (§4) — decisions run on snapshot margins, not distributions.
8. **Vegas only half-wired** (§5): not in batter scoring.
9. **Retrospective learning is hollow** (§4): decision outcomes always "unknown"; swing predictions auto-scored correct.
10. **Naming:** pitching save+hold category is `SVHD` in code (= `SV+H` in the league model) — confirm it maps to Yahoo's real stat id.

---

## 10. Honest assessment

The codebase is **well-typed and the plumbing is real** — data ingestion, z-score valuation, daily lineup optimization, Statcast streaks, LLM synthesis, memory, logging, and Telegram all work end-to-end as a **read-only advisory**. But measured against [strategy.md](./strategy.md) and [league-model.md](./league-model.md), three things are missing or wrong:

- **It doesn't act** (no Yahoo writes).
- **It doesn't model the future or the opponent** (the engine that would — Monte Carlo, opponent scouting, SGP — is dead or stubbed; it runs on z-scores and current margins).
- **It doesn't trust Yahoo for state** (budget/priority/empty-slots inferred locally — the source of the original bugs).

The good news for the replan: a lot of the needed engine is **already written and just unwired** (Monte Carlo, opponent scout, volatility, game-count multipliers, playoff optimizer). The rewrite is therefore as much **"wire up + correct + source state from Yahoo + add an execution layer"** as it is net-new code. See [rewrite-plan.md](./rewrite-plan.md) and [decision-engine.md](./decision-engine.md).
