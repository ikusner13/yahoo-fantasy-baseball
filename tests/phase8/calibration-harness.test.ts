import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import {
  CalibrationHarness,
  CategoryOutcome,
  CategoryPrediction,
  RetrospectiveInputs,
  WeeklyRetrospective,
  brierByCategory,
  brierScore,
  buildRetrospective,
  calibrationReport,
  isClosedOut,
  logLoss,
  makeCalibrationHarnessTest,
  outcomesFromTotals,
  reliabilityBins,
  scoredPredictions,
  sweepCoefficient,
} from "../../src/services/CalibrationHarness";
import { simulateMatchup } from "../../src/services/DecisionEngine";
import { WeeklyBatterLine } from "../../src/services/ProjectionModel";

const prediction = (category: string, winProbability: number, tieProbability = 0) =>
  new CategoryPrediction({ category, winProbability, tieProbability });

const outcome = (category: string, result: "win" | "loss" | "tie") =>
  new CategoryOutcome({ category, myTotal: 0, opponentTotal: 0, outcome: result });

const closedWeek = (
  week: number,
  predictions: ReadonlyArray<CategoryPrediction>,
  outcomes: ReadonlyArray<CategoryOutcome>,
) =>
  new WeeklyRetrospective({
    week,
    recordedAt: "2026-06-19T00:00:00.000Z",
    predictions,
    outcomes,
  });

describe("CalibrationHarness scoring (F8)", () => {
  it("brierScore is 0 for a perfect prediction and 1 for a confidently wrong one", () => {
    const perfect = scoredPredictions([
      closedWeek(1, [prediction("HR", 1)], [outcome("HR", "win")]),
    ]);
    const worst = scoredPredictions([
      closedWeek(2, [prediction("HR", 1)], [outcome("HR", "loss")]),
    ]);
    expect(brierScore(perfect)).toBe(0);
    expect(brierScore(worst)).toBe(1);
  });

  it("returns null metrics when there is no closed-out history", () => {
    const open = new WeeklyRetrospective({
      week: 1,
      recordedAt: "2026-06-19T00:00:00.000Z",
      predictions: [prediction("HR", 0.6)],
    });
    expect(isClosedOut(open)).toBe(false);
    expect(brierScore(scoredPredictions([open]))).toBeNull();
    expect(logLoss(scoredPredictions([open]))).toBeNull();
    const report = calibrationReport([open]);
    expect(report.weeks).toBe(0);
    expect(report.predictions).toBe(0);
    expect(report.brier).toBeNull();
  });

  it("scores ties as 0.5 category points", () => {
    const pairs = scoredPredictions([
      closedWeek(1, [prediction("R", 0.5, 1.0)], [outcome("R", "tie")]),
    ]);
    expect(pairs[0].predicted).toBe(1.0);
    expect(pairs[0].actual).toBe(0.5);
    expect(brierScore(pairs)).toBeCloseTo(0.25, 10);
  });

  it("matches predictions to outcomes by category and drops unmatched", () => {
    const pairs = scoredPredictions([
      closedWeek(
        1,
        [prediction("R", 0.7), prediction("HR", 0.4)],
        [outcome("R", "win")], // HR has no outcome → dropped
      ),
    ]);
    expect(pairs.map((pair) => pair.category)).toEqual(["R"]);
  });

  it("breaks Brier down per category, worst first", () => {
    const pairs = scoredPredictions([
      closedWeek(
        1,
        [prediction("R", 0.9), prediction("HR", 0.5)],
        [outcome("R", "loss"), outcome("HR", "win")],
      ),
    ]);
    const byCategory = brierByCategory(pairs);
    expect(byCategory[0].category).toBe("R");
    expect(byCategory[0].brier).toBeCloseTo(0.81, 10);
  });

  it("reliability bins recover a well-calibrated rate", () => {
    // 10 predictions at p=0.7; 7 wins, 3 losses → realized rate 0.7.
    const predictions = Array.from({ length: 10 }, (_, index) => prediction(`C${index}`, 0.7));
    const outcomes = predictions.map((_, index) =>
      outcome(`C${index}`, index < 7 ? "win" : "loss"),
    );
    const bins = reliabilityBins(scoredPredictions([closedWeek(1, predictions, outcomes)]));
    expect(bins).toHaveLength(1);
    expect(bins[0].meanPredicted).toBeCloseTo(0.7, 10);
    expect(bins[0].meanActual).toBeCloseTo(0.7, 10);
    expect(bins[0].count).toBe(10);
  });
});

const batterLine = (playerKey: string, high: boolean) =>
  new WeeklyBatterLine({
    kind: "batter",
    playerKey,
    name: playerKey,
    team: "NYY",
    pa: 30,
    r: high ? 12 : 4,
    h: high ? 9 : 6,
    hr: high ? 5 : 1,
    rbi: high ? 12 : 4,
    sb: 1,
    tb: high ? 22 : 10,
    obpNumerator: high ? 12 : 9,
    obpDenominator: 30,
    obp: high ? 0.4 : 0.3,
  });

