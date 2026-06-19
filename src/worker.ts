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
import { deliverManagerBriefing } from "./routines/delivery.ts";
import { dispatchRoutine } from "./routines/dispatch.ts";
import { ApiCache } from "./services/ApiCache.ts";
import { Db } from "./services/Db.ts";
import { DecisionEngine } from "./services/DecisionEngine.ts";
import { DiscordNotifier } from "./services/DiscordNotifier.ts";
import { DailyLineupAdvisor } from "./services/DailyLineupAdvisor.ts";
import { LeagueState } from "./services/LeagueState.ts";
import { evaluateManagerHealth, managerHealthDefaults } from "./services/ManagerHealth.ts";
import {
  LAST_MANAGER_DELIVERY_CACHE_KEY,
  ManagerDeliveryReport,
} from "./services/ManagerDelivery.ts";
import {
  LAST_MANAGER_WRITE_STATUS_CACHE_KEY,
  ManagerWriteStatus,
} from "./services/ManagerWriteStatus.ts";
import {
  buildYahooApplyPlan,
  LAST_MANAGER_BRIEFING_CACHE_KEY,
  ManagerBriefing,
  ManagerBriefingReport,
} from "./services/ManagerBriefing.ts";
import { PlayerIdentity } from "./services/PlayerIdentity.ts";
import { ProjectionData } from "./services/ProjectionData.ts";
import { readSchedulerStatus, Scheduler, type SchedulerTask } from "./services/Scheduler.ts";
import { StandingsHistory } from "./services/StandingsHistory.ts";
import { renderManagerBriefingForTelegram } from "./services/TelegramNotifier.ts";
import { TelegramNotifier } from "./services/TelegramNotifier.ts";
import { TransactionPlanner } from "./services/TransactionPlanner.ts";
import { WeeklyProjections } from "./services/WeeklyProjections.ts";
import { YahooClient } from "./services/YahooClient.ts";
import { YahooLineupExecutor } from "./services/YahooLineupExecutor.ts";
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

const publicOriginFor = (
  request: { readonly headers: Readonly<Record<string, string | undefined>> },
  fallbackUrl: URL,
) => {
  const forwardedHost = request.headers["x-forwarded-host"]?.split(",")[0]?.trim();
  const host = forwardedHost ?? request.headers["host"];
  if (host == null || host === "" || host === "localhost") {
    return "https://fantasygm-fantasygmworker-prod-cbbdqptg2afhvv5l.ikusner13.workers.dev";
  }
  const forwardedProto = request.headers["x-forwarded-proto"]?.split(",")[0]?.trim();
  const protocol =
    forwardedProto === "http" || forwardedProto === "https"
      ? forwardedProto
      : fallbackUrl.protocol.replace(":", "") === "https"
        ? "https"
        : "http";
  return `${protocol}://${host}`;
};

