import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as dotenv from "dotenv";
import type * as Context from "effect/Context";
import { Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { pathToFileURL } from "node:url";

import { ApiCache } from "../src/services/ApiCache.ts";
import { closeOutPreviousWeek, recordCurrentWeekPrediction } from "../src/routines/calibration.ts";
import { deliverManagerBriefing } from "../src/routines/delivery.ts";
import { DailyLineupAdvisor } from "../src/services/DailyLineupAdvisor.ts";
import { prepareSimJob, reduceSimJob, simulateUnit } from "../src/services/DecisionEngine.ts";
import {
  deliverySucceeded,
  LAST_MANAGER_DELIVERY_CACHE_KEY,
} from "../src/services/ManagerDelivery.ts";
import {
  LAST_MANAGER_BRIEFING_CACHE_KEY,
  ManagerBriefing,
} from "../src/services/ManagerBriefing.ts";
import { PlayerIdentity } from "../src/services/PlayerIdentity.ts";
import { ProjectionData } from "../src/services/ProjectionData.ts";
import { StandingsHistory } from "../src/services/StandingsHistory.ts";
import { renderManagerBriefingForTelegram } from "../src/services/TelegramNotifier.ts";
import { TelegramNotifier } from "../src/services/TelegramNotifier.ts";
import { TransactionPlanner } from "../src/services/TransactionPlanner.ts";
import { WeeklyProjections } from "../src/services/WeeklyProjections.ts";
import { YahooClient } from "../src/services/YahooClient.ts";
import { YahooOAuthRemote, DbNode } from "../src/services/WorkerAdmin.ts";
import { CalibrationHarness } from "../src/services/CalibrationHarness.ts";
import { DiscordNotifier } from "../src/services/DiscordNotifier.ts";
import { LeagueState } from "../src/services/LeagueState.ts";
import {
  simPartialKey,
  simReducedGenKey,
  simReducedKey,
  SimReducedGen,
  simSpecKey,
  specGeneration,
} from "../src/services/SimJob.ts";
import { easternDateKey, taskStateKey, TaskState } from "../src/services/Scheduler.ts";

type Flags = {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly envFile: string;
};

const HOUR = 60 * 60 * 1000;

type ApiCacheService = Context.Service.Shape<typeof ApiCache>;

export const parseFlags = (argv: ReadonlyArray<string>): Flags => {
  let envFile = process.env["FANTASY_GM_ENV_FILE"] ?? ".env.local";
  let dryRun = false;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force") force = true;
    else if (arg === "--env-file") envFile = argv[++index] ?? envFile;
    else if (arg.startsWith("--env-file=")) envFile = arg.slice("--env-file=".length);
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: daily-briefing [--dry-run] [--force] [--env-file PATH]");
      process.exit(0);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return { dryRun, force, envFile };
};

export const sentToday = (completedAt: string | undefined, now = new Date()) =>
  completedAt != null && easternDateKey(new Date(completedAt)) === easternDateKey(now);

const loadEnv = (path: string) =>
  Effect.sync(() => {
    dotenv.config({ path, override: true, quiet: true });
  });

const writeTaskSuccess = (cache: ApiCacheService) =>
  cache.put(taskStateKey("send-briefing"), { completedAt: new Date().toISOString() });

const calibrationBestEffort = Effect.all(
  [
    recordCurrentWeekPrediction.pipe(Effect.catch((error) => Effect.logWarning(error))),
    closeOutPreviousWeek.pipe(Effect.catch((error) => Effect.logWarning(error))),
  ],
  { concurrency: 1 },
);

export const runDailyBriefing = (flags: Flags) =>
  Effect.gen(function* () {
    yield* loadEnv(flags.envFile);
    const startedAt = Date.now();
    const today = easternDateKey(new Date());
    const cache = yield* ApiCache;

    if (!flags.force && !flags.dryRun) {
      const sendState = yield* cache.get(taskStateKey("send-briefing"), TaskState, 7 * 24 * HOUR);
      if (sentToday(sendState?.completedAt)) {
        yield* Console.log(
          `daily-briefing: not sent; already completed today (${sendState?.completedAt})`,
        );
        return {
          status: "already-sent" as const,
          coinFlips: 0,
          durationMs: Date.now() - startedAt,
        };
      }
    }

    const weeklyProjections = yield* WeeklyProjections;
    const leagueState = yield* LeagueState;
    const standingsHistory = yield* StandingsHistory;
    const managerBriefing = yield* ManagerBriefing;

    const [set, snapshot, categoryTotals, contextState] = yield* Effect.all(
      [
        weeklyProjections.currentMatchup,
        leagueState.snapshot,
        standingsHistory.categoryTotals,
        cache.get(taskStateKey("refresh-context"), TaskState, 7 * 24 * HOUR),
      ],
      { concurrency: 1 },
    );

    const stored = prepareSimJob(set, snapshot, categoryTotals, contextState?.completedAt);
    const gen = specGeneration(stored.stored.contextAt);
    if (!flags.dryRun) {
      yield* cache.put(simSpecKey(today), stored);
    }

    const partials = yield* Effect.forEach(stored.stored.spec.candidates, (_candidate, index) => {
      const partial = simulateUnit(stored, index + 1);
      return flags.dryRun
        ? Effect.succeed(partial)
        : cache.put(simPartialKey(today, index + 1, 0, gen), partial).pipe(Effect.as(partial));
    });

    const report = reduceSimJob(stored, partials);
    const briefing = yield* managerBriefing.briefingFromReport(report);
    const coinFlips = report.baseline.categories.filter(
      (category) => category.tag === "coin-flip",
    ).length;

    if (flags.dryRun) {
      yield* Console.log(renderManagerBriefingForTelegram(briefing));
      yield* Console.log(
        `daily-briefing: dry-run; not sent; coin-flips ${coinFlips}; duration ${Date.now() - startedAt}ms`,
      );
      return { status: "dry-run" as const, coinFlips, durationMs: Date.now() - startedAt };
    }

    yield* cache.put(simReducedKey(today), briefing);
    yield* cache.put(simReducedGenKey(today), new SimReducedGen({ gen }));

    const telegram = yield* TelegramNotifier;
    const discord = yield* DiscordNotifier;
    const delivery = yield* deliverManagerBriefing(briefing, telegram, discord);
    yield* cache.put(LAST_MANAGER_DELIVERY_CACHE_KEY, delivery);

    if (!deliverySucceeded(delivery)) {
      return yield* Effect.fail(
        new Error("manager briefing delivery had no successful Telegram channel"),
      );
    }

    yield* cache.put(LAST_MANAGER_BRIEFING_CACHE_KEY, briefing);
    yield* writeTaskSuccess(cache);
    yield* calibrationBestEffort;

    yield* Console.log(
      `daily-briefing: sent; coin-flips ${coinFlips}; duration ${Date.now() - startedAt}ms`,
    );
    return { status: "sent" as const, coinFlips, durationMs: Date.now() - startedAt };
  });

const YahooLayer = YahooClient.layer.pipe(
  Layer.provide(Layer.mergeAll(YahooOAuthRemote, FetchHttpClient.layer)),
);
const LeagueStateLayer = LeagueState.layerLive.pipe(Layer.provide(YahooLayer));
const ApiCacheLayer = ApiCache.layerLive.pipe(Layer.provide(DbNode));
const LiveProjectionDataLayer = ProjectionData.layerLive.pipe(Layer.provide(FetchHttpClient.layer));
const ProjectionDataLayer = ProjectionData.layerCached.pipe(
  Layer.provide(Layer.mergeAll(LiveProjectionDataLayer, ApiCacheLayer)),
);
const PlayerIdentityLayer = PlayerIdentity.layerLive.pipe(Layer.provide(DbNode));
const WeeklyProjectionLayer = WeeklyProjections.layerLive.pipe(
  Layer.provide(
    Layer.mergeAll(LeagueStateLayer, YahooLayer, ProjectionDataLayer, PlayerIdentityLayer),
  ),
);
const StandingsHistoryLayer = StandingsHistory.layerLive.pipe(Layer.provide(YahooLayer));
const DailyLineupAdvisorLayer = DailyLineupAdvisor.layerLive.pipe(Layer.provide(YahooLayer));
const TransactionPlannerLayer = TransactionPlanner.layerLive.pipe(
  Layer.provide(Layer.mergeAll(WeeklyProjectionLayer, LeagueStateLayer, StandingsHistoryLayer)),
);
const ManagerBriefingLayer = ManagerBriefing.layerLive.pipe(
  Layer.provide(Layer.mergeAll(TransactionPlannerLayer, DailyLineupAdvisorLayer, ApiCacheLayer)),
);
const TelegramNotifierLayer = TelegramNotifier.layerLive.pipe(Layer.provide(FetchHttpClient.layer));
const DiscordNotifierLayer = DiscordNotifier.layerLive.pipe(Layer.provide(FetchHttpClient.layer));
const CalibrationHarnessLayer = CalibrationHarness.layerLive.pipe(Layer.provide(DbNode));

const AppLayer = Layer.mergeAll(
  DbNode,
  ApiCacheLayer,
  YahooLayer,
  LeagueStateLayer,
  ProjectionDataLayer,
  WeeklyProjectionLayer,
  StandingsHistoryLayer,
  DailyLineupAdvisorLayer,
  TransactionPlannerLayer,
  ManagerBriefingLayer,
  TelegramNotifierLayer,
  DiscordNotifierLayer,
  CalibrationHarnessLayer,
);

const main = runDailyBriefing(parseFlags(process.argv.slice(2))).pipe(
  Effect.provide(AppLayer),
  Effect.provide(NodeServices.layer),
);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  NodeRuntime.runMain(main as Effect.Effect<unknown, unknown, never>);
}
