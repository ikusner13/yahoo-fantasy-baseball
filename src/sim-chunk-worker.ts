import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import { FREE_TIER_MODE } from "./infra/free-tier.ts";
import { DecisionLogDb } from "./infra/resources.ts";
import { ApiCache } from "./services/ApiCache.ts";
import { Db } from "./services/Db.ts";
import { runSimChunk } from "./services/SimChunk.ts";

// SEPARATE sim-chunk worker (a DIFFERENT script than FantasyGMWorker), sharing the SAME D1 database.
//
// WHY a second worker: a Cloudflare Worker cannot offload CPU to ITSELF — a self HTTP fetch to its
// own workers.dev host is loopback-BLOCKED, and a self service binding kills the parent invocation
// with exceededCpu (same-worker loop-protection / CPU sharing). So the heavy per-unit Monte Carlo
// MUST run in a separate script. The main worker invokes it via a CROSS-worker service binding
// (see worker.ts `env: { SIM_CHUNK_WORKER }`), which gives this worker its OWN independent CPU
// budget and no loop-protection.
//
// It is intentionally TINY: it binds only the shared D1 (the `DB` binding) + ApiCache, reuses the
// EXISTING runSimChunk core from worker.ts (no sim logic duplicated), and has NO cron trigger (the
// repo enforces maxCronTriggers: 1 on the MAIN worker; this worker must not add one). It is invoked
// only via the service binding (or its own public URL for manual ops).
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

export default class SimChunkWorker extends Cloudflare.Worker<SimChunkWorker>()(
  "SimChunkWorker",
  {
    main: import.meta.filename,
    compatibility: {
      date: "2026-06-02",
      flags: ["nodejs_compat"],
    },
    env: {
      ADMIN_TRIGGER_TOKEN: Config.string("ADMIN_TRIGGER_TOKEN"),
    },
    dev: {
      port: 8788,
    },
    observability: {
      enabled: true,
      logs: { enabled: true, invocationLogs: true },
    },
  },
  Effect.gen(function* () {
    // Bind the SAME D1 database resource as the main worker → reads the spec and writes partials to
    // the SAME `apiCache` table. D1 is strongly consistent read-after-write, so a partial written
    // here is visible to the main worker's reduce stage.
    const d1 = yield* Cloudflare.D1Connection.bind(DecisionLogDb);
    const DbLayer = Db.layer(d1);
    const ApiCacheLayer = ApiCache.layerLive.pipe(Layer.provide(DbLayer));

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");

        if (request.method === "GET" && url.pathname === "/internal/sim-chunk") {
          const adminToken = yield* Config.string("ADMIN_TRIGGER_TOKEN");
          if (url.searchParams.get("token") !== adminToken) {
            return HttpServerResponse.text("Unauthorized", { status: 401 });
          }
          const date = url.searchParams.get("date") ?? easternDateKey(new Date());
          const unit = Number.parseInt(url.searchParams.get("unit") ?? "", 10);
          const chunk = Number.parseInt(url.searchParams.get("chunk") ?? "0", 10);
          const chunkCount = Number.parseInt(url.searchParams.get("chunkCount") ?? "1", 10);

          // ONLY ApiCache (over the shared D1). simulateUnit is pure; every input comes from the
          // persisted spec, so this invocation never touches Yahoo/projections and stays tiny.
          const result = yield* runSimChunk({ date, unit, chunk, chunkCount }).pipe(
            Effect.provide(ApiCacheLayer),
          );

          if (result.ok) {
            return yield* HttpServerResponse.json(result);
          }
          if (result.reason === "spec-missing") {
            return yield* HttpServerResponse.json(
              { ok: false, reason: "spec-missing", date },
              { status: 409 },
            );
          }
          return yield* HttpServerResponse.json(
            { ok: false, reason: "bad-params", error: result.message },
            { status: 400 },
          );
        }

        if (request.method === "GET" && url.pathname === "/health") {
          return yield* HttpServerResponse.json({
            ok: true,
            worker: "sim-chunk",
            freeTier: FREE_TIER_MODE.mode,
          });
        }

        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.D1ConnectionLive).pipe(
        Layer.provideMerge(Layer.mergeAll(Cloudflare.D1ConnectionPolicyLive)),
      ),
    ),
  ),
) {}
