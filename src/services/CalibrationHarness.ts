import { asc } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { retrospectives } from "../db/schema.ts";
import { Db } from "./Db.ts";
import {
  type MatchupSimulation,
  PRODUCTION_SIMULATION_COUNT,
  simulateMatchup,
} from "./DecisionEngine.ts";
import { WeeklyBatterLine, WeeklyPitcherLine } from "./ProjectionModel.ts";

// Must match the default `seed` of simulateMatchup in DecisionEngine, so a recorded week
// re-simulates to the same predictions at coefficient = 1.
const DEFAULT_SIM_SEED = 62744;

// Categories where a lower total wins (orientation for deriving outcomes from raw totals). Mirrors
// DecisionEngine's LOWER_IS_BETTER; passed explicitly to outcomesFromTotals to keep this module from
// re-encoding league rules silently.
const DEFAULT_LOWER_IS_BETTER: ReadonlySet<string> = new Set(["ERA", "WHIP"]);

// F8 — Backtest & calibration harness.
//
// Scores the engine's predicted category win probabilities against realized weekly outcomes and
// fits coefficients instead of hand-setting them (locked decision #5). A `WeeklyRetrospective` is
// recorded at decision time (predictions + the re-simulatable roster lines) and closed out after the
// week ends (actual per-category totals). The pure scoring functions and the coefficient sweep work
// on plain arrays so they are testable without a DB and degrade gracefully when history is thin.

const WeeklyLineSchema = Schema.Union([WeeklyBatterLine, WeeklyPitcherLine]);
type WeeklyLine = WeeklyBatterLine | WeeklyPitcherLine;

export class CalibrationHarnessError extends Data.TaggedError("CalibrationHarnessError")<{
  readonly message: string;
}> {}

// The engine's predicted distribution for one category in a recorded week.
export class CategoryPrediction extends Schema.Class<CategoryPrediction>("CategoryPrediction")({
  category: Schema.String,
  winProbability: Schema.Finite,
  tieProbability: Schema.Finite,
}) {}

// The realized result for one category once the week is final.
export class CategoryOutcome extends Schema.Class<CategoryOutcome>("CategoryOutcome")({
  category: Schema.String,
  myTotal: Schema.Finite,
  opponentTotal: Schema.Finite,
  outcome: Schema.Union([Schema.Literal("win"), Schema.Literal("loss"), Schema.Literal("tie")]),
}) {}

// Everything needed to re-simulate the week under a different coefficient (for the sweep).
export class RetrospectiveInputs extends Schema.Class<RetrospectiveInputs>("RetrospectiveInputs")({
  myRoster: Schema.Array(WeeklyLineSchema),
  opponentRoster: Schema.Array(WeeklyLineSchema),
  iterations: Schema.Finite,
  seed: Schema.Finite,
}) {}

export class WeeklyRetrospective extends Schema.Class<WeeklyRetrospective>("WeeklyRetrospective")({
  week: Schema.Finite,
  recordedAt: Schema.String,
  predictions: Schema.Array(CategoryPrediction),
  // Filled in at close-out. A retrospective without outcomes is "open" and not scored yet.
  outcomes: Schema.optional(Schema.Array(CategoryOutcome)),
  // Optional so a prediction can be logged even when the re-simulation inputs are unavailable;
  // only retrospectives that carry inputs participate in the coefficient sweep.
  inputs: Schema.optional(RetrospectiveInputs),
}) {}

export interface ScoredPrediction {
  readonly week: number;
  readonly category: string;
  // Predicted expected category points = P(win) + 0.5·P(tie). This is the engine's objective term,
  // so calibrating it directly calibrates what the ranking optimizes (§1.2).
  readonly predicted: number;
  // Realized category points: win 1, tie 0.5, loss 0.
  readonly actual: number;
}

const actualPoints = (outcome: CategoryOutcome["outcome"]) =>
  outcome === "win" ? 1 : outcome === "tie" ? 0.5 : 0;

