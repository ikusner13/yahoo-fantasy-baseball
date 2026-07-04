import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ApiCache } from "./ApiCache.ts";
import { FREE_TIER_MODE } from "../infra/free-tier.ts";
import { DiscordNotifier } from "./DiscordNotifier.ts";
import { LeagueState } from "./LeagueState.ts";
import {
  deliverySucceeded,
  LAST_MANAGER_DELIVERY_CACHE_KEY,
  type ManagerDeliveryReport,
} from "./ManagerDelivery.ts";
import {
  LAST_MANAGER_BRIEFING_CACHE_KEY,
  ManagerBriefing,
  ManagerBriefingReport,
} from "./ManagerBriefing.ts";
import { LAST_MANAGER_WRITE_STATUS_CACHE_KEY, ManagerWriteStatus } from "./ManagerWriteStatus.ts";
import { ProjectionData } from "./ProjectionData.ts";
import { StandingsHistory } from "./StandingsHistory.ts";
import { TelegramNotifier } from "./TelegramNotifier.ts";
import { WeeklyProjections } from "./WeeklyProjections.ts";
import { YahooLineupExecutor } from "./YahooLineupExecutor.ts";
import { prepareSimJob, reduceSimJob, StoredSimJob, sumUnitPartials } from "./DecisionEngine.ts";
import {
  SIM_JOB_MAX_AGE_MS,
  simPartialKey,
  simReducedGenKey,
  simReducedKey,
  SimReducedGen,
  simSpecKey,
  specGeneration,
  UnitPartial,
} from "./SimJob.ts";
import { deliverManagerBriefing } from "../routines/delivery.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const PRE_FIRST_PITCH_LEAD_MS = 2 * HOUR;
const MIN_BRIEFING_REFRESH_GAP_MS = 2 * HOUR;

type SchedulerTask =
  | "refresh-projections"
  | "refresh-context"
  | "precompute"
  | "apply-lineup"
  | "send-briefing";
const SCHEDULER_TASKS = [
  "refresh-projections",
  "refresh-context",
  "precompute",
  "apply-lineup",
  "send-briefing",
] as const satisfies ReadonlyArray<SchedulerTask>;

export const taskStateKey = (task: SchedulerTask) => `scheduler:task:${task}:last-success:v1`;
export const taskRunCountKey = (task: SchedulerTask, date: string) =>
  `scheduler:task:${task}:run-count:${date}:v2`;
const DAILY_TASK_LIMITS = FREE_TIER_MODE.dailyTaskLimits satisfies Record<SchedulerTask, number>;
export class TaskState extends Schema.Class<TaskState>("TaskState")({
  completedAt: Schema.String,
}) {}

export class TaskRunCount extends Schema.Class<TaskRunCount>("TaskRunCount")({
  date: Schema.String,
  count: Schema.Finite,
}) {}

export class SchedulerError extends Data.TaggedError("SchedulerError")<{
  readonly message: string;
  readonly task?: SchedulerTask;
}> {}

export class SchedulerTaskStatus extends Schema.Class<SchedulerTaskStatus>("SchedulerTaskStatus")({
  task: Schema.Union([
    Schema.Literal("refresh-projections"),
    Schema.Literal("refresh-context"),
    Schema.Literal("precompute"),
    Schema.Literal("apply-lineup"),
    Schema.Literal("send-briefing"),
  ]),
  completedAt: Schema.optional(Schema.String),
  runCountToday: Schema.Finite,
  canRunToday: Schema.Boolean,
}) {}

export class SchedulerStatus extends Schema.Class<SchedulerStatus>("SchedulerStatus")({
  date: Schema.String,
  tasks: Schema.Array(SchedulerTaskStatus),
}) {}

type ApiCacheService = {
  readonly get: <A>(
    key: string,
    schema: Schema.Schema<A>,
    maxAgeMs: number,
  ) => Effect.Effect<A | undefined, unknown>;
  readonly put?: <A>(key: string, value: A) => Effect.Effect<void, unknown>;
};

