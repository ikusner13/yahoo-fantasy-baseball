# Engine Phase 2 Poisson Gate

Change 5 was attempted after changes 1-4 were green and was dropped.

The attempted implementation used inverse-transform Poisson for low-mean counting stats, a one-draw rounded normal fallback for high means, and exact integer tie comparison for counting categories. It destabilized existing CRN and calibration invariants:

- Low-mean Poisson ignored the existing `volatility` multiplier, so the F2 variance-awareness tests and volatility calibration sweep stopped moving Brier scores.
- Consuming counting-stat draws even when `volatility: 0` advanced the mine-side RNG stream across iterations when a candidate appended extra roster lines, breaking the current CRN tests that protect candidate-vs-baseline comparability.

Keeping change 5 would require a broader design for mean-preserving overdispersion plus fixed per-line draw budgets that preserve the current CRN contract across appended candidates. It is intentionally left out of this phase rather than weakening those invariants.
