import type { KVNamespaceClient } from "alchemy/Cloudflare";
import type { BaseRuntimeContext } from "alchemy";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";
const TOKEN_STORE_KEY = "yahoo-oauth-tokens";
const EXPIRY_BUFFER_MS = 60_000;
const FANTASY_READ_WRITE_SCOPE = "fspt-w";

export class YahooOAuthError extends Data.TaggedError("YahooOAuthError")<{
  readonly message: string;
  readonly status?: number;
}> {}

export class YahooOAuthTokenResponse extends Schema.Class<YahooOAuthTokenResponse>(
  "YahooOAuthTokenResponse",
)({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Finite,
  token_type: Schema.optional(Schema.String),
}) {}

export class YahooStoredTokens extends Schema.Class<YahooStoredTokens>("YahooStoredTokens")({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
}) {}

export interface YahooTokenStore {
  readonly get: Effect.Effect<YahooStoredTokens | null, YahooOAuthError>;
  readonly put: (tokens: YahooStoredTokens) => Effect.Effect<void, YahooOAuthError>;
}

export interface YahooOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string | Redacted.Redacted;
  readonly initialRefreshToken?: string;
}

const decodeStoredTokens = (value: unknown) =>
  Schema.decodeUnknownEffect(YahooStoredTokens)(value).pipe(
    Effect.mapError(
      (issue) =>
        new YahooOAuthError({
          message: `Stored Yahoo OAuth tokens did not match schema: ${String(issue)}`,
        }),
    ),
  );

const toStoredTokens = (
  response: YahooOAuthTokenResponse,
  fallbackRefreshToken?: string,
): Effect.Effect<YahooStoredTokens, YahooOAuthError> => {
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (refreshToken == null || refreshToken === "") {
    return Effect.fail(
      new YahooOAuthError({ message: "Yahoo OAuth response did not include a refresh token" }),
    );
  }

  return Effect.succeed(
    new YahooStoredTokens({
      accessToken: response.access_token,
      refreshToken,
      expiresAt: Date.now() + response.expires_in * 1000,
    }),
  );
};

const isUsable = (tokens: YahooStoredTokens) => Date.now() < tokens.expiresAt - EXPIRY_BUFFER_MS;

const tokenRequest = (
  httpClient: HttpClient.HttpClient,
  config: YahooOAuthConfig,
  body: Record<string, string>,
): Effect.Effect<YahooOAuthTokenResponse, YahooOAuthError> =>
  HttpClientRequest.post(TOKEN_URL).pipe(
    HttpClientRequest.basicAuth(config.clientId, config.clientSecret),
    HttpClientRequest.bodyUrlParams(body),
    httpClient.execute,
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? HttpClientResponse.schemaBodyJson(YahooOAuthTokenResponse)(response).pipe(
            Effect.mapError(
              (issue) =>
                new YahooOAuthError({
                  message: `Yahoo OAuth token response did not match schema: ${String(issue)}`,
                  status: response.status,
                }),
            ),
          )
        : response.text.pipe(
            Effect.flatMap((message) =>
              Effect.fail(new YahooOAuthError({ message, status: response.status })),
            ),
          ),
    ),
    Effect.mapError((cause) =>
      cause instanceof YahooOAuthError
        ? cause
        : new YahooOAuthError({
            message: cause instanceof Error ? cause.message : String(cause),
          }),
    ),
  );

export const kvYahooTokenStore = (
  kv: KVNamespaceClient,
  runtimeContext: BaseRuntimeContext,
): YahooTokenStore => {
  const runtimeContextTag = Effect.promise(() =>
    import("alchemy").then((alchemy) => alchemy.RuntimeContext),
  );
  return {
    get: Effect.gen(function* () {
      const tag = yield* runtimeContextTag;
      const tokens = yield* kv.get<unknown>(TOKEN_STORE_KEY, "json").pipe(
        Effect.provideService(tag, runtimeContext),
        Effect.mapError(
          (cause) =>
            new YahooOAuthError({
              message: `Failed to read Yahoo OAuth tokens: ${cause.message}`,
            }),
        ),
      );
      if (tokens == null) return null;
      return yield* decodeStoredTokens(tokens);
    }),
    put: (tokens) =>
      Effect.gen(function* () {
        const tag = yield* runtimeContextTag;
        yield* kv.put(TOKEN_STORE_KEY, JSON.stringify(tokens)).pipe(
          Effect.provideService(tag, runtimeContext),
          Effect.mapError(
            (cause) =>
              new YahooOAuthError({
                message: `Failed to write Yahoo OAuth tokens: ${cause.message}`,
              }),
          ),
        );
      }),
  };
};

