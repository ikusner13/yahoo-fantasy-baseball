import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ApiCache, ApiCacheError, makeApiCacheTest } from "../src/services/ApiCache";
import { CalibrationHarness, CalibrationHarnessError } from "../src/services/CalibrationHarness";
import { DiscordNotifier } from "../src/services/DiscordNotifier";
import { LeagueState } from "../src/services/LeagueState";
import { ManagerBriefing, ManagerBriefingError } from "../src/services/ManagerBriefing";
import {
  LAST_TICK_ERROR_KEY,
  runDeadmanWatchdog,
  safeDispatchRoutine,
  SchedulerLastTickError,
} from "../src/routines/dispatch";
import { Scheduler, SchedulerError, TaskState, taskStateKey } from "../src/services/Scheduler";
import { TelegramNotifier, TelegramNotifierError } from "../src/services/TelegramNotifier";
import { YahooApiError, YahooClient } from "../src/services/YahooClient";

type Store = Map<string, { data: string; updatedAt: string }>;

const telegramLayer = (messages: Array<string>) =>
  Layer.succeed(
    TelegramNotifier,
    TelegramNotifier.of({
      postMessage: (content) => Effect.sync(() => void messages.push(content)),
      postManagerBriefing: () => Effect.void,
    }),
  );

const failingTelegramLayer = Layer.succeed(
  TelegramNotifier,
  TelegramNotifier.of({
    postMessage: () => Effect.fail(new TelegramNotifierError({ message: "telegram failed" })),
    postManagerBriefing: () =>
      Effect.fail(new TelegramNotifierError({ message: "telegram failed" })),
  }),
);

const failingBriefingLayer = Layer.succeed(
  ManagerBriefing,
  ManagerBriefing.of({
    currentBriefing: Effect.fail(new ManagerBriefingError({ message: "briefing failed" })),
    briefingFromReport: () => Effect.fail(new ManagerBriefingError({ message: "unused" })),
  }),
);

const noopDiscordLayer = Layer.succeed(
  DiscordNotifier,
  DiscordNotifier.of({ postManagerBriefing: () => Effect.void }),
);

const failingApiCacheLayer = Layer.succeed(
  ApiCache,
  ApiCache.of({
    get: (key) => Effect.fail(new ApiCacheError({ key, message: "get failed" })),
    put: (key) => Effect.fail(new ApiCacheError({ key, message: "put failed" })),
    getOrRefresh: (_key, _schema, _maxAgeMs, refresh) => refresh,
    getOrRefreshTyped: (_key, _schema, _maxAgeMs, refresh) => refresh,
  }),
);

const unusedRoutineDepsLayer = Layer.mergeAll(
  Layer.succeed(
    CalibrationHarness,
    CalibrationHarness.of({
      record: () => Effect.void,
      closeOut: () => Effect.fail(new CalibrationHarnessError({ message: "unused" })),
      load: () => Effect.succeed([]),
      report: () => Effect.fail(new CalibrationHarnessError({ message: "unused" })),
      sweep: () => Effect.fail(new CalibrationHarnessError({ message: "unused" })),
    }),
  ),
  Layer.succeed(
    LeagueState,
    LeagueState.of({
      snapshot: Effect.fail(new YahooApiError({ message: "unused" })),
    }),
  ),
  Layer.succeed(
    Scheduler,
    Scheduler.of({
      tick: Effect.fail(new SchedulerError({ message: "unused" })),
      runTask: () => Effect.fail(new SchedulerError({ message: "unused" })),
      status: Effect.fail(new SchedulerError({ message: "unused" })),
    }),
  ),
  Layer.succeed(YahooClient, YahooClient.of({} as Context.Service.Shape<typeof YahooClient>)),
);

const parseLastTickError = (store: Store) => {
  const row = store.get(LAST_TICK_ERROR_KEY);
  expect(row).not.toBeUndefined();
  return Schema.decodeUnknownSync(SchedulerLastTickError)(JSON.parse(row!.data));
};

describe("tick reliability", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("safeDispatchRoutine persists the last tick error and alerts once per Eastern date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T18:00:00.000Z"));
    const store: Store = new Map();
    const messages: Array<string> = [];
    const layer = Layer.mergeAll(
      makeApiCacheTest(store),
      telegramLayer(messages),
      failingBriefingLayer,
      noopDiscordLayer,
      unusedRoutineDepsLayer,
    );

    await Effect.runPromise(safeDispatchRoutine("daily-morning").pipe(Effect.provide(layer)));
    await Effect.runPromise(safeDispatchRoutine("daily-morning").pipe(Effect.provide(layer)));

    const error = parseLastTickError(store);
    expect(error.routine).toBe("daily-morning");
    expect(error.error).toContain("briefing failed");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("FantasyGM tick failed (daily-morning)");

    vi.setSystemTime(new Date("2026-07-05T18:00:00.000Z"));
    await Effect.runPromise(safeDispatchRoutine("daily-morning").pipe(Effect.provide(layer)));
    expect(messages).toHaveLength(2);
  });

  it("safeDispatchRoutine never throws when error persistence and Telegram both fail", async () => {
    const layer = Layer.mergeAll(
      failingApiCacheLayer,
      failingTelegramLayer,
      failingBriefingLayer,
      noopDiscordLayer,
      unusedRoutineDepsLayer,
    );

    await expect(
      Effect.runPromise(safeDispatchRoutine("daily-morning").pipe(Effect.provide(layer))),
    ).resolves.toBeUndefined();
  });

  it("dead-man watchdog sends one alert after 1pm ET when no briefing was sent today", async () => {
    const store: Store = new Map();
    const messages: Array<string> = [];
    const layer = Layer.mergeAll(makeApiCacheTest(store), telegramLayer(messages));

    await Effect.runPromise(
      runDeadmanWatchdog(new Date("2026-07-04T17:00:00.000Z")).pipe(Effect.provide(layer)),
    );
    expect(messages).toEqual([
      "⚠️ No briefing delivered yet today (past 1pm ET). Check scheduler:last-tick-error:v1 or drive /admin/run/task manually.",
    ]);
    expect(store.has("scheduler:deadman-alert:2026-07-04:v1")).toBe(true);

    await Effect.runPromise(
      runDeadmanWatchdog(new Date("2026-07-04T18:00:00.000Z")).pipe(Effect.provide(layer)),
    );
    expect(messages).toHaveLength(1);
  });

  it("dead-man watchdog skips when sent today or before 1pm ET", async () => {
    const store: Store = new Map();
    const messages: Array<string> = [];
    const layer = Layer.mergeAll(makeApiCacheTest(store), telegramLayer(messages));

    await Effect.runPromise(
      runDeadmanWatchdog(new Date("2026-07-04T16:59:59.000Z")).pipe(Effect.provide(layer)),
    );
    expect(messages).toEqual([]);

    store.set(taskStateKey("send-briefing"), {
      data: JSON.stringify(new TaskState({ completedAt: "2026-07-04T15:00:00.000Z" })),
      updatedAt: new Date().toISOString(),
    });
    await Effect.runPromise(
      runDeadmanWatchdog(new Date("2026-07-04T18:00:00.000Z")).pipe(Effect.provide(layer)),
    );
    expect(messages).toEqual([]);
  });
});