const sweepWeek = () =>
  new WeeklyRetrospective({
    week: 1,
    recordedAt: "2026-06-19T00:00:00.000Z",
    predictions: [prediction("R", 0.95), prediction("HR", 0.95)],
    // Engine was confidently favored in R and HR but actually LOST both — overconfident.
    outcomes: [outcome("R", "loss"), outcome("HR", "loss")],
    inputs: new RetrospectiveInputs({
      myRoster: [batterLine("me", true)],
      opponentRoster: [batterLine("opp", false)],
      iterations: 5000,
      seed: 62744,
    }),
  });

describe("CalibrationHarness coefficient sweep (F8)", () => {
  it("inflating volatility lowers Brier when the engine was overconfident", () => {
    const result = sweepCoefficient("volatility", [sweepWeek()], [0.5, 1, 2, 4]);
    expect(result.coefficient).toBe("volatility");
    expect(result.points).toHaveLength(4);
    // Overconfident losses ⇒ pulling win-probs toward 0.5 (higher volatility) reduces error.
    const brierAtLow = result.points[0].brier;
    const brierAtHigh = result.points[3].brier;
    expect(brierAtLow).not.toBeNull();
    expect(brierAtHigh).not.toBeNull();
    expect(brierAtHigh!).toBeLessThan(brierAtLow!);
    expect(result.best).toBe(4);
  });

  it("skips weeks without re-simulation inputs", () => {
    const noInputs = closedWeek(2, [prediction("R", 0.6)], [outcome("R", "win")]);
    const result = sweepCoefficient("volatility", [noInputs], [1, 2]);
    expect(result.points.every((point) => point.predictions === 0)).toBe(true);
    expect(result.best).toBeNull();
  });
});

describe("CalibrationHarness recording bridge (F8)", () => {
  it("builds a recordable retrospective whose inputs re-simulate to the recorded predictions", () => {
    const myRoster = [batterLine("me", true)];
    const opponentRoster = [batterLine("opp", false)];
    const baseline = simulateMatchup(myRoster, opponentRoster);
    const retro = buildRetrospective({
      week: 7,
      recordedAt: "2026-06-19T00:00:00.000Z",
      baseline,
      myRoster,
      opponentRoster,
    });
    expect(retro.week).toBe(7);
    expect(retro.predictions).toHaveLength(baseline.categories.length);
    // Re-simulating the stored inputs at the stored seed reproduces the baseline win-probs.
    const replay = simulateMatchup(
      retro.inputs!.myRoster,
      retro.inputs!.opponentRoster,
      retro.inputs!.iterations,
      retro.inputs!.seed,
    );
    expect(replay.categories[0].winProbability).toBe(baseline.categories[0].winProbability);
  });

  it("derives outcomes from totals, honoring lower-is-better categories", () => {
    const outcomes = outcomesFromTotals([
      { category: "R", myTotal: 30, opponentTotal: 25 }, // higher wins
      { category: "ERA", myTotal: 3.1, opponentTotal: 4.2 }, // lower wins
      { category: "HR", myTotal: 8, opponentTotal: 8 }, // tie
    ]);
    const byCategory = new Map(outcomes.map((o) => [o.category, o.outcome]));
    expect(byCategory.get("R")).toBe("win");
    expect(byCategory.get("ERA")).toBe("win");
    expect(byCategory.get("HR")).toBe("tie");
  });
});

describe("CalibrationHarness service (F8)", () => {
  it("records, closes out, reports, and sweeps through the in-memory layer", () =>
    Effect.gen(function* () {
      const harness = yield* CalibrationHarness;
      yield* harness.record(
        new WeeklyRetrospective({
          week: 1,
          recordedAt: "2026-06-19T00:00:00.000Z",
          predictions: [prediction("R", 0.9), prediction("HR", 0.5)],
        }),
      );

      // Before close-out there is nothing to score.
      const openReport = yield* harness.report();
      expect(openReport.weeks).toBe(0);

      const closed = yield* harness.closeOut(1, [outcome("R", "loss"), outcome("HR", "win")]);
      expect(isClosedOut(closed)).toBe(true);

      const report = yield* harness.report();
      expect(report.weeks).toBe(1);
      expect(report.predictions).toBe(2);
      expect(report.brier).toBeCloseTo((0.81 + 0.25) / 2, 10);
    }).pipe(Effect.provide(makeCalibrationHarnessTest()), Effect.runPromise));

  it("fails close-out for an unrecorded week", () =>
    Effect.gen(function* () {
      const harness = yield* CalibrationHarness;
      const result = yield* Effect.exit(harness.closeOut(99, [outcome("R", "win")]));
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(makeCalibrationHarnessTest()), Effect.runPromise));
});
