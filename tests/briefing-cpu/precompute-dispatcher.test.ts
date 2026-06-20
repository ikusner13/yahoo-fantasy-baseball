import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ApiCacheError, makeApiCacheTest } from "../../src/services/ApiCache";
import { prepareSimJob, reduceSimJob } from "../../src/services/DecisionEngine";
import { ManagerBriefingReport } from "../../src/services/ManagerBriefing";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";
import { deliverPreparedBriefing, runPrecompute } from "../../src/services/Scheduler";
import {
  simPartialKey,
  simReducedKey,
  simSpecKey,
  specGeneration,
  UnitPartial,
} from "../../src/services/SimJob";
import { runSimChunk } from "../../src/services/SimChunk";

// The fixtures build specs with contextAt=undefined, so every partial is keyed by this generation.
const GEN = specGeneration(undefined);

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

type Store = Map<string, { data: string; updatedAt: string }>;

// PrecomputeCache adapter over a shared in-memory store (the same store the stubbed self-fetch
// writes partials to). Mirrors makeApiCacheTest's get/put semantics.
const makeCache = (store: Store) => ({
  get: <A>(key: string, schema: Schema.Schema<A>, maxAgeMs: number) =>
    Effect.gen(function* () {
      const row = store.get(key);
      if (row == null) return undefined;
      if (Date.now() - Date.parse(row.updatedAt) > maxAgeMs) return undefined;
      return yield* (
        Schema.decodeUnknownEffect(schema)(JSON.parse(row.data)) as Effect.Effect<A, unknown, never>
      ).pipe(Effect.mapError((error) => new ApiCacheError({ key, message: String(error) })));
    }),
  put: <A>(key: string, value: A) =>
    Effect.sync(() => {
      store.set(key, { data: JSON.stringify(value), updatedAt: new Date().toISOString() });
    }),
});

// Stubbed self-fetch: instead of HTTP, run runSimChunk against the SAME in-memory store so the
// partial gets persisted exactly as the real /internal/sim-chunk route would.
const stubFetchChunk = (store: Store) => (unit: number, chunk: number) =>
  runSimChunk({ date: DATE, unit, chunk, chunkCount: 1 }).pipe(
    Effect.provide(makeApiCacheTest(store)),
    Effect.asVoid,
  );

const stubBriefing = () =>
  new ManagerBriefingReport({
    summary: "stub",
    generatedAt: new Date().toISOString(),
    addsRemaining: 0,
    reservedAdds: 0,
    projectedWeeklyIp: 0,
    closestCategories: [],
    categorySituations: [],
    managerTakeaways: [],
    categoryPlan: [],
    addTriggers: [],
    lineupAlerts: [],
    optimalLineup: [],
    optimalBench: [],
    rejectedTransactions: [],
    doNow: [],
    holdForLater: [],
    warnings: [],
  });

const seededSpecStore = () => {
  const store: Store = new Map();
  const stored = prepareSimJob(fixtureSet(), undefined, []);
  store.set(simSpecKey(DATE), {
    data: JSON.stringify(stored),
    updatedAt: new Date().toISOString(),
  });
  return { store, stored };
};

const run = (store: Store, overrides: Partial<Parameters<typeof runPrecompute>[0]> = {}) =>
  Effect.runPromise(
    runPrecompute({
      cache: makeCache(store),
      date: DATE,
      buildSpec: Effect.sync(() => prepareSimJob(fixtureSet(), undefined, [])),
      fetchChunk: stubFetchChunk(store),
      briefingFromReport: () => Effect.succeed(stubBriefing()),
      ...overrides,
    }),
  );