const predictedPoints = (prediction: CategoryPrediction) =>
  prediction.winProbability + 0.5 * prediction.tieProbability;

// Attach realized outcomes to an open retrospective, preserving the recorded predictions/inputs.
const withOutcomes = (retro: WeeklyRetrospective, outcomes: ReadonlyArray<CategoryOutcome>) =>
  new WeeklyRetrospective({
    week: retro.week,
    recordedAt: retro.recordedAt,
    predictions: retro.predictions,
    outcomes,
    inputs: retro.inputs,
  });

// Bridge from the live decision flow: turn the baseline simulation + the exact rosters that were
// simulated into an open retrospective ready to record. Pass the *active* scoring roster (what
// `rankAddCandidates` actually fed to `simulateMatchup`), not the full bench-inclusive roster, so
// the sweep re-simulates identically at coefficient = 1. Stores iterations/seed for the same reason.
export const buildRetrospective = (params: {
  readonly week: number;
  readonly recordedAt: string;
  readonly baseline: MatchupSimulation;
  readonly myRoster: ReadonlyArray<WeeklyLine>;
  readonly opponentRoster: ReadonlyArray<WeeklyLine>;
  readonly iterations?: number;
  readonly seed?: number;
}) =>
  new WeeklyRetrospective({
    week: params.week,
    recordedAt: params.recordedAt,
    predictions: params.baseline.categories.map(
      (category) =>
        new CategoryPrediction({
          category: category.category,
          winProbability: category.winProbability,
          tieProbability: category.tieProbability,
        }),
    ),
    inputs: new RetrospectiveInputs({
      myRoster: params.myRoster,
      opponentRoster: params.opponentRoster,
      iterations: params.iterations ?? PRODUCTION_SIMULATION_COUNT,
      seed: params.seed ?? DEFAULT_SIM_SEED,
    }),
  });

// Bridge from realized weekly results (e.g. a Yahoo matchup payload): derive per-category win/loss/
// tie from raw totals, honoring lower-is-better categories.
export const outcomesFromTotals = (
  totals: ReadonlyArray<{
    readonly category: string;
    readonly myTotal: number;
    readonly opponentTotal: number;
  }>,
  lowerIsBetter: ReadonlySet<string> = DEFAULT_LOWER_IS_BETTER,
): ReadonlyArray<CategoryOutcome> =>
  totals.map(({ category, myTotal, opponentTotal }) => {
    const oriented = lowerIsBetter.has(category)
      ? opponentTotal - myTotal
      : myTotal - opponentTotal;
    const outcome =
      Math.abs(myTotal - opponentTotal) < 1e-9 ? "tie" : oriented > 0 ? "win" : "loss";
    return new CategoryOutcome({ category, myTotal, opponentTotal, outcome });
  });

// Closed-out retrospectives only — open ones (no outcomes) contribute nothing to calibration.
export const isClosedOut = (
  retro: WeeklyRetrospective,
): retro is WeeklyRetrospective & { outcomes: ReadonlyArray<CategoryOutcome> } =>
  retro.outcomes != null && retro.outcomes.length > 0;

// Flatten retrospectives into (predicted, actual) pairs, matching predictions to outcomes by
// category. Predictions without a matching outcome (and vice versa) are dropped.
export const scoredPredictions = (
  retros: ReadonlyArray<WeeklyRetrospective>,
): ReadonlyArray<ScoredPrediction> =>
  retros.filter(isClosedOut).flatMap((retro) => {
    const outcomeByCategory = new Map(retro.outcomes.map((o) => [o.category, o]));
    return retro.predictions.flatMap((prediction) => {
      const outcome = outcomeByCategory.get(prediction.category);
      return outcome == null
        ? []
        : [
            {
              week: retro.week,
              category: prediction.category,
              predicted: predictedPoints(prediction),
              actual: actualPoints(outcome.outcome),
            } satisfies ScoredPrediction,
          ];
    });
  });

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