export const memoryYahooTokenStore = (initial?: YahooStoredTokens): YahooTokenStore => {
  let current: YahooStoredTokens | null = initial ?? null;
  return {
    get: Effect.sync(() => current),
    put: (tokens) =>
      Effect.sync(() => {
        current = tokens;
      }),
  };
};

export class YahooOAuth extends Context.Service<
  YahooOAuth,
  {
    readonly authorizationUrl: (redirectUri: string) => string;
    readonly authorizationUrlWithState: (redirectUri: string, state: string) => string;
    readonly exchangeAuthorizationCode: (
      code: string,
      redirectUri: string,
    ) => Effect.Effect<YahooStoredTokens, YahooOAuthError>;
    readonly refresh: (refreshToken?: string) => Effect.Effect<YahooStoredTokens, YahooOAuthError>;
    readonly getAccessToken: Effect.Effect<string, YahooOAuthError>;
  }
>()("fantasy-gm/YahooOAuth") {
  static readonly layer = (tokenStore: YahooTokenStore) =>
    Layer.effect(
      YahooOAuth,
      Effect.gen(function* () {
        const httpClient = yield* HttpClient.HttpClient;
        const clientId = yield* Config.string("YAHOO_CLIENT_ID");
        const clientSecret = yield* Config.redacted("YAHOO_CLIENT_SECRET");
        const initialRefreshToken = yield* Config.redacted("YAHOO_REFRESH_TOKEN").pipe(
          Effect.map(Redacted.value),
          Effect.option,
          Effect.map((option) => (option._tag === "Some" ? option.value : undefined)),
        );

        return YahooOAuth.of(
          makeYahooOAuth({ clientId, clientSecret, initialRefreshToken }, tokenStore, httpClient),
        );
      }),
    );
}

export const makeYahooOAuth = (
  config: YahooOAuthConfig,
  tokenStore: YahooTokenStore,
  httpClient: HttpClient.HttpClient,
): Context.Service.Shape<typeof YahooOAuth> => {
  const persist = (tokens: YahooStoredTokens) => tokenStore.put(tokens).pipe(Effect.as(tokens));

  const authorizationUrlWithState = (redirectUri: string, state?: string) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: FANTASY_READ_WRITE_SCOPE,
    });
    if (state != null && state !== "") params.set("state", state);
    return `${AUTH_URL}?${params.toString()}`;
  };
  const authorizationUrl = (redirectUri: string) => authorizationUrlWithState(redirectUri);

  const exchangeAuthorizationCode = (code: string, redirectUri: string) =>
    tokenRequest(httpClient, config, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }).pipe(
      Effect.flatMap((response) => toStoredTokens(response)),
      Effect.flatMap(persist),
    );

  const refresh = (refreshToken?: string) => {
    const token = refreshToken ?? config.initialRefreshToken;
    if (token == null || token === "") {
      return Effect.fail(new YahooOAuthError({ message: "No Yahoo refresh token available" }));
    }

    return tokenRequest(httpClient, config, {
      grant_type: "refresh_token",
      refresh_token: token,
    }).pipe(
      Effect.flatMap((response) => toStoredTokens(response, token)),
      Effect.flatMap(persist),
    );
  };

  const getAccessToken = Effect.gen(function* () {
    const stored = yield* tokenStore.get;
    if (stored != null && isUsable(stored)) return stored.accessToken;

    const refreshToken = stored?.refreshToken ?? config.initialRefreshToken;
    const refreshed = yield* refresh(refreshToken);
    return refreshed.accessToken;
  });

  return {
    authorizationUrl,
    authorizationUrlWithState,
    exchangeAuthorizationCode,
    refresh,
    getAccessToken,
  };
};