describe("precompute dispatcher (runPrecompute)", () => {
  it("ONE-STAGE-PER-TICK: tick 1 builds spec and RETURNS (no fan-out, no reduce); a later tick reduces", async () => {
    const store: Store = new Map();

    // Tick 1: builds + persists the spec, then returns spec-built. It MUST NOT have fanned out or
    // reduced — spec-build and reduce never co-occur (the ~1037ms exceededCpu failure this prevents).
    const first = await run(store);
    expect(first.stage).toBe("spec-built");
    expect(store.has(simSpecKey(DATE))).toBe(true);
    expect(store.has(simPartialKey(DATE, 1, 0, GEN))).toBe(false);
    expect(store.has(simPartialKey(DATE, 2, 0, GEN))).toBe(false);
    expect(store.has(simReducedKey(DATE))).toBe(false);

    // Tick 2 (spec present, not stale): fans out + reduces.
    const second = await run(store);
    expect(second.stage).toBe("reduced");
    expect(store.has(simReducedKey(DATE))).toBe(true);
    expect(store.has(simPartialKey(DATE, 1, 0, GEN))).toBe(true);
    expect(store.has(simPartialKey(DATE, 2, 0, GEN))).toBe(true);
  });

  it("the persisted prepared briefing decodes as a ManagerBriefingReport", async () => {
    const store: Store = new Map();
    await run(store); // tick 1: spec-built
    await run(store); // tick 2: reduced
    const row = store.get(simReducedKey(DATE))!;
    const decoded = Schema.decodeUnknownSync(ManagerBriefingReport)(JSON.parse(row.data));
    expect(decoded.summary).toBe("stub");
  });

  it("a died chunk leaves the unit pending and a later tick retries only it", async () => {
    const { store } = seededSpecStore();
    let calls = 0;
    // First tick: unit 1 succeeds, unit 2's chunk "dies" (no partial written) the first time.
    const flakyFetch = (unit: number, chunk: number) =>
      Effect.gen(function* () {
        calls += 1;
        if (unit === 2 && calls <= 2) return; // dies: no partial persisted for unit 2 this tick
        yield* stubFetchChunk(store)(unit, chunk);
      });
    const first = await run(store, { fetchChunk: flakyFetch });
    expect(first.stage).toBe("fan-out");
    if (first.stage === "fan-out") expect(first.pending).toEqual([2]);
    expect(store.has(simPartialKey(DATE, 1, 0, GEN))).toBe(true);
    expect(store.has(simPartialKey(DATE, 2, 0, GEN))).toBe(false);
    expect(store.has(simReducedKey(DATE))).toBe(false);

    // Second tick: unit 1 already done (not re-fetched), unit 2 now succeeds → reduce.
    const second = await run(store, { fetchChunk: stubFetchChunk(store) });
    expect(second.stage).toBe("reduced");
    expect(store.has(simPartialKey(DATE, 2, 0, GEN))).toBe(true);
    expect(store.has(simReducedKey(DATE))).toBe(true);
  });

  it("only fetches still-pending units on a resume tick (completed partials are reused)", async () => {
    const { store } = seededSpecStore();
    // Pre-seed unit 1's partial so only unit 2 should be fetched.
    await Effect.runPromise(stubFetchChunk(store)(1, 0));
    const fetched: Array<number> = [];
    const trackingFetch = (unit: number, chunk: number) =>
      Effect.gen(function* () {
        fetched.push(unit);
        yield* stubFetchChunk(store)(unit, chunk);
      });
    const outcome = await run(store, { fetchChunk: trackingFetch });
    expect(outcome.stage).toBe("reduced");
    expect(fetched).toEqual([2]);
  });

  it("once reduced, a subsequent tick is a no-op (already-reduced)", async () => {
    const store: Store = new Map();
    await run(store); // spec-built
    await run(store); // reduced
    const again = await run(store);
    expect(again.stage).toBe("already-reduced");
  });

  it("rebuilds the spec and re-fans-out when a newer context exists (staleness)", async () => {
    const store: Store = new Map();
    const specForContext = (contextAt: string) =>
      Effect.sync(() => prepareSimJob(fixtureSet(), undefined, [], contextAt));
    // Spec built from an older context: tick 1 builds spec (spec-built), tick 2 reduces.
    const built = await run(store, {
      contextAt: "2026-06-20T10:00:00.000Z",
      buildSpec: specForContext("2026-06-20T10:00:00.000Z"),
    });
    expect(built.stage).toBe("spec-built");
    await run(store, {
      contextAt: "2026-06-20T10:00:00.000Z",
      buildSpec: specForContext("2026-06-20T10:00:00.000Z"),
    });
    expect(store.has(simReducedKey(DATE))).toBe(true);
    const firstSpec = store.get(simSpecKey(DATE))!.data;

    // A newer context arrives: the spec must be REBUILT (spec-built), not treated as already-reduced
    // — one-stage-per-tick means this rebuild tick returns immediately without re-reducing.
    const rebuild = await run(store, {
      contextAt: "2026-06-20T15:00:00.000Z",
      buildSpec: specForContext("2026-06-20T15:00:00.000Z"),
    });
    expect(rebuild.stage).toBe("spec-built");
    // A following tick (spec now fresh, not stale) re-fans-out and re-reduces.
    const outcome = await run(store, {
      contextAt: "2026-06-20T15:00:00.000Z",
      buildSpec: specForContext("2026-06-20T15:00:00.000Z"),
    });
    expect(outcome.stage).toBe("reduced");
    const rebuiltSpec = store.get(simSpecKey(DATE))!.data;
    const parsedFirst = JSON.parse(firstSpec) as { stored: { contextAt?: string } };
    const parsedRebuilt = JSON.parse(rebuiltSpec) as { stored: { contextAt?: string } };
    expect(parsedFirst.stored.contextAt).toBe("2026-06-20T10:00:00.000Z");
    expect(parsedRebuilt.stored.contextAt).toBe("2026-06-20T15:00:00.000Z");
  });

  it("reduce output matches reduceSimJob over the persisted partials", async () => {
    const { store, stored } = seededSpecStore();
    let captured: ReturnType<typeof reduceSimJob> | undefined;
    await run(store, {
      buildSpec: Effect.succeed(stored),
      briefingFromReport: (report) => {
        captured = report;
        return Effect.succeed(stubBriefing());
      },
    });
    expect(captured).not.toBeUndefined();
    // Independently decode the persisted partials and reduce — must equal the dispatcher's report.
    const partials = stored.stored.spec.candidates.map((_unused, index) => {
      const row = store.get(simPartialKey(DATE, index + 1, 0, GEN))!;
      return Schema.decodeUnknownSync(UnitPartial)(JSON.parse(row.data));
    });
    const expected = reduceSimJob(stored, partials);
    expect(JSON.parse(JSON.stringify(captured))).toEqual(JSON.parse(JSON.stringify(expected)));
  });
});

