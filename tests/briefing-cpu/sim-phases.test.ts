import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DecisionReport,
  PRODUCTION_SIMULATION_COUNT,
  prepareSimJob,
  reduceSimJob,
  simulateUnit,
  sumUnitPartials,
} from "../../src/services/DecisionEngine";
import { goldenDecisionReport } from "./golden-decision-report";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";
import { UnitPartial } from "../../src/services/SimJob";

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

// The same fixture used to capture tests/briefing-cpu/golden-decision-report.json from the ORIGINAL
// monolithic rankAddCandidates (captured before the prepare/simulateUnit/reduce refactor).
const goldenSet = () =>
  new WeeklyProjectionSet({
    myRoster: [
      batter({ playerKey: "my-batter", hr: 1, r: 3, rbi: 3 }),
      pitcher({ playerKey: "my-pitcher", k: 4, out: 15 }),
    ],
    opponentRoster: [
      batter({ playerKey: "opp-batter", hr: 4, r: 4, rbi: 4 }),
      pitcher({ playerKey: "opp-pitcher", k: 9, out: 18 }),
    ],
    freeAgents: [
      batter({ playerKey: "power-bat", name: "Power Bat", hr: 12, r: 5, rbi: 6, tb: 12 }),
      pitcher({
        playerKey: "ratio-arm",
        name: "Ratio Arm",
        k: 2,
        out: 6,
        er: 0.5,
        baserunners: 3,
        ip: 4,
      }),
      batter({ playerKey: "speed", name: "Speed", sb: 9 }),
      batter({
        playerKey: "obp-bat",
        name: "OBP Bat",
        obpNumerator: 18,
        obpDenominator: 30,
        obp: 0.6,
      }),
    ],
  });
const goldenHistory = [
  { teamKey: "1", rank: 1, categories: { HR: 240, R: 900 } },
  { teamKey: "2", rank: 2, categories: { HR: 225, R: 870 } },
];

const runPipeline = (set: WeeklyProjectionSet, history = goldenHistory) => {
  const stored = prepareSimJob(set, undefined, history);
  const partials = stored.stored.spec.candidates.map((_, index) => simulateUnit(stored, index + 1));
  return reduceSimJob(stored, partials);
};

describe("Phase 2 sim decomposition", () => {
  it("reproduces the pre-refactor DecisionReport byte-for-byte (refactor equivalence)", () => {
    const report = runPipeline(goldenSet());
    const encoded = Schema.encodeSync(DecisionReport)(report);
    // Deep-equal against the golden captured from the original monolithic rankAddCandidates.
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(
      JSON.parse(JSON.stringify(goldenDecisionReport)),
    );
  });

  it("chunk-sum equivalence: chunkCount=1 is the full-iteration run", () => {
    const stored = prepareSimJob(goldenSet(), undefined, goldenHistory);
    const single = simulateUnit(stored, 1, 0, 1);
    expect(single.iters).toBe(PRODUCTION_SIMULATION_COUNT);
    const summed = sumUnitPartials([single]);
    expect(summed.iters).toBe(PRODUCTION_SIMULATION_COUNT);
    for (const counter of summed.categories) {
      const ref = single.categories.find((c) => c.category === counter.category)!;
      expect(counter.wins).toBe(ref.wins);
      expect(counter.ties).toBe(ref.ties);
      expect(counter.marginSum).toBe(ref.marginSum);
      expect(counter.marginSqSum).toBe(ref.marginSqSum);
    }
  });

  it("chunk-sum equivalence: chunkCount>1 partitions iterations exactly and sums additively", () => {
    const stored = prepareSimJob(goldenSet(), undefined, goldenHistory);
    const unit = 2;
    const chunkCount = 4;
    const chunks = Array.from({ length: chunkCount }, (_, k) =>
      simulateUnit(stored, unit, k, chunkCount),
    );

    // Iterations partition PRODUCTION_SIMULATION_COUNT exactly (floor + deterministic remainder).
    const totalIters = chunks.reduce((sum, c) => sum + c.iters, 0);
    expect(totalIters).toBe(PRODUCTION_SIMULATION_COUNT);

    // Build an independent reference by hand-summing each chunk's counters (proves additivity:
    // no overlap, no double counting across the distinct-seed chunk slices).
    const reference = new Map<
      string,
      { wins: number; ties: number; marginSum: number; marginSqSum: number }
    >();
    for (const chunk of chunks) {
      for (const c of chunk.categories) {
        const acc = reference.get(c.category) ?? {
          wins: 0,
          ties: 0,
          marginSum: 0,
          marginSqSum: 0,
        };
        acc.wins += c.wins;
        acc.ties += c.ties;
        acc.marginSum += c.marginSum;
        acc.marginSqSum += c.marginSqSum;
        reference.set(c.category, acc);
      }
    }

    const summed = sumUnitPartials(chunks);
    expect(summed.iters).toBe(PRODUCTION_SIMULATION_COUNT);
    for (const counter of summed.categories) {
      const ref = reference.get(counter.category)!;
      expect(counter.wins).toBe(ref.wins);
      expect(counter.ties).toBe(ref.ties);
      expect(counter.marginSum).toBe(ref.marginSum);
      expect(counter.marginSqSum).toBe(ref.marginSqSum);
      // wins + ties never exceed the iterations covered.
      expect(counter.wins + counter.ties).toBeLessThanOrEqual(PRODUCTION_SIMULATION_COUNT);
    }
  });

  it("CRN: opponent-side counters are identical across baseline and a candidate unit", () => {
    // A candidate that ONLY appends a pitcher means the opponent's batting-category samples must be
    // byte-identical across the baseline unit and the candidate unit (decoupled opp stream, shared
    // seed). We isolate the opponent in a batting category (SB) by making MY contribution to SB
    // deterministic (volatility 0 → no sampled draws), so the SB margin distribution is decided
    // purely by the opponent's sampled SB. Appending a pitcher candidate must leave SB counters
    // byte-identical.
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "mine", sb: 5, volatility: 0 })],
      opponentRoster: [batter({ playerKey: "opp", sb: 5 })],
      freeAgents: [pitcher({ playerKey: "cand", name: "Cand", k: 12, out: 30 })],
    });
    const stored = prepareSimJob(set, undefined, []);
    const baselineUnit: UnitPartial = simulateUnit(stored, 0);
    const candidateUnit: UnitPartial = simulateUnit(stored, 1);

    const baseSb = baselineUnit.categories.find((c) => c.category === "SB")!;
    const candSb = candidateUnit.categories.find((c) => c.category === "SB")!;
    expect(candSb.wins).toBe(baseSb.wins);
    expect(candSb.ties).toBe(baseSb.ties);
    expect(candSb.marginSum).toBe(baseSb.marginSum);
    expect(candSb.marginSqSum).toBe(baseSb.marginSqSum);
  });

  it("unit 0 reproduces the baseline partial stored in the spec", () => {
    const stored = prepareSimJob(goldenSet(), undefined, goldenHistory);
    const unit0 = simulateUnit(stored, 0);
    expect(unit0.iters).toBe(stored.stored.baseline.iters);
    for (const counter of unit0.categories) {
      const ref = stored.stored.baseline.categories.find((c) => c.category === counter.category)!;
      expect(counter.wins).toBe(ref.wins);
      expect(counter.marginSum).toBe(ref.marginSum);
      expect(counter.marginSqSum).toBe(ref.marginSqSum);
    }
  });
});
