import type { D1ConnectionClient } from "alchemy/Cloudflare";
import type { RuntimeContext } from "alchemy";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as schema from "../db/schema.ts";

export type AppDatabase = DrizzleD1Database<typeof schema>;

export class Db extends Context.Service<
  Db,
  {
    readonly d1: D1ConnectionClient;
    readonly drizzle: Effect.Effect<AppDatabase, never, RuntimeContext>;
  }
>()("fantasy-gm/Db") {
  static layer(connection: D1ConnectionClient) {
    return Layer.succeed(
      Db,
      Db.of({
        d1: connection,
        drizzle: connection.raw.pipe(Effect.map((binding) => drizzle(binding, { schema }))),
      }),
    );
  }
}
