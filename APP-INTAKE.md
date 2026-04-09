# Fantasy Baseball App Intake

Last updated: 2026-04-09

## Status

- Current section: Complete
- Progress: 7 / 7 sections completed

## 1. League

- Platform: Yahoo
- Lineup lock style: Daily changes allowed; players lock at individual game time
- Scoring categories:
  - Hitting: R, H, HR, RBI, SB, TB, OBP
  - Pitching: OUT, K, ERA, WHIP, QS, SV+H
- Minimum innings requirement: 20 IP per week
- Number of teams: 12
- Roster slots: C, 1B, 2B, 3B, SS, OF, OF, OF, Util, Util, SP, SP, RP, RP, P, P, P, P
- Bench size: 5
- IL size: 4
- Adds per week: 6
- Waiver system:
  - Waiver time: 2 days
  - Waiver type: Continual rolling list
  - Waiver mode: Standard
  - Injured players can be added directly to IL: Yes
- Trade review / veto rules: League vote
- Playoff / tiebreak rules:
  - Playoffs: 6 teams
  - Playoff weeks: 24, 25, 26
  - Playoffs end: Sunday, September 27
  - Playoff tie-breaker: Higher seed wins

## 2. Control

- Recommendation-only or allowed to act: Recommendation-only
- Allowed automatic actions:
  - Set lineup: Recommend only
  - Move players to/from IL: Recommend only
  - Add/drop free agents: Recommend only
  - Submit waiver claims: Recommend only
  - Propose trades: Recommend only
- Approval required for roster-changing moves: Yes; app cannot act

## Control Notes

- Yahoo does not provide write permissions for this setup.
- If a move is urgent and the user has not replied, the app still cannot act.

## 3. Goal

- Primary optimization target: Win the current week's matchup, while keeping championship equity in mind
- Weekly punt tolerance: Yes, if it improves matchup win odds
- Season-long sacrifice tolerance: Yes
- Streaming aggressiveness: Medium
- Drop aggressiveness: Medium
- Floor vs ceiling preference: Depends on matchup context

## Goal Notes

- User wants the app to surface all actionable edges, including small ones.
- User's framing is outcome-based: "I want to win."
- Medium aggression is the default starting point for streaming and fringe-player churn.

## 4. Messages

- Delivery channel: Telegram
- Daily lineup messages: Yes
- News / injury alerts: Yes, for players the user cares about
- Waiver alerts: Only when the app recommends action
- Sunday tactics: Send when helpful
- Message length: Short and direct
- Single recommendation vs ranked options: Both
- Confidence labels: Yes, determined from stats / algorithms rather than vibes

## Message Notes

- Core expectation: recommendations should be driven primarily by proper stats and algorithms.
- LLMs are available, but should support synthesis and communication rather than replace the numbers.
- Need a later mechanism for defining "players the user cares about" beyond default roster relevance.

## 5. Decision Style

- Conservative vs decisive: Context-dependent
- Explain ignored categories: Yes
- Include "what not to do": Yes
- Personal preferences vs pure EV: Optimize for win odds, but avoid reckless moves that damage the team for a random short-term win

## Decision Style Notes

- If the evidence is genuinely weak and there is no edge, the app should say so plainly.
- The user does not want fake certainty; weak recommendations should not be presented as strong ones.

## 6. Data

- Trusted data sources:
  - Recommended weighting:
    - 1. Rest-of-season and weekly projections as the backbone
    - 2. Role / lineup / closer news as a critical override layer
    - 3. Schedule / game counts / probable matchups for weekly and daily decisions
    - 4. Recent performance as a modest modifier
    - 5. Statcast / underlying skills as a secondary validation and breakout-detection layer
    - 6. Vegas lines as a small tiebreaker only
- Free-only vs paid tools: Prefer free/public data first; paid tools only if a clear edge is worth it
- Opponent modeling depth: Current scoreboard only

## Data Notes

- User wants research-driven source weighting rather than guessing.
- Watchlist is desired for must-pick-up free agents, closers, and similar high-priority targets.
- User does not care about deep opponent-roster modeling beyond the live matchup scoreboard.

## 7. Trades and Evaluation

- Trade recommendations needed: Tentative / possible, but not a first-order priority
- Trade optimization target: Championship equity rather than short-term weekly matchup tactics
- Draft trade messages: Yes, if trade recommendations are enabled
- Success metrics:
  - Needs to be measurable day by day and matchup by matchup
  - Should be mathematical, not just subjective
  - Likely metrics: weekly matchup win rate, category win rate, decision hit rate, and season/championship outcomes
- Learn from outcomes: Yes

## Trades and Evaluation Notes

- User is not yet convinced trades are the highest-value feature.
- Short-term "win this week" trades are not the goal; any trade logic should be season-long and title-oriented.
- LLMs may be useful in the learning loop, but outcome tracking should remain grounded in hard data.
- Watchlist preference: ranked watchlist, ideally with must-add escalation for top opportunities.

## Notes

- Pending.
