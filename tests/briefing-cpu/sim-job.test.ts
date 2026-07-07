import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WeeklyBatterLine, WeeklyPitcherLine } from "../../src/services/ProjectionModel";
import {
  SIM_JOB_MAX_AGE_MS,
  SimJobSpec,
  StoredSimJobSpec,
  UnitPartial,
  simPartialKey,
  simReducedKey,
  simSpecKey,
} from "../../src/services/SimJob";

const batter = new WeeklyBatterLine({
  kind: "batter",
  playerKey: "p1",
  name: "Bat One",
  team: "NYY",
  pa: 25,
  r: 4,
  h: 7,
  hr: 2,
  rbi: 5,
  sb: 1,
  tb: 14,
  obpNumerator: 9,
  obpDenominator: 25,
  obp: 0.36,
});

const pitcher = new WeeklyPitcherLine({
  kind: "pitcher",
  playerKey: "p2",
  name: "Pitch One",
  team: "BOS",
  ip: 6,
  out: 18,
  k: 7,
  er: 2,
  baserunners: 8,
  era: 3,
  whip: 1.1,
  qs: 1,
  svh: 0,
});

describe("SimJob D1 key helpers", () => {
  it("produces dated, versioned keys", () => {
    expect(simSpecKey("2026-06-20")).toBe("sim:job:2026-06-20:spec:v1");
    expect(simReducedKey("2026-06-20")).toBe("sim:job:2026-06-20:reduced:v1.r2");
    // Partial keys carry a spec-generation segment (default "0") so a newer-context rebuild's
    // partials never collide with the prior spec's on the same date.
    expect(simPartialKey("2026-06-20", 3)).toBe("sim:job:2026-06-20:partial:0:3:0:v1");
    expect(simPartialKey("2026-06-20", 3, 2)).toBe("sim:job:2026-06-20:partial:0:3:2:v1");
    expect(simPartialKey("2026-06-20", 3, 2, "abc")).toBe("sim:job:2026-06-20:partial:abc:3:2:v1");
  });

  it("self-expires within a day-cycle plus retries", () => {
    expect(SIM_JOB_MAX_AGE_MS).toBe(36 * 60 * 60 * 1_000);
  });
});

describe("SimJob payload schemas", () => {
  it("round-trips a StoredSimJobSpec through JSON", () => {
    const spec = new SimJobSpec({
      scoringCategories: ["R", "HR", "K"],
      scoringRoster: [batter],
      opponentRoster: [pitcher],
      candidates: [{ line: pitcher, seasonSgpDelta: 1.5 }],
      denominators: { R: 35, HR: 12, K: 55 },
      baseSeed: 62744,
    });
    const baseline = new UnitPartial({
      iters: 5000,
      categories: [{ category: "R", wins: 2600, ties: 10, marginSum: 1200, marginSqSum: 90000 }],
    });
    const stored = new StoredSimJobSpec({
      spec,
      baseline,
      unitCount: 7,
      contextAt: "2026-06-20T13:00:00Z",
    });

    const encoded = JSON.parse(JSON.stringify(stored));
    const decoded = Schema.decodeUnknownSync(StoredSimJobSpec)(encoded);

    expect(decoded.unitCount).toBe(7);
    expect(decoded.spec.candidates[0].line.playerKey).toBe("p2");
    expect(decoded.baseline.categories[0].wins).toBe(2600);
    expect(decoded.contextAt).toBe("2026-06-20T13:00:00Z");
  });
});
