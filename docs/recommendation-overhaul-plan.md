# Recommendation Overhaul Plan

Last updated: 2026-04-09
Branch: `feature/recommendation-overhaul`

## Goal

Build a recommendation-only Yahoo fantasy baseball assistant that sends short, direct Telegram messages that help win H2H category matchups, while preserving championship equity.

The app should:

- Optimize for weekly matchup win probability first.
- Avoid reckless churn for tiny short-term edges.
- Explain what to do, what not to do, and which categories to ignore.
- Use math and baseball signals as the primary decision engine.
- Use LLMs as a synthesis, communication, and learning layer, not as the source of truth.

## Current State

The repo already has a substantial base. This is not a greenfield app.

Useful existing pieces:

- Yahoo ingestion and matchup parsing
- Projection ingestion
- Daily lineup optimizer
- Matchup classification
- Streaming and pitcher pickup modules
- Monte Carlo matchup simulator
- News monitor and Telegram messaging
- Retrospective and memory scaffolding
- A meaningful unit-test base

Current limitations:

- Core recommendation logic is still mostly heuristic rather than win-probability driven.
- Weekly preview labels current-state heuristics as projections.
- League settings and waiver state are partially hardcoded.
- Tests over-index on sanity and formatting, not real decision quality.
- Integration tests depend on live network and are not stable enough for CI.
- Some newer modules exist but are not yet the canonical production engine.

## Research-Driven Decision Principles

Use these as architecture constraints:

1. Projections are the baseline truth.
   - Rest-of-season and weekly projections should anchor player value.
   - Recent form should not override projections by default.

2. Role changes and lineup/closer news are high-priority overrides.
   - Bullpen roles and lineup spots change faster than projections.

3. H2H categories is a matchup-probability game, not a raw-points game.
   - We should optimize expected category wins and matchup win probability.
   - Punting dead categories is valid when it improves overall win odds.

4. Volume matters heavily in daily H2H.
   - Schedule, games remaining, two-start pitchers, and available starts are core inputs.

5. Statcast and recent performance are modifiers.
   - They are useful for validating skills changes and breakouts.
   - They should not replace the projection layer.

6. Confidence must be computed, not narrated.
   - Confidence should come from model edge size, downside, and signal agreement.

## Rewrite Recommendation

Do not blindly rewrite the whole app.

Recommended approach:

- Keep the external integration shell:
  - Yahoo client
  - Telegram delivery
  - Projection/statcast/news ingestion
  - Cron/worker orchestration
- Rewrite the recommendation core:
  - matchup engine
  - lineup decision engine
  - waiver/streaming ranking
  - confidence model
  - evaluation and learning loop

If the current orchestration in `gm.ts` keeps fighting the new engine, extract a new recommendation service module and progressively retire the old paths.

## Target Architecture

### 1. Canonical League Context

Create a single typed league context that drives every recommendation:

- categories
- roster slots
- daily lock behavior
- weekly add cap
- waiver type
- innings minimum
- playoff structure

This must replace hidden constants spread across the codebase.

### 2. Canonical Recommendation Context

Define one shared recommendation context built fresh for every decision cycle:

- current matchup scoreboard
- days remaining
- team and opponent remaining volume
- my projected remaining production
- available free-agent opportunity set
- injury / role / lineup news
- adds remaining
- current roster opportunity cost

### 3. Matchup Probability Engine

Use the existing Monte Carlo work as the seed, but make it production-grade.

Requirements:

- per-category projected remaining production
- category covariance where practical
- rate-stat handling via underlying counting accumulators
- team schedule / game-count awareness
- remaining starts awareness
- explicit category win probabilities
- explicit overall matchup win probability

This becomes the source of truth for:

- weekly preview
- daily lineup changes
- streamer recommendations
- waiver recommendations
- Sunday tactics

### 4. Decision Engines

#### Lineup

Replace “best raw player” heuristics with “highest matchup win-probability delta”.

For each viable lineup decision:

- compare current lineup vs candidate lineup
- compute matchup EV delta
- emit recommendation only if the edge is meaningful

#### Streaming

Rank streamers by:

- projected matchup win-probability delta
- category help/hurt breakdown
- ratio downside
- add-cost opportunity cost
- number and confidence of starts before matchup end

#### Waivers

Rank hitter and pitcher pickups by:

- weekly matchup EV delta
- near-term role certainty
- game-count advantage
- roster-drop opportunity cost
- future value when not harming present matchup

#### Watchlist

Build a persistent ranked watchlist with must-add escalation.

Must-add triggers should include:

- new closer / leverage role capture
- injured player replacement with locked-in playing time
- high-upside call-up with immediate role
- two-start SP with favorable matchups and viable downside

### 5. Confidence Model

Every recommendation should output:

- `edge_score`
- `confidence`
- `why_now`
- `what_not_to_do`

