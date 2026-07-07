// Phase 5 — full day-cycle integration test, in-process.
//
// Drives the ENTIRE fan-out pipeline in one place against a single shared in-memory ApiCache
// store, with the self-fetch sub-invocation stubbed by running runSimChunk against that SAME store
// (exactly as Phase 4 wires the real /internal/sim-chunk route):
//
//   build context (fixtureSet) → runPrecompute (spec → fan-out → reduce; prepared briefing persisted
//   at simReducedKey) → deliverPreparedBriefing (REAL read-only send path; notifiers stubbed) marks
//   it delivered + copies to LAST_MANAGER_BRIEFING_CACHE_KEY → a subsequent tick is idle (sent-today,
//   proven through selectDueTask).
//
// Also proves the daily-delivery GUARANTEE: if the first dispatcher tick is interrupted right after
// stage 1 (spec built, ZERO partials persisted), a later healthy tick resumes the fan-out, reduces,
// and delivery still succeeds across ticks.
//
// The narrower stage-level transitions (died-chunk-mid-fan-out resume, pending reuse, staleness,
// reduce-equivalence, deliverPreparedBriefing not-ready/delivered) are covered by
// precompute-dispatcher.test.ts; this file adds the missing end-to-end "spec → … → delivered → idle"
// happy path through the real send path plus the interrupted-after-stage-1 guarantee.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ApiCacheError, makeApiCacheTest } from "../../src/services/ApiCache";
import { prepareSimJob } from "../../src/services/DecisionEngine";
import {
  LAST_MANAGER_BRIEFING_CACHE_KEY,
  ManagerBriefingReport,
} from "../../src/services/ManagerBriefing";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";
import {
  deliverPreparedBriefing,
  runPrecompute,
  selectDueTask,
  type SchedulerTask,
} from "../../src/services/Scheduler";
import { simReducedKey, simSpecKey } from "../../src/services/SimJob";
import { runSimChunk } from "../../src/services/SimChunk";

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

// A real ManagerBriefingReport so the prepared artifact round-trips through deliverManagerBriefing.
const stubBriefing = () =>
  new ManagerBriefingReport({
    summary: "full-cycle",
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
    waiverTargets: [],
    warnings: [],
  });

// Stub notifiers that record which channels were posted; both succeed.
const okNotifiers = () => {
  const posted: Array<string> = [];
  return {
    posted,
    telegram: { postManagerBriefing: () => Effect.sync(() => void posted.push("telegram")) },
    discord: { postManagerBriefing: () => Effect.sync(() => void posted.push("discord")) },
  };
};

const runPrecomputeTick = (store: Store, fetchChunk = stubFetchChunk(store)) =>
  Effect.runPromise(
    runPrecompute({
      cache: makeCache(store),
      date: DATE,
      // Build context = build spec from the projection fixtures (one baseline sim in prepareSimJob).
      buildSpec: Effect.sync(() => prepareSimJob(fixtureSet(), undefined, [])),
      fetchChunk,
      briefingFromReport: () => Effect.succeed(stubBriefing()),
    }),
  );

const noCanRun: Record<SchedulerTask, boolean> = {
  "refresh-projections": false,
  "refresh-context": false,
  precompute: false,
  "apply-lineup": false,
  "send-briefing": false,
};

