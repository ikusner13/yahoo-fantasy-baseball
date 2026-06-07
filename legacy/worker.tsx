import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import type { Env } from "./types";
import { handleTelegramWebhook } from "./notifications/telegram";
import { getAuthUrl, handleCallback } from "./yahoo/auth";
import { runTestSuite } from "./test-harness";
import { dispatchCron } from "./cron";
import {
  runDailyMorning,
  runLateScratchCheck,
  runWeeklyMatchupAnalysis,
  runMidWeekAdjustment,
  runTradeEvaluation,
  runNewsMonitor,
  runSundayTactics,
  runTwoStartPreview,
} from "./gm";
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

// --- Manual routine triggers ---

const ROUTINES: Record<string, (env: Env) => Promise<void>> = {
  daily: runDailyMorning,
  "late-scratch": runLateScratchCheck,
  matchup: runWeeklyMatchupAnalysis,
  midweek: runMidWeekAdjustment,
  trade: runTradeEvaluation,
  news: runNewsMonitor,
  sunday: runSundayTactics,
  "two-start": runTwoStartPreview,
};

// GET /run/:routine — run a routine for real (sends to Telegram)
app.get("/run/:routine", async (c) => {
  const name = c.req.param("routine");
  const fn = ROUTINES[name];
  if (!fn) {
    const available = Object.keys(ROUTINES).join(", ");
    return c.text(`Unknown routine "${name}". Available: ${available}`, 400);
  }
  const env = buildAppEnv(c.env);
  const start = Date.now();
  try {
    await fn(env);
    return c.text(`${name}: completed in ${Date.now() - start}ms (messages sent to Telegram)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.text(`${name}: FAILED in ${Date.now() - start}ms\n${msg}`, 500);
  }
});

// GET /preview/:routine — run a routine but capture messages instead of sending
app.get("/preview/:routine", async (c) => {
  const name = c.req.param("routine");
  const fn = ROUTINES[name];
  if (!fn) {
    const available = Object.keys(ROUTINES).join(", ");
    return c.text(`Unknown routine "${name}". Available: ${available}`, 400);
  }
  const env = buildAppEnv(c.env);
  env._messageBuffer = [];
  const start = Date.now();
  try {
    await fn(env);
    const elapsed = Date.now() - start;
    const messages = env._messageBuffer;
    const header = `=== PREVIEW: ${name} (${elapsed}ms, ${messages.length} messages) ===\n`;
    const body =
      messages.length > 0
        ? messages.map((m, i) => `--- Message ${i + 1} ---\n${m}`).join("\n\n")
        : "(no messages produced)";
    return c.text(header + "\n" + body);
  } catch (e) {
    const elapsed = Date.now() - start;
    const msg = e instanceof Error ? e.message : String(e);
    const captured = env._messageBuffer;
    const header = `=== PREVIEW: ${name} FAILED (${elapsed}ms) ===\nError: ${msg}\n`;
    const body =
      captured.length > 0
        ? "\nMessages captured before failure:\n" +
          captured.map((m, i) => `--- Message ${i + 1} ---\n${m}`).join("\n\n")
        : "";
    return c.text(header + body, 500);
  }
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
