import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import FantasyGMWorker from "./src/worker.ts";
import SimChunkWorker from "./src/sim-chunk-worker.ts";
import { AppSecrets, DecisionLogDb, LeagueStateCache } from "./src/infra/resources.ts";

export default Alchemy.Stack(
  "FantasyGM",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const db = yield* DecisionLogDb;
    const kv = yield* LeagueStateCache;
    const secrets = yield* AppSecrets;
    // The separate sim-chunk worker (same D1, no cron). The main worker cross-worker-binds it; the
    // main worker `yield* SimChunkWorker` resolves the SAME resource instance, so it is deployed
    // once and bound, not duplicated.
    const simChunkWorker = yield* SimChunkWorker;
    const worker = yield* FantasyGMWorker;

    return {
      workerUrl: worker.url.as<string>(),
      simChunkWorkerUrl: simChunkWorker.url.as<string>(),
      databaseName: db.databaseName,
      kvTitle: kv.title,
      secretNames: secrets.map((secret) => secret.secretName),
      crons: worker.crons,
    };
  }),
);
