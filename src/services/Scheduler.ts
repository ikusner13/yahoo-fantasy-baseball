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
import { ManagerBriefing } from "./ManagerBriefing.ts";
import { ProjectionData } from "./ProjectionData.ts";
import { TelegramNotifier } from "./TelegramNotifier.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const PRE_FIRST_PITCH_LEAD_MS = 90 * MINUTE;

type SchedulerTask = "refresh-projections" | "refresh-context" | "send-briefing";

const taskStateKey = (task: SchedulerTask) => `scheduler:task:${task}:last-success:v1`;
const taskRunCountKey = (task: SchedulerTask, date: string) =>
  `scheduler:task:${task}:run-count:${date}:v1`;
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

export class Scheduler extends Context.Service<
  Scheduler,
  {
    readonly tick: Effect.Effect<SchedulerTask | "idle", SchedulerError>;
    readonly runTask: (task: SchedulerTask) => Effect.Effect<void, SchedulerError>;
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

      const canRunToday = (task: SchedulerTask, date: string) =>
        runCount(task, date).pipe(Effect.map((count) => count < DAILY_TASK_LIMITS[task]));

      const runTask = (task: SchedulerTask) =>
        Effect.gen(function* () {
          const runDate = easternDateKey(new Date());
          if (!(yield* canRunToday(task, runDate))) return;
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
          } else {
            const briefing = yield* managerBriefing.currentBriefing;
            yield* telegram.postManagerBriefing(briefing);
            yield* discord.postManagerBriefing(briefing);
          }
          yield* incrementRunCount(task, runDate);
          yield* markComplete(task);
        }).pipe(Effect.mapError((error) => toSchedulerError(task, error)));

      const dueTask = Effect.gen(function* () {
        const now = new Date();
        const nowMs = now.getTime();
        const [projectionAt, contextAt, sendAt] = yield* Effect.all([
          lastCompletedAt("refresh-projections"),
          lastCompletedAt("refresh-context"),
          lastCompletedAt("send-briefing"),
        ]);
        const today = easternDateKey(now);
        if (
          (projectionAt == null || nowMs - projectionAt > 12 * HOUR) &&
          (yield* canRunToday("refresh-projections", today))
        ) {
          return "refresh-projections" as const;
        }
        if (
          (contextAt == null || nowMs - contextAt > HOUR) &&
          (yield* canRunToday("refresh-context", today))
        ) {
          return "refresh-context" as const;
        }
        const sentToday =
          sendAt != null && easternDateKey(new Date(sendAt)) === easternDateKey(now);
        if (!sentToday && (yield* canRunToday("send-briefing", today))) {
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
            return "send-briefing" as const;
          }
          if (firstGameMs == null && now.getUTCHours() >= sendHourUtc) {
            return "send-briefing" as const;
          }
        }
        return "idle" as const;
      });

      const tick = Effect.gen(function* () {
        const task = yield* dueTask;
        if (task === "idle") return task;
        yield* runTask(task);
        return task;
      });

      return Scheduler.of({ tick, runTask });
    }),
  );
}

export type { SchedulerTask };