// Brier score: mean squared error of the predicted probability. 0 is perfect, 1 is worst.
// Returns null when there is nothing to score (thin early-season history).
export const brierScore = (pairs: ReadonlyArray<ScoredPrediction>) =>
  mean(pairs.map((pair) => (pair.predicted - pair.actual) ** 2));

// Logarithmic loss (cross-entropy), generalized to the {0, 0.5, 1} outcome set. Punishes confident
// wrong predictions harder than Brier does. EPS keeps the log finite at the probability extremes.
const LOG_LOSS_EPS = 1e-9;
export const logLoss = (pairs: ReadonlyArray<ScoredPrediction>) =>
  mean(
    pairs.map((pair) => {
      const p = Math.min(Math.max(pair.predicted, LOG_LOSS_EPS), 1 - LOG_LOSS_EPS);
      return -(pair.actual * Math.log(p) + (1 - pair.actual) * Math.log(1 - p));
    }),
  );

export interface CategoryBrier {
  readonly category: string;
  readonly brier: number;
  readonly count: number;
}

export const brierByCategory = (
  pairs: ReadonlyArray<ScoredPrediction>,
): ReadonlyArray<CategoryBrier> => {
  const byCategory = new Map<string, Array<ScoredPrediction>>();
  for (const pair of pairs) {
    const bucket = byCategory.get(pair.category) ?? [];
    bucket.push(pair);
    byCategory.set(pair.category, bucket);
  }
  return [...byCategory.entries()]
    .map(([category, bucket]) => ({
      category,
      brier: brierScore(bucket) ?? 0,
      count: bucket.length,
    }))
    .sort((a, b) => b.brier - a.brier);
};

export interface ReliabilityBin {
  readonly lower: number;
  readonly upper: number;
  readonly meanPredicted: number;
  readonly meanActual: number;
  readonly count: number;
}

// Reliability (calibration) curve: bucket predictions by predicted probability, then compare the
// mean predicted probability to the mean realized rate in each bucket. A well-calibrated engine has
// meanPredicted ≈ meanActual in every populated bin.
export const reliabilityBins = (
  pairs: ReadonlyArray<ScoredPrediction>,
  binCount = 10,
): ReadonlyArray<ReliabilityBin> => {
  const bins = Array.from({ length: binCount }, (_, index) => ({
    lower: index / binCount,
    upper: (index + 1) / binCount,
    predictedSum: 0,
    actualSum: 0,
    count: 0,
  }));
  for (const pair of pairs) {
    const index = Math.min(binCount - 1, Math.max(0, Math.floor(pair.predicted * binCount)));
    const bin = bins[index];
    bin.predictedSum += pair.predicted;
    bin.actualSum += pair.actual;
    bin.count += 1;
  }
  return bins
    .filter((bin) => bin.count > 0)
    .map((bin) => ({
      lower: bin.lower,
      upper: bin.upper,
      meanPredicted: bin.predictedSum / bin.count,
      meanActual: bin.actualSum / bin.count,
      count: bin.count,
    }));
};

export class CalibrationReport extends Schema.Class<CalibrationReport>("CalibrationReport")({
  weeks: Schema.Finite,
  predictions: Schema.Finite,
  brier: Schema.NullOr(Schema.Finite),
  logLoss: Schema.NullOr(Schema.Finite),
  byCategory: Schema.Array(
    Schema.Struct({
      category: Schema.String,
      brier: Schema.Finite,
      count: Schema.Finite,
    }),
  ),
  reliability: Schema.Array(
    Schema.Struct({
      lower: Schema.Finite,
      upper: Schema.Finite,
      meanPredicted: Schema.Finite,
      meanActual: Schema.Finite,
      count: Schema.Finite,
    }),
  ),
}) {}