describe("send-briefing read-only delivery (deliverPreparedBriefing)", () => {
  const okNotifiers = () => {
    const posted: Array<string> = [];
    return {
      posted,
      telegram: { postManagerBriefing: () => Effect.sync(() => void posted.push("telegram")) },
      discord: { postManagerBriefing: () => Effect.sync(() => void posted.push("discord")) },
    };
  };

  it("returns not-ready and delivers nothing when no prepared briefing exists", async () => {
    const store: Store = new Map();
    const { posted, telegram, discord } = okNotifiers();
    const outcome = await Effect.runPromise(
      deliverPreparedBriefing(makeCache(store), DATE, { telegram, discord }),
    );
    expect(outcome.status).toBe("not-ready");
    expect(posted).toEqual([]);
  });

  it("delivers and caches when a prepared briefing exists", async () => {
    const store: Store = new Map();
    store.set(simReducedKey(DATE), {
      data: JSON.stringify(stubBriefing()),
      updatedAt: new Date().toISOString(),
    });
    const { posted, telegram, discord } = okNotifiers();
    const outcome = await Effect.runPromise(
      deliverPreparedBriefing(makeCache(store), DATE, { telegram, discord }),
    );
    expect(outcome.status).toBe("delivered");
    expect(posted).toEqual(["telegram", "discord"]);
    // the prepared briefing was copied to the delivery source key
    expect(store.has("manager-briefing:last:v1")).toBe(true);
  });
});
