import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import { makeApiCacheTest } from "../../src/services/ApiCache";
import {
  WeeklyRetrospective,
  makeCalibrationHarnessTest,
} from "../../src/services/CalibrationHarness";
import { calibrationInputsFromSpec, prepareSimJob } from "../../src/services/DecisionEngine";
import { LeagueState, type LeagueStateSnapshot } from "../../src/services/LeagueState";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";
import { simSpecKey } from "../../src/services/SimJob";
import { recordCurrentWeekPrediction } from "../../src/routines/calibration";

const batter = (o: Partial<ConstructorParameters<typeof WeeklyBatterLine>[0]> = {}) =>
  new WeeklyBatterLine({
    kind: "batter",
    playerKey: "b",
    name: "B",
    team: "NYY",
    pa: 25,
    r: 4,
    h: 6,
    hr: 1,
    rbi: 4,
    sb: 1,
    tb: 10,
    obpNumerator: 8,
    obpDenominator: 24,
    obp: 8 / 24,
    ...o,
  });
const pitcher = (o: Partial<ConstructorParameters<typeof WeeklyPitcherLine>[0]> = {}) =>
  new WeeklyPitcherLine({
    kind: "pitcher",
    playerKey: "p",
    name: "P",
    team: "SEA",
    ip: 6,
    out: 18,
    k: 7,
    er: 2,
    baserunners: 7,
    era: 3,
    whip: 7 / 6,
    qs: 0.7,
    svh: 0,
    ...o,
  });

const fixtureSet = () =>
  new WeeklyProjectionSet({
    myRoster: [batter({ playerKey: "my-batter" }), pitcher({ playerKey: "my-pitcher" })],
    opponentRoster: [
      batter({ playerKey: "opp-batter", hr: 4 }),
      pitcher({ playerKey: "opp-pitcher", k: 9 }),
    ],
    freeAgents: [batter({ playerKey: "power-bat", hr: 12 })],
  });

const easternDateKey = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const snapshot = { matchup: { week: 6 } } as unknown as LeagueStateSnapshot;
const leagueStateLayer = Layer.succeed(
  LeagueState,
  LeagueState.of({ snapshot: Effect.succeed(snapshot) }),
);

type Store = Map<string, { data: string; updatedAt: string }>;
const seedSpec = (store: Store) => {
  const stored = prepareSimJob(fixtureSet(), undefined, []);
  store.set(simSpecKey(easternDateKey(new Date())), {
    data: JSON.stringify(stored),
    updatedAt: new Date().toISOString(),
  });
  return stored;
};

describe("recordCurrentWeekPrediction (F8) — spec reuse, no inline sim", () => {
  it("records the week's prediction from today's already-built spec baseline", () =>
    Effect.gen(function* () {
      const cacheStore: Store = new Map();
      const stored = seedSpec(cacheStore);
      const harnessStore = new Map<number, WeeklyRetrospective>();

      const week = yield* recordCurrentWeekPrediction.pipe(
        Effect.provide(
          Layer.mergeAll(
            leagueStateLayer,
            makeApiCacheTest(cacheStore),
            makeCalibrationHarnessTest(harnessStore),
          ),
        ),
      );

      expect(week).toBe(6);
      const retro = harnessStore.get(6)!;
      expect(retro).toBeDefined();

      // Predictions match the spec's baseline categories exactly (pure aggregation, not a re-sim).
      const expected = calibrationInputsFromSpec(stored).baseline;
      expect(retro.predictions.map((p) => p.category)).toEqual(
        expected.categories.map((c) => c.category),
      );
      for (const prediction of retro.predictions) {
        const baselineCategory = expected.categories.find(
          (c) => c.category === prediction.category,
        )!;
        expect(prediction.winProbability).toBe(baselineCategory.winProbability);
      }
      // The exact simulated active roster is stored for later re-scoring.
      expect(retro.inputs?.myRoster.length).toBe(stored.stored.spec.scoringRoster.length);
    }).pipe(Effect.runPromise));

  it("is a no-op when today's spec is not built yet", () =>
    Effect.gen(function* () {
      const harnessStore = new Map<number, WeeklyRetrospective>();
      const result = yield* recordCurrentWeekPrediction.pipe(
        Effect.provide(
          Layer.mergeAll(
            leagueStateLayer,
            makeApiCacheTest(new Map()),
            makeCalibrationHarnessTest(harnessStore),
          ),
        ),
      );

      expect(result).toBeUndefined();
      expect(harnessStore.size).toBe(0);
    }).pipe(Effect.runPromise));
});
