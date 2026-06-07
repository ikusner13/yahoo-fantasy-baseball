import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { makeHealthResponse } from "./http/health.ts";
import { CRON_ROUTINES } from "./infra/crons.ts";
import { FREE_TIER_MODE } from "./infra/free-tier.ts";
import { DecisionLogDb, LeagueStateCache } from "./infra/resources.ts";
import { dispatchRoutine } from "./routines/dispatch.ts";
import { ApiCache } from "./services/ApiCache.ts";
import { Db } from "./services/Db.ts";
import { DecisionEngine } from "./services/DecisionEngine.ts";
import { DiscordNotifier } from "./services/DiscordNotifier.ts";
import { LeagueState } from "./services/LeagueState.ts";
import { ManagerBriefing } from "./services/ManagerBriefing.ts";
import { PlayerIdentity } from "./services/PlayerIdentity.ts";
import { ProjectionData } from "./services/ProjectionData.ts";
import { Scheduler, type SchedulerTask } from "./services/Scheduler.ts";
import { StandingsHistory } from "./services/StandingsHistory.ts";
import { renderManagerBriefingForTelegram } from "./services/TelegramNotifier.ts";
import { TelegramNotifier } from "./services/TelegramNotifier.ts";
import { TransactionPlanner } from "./services/TransactionPlanner.ts";
import { WeeklyProjections } from "./services/WeeklyProjections.ts";
import { YahooClient } from "./services/YahooClient.ts";
import { kvYahooTokenStore, YahooOAuth } from "./services/YahooOAuth.ts";

const registerCron = (
  cron: (typeof CRON_ROUTINES)[number],
  runtimeLayer: Layer.Layer<
    LeagueState | ManagerBriefing | TelegramNotifier | DiscordNotifier | Scheduler,
    unknown,
    unknown
  >,
) =>
  Cloudflare.cron(cron.expression).subscribe(() =>
    dispatchRoutine(cron.routine).pipe(Effect.provide(runtimeLayer), Effect.orDie),
  );

