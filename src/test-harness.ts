import type { Env, PlayerProjection, Roster } from "./types";
import { YahooClient } from "./yahoo/client";
import { getValidToken } from "./yahoo/auth";
import { setLineupViaBrowser } from "./yahoo/browser";
import { getTodaysGames, getInjuries } from "./data/mlb";
import { fetchBatterProjections, fetchPitcherProjections } from "./data/projections";
import { computeZScores } from "./analysis/valuations";
import { optimizeLineup } from "./analysis/lineup";
import { analyzeMatchup } from "./analysis/matchup";
import { getILMoves } from "./analysis/il-manager";

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
  dryRun: boolean,
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

  // --- 8. FanGraphs Projections ---
  let projMap: Map<string, PlayerProjection> | null = null;
  results.push(
    await runTest("FanGraphs — batter + pitcher projections", async () => {
      const [batters, pitchers] = await Promise.all([
        fetchBatterProjections(),
        fetchPitcherProjections(),
      ]);

      projMap = new Map<string, PlayerProjection>();
      for (const b of batters) {
        projMap.set(`fg:${b.fangraphsId}`, {
          yahooId: `fg:${b.fangraphsId}`,
          playerType: "batter",
          batting: {
            pa: b.pa,
            r: b.r,
            h: b.h,
            hr: b.hr,
            rbi: b.rbi,
            sb: b.sb,
            tb: b.tb,
            obp: b.obp,
          },
          updatedAt: new Date().toISOString(),
        });
      }
      for (const p of pitchers) {
        projMap.set(`fg:${p.fangraphsId}`, {
          yahooId: `fg:${p.fangraphsId}`,
          playerType: "pitcher",
          pitching: {
            ip: p.ip,
            outs: Math.round(p.ip * 3),
            k: p.k,
            era: p.era,
            whip: p.whip,
            qs: p.qs,
            svhd: p.svhd,
          },
          updatedAt: new Date().toISOString(),
        });
      }

      return `${batters.length} batters, ${pitchers.length} pitchers. Top batter: ${batters[0]?.name}. Top pitcher: ${pitchers[0]?.name}`;
    }),
  );

  // --- 9. Z-Score Valuations ---
  results.push(
    await runTest("Valuations — compute z-scores", async () => {
      if (!projMap) throw new Error("No projections loaded");
      const projArr = Array.from(projMap.values());
      const vals = computeZScores(projArr);
      const top5 = vals.slice(0, 5).map((v) => `${v.yahooId} (z=${v.totalZScore.toFixed(2)})`);
      return `${vals.length} players valued. Top 5: ${top5.join(", ")}`;
    }),
  );

  // --- 10. Lineup Optimizer (dry run) ---
  results.push(
    await runTest("Lineup Optimizer — generate moves (DRY RUN)", async () => {
      if (!roster || !projMap) throw new Error("No roster or projections");
      const games = await getTodaysGames(today);
      const moves = optimizeLineup(roster, projMap, games);
      const summary = moves
        .filter((m) => m.position !== "BN")
        .map((m) => `${m.playerId} → ${m.position}`)
        .join("\n");
      return `${moves.length} moves generated:\n${summary}`;
    }),
  );

  // --- 11. Matchup Analysis ---
  results.push(
    await runTest("Matchup Analysis — strategy recommendation", async () => {
      const matchup = await yahoo.getMatchup();
      if (matchup.categories.length === 0) {
        return "No category data yet (season may not have started)";
      }
      const analysis = analyzeMatchup(matchup);
      return `Projected: ${analysis.projectedWins}W-${analysis.projectedLosses}L. Swing: ${analysis.swingCategories.join(",")}. ${analysis.strategy.benchMessage}`;
    }),
  );

  // --- 12. IL Manager ---
  results.push(
    await runTest("IL Manager — check moves needed", async () => {
      if (!roster) throw new Error("No roster");
      const ilMoves = getILMoves(roster);
      if (ilMoves.length === 0) return "No IL moves needed";
      return ilMoves.map((m) => m.reasoning).join("; ");
    }),
  );

  // --- 13. Set Lineup (only if ?apply=1) ---
  if (!dryRun && roster && projMap) {
    results.push(
      await runTest("SET LINEUP — apply via browser (LIVE)", async () => {
        const games = await getTodaysGames(today);
        const moves = optimizeLineup(roster!, projMap!, games);
        // Try API first, fall back to browser automation
        try {
          await yahoo.setLineup(today, moves);
          return `Applied ${moves.length} lineup moves via API for ${today}`;
        } catch {
          const result = await setLineupViaBrowser(env, today, moves);
          const debugInfo = result.debug ? `\n${result.debug}` : "";
          if (!result.success) throw new Error(`${result.message}${debugInfo}`);
          return `${result.message} (via browser)${debugInfo}`;
        }
      }),
    );
  } else {
    results.push({
      name: "SET LINEUP — apply to Yahoo",
      status: "skip",
      detail: "Skipped (dry run). Use /test?apply=1 to actually set lineup.",
      duration: 0,
    });
  }

  // --- Format response ---
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  const lines = [
    `FANTASY BASEBALL GM — TEST SUITE`,
    `================================`,
    `${passed} passed, ${failed} failed, ${skipped} skipped`,
    `Mode: ${dryRun ? "DRY RUN (read-only)" : "LIVE (writes enabled)"}`,
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
