# League Model and Product Assumptions

This document is the source of truth for how the app should reason about Ian's Yahoo Fantasy Baseball league. The current app needs a rewrite around these assumptions.

Observed from Yahoo on 2026-06-06:

- League: `2026 thunder dome`, Yahoo league ID `62744`.
- Team: `Ian's Smashers`, team ID `12`.
- Format: 12-team Yahoo Fantasy Baseball head-to-head categories (`scoring_type=head`, `scoring_label=H2H Cat`).
- Standings are cumulative category results, not weekly matchup wins.
- Current standings record: `36-83-11`, 12th place.
- Current matchup: Week 11 vs `Republíca Domínican`, trailing `4-9`.
- Weekly acquisition limit: 6 player adds.
- Current weekly adds used: `0 of 6`.
- Waiver priority: 1st (`waiver_type=R`, rolling waivers; `waiver_time=2` days).
- IL slots: 4 total, 3 used.
- Roster alert: 2 empty roster spots.
- Minimum pitching volume: 20 IP per week; Week 11 minimum had already been reached at `22.2 IP`.
- League activity level is materially higher than Ian's team: other teams showed 5 to 51 moves, while Ian's team showed 2 moves.
- Playoffs: 6 playoff teams, playoffs start Week 24.
- Trade review: commissioner review, 1-day reject time, trade deadline 2026-08-06.

## Scoring Categories

The league has 13 scoring categories.

Batting:

- `R`
- `H`
- `HR`
- `RBI`
- `SB`
- `TB`
- `OBP`

Pitching:

- `OUT`
- `K`
- `ERA`
- `WHIP`
- `QS`
- `SV+H`

Yahoo also displays `H/AB` and `IP`, but those are display-only/non-scoring in this league. `IP` still matters operationally because failing to reach the weekly minimum forfeits pitching categories.

The rewrite should discover these categories from Yahoo's `/league/{leagueKey}/settings` `stat_categories` payload and exclude stats with `is_only_display_stat=1`. The current league settings expose:

- Display-only batting stat: stat id `60`, `H/AB`.
- Scoring batting stats: `7=R`, `8=H`, `12=HR`, `13=RBI`, `16=SB`, `23=TB`, `4=OBP`.
- Display-only pitching stat: stat id `50`, `IP`.
- Scoring pitching stats: `33=OUT`, `42=K`, `26=ERA`, `27=WHIP`, `83=QS`, `89=SV+H`.

## Roster Model

Starting slots:

- `C`: 1
- `1B`: 1
- `2B`: 1
- `3B`: 1
- `SS`: 1
- `OF`: 3
- `Util`: 2
- `SP`: 2
- `RP`: 2
- `P`: 4

Reserve slots:

- `BN`: 5
- `IL`: 4

Raw Yahoo roster entries expose the current lineup slot at `player[1].selected_position[1].position`. This matters because the current app parser was observed to collapse all players to `BN` by reading the wrong nested path. The rewrite must treat selected position parsing as a tested contract.

## Standings Model

Every category result is a standings unit.

The weekly matchup score, such as `4-9`, means 4 category wins and 9 category losses for that week. Those category results roll directly into the season standings record. A team does not get one standings win for winning the week; it gets up to 13 category outcomes per week.

Implications:

- The app must maximize expected category points, not binary weekly matchup wins.
- Turning a `4-9` week into `5-8` matters.
- Protecting a doomed weekly matchup is not enough; the app should identify any category that can still be flipped.
- Punting is only correct when the roster/add/start cost is better spent on another category.
- Category ties have value and should be protected or pursued when realistic.

## Product Objective

The correct product objective is:

> Maximize expected cumulative category wins and ties across the season, subject to Yahoo roster rules, weekly add limits, injury constraints, and user approval for roster-changing actions.

This is different from:

- maximizing rest-of-season player value,
- maximizing a single lineup's projected fantasy value,
- winning the weekly matchup as a binary outcome,
- preserving waiver priority by default,
- minimizing roster churn.

Those can be useful secondary concerns, but they must not override high-leverage category points.

## Operating Strategy

The app should behave like an active H2H category manager.

Default posture:

- Use available roster capacity. Empty roster spots are free lost volume and should trigger urgent add recommendations.
- Use weekly adds deliberately. In a 6-add league, unused adds are usually wasted category equity, especially late in the week.
- Exploit schedule volume. Extra games and probable starts can be worth more than small rest-of-season value gaps.
- Treat close categories as the primary battlefield.
- Preserve ratio leads only when the expected gain in `OUT`, `K`, `QS`, or `SV+H` is not worth the risk to `ERA`/`WHIP`.
- Prefer add-only improvements before add/drop decisions when the roster has open slots.
- Distinguish free-agent adds from waiver claims. Waiver priority has opportunity cost, but 1st priority is not useful if the roster is leaking standings points.