export const recordSchedulerTaskSuccess = (
  cache: ApiCacheService & {
    readonly put: <A>(key: string, value: A) => Effect.Effect<void, unknown>;
  },
  task: SchedulerTask,
  now = new Date(),
) =>
  Effect.gen(function* () {
    const date = easternDateKey(now);
    const count =
      (yield* cache.get(taskRunCountKey(task, date), TaskRunCount, 36 * HOUR))?.count ?? 0;
    yield* cache.put(taskRunCountKey(task, date), new TaskRunCount({ date, count: count + 1 }));
    yield* cache.put(taskStateKey(task), new TaskState({ completedAt: now.toISOString() }));
  });

export const readSchedulerStatus = (cache: ApiCacheService, now = new Date()) =>
  Effect.gen(function* () {
    const date = easternDateKey(now);
    const tasks = yield* Effect.all(
      SCHEDULER_TASKS.map((task) =>
        Effect.gen(function* () {
          const [completedAt, runCountToday] = yield* Effect.all([
            cache.get(taskStateKey(task), TaskState, 7 * 24 * HOUR).pipe(
              Effect.map((state) => state?.completedAt),
              Effect.mapError((error) => toSchedulerError(task, error)),
            ),
            cache.get(taskRunCountKey(task, date), TaskRunCount, 36 * HOUR).pipe(
              Effect.map((state) => state?.count ?? 0),
              Effect.mapError((error) => toSchedulerError(task, error)),
            ),
          ]);
          return new SchedulerTaskStatus({
            task,
            completedAt,
            runCountToday,
            canRunToday: runCountToday < DAILY_TASK_LIMITS[task],
          });
        }),
      ),
      { concurrency: 1 },
    );
    return new SchedulerStatus({ date, tasks });
  });

const toSchedulerError = (task: SchedulerTask, error: unknown) =>
  new SchedulerError({
    task,
    message: error instanceof Error ? error.message : String(error),
  });

