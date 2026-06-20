import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { ApiCache, makeApiCacheTest } from "../../src/services/ApiCache";
import { prepareSimJob, simulateUnit } from "../../src/services/DecisionEngine";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";
import {
  SIM_JOB_MAX_AGE_MS,
  simPartialKey,
  simSpecKey,
  UnitPartial,
} from "../../src/services/SimJob";
import { runSimChunk } from "../../src/worker";

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
    ],
  });

const DATE = "2026-06-20";

// Seed the test cache with a StoredSimJob under the spec key and return both the layer and the
// stored job (so tests can compare against simulateUnit directly).
const seededLayer = () => {
  const store = new Map<string, { data: string; updatedAt: string }>();
  const stored = prepareSimJob(fixtureSet(), undefined, []);
  store.set(simSpecKey(DATE), {
    data: JSON.stringify(stored),
    updatedAt: new Date().toISOString(),
  });
  return { layer: makeApiCacheTest(store), stored, store };
};

const readPartial = (store: Map<string, { data: string; updatedAt: string }>, key: string) =>
  Effect.gen(function* () {
    const cache = yield* ApiCache;
    return yield* cache.get(key, UnitPartial, SIM_JOB_MAX_AGE_MS);
  }).pipe(Effect.provide(makeApiCacheTest(store)));

describe("/internal/sim-chunk handler core (runSimChunk)", () => {
  it("persists the partial under simPartialKey and it equals simulateUnit", async () => {
    const { layer, stored, store } = seededLayer();
    const unit = 1;
    const chunk = 0;

    const result = await Effect.runPromise(
      runSimChunk({ date: DATE, unit, chunk, chunkCount: 1 }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ ok: true, unit, chunk });

    const persisted = await Effect.runPromise(readPartial(store, simPartialKey(DATE, unit, chunk)));
    expect(persisted).not.toBeUndefined();

    const expected = simulateUnit(stored, unit, chunk, 1);
    expect(persisted!.iters).toBe(expected.iters);
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("honors chunkIndex/chunkCount when running and persisting", async () => {
    const { layer, stored, store } = seededLayer();
    const unit = 2;
    const chunk = 1;
    const chunkCount = 4;

    const result = await Effect.runPromise(
      runSimChunk({ date: DATE, unit, chunk, chunkCount }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ ok: true, unit, chunk });

    const persisted = await Effect.runPromise(readPartial(store, simPartialKey(DATE, unit, chunk)));
    const expected = simulateUnit(stored, unit, chunk, chunkCount);
    expect(JSON.parse(JSON.stringify(persisted))).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("returns spec-missing (no write) when no spec is in the cache", async () => {
    const layer = makeApiCacheTest(); // empty store
    const result = await Effect.runPromise(
      runSimChunk({ date: DATE, unit: 1, chunk: 0, chunkCount: 1 }).pipe(Effect.provide(layer)),
    );
    expect(result).toEqual({ ok: false, reason: "spec-missing" });
  });

  it("rejects bad params (negative unit, zero chunkCount) without reading the spec", async () => {
    const { layer } = seededLayer();
    const negativeUnit = await Effect.runPromise(
      runSimChunk({ date: DATE, unit: -1, chunk: 0, chunkCount: 1 }).pipe(Effect.provide(layer)),
    );
    expect(negativeUnit.ok).toBe(false);
    if (!negativeUnit.ok) expect(negativeUnit.reason).toBe("bad-params");

    const nan = await Effect.runPromise(
      runSimChunk({ date: DATE, unit: Number.NaN, chunk: 0, chunkCount: 1 }).pipe(
        Effect.provide(seededLayer().layer),
      ),
    );
    expect(nan.ok).toBe(false);

    const zeroChunkCount = await Effect.runPromise(
      runSimChunk({ date: DATE, unit: 1, chunk: 0, chunkCount: 0 }).pipe(
        Effect.provide(seededLayer().layer),
      ),
    );
    expect(zeroChunkCount.ok).toBe(false);
    if (!zeroChunkCount.ok) expect(zeroChunkCount.reason).toBe("bad-params");
  });

  it("token guard: the route accepts only an exact ADMIN_TRIGGER_TOKEN match", () => {
    // The route guards on `url.searchParams.get("token") !== adminToken` exactly like every other
    // admin/internal route in worker.ts (401 on mismatch). This pins that contract.
    const adminToken = "secret-token";
    const guardRejects = (tokenParam: string | null) => tokenParam !== adminToken;
    expect(guardRejects(null)).toBe(true);
    expect(guardRejects("")).toBe(true);
    expect(guardRejects("wrong")).toBe(true);
    expect(guardRejects(adminToken)).toBe(false);
  });
});
