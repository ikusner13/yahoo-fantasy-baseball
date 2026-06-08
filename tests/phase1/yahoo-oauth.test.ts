import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";

import {
  makeYahooOAuth,
  memoryYahooTokenStore,
  YahooStoredTokens,
} from "../../src/services/YahooOAuth";

const config = {
  clientId: "client-id",
  clientSecret: "client-secret",
  initialRefreshToken: "initial-refresh",
};

const httpClient = (body: unknown, status = 200): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );

describe("YahooOAuth", () => {
  it("requests Fantasy Sports read/write scope when building the authorization URL", () => {
    const oauth = makeYahooOAuth(config, memoryYahooTokenStore(), httpClient({}));
    const url = new URL(oauth.authorizationUrl("https://example.test/callback"));

    expect(url.searchParams.get("scope")).toBe("fspt-w");
  });

  it("can include admin state in the authorization URL", () => {
    const oauth = makeYahooOAuth(config, memoryYahooTokenStore(), httpClient({}));
    const url = new URL(
      oauth.authorizationUrlWithState("https://example.test/callback", "admin-state"),
    );

    expect(url.searchParams.get("state")).toBe("admin-state");
  });

  it.effect("returns a stored access token when it has not expired", () =>
    Effect.gen(function* () {
      const store = memoryYahooTokenStore(
        new YahooStoredTokens({
          accessToken: "stored-access",
          refreshToken: "stored-refresh",
          expiresAt: Date.now() + 3_600_000,
        }),
      );
      const oauth = makeYahooOAuth(config, store, httpClient({}));

      const accessToken = yield* oauth.getAccessToken;

      expect(accessToken).toBe("stored-access");
    }),
  );

  it.effect("refreshes expired tokens and persists the replacement", () =>
    Effect.gen(function* () {
      const store = memoryYahooTokenStore(
        new YahooStoredTokens({
          accessToken: "old-access",
          refreshToken: "stored-refresh",
          expiresAt: Date.now() - 1,
        }),
      );
      const oauth = makeYahooOAuth(
        config,
        store,
        httpClient({
          access_token: "new-access",
          expires_in: 3600,
          token_type: "bearer",
        }),
      );

      const accessToken = yield* oauth.getAccessToken;
      const stored = yield* store.get;

      expect(accessToken).toBe("new-access");
      expect(stored).toMatchObject({
        accessToken: "new-access",
        refreshToken: "stored-refresh",
      });
    }),
  );

  it.effect("fails with a typed error when Yahoo returns an invalid token shape", () =>
    Effect.gen(function* () {
      const oauth = makeYahooOAuth(
        config,
        memoryYahooTokenStore(),
        httpClient({ access_token: "missing-expiry" }),
      );

      const exit = yield* Effect.exit(oauth.refresh("refresh-token"));

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("YahooOAuthError");
      }
    }),
  );

  it.effect("fails when no refresh token is available", () =>
    Effect.gen(function* () {
      const oauth = makeYahooOAuth(
        { clientId: "client-id", clientSecret: "client-secret" },
        memoryYahooTokenStore(),
        httpClient({}),
      );

      const exit = yield* Effect.exit(oauth.getAccessToken);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(String(exit.cause)).toContain("YahooOAuthError");
      }
    }),
  );
});