export default class FantasyGMWorker extends Cloudflare.Worker<FantasyGMWorker>()(
  "FantasyGMWorker",
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-06-02",
      flags: ["nodejs_compat"],
    },
    env: {
      YAHOO_CLIENT_ID: Config.string("YAHOO_CLIENT_ID"),
      YAHOO_CLIENT_SECRET: Config.string("YAHOO_CLIENT_SECRET"),
      YAHOO_LEAGUE_ID: Config.string("YAHOO_LEAGUE_ID"),
      YAHOO_TEAM_ID: Config.string("YAHOO_TEAM_ID"),
      YAHOO_REFRESH_TOKEN: Config.string("YAHOO_REFRESH_TOKEN"),
      ODDS_API_KEY: Config.string("ODDS_API_KEY"),
      TELEGRAM_BOT_TOKEN: Config.string("TELEGRAM_BOT_TOKEN"),
      TELEGRAM_CHAT_ID: Config.string("TELEGRAM_CHAT_ID"),
      DISCORD_BOT_TOKEN: Config.string("DISCORD_BOT_TOKEN").pipe(Config.option),
      DISCORD_CHANNEL_ID: Config.string("DISCORD_CHANNEL_ID").pipe(Config.option),
      ADMIN_TRIGGER_TOKEN: Config.string("ADMIN_TRIGGER_TOKEN"),
      MAX_CONFIRMED_LINEUP_BOXSCORES: Config.number("MAX_CONFIRMED_LINEUP_BOXSCORES").pipe(
        Config.withDefault(FREE_TIER_MODE.defaults.maxConfirmedLineupBoxscores),
      ),
      USE_STANDINGS_HISTORY: Config.boolean("USE_STANDINGS_HISTORY").pipe(
        Config.withDefault(FREE_TIER_MODE.defaults.useStandingsHistory),
      ),
      DAILY_BRIEFING_HOUR_UTC: Config.number("DAILY_BRIEFING_HOUR_UTC").pipe(
        Config.withDefault(FREE_TIER_MODE.defaults.dailyBriefingHourUtcFallback),
      ),
    },
    dev: {
      port: 8787,
    },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
  },
  Effect.gen(function* () {
    const d1 = yield* Cloudflare.D1Connection.bind(DecisionLogDb);
    const leagueStateKv = yield* Cloudflare.KVNamespace.bind(LeagueStateCache);
    const runtimeContext = yield* RuntimeContext;

    const OAuthLayer = YahooOAuth.layer(kvYahooTokenStore(leagueStateKv, runtimeContext)).pipe(
      Layer.provide(FetchHttpClient.layer),
    );
    const YahooLayer = YahooClient.layer.pipe(
      Layer.provide(Layer.mergeAll(OAuthLayer, FetchHttpClient.layer)),
    );
    const RuntimeLayer = LeagueState.layerLive.pipe(Layer.provide(YahooLayer));

    const DbLayer = Db.layer(d1);
    const ApiCacheLayer = ApiCache.layerLive.pipe(Layer.provide(DbLayer));
    const LiveProjectionDataLayer = ProjectionData.layerLive.pipe(
      Layer.provide(FetchHttpClient.layer),
    );
    const ProjectionDataLayer = ProjectionData.layerCached.pipe(
      Layer.provide(Layer.mergeAll(LiveProjectionDataLayer, ApiCacheLayer)),
    );
    const PlayerIdentityLayer = PlayerIdentity.layerLive.pipe(Layer.provide(DbLayer));
    const StandingsHistoryLayer = StandingsHistory.layerLive.pipe(Layer.provide(YahooLayer));
    const WeeklyProjectionLayer = WeeklyProjections.layerLive.pipe(
      Layer.provide(
        Layer.mergeAll(RuntimeLayer, YahooLayer, ProjectionDataLayer, PlayerIdentityLayer),
      ),
    );
    const DecisionEngineLayer = DecisionEngine.layerLive.pipe(
      Layer.provide(Layer.mergeAll(WeeklyProjectionLayer, RuntimeLayer, StandingsHistoryLayer)),
    );
    const TransactionPlannerLayer = TransactionPlanner.layerLive.pipe(
      Layer.provide(Layer.mergeAll(WeeklyProjectionLayer, RuntimeLayer, StandingsHistoryLayer)),
    );
    const ManagerBriefingLayer = ManagerBriefing.layerLive.pipe(
      Layer.provide(TransactionPlannerLayer),
    );
    const TelegramNotifierLayer = TelegramNotifier.layerLive.pipe(
      Layer.provide(FetchHttpClient.layer),
    );
    const DiscordNotifierLayer = DiscordNotifier.layerLive.pipe(
      Layer.provide(FetchHttpClient.layer),
    );
    const SchedulerLayer = Scheduler.layerLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          ApiCacheLayer,
          ProjectionDataLayer,
          RuntimeLayer,
          ManagerBriefingLayer,
          TelegramNotifierLayer,
          DiscordNotifierLayer,
        ),
      ),
    );
    const RoutineLayer = Layer.mergeAll(
      RuntimeLayer,
      ManagerBriefingLayer,
      TelegramNotifierLayer,
      DiscordNotifierLayer,
      SchedulerLayer,
    );

    yield* Effect.all(CRON_ROUTINES.map((cron) => registerCron(cron, RoutineLayer)));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json(makeHealthResponse(CRON_ROUTINES.length));
        }

        if (request.method === "GET" && url.pathname === "/") {
          return HttpServerResponse.text("Fantasy GM scaffold is running.");
        }

        if (request.method === "POST" && url.pathname === "/admin/run/daily-morning") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          yield* dispatchRoutine("daily-morning").pipe(Effect.provide(RoutineLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            routine: "daily-morning",
          });
        }

        if (request.method === "POST" && url.pathname === "/admin/run/scheduler-tick") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const task = yield* Effect.gen(function* () {
            const scheduler = yield* Scheduler;
            return yield* scheduler.tick;
          }).pipe(Effect.provide(SchedulerLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            task,
          });
        }

        if (request.method === "POST" && url.pathname.startsWith("/admin/run/task/")) {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
          const task = url.pathname.split("/").at(-1) as SchedulerTask;
          if (!["refresh-projections", "refresh-context", "send-briefing"].includes(task)) {
            return HttpServerResponse.text("Unknown task", { status: 400 });
          }
          yield* Effect.gen(function* () {
            const scheduler = yield* Scheduler;
            yield* scheduler.runTask(task);
          }).pipe(Effect.provide(SchedulerLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            task,
          });
        }

        if (request.method === "GET" && url.pathname === "/admin/preview/briefing") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const briefing = yield* Effect.gen(function* () {
            const managerBriefing = yield* ManagerBriefing;
            return yield* managerBriefing.currentBriefing;
          }).pipe(Effect.provide(ManagerBriefingLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            briefing,
            telegramText: renderManagerBriefingForTelegram(briefing),
          });
        }

        if (
          request.method === "GET" &&
          url.pathname === "/debug/phase2" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        ) {
          const set = yield* Effect.gen(function* () {
            const weeklyProjections = yield* WeeklyProjections;
            return yield* weeklyProjections.currentMatchup;
          }).pipe(Effect.provide(WeeklyProjectionLayer));

          return yield* HttpServerResponse.json({
            myRosterLines: set.myRoster.length,
            opponentRosterLines: set.opponentRoster.length,
            freeAgentLines: set.freeAgents.length,
            sampleMyRoster: set.myRoster.slice(0, 3),
            sampleOpponent: set.opponentRoster.slice(0, 3),
            sampleFreeAgents: set.freeAgents.slice(0, 3),
          });
        }

        if (
          request.method === "GET" &&
          url.pathname === "/debug/phase3" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        ) {
          const report = yield* Effect.gen(function* () {
            const decisionEngine = yield* DecisionEngine;
            return yield* decisionEngine.currentAddRecommendations;
          }).pipe(Effect.provide(DecisionEngineLayer));

          return yield* HttpServerResponse.json({
            baselineExpectedCategoryPoints: report.baseline.expectedCategoryPoints,
            baselineCategories: report.baseline.categories,
            scout: report.scout,
            recommendations: report.recommendations.slice(0, 10),
            lineupRecommendations: report.lineupRecommendations.slice(0, 10),
          });
        }

        if (
          request.method === "GET" &&
          url.pathname === "/debug/phase4" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        ) {
          const plan = yield* Effect.gen(function* () {
            const transactionPlanner = yield* TransactionPlanner;
            return yield* transactionPlanner.currentPlan;
          }).pipe(Effect.provide(TransactionPlannerLayer));

          return yield* HttpServerResponse.json(plan);
        }

        if (
          request.method === "GET" &&
          url.pathname === "/debug/briefing" &&
          (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        ) {
          const briefing = yield* Effect.gen(function* () {
            const managerBriefing = yield* ManagerBriefing;
            return yield* managerBriefing.currentBriefing;
          }).pipe(Effect.provide(ManagerBriefingLayer));

          return yield* HttpServerResponse.json(briefing);
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1ConnectionLive,
        Cloudflare.KVNamespaceBindingLive,
        Cloudflare.CronEventSourceLive,
      ).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Cloudflare.D1ConnectionPolicyLive,
            Cloudflare.KVNamespaceBindingPolicyLive,
            Cloudflare.CronEventSourcePolicyLive,
          ),
        ),
      ),
    ),
  ),
) {}