export const calibrationReport = (
  retros: ReadonlyArray<WeeklyRetrospective>,
): CalibrationReport => {
  const closed = retros.filter(isClosedOut);
  const pairs = scoredPredictions(closed);
  return new CalibrationReport({
    weeks: closed.length,
    predictions: pairs.length,
    brier: brierScore(pairs),
    logLoss: logLoss(pairs),
    byCategory: brierByCategory(pairs),
    reliability: reliabilityBins(pairs),
  });
};

// The single coefficient currently sweepable. `volatility` is a global multiplier on every line's
// Monte Carlo σ: >1 inflates variance (pulls win-probs toward 0.5), <1 deflates it. It is the most
// defensible Brier-affecting knob and is already a per-line parameter, so the sweep needs no engine
// refactor. Extend this union as more coefficients become re-simulatable.
export type SweepCoefficient = "volatility";

const withVolatilityFactor = (line: WeeklyLine, factor: number): WeeklyLine => {
  const volatility = (line.volatility ?? 1) * factor;
  if (line.kind === "batter") {
    const { volatility: _previous, ...rest } = line;
    return new WeeklyBatterLine({ ...rest, volatility });
  }
  const { volatility: _previous, ...rest } = line;
  return new WeeklyPitcherLine({ ...rest, volatility });
};

export interface SweepPoint {
  readonly value: number;
  readonly brier: number | null;
  readonly predictions: number;
}

export interface SweepResult {
  readonly coefficient: SweepCoefficient;
  readonly points: ReadonlyArray<SweepPoint>;
  // The swept value that minimizes Brier, or null when no week is re-simulatable.
  readonly best: number | null;
}

// Re-simulate every retrospective that carries inputs under each candidate coefficient value and
// score the resulting predictions against the recorded outcomes. Returns the Brier at each value
// and the argmin. Pure (simulateMatchup is deterministic given the stored seed), so the sweep is
// reproducible and testable without a DB.
export const sweepCoefficient = (
  coefficient: SweepCoefficient,
  retros: ReadonlyArray<WeeklyRetrospective>,
  values: ReadonlyArray<number>,
): SweepResult => {
  const usable = retros.filter(
    (
      retro,
    ): retro is WeeklyRetrospective & {
      inputs: RetrospectiveInputs;
      outcomes: ReadonlyArray<CategoryOutcome>;
    } => retro.inputs != null && isClosedOut(retro),
  );

  const points = values.map((value) => {
    const pairs = usable.flatMap((retro) => {
      const simulation = simulateMatchup(
        retro.inputs.myRoster.map((line) => withVolatilityFactor(line, value)),
        retro.inputs.opponentRoster.map((line) => withVolatilityFactor(line, value)),
        retro.inputs.iterations,
        retro.inputs.seed,
      );
      const outcomeByCategory = new Map(retro.outcomes.map((o) => [o.category, o]));
      return simulation.categories.flatMap((category) => {
        const outcome = outcomeByCategory.get(category.category);
        return outcome == null
          ? []
          : [
              {
                week: retro.week,
                category: category.category,
                predicted: category.winProbability + 0.5 * category.tieProbability,
                actual: actualPoints(outcome.outcome),
              } satisfies ScoredPrediction,
            ];
      });
    });
    return { value, brier: brierScore(pairs), predictions: pairs.length };
  });

  const scored = points.filter(
    (point): point is SweepPoint & { brier: number } => point.brier != null,
  );
  const best =
    scored.length === 0
      ? null
      : scored.reduce((lowest, point) => (point.brier < lowest.brier ? point : lowest)).value;

  return { coefficient, points, best };
};

export class CalibrationHarness extends Context.Service<
  CalibrationHarness,
  {
    readonly record: (retro: WeeklyRetrospective) => Effect.Effect<void, CalibrationHarnessError>;
    readonly closeOut: (
      week: number,
      outcomes: ReadonlyArray<CategoryOutcome>,
    ) => Effect.Effect<WeeklyRetrospective, CalibrationHarnessError>;
    readonly load: () => Effect.Effect<ReadonlyArray<WeeklyRetrospective>, CalibrationHarnessError>;
    readonly report: () => Effect.Effect<CalibrationReport, CalibrationHarnessError>;
    readonly sweep: (
      coefficient: SweepCoefficient,
      values: ReadonlyArray<number>,
    ) => Effect.Effect<SweepResult, CalibrationHarnessError>;
  }
