import { Hono } from "hono";
import { serve } from "@hono/node-server";
import cron from "node-cron";
import Database from "better-sqlite3";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./types";
import { handleTelegramWebhook } from "./notifications/telegram";
import { getAuthUrl, handleCallback } from "./yahoo/auth";
import { runTestSuite } from "./test-harness";
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(): Record<string, string> {
  // Try config.json first, then fall back to process.env
  const cfgPath = join(process.cwd(), "config.json");
  if (existsSync(cfgPath)) {
    return JSON.parse(readFileSync(cfgPath, "utf-8"));
  }
  return {};
}

function requireEnvVar(cfg: Record<string, string>, key: string): string {
  const val = cfg[key] ?? process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const cfg = loadConfig();

const DATA_DIR = cfg.DATA_DIR ?? process.env.DATA_DIR ?? "./data";
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

// Init better-sqlite3
const dbPath = join(DATA_DIR, "fantasy.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

// Run schema migration
const schemaPath = join(process.cwd(), "db", "schema.sql");
if (existsSync(schemaPath)) {
  const schema = readFileSync(schemaPath, "utf-8");
  db.exec(schema);
}

const env: Env = {
  db,
  DATA_DIR,
  YAHOO_CLIENT_ID: requireEnvVar(cfg, "YAHOO_CLIENT_ID"),
  YAHOO_CLIENT_SECRET: requireEnvVar(cfg, "YAHOO_CLIENT_SECRET"),
  TELEGRAM_BOT_TOKEN: requireEnvVar(cfg, "TELEGRAM_BOT_TOKEN"),
  YAHOO_LEAGUE_ID: requireEnvVar(cfg, "YAHOO_LEAGUE_ID"),
  YAHOO_TEAM_ID: requireEnvVar(cfg, "YAHOO_TEAM_ID"),
  TELEGRAM_CHAT_ID: requireEnvVar(cfg, "TELEGRAM_CHAT_ID"),
  ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: cfg.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: cfg.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
};

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// GET /auth — redirect to Yahoo OAuth (oob flow)
app.get("/auth", (c) => {
  const authUrl = getAuthUrl(env, "oob");
  return c.redirect(authUrl, 302);
});

// GET /auth/callback?code=... — exchange code for tokens
app.get("/auth/callback", async (c) => {
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
  return handleTelegramWebhook(c.req.raw, env);
});

// GET /test — run read-only test suite
app.get("/test", (c) => {
  const dryRun = c.req.query("apply") !== "1";
  const date = c.req.query("date") ?? undefined;
  return runTestSuite(env, dryRun, date);
});

// GET /health
app.get("/health", (c) => c.text("ok"));

// ---------------------------------------------------------------------------
// Cron jobs
// ---------------------------------------------------------------------------

// 9am ET = 13:00 UTC
cron.schedule("0 13 * * *", () => {
  console.log(`[cron] runDailyMorning ${new Date().toISOString()}`);
  runDailyMorning(env).catch((e) => console.error("runDailyMorning failed:", e));
});

// 6pm ET = 22:00 UTC
cron.schedule("0 22 * * *", () => {
  console.log(`[cron] runLateScratchCheck ${new Date().toISOString()}`);
  runLateScratchCheck(env).catch((e) => console.error("runLateScratchCheck failed:", e));
});

// Monday 10am ET = 14:00 UTC
cron.schedule("0 14 * * 1", () => {
  console.log(`[cron] runWeeklyMatchupAnalysis ${new Date().toISOString()}`);
  runWeeklyMatchupAnalysis(env).catch((e) => console.error("runWeeklyMatchupAnalysis failed:", e));
});

// Wednesday 3pm ET = 19:00 UTC
cron.schedule("0 19 * * 3", () => {
  console.log(`[cron] runMidWeekAdjustment ${new Date().toISOString()}`);
  runMidWeekAdjustment(env).catch((e) => console.error("runMidWeekAdjustment failed:", e));
});

// Saturday 10am ET = 14:00 UTC
cron.schedule("0 14 * * 6", () => {
  console.log(`[cron] runTradeEvaluation ${new Date().toISOString()}`);
  runTradeEvaluation(env).catch((e) => console.error("runTradeEvaluation failed:", e));
});

// Sunday 10am ET = 14:00 UTC — final day matchup tactics
cron.schedule("0 14 * * 0", () => {
  console.log(`[cron] runSundayTactics ${new Date().toISOString()}`);
  runSundayTactics(env).catch((e) => console.error("runSundayTactics failed:", e));
});

// Friday 10am ET = 14:00 UTC — two-start SP preview for next week
cron.schedule("0 14 * * 5", () => {
  console.log(`[cron] runTwoStartPreview ${new Date().toISOString()}`);
  runTwoStartPreview(env).catch((e) => console.error("runTwoStartPreview failed:", e));
});

// News monitor — :15 and :45 past each hour during game hours (avoids 13:00 overlap w/ daily morning)
cron.schedule("15,45 13-23 * * *", () => {
  console.log(`[cron] runNewsMonitor ${new Date().toISOString()}`);
  runNewsMonitor(env).catch((e) => console.error("runNewsMonitor failed:", e));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const port = Number(cfg.PORT ?? process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Fantasy Baseball GM running on port ${port}`);
});
