import type { D1ConnectionClient } from "alchemy/Cloudflare";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as schema from "../db/schema.ts";

export type AppDatabase = DrizzleD1Database<typeof schema>;

const runtimeContextTag = Effect.promise(() =>
  import("alchemy").then((alchemy) => alchemy.RuntimeContext),
);

export class Db extends Context.Service<
  Db,
  {
    readonly d1: D1ConnectionClient;
    readonly drizzle: Effect.Effect<AppDatabase>;
  }
>()("fantasy-gm/Db") {
  static layer(connection: D1ConnectionClient) {
    return Layer.effect(
      Db,
      Effect.gen(function* () {
        const tag = yield* runtimeContextTag;
        const runtimeContext = yield* tag;
        return Db.of({
          d1: connection,
          drizzle: connection.raw.pipe(
            Effect.provideService(tag, runtimeContext),
            Effect.map((binding) => drizzle(binding, { schema })),
          ),
        });
      }),
    );
  }
}
