# Algorithm Research Audit

Last updated: 2026-04-11

## What Holds Up

- Rest-of-season projection baseline is the right backbone for lineup and matchup decisions.
  MLB's wRAA glossary explicitly treats offensive value as a rate-above-average scaled by plate appearances, which is the same basic logic used here for OBP time-weighting rather than treating rate stats as raw percentages.
  Source: https://www.mlb.com/glossary/advanced-stats/weighted-runs-above-average

- Statcast process metrics are appropriate for recency checks, but expected stats should stay secondary.
  MLB defines Statcast as measurement and skill-tracking infrastructure, and notes that xwOBA is derived from exit velocity, launch angle, Sprint Speed, plus real walks and strikeouts; it is useful for spotting over/underperformance over time, not as a stand-alone short-window forecast.
  Source: https://www.mlb.com/glossary/statcast

- Matchup probability models should lean on batter talent, pitcher talent, and league baseline, not raw matchup history alone.
  Haechrel's SABR paper derives and validates a generalized log5-style matchup model using batter event rates, pitcher event rates, and league event rates.
  Source: https://sabr.org/journal/article/matchup-probabilities-in-major-league-baseball/

## What Needed Tightening

- Raw batter-vs-pitcher history is too noisy to use as more than a weak tiebreaker.
  The SABR matchup paper notes that even 20+ plate appearances in a specific matchup are illustrative rather than conclusive.
  Source: https://sabr.org/journal/article/matchup-probabilities-in-major-league-baseball/

- Split data needs shrinkage.
  Bill James' SABR essay on platoon data argues that side-specific batting lines in roughly 100-200 at-bats contain a lot of instability, even though platoon skill is real in aggregate.
  Source: https://sabr.org/journal/article/underestimating-the-fog/

- Naive small-sample performance estimates are poor predictors.
  Brown's empirical Bayes paper shows that directly using current observed performance is the weakest prediction method in-season.
  Source: https://arxiv.org/abs/0803.3697

## Changes Applied

- `src/analysis/lineup.ts`
  BvP is now heavily shrunk toward neutral and capped at a very small effect.
  Platoon multipliers now shrink by split sample size instead of trusting raw split deltas.

- `src/analysis/retrospective.ts`
  Weekly retrospectives now dedupe repeated decisions and recover forecasts from the best available logged routine instead of falling back to `unknown` too often.

## Remaining Gaps

- Category leverage weights are still heuristic thresholds, not empirically calibrated from outcome logs.
- Opponent future production in matchup simulation is still pace/projection based rather than built from a full opponent-roster model.
- If BvP is ever promoted beyond a tiny tiebreaker, it should move to a proper log5 / empirical-Bayes event model rather than raw OBP-vs-pitcher history.