const htmlEscape = (value: unknown) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const yahooCallbackHtml = (
  result:
    | { readonly ok: false; readonly error: string }
    | {
        readonly ok: true;
        readonly scope: string;
        readonly expiresAt: string;
        readonly writeCheck: {
          readonly ok: boolean;
          readonly capability: string;
          readonly date: string;
          readonly error?: string;
          readonly applied?: boolean;
          readonly verified?: boolean;
          readonly moves?: ReadonlyArray<{
            readonly playerName: string;
            readonly from: string;
            readonly to: string;
          }>;
          readonly writeAccess?: { readonly verified: boolean; readonly playersWritten: number };
        };
      },
) => {
  const title = result.ok
    ? result.writeCheck.ok
      ? "Yahoo Write Auth Verified"
      : "Yahoo Auth Needs Attention"
    : "Yahoo Auth Failed";
  const status = result.ok
    ? result.writeCheck.ok
      ? "Authorized"
      : `Not verified: ${result.writeCheck.capability}`
    : "Failed";
  const details = result.ok
    ? [
        ["Scope", result.scope],
        ["Token expires", result.expiresAt],
        ["Write date", result.writeCheck.date],
        ["Write access", result.writeCheck.writeAccess?.verified ? "verified" : "not verified"],
        ["Players written in no-op check", result.writeCheck.writeAccess?.playersWritten ?? "n/a"],
        ["Lineup apply attempted", result.writeCheck.applied ?? false],
        ["Lineup apply verified", result.writeCheck.verified ?? false],
        ["Error", result.writeCheck.error ?? ""],
      ]
    : [["Error", result.error]];
  const moveRows =
    result.ok && (result.writeCheck.moves?.length ?? 0) > 0
      ? `<h2>Lineup moves</h2><ul>${result.writeCheck
          .moves!.map(
            (move) =>
              `<li>${htmlEscape(move.playerName)}: ${htmlEscape(move.from)} &rarr; ${htmlEscape(move.to)}</li>`,
          )
          .join("")}</ul>`
      : "";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${htmlEscape(title)}</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; background: #f7f8fa; color: #17202a; }
      main { max-width: 760px; margin: 48px auto; padding: 0 20px; }
      section { background: white; border: 1px solid #d8dee8; border-radius: 8px; padding: 24px; }
      h1 { margin: 0 0 8px; font-size: 28px; }
      h2 { margin-top: 24px; font-size: 18px; }
      .status { font-weight: 700; color: ${result.ok && result.writeCheck.ok ? "#147a3d" : "#a23b19"}; }
      dl { display: grid; grid-template-columns: 180px 1fr; gap: 10px 16px; margin: 20px 0 0; }
      dt { color: #526173; }
      dd { margin: 0; overflow-wrap: anywhere; }
      code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <section>
        <h1>${htmlEscape(title)}</h1>
        <div class="status">${htmlEscape(status)}</div>
        <dl>
          ${details
            .filter(([, value]) => value !== "")
            .map(([key, value]) => `<dt>${htmlEscape(key)}</dt><dd>${htmlEscape(value)}</dd>`)
            .join("")}
        </dl>
        ${moveRows}
        <h2>Next check</h2>
        <p>Run <code>vpr gm:status</code> locally. It should pass once write access is verified.</p>
      </section>
    </main>
  </body>
</html>`;
};

const htmlResponse = (body: string, options?: { readonly status?: number }) =>
  HttpServerResponse.text(body, {
    status: options?.status,
    contentType: "text/html; charset=utf-8",
  });

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
      DAILY_MORNING_BRIEFING_HOUR_EASTERN: Config.number(
        "DAILY_MORNING_BRIEFING_HOUR_EASTERN",
      ).pipe(Config.withDefault(FREE_TIER_MODE.defaults.dailyMorningBriefingHourEastern)),
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
    const DailyLineupAdvisorLayer = DailyLineupAdvisor.layerLive.pipe(Layer.provide(YahooLayer));
    const YahooLineupExecutorLayer = YahooLineupExecutor.layerLive.pipe(
      Layer.provide(Layer.mergeAll(DailyLineupAdvisorLayer, YahooLayer)),
    );
    const TransactionPlannerLayer = TransactionPlanner.layerLive.pipe(
      Layer.provide(Layer.mergeAll(WeeklyProjectionLayer, RuntimeLayer, StandingsHistoryLayer)),
    );
    const ManagerBriefingLayer = ManagerBriefing.layerLive.pipe(
      Layer.provide(
        Layer.mergeAll(TransactionPlannerLayer, DailyLineupAdvisorLayer, ApiCacheLayer),
      ),
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
          YahooLineupExecutorLayer,
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

        if (request.method === "GET" && url.pathname === "/admin/yahoo/auth-url") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
          const redirectUri = `${publicOriginFor(request, url)}/admin/yahoo/callback`;
          const authUrl = yield* Effect.gen(function* () {
            const oauth = yield* YahooOAuth;
            return oauth.authorizationUrlWithState(redirectUri, adminToken);
          }).pipe(Effect.provide(OAuthLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            scope: "fspt-w",
            redirectUri,
            authUrl,
          });
        }

        if (request.method === "GET" && url.pathname === "/admin/yahoo/callback") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("state") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
          const code = url.searchParams.get("code");
          if (code == null || code === "") {
            return yield* HttpServerResponse.json(
              { ok: false, error: "Missing Yahoo OAuth code." },
              { status: 400 },
            );
          }
          const redirectUri = `${publicOriginFor(request, url)}/admin/yahoo/callback`;
          return yield* Effect.gen(function* () {
            const oauth = yield* YahooOAuth;
            const tokens = yield* oauth.exchangeAuthorizationCode(code, redirectUri);
            const date = easternDateKey(new Date());
            const cache = yield* ApiCache;
            const writeCheck = yield* Effect.gen(function* () {
              const executor = yield* YahooLineupExecutor;
              const applyReport = yield* executor.applyForDate(date, { dryRun: false });
              const accessReport = yield* executor.verifyWriteAccessForDate(date);
              return { applyReport, accessReport };
            }).pipe(
              Effect.provide(YahooLineupExecutorLayer),
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.gen(function* () {
                    const status = new ManagerWriteStatus({
                      checkedAt: new Date().toISOString(),
                      capability: "unauthorized",
                      action: "post-auth-apply-lineup",
                      ok: false,
                      date,
                      error:
                        "Yahoo OAuth completed, but Yahoo rejected the guarded lineup write check.",
                    });
                    yield* cache.put(LAST_MANAGER_WRITE_STATUS_CACHE_KEY, status);
                    return {
                      ok: false,
                      capability: status.capability,
                      date,
                      error: error.message,
                    };
                  }),
                onSuccess: ({ applyReport, accessReport }) =>
                  Effect.gen(function* () {
                    const capability = accessReport.verified ? "authorized" : "unknown";
                    const status = new ManagerWriteStatus({
                      checkedAt: new Date().toISOString(),
                      capability,
                      action: "post-auth-apply-lineup",
                      ok: accessReport.verified,
                      date,
                      error:
                        capability === "authorized"
                          ? undefined
                          : "Yahoo OAuth completed, but guarded no-op roster write verification failed.",
                    });
                    yield* cache.put(LAST_MANAGER_WRITE_STATUS_CACHE_KEY, status);
                    return {
                      ok: status.ok,
                      capability,
                      date,
                      applied: applyReport.applied,
                      verified: applyReport.verified,
                      moves: applyReport.moves,
                      writeAccess: accessReport,
                      error: status.error,
                    };
                  }),
              }),
            );
            return { tokens, writeCheck };
          }).pipe(
            Effect.provide(Layer.mergeAll(OAuthLayer, ApiCacheLayer)),
            Effect.map(({ tokens, writeCheck }) =>
              htmlResponse(
                yahooCallbackHtml({
                  ok: true,
                  scope: "fspt-w",
                  expiresAt: new Date(tokens.expiresAt).toISOString(),
                  writeCheck,
                }),
              ),
            ),
            Effect.catch((error: Error) =>
              Effect.succeed(
                htmlResponse(yahooCallbackHtml({ ok: false, error: error.message }), {
                  status: 400,
                }),
              ),
            ),
          );
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

        if (request.method === "POST" && url.pathname === "/admin/run/apply-lineup") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
          const date = url.searchParams.get("date") ?? easternDateKey(new Date());
          const apply = url.searchParams.get("apply") === "1";
          const cacheWriteStatus = (status: ManagerWriteStatus) =>
            Effect.gen(function* () {
              const cache = yield* ApiCache;
              yield* cache.put(LAST_MANAGER_WRITE_STATUS_CACHE_KEY, status);
            }).pipe(Effect.provide(ApiCacheLayer));
          const response = yield* Effect.gen(function* () {
            const executor = yield* YahooLineupExecutor;
            return yield* executor.applyForDate(date, { dryRun: !apply });
          }).pipe(
            Effect.provide(YahooLineupExecutorLayer),
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.gen(function* () {
                  if (apply) {
                    yield* cacheWriteStatus(
                      new ManagerWriteStatus({
                        checkedAt: new Date().toISOString(),
                        capability: "unauthorized",
                        action: "apply-lineup",
                        ok: false,
                        date,
                        error:
                          "Yahoo rejected lineup write; re-authorize with Fantasy Sports read/write scope.",
                      }),
                    );
                  }
                  return yield* HttpServerResponse.json(
                    {
                      ok: false,
                      mode: apply ? "apply" : "dry-run",
                      error: error.message,
                    },
                    { status: 409 },
                  );
                }),
              onSuccess: (report) =>
                Effect.gen(function* () {
                  if (apply) {
                    yield* cacheWriteStatus(
                      new ManagerWriteStatus({
                        checkedAt: new Date().toISOString(),
                        capability: "authorized",
                        action: "apply-lineup",
                        ok: true,
                        date,
                      }),
                    );
                  }
                  return yield* HttpServerResponse.json({
                    ok: report.verified || !apply,
                    mode: apply ? "apply" : "dry-run",
                    result: report,
                  });
                }),
            }),
          );
          return response;
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
          if (
            !["refresh-projections", "refresh-context", "apply-lineup", "send-briefing"].includes(
              task,
            )
          ) {
            return HttpServerResponse.text("Unknown task", { status: 400 });
          }
          const force = url.searchParams.get("force") === "1";
          const ran = yield* Effect.gen(function* () {
            const scheduler = yield* Scheduler;
            return yield* scheduler.runTask(task, { force });
          }).pipe(Effect.provide(SchedulerLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            task,
            ran,
            force,
          });
        }

        if (request.method === "POST" && url.pathname === "/admin/run/resend-briefing") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const [briefing, telegram, discord, cache] = yield* Effect.gen(function* () {
            const cache = yield* ApiCache;
            const briefing = yield* cache.get(
              LAST_MANAGER_BRIEFING_CACHE_KEY,
              ManagerBriefingReport,
              36 * 60 * 60 * 1000,
            );
            const telegram = yield* TelegramNotifier;
            const discord = yield* DiscordNotifier;
            return [briefing, telegram, discord, cache] as const;
          }).pipe(
            Effect.provide(
              Layer.mergeAll(ApiCacheLayer, TelegramNotifierLayer, DiscordNotifierLayer),
            ),
          );

          if (briefing == null) {
            return yield* HttpServerResponse.json(
              {
                ok: false,
                error: "No cached briefing available; run send-briefing first.",
              },
              { status: 404 },
            );
          }

          const delivery = yield* deliverManagerBriefing(briefing, telegram, discord);
          yield* cache.put(LAST_MANAGER_DELIVERY_CACHE_KEY, delivery);

          return yield* HttpServerResponse.json({
            ok: delivery.channels.some((channel) => channel.ok),
            briefingGeneratedAt: briefing.generatedAt,
            delivery,
          });
        }

        if (request.method === "POST" && url.pathname === "/admin/run/recover-briefing") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const maxBriefingAgeMinutes = Number.parseInt(
            url.searchParams.get("maxBriefingAgeMinutes") ??
              `${managerHealthDefaults.maxBriefingAgeMinutes}`,
            10,
          );
          const forceRegenerate =
            url.searchParams.get("forceRegenerate") === "1" ||
            url.searchParams.get("forceRegenerate") === "true";
          const [status, briefing, delivery, telegram, discord, cache] = yield* Effect.gen(
            function* () {
              const cache = yield* ApiCache;
              const [status, briefing, delivery] = yield* Effect.all(
                [
                  readSchedulerStatus(cache),
                  cache.get(
                    LAST_MANAGER_BRIEFING_CACHE_KEY,
                    ManagerBriefingReport,
                    36 * 60 * 60 * 1000,
                  ),
                  cache.get(
                    LAST_MANAGER_DELIVERY_CACHE_KEY,
                    ManagerDeliveryReport,
                    36 * 60 * 60 * 1000,
                  ),
                ],
                { concurrency: 1 },
              );
              const telegram = yield* TelegramNotifier;
              const discord = yield* DiscordNotifier;
              return [status, briefing, delivery, telegram, discord, cache] as const;
            },
          ).pipe(
            Effect.provide(
              Layer.mergeAll(ApiCacheLayer, TelegramNotifierLayer, DiscordNotifierLayer),
            ),
          );
          const health = evaluateManagerHealth(status, briefing, delivery, {
            maxBriefingAgeMinutes: Number.isFinite(maxBriefingAgeMinutes)
              ? maxBriefingAgeMinutes
              : managerHealthDefaults.maxBriefingAgeMinutes,
            requireSentToday: true,
            requireDelivery: true,
            requireDeliveredToday: true,
          });

          if (health.ok) {
            return yield* HttpServerResponse.json({
              ok: true,
              action: "none",
              health,
            });
          }

          const canResendCached =
            briefing != null &&
            (health.deliverySucceeded !== true ||
              delivery == null ||
              delivery.generatedAt !== briefing.generatedAt);
          if (canResendCached) {
            const recoveredDelivery = yield* deliverManagerBriefing(briefing, telegram, discord);
            yield* cache.put(LAST_MANAGER_DELIVERY_CACHE_KEY, recoveredDelivery);
            return yield* HttpServerResponse.json({
              ok: recoveredDelivery.channels.some((channel) => channel.ok),
              action: "resend",
              healthBefore: health,
              briefingGeneratedAt: briefing.generatedAt,
              delivery: recoveredDelivery,
            });
          }

          if (forceRegenerate) {
            const ran = yield* Effect.gen(function* () {
              const scheduler = yield* Scheduler;
              return yield* scheduler.runTask("send-briefing", { force: true });
            }).pipe(Effect.provide(SchedulerLayer));
            return yield* HttpServerResponse.json({
              ok: ran,
              action: "force-send-briefing",
              healthBefore: health,
              ran,
            });
          }

          return yield* HttpServerResponse.json(
            {
              ok: false,
              action: "blocked",
              health,
              error: "Briefing is stale or missing; pass forceRegenerate=1 to recompute and send.",
            },
            { status: 409 },
          );
        }

        if (request.method === "POST" && url.pathname === "/admin/decision") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const maxBriefingAgeMinutes = Number.parseInt(
            url.searchParams.get("maxBriefingAgeMinutes") ??
              `${managerHealthDefaults.maxBriefingAgeMinutes}`,
            10,
          );
          const forceRegenerate =
            url.searchParams.get("forceRegenerate") === "1" ||
            url.searchParams.get("forceRegenerate") === "true";
          const healthOptions = {
            maxBriefingAgeMinutes: Number.isFinite(maxBriefingAgeMinutes)
              ? maxBriefingAgeMinutes
              : managerHealthDefaults.maxBriefingAgeMinutes,
            requireSentToday: true,
            requireDelivery: true,
            requireDeliveredToday: true,
          };
          const [status, briefing, delivery, telegram, discord, cache] = yield* Effect.gen(
            function* () {
              const cache = yield* ApiCache;
              const [status, briefing, delivery] = yield* Effect.all(
                [
                  readSchedulerStatus(cache),
                  cache.get(
                    LAST_MANAGER_BRIEFING_CACHE_KEY,
                    ManagerBriefingReport,
                    36 * 60 * 60 * 1000,
                  ),
                  cache.get(
                    LAST_MANAGER_DELIVERY_CACHE_KEY,
                    ManagerDeliveryReport,
                    36 * 60 * 60 * 1000,
                  ),
                ],
                { concurrency: 1 },
              );
              const telegram = yield* TelegramNotifier;
              const discord = yield* DiscordNotifier;
              return [status, briefing, delivery, telegram, discord, cache] as const;
            },
          ).pipe(
            Effect.provide(
              Layer.mergeAll(ApiCacheLayer, TelegramNotifierLayer, DiscordNotifierLayer),
            ),
          );

          const health = evaluateManagerHealth(status, briefing, delivery, healthOptions);
          const recovery = yield* Effect.gen(function* () {
            if (health.ok) return { ok: true, action: "none" as const, health };
            const canResendCached =
              briefing != null &&
              (health.deliverySucceeded !== true ||
                delivery == null ||
                delivery.generatedAt !== briefing.generatedAt);
            if (canResendCached) {
              const recoveredDelivery = yield* deliverManagerBriefing(briefing, telegram, discord);
              yield* cache.put(LAST_MANAGER_DELIVERY_CACHE_KEY, recoveredDelivery);
              return {
                ok: recoveredDelivery.channels.some((channel) => channel.ok),
                action: "resend" as const,
                healthBefore: health,
                briefingGeneratedAt: briefing.generatedAt,
                delivery: recoveredDelivery,
              };
            }
            if (forceRegenerate) {
              const ran = yield* Effect.gen(function* () {
                const scheduler = yield* Scheduler;
                return yield* scheduler.runTask("send-briefing", { force: true });
              }).pipe(Effect.provide(SchedulerLayer));
              return {
                ok: ran,
                action: "force-send-briefing" as const,
                healthBefore: health,
                ran,
              };
            }
            return {
              ok: false,
              action: "blocked" as const,
              health,
              error: "Briefing is stale or missing; pass forceRegenerate=1 to recompute and send.",
            };
          });

          const [refreshedStatus, refreshedBriefing, refreshedDelivery, refreshedWriteStatus] =
            yield* Effect.all(
              [
                readSchedulerStatus(cache),
                cache.get(
                  LAST_MANAGER_BRIEFING_CACHE_KEY,
                  ManagerBriefingReport,
                  36 * 60 * 60 * 1000,
                ),
                cache.get(
                  LAST_MANAGER_DELIVERY_CACHE_KEY,
                  ManagerDeliveryReport,
                  36 * 60 * 60 * 1000,
                ),
                cache.get(
                  LAST_MANAGER_WRITE_STATUS_CACHE_KEY,
                  ManagerWriteStatus,
                  30 * 24 * 60 * 60 * 1000,
                ),
              ],
              { concurrency: 1 },
            );
          const finalHealth = evaluateManagerHealth(
            refreshedStatus,
            refreshedBriefing,
            refreshedDelivery,
            healthOptions,
          );
          if (refreshedBriefing == null) {
            return yield* HttpServerResponse.json(
              {
                ok: false,
                recovery,
                health: finalHealth,
                writeStatus: refreshedWriteStatus,
                error: "No cached briefing available; run send-briefing first.",
              },
              { status: 404 },
            );
          }
          return yield* HttpServerResponse.json(
            {
              ok: recovery.ok && finalHealth.ok,
              recovery,
              health: finalHealth,
              writeStatus: refreshedWriteStatus,
              briefing: refreshedBriefing,
              telegramText: renderManagerBriefingForTelegram(refreshedBriefing),
              applyPlan: buildYahooApplyPlan(refreshedBriefing),
            },
            { status: recovery.ok && finalHealth.ok ? 200 : 409 },
          );
        }

        if (request.method === "GET" && url.pathname === "/admin/preview/scheduler") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const status = yield* Effect.gen(function* () {
            const cache = yield* ApiCache;
            return yield* readSchedulerStatus(cache);
          }).pipe(Effect.provide(ApiCacheLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            status,
          });
        }

        if (request.method === "GET" && url.pathname === "/admin/health/manager") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const maxBriefingAgeMinutes = Number.parseInt(
            url.searchParams.get("maxBriefingAgeMinutes") ??
              `${managerHealthDefaults.maxBriefingAgeMinutes}`,
            10,
          );
          const requireSentToday =
            url.searchParams.get("requireSentToday") === "1" ||
            url.searchParams.get("requireSentToday") === "true";
          const requireDelivery =
            url.searchParams.get("requireDelivery") === "1" ||
            url.searchParams.get("requireDelivery") === "true";
          const requireDeliveredToday =
            url.searchParams.get("requireDeliveredToday") === "1" ||
            url.searchParams.get("requireDeliveredToday") === "true";
          const requireYahooWrites =
            url.searchParams.get("requireYahooWrites") === "1" ||
            url.searchParams.get("requireYahooWrites") === "true";
          const [status, briefing, delivery, writeStatus] = yield* Effect.gen(function* () {
            const cache = yield* ApiCache;
            return yield* Effect.all(
              [
                readSchedulerStatus(cache),
                cache.get(
                  LAST_MANAGER_BRIEFING_CACHE_KEY,
                  ManagerBriefingReport,
                  36 * 60 * 60 * 1000,
                ),
                cache.get(
                  LAST_MANAGER_DELIVERY_CACHE_KEY,
                  ManagerDeliveryReport,
                  36 * 60 * 60 * 1000,
                ),
                cache.get(
                  LAST_MANAGER_WRITE_STATUS_CACHE_KEY,
                  ManagerWriteStatus,
                  30 * 24 * 60 * 60 * 1000,
                ),
              ],
              { concurrency: 1 },
            );
          }).pipe(Effect.provide(ApiCacheLayer));
          const health = evaluateManagerHealth(status, briefing, delivery, writeStatus, {
            maxBriefingAgeMinutes: Number.isFinite(maxBriefingAgeMinutes)
              ? maxBriefingAgeMinutes
              : managerHealthDefaults.maxBriefingAgeMinutes,
            requireSentToday,
            requireDelivery,
            requireDeliveredToday,
            requireYahooWrites,
          });

          return yield* HttpServerResponse.json(
            {
              ok: health.ok,
              health,
              status,
              briefing:
                briefing == null
                  ? undefined
                  : {
                      generatedAt: briefing.generatedAt,
                      summary: briefing.summary,
                      managerTakeaways: briefing.managerTakeaways,
                      lineupAlertCount: briefing.lineupAlerts.length,
                    },
              delivery,
              writeStatus,
            },
            { status: health.ok ? 200 : 503 },
          );
        }

        if (request.method === "GET" && url.pathname === "/admin/preview/briefing") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const live = url.searchParams.get("live") === "1";
          const briefing = yield* live
            ? Effect.gen(function* () {
                const managerBriefing = yield* ManagerBriefing;
                return yield* managerBriefing.currentBriefing;
              }).pipe(Effect.provide(ManagerBriefingLayer))
            : Effect.gen(function* () {
                const cache = yield* ApiCache;
                return yield* cache.get(
                  LAST_MANAGER_BRIEFING_CACHE_KEY,
                  ManagerBriefingReport,
                  36 * 60 * 60 * 1000,
                );
              }).pipe(Effect.provide(ApiCacheLayer));

          if (briefing == null) {
            return yield* HttpServerResponse.json(
              {
                ok: false,
                error: "No cached briefing available; run send-briefing first.",
              },
              { status: 404 },
            );
          }

          return yield* HttpServerResponse.json({
            ok: true,
            live,
            briefing,
            telegramText: renderManagerBriefingForTelegram(briefing),
          });
        }

        if (request.method === "GET" && url.pathname === "/admin/preview/apply-plan") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const live = url.searchParams.get("live") === "1";
          const briefing = yield* live
            ? Effect.gen(function* () {
                const managerBriefing = yield* ManagerBriefing;
                return yield* managerBriefing.currentBriefing;
              }).pipe(Effect.provide(ManagerBriefingLayer))
            : Effect.gen(function* () {
                const cache = yield* ApiCache;
                return yield* cache.get(
                  LAST_MANAGER_BRIEFING_CACHE_KEY,
                  ManagerBriefingReport,
                  36 * 60 * 60 * 1000,
                );
              }).pipe(Effect.provide(ApiCacheLayer));

          if (briefing == null) {
            return yield* HttpServerResponse.json(
              {
                ok: false,
                error: "No cached briefing available; run send-briefing first.",
              },
              { status: 404 },
            );
          }

          return yield* HttpServerResponse.json({
            ok: true,
            live,
            applyPlan: buildYahooApplyPlan(briefing),
          });
        }

        if (request.method === "GET" && url.pathname === "/admin/preview/lineup") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }

          const date = url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10);
          const report = yield* Effect.gen(function* () {
            const advisor = yield* DailyLineupAdvisor;
            return yield* advisor.forDate(date);
          }).pipe(Effect.provide(DailyLineupAdvisorLayer));

          return yield* HttpServerResponse.json({
            ok: true,
            report,
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
