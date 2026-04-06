import type { Env, YahooTokens } from "../types";

const AUTH_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";

/** Buffer before expiry to trigger refresh (60s) */
const EXPIRY_BUFFER_MS = 60_000;
const KV_KEY = "yahoo-tokens";

async function readTokens(env: Env): Promise<YahooTokens | null> {
  try {
    return await env.KV.get<YahooTokens>(KV_KEY, "json");
  } catch {
    return null;
  }
}

async function writeTokens(env: Env, tokens: YahooTokens): Promise<void> {
  await env.KV.put(KV_KEY, JSON.stringify(tokens));
}

function basicAuthHeader(env: Env): string {
  return "Basic " + btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`);
}

/** Build the Yahoo OAuth authorization URL for the user to visit. */
export function getAuthUrl(env: Env, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: env.YAHOO_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

/** Exchange an authorization code for tokens, store to KV. */
export async function handleCallback(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<YahooTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Yahoo token exchange failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens: YahooTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await writeTokens(env, tokens);
  return tokens;
}

/** Refresh expired tokens, store new ones to KV. */
export async function refreshTokens(env: Env, refreshToken: string): Promise<YahooTokens> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Yahoo token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  const tokens: YahooTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  await writeTokens(env, tokens);
  return tokens;
}

/** Get a valid access token, refreshing if needed. */
export async function getValidToken(env: Env): Promise<string> {
  const tokens = await readTokens(env);
  if (!tokens) {
    throw new Error("No Yahoo tokens found — complete OAuth flow first");
  }

  let current = tokens;
  if (Date.now() >= current.expiresAt - EXPIRY_BUFFER_MS) {
    current = await refreshTokens(env, current.refreshToken);
  }

  return current.accessToken;
}
