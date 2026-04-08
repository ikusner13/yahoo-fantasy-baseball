import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { Env } from "./types";
import { handleTelegramWebhook } from "./notifications/telegram";
import { getAuthUrl, handleCallback } from "./yahoo/auth";
import { runTestSuite } from "./test-harness";
import { dispatchCron } from "./cron";
import { useWorkersLogger } from "workers-tagged-logger";

// Cloudflare bindings (raw, before we wrap into our Env)
type CloudflareBindings = {
  DB: D1Database;
  KV: KVNamespace;
  YAHOO_CLIENT_ID: string;
  YAHOO_CLIENT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  YAHOO_LEAGUE_ID: string;
  YAHOO_TEAM_ID: string;
  TELEGRAM_CHAT_ID: string;
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ODDS_API_KEY?: string;
};

function buildAppEnv(cfEnv: CloudflareBindings): Env {
  return {
    db: drizzle(cfEnv.DB, { schema }),
    KV: cfEnv.KV,
    YAHOO_CLIENT_ID: cfEnv.YAHOO_CLIENT_ID,
    YAHOO_CLIENT_SECRET: cfEnv.YAHOO_CLIENT_SECRET,
    TELEGRAM_BOT_TOKEN: cfEnv.TELEGRAM_BOT_TOKEN,
    YAHOO_LEAGUE_ID: cfEnv.YAHOO_LEAGUE_ID,
    YAHOO_TEAM_ID: cfEnv.YAHOO_TEAM_ID,
    TELEGRAM_CHAT_ID: cfEnv.TELEGRAM_CHAT_ID,
    ANTHROPIC_API_KEY: cfEnv.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: cfEnv.OPENAI_API_KEY,
    OPENROUTER_API_KEY: cfEnv.OPENROUTER_API_KEY,
    ODDS_API_KEY: cfEnv.ODDS_API_KEY,
  };
}

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("*", useWorkersLogger("fantasy-gm"));

// GET /auth — redirect to Yahoo OAuth (oob flow)
app.get("/auth", (c) => {
  const env = buildAppEnv(c.env);
  const authUrl = getAuthUrl(env, "oob");
  return c.redirect(authUrl, 302);
});

// GET /auth/callback?code=... — exchange code for tokens
app.get("/auth/callback", async (c) => {
  const env = buildAppEnv(c.env);
  const code = c.req.query("code");
  if (!code) {
    return c.html(
      <html>
        <body>
          <h2>Paste your Yahoo auth code</h2>
          <form method="get" action="/auth/callback">
            <input name="code" size={40} placeholder="Paste code here" autofocus />
            <button type="submit">Submit</button>
          </form>
        </body>
      </html>,
    );
  }
  try {
    await handleCallback(env, code, "oob");
    return c.text("Yahoo OAuth connected successfully!");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return c.text(`OAuth error: ${msg}`, 500);
  }
});

// POST /telegram — incoming webhook from Telegram
app.post("/telegram", async (c) => {
  const env = buildAppEnv(c.env);
  return handleTelegramWebhook(c.req.raw, env);
});

// GET /test — run read-only test suite
app.get("/test", async (c) => {
  const env = buildAppEnv(c.env);
  const dryRun = c.req.query("apply") !== "1";
  const date = c.req.query("date") ?? undefined;
  return runTestSuite(env, dryRun, date);
});

// GET /health
app.get("/health", (c) => c.text("ok"));

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledEvent, cfEnv: CloudflareBindings, ctx: ExecutionContext) {
    const env = buildAppEnv(cfEnv);
    ctx.waitUntil(dispatchCron(env, event.cron));
  },
};
