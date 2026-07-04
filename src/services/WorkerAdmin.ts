import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as schema from "../db/schema.ts";
import { Db, type AppDatabase } from "./Db.ts";
import { YahooOAuth, YahooOAuthError, type YahooStoredTokens } from "./YahooOAuth.ts";

export type D1ProxyMethod = "run" | "all" | "get" | "values";

export type D1ProxyQuery = {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly method: D1ProxyMethod;
};

export type D1ProxySingleRequest = D1ProxyQuery;
export type D1ProxyBatchRequest = {
  readonly queries: ReadonlyArray<D1ProxyQuery>;
};
export type D1ProxyResult = { readonly rows: ReadonlyArray<unknown> };
export type D1ProxyBatchResponse = { readonly results: ReadonlyArray<D1ProxyResult> };

export class WorkerAdminError extends Data.TaggedError("WorkerAdminError")<{
  readonly message: string;
  readonly status?: number;
}> {}

export const workerBaseUrlFromEnv = () =>
  process.env["WORKER_BASE_URL"] ??
  process.env["FANTASY_GM_WORKER_URL"] ??
  "https://fantasygm-fantasygmworker-prod-cbbdqptg2afhvv5l.ikusner13.workers.dev";

const requireWorkerEnv = (name: string) =>
  Effect.sync(() => {
    const value = process.env[name];
    if (value == null || value === "") {
      throw new WorkerAdminError({ message: `${name} is required` });
    }
    return value;
  });

const adminUrl = (baseUrl: string, path: string, token: string) => {
  const url = new URL(path, baseUrl.replace(/\/$/, ""));
  url.searchParams.set("token", token);
  return url;
};

const parseJsonResponse = <A>(response: Response): Effect.Effect<A, WorkerAdminError> =>
  Effect.tryPromise({
    try: async () => {
      const text = await response.text();
      if (!response.ok) {
        throw new WorkerAdminError({
          message: `${response.status} ${response.statusText}: ${text}`,
          status: response.status,
        });
      }
      return JSON.parse(text) as A;
    },
    catch: (error) =>
      error instanceof WorkerAdminError
        ? error
        : new WorkerAdminError({ message: error instanceof Error ? error.message : String(error) }),
  });

export const postD1ProxyQuery = (
  endpoint: string,
  body: D1ProxySingleRequest | D1ProxyBatchRequest,
): Effect.Effect<D1ProxyResult | D1ProxyBatchResponse, WorkerAdminError> =>
  Effect.tryPromise({
    try: () =>
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    catch: (error) =>
      new WorkerAdminError({ message: error instanceof Error ? error.message : String(error) }),
  }).pipe(Effect.flatMap(parseJsonResponse<D1ProxyResult | D1ProxyBatchResponse>));

export const sqliteProxyCallback =
  (endpoint: string) =>
  (sql: string, params: unknown[], method: D1ProxyMethod): Promise<{ rows: unknown }> =>
    Effect.runPromise(
      postD1ProxyQuery(endpoint, { sql, params, method }).pipe(
        Effect.flatMap((result) =>
          "results" in result
            ? Effect.fail(new WorkerAdminError({ message: "Unexpected batch response" }))
            : Effect.succeed({ rows: method === "get" ? result.rows[0] : [...result.rows] }),
        ),
      ),
    );

export const sqliteProxyBatchCallback =
  (endpoint: string) =>
  (queries: ReadonlyArray<D1ProxyQuery>): Promise<ReadonlyArray<{ rows: unknown }>> =>
    Effect.runPromise(
      postD1ProxyQuery(endpoint, { queries }).pipe(
        Effect.flatMap((result) =>
          "results" in result
            ? Effect.succeed(
                result.results.map((entry, index) => ({
                  rows: queries[index]?.method === "get" ? entry.rows[0] : entry.rows,
                })),
              )
            : Effect.fail(new WorkerAdminError({ message: "Unexpected single-query response" })),
        ),
      ),
    );

export const dbNodeLayerFromEndpoint = (endpoint: string) =>
  Layer.succeed(
    Db,
    Db.of({
      d1: undefined as never,
      drizzle: Effect.succeed(
        drizzleSqliteProxy(
          sqliteProxyCallback(endpoint) as never,
          sqliteProxyBatchCallback(endpoint) as never,
          { schema },
        ) as unknown as AppDatabase,
      ),
    }),
  );

export const DbNode = Layer.effect(
  Db,
  Effect.gen(function* () {
    const token = yield* requireWorkerEnv("ADMIN_TRIGGER_TOKEN");
    const endpoint = adminUrl(workerBaseUrlFromEnv(), "/admin/d1/query", token).toString();
    return Db.of({
      d1: undefined as never,
      drizzle: Effect.succeed(
        drizzleSqliteProxy(
          sqliteProxyCallback(endpoint) as never,
          sqliteProxyBatchCallback(endpoint) as never,
          { schema },
        ) as unknown as AppDatabase,
      ),
    });
  }),
);

const makeRemoteYahooOAuth = (endpoint: string): Context.Service.Shape<typeof YahooOAuth> => ({
  authorizationUrl: () => {
    throw new YahooOAuthError({
      message: "Yahoo OAuth authorizationUrl is not available in CLI; worker holds token custody",
    });
  },
  authorizationUrlWithState: () => {
    throw new YahooOAuthError({
      message:
        "Yahoo OAuth authorizationUrlWithState is not available in CLI; worker holds token custody",
    });
  },
  exchangeAuthorizationCode: () =>
    Effect.fail(
      new YahooOAuthError({
        message:
          "Yahoo OAuth exchangeAuthorizationCode is not available in CLI; worker holds token custody",
      }),
    ),
  refresh: () =>
    Effect.fail(
      new YahooOAuthError({
        message: "Yahoo OAuth refresh is not available in CLI; worker holds token custody",
      }),
    ),
  getAccessToken: remoteAccessToken(endpoint),
});

export const remoteYahooOAuthLayerFromEndpoint = (endpoint: string) =>
  Layer.succeed(YahooOAuth, YahooOAuth.of(makeRemoteYahooOAuth(endpoint)));

const remoteAccessToken = (endpoint: string): Effect.Effect<string, YahooOAuthError> => {
  let cached: { token: string; expiresAt: number } | undefined;
  return Effect.gen(function* () {
    if (cached != null && Date.now() < cached.expiresAt) return cached.token;
    const payload = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(endpoint);
        const text = await response.text();
        if (!response.ok) {
          throw new YahooOAuthError({
            message: `${response.status} ${response.statusText}: ${text}`,
            status: response.status,
          });
        }
        return JSON.parse(text) as { accessToken?: unknown };
      },
      catch: (error) =>
        error instanceof YahooOAuthError
          ? error
          : new YahooOAuthError({
              message: error instanceof Error ? error.message : String(error),
            }),
    });
    if (typeof payload.accessToken !== "string" || payload.accessToken === "") {
      return yield* Effect.fail(
        new YahooOAuthError({ message: "Worker did not return a Yahoo access token" }),
      );
    }
    cached = { token: payload.accessToken, expiresAt: Date.now() + 50 * 60 * 1000 };
    return payload.accessToken;
  });
};

export const YahooOAuthRemote = Layer.effect(
  YahooOAuth,
  Effect.gen(function* () {
    const token = yield* requireWorkerEnv("ADMIN_TRIGGER_TOKEN");
    const endpoint = adminUrl(
      workerBaseUrlFromEnv(),
      "/admin/yahoo/access-token",
      token,
    ).toString();
    return YahooOAuth.of(makeRemoteYahooOAuth(endpoint));
  }),
);

export type { YahooStoredTokens };
