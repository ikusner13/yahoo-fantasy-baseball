import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { RoutineName } from "../infra/crons.ts";
import { ApiCache } from "../services/ApiCache.ts";
import { DiscordNotifier } from "../services/DiscordNotifier.ts";
import { ManagerBriefing } from "../services/ManagerBriefing.ts";
import {
  easternDateKey,
  easternHour,
  Scheduler,
  TaskState,
  taskStateKey,
} from "../services/Scheduler.ts";
import { TelegramNotifier } from "../services/TelegramNotifier.ts";
import { closeOutPreviousWeek, recordCurrentWeekPrediction } from "./calibration.ts";
import { deliverManagerBriefing } from "./delivery.ts";

const DAY = 24 * 60 * 60 * 1000;
const ALERT_TIMEOUT = "20 seconds";
export const LAST_TICK_ERROR_KEY = "scheduler:last-tick-error:v1";

export class SchedulerLastTickError extends Schema.Class<SchedulerLastTickError>(
  "SchedulerLastTickError",
)({
  at: Schema.String,
  routine: Schema.String,
  error: Schema.String,
}) {}

class SchedulerAlertMarker extends Schema.Class<SchedulerAlertMarker>("SchedulerAlertMarker")({
  at: Schema.String,
}) {}

const briefingRoutines = new Set<string>([
  "daily-morning",
  "weekly-planning",
  "mid-week-adjustment",
  "late-scratch-check",
]);

export const dispatchRoutine = (routine: RoutineName) =>
  Effect.gen(function* () {
    yield* Effect.log("routine dispatched", { routine });

    if (routine === "scheduler-tick") {
      const scheduler = yield* Scheduler;
      const task = yield* scheduler.tick;
      yield* Effect.log("scheduler tick completed", { task });
      // F8 calibration loop. Best-effort: a failure here must never break the scheduler tick.
      yield* recordCurrentWeekPrediction.pipe(
        Effect.tap((week) =>
          week == null ? Effect.void : Effect.log("calibration prediction recorded", { week }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("calibration record skipped", { error: String(error) }),
        ),
      );
      yield* closeOutPreviousWeek.pipe(
        Effect.tap((week) =>
          week == null ? Effect.void : Effect.log("calibration week closed out", { week }),
        ),
        Effect.catch((error) =>
          Effect.logWarning("calibration close-out skipped", { error: String(error) }),
        ),
      );
      yield* runDeadmanWatchdog().pipe(Effect.ignore);
      return;
    }

    if (!briefingRoutines.has(routine)) return;

    const managerBriefing = yield* ManagerBriefing;
    const telegram = yield* TelegramNotifier;
    const discord = yield* DiscordNotifier;
    const briefing = yield* managerBriefing.currentBriefing;

    yield* deliverManagerBriefing(briefing, telegram, discord);
  });

const markerKey = (kind: "tick-error-alert" | "deadman-alert", date: string) =>
  `scheduler:${kind}:${date}:v1`;

const alertOncePerDay = (
  key: string,
  message: string,
): Effect.Effect<void, never, ApiCache | TelegramNotifier> =>
  Effect.gen(function* () {
    const cache = yield* ApiCache;
    const telegram = yield* TelegramNotifier;
    const marker = yield* cache
      .get(key, SchedulerAlertMarker, DAY)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    if (marker != null) return;
    yield* telegram.postMessage(message).pipe(Effect.timeout(ALERT_TIMEOUT), Effect.ignore);
    yield* cache
      .put(key, new SchedulerAlertMarker({ at: new Date().toISOString() }))
      .pipe(Effect.ignore);
  }).pipe(Effect.catchCause(() => Effect.void));

export const runDeadmanWatchdog = (
  now = new Date(),
): Effect.Effect<void, never, ApiCache | TelegramNotifier> =>
  Effect.gen(function* () {
    if (easternHour(now) < 13) return;
    const cache = yield* ApiCache;
    const easternDate = easternDateKey(now);
    const sendState = yield* cache
      .get(taskStateKey("send-briefing"), TaskState, 7 * DAY)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)));
    const sentToday =
      sendState?.completedAt != null &&
      easternDateKey(new Date(sendState.completedAt)) === easternDate;
    if (sentToday) return;
    yield* alertOncePerDay(
      markerKey("deadman-alert", easternDate),
      "⚠️ No briefing delivered yet today (past 1pm ET). Check scheduler:last-tick-error:v1 or drive /admin/run/task manually.",
    );
  }).pipe(Effect.catchCause(() => Effect.void));

export const safeDispatchRoutine = (routine: RoutineName) =>
  dispatchRoutine(routine).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const pretty = Cause.pretty(cause).slice(0, 2000);
        yield* Effect.logError("tick failed", { routine, error: pretty }).pipe(Effect.ignore);
        const cache = yield* ApiCache;
        yield* cache
          .put(
            LAST_TICK_ERROR_KEY,
            new SchedulerLastTickError({
              at: new Date().toISOString(),
              routine,
              error: pretty,
            }),
          )
          .pipe(Effect.ignore);
        const easternDate = easternDateKey(new Date());
        yield* alertOncePerDay(
          markerKey("tick-error-alert", easternDate),
          `⚠️ FantasyGM tick failed (${routine}): ${pretty.slice(0, 300)}`,
        );
      }).pipe(Effect.catchCause(() => Effect.void)),
    ),
  );
