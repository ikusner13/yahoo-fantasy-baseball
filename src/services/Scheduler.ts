import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import { LAST_MANAGER_BRIEFING_CACHE_KEY, ManagerBriefing } from "./ManagerBriefing.ts";
import { LAST_MANAGER_WRITE_STATUS_CACHE_KEY, ManagerWriteStatus } from "./ManagerWriteStatus.ts";
import { ProjectionData } from "./ProjectionData.ts";
import { TelegramNotifier } from "./TelegramNotifier.ts";
import { YahooLineupExecutor } from "./YahooLineupExecutor.ts";
import { deliverManagerBriefing } from "../routines/delivery.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const PRE_FIRST_PITCH_LEAD_MS = 90 * MINUTE;
const MIN_BRIEFING_REFRESH_GAP_MS = 2 * HOUR;

type SchedulerTask = "refresh-projections" | "refresh-context" | "apply-lineup" | "send-briefing";
const SCHEDULER_TASKS = [
  "refresh-projections",
  "refresh-context",
  "apply-lineup",
  "send-briefing",
] as const satisfies ReadonlyArray<SchedulerTask>;

const taskStateKey = (task: SchedulerTask) => `scheduler:task:${task}:last-success:v1`;
const taskRunCountKey = (task: SchedulerTask, date: string) =>
  `scheduler:task:${task}:run-count:${date}:v2`;
const DAILY_TASK_LIMITS = FREE_TIER_MODE.dailyTaskLimits satisfies Record<SchedulerTask, number>;
class TaskState extends Schema.Class<TaskState>("TaskState")({
  completedAt: Schema.String,
}) {}

class TaskRunCount extends Schema.Class<TaskRunCount>("TaskRunCount")({
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
};

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
  if (!appliedLineupToday && canRun["apply-lineup"] && briefingDue) {
    return "apply-lineup" as const;
  }
  if (!sentToday && canRun["send-briefing"] && briefingDue) {
    return "send-briefing" as const;
  }
  if (
    sentToday &&
    briefingDue &&
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

export const shouldCountTaskRun = (options: { readonly force?: boolean } = {}) =>
  options.force !== true;

export const shouldEvaluateBriefingDue = (canRunSendBriefing: boolean) => canRunSendBriefing;

export const shouldAttemptAutomaticLineupWrite = (writeStatus: ManagerWriteStatus | undefined) =>
  writeStatus?.capability !== "unauthorized";

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
      const telegram = yield* TelegramNotifier;
      const discord = yield* DiscordNotifier;
      const lineupExecutor = yield* YahooLineupExecutor;
      const sendHourUtc = yield* Config.number("DAILY_BRIEFING_HOUR_UTC").pipe(
        Config.withDefault(FREE_TIER_MODE.defaults.dailyBriefingHourUtcFallback),
      );

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
          } else {
            const briefing = yield* managerBriefing.currentBriefing;
            yield* cache
              .put(LAST_MANAGER_BRIEFING_CACHE_KEY, briefing)
              .pipe(Effect.mapError((error) => toSchedulerError(task, error)));
            const delivery = yield* deliverManagerBriefing(briefing, telegram, discord);
            yield* cache
              .put(LAST_MANAGER_DELIVERY_CACHE_KEY, delivery)
              .pipe(Effect.mapError((error) => toSchedulerError(task, error)));
            if (!shouldMarkSendBriefingComplete(delivery)) {
              return yield* Effect.fail(
                new SchedulerError({
                  task,
                  message: "send-briefing delivery had no successful channel",
                }),
              );
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
        const nowMs = now.getTime();
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
          "apply-lineup":
            shouldAttemptAutomaticLineupWrite(writeStatus) &&
            (yield* canRunToday("apply-lineup", today)),
          "send-briefing": yield* canRunToday("send-briefing", today),
        };
        let briefingDue = false;
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
          const firstGameMs =
            todayWindow?.firstGameTime == null ? undefined : Date.parse(todayWindow.firstGameTime);
          if (
            firstGameMs != null &&
            Number.isFinite(firstGameMs) &&
            nowMs >= firstGameMs - PRE_FIRST_PITCH_LEAD_MS
          ) {
            briefingDue = true;
          }
          if (firstGameMs == null && now.getUTCHours() >= sendHourUtc) {
            briefingDue = true;
          }
        }
        return selectDueTask(
          now,
          { projectionAt, contextAt, applyLineupAt, sendAt },
          canRun,
          briefingDue,
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
