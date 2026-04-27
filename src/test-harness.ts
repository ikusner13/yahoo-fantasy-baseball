import type { Env, Roster } from "./types";
import { YahooClient } from "./yahoo/client";
import { getValidToken } from "./yahoo/auth";
import { getTodaysGames, getInjuries } from "./data/mlb";
import { simulateDay, type SimulationResult } from "./simulation";
import { askLLM } from "./ai/llm";

interface TestResult {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  duration: number;
}

async function runTest(name: string, fn: () => Promise<string>): Promise<TestResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, status: "pass", detail, duration: Date.now() - start };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { name, status: "fail", detail: msg, duration: Date.now() - start };
  }
}

export async function runTestSuite(
  env: Env,
  _dryRun: boolean,
  targetDate?: string,
): Promise<Response> {
  const results: TestResult[] = [];
  const yahoo = new YahooClient(env);
  const today = targetDate ?? new Date().toISOString().slice(0, 10);

  // --- 1. Yahoo Auth ---
  results.push(
    await runTest("Yahoo Auth — get valid token", async () => {
      const token = await getValidToken(env);
      return `Token: ${token.slice(0, 12)}...${token.slice(-4)} (${token.length} chars)`;
    }),
  );

  // --- 2. Yahoo Roster ---
  let roster: Roster | null = null;
  results.push(
    await runTest("Yahoo Roster — fetch my team", async () => {
      roster = await yahoo.getRoster(today);
      const names = roster.entries.map((e) => `${e.player.name} [${e.currentPosition}]`);
      return `${roster.entries.length} players:\n${names.join("\n")}`;
    }),
  );

  // --- 3. Yahoo Matchup ---
  results.push(
    await runTest("Yahoo Matchup — fetch current", async () => {
      const matchup = await yahoo.getMatchup();
      const catInfo =
        matchup.categories.length > 0
          ? matchup.categories
              .map((c) => `${c.category}: ${c.myValue} vs ${c.opponentValue}`)
              .join(", ")
          : "no category data yet";
      return `Week ${matchup.week} vs ${matchup.opponentTeamName}. ${catInfo}`;
    }),
  );

  // --- 4. Yahoo Standings ---
  results.push(
    await runTest("Yahoo Standings — fetch league", async () => {
      const standings = await yahoo.getStandings();
      return `Got standings response (${JSON.stringify(standings).length} bytes)`;
    }),
  );

  // --- 5. Yahoo Free Agents ---
  results.push(
    await runTest("Yahoo Free Agents — top 10", async () => {
      const fas = await yahoo.getFreeAgents(undefined, 10);
      return `${fas.length} free agents: ${fas.map((p) => p.name).join(", ")}`;
    }),
  );

  // --- 6. MLB Games Today ---
  results.push(
    await runTest("MLB Stats API — today's games", async () => {
      const games = await getTodaysGames(today);
      const summary = games
        .slice(0, 5)
        .map((g) => {
          const hp = g.homeProbable?.name ?? "TBD";
          const ap = g.awayProbable?.name ?? "TBD";
          return `${g.awayTeam}@${g.homeTeam} (${ap} vs ${hp})`;
        })
        .join(", ");
      return `${games.length} games: ${summary}${games.length > 5 ? "..." : ""}`;
    }),
  );

  // --- 7. MLB Injuries ---
  results.push(
    await runTest("MLB Stats API — recent IL transactions", async () => {
      const injuries = await getInjuries();
      return `${injuries.length} recent IL moves${
        injuries.length > 0
          ? `: ${injuries
              .slice(0, 3)
              .map((i) => `${i.name} (${i.team})`)
              .join(", ")}...`
          : ""
      }`;
    }),
  );

  // --- 8. Full Simulation (comprehensive end-to-end) ---
  let simResult: SimulationResult | null = null;
  results.push(
    await runTest("Simulation — full day analysis (read-only)", async () => {
      simResult = await simulateDay(env, today);

      const catSummary = simResult.matchupState.categoryStates
        .map((c) => {
          const sign = c.margin >= 0 ? "+" : "";
          return `${c.category}: ${c.state} (${sign}${c.margin.toFixed(c.category === "ERA" || c.category === "WHIP" || c.category === "OBP" ? 3 : 0)})`;
        })
        .join(", ");

      const lines = [
        `Week ${simResult.matchupState.week} vs ${simResult.matchupState.opponent}, ${simResult.matchupState.daysRemaining} days left`,
        `Categories: ${catSummary}`,
        `Worthless: ${simResult.matchupState.worthlessCategories.join(", ") || "none"}`,
        `Streaming: ${simResult.matchupState.streamingDecision.reasoning}`,
        `IP: ${simResult.matchupState.ipStatus.currentIP.toFixed(1)} (${simResult.matchupState.ipStatus.above ? "above" : "below"} min)`,
        `Lineup: ${simResult.lineupDecisions.starters.length} starters, ${simResult.lineupDecisions.benched.length} benched`,
        `Top starters: ${simResult.lineupDecisions.starters
          .slice(0, 5)
          .map((s) => `${s.name} (${s.position}, ${s.score.toFixed(2)})`)
          .join(", ")}`,
        `Benched: ${simResult.lineupDecisions.benched.map((b) => `${b.name} (${b.reason})`).join(", ") || "none"}`,
        `Park boosts: ${simResult.lineupDecisions.parkFactors.length} players`,
        `Platoon matches: ${simResult.lineupDecisions.platoonMatches}`,
        `Streaks applied: ${simResult.lineupDecisions.streaksApplied}`,
        `Waiver recs: ${simResult.waiverRecommendations.length}`,
        `Streaming candidates: ${simResult.streamingCandidates.length}`,
      ];
      return lines.join("\n");
    }),
  );

  // --- 9. Player ID Mapping ---
  results.push(
    await runTest("Player ID Mapping — roster to projections", async () => {
      if (!simResult) throw new Error("Simulation not run");
      const pct = ((simResult.playerIdMatchCount / simResult.rosterSize) * 100).toFixed(0);
      return `${simResult.playerIdMatchCount}/${simResult.rosterSize} roster players matched to FanGraphs (${pct}%)`;
    }),
  );

  // --- 10. Matchup Categories Parsed ---
  results.push(
    await runTest("Matchup Categories — all 13 parsed", async () => {
      if (!simResult) throw new Error("Simulation not run");
      const count = simResult.matchupState.categoryStates.length;
      const cats = simResult.matchupState.categoryStates.map((c) => c.category).join(", ");
      if (count < 13) throw new Error(`Only ${count}/13 categories parsed: ${cats}`);
      return `All ${count} categories: ${cats}`;
    }),
  );

  // --- 11. Detailed Analysis Produced ---
  results.push(
    await runTest("Detailed Analysis — worthless cats + streaming decision", async () => {
      if (!simResult) throw new Error("Simulation not run");
      const worthless = simResult.matchupState.worthlessCategories;
      const stream = simResult.matchupState.streamingDecision;
      return `Worthless categories: ${worthless.length > 0 ? worthless.join(", ") : "none (all in play)"}. Streaming: ${stream.canStream ? "yes" : "no"} (floor: ${stream.qualityFloor}). ${stream.reasoning}`;
    }),
  );

  // --- 12. LLM Briefing Formatting ---
  results.push(
    await runTest("LLM Briefing — non-empty with expected sections", async () => {
      if (!simResult) throw new Error("Simulation not run");
      const briefing = simResult.llmBriefing;
      if (!briefing) throw new Error("No LLM briefing generated");
      if (briefing.length < 100) throw new Error(`Briefing too short (${briefing.length} chars)`);

      const expectedSections = ["WORTHLESS", "STREAMING", "IP STATUS"];
      const missing = expectedSections.filter((s) => !briefing.includes(s));
      if (missing.length > 0) throw new Error(`Missing sections: ${missing.join(", ")}`);

      return `Briefing: ${briefing.length} chars, all expected sections present`;
    }),
  );

  // --- 13. LLM API Call ---
  results.push(
    await runTest("LLM API — OpenRouter connectivity", async () => {
      if (!env.OPENROUTER_API_KEY && !env.ANTHROPIC_API_KEY) {
        throw new Error("No LLM API key configured");
      }
      const response = await askLLM(env, "You are a test bot.", "Say 'OK' and nothing else.");
      if (response.includes("LLM unavailable")) {
        throw new Error(`LLM call failed: ${response}`);
      }
      return `LLM responded: "${response.slice(0, 50)}${response.length > 50 ? "..." : ""}"`;
    }),
  );

  results.push({
    name: "YAHOO WRITES — unsupported",
    status: "skip",
    detail: "Skipped. This deployment is read-only and lineup or transaction changes must be applied manually in Yahoo.",
    duration: 0,
  });

  // --- Format response ---
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  const lines = [
    `FANTASY BASEBALL GM — TEST SUITE`,
    `================================`,
    `${passed} passed, ${failed} failed, ${skipped} skipped`,
    `Mode: READ-ONLY ADVISOR`,
    ``,
    ...results.map((r) => {
      const icon = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
      return `[${icon}] ${r.name} (${r.duration}ms)\n       ${r.detail}\n`;
    }),
  ];

  return new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain" },
  });
}