Confidence inputs:

- edge size vs replacement decision
- agreement between projection, schedule, and role signals
- downside risk to protected categories
- certainty of playing time / start probability
- data freshness

### 6. Messaging Layer

Message contracts should be action-first and consistent:

- recommendation
- urgency
- confidence
- expected category impact
- what to ignore
- what not to do

Default message types:

- daily lineup plan
- urgent news / injury alert
- must-add watchlist alert
- actionable waiver recommendation
- streamer recommendation
- Sunday endgame tactics
- “no edge today” message when appropriate

### 7. Learning Loop

Track every recommendation with structured fields:

- timestamp
- recommendation type
- input context hash
- predicted EV delta
- predicted category impact
- confidence
- user action taken
- actual outcome

LLM use in learning:

- summarize patterns
- cluster mistakes
- generate human-readable retrospectives

LLM should not rewrite the underlying outcome labels.

## Verification Strategy

Verification is part of the design, not phase-two cleanup.

### Unit Tests

Add or strengthen tests for:

- league-context normalization
- matchup probability math
- rate-stat accumulator math
- lineup delta monotonicity
- waiver and streamer opportunity-cost math
- confidence scoring
- watchlist trigger rules

### Scenario Tests

Create a curated bank of matchup scenarios covering:

- protect-ratios late week
- chase counting stats with IP minimum pressure
- punt dead SB / SV+H categories
- preserve championship equity vs reckless short-term churn
- two-start pitcher edges under add limits
- closer-change must-add alerts

Each scenario should assert:

- recommendation
- non-recommendation
- confidence band
- expected category reasoning

### Property Tests

Use property-style checks where possible:

- better projection should not lower score all else equal
- extra confirmed start should not reduce streamer rank all else equal
- worse ratio risk should not improve recommendation when ratio cats are protected

### Replay / Backtest Harness

Extend the dry-run simulator into a real replay harness:

- ingest historical snapshots
- replay day by day
- compare app decisions against baseline heuristics
- measure weekly and category-level outcomes

### Integration Tests

Replace live-network integration dependence with fixtures by default.

Live tests should be optional and separate from CI.

### Acceptance Metrics

Track:

- weekly matchup win rate
- category win rate
- recommendation acceptance rate
- recommendation hit rate
- calibration of confidence vs realized outcomes
- false-positive alert rate

## Workstreams

### Workstream A: League Context and Data Contracts

- Centralize league settings
- Remove hardcoded constants from decision paths
- Add typed config and fixtures
- Tests: config parsing, invariants, regression coverage

### Workstream B: Matchup Probability Engine

- Productionize Monte Carlo / distribution engine
- Replace fake “projected” weekly output
- Tests: probability math, regression scenarios, replay checks

### Workstream C: Decision Engines

- Rebuild lineup / waiver / streaming ranking around EV delta
- Fold in schedule, role, and opportunity cost
- Tests: scenario bank + property tests

### Workstream D: Watchlist and Alerting

- Add persistent watchlist
- Add must-add triggers
- Add relevance filters for “players I care about”
- Tests: trigger fixtures, dedupe, urgency correctness

### Workstream E: Messaging and Confidence

- Standardize message payloads
- Add structured confidence output
- Add “what not to do”
- Tests: notification snapshots and contract tests

### Workstream F: Learning and Evaluation

- Log predictions and outcomes
- Build replay/backtest runner
- Add calibration and hit-rate reporting
- Tests: logging schema, scorer correctness, replay determinism

### Workstream G: Trade Logic (Phase 2)

- Do not lead with trade automation
- Revisit after matchup engine and watchlist are strong
- Optimize for championship equity, not weekly desperation

## Execution Order

1. Stabilize league context and test baseline.
2. Replace weekly preview with true matchup projections.
3. Upgrade daily lineup engine to EV-delta based ranking.
4. Upgrade streamer and waiver engines.
5. Add watchlist and must-add alerting.
6. Add confidence and messaging contracts.
7. Add replay/backtest and learning loop.
8. Revisit trades only after the core loop is trustworthy.

## Baseline Status Before Changes

Current local baseline:

- Focused unit tests for core matchup/streaming/decision-quality paths pass.
- Full `pnpm test` currently fails.
- The failures are concentrated in:
  - live-network integration tests
  - statcast parsing expectations

This means the overhaul should begin by separating stable CI verification from flaky or environment-dependent checks.

## Deliverables

Minimum viable overhaul:

- true weekly matchup projection
- EV-based lineup recommendations
- EV-based streamer and waiver recommendations
- ranked watchlist with must-add alerts
- confidence labels
- structured recommendation logging
- stable CI-grade tests

Full target:

- replay/backtest system
- calibration reporting
- LLM-assisted retrospective summaries
- championship-aware trade module
