#!/usr/bin/env npx tsx
/**
 * CLI backtest: replay the engine against a completed week.
 *
 * Usage:
 *   npx tsx scripts/simulate-week.ts                         # defaults: Week 2 (Mar 30 - Apr 5)
 *   npx tsx scripts/simulate-week.ts 2026-03-30 2026-04-05   # explicit date range
 */

import Database from "better-sqlite3";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "../src/types";
import { simulateDay, type SimulationResult } from "../src/simulation";

// --- Bootstrap env (mirrors index.tsx) ---

function loadConfig(): Record<string, string> {
  const cfgPath = join(process.cwd(), "config.json");
  if (existsSync(cfgPath)) return JSON.parse(readFileSync(cfgPath, "utf-8"));
  return {};
}

function requireEnvVar(cfg: Record<string, string>, key: string): string {
  const val = cfg[key] ?? process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function bootstrapEnv(): Env {
  // Load dotenv if present (sync require — tsx handles it)
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("dotenv").config();
  } catch {
    // dotenv not required if config.json exists
  }

  const cfg = loadConfig();
  const DATA_DIR = cfg.DATA_DIR ?? process.env.DATA_DIR ?? "./data";
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const dbPath = join(DATA_DIR, "fantasy.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  const schemaPath = join(process.cwd(), "db", "schema.sql");
  if (existsSync(schemaPath)) {
    db.exec(readFileSync(schemaPath, "utf-8"));
  }

  return {
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
}

// --- Date helpers ---

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function getDatesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  let current = start;
  while (current <= end) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

// --- Formatters ---

function formatCategoryState(
  states: SimulationResult["matchupState"]["categoryStates"],
): { clinched: string[]; swing: string[]; lost: string[]; safe: string[]; losing: string[] } {
  const clinched: string[] = [];
  const safe: string[] = [];
  const swing: string[] = [];
  const losing: string[] = [];
  const lost: string[] = [];

  for (const c of states) {
    const label = `${c.category} (${c.myValue}-${c.oppValue})`;
    switch (c.state) {
      case "clinched":
        clinched.push(label);
        break;
      case "safe":
        safe.push(label);
        break;
      case "swing":
        swing.push(label);
        break;
      case "losing":
        losing.push(label);
        break;
      case "lost":
        lost.push(label);
        break;
    }
  }
  return { clinched, safe, swing, losing, lost };
}

function printDaySummary(sim: SimulationResult): void {
  const cats = formatCategoryState(sim.matchupState.categoryStates);

  // Win/loss/tie count
  const winning = cats.clinched.length + cats.safe.length;
  const swingCount = cats.swing.length;
  const losingCount = cats.losing.length + cats.lost.length;

  console.log(
    `Matchup: ~${winning}-${losingCount}-${swingCount} (${sim.matchupState.daysRemaining} days left)`,
  );

  if (cats.clinched.length > 0) console.log(`  CLINCHED: ${cats.clinched.join(", ")}`);
  if (cats.safe.length > 0) console.log(`  SAFE: ${cats.safe.join(", ")}`);
  if (cats.swing.length > 0) console.log(`  SWING: ${cats.swing.join(", ")}`);
  if (cats.losing.length > 0) console.log(`  LOSING: ${cats.losing.join(", ")}`);
  if (cats.lost.length > 0) console.log(`  LOST: ${cats.lost.join(", ")}`);

  // Worthless categories
  if (sim.matchupState.worthlessCategories.length > 0) {
    console.log(
      `  WORTHLESS: ${sim.matchupState.worthlessCategories.join(", ")} (${sim.matchupState.worthlessCategories.length} categories decided)`,
    );
  }

  // Streaming decision
  const sd = sim.matchupState.streamingDecision;
  console.log(
    `Streaming: ${sd.canStream ? "ELIGIBLE" : "PROTECT"} — ${sd.reasoning} (floor: ${sd.qualityFloor})`,
  );

  // IP status
  const ip = sim.matchupState.ipStatus;
  console.log(
    `IP status: ${ip.currentIP.toFixed(1)} IP (${ip.above ? "above" : "below"} 20 min${ip.ipNeeded > 0 ? `, need ${ip.ipNeeded.toFixed(1)} more` : ""})`,
  );

  // Lineup
  console.log(
    `Lineup: ${sim.lineupDecisions.starters.length} starters, ${sim.lineupDecisions.benched.length} benched`,
  );
  if (sim.lineupDecisions.benched.length > 0) {
    console.log(
      `  Benched: ${sim.lineupDecisions.benched.map((b) => `${b.name} (${b.reason})`).join(", ")}`,
    );
  }
  if (sim.lineupDecisions.parkFactors.length > 0) {
    for (const pf of sim.lineupDecisions.parkFactors.slice(0, 3)) {
      const dir = pf.factor > 1.0 ? "+" : "";
      console.log(
        `  Park boost: ${pf.name} ${dir}${((pf.factor - 1) * 100).toFixed(0)}% (${pf.park})`,
      );
    }
  }
  if (sim.lineupDecisions.platoonMatches > 0) {
    console.log(`  Platoon: ${sim.lineupDecisions.platoonMatches} batters with split data`);
  }

  // Waivers
  if (sim.waiverRecommendations.length > 0) {
    console.log(`Waivers: ${sim.waiverRecommendations.length} recommendations`);
    for (const w of sim.waiverRecommendations.slice(0, 3)) {
      console.log(`  Add ${w.add}, drop ${w.drop} (+${w.netValue.toFixed(1)})`);
    }
  } else {
    console.log("Waivers: No action");
  }

  // Streaming candidates
  if (sim.streamingCandidates.length > 0) {
    const top = sim.streamingCandidates[0];
    console.log(
      `Top stream: ${top.name} vs ${top.opponent} (score: ${top.score.toFixed(1)}, helps ${top.netImpact.helped} cats, hurts ${top.netImpact.hurt})`,
    );
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const weekStart = args[0] ?? "2026-03-30";
  const weekEnd = args[1] ?? "2026-04-05";

  console.log(`\n=== WEEK SIMULATION: ${formatDate(weekStart)} - ${formatDate(weekEnd)} ===\n`);

  const env = bootstrapEnv();
  const dates = getDatesInRange(weekStart, weekEnd);
  const results: SimulationResult[] = [];

  for (const date of dates) {
    console.log(`--- ${formatDate(date)} ---`);
    try {
      const sim = await simulateDay(env, date);
      results.push(sim);
      printDaySummary(sim);
    } catch (e) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
    console.log("");
  }

  // --- Weekly Summary ---
  if (results.length === 0) {
    console.log("No simulation results to summarize.");
    return;
  }

  const final = results[results.length - 1];
  const cats = formatCategoryState(final.matchupState.categoryStates);
  const wins = cats.clinched.length + cats.safe.length;
  const losses = cats.losing.length + cats.lost.length;
  const ties = cats.swing.length;

  console.log("=== WEEKLY SUMMARY ===");
  console.log(
    `vs. ${final.matchupState.opponent} | Final categories: ${wins}W-${losses}L-${ties}T`,
  );
  console.log("");

  // Track how categories evolved over the week
  if (results.length > 1) {
    const first = results[0];
    const firstCats = new Map(
      first.matchupState.categoryStates.map((c) => [c.category, c]),
    );
    const finalCats = new Map(
      final.matchupState.categoryStates.map((c) => [c.category, c]),
    );

    const flipped: string[] = [];
    const couldHaveFlipped: string[] = [];
    const correctlyLost: string[] = [];

    for (const [cat, finalState] of finalCats) {
      const firstState = firstCats.get(cat);
      if (!firstState) continue;

      const wasSwing = firstState.state === "swing";
      const wasLosing = firstState.state === "losing";
      const isNowWinning =
        finalState.state === "clinched" || finalState.state === "safe";
      const isNowLost =
        finalState.state === "lost" || finalState.state === "losing";
      const isSwing = finalState.state === "swing";

      if ((wasSwing || wasLosing) && isNowWinning) {
        flipped.push(cat);
      } else if (isSwing && Math.abs(finalState.margin) <= 2) {
        couldHaveFlipped.push(`${cat} (margin: ${finalState.margin >= 0 ? "+" : ""}${finalState.margin.toFixed(0)})`);
      } else if (isNowLost && (wasSwing || wasLosing)) {
        correctlyLost.push(cat);
      }
    }

    if (flipped.length > 0) {
      console.log(`Categories that flipped during the week: ${flipped.join(", ")}`);
    }
    if (couldHaveFlipped.length > 0) {
      console.log(`Close calls (could have been flipped): ${couldHaveFlipped.join(", ")}`);
    }
    if (correctlyLost.length > 0) {
      console.log(`Categories correctly identified as lost: ${correctlyLost.join(", ")}`);
    }
  }

  // Aggregated recommendations
  const totalWaiverRecs = results.reduce(
    (sum, r) => sum + r.waiverRecommendations.length,
    0,
  );
  const totalStreamCandidates = results.reduce(
    (sum, r) => sum + r.streamingCandidates.length,
    0,
  );
  console.log(
    `\nTotal waiver recommendations: ${totalWaiverRecs}`,
  );
  console.log(
    `Total streaming candidates evaluated: ${totalStreamCandidates}`,
  );

  // Player ID match quality
  console.log(
    `Player ID matching: ${final.playerIdMatchCount}/${final.rosterSize} players matched`,
  );

  env.db.close();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