## Current Failure Pattern

The app appears to have been built with some correct scoring-category parsing but the wrong behavioral assumptions.

Known mismatch signals:

- The app has drop-centric waiver logic, but Yahoo shows 2 empty roster spots.
- The app tracks add budget internally in KV, but Yahoo's actual state showed `0 of 6` adds used.
- The app had hardcoded waiver-priority assumptions in recommendation logic.
- The roster had very low transaction activity compared with the league.
- The current matchup deficit was mostly volume categories, yet roster capacity was unused.
- The current roster parser reads selected position from the wrong Yahoo JSON path, causing API-driven analysis to think every player is benched.
- The current category setup is hardcoded even though Yahoo settings provide enabled scoring categories and display-only flags.

These are not small tuning problems. The rewrite should model roster capacity, add budget, waiver priority, category state, and schedule volume as first-class inputs.

## Decision Hierarchy

Recommended decision order:

1. Validate league state from Yahoo: roster slots, empty slots, IL usage, adds used, waiver priority, category scores, days remaining, games remaining.
2. Identify category point opportunities: likely wins, likely losses, ties, and realistic flips.
3. Fill empty roster slots with the highest marginal category impact for the current week.
4. Use add/drop moves to improve category points when add-only capacity is gone.
5. Stream pitchers only when the category upside justifies ratio risk.
6. Preserve or spend waiver priority based on player scarcity and immediate category value.
7. Reassess daily because games remaining, probable starters, lineup status, injuries, and category margins change quickly.

## Safety and Control

The app may analyze and recommend aggressively, but roster-changing actions must remain controlled.

- Read-only inspection and analysis can run automatically.
- Lineup recommendations may be sent without applying moves unless the user has explicitly enabled automatic lineup setting.
- Adds, drops, waiver claims, and trades should require explicit user approval.
- Recommendations should say whether the action is add-only, add/drop, waiver claim, lineup move, IL move, or trade.
- Recommendations should name the categories affected and the reason the move is worth the transaction cost.

## Browser Lineup Write Observation

Observed on 2026-06-06 from the Yahoo My Team page after moving `Andrew Vaughn` to `1B` and `Yandy Díaz` to `Util`:

- Yahoo made a browser-authenticated `POST` to `/b1/62744/12/editroster`.
- The request body submitted the entire roster slot map, not only the changed players.
- The body included one field per Yahoo player id with the target selected position, plus `date`, stat view fields, `crumb`, and `jsubmit=Save Changes`.
- The response status was `200`, and the page emitted `EV_ROSTER_CHANGED` and `EV_ROSTER_SAVED`.
- Cookies/session headers were not captured or documented. The crumb is a session-sensitive anti-CSRF value and must be treated as secret.

Sanitized request shape:

```txt
POST /b1/62744/12/editroster

<playerId>=<slot>&...&date=2026-06-06&stat1=S&stat2=D&crumb=[REDACTED]&jsubmit=Save%20Changes
```

Implications for the rewrite:

- The official Yahoo API should remain the preferred write path when Yahoo grants write access.
- Until then, browser-derived lineup writes appear technically possible but private, fragile, and session-bound.
- Any browser-write adapter must rebuild and submit the full roster map for the target date; partial updates are the wrong assumption.
- The adapter must never log cookies, raw crumbs, or full request headers.
- This path should be gated behind explicit user approval and should initially be limited to lineup/position moves, not adds, drops, waiver claims, or trades.

## Rewrite Requirements

The rewrite should include:

- A league-state snapshot model sourced from Yahoo, not inferred from local KV alone.
- Add-only transaction support and recommendation formatting.
- Real weekly add usage from Yahoo.
- Real waiver priority from Yahoo.
- Real selected-position parsing from Yahoo roster responses.
- League settings parsing for roster slots, scoring categories, display-only stats, playoffs, waivers, and trade rules.
- Category-point expected value scoring.
- Empty-slot urgency scoring.
- Schedule-volume scoring for batters and pitchers.
- Separate free-agent add, waiver claim, and add/drop decision paths.
- A daily "what category points can we still gain?" report.
- Tests that encode this league's 13 categories and standings model.
- A lineup-write abstraction that can use the official Yahoo API when available, with any browser-derived fallback isolated, secret-safe, and explicitly approved.