describe("full day-cycle (precompute → real send → idle)", () => {
  it("one healthy precompute tick then deliverPreparedBriefing delivers; next tick is idle (sent-today)", async () => {
    const store: Store = new Map();

    // ONE-STAGE-PER-TICK: tick 1 builds the spec and returns (spec-build and reduce never co-occur).
    const specTick = await runPrecomputeTick(store);
    expect(specTick.stage).toBe("spec-built");
    expect(store.has(simReducedKey(DATE))).toBe(false);

    // Tick 2 (spec present): fans out + reduces.
    const precompute = await runPrecomputeTick(store);
    expect(precompute.stage).toBe("reduced");
    // A valid ManagerBriefingReport is persisted at the reduced key.
    const reducedRow = store.get(simReducedKey(DATE))!;
    const persisted = Schema.decodeUnknownSync(ManagerBriefingReport)(JSON.parse(reducedRow.data));
    expect(persisted.summary).toBe("full-cycle");

    // STAGE 4: the REAL read-only send path delivers the prepared briefing.
    const { posted, telegram, discord } = okNotifiers();
    const delivery = await Effect.runPromise(
      deliverPreparedBriefing(makeCache(store), DATE, { telegram, discord }),
    );
    expect(delivery.status).toBe("delivered");
    expect(posted).toEqual(["telegram", "discord"]);
    // It copied the prepared briefing to the delivery source key.
    expect(store.has(LAST_MANAGER_BRIEFING_CACHE_KEY)).toBe(true);

    // Now model the scheduler state AFTER a successful send (sendAt = now) and prove the next tick
    // is idle: prepared briefing present (not missing) and already sent today ⇒ nothing due.
    const now = new Date("2026-06-20T15:00:00.000Z"); // 11am ET, well after the morning slot
    const due = selectDueTask(
      now,
      { projectionAt: now.getTime(), contextAt: now.getTime(), sendAt: now.getTime() },
      { ...noCanRun, precompute: true, "send-briefing": true },
      /* briefingDue */ true,
      /* refreshBriefingDue */ false,
      /* lineupBeforeBriefingDue */ false,
      /* preparedBriefingMissing */ false,
    );
    expect(due).toBe("idle");
  });

  it("guarantee: a tick interrupted right after stage 1 (no partials) is resumed by a later tick and still delivers", async () => {
    const store: Store = new Map();

    // FIRST tick interrupted after stage 1: spec is built/persisted but EVERY chunk fetch dies, so
    // no partials are written. The dispatcher reports spec-built (not reduced) and writes no reduced
    // artifact — the next tick must resume.
    const deadFetch = () => Effect.void; // self-fetch "dies": persists nothing
    const interrupted = await runPrecomputeTick(store, deadFetch);
    expect(interrupted.stage).toBe("spec-built");
    expect(store.has(simSpecKey(DATE))).toBe(true);
    expect(store.has(simReducedKey(DATE))).toBe(false);

    // Mid-cycle a send tick would find NOTHING ready → not-ready, delivers nothing (no false send).
    const { posted: earlyPosted, telegram: t0, discord: d0 } = okNotifiers();
    const early = await Effect.runPromise(
      deliverPreparedBriefing(makeCache(store), DATE, { telegram: t0, discord: d0 }),
    );
    expect(early.status).toBe("not-ready");
    expect(earlyPosted).toEqual([]);

    // SECOND (healthy) tick resumes: spec already present, fan-out completes, reduce persists.
    const resumed = await runPrecomputeTick(store);
    expect(resumed.stage).toBe("reduced");
    expect(store.has(simReducedKey(DATE))).toBe(true);

    // Delivery now succeeds across ticks — the daily-delivery guarantee.
    const { posted, telegram, discord } = okNotifiers();
    const delivery = await Effect.runPromise(
      deliverPreparedBriefing(makeCache(store), DATE, { telegram, discord }),
    );
    expect(delivery.status).toBe("delivered");
    expect(posted).toEqual(["telegram", "discord"]);
  });

  it("send-briefing stays selectable across ticks while the prepared briefing is still missing", async () => {
    // Before reduce lands, preparedBriefingMissing=true keeps the scheduler driving precompute (the
    // retry mechanism) and never selects send-briefing — so no premature/empty send.
    const now = new Date("2026-06-20T15:00:00.000Z");
    const whileMissing = selectDueTask(
      now,
      { projectionAt: now.getTime(), contextAt: now.getTime() },
      { ...noCanRun, precompute: true, "send-briefing": true },
      true,
      false,
      false,
      /* preparedBriefingMissing */ true,
    );
    expect(whileMissing).toBe("precompute");

    // Once reduced (present) but not yet sent today, send-briefing becomes due.
    const whenReady = selectDueTask(
      now,
      { projectionAt: now.getTime(), contextAt: now.getTime() },
      { ...noCanRun, precompute: true, "send-briefing": true },
      true,
      false,
      false,
      /* preparedBriefingMissing */ false,
    );
    expect(whenReady).toBe("send-briefing");
  });
});
