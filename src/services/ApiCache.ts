import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { apiCache } from "../db/schema.ts";
import { Db } from "./Db.ts";

export class ApiCacheError extends Data.TaggedError("ApiCacheError")<{
  readonly message: string;
  readonly key: string;
}> {}

export class ApiCache extends Context.Service<
  ApiCache,
  {
    readonly get: <A>(
      key: string,
      schema: Schema.Schema<A>,
      maxAgeMs: number,
    ) => Effect.Effect<A | undefined, ApiCacheError>;
    readonly put: <A>(key: string, value: A) => Effect.Effect<void, ApiCacheError>;
    readonly getOrRefresh: <A>(
      key: string,
      schema: Schema.Schema<A>,
      maxAgeMs: number,
      refresh: Effect.Effect<A, unknown, never>,
    ) => Effect.Effect<A, unknown, never>;
    readonly getOrRefreshTyped: <A, E>(
      key: string,
      schema: Schema.Schema<A>,
      maxAgeMs: number,
      refresh: Effect.Effect<A, E, never>,
    ) => Effect.Effect<A, ApiCacheError | E, never>;
  }
>()("fantasy-gm/ApiCache") {
  static readonly layerLive = Layer.effect(
    ApiCache,
    Effect.gen(function* () {
      const db = yield* Db;
      const database = yield* db.drizzle;

      const get = <A>(key: string, schema: Schema.Schema<A>, maxAgeMs: number) =>
        Effect.gen(function* () {
          const rows = yield* Effect.tryPromise({
            try: () => database.select().from(apiCache).where(eq(apiCache.cacheKey, key)).limit(1),
            catch: (error) => new ApiCacheError({ key, message: String(error) }),
          });
          const row = rows[0];
          if (row == null) return undefined;
          const updatedAt = Date.parse(row.updatedAt);
          if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAgeMs) return undefined;
          const parsed = yield* Effect.try({
            try: () => JSON.parse(row.data) as unknown,
            catch: (error) => new ApiCacheError({ key, message: String(error) }),
          });
          return yield* (
            Schema.decodeUnknownEffect(schema)(parsed) as Effect.Effect<A, unknown, never>
          ).pipe(
            Effect.mapError(
              (error) =>
                new ApiCacheError({ key, message: `Invalid cache payload: ${String(error)}` }),
            ),
          );
        });

      const put = <A>(key: string, value: A) =>
        Effect.tryPromise({
          try: () =>
            database
              .insert(apiCache)
              .values({
                cacheKey: key,
                data: JSON.stringify(value),
                updatedAt: new Date().toISOString(),
              })
              .onConflictDoUpdate({
                target: apiCache.cacheKey,
                set: {
                  data: JSON.stringify(value),
                  updatedAt: new Date().toISOString(),
                },
              }),
          catch: (error) => new ApiCacheError({ key, message: String(error) }),
        }).pipe(Effect.asVoid);

      const getOrRefreshTyped = <A, E>(
        key: string,
        schema: Schema.Schema<A>,
        maxAgeMs: number,
        refresh: Effect.Effect<A, E, never>,
      ) =>
        Effect.gen(function* () {
          const cached = yield* get(key, schema, maxAgeMs);
          if (cached !== undefined) return cached;
          const value = yield* refresh;
          yield* put(key, value);
          return value;
        });

      const getOrRefresh = <A>(
        key: string,
        schema: Schema.Schema<A>,
        maxAgeMs: number,
        refresh: Effect.Effect<A, unknown, never>,
      ) => getOrRefreshTyped(key, schema, maxAgeMs, refresh);

      return ApiCache.of({ get, put, getOrRefresh, getOrRefreshTyped });
    }),
  );
}

export const makeApiCacheTest = (
  store = new Map<string, { data: string; updatedAt: string }>(),
) => {
  const get = <A>(key: string, schema: Schema.Schema<A>, maxAgeMs: number) =>
    Effect.gen(function* () {
      const row = store.get(key);
      if (row == null) return undefined;
      if (Date.now() - Date.parse(row.updatedAt) > maxAgeMs) return undefined;
      return yield* (
        Schema.decodeUnknownEffect(schema)(JSON.parse(row.data)) as Effect.Effect<A, unknown, never>
      ).pipe(
        Effect.mapError(
          (error) => new ApiCacheError({ key, message: `Invalid cache payload: ${String(error)}` }),
        ),
      );
    });

  const put = <A>(key: string, value: A) =>
    Effect.sync(() => {
      store.set(key, { data: JSON.stringify(value), updatedAt: new Date().toISOString() });
    });

  const getOrRefreshTyped = <A, E>(
    key: string,
    schema: Schema.Schema<A>,
    maxAgeMs: number,
    refresh: Effect.Effect<A, E, never>,
  ) =>
    Effect.gen(function* () {
      const cached = yield* get(key, schema, maxAgeMs);
      if (cached !== undefined) return cached;
      const value = yield* refresh;
      yield* put(key, value);
      return value;
    });

  const getOrRefresh = <A>(
    key: string,
    schema: Schema.Schema<A>,
    maxAgeMs: number,
    refresh: Effect.Effect<A, unknown, never>,
  ) => getOrRefreshTyped(key, schema, maxAgeMs, refresh);

  return Layer.succeed(ApiCache, ApiCache.of({ get, put, getOrRefresh, getOrRefreshTyped }));
};