export const easternDateKey = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export const easternHour = (date: Date) => {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const parsed = Number.parseInt(hour, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

type SchedulerCompletionState = {
  readonly projectionAt?: number;
  readonly contextAt?: number;
  readonly applyLineupAt?: number;
  readonly sendAt?: number;
};

export const selectDueTask = (
  now: Date,
  state: SchedulerCompletionState,
  canRun: Record<SchedulerTask, boolean>,
  briefingDue: boolean,
  refreshBriefingDue = briefingDue,
  lineupBeforeBriefingDue = briefingDue,
  // Whether today's prepared briefing (the precompute reduce artifact) is missing in D1. Drives
  // the precompute fan-out: while it is missing the scheduler keeps advancing/retrying precompute,
  // and only once it is present can send-briefing deliver. Defaults to false so the live
  // (non-fan-out) flow and existing callers keep their prior behavior.
  preparedBriefingMissing = false,
) => {
  const nowMs = now.getTime();
  if (
    (state.projectionAt == null || nowMs - state.projectionAt > 12 * HOUR) &&
    canRun["refresh-projections"]
  ) {
    return "refresh-projections" as const;
  }
  const sentToday =
    state.sendAt != null && easternDateKey(new Date(state.sendAt)) === easternDateKey(now);
  const appliedLineupToday =
    state.applyLineupAt != null &&
    easternDateKey(new Date(state.applyLineupAt)) === easternDateKey(now);
  const contextRefreshedAfterSend =
    state.contextAt != null && state.sendAt != null && state.contextAt > state.sendAt;
  const enoughTimeSinceSend =
    state.sendAt != null && nowMs - state.sendAt >= MIN_BRIEFING_REFRESH_GAP_MS;
  if (
    briefingDue &&
    (state.contextAt == null || nowMs - state.contextAt > HOUR) &&
    canRun["refresh-context"]
  ) {
    return "refresh-context" as const;
  }
  // Precompute (spec → fan-out → reduce, gated on D1 state) runs early and on ANY tick where
  // today's prepared briefing is still missing, so a died dispatcher/chunk is retried next tick.
  // Reaching here means projections/context aren't blocking, so inputs are ready.
  if (preparedBriefingMissing && !sentToday && canRun["precompute"]) {
    return "precompute" as const;
  }
  if (!appliedLineupToday && canRun["apply-lineup"] && lineupBeforeBriefingDue) {
    return "apply-lineup" as const;
  }
  if (!sentToday && !preparedBriefingMissing && canRun["send-briefing"] && briefingDue) {
    return "send-briefing" as const;
  }
  if (
    sentToday &&
    refreshBriefingDue &&
    canRun["send-briefing"] &&
    contextRefreshedAfterSend &&
    enoughTimeSinceSend
  ) {
    return "send-briefing" as const;
  }
  if ((state.contextAt == null || nowMs - state.contextAt > HOUR) && canRun["refresh-context"]) {
    return "refresh-context" as const;
  }
  return "idle" as const;
};

export const shouldMarkSendBriefingComplete = (delivery: ManagerDeliveryReport) =>
  deliverySucceeded(delivery);

// What one precompute tick advanced. Each tick advances whichever stage is next, gating on what
// already exists in D1 for today's date; a healthy tick can run all three (the heavy per-unit sim
// CPU lives in the offloaded self-fetch sub-invocations, so the dispatcher itself stays cheap).
export type PrecomputeOutcome =
  | { readonly stage: "spec-built"; readonly unitCount: number; readonly reduced: boolean }
  | {
      readonly stage: "fan-out";
      readonly pending: ReadonlyArray<number>;
      readonly reduced: boolean;
    }
  | { readonly stage: "reduced" }
  | { readonly stage: "already-reduced" };

// Minimal cache surface the precompute dispatcher needs: typed get + put. Errors surface as the
// effect error channel and are mapped to SchedulerError by the caller.
type PrecomputeCache = {
  readonly get: <A>(
    key: string,
    schema: Schema.Schema<A>,
    maxAgeMs: number,
  ) => Effect.Effect<A | undefined, unknown>;
  readonly put: <A>(key: string, value: A) => Effect.Effect<void, unknown>;
};

// The precompute dispatcher, gated entirely on D1 state so a DIED dispatcher/chunk is resumable on
// the next tick. ONE-STAGE-PER-TICK is a HARD RULE: a single invocation advances roughly one heavy
// stage, and spec-build and reduce NEVER run in the same invocation (a tick doing both was ~1037ms
// CPU → exceededCpu; spec-build alone is ~874ms, fan-out+reduce together ~632ms — both safe).
//   Stage 1 (spec): no StoredSimJob at simSpecKey(date) → build it (one baseline sim) and persist,
//     then RETURN IMMEDIATELY (`spec-built`). A same-day spec is pinned to the context it was built
//     from; later refresh-context ticks must not invalidate it, or fan-out never gets a stable spec
//     to finish. It does NOT fan out or reduce this tick; a later tick (spec present) does that.
//   Stage 2 (fan-out): pending = {1..unitCount} minus units whose simPartialKey already exists.
//     Fan out each pending unit to the separate SimChunkWorker (its OWN CPU budget); the dispatcher
//     only awaits I/O. This shares a tick with stage 3 (fan-out is I/O, reduce ~632ms → safe).
//   Stage 3 (reduce): all partials present AND no reduced artifact → reduceSimJob → assemble the
//     ManagerBriefingReport via briefingFromReport → persist under simReducedKey(date).
// chunkCount defaults to 1 (units×chunks ≤ ~40 cap honored by the caller's chunk knob).
export const runPrecompute = (deps: {
  readonly cache: PrecomputeCache;
  readonly date: string;
  readonly contextAt?: string;
  readonly chunkCount?: number;
  readonly buildSpec: Effect.Effect<StoredSimJob, unknown>;
  readonly fetchChunk: (unit: number, chunk: number) => Effect.Effect<void, unknown>;
  readonly briefingFromReport: (
    report: ReturnType<typeof reduceSimJob>,
  ) => Effect.Effect<ManagerBriefingReport, unknown>;
}): Effect.Effect<PrecomputeOutcome, unknown> =>
  Effect.gen(function* () {
    const { cache, date, buildSpec, fetchChunk, briefingFromReport } = deps;
    const chunkCount = deps.chunkCount ?? 1;
    let stored = yield* cache.get(simSpecKey(date), StoredSimJob, SIM_JOB_MAX_AGE_MS);

    if (stored == null) {
      // Stage 1: build + persist the spec (one baseline sim, the heavy ~874ms CPU of this stage),
      // then RETURN IMMEDIATELY. One-stage-per-tick HARD RULE: this tick must NOT also fan out or
      // reduce (spec-build + reduce in one tick is the ~1037ms exceededCpu failure). A later tick
      // does the fan-out + reduce. The spec's unitCount is the count to fan out.
      const rebuilt = yield* buildSpec;
      yield* cache.put(simSpecKey(date), rebuilt);
      return { stage: "spec-built", unitCount: rebuilt.stored.unitCount, reduced: false } as const;
    }

    const unitCount = stored.stored.unitCount;
    // Generation of THIS spec; partials are keyed by it so a newer-context rebuild's fan-out never
    // reads the previous spec's partials, and a STALE reduced artifact (built from an older
    // generation) is not mistaken for this job's. The reduced artifact itself stays at a
    // generation-free key (the delivery source); a sibling marker records its generation.
    const gen = specGeneration(stored.stored.contextAt);
    const reducedExisting = yield* cache.get(
      simReducedKey(date),
      ManagerBriefingReport,
      SIM_JOB_MAX_AGE_MS,
    );
    const reducedGen = yield* cache.get(simReducedGenKey(date), SimReducedGen, SIM_JOB_MAX_AGE_MS);
    if (reducedExisting != null && reducedGen?.gen === gen) {
      return { stage: "already-reduced" } as const;
    }

    // Stage 2: find pending units (a unit is "done" only if ALL its chunks exist).
    const pending: Array<number> = [];
    for (let unit = 1; unit <= unitCount; unit += 1) {
      let complete = true;
      for (let chunk = 0; chunk < chunkCount; chunk += 1) {
        const partial = yield* cache.get(
          simPartialKey(date, unit, chunk, gen),
          UnitPartial,
          SIM_JOB_MAX_AGE_MS,
        );
        if (partial == null) {
          complete = false;
          break;
        }
      }
      if (!complete) pending.push(unit);
    }

    if (pending.length > 0) {
      // Fire all pending (unit,chunk) self-fetches. A DIED chunk must NOT fail the whole tick — its
      // partial simply won't be written, and the re-check below leaves that unit pending for the
      // next tick (crash-resume). So each fetch is made non-fatal here.
      yield* Effect.all(
        pending.flatMap((unit) =>
          Array.from({ length: chunkCount }, (_unused, chunk) =>
            fetchChunk(unit, chunk).pipe(Effect.ignore),
          ),
        ),
        { concurrency: "unbounded" },
      );
      // Re-check: any unit still missing a partial (a chunk fetch DIED) is left pending for the next
      // tick. Only proceed to reduce when every unit's partials are present.
      const stillPending: Array<number> = [];
      for (let unit = 1; unit <= unitCount; unit += 1) {
        for (let chunk = 0; chunk < chunkCount; chunk += 1) {
          const partial = yield* cache.get(
            simPartialKey(date, unit, chunk, gen),
            UnitPartial,
            SIM_JOB_MAX_AGE_MS,
          );
          if (partial == null) {
            stillPending.push(unit);
            break;
          }
        }
      }
      if (stillPending.length > 0) {
        return { stage: "fan-out", pending: stillPending, reduced: false } as const;
      }
    }

    // Stage 3: all partials present, reduced absent or from an older generation → reduce + assemble
    // + persist (overwriting any stale reduced in place) and record this generation as the reduced's.
    const candidatePartials: Array<UnitPartial> = [];
    for (let unit = 1; unit <= unitCount; unit += 1) {
      const summed = yield* sumStoredChunks(cache, date, unit, chunkCount, gen);
      candidatePartials.push(summed);
    }
    const report = reduceSimJob(stored, candidatePartials);
    const briefing = yield* briefingFromReport(report);
    yield* cache.put(simReducedKey(date), briefing);
    yield* cache.put(simReducedGenKey(date), new SimReducedGen({ gen }));
    return { stage: "reduced" } as const;
  });

// Sum a unit's chunk partials (chunkCount=1 ⇒ the single chunk). Mirrors sumUnitPartials but reads
// from the cache; the additive counters make summed chunks identical to one full-iter run.
const sumStoredChunks = (
  cache: PrecomputeCache,
  date: string,
  unit: number,
  chunkCount: number,
  gen: string,
): Effect.Effect<UnitPartial, unknown> =>
  Effect.gen(function* () {
    const partials: Array<UnitPartial> = [];
    for (let chunk = 0; chunk < chunkCount; chunk += 1) {
      const partial = yield* cache.get(
        simPartialKey(date, unit, chunk, gen),
        UnitPartial,
        SIM_JOB_MAX_AGE_MS,
      );
      if (partial != null) partials.push(partial);
    }
    if (partials.length === 1) return partials[0]!;
    return sumUnitPartials(partials);
  });

type DeliveryNotifiers = {
  readonly telegram: Parameters<typeof deliverManagerBriefing>[1];
  readonly discord: Parameters<typeof deliverManagerBriefing>[2];
};

export type PreparedDeliveryOutcome =
  | { readonly status: "not-ready" }
  | { readonly status: "delivered"; readonly delivery: ManagerDeliveryReport }
  | { readonly status: "no-channel"; readonly delivery: ManagerDeliveryReport };

// READ-ONLY send: read today's prepared briefing from D1 (the precompute reduce artifact). If it is
// absent → "not-ready" (NO inline compute, NO delivery) so a later tick retries. If present →
// deliver, copy it to LAST_MANAGER_BRIEFING_CACHE_KEY (the delivery source) + cache the delivery.
export const deliverPreparedBriefing = (
  cache: PrecomputeCache,
  date: string,
  notifiers: DeliveryNotifiers,
): Effect.Effect<PreparedDeliveryOutcome, unknown> =>
  Effect.gen(function* () {
    const briefing = yield* cache.get(
      simReducedKey(date),
      ManagerBriefingReport,
      SIM_JOB_MAX_AGE_MS,
    );
    if (briefing == null) {
      return { status: "not-ready" } as const;
    }
    yield* cache.put(LAST_MANAGER_BRIEFING_CACHE_KEY, briefing);
    const delivery = yield* deliverManagerBriefing(briefing, notifiers.telegram, notifiers.discord);
    yield* cache.put(LAST_MANAGER_DELIVERY_CACHE_KEY, delivery);
    if (!shouldMarkSendBriefingComplete(delivery)) {
      return { status: "no-channel", delivery } as const;
    }
    return { status: "delivered", delivery } as const;
  });

export const shouldCountTaskRun = (options: { readonly force?: boolean } = {}) =>
  options.force !== true;

export const shouldEvaluateBriefingDue = (canRunSendBriefing: boolean) => canRunSendBriefing;

export const shouldAttemptAutomaticLineupWrite = (writeStatus: ManagerWriteStatus | undefined) =>
  writeStatus?.capability !== "unauthorized";

export const isMorningBriefingDue = (
  now: Date,
  options: {
    readonly morningHourEastern: number;
  },
) => easternHour(now) >= options.morningHourEastern;

export const isPregameBriefingDue = (
  now: Date,
  options: {
    readonly firstGameTime?: string;
    readonly sendHourUtc: number;
  },
) => {
  const firstGameMs = options.firstGameTime == null ? undefined : Date.parse(options.firstGameTime);
  if (firstGameMs != null && Number.isFinite(firstGameMs)) {
    return now.getTime() >= firstGameMs - PRE_FIRST_PITCH_LEAD_MS;
  }
  return now.getUTCHours() >= options.sendHourUtc;
};

export const isBriefingDue = (
  now: Date,
  options: {
    readonly firstGameTime?: string;
    readonly sendHourUtc: number;
    readonly morningHourEastern: number;
  },
) =>
  isMorningBriefingDue(now, options) ||
  isPregameBriefingDue(now, {
    firstGameTime: options.firstGameTime,
    sendHourUtc: options.sendHourUtc,
  });

// The CROSS-worker service binding used to fan out sim-chunk sub-invocations to the SEPARATE
// SimChunkWorker script. A Cloudflare Worker cannot offload CPU to ITSELF: a self HTTP fetch to its
// own workers.dev host is loopback-BLOCKED (zero sub-invocations), and a self service binding kills
// the parent with exceededCpu (same-worker loop-protection). So the heavy per-unit sim runs in a
// DIFFERENT worker, invoked via a cross-worker service binding (declared in worker.ts via
// `env: { SIM_CHUNK_WORKER: simChunkWorker }`), which has its OWN independent CPU budget and no
// loop-protection. `fetch(new Request(url))` on this binding routes to that worker regardless of
// URL host. Provided only in the deployed/dev runtime (where the binding exists); resolved
// OPTIONALLY so the Scheduler layer never fails to construct where the binding is absent (tests,
// plain `vp dev` without the bound worker). When absent, fetchChunk fails the unit (it stays
// pending) — there is no public-URL fallback, because there is no functional self-fetch path.
export class SimChunkBinding extends Context.Service<
  SimChunkBinding,
  {
    readonly fetch: (request: Request) => Effect.Effect<Response, unknown>;
  }
>()("fantasy-gm/SimChunkBinding") {}

export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly tick: Effect.Effect<SchedulerTask | "idle", SchedulerError>;
    readonly runTask: (
      task: SchedulerTask,
      options?: { readonly force?: boolean },
    ) => Effect.Effect<boolean, SchedulerError>;
    readonly status: Effect.Effect<SchedulerStatus, SchedulerError>;
  }
>()("fantasy-gm/Scheduler") {
  static readonly layerLive = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      const cache = yield* ApiCache;
      const projectionData = yield* ProjectionData;
      const leagueState = yield* LeagueState;
      const managerBriefing = yield* ManagerBriefing;
      const weeklyProjections = yield* WeeklyProjections;
      const standingsHistory = yield* StandingsHistory;
      const telegram = yield* TelegramNotifier;
      const discord = yield* DiscordNotifier;
      const lineupExecutor = yield* YahooLineupExecutor;
      const sendHourUtc = yield* Config.number("DAILY_BRIEFING_HOUR_UTC").pipe(
        Config.withDefault(FREE_TIER_MODE.defaults.dailyBriefingHourUtcFallback),
      );
      const morningHourEastern = yield* Config.number("DAILY_MORNING_BRIEFING_HOUR_EASTERN").pipe(
        Config.withDefault(FREE_TIER_MODE.defaults.dailyMorningBriefingHourEastern),
      );
      const useStandingsHistory = yield* Config.boolean("USE_STANDINGS_HISTORY").pipe(
        Config.withDefault(FREE_TIER_MODE.defaults.useStandingsHistory),
      );
      // Fan-out config. The token authenticates the internal sim-chunk route on the SEPARATE
      // SimChunkWorker. A cross-worker service binding routes to that worker regardless of URL host,
      // so any in-binding URL host works — the path+query are all that matter.
      const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
      // PRIMARY (and only) fan-out transport: the cross-worker service binding to SimChunkWorker.
      // Resolved optionally so the layer never fails to construct where the binding is absent
      // (tests, plain `vp dev` without the bound worker). When present, fetchChunk routes through it;
      // when absent, fetchChunk fails the unit so it stays pending (no public-URL self-fetch
      // fallback exists — self-loopback is blocked and a self binding kills the parent, so the
      // cross-worker binding MUST be present in prod for the fan-out to run; see SimChunkBinding /
      // worker.ts).
      const simChunkBinding = yield* Effect.serviceOption(SimChunkBinding);

      const markComplete = (task: SchedulerTask) =>
        cache
          .put(taskStateKey(task), { completedAt: new Date().toISOString() })
          .pipe(Effect.mapError((error) => toSchedulerError(task, error)));

      const lastCompletedAt = (task: SchedulerTask) =>
        cache.get(taskStateKey(task), TaskState, 7 * 24 * HOUR).pipe(
          Effect.map((state) => (state == null ? undefined : Date.parse(state.completedAt))),
          Effect.mapError((error) => toSchedulerError(task, error)),
        );

      const runCount = (task: SchedulerTask, date: string) =>
        cache.get(taskRunCountKey(task, date), TaskRunCount, 36 * HOUR).pipe(
          Effect.map((state) => state?.count ?? 0),
          Effect.mapError((error) => toSchedulerError(task, error)),
        );

      const incrementRunCount = (task: SchedulerTask, date: string) =>
        Effect.gen(function* () {
          const count = yield* runCount(task, date);
          yield* cache
            .put(taskRunCountKey(task, date), { date, count: count + 1 })
            .pipe(Effect.mapError((error) => toSchedulerError(task, error)));
        });

      const recordWriteStatus = (status: ManagerWriteStatus) =>
        cache
          .put(LAST_MANAGER_WRITE_STATUS_CACHE_KEY, status)
          .pipe(Effect.mapError((error) => toSchedulerError("apply-lineup", error)));

      const canRunToday = (task: SchedulerTask, date: string) =>
        runCount(task, date).pipe(Effect.map((count) => count < DAILY_TASK_LIMITS[task]));

      const status = readSchedulerStatus(cache);

      // Stage 1 inputs: build the StoredSimJob spec (one baseline sim) from the cheap set+snapshot+
      // standings inputs. contextAt = the refresh-context last-success time, used for staleness.
      const buildSpec = (contextAt: string | undefined) =>
        Effect.gen(function* () {
          const [set, snapshot] = yield* Effect.all([
            weeklyProjections.currentMatchup,
            leagueState.snapshot,
          ]);
          const categoryTotals = useStandingsHistory ? yield* standingsHistory.categoryTotals : [];
          return prepareSimJob(set, snapshot, categoryTotals, contextAt);
        });

      // Stage 2 fan-out: one SimChunkWorker sub-invocation per (unit,chunk) with its OWN CPU budget.
      // The dispatcher only awaits I/O. Non-2xx is surfaced so the unit stays pending for retry.
      //
      // The request is dispatched through the SimChunkBinding cross-worker service binding. A
      // service binding routes to the bound (separate) worker irrespective of the URL host, so the
      // host portion of the URL below is irrelevant — only the path+query matter. When the binding
      // is ABSENT (tests, plain `vp dev` without the bound worker) the unit is failed so it stays
      // pending; there is no public-URL fallback (self-loopback is blocked and a self binding kills
      // the parent — the bugs this cross-worker binding fixes), so the binding MUST be present in
      // prod for any sim-chunk sub-invocation to be produced.
      const fetchChunk = (date: string, unit: number, chunk: number, chunkCount: number) => {
        const url = new URL("/internal/sim-chunk", "https://sim-chunk-worker.internal");
        url.searchParams.set("token", adminToken);
        url.searchParams.set("date", date);
        url.searchParams.set("unit", String(unit));
        url.searchParams.set("chunk", String(chunk));
        url.searchParams.set("chunkCount", String(chunkCount));
        const send: Effect.Effect<Response, unknown> = Option.match(simChunkBinding, {
          onSome: (binding) => binding.fetch(new Request(url.toString())),
          onNone: () =>
            Effect.fail(
              new SchedulerError({
                task: "precompute",
                message: "sim-chunk binding unavailable",
              }),
            ),
        });
        return send.pipe(
          Effect.flatMap((response) =>
            response.ok
              ? Effect.void
              : Effect.fail(
                  new SchedulerError({
                    task: "precompute",
                    message: `sim-chunk ${unit}/${chunk} failed: ${response.status}`,
                  }),
                ),
          ),
          Effect.mapError(
            (error) => new SchedulerError({ task: "precompute", message: String(error) }),
          ),
        );
      };

      const runTask = (task: SchedulerTask, options: { readonly force?: boolean } = {}) =>
        Effect.gen(function* () {
          const runDate = easternDateKey(new Date());
          if (options.force !== true && !(yield* canRunToday(task, runDate))) return false;
          if (task === "refresh-projections") {
            yield* Effect.all(
              [projectionData.batterProjections, projectionData.pitcherProjections],
              {
                concurrency: 1,
              },
            );
          } else if (task === "refresh-context") {
            const snapshot = yield* leagueState.snapshot;
            yield* projectionData.weeklyContext(
              snapshot.matchup.weekStart,
              snapshot.matchup.weekEnd,
            );
          } else if (task === "apply-lineup") {
            yield* lineupExecutor.applyForDate(runDate, { dryRun: false }).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  recordWriteStatus(
                    new ManagerWriteStatus({
                      checkedAt: new Date().toISOString(),
                      capability: "unauthorized",
                      action: "apply-lineup",
                      ok: false,
                      date: runDate,
                      error:
                        "Yahoo rejected lineup write; re-authorize with Fantasy Sports read/write scope.",
                    }),
                  ),
                onSuccess: () =>
                  recordWriteStatus(
                    new ManagerWriteStatus({
                      checkedAt: new Date().toISOString(),
                      capability: "authorized",
                      action: "apply-lineup",
                      ok: true,
                      date: runDate,
                    }),
                  ),
              }),
            );
          } else if (task === "precompute") {
            const contextAt = yield* cache
              .get(taskStateKey("refresh-context"), TaskState, 7 * 24 * HOUR)
              .pipe(
                Effect.map((state) => state?.completedAt),
                Effect.mapError((error) => toSchedulerError(task, error)),
              );
            const outcome = yield* runPrecompute({
              cache,
              date: runDate,
              contextAt,
              buildSpec: buildSpec(contextAt),
              fetchChunk: (unit, chunk) => fetchChunk(runDate, unit, chunk, 1),
              briefingFromReport: (report) => managerBriefing.briefingFromReport(report),
            }).pipe(Effect.mapError((error) => toSchedulerError(task, error)));
            // Count + mark complete only once the prepared briefing actually lands (or already had).
            // A partial-progress tick (spec built / units still pending) returns false so the next
            // tick re-selects precompute and resumes — the crash-resume guarantee.
            if (outcome.stage !== "reduced" && outcome.stage !== "already-reduced") {
              return false;
            }
          } else {
            // send-briefing is now READ-ONLY delivery: it reads today's prepared briefing from D1.
            // Absent → not-ready (no inline compute, no delivery) so a LATER tick retries; this
            // cross-tick retry across the 12 daily ticks is the daily-delivery guarantee.
            const outcome = yield* deliverPreparedBriefing(cache, runDate, {
              telegram,
              discord,
            }).pipe(Effect.mapError((error) => toSchedulerError(task, error)));
            if (outcome.status === "not-ready") {
              return false;
            }
            if (outcome.status === "no-channel") {
              return yield* new SchedulerError({
                task,
                message: "send-briefing delivery had no successful channel",
              });
            }
          }
          if (shouldCountTaskRun(options)) {
            yield* incrementRunCount(task, runDate);
          }
          yield* markComplete(task);
          return true;
        }).pipe(Effect.mapError((error) => toSchedulerError(task, error)));

      const dueTask = Effect.gen(function* () {
        const now = new Date();
        const [projectionAt, contextAt, applyLineupAt, sendAt] = yield* Effect.all([
          lastCompletedAt("refresh-projections"),
          lastCompletedAt("refresh-context"),
          lastCompletedAt("apply-lineup"),
          lastCompletedAt("send-briefing"),
        ]);
        const today = easternDateKey(now);
        const writeStatus = yield* cache
          .get(LAST_MANAGER_WRITE_STATUS_CACHE_KEY, ManagerWriteStatus, 30 * 24 * HOUR)
          .pipe(Effect.mapError((error) => toSchedulerError("apply-lineup", error)));
        const canRun = {
          "refresh-projections": yield* canRunToday("refresh-projections", today),
          "refresh-context": yield* canRunToday("refresh-context", today),
          precompute: yield* canRunToday("precompute", today),
          "apply-lineup":
            shouldAttemptAutomaticLineupWrite(writeStatus) &&
            (yield* canRunToday("apply-lineup", today)),
          "send-briefing": yield* canRunToday("send-briefing", today),
        };
        // Today's prepared briefing (precompute reduce artifact) present in D1?
        const preparedBriefing = yield* cache
          .get(simReducedKey(today), ManagerBriefingReport, SIM_JOB_MAX_AGE_MS)
          .pipe(Effect.mapError((error) => toSchedulerError("precompute", error)));
        const preparedBriefingMissing = preparedBriefing == null;
        let briefingDue = false;
        let refreshBriefingDue = false;
        if (shouldEvaluateBriefingDue(canRun["send-briefing"])) {
          const snapshot = yield* leagueState.snapshot.pipe(
            Effect.mapError((error) => toSchedulerError("send-briefing", error)),
          );
          const context = yield* projectionData
            .weeklyContext(snapshot.matchup.weekStart, snapshot.matchup.weekEnd)
            .pipe(Effect.mapError((error) => toSchedulerError("send-briefing", error)));
          const todayWindow = context.dailyGameWindows?.find(
            (window) => window.date === easternDateKey(now),
          );
          refreshBriefingDue = isPregameBriefingDue(now, {
            firstGameTime: todayWindow?.firstGameTime,
            sendHourUtc,
          });
          briefingDue = isBriefingDue(now, {
            firstGameTime: todayWindow?.firstGameTime,
            sendHourUtc,
            morningHourEastern,
          });
        }
        return selectDueTask(
          now,
          { projectionAt, contextAt, applyLineupAt, sendAt },
          canRun,
          briefingDue,
          refreshBriefingDue,
          refreshBriefingDue,
          preparedBriefingMissing,
        );
      });

      const tick = Effect.gen(function* () {
        const task = yield* dueTask;
        if (task === "idle") return task;
        yield* runTask(task);
        return task;
      });

      return Scheduler.of({ tick, runTask, status });
    }),
  );
}

export type { SchedulerTask };
