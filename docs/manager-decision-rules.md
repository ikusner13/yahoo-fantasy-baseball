# Manager Decision Rules

This file records the research-backed rules the manager currently enforces in code. It is deliberately narrower than `strategy.md`: each rule below should correspond to a user-facing decision or suppression in the daily briefing.

## Sources Used

- Yahoo roster and lineup deadlines: Yahoo says lineup edits depend on league settings and player game start deadlines; active lineup stats are what count. Source: <https://help.yahoo.com/kb/transaction-lineup-deadlines-yahoo-fantasy-sln6775.html>
- Yahoo H2H categories: each scoring category produces a weekly win, loss, or tie that contributes to the record. Source: <https://help.yahoo.com/kb/head-to-head-categories-points-sln6212.html>
- H2H category aggression and acquisition budgeting: expert H2H guidance supports active daily management, saving some add capacity for late-week category swings, and streaming where league settings allow it. Source: <https://www.fantasypros.com/2016/02/fantasy-baseball-head-to-head-strategy/>
- Pitcher streaming risk: current streaming guidance emphasizes matchup selection, counting-stat upside, ratio risk, and not cutting meaningful long-term contributors for short-term streams. Source: <https://www.rotowire.com/baseball/article/fantasy-baseball-strategy-stream-pitchers-efficiently-116461>
- Two-start/streaming pitcher use: expert waiver guidance treats two-start pitchers and weak opponents as volume levers, with explicit risk management. Source: <https://www.fantasypros.com/2025/04/fantasy-baseball-streaming-two-start-pitchers/>

## Enforced Rules

0. **Optimize cumulative category points, not binary weekly matchup wins.**
   - Evidence: this Yahoo format records every category result into the season record. A 5-8 week is better than 4-9 even though both are ordinary matchup losses.
   - App behavior: `DecisionEngine` computes `expectedCategoryPoints = Σ(P(win) + 0.5 * P(tie))` across categories, and transaction planning targets realistic category improvements rather than “win/loss this week” labels.
   - Scope: this rule governs the regular season. Playoffs may require a separate mode because weekly advancement can make binary matchup survival more important than cumulative category accumulation.

1. **Fix illegal or unavailable active lineup slots before transaction churn.**
   - Evidence: Yahoo active lineup stats count, and players lock by game deadline.
   - App behavior: `DailyLineupAdvisor` identifies active IL/O/NA players and recommends internal IL/bench moves before add/drop actions.

2. **Do not drop long-term value for a short-term category guess.**
   - Evidence: streaming is useful in H2H, but RotoWire explicitly frames it as a short-term fix and warns against cutting players likely to be immediately picked up by another team.
   - App behavior: add/drop recommendations must beat replacement/drop thresholds and scarce-position protection before appearing.

3. **Open bench capacity is useful, but not sufficient by itself.**
   - Evidence: daily H2H management rewards active volume and roster flexibility, but an add still has opportunity cost in a 6-add league.
   - App behavior: open-BN adds are suppressed when the player has no credible category value. The briefing records them under `Skipped` instead of presenting them as a decision.

4. **Optional start/sit projection swaps require a clean, fully unlocked slate.**
   - Evidence: Yahoo lineup changes are deadline-sensitive by player game start. Without player-level lock data, a partially started MLB slate is not enough evidence to tell the user to make speculative start/sit swaps.
   - App behavior: projection-only `Start X over Y` suggestions are shown only when there are no hard-unavailable active players and `todayGameWindow.remainingGames === todayGameWindow.games`. Otherwise they are suppressed.

5. **When a lineup move is shown, it should be a decision, not a candidate.**
   - Evidence: active daily management is a durable H2H edge; user-facing output should not hand back the same analysis burden when the app already has Yahoo state.
   - App behavior: Telegram uses imperative manager language for internal Yahoo-state moves and does not print `Confirm`, `Verify`, `Check:`, or `Stop if:` lines.

6. **Category targeting beats generic best-player adds late in the week.**
   - Evidence: H2H category strategy concentrates adds on categories that can still move; generic value is less important when a category is already locked or lost.
   - App behavior: transaction display categories are filtered to credible player-category contributions and matchup targets. Weak or non-credible categories, such as low-speed hitters being labeled as SB help, are suppressed.

7. **Protect ERA/WHIP from unnecessary pitcher streams once the 20-IP floor is covered.**
   - Evidence: pitching streams add counting stats but can damage ratios; expert guidance recommends choosing spots carefully and considering the larger roster picture.
   - App behavior: the planner applies streaming skill and ratio guardrails, and the briefing warns against risky pitcher volume when the weekly IP floor appears covered.

## Open Research-to-Code Gaps

- Player-level Yahoo lock state is not yet modeled. Until it is, optional same-day start/sit recommendations must remain conservative.
- The current engine uses projected category deltas and SGP-style scoring, but the full documented Monte Carlo flip-probability engine is not yet the sole source of move value.
- Hitter streaming could be improved with researched matchup inputs: batting order, platoon advantage, park, opposing pitcher quality, and remaining games.
- Pitcher streaming could be improved with researched matchup inputs: opponent offense/K%, park, probable-start confidence, and ratio-risk bands.