>()("fantasy-gm/CalibrationHarness") {
  static readonly layerLive = Layer.effect(
    CalibrationHarness,
    Effect.gen(function* () {
      const db = yield* Db;
      const database = yield* db.drizzle;

      const decodeRow = (data: string) =>
        Effect.try({
          try: () => JSON.parse(data) as unknown,
          catch: (error) => new CalibrationHarnessError({ message: String(error) }),
        }).pipe(
          Effect.flatMap((parsed) =>
            (
              Schema.decodeUnknownEffect(WeeklyRetrospective)(parsed) as Effect.Effect<
                WeeklyRetrospective,
                unknown,
                never
              >
            ).pipe(
              Effect.mapError(
                (error) =>
                  new CalibrationHarnessError({
                    message: `Invalid retrospective payload: ${String(error)}`,
                  }),
              ),
            ),
          ),
        );

      const upsert = (retro: WeeklyRetrospective) =>
        Effect.tryPromise({
          try: () =>
            database
              .insert(retrospectives)
              .values({ week: retro.week, data: JSON.stringify(retro) })
              .onConflictDoUpdate({
                target: retrospectives.week,
                set: { data: JSON.stringify(retro) },
              }),
          catch: (error) => new CalibrationHarnessError({ message: String(error) }),
        }).pipe(Effect.asVoid);

      const load = () =>
        Effect.gen(function* () {
          const rows = yield* Effect.tryPromise({
            try: () => database.select().from(retrospectives).orderBy(asc(retrospectives.week)),
            catch: (error) => new CalibrationHarnessError({ message: String(error) }),
          });
          return yield* Effect.forEach(rows, (row) => decodeRow(row.data));
        });

      const record = (retro: WeeklyRetrospective) => upsert(retro);

      const closeOut = (week: number, outcomes: ReadonlyArray<CategoryOutcome>) =>
        Effect.gen(function* () {
          const rows = yield* load();
          const existing = rows.find((retro) => retro.week === week);
          if (existing == null) {
            return yield* Effect.fail(
              new CalibrationHarnessError({
                message: `No retrospective recorded for week ${week}`,
              }),
            );
          }
          const closed = withOutcomes(existing, outcomes);
          yield* upsert(closed);
          return closed;
        });

      const report = () => load().pipe(Effect.map(calibrationReport));

      const sweep = (coefficient: SweepCoefficient, values: ReadonlyArray<number>) =>
        load().pipe(Effect.map((rows) => sweepCoefficient(coefficient, rows, values)));

      return CalibrationHarness.of({ record, closeOut, load, report, sweep });
    }),
  );
}

export const makeCalibrationHarnessTest = (store = new Map<number, WeeklyRetrospective>()) =>
  Layer.succeed(
    CalibrationHarness,
    CalibrationHarness.of({
      record: (retro) =>
        Effect.sync(() => {
          store.set(retro.week, retro);
        }),
      closeOut: (week, outcomes) =>
        Effect.gen(function* () {
          const existing = store.get(week);
          if (existing == null) {
            return yield* Effect.fail(
              new CalibrationHarnessError({
                message: `No retrospective recorded for week ${week}`,
              }),
            );
          }
          const closed = withOutcomes(existing, outcomes);
          store.set(week, closed);
          return closed;
        }),
      load: () => Effect.succeed([...store.values()].sort((a, b) => a.week - b.week)),
      report: () => Effect.succeed(calibrationReport([...store.values()])),
      sweep: (coefficient, values) =>
        Effect.succeed(sweepCoefficient(coefficient, [...store.values()], values)),
    }),
  );
