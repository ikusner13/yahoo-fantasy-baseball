# Winning Strategy for This League

This is the strategy source-of-truth, synthesized from four parallel deep-research investigations (Jun 2026): H2H category theory, in-season roster tactics, quantitative/projection modeling, and the Yahoo API/automation surface. It is the _why_ and _how_ behind [league-model.md](./league-model.md)'s product objective. Every nontrivial claim is cited; confidence flags are at the end of each part.

Read [league-model.md](./league-model.md) first for the rules and the rewrite requirements. This document explains how to actually win.

---

## 0. The one fact that reframes everything

**This league is roto, scored weekly — not standard head-to-head.**

In standard H2H-most-categories, a weekly matchup resolves like a 2-team mini-roto: winning 7 of 13 beats losing 6, and a 13-0 blowout is worth exactly the same as a 7-6 squeaker — one matchup win. Margins beyond the deciding category are wasted, which is _why_ punting and "just win the week" tactics work there ([CBS game theory](https://www.cbssports.com/fantasy/baseball/news/fbt-best-strategies-and-game-theory-on-how-to-approach-h2h-points-roto-h2h-categories-salary-cap-leagues/); [FantasyPros roto vs H2H](https://www.fantasypros.com/2026/01/fantasy-baseball-draft-advice-roto-vs-head-to-head-categories/)).

Our league breaks that. Yahoo confirms each category is "1 game per Game Week" and "this weekly win-loss total will be added to a cumulative season record," with standings ranked by win pct = (Wins + 0.5·Ties) / Total Games ([Yahoo H2H scoring](https://help.yahoo.com/kb/head-to-head-scoring-yahoo-fantasy-sln6212.html)). So **every one of the up-to-13 weekly category outcomes is a standings point of equal, linear value.** Turning a 4-9 week into 5-8 is worth exactly as much as turning a 9-4 into a 10-3.

Consequences that drive everything below:

- **The objective function is roto's** — maximize _total category points across the season_ — but with two in-season levers roto lacks: a **weekly opponent** (sets which categories are flippable _this_ week) and a **6-add weekly budget** (lets you redirect at the margin).
- **Margins are worthless; raw counts and flip-probability are everything.** You optimize against the field for roster construction, against this week's opponent for the 6 adds.
- **There is no "decided matchup."** Never coast a won week, never give up a lost week — both are pure standings leakage. This is the single biggest behavioral fix vs. our current passive, last-place pattern.

---

## Part 1 — Category strategy

### 1.1 Never punt for the season

Punting is structurally correct in standard H2H (you only need one category more than the opponent) but **mathematically wrong here**. A 10-million-iteration roto Monte Carlo found that to punt one category and still hit a typical winning score required near-perfection elsewhere — it succeeded **23 times out of 10M** ([RotoGraphs, "There's No Punting in Baseball"](https://fantasy.fangraphs.com/punting-theres-no-punting-in-baseball/)). Our format has the same arithmetic across 13 categories _and_ removes punting's only upside (the binary weekly win), so a punted category is a guaranteed ≈ −1.0 to the record **every week**, ~26 negative results a season.

The only defensible move is a **soft, temporary de-emphasis** of the least-correlated categories when the 6-add budget forces triage — never abandonment.

### 1.2 Movable (counting) vs sticky (ratio) categories

Split the 13 into where adds buy points vs where they don't:

**Counting — movable with adds** (R, H, HR, RBI, SB, TB; K, QS, SV+H, OUT): accumulate, so any added playing time / save-hold opportunity is immediate, permanent points. This is where the 6 weekly adds buy the most marginal standings value.

- HR/R/RBI/TB are **highly correlated** (HR↔RBI ≈ 0.885; the cluster sits ~0.90–0.94) — one power bat moves several at once ([RotoGraphs](https://fantasy.fangraphs.com/punting-theres-no-punting-in-baseball/); [RotoWire categories](https://www.rotowire.com/baseball/article/fantasy-baseball-scoring-categories-breaking-down-category-107182)).
- **SB and SV+H are "siloed"** — least correlated to everything (SV ≈ 1.52, SB ≈ 2.58 total correlation). No other add backfills them, so they must be targeted _deliberately_ — but that same independence makes them the **cheapest standings points when the field neglects them** (our likely situation).

**Ratio — sticky, defend don't chase** (OBP; ERA, WHIP): volume-weighted denominators you cannot "buy" late — a single add is a tiny fraction of your seasonal (or even weekly team) denominator. Manage by **roster quality and start/sit discipline**, not by chasing. Note OBP is sticky but _independent_ (low correlation), so a dedicated high-OBP bat is a clean way to firm it up without distorting other cats.

- **Defensive priority:** one blown streaming start torches _both_ ERA and WHIP for the week — a −2 swing that usually outweighs the +K/+OUT it bought.

### 1.3 SV+H is our cheapest, most-underexploited category

Low transaction activity almost certainly means we're leaving SV+H on the table. It's the least-correlated category, so you can stack it without distorting the roster.

- **Target the arm, not the jersey:** rank relievers by K-BB%, swinging-strike%, Stuff+, and **game Leverage Index (gmLI)**; high-leverage _setup men_ bank holds (plus an ERA/WHIP/K cushion) even without the 9th inning ([Pitcher List Top 300 RP](https://pitcherlist.com/top-300-relievers-for-fantasy-baseball-2026/); [FanGraphs RP leaderboard / gmLI](https://fantasy.fangraphs.com/)).
- **Winning teams generate opportunities** — more leads → more save/hold chances; bias toward relievers on good teams ([RotoBaller SV+HLD](https://www.rotoballer.com/how-to-approach-relievers-in-svhld-fantasy-leagues/714201)).
- **Role volatility is the edge:** "half of competing in saves is simply being on top of bullpen roles." Stash closer handcuffs; a handcuff that inherits the 9th is a free SV+H jump ([RotoBaller](https://www.rotoballer.com/how-to-approach-relievers-in-svhld-fantasy-leagues/714201)).
- **Stream holds weekly** — high-leverage middle relievers are widely available and (unlike SP streaming) usually _help_ ratios.

### 1.4 The 20 IP gate is a floor, not a target

Missing 20 IP forfeits **all six** pitching categories for the week — a catastrophic −6 ([Yahoo usage limits](https://help.yahoo.com/kb/SLN6809.html)). So each week: **clear 20 IP first (≈ two real starts + relief), then optimize.** A reliever-heavy SV+H build can fail the gate — balance RP against enough SP/QS volume.

### 1.5 Marginal category value — the core math

_How many standings points is one extra add in a category this week worth?_

**Standings Gain Points (SGP).** Per category, `SGP_cat(player) = (player_stat − replacement) / SGP_denominator`. The denominator = stat needed to move one standings rung; best practice is the **slope of (category total vs rank) across all 12 teams** via Excel `SLOPE`, not first-vs-last (which overstates it: 9.09 vs 7.20 in the worked example) ([SmartFantasyBaseball intro](https://www.smartfantasybaseball.com/2013/03/create-your-own-fantasy-baseball-rankings-part-5-understanding-standings-gain-points/); [improved SGP](https://www.smartfantasybaseball.com/2014/04/improved-sgp-calculation-formula-part-1/)).

**Ratio-stat SGP is different and can be negative** — model the player's effect on a _full team ratio_: take team-minus-one at league average, add the player, recompute. Worked AVG example: a .300/667-AB hitter → `(1968/7284 − .267)/.0019 = +1.67`; a below-average bat → `−1.58`. ERA/WHIP use the identical method with **team IP** — which is exactly why low-IP relievers barely move ratios and innings-eaters with bad ratios sink you ([SFB ratio stats](https://www.smartfantasybaseball.com/2018/02/more-than-you-wanted-to-know-about-ratio-stats-and-standings-gain-points/)).

**Z-scores** (`(stat − pool_mean)/pool_sd`, rate stats PA/IP-weighted) give near-identical rankings in standard leagues; SGP is preferred because its denominator is calibrated to _our actual standings_ ([Razzball category values](https://razzball.com/category-values/)).

**The league-specific adjustment:** season-long SGP is the _backbone_, but the weekly decision is **probabilistic category flips**, not raw marginal stats. A +2-SGP HR move is **worthless this week** if you're already winning HR 12-3 or losing 3-14. So:

> **Weekly move value ≈ Σ_cat (SGP price of category) × P(this add flips that category's W/L/T vs this opponent).**

SGP gives the season backbone; Monte Carlo (Part 3) gives the weekly flip weighting. Combine them.

_Confidence: high on SGP/ratio math and the punting Monte Carlo; the exact 2019 correlation coefficients are single-source (RotoGraphs) — treat as directional. Our league's actual SGP denominators must be computed from our own standings history — natural next step._

---

## Part 2 — In-season roster tactics

### 2.1 The weekly triage: Locks / Coin-flips / Lost-causes

Before each week, sort all 13 categories into **Locks** (will win regardless), **Coin-flips** (close enough to tip), and **Lost-causes** (will lose regardless). **All add-budget, streaming, and lineup effort goes into the Coin-flips.** An add that pads a Lock or a Lost-cause banks nothing this week — don't spend it there.

### 2.2 Pitcher streaming without wrecking ratios

Selection criteria (cited thresholds):

- **Opponent offense:** target weak/strikeout-prone lineups; hard-avoid elite offenses ([theScore](https://www.thescore.com/news/953604)). Sharp tool: **team wRC+ by handedness** — a ~25+ point split is actionable; a team at ~74 wRC+ vs LHP facing a confirmed lefty is a near-automatic stream ([RotoGraphs wRC+ splits](https://fantasy.fangraphs.com/exploiting-wrc-splits-in-2026/)).
- **Opponent K%:** lineups fanning ~24.5%+ of PAs let even a middling arm rack Ks ([theScore](https://www.thescore.com/news/953604)).
- **Pitcher's own K-rate:** prefer > ~7 K/9 so you bank Ks even in a mediocre line.
- **Park:** hard-avoid hitter parks (Coors above all); favor pitcher parks. Streaming vs Colorado _away from Coors_ is viable ([theScore](https://www.thescore.com/news/953604); [RotoGraphs](https://fantasy.fangraphs.com/exploiting-wrc-splits-in-2026/)).
- **Composite matchup index** (opponent home/away wOBA + last-14-day wOBA + park, 100 = avg) is the standard blend ([RotoGraphs streamers](https://fantasy.fangraphs.com/category/streamers/)).

**The ratio discipline:** extra adds trade rate stats for counting stats ("5 adds ≈ 5 wins + 25 Ks" — [theScore](https://www.thescore.com/news/953604)). That trade is correct **only when ERA/WHIP are already Locks or Lost-causes.** When ratios are Coin-flips, stream only high-floor arms (K-rate + park filters both pass), or don't stream.

_(Vegas total/moneyline and umpire K thresholds are practitioner-standard but I found no citable numeric rule — treat as judgment, not a hard rule.)_

### 2.3 Two-start pitchers — the biggest weekly volume lever

Two starts ≈ 10–14 IP and double the QS lottery tickets from one free roster spot. **In a volume-deciding week, take a mediocre two-start arm over a good one-start arm; in a ratio-deciding week, take the safer one-start arm.** Screen both matchups as non-disasters — a two-start dud uniquely loses K _and_ ERA _and_ WHIP _and_ QS at once ([FantasyPros two-start](https://www.fantasypros.com/mlb/two-start-pitchers.php); [Yahoo "fool's gold"](https://sports.yahoo.com/fantasy/article/fantasy-baseball-2-start-pitcher-rankings-plenty-of-fools-gold-on-the-waiver-wire-for-streaming-this-week-143140021.html)).

- **Lead time:** FantasyPros publishes 1–2 weeks of two-start rankings ahead; RotoGraphs/Pitcher List drop mid-day Friday; probables refresh Friday & Monday. **Plan the skeleton Friday, confirm Sun/Mon.** Days 4–7 are provisional (rainouts, skips, 6-man rotations) — never commit the last add to an unconfirmed second start ([ESPN forecaster](https://www.espn.com/fantasy/baseball/story/_/id/31165100/fantasy-baseball-forecaster-probable-starting-pitcher-projections-matchups-daily-weekly-leagues)).

### 2.4 Hitter streaming for counting stats

Lower-variance than pitcher streaming (only a tiny OBP drag risk).

- **Platoon is the primary lever:** opposite-handed bat vs the starter, worth ~17–32 wOBA points (LHB vs RHP .332, RHB vs LHP .326, same-side .315/.300). Use _team_ wRC+-by-handedness for selection — individual splits are noisy until ~2,000 PA ([ESPN how to stream hitters](https://www.espn.com/fantasy/baseball/story/_/id/26316072/fantasy-baseball-how-stream-hitters); [RotoGraphs](https://fantasy.fangraphs.com/exploiting-wrc-splits-in-2026/)).
- **Opposing-SP thresholds:** wOBA-against > .325 favorable; K-rate < ~21% won't suppress your bat; Expected Game Score ≤ 45 best; for HR/TB target SP HR/9 > 1.3 ([ESPN](https://www.espn.com/fantasy/baseball/story/_/id/26316072/fantasy-baseball-how-stream-hitters)).
- **Park tiers:** > 115 extreme-favorable, 106–115 moderate, 96–105 neutral, < 86 extreme-bad ([ESPN](https://www.espn.com/fantasy/baseball/story/_/id/26316072/fantasy-baseball-how-stream-hitters)).
- **Lineup spot = volume:** stream only hitters batting top-5 in the order ([ESPN](https://www.espn.com/fantasy/baseball/story/_/id/26316072/fantasy-baseball-how-stream-hitters)).

**SB is the single most movable category** — stack a rostered speed specialist into a soft-catcher matchup. League avg ≈ 0.78 SB allowed/game; worst teams ≈ 1.10 (2026 Marlins led, 85% success against). Weight the pitcher's SB-allowed rate too (slow delivery + WHIP). One extra SB frequently flips the category in a tight week ([Yahoo SB tollbooth](https://sports.yahoo.com/articles/fantasy-baseball-2026-stolen-tollbooth-231724675.html); [FantasyAlarm SB report](https://www.fantasyalarm.com/articles/mlb/streaks-trends/mlb-stolen-base-report-teams-pitchers-players-target-may-30-2026/190854)).

### 2.5 Add-budget optimization (6/week is the binding constraint)

Each add is a scarce token whose shadow price _rises_ as the week progresses and game-opportunities shrink. Sequencing:

- **Mon–Tue:** spend only on (a) confirmed two-start arms and (b) injury/role fills for empty active slots (an empty slot leaks volume all week). **Reserve 2–3 adds.**
- **Hold the reserve for Thu–Sun:** by mid-week you can _see_ the 2–3 Coin-flip categories and spend reserved adds to flip exactly those. Burning all six by Tuesday forfeits this optionality — the classic mistake.
- **The 6th add is worth the most** — deploy Sat/Sun on the single tightest remaining category. Never waste it early on a speculative stash.

An add is "worth it" only when its expected contribution has a realistic chance of flipping a Coin-flip. Target near-full utilization of the 6 every week — passivity is the canonical last-place cause and unspent adds are unscored points ([RotoGraphs waiver coverage](https://fantasy.fangraphs.com/category/waiver-wire-2/)).

### 2.6 Waiver vs free-agent and priority opportunity cost

Free-agent pickups don't touch waiver order; **claims cost priority** ([ESPN waiver mechanics](https://support.espn.com/hc/en-us/articles/360000093771-Waiver-Order-Free-Agent-Budget-Tiebreaker)). Yahoo weekly waivers clear ~11:59pm PT Tuesday; the winner drops to the back ([Yahoo waivers](https://help.yahoo.com/kb/SLN6811.html)).

- **Burn priority only on genuine difference-makers** (a newly-anointed closer → SV+H; a clear breakout SP). Route all streamers/short-term plays through free agency (priority-free). Most FAs aren't worth a claim ([RotoWire waiver wire](https://www.rotowire.com/baseball/article/waiver-wire-fantasy-baseball-109143)).
- Treat rolling priority like a finite FAAB balance: each top-of-order position is a one-time spend.

### 2.7 IL slots = free roster real estate (stash-and-stream)

Four IL slots convert injured stashes into active streaming slots at no cost to the active roster ([RotoWire stashing](https://www.rotowire.com/baseball/article/stashing-players-in-fantasy-baseball-107668)). Moving an injured starter to IL opens an active slot for this week's streamer; reverse on return. **But every move still counts against the 6 adds** — IL frees _roster space_, not _transactions_. In a cumulative format there's no playoff cliff, so bias freed slots toward active volume over speculative stashes unless the stash is a real difference-maker.

### 2.8 Schedule / games-remaining exploitation

In a daily-lineup volume format, games-remaining is a category lever most managers ignore. Use a **schedule grid** ([Baseball Monster](https://baseballmonster.com/schedulegrid.aspx)) to roster the back of the bench by _schedule_ (most games / doubleheaders / fewest off-days), not talent — extra PAs and innings are free counting stats. Fill **every active slot every day**; an open slot on a game day is lost volume.

_Confidence: high on the cited numeric thresholds (wRC+, park tiers, K-rate, SB-allowed, wOBA splits); Vegas/umpire streaming thresholds are uncited judgment; the Athlon "two non-terrible matchups" framing rests on a search snapshot (page 403'd)._

---

## Part 3 — Quantitative engine

### 3.1 Projection systems and blending

Most-accurate (FantasyPros 2024 blind contest, lower = better): **THE BAT X (−1.874) > Zeile > ATC > Draft Buddy > Depth Charts > Steamer > Razzball > ZiPS DC**. Split by side: **THE BAT X dominates hitters; Zeile/ATC lead pitchers** ([FantasyPros 2024 results](https://www.fantasypros.com/2025/02/most-accurate-fantasy-baseball-projections-2024-results/)). FanGraphs' separate _profitability_ comparison has ATC winning 2022–23 — note "effectiveness differs from accuracy" ([RotoGraphs game-theory comparison](https://fantasy.fangraphs.com/2023-projection-systems-comparison-a-game-theory-approach/)).

**Recommendation:** blend **THE BAT X + Steamer + ZiPS DC + ATC (rest-of-season variants)**, weighted **per category** — lean THE BAT X on hitting cats, ATC/consensus on pitching cats. All are free to view and update daily on FanGraphs; use the `r`-suffixed ROS URLs (`steamerr`, `rthebatx`, `ratcdc`, `zipsdc`) ([FanGraphs projections](https://www.fangraphs.com/projections)). No public system projects a single week — you must prorate.

### 3.2 Prorating ROS → scoring period

**Counting (hitter):** `PA_week = (ROS_PA/G_ros)·G_week`, then `Stat_week = (ROS_Stat/ROS_PA)·PA_week`, counting only expected starts. **Counting (SP):** unit is the _start_ — `IP_week = (ROS_IP/ROS_GS)·Starts_week`, `K_week = (ROS_K/ROS_IP)·IP_week`, `OUT_week = IP_week·3`.

**Rate stats — never average rates.** Accumulate numerator/denominator separately:

- `OBP_week = Σ(H+BB+HBP) / Σ(AB+BB+HBP+SF)`
- `ERA_week = 9·ΣER / ΣIP`
- `WHIP_week = (ΣBB+ΣH) / ΣIP`

Each player weighted by expected denominator (PA / IP) — a low-IP reliever barely moves weekly ratios; a two-start ace dominates them.

**SV+H:** `E[SV+H]_week ≈ E[appearances]·P(opp | role)·P(convert)`; drive `P(opp|role)` from gmLI + bullpen depth charts, convert ≈ 85–90% for established arms (tune from data). **QS:** map projected WHIP/ERA → QS% (e.g. ~1.15 WHIP → ~68% QS), adjust by opponent implied total + park ([Predicting Quality Starts](https://www.angelineprotacio.com/portfolio/quality-starts/)).

### 3.3 Matchup inputs, ranked by predictive value

- **High — Vegas implied team totals:** derive from total + spread; hitters produce value at implied > 4 (peak 5.1–6.0), pitchers best when _opponent_ implied ≤ 4. Best single input because the market already prices lineup/pitcher/park/weather — but a team beats its implied total only ~49–50% of the time, so it's directional ([FantasyLabs](https://www.fantasylabs.com/articles/mlb-vegas-data-overunders-team-implied-totals/); [FantasyTeamAdvice](https://fantasyteamadvice.com/daily-fantasy-baseball/mlb-implied-runs); [RotoGrinders accuracy](https://rotogrinders.com/articles/mlb-dfs-how-accurate-are-vegas-implied-totals-1967459)).
- **High — platoon splits:** most stable matchup driver (~20–30 wOBA pts).
- **High — park factors:** FanGraphs 5-yr regressed, half-weight, handed; Savant Statcast park factors stabilize faster via batted-ball quality ([FanGraphs Library](https://library.fangraphs.com/principles/park-factors/); [Savant park factors](https://baseballsavant.mlb.com/leaderboard/statcast-park-factors)).
- **Moderate:** opposing-pitcher/team pitch-type & handedness aggregates (not raw BvP); weather (mostly already in Vegas totals).
- **Low:** umpire zone, catcher framing — skip for v1.

**Takeaway: Vegas implied totals + platoon + park capture nearly all actionable signal.**

### 3.4 Statcast regression overlay (buy-low / sell-high)

Use actual-minus-expected gaps to override stale projections: hitters > .030 xwOBA gap, pitchers > 0.50-run xERA gap (1.00+ = screaming). Barrel% predicts future HR (r ≈ .609). Trust 200+ PA/BF gaps far more than 50-PA ([Savant expected stats](https://baseballsavant.mlb.com/leaderboard/expected_statistics); [Oddsmyth xwOBA](https://oddsmyth.ai/guides/xwoba); [MLB Prediction Statcast guide](https://mlbprediction.com/statcast-metrics-analytics-guide.html)).

### 3.5 Monte Carlo — distributions, not point estimates

Point estimates can't answer the real question (flip probability). Method:

1. Per player/category, build an outcome **distribution** (Poisson/neg-binom for counting; numerator/denominator draws for rates).
2. Simulate the full scoring period **N ≥ 5,000×** for your roster vs the opponent's projected roster; sum each of 13 categories per iteration.
3. Per category: `P(win) = #(you > opp)/N`, plus `P(tie)`.
4. `WeeklyExpCatPoints = Σ_c [P(win_c) + 0.5·P(tie_c)]`.

**Marginal value of a move** = re-simulate with the candidate swapped in: `ΔWeeklyExpCatPoints`. A move that raises mean HR helps _nothing_ if `P(win HR)` is already 0.02 or 0.98 — concentrate moves where `P(win) ≈ 0.5`. High-variance cats (SB, SV+H, weekly HR) have the most flippable outcomes ([SharpAlpha Monte Carlo intro](https://sharpalpha.substack.com/p/an-intro-to-monte-carlo-simulation); [MLB game-sim](https://mlbprediction.com/mlb-game-simulation-models.html)).

**Combine weekly + season:** `combined = α·ΔWeeklyExpCatPoints + (1−α)·ΔSeasonSGP`. Raise α late-season / in tight matchups; lower it early when accumulation dominates.

### 3.6 Data-source stack (free/public)

| Source                   | Endpoint                                                                                                                 | Notes                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MLB Stats API**        | `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=…&hydrate=team,linescore,probablePitcher`                       | Free, no key; undocumented but stable. Core feed for probables / two-start detection / games-remaining. Stats default to 50 rows — paginate. ([docs](https://docs.statsapi.mlb.com/)) |
| **Baseball Savant**      | `/statcast_search/csv`, `/leaderboard/expected_statistics`, `/leaderboard/rolling`, `/leaderboard/statcast-park-factors` | 30,000-row cap per query — chunk by date. ([csv-docs](https://baseballsavant.mlb.com/csv-docs))                                                                                       |
| **FanGraphs**            | `/projections?type={steamerr\|rthebatx\|ratcdc\|zipsdc}`                                                                 | All systems + ROS free to view, daily updates. Full CSV export likely membership-gated (verify).                                                                                      |
| **The Odds API**         | `/v4/sports/baseball_mlb/odds?regions=us&markets=h2h,totals&apiKey=…`                                                    | Free tier 500 credits/mo; pull totals+h2h → implied team totals. ([the-odds-api](https://the-odds-api.com/))                                                                          |
| **Bullpen roles / gmLI** | FanGraphs RP leaderboard (Win Probability stats); RotoBaller / Fantasy Alarm depth charts                                | gmLI is the quantitative role signal for SV+H.                                                                                                                                        |
| **Weather**              | Open-Meteo (free, no key) by ballpark lat/long                                                                           | Low marginal value if using Vegas totals.                                                                                                                                             |

_Confidence: high on SGP/ratio math, projection rankings, API endpoints/limits, Vegas & Statcast thresholds, park methodology, gmLI; medium on the QS%↔WHIP map (single-model) and SV+H convert assumption (calibrate from data); ATC per-category weights are proprietary._

---

## Part 4 — Yahoo API & automation (read/write the true state)

This part directly fixes the [league-model.md](./league-model.md) "Current Failure Pattern": KV add-budget drift, assumed waiver priority, drop-centric logic against empty slots.

### 4.1 Auth & resource model

OAuth 2.0, 3-legged for user data. **Access tokens expire ~1 hour** — store the refresh token (KV/D1), refresh-on-401 ([yahoo-fantasy node docs](https://y-fantasy-node-docs.vercel.app/)). Base host `https://fantasysports.yahooapis.com/fantasy/v2/`, append `?format=json` for reads. Keys: game `mlb`, league `mlb.l.62744`, team `mlb.l.62744.t.12` ([developer guide](https://developer.yahoo.com/fantasysports/guide/); [yahoo-fantasy-baseball-reader](https://github.com/edwarddistel/yahoo-fantasy-baseball-reader)).

### 4.2 Which resource gives which state (read)

| State                      | Resource                                                                         | Note                                                                     |
| -------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------- |
| Roster + positions         | `team/{key}/roster;week=` or `;date=`                                            | `selected_position`, `eligible_positions`, `status`                      |
| **Empty slots**            | **Derived** — diff roster `selected_position` set vs settings `roster_positions` | No "empty slot" field. **This is the drop-centric-bug root cause.**      |
| IL usage                   | roster call; `selected_position` ∈ {IL, IL+}                                     |                                                                          |
| **Adds used vs limit**     | `team/{key}` → `number_of_moves`; settings → `max_weekly_adds`                   | **Read every run — never track in KV.** Fixes the "0 of 6" disagreement. |
| **Waiver priority / FAAB** | `team/{key}` → `waiver_priority` / `faab_balance`; settings → `waiver_type`      | Read, don't assume.                                                      |
| Matchup category scores    | `team/{key}/matchups;week=` or `league/{key}/scoreboard;week=`                   | per-category `stat_winners`, `team_stats`                                |
| Stat categories (our 13)   | `league/{key}/settings` → `stat_categories`                                      | map `stat_id` → abbr                                                     |
| Standings                  | `league/{key}/standings`                                                         |                                                                          |
| FAs / waivers              | `league/{key}/players;status=A                                                   | W`                                                                       | paginate 25/page |

### 4.3 Writes (XML body even though reads are JSON)

POST `league/{key}/transactions` for add / drop / `add/drop` / `waiver` (with `<faab_bid>` or priority); PUT `team/{key}/roster;date=` to set lineup; PUT `transaction/{key}` to edit a pending claim; propose/accept/reject trade via transactions. After any write, **re-read `number_of_moves`, `faab_balance`, `waiver_priority`, and roster to confirm** — never trust local state ([yahoo_fantasy_api write reference](https://yahoo-fantasy-api.readthedocs.io/en/latest/yahoo_fantasy_api.html)).

### 4.4 Library decision

No mature JS/TS library does writes, and the leading Node lib isn't edge-compatible. **Call the REST API directly with `fetch` from the Worker:** Bearer auth, refresh-on-401, `?format=json` reads, hand-built XML write bodies. Port yfpy's recursive JSON-flattening to TS to tame Yahoo's XML-shaped JSON; mine the Python `yahoo_fantasy_api` source for exact write payloads.

### 4.5 Probables, news, late scratches

- **Probables / schedule:** MLB Stats API `hydrate=probablePitcher`. Trust 2–3 days as near-certain; days 4–7 provisional — re-poll daily.
- **News/injury/lineups:** MLB Stats API is the best _free_ source (roster `status`, boxscore lineups). Yahoo player notes come free via the player resource. **Sleeper API is NFL-only — unusable for MLB.** Rotowire/FantasyPros are paid/no-free-API.
- **Late-scratch detection:** Yahoo lock = each player's game start minus 5 min ([Yahoo deadlines](https://help.yahoo.com/kb/transaction-lineup-deadlines-yahoo-fantasy-sln6775.html)). Poll official MLB lineups in the final ~60–90 min before first pitch; a starter absent from the posted lineup = scratch. Dedupe news by `(player_id, news_updated)`.

### 4.6 Scheduling (Cloudflare Workers)

Cron Triggers → one `scheduled()` handler branching on `controller.cron`. **Max 3 cron schedules per Worker** (5 triggers/account free, 250 paid) — split functions across Workers or use one frequent cron that decides internally. Suggested cadence: hourly news+probables; every 10–15 min midday→night for pre-lock scratch checks; daily AM for baseline lineup + authoritative state read; weekly at matchup rollover for the matchup/streaming plan. **Idempotency:** re-read Yahoo state + check a D1 ledger keyed by `(date, player_key, action)` before any write ([Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).

### 4.7 Risk / human-in-the-loop

Undocumented rate limits — throttle/cache, back off on blocks. Refresh-on-401 mandatory; alert via Telegram on auth failure. ToS doesn't explicitly prohibit single-account automation but isn't fully retrievable — review before fully autonomous writes. **Auto-execute low-risk** (lineup sets, IL moves for confirmed injuries, bench/active swaps); **require approval** for trades, drops, FAAB above a threshold, and any add that consumes the weekly limit.

_Confidence: high on auth/resource model, the read→state map, write verbs, library decision, scheduling limits; field tags (`number_of_moves`, `max_weekly_adds`, `waiver_priority`), IL codes, and exact write XML are flagged UNVERIFIED in source — confirm against live API responses (the official guide now redirects and Wayback was unreachable)._

---

## Mapping to the rewrite

How these findings drive the [league-model.md](./league-model.md) rewrite requirements:

1. **League-state snapshot from Yahoo (§4.2)** — read roster, computed empty slots, IL usage, `number_of_moves`, `waiver_priority`, matchup category scores, week boundaries every run. Kills all three current bugs.
2. **Per-category EV scoring (§1.5, §3.5)** — `combined = α·ΔWeeklyExpCatPoints + (1−α)·ΔSeasonSGP`. SGP denominators computed from our standings history; Monte Carlo flip probabilities per category.
3. **Weekly triage state (§2.1)** — every category tagged Lock / Coin-flip / Lost-cause; all recommendations target Coin-flips.
4. **Empty-slot urgency (§2.8)** — open active slot on a game day = quantified lost volume → urgent add.
5. **Schedule-volume scoring (§2.8, §3.2)** — games-remaining and probable-start counts feed the weekly proration for both batters and pitchers.
6. **Add-budget sequencing (§2.5)** — reserve 2–3 adds for late-week Coin-flip flips; the 6th add is highest-value Sat/Sun; target near-full weekly utilization.
7. **Separate decision paths (§2.6)** — free-agent add (priority-free) vs waiver claim (burn priority only on difference-makers) vs add/drop, surfaced distinctly with the affected categories named.
8. **SV+H program (§1.3)** — dedicated reliever module: gmLI + depth charts, setup-men-for-holds, closer handcuffs.
9. **Pitcher-streaming guardrails (§2.2–2.3)** — matchup/skills/park/ratio filters; two-start planning Friday; ratio protection gated on Coin-flip state; 20-IP floor enforced first.
10. **Daily "what category points can we still gain?" report (§3.5)** — driven by Monte Carlo `P(win)` deltas, recomputed daily as probables/scratches/margins change.
11. **Data pipeline (§3.6)** — MLB Stats API + Savant + FanGraphs ROS blend + The Odds API + gmLI, ingested daily.
12. **Safety (§4.7)** — auto lineup/IL; human approval for adds/drops/claims/trades, with category rationale and transaction-type label.

---

## Open items before/while building

- **Compute our actual SGP denominators** from this league's standings history (`SLOPE` over all 12 teams per category) — sharpens every marginal-value calc.
- **Confirm Yahoo field tags and write XML** against live API responses (flagged UNVERIFIED): `number_of_moves`, `max_weekly_adds`, `waiver_priority`, `faab_balance`, IL position codes, transaction bodies, refresh-token lifetime, rate limits, ToS automation language.
- **Calibrate** the QS%↔WHIP map and SV+H conversion rate from real data rather than the cited single-model/illustrative values.
- **Tune α** (weekly-flip vs season-SGP weight) empirically; expect higher late-season.
