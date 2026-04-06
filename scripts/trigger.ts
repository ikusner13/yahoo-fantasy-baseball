/**
 * Manual trigger for any GM routine. Use to test without waiting for cron.
 *
 * Usage:
 *   npx tsx scripts/trigger.ts morning          # daily morning routine
 *   npx tsx scripts/trigger.ts matchup          # weekly matchup analysis (Mon)
 *   npx tsx scripts/trigger.ts midweek          # mid-week adjustment (Wed)
 *   npx tsx scripts/trigger.ts sunday           # Sunday tactical analysis
 *   npx tsx scripts/trigger.ts trade            # trade evaluation (Sat)
 *   npx tsx scripts/trigger.ts twostart         # two-start SP preview (Fri)
 *   npx tsx scripts/trigger.ts news             # news monitor
 *   npx tsx scripts/trigger.ts scratch          # late scratch check
 *   npx tsx scripts/trigger.ts simulate [date]  # dry-run simulation (no writes)
 *   npx tsx scripts/trigger.ts test             # run test harness
 */

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  runDailyMorning,
  runLateScratchCheck,
  runWeeklyMatchupAnalysis,
  runMidWeekAdjustment,
  runTradeEvaluation,
  runNewsMonitor,
  runSundayTactics,
  runTwoStartPreview,
} from "../src/gm";
import { simulateDay } from "../src/simulation";
import { runTestSuite } from "../src/test-harness";
import type { Env } from "../src/types";

function loadConfig(): Record<string, string> {
  const cfgPath = join(process.cwd(), "config.json");
  if (existsSync(cfgPath)) return JSON.parse(readFileSync(cfgPath, "utf-8"));
  return {};
}

const cfg = loadConfig();
const DATA_DIR = cfg.DATA_DIR ?? process.env.DATA_DIR ?? "./data";
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const dbPath = join(DATA_DIR, "fantasy.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const schemaPath = join(process.cwd(), "db", "schema.sql");
if (existsSync(schemaPath)) db.exec(readFileSync(schemaPath, "utf-8"));

const env: Env = {
  db,
  DATA_DIR,
  YAHOO_CLIENT_ID: cfg.YAHOO_CLIENT_ID ?? process.env.YAHOO_CLIENT_ID ?? "",
  YAHOO_CLIENT_SECRET: cfg.YAHOO_CLIENT_SECRET ?? process.env.YAHOO_CLIENT_SECRET ?? "",
  TELEGRAM_BOT_TOKEN: cfg.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? "",
  YAHOO_LEAGUE_ID: cfg.YAHOO_LEAGUE_ID ?? process.env.YAHOO_LEAGUE_ID ?? "",
  YAHOO_TEAM_ID: cfg.YAHOO_TEAM_ID ?? process.env.YAHOO_TEAM_ID ?? "",
  TELEGRAM_CHAT_ID: cfg.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_CHAT_ID ?? "",
  ANTHROPIC_API_KEY: cfg.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: cfg.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  OPENROUTER_API_KEY: cfg.OPENROUTER_API_KEY ?? process.env.OPENROUTER_API_KEY,
};

const command = process.argv[2];
const arg = process.argv[3];

async function main() {
  const start = Date.now();
  console.log(`[trigger] Running: ${command ?? "help"}`);

  switch (command) {
    case "morning":
      await runDailyMorning(env);
      break;
    case "matchup":
      await runWeeklyMatchupAnalysis(env);
      break;
    case "midweek":
      await runMidWeekAdjustment(env);
      break;
    case "sunday":
      await runSundayTactics(env);
      break;
    case "trade":
      await runTradeEvaluation(env);
      break;
    case "twostart":
      await runTwoStartPreview(env);
      break;
    case "news":
      await runNewsMonitor(env);
      break;
    case "scratch":
      await runLateScratchCheck(env);
      break;
    case "simulate": {
      const date = arg ?? new Date().toISOString().slice(0, 10);
      console.log(`[simulate] Date: ${date}`);
      const result = await simulateDay(env, date);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case "test": {
      const res = await runTestSuite(env, true);
      console.log(await res.text());
      break;
    }
    default:
      console.log(`
Usage: npx tsx scripts/trigger.ts <command>

Commands:
  morning    Daily morning routine (lineup, waivers, streaming, IL)
  matchup    Weekly matchup analysis (runs retrospective first)
  midweek    Mid-week adjustment
  sunday     Sunday tactical analysis (last-day sit/start)
  trade      Trade evaluation
  twostart   Two-start SP preview
  news       News monitor
  scratch    Late scratch check
  simulate   Dry-run simulation (no writes) [optional: date YYYY-MM-DD]
  test       Run test harness (read-only)
`);
      process.exit(1);
  }

  console.log(`[trigger] Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  db.close();
}

main().catch((e) => {
  console.error("[trigger] Fatal:", e);
  db.close();
  process.exit(1);
});
