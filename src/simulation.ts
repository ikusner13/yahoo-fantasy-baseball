/**
 * Dry-run simulation engine — replays the full analysis pipeline in read-only mode.
 * NO Yahoo writes, NO Telegram sends, NO LLM calls. Pure deterministic analysis.
 */

import type { Env, PlayerProjection, PlayerValuation } from "./types";
import { YahooClient } from "./yahoo/client";
import { getTodaysGames } from "./data/mlb";
import { fetchBatterProjections, fetchPitcherProjections } from "./data/projections";
import { computeZScores } from "./analysis/valuations";
import { optimizeLineup, scorePlayerForToday, type ScoringContext } from "./analysis/lineup";
import { analyzeMatchupDetailed, type DetailedMatchupAnalysis } from "./analysis/matchup";
import { rankStreamingOptions, estimateStreamingImpact, getIPStatus } from "./analysis/streaming";
import { findBestPickups } from "./analysis/waivers";
import { buildPlayerIdMap } from "./data/player-match";
import { lookupByYahooId, upsertPlayerIds } from "./data/player-ids";
import type { PlayerIdRow } from "./data/player-ids";
import { getBatterStatcast } from "./data/statcast";
import { getParkFactor, getPitcherHand, getBatchPlatoonSplits } from "./data/matchup-data";
import {
  computeStreaks,
  getStreakSummary,
  type RecentPerformance,
} from "./analysis/recent-performance";
import { formatMatchupForLLM, type MatchupBriefing } from "./ai/briefing";
import { getAddBudget } from "./analysis/add-budget";
import { identifyCategoryNeeds } from "./analysis/trades";

// --- SimulationResult types ---

export interface SimulationResult {
  date: string;
  matchupState: {
    week: number;
    opponent: string;
    daysRemaining: number;
    categoryStates: Array<{
      category: string;
      state: string;
      myValue: number;
      oppValue: number;
      margin: number;
    }>;
    worthlessCategories: string[];
    streamingDecision: {
      canStream: boolean;
      qualityFloor: string;
      reasoning: string;
    };
    ipStatus: {
      currentIP: number;
      above: boolean;
      ipNeeded: number;
    };
  };
  lineupDecisions: {
    starters: Array<{ name: string; position: string; score: number }>;
    benched: Array<{ name: string; score: number; reason: string }>;
    parkFactors: Array<{ name: string; park: string; factor: number }>;
    platoonMatches: number;
    streaksApplied: number;
  };
  waiverRecommendations: Array<{
    add: string;
    drop: string;
    netValue: number;
    reasoning: string;
  }>;
  streamingCandidates: Array<{
    name: string;
    score: number;
    opponent: string;
    netImpact: { helped: number; hurt: number };
  }>;
  /** Number of roster players matched to FanGraphs projections */
  playerIdMatchCount: number;
  /** Total roster size */
  rosterSize: number;
  /** The formatted briefing that would be sent to the LLM */
  llmBriefing?: string;
}

// --- Helpers (mirrored from gm.ts since they're not exported) ---

function getCurrentIP(matchup: {
  categories: Array<{ category: string; myValue: number }>;
}): number {
  const outStat = matchup.categories.find((c) => c.category === "OUT");
  if (outStat) return outStat.myValue / 3;
  const ipStat = matchup.categories.find((c) => c.category === "IP");
  if (ipStat) return ipStat.myValue;
  return 0;
}

function formatDetailedCategories(detailed: DetailedMatchupAnalysis): string {
  return detailed.detailedCategories
    .map((c) => {
      const stateLabel = c.state.toUpperCase();
      const sign = c.margin >= 0 ? "+" : "";
      const decimals =
        c.category === "ERA" || c.category === "WHIP" || c.category === "OBP" ? 3 : 0;
      return `${c.category}: ${c.myValue} vs ${c.opponentValue} (${stateLabel}, margin ${sign}${c.margin.toFixed(decimals)})`;
    })
    .join("\n");
}

function buildProjectionMap(
  batters: Awaited<ReturnType<typeof fetchBatterProjections>>,
  pitchers: Awaited<ReturnType<typeof fetchPitcherProjections>>,
  rosterPlayers?: Array<{ yahooId: string; name: string; team: string }>,
  env?: Env,
): { map: Map<string, PlayerProjection>; matchCount: number } {
  const map = new Map<string, PlayerProjection>();
  const now = new Date().toISOString();
  let matchCount = 0;

  let fgToYahoo = new Map<number, string>();
  if (rosterPlayers && rosterPlayers.length > 0) {
    const allProjections = [
      ...batters.map((b) => ({ fangraphsId: b.fangraphsId, name: b.name, team: b.team })),
      ...pitchers.map((p) => ({ fangraphsId: p.fangraphsId, name: p.name, team: p.team })),
    ];
    const { idMap, matches } = buildPlayerIdMap(rosterPlayers, allProjections);
    fgToYahoo = idMap;
    matchCount = matches.length;

    // Persist matches to player_ids table
    if (env && matches.length > 0) {
      const projByFg = new Map<number, { name: string; team: string }>();
      for (const b of batters) projByFg.set(b.fangraphsId, { name: b.name, team: b.team });
      for (const p of pitchers) projByFg.set(p.fangraphsId, { name: p.name, team: p.team });

      const rows: PlayerIdRow[] = matches.map((m) => {
        const proj = projByFg.get(m.fangraphsId);
        return {
          yahooId: m.yahooId,
          mlbId: null,
          fangraphsId: m.fangraphsId,
          name: proj?.name ?? m.name,
          positions: null,
          team: proj?.team ?? m.team,
        };
      });
      try {
        upsertPlayerIds(env, rows);
      } catch {
        // non-fatal
      }
    }
  }

  for (const b of batters) {
    const yahooId = fgToYahoo.get(b.fangraphsId);
    const key = yahooId ?? `fg:${b.fangraphsId}`;
    map.set(key, {
      yahooId: key,
      playerType: "batter",
      batting: { pa: b.pa, r: b.r, h: b.h, hr: b.hr, rbi: b.rbi, sb: b.sb, tb: b.tb, obp: b.obp },
      updatedAt: now,
    });
  }

  for (const p of pitchers) {
    const yahooId = fgToYahoo.get(p.fangraphsId);
    const key = yahooId ?? `fg:${p.fangraphsId}`;
    map.set(key, {
      yahooId: key,
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
      updatedAt: now,
    });
  }

  return { map, matchCount };
}

// --- Core simulation ---

export async function simulateDay(env: Env, date: string): Promise<SimulationResult> {
  const yahoo = new YahooClient(env);

  // 1. Fetch roster
  const roster = await yahoo.getRoster(date);

  // 2. Fetch games for this date
  const games = await getTodaysGames(date, env);

  // 3. Fetch matchup data
  const matchup = await yahoo.getMatchup();

  // 4. Fetch projections (cached)
  const [rawBatters, rawPitchers] = await Promise.all([
    fetchBatterProjections(undefined, env),
    fetchPitcherProjections(undefined, env),
  ]);

  // 5. Build projection map with player ID matching
  const rosterForMatch = roster.entries.map((e) => e.player);
  const { map: projectionMap, matchCount } = buildProjectionMap(
    rawBatters,
    rawPitchers,
    rosterForMatch,
    env,
  );
  const allProjections = [...projectionMap.values()];

  // 6. Compute z-scores and valuations
  const valuations = computeZScores(allProjections);
  const valMap = new Map<string, PlayerValuation>();
  for (const v of valuations) valMap.set(v.yahooId, v);

  // 7. Compute daysRemaining from matchup dates
  const weekEnd = new Date(matchup.weekEnd);
  const simDate = new Date(date);
  const daysRemaining = Math.max(0, Math.ceil((weekEnd.getTime() - simDate.getTime()) / 86400000));

  // 8. Detailed matchup analysis
  const currentIP = getCurrentIP(matchup);
  const detailed = analyzeMatchupDetailed(matchup, daysRemaining, currentIP);
  const ipStatus = getIPStatus(currentIP);

  // 9. Statcast + streaks
  const yahooToMlb = new Map<string, number>();
  const mlbToYahoo = new Map<number, string>();
  const mlbToName = new Map<number, string>();

  for (const entry of roster.entries) {
    const p = entry.player;
    let mlbId = p.mlbId;
    if (!mlbId) {
      const row = lookupByYahooId(env, p.yahooId);
      if (row?.mlbId) mlbId = row.mlbId;
    }
    if (mlbId) {
      yahooToMlb.set(p.yahooId, mlbId);
      mlbToYahoo.set(mlbId, p.yahooId);
      mlbToName.set(mlbId, p.name);
    }
  }

  const rosterMlbIds = [...yahooToMlb.values()];
  let streakMap: Map<number, RecentPerformance> | undefined;
  let streaksApplied = 0;

  try {
    if (rosterMlbIds.length > 0) {
      const statcast = await getBatterStatcast(rosterMlbIds, 2026, env);
      if (statcast.length > 0) {
        const streaks = computeStreaks(statcast, allProjections, mlbToYahoo, mlbToName);
        streakMap = new Map(streaks.map((s) => [s.mlbId, s]));
        streaksApplied = streaks.filter((s) => Math.abs(s.streakScore) > 0.1).length;
      }
    }
  } catch {
    // non-fatal
  }

  // 10. Build contextMap with park factors + platoon splits
  const contextMap = new Map<string, ScoringContext>();
  const parkFactorResults: Array<{ name: string; park: string; factor: number }> = [];
  let platoonMatches = 0;

  // Park factors
  for (const entry of roster.entries) {
    const team = entry.player.team;
    const game = games.find((g) => g.homeTeam === team || g.awayTeam === team);
    if (game) {
      const parkFactor = getParkFactor(game.homeTeam);
      contextMap.set(entry.player.yahooId, { parkFactor });
      if (Math.abs(parkFactor.runsFactor - 1.0) > 0.02) {
        parkFactorResults.push({
          name: entry.player.name,
          park: parkFactor.parkName,
          factor: parkFactor.runsFactor,
        });
      }
    }
  }

  // Platoon splits
  try {
    const teamToOpposingPitcherId = new Map<string, number>();
    for (const game of games) {
      if (game.awayProbable?.mlbId) {
        teamToOpposingPitcherId.set(game.homeTeam, game.awayProbable.mlbId);
      }
      if (game.homeProbable?.mlbId) {
        teamToOpposingPitcherId.set(game.awayTeam, game.homeProbable.mlbId);
      }
    }

    const pitcherHandResults = await Promise.all(
      [...new Set(teamToOpposingPitcherId.values())].map((id) =>
        getPitcherHand(id).then((hand) => ({ id, hand })),
      ),
    );
    const pitcherHandMap = new Map<number, "L" | "R">();
    for (const { id, hand } of pitcherHandResults) {
      if (hand) pitcherHandMap.set(id, hand);
    }

    const teamToOpposingHand = new Map<string, "L" | "R">();
    for (const [team, pitcherId] of teamToOpposingPitcherId) {
      const hand = pitcherHandMap.get(pitcherId);
      if (hand) teamToOpposingHand.set(team, hand);
    }

    const battersWithGame: Array<{ yahooId: string; mlbId: number }> = [];
    for (const entry of roster.entries) {
      const team = entry.player.team;
      if (!teamToOpposingHand.has(team)) continue;
      const mlbId = yahooToMlb.get(entry.player.yahooId);
      if (!mlbId) continue;
      const proj = projectionMap.get(entry.player.yahooId);
      if (proj?.playerType === "pitcher") continue;
      battersWithGame.push({ yahooId: entry.player.yahooId, mlbId });
    }

    const freshSplits = await getBatchPlatoonSplits(battersWithGame.map((b) => b.mlbId));
    for (const { yahooId, mlbId } of battersWithGame) {
      const team = roster.entries.find((e) => e.player.yahooId === yahooId)?.player.team;
      if (!team) continue;
      const opposingPitcherHand = teamToOpposingHand.get(team);
      const platoon = freshSplits.get(mlbId);
      if (!opposingPitcherHand) continue;

      const existing = contextMap.get(yahooId) ?? {};
      contextMap.set(yahooId, { ...existing, platoon, opposingPitcherHand });
      platoonMatches++;
    }
  } catch {
    // non-fatal
  }

  // 11. Optimize lineup (read-only — compute moves but don't apply)
  const moves = optimizeLineup(roster, projectionMap, games, matchup, streakMap, contextMap);

  const starters: Array<{ name: string; position: string; score: number }> = [];
  const benched: Array<{ name: string; score: number; reason: string }> = [];

  for (const move of moves) {
    const entry = roster.entries.find((e) => e.player.yahooId === move.playerId);
    if (!entry) continue;
    const proj = projectionMap.get(entry.player.yahooId);
    const hasGame = games.some(
      (g) =>
        (g.homeTeam === entry.player.team || g.awayTeam === entry.player.team) &&
        g.status !== "final",
    );
    const ctx = contextMap.get(entry.player.yahooId);
    const score = scorePlayerForToday(entry.player, proj, hasGame, ctx);

    if (move.position === "BN" || move.position === "IL") {
      const reason = !hasGame
        ? "no game"
        : entry.player.status === "IL" || entry.player.status === "OUT"
          ? entry.player.status
          : "lower score";
      benched.push({ name: entry.player.name, score, reason });
    } else {
      starters.push({ name: entry.player.name, position: move.position, score });
    }
  }

  // 12. Waiver analysis (read-only)
  const waiverRecommendations: SimulationResult["waiverRecommendations"] = [];
  try {
    const freeAgents = await yahoo.getFreeAgents(undefined, 50);
    if (freeAgents.length > 0 && valuations.length > 0) {
      const faValuations = valuations.filter((v) =>
        freeAgents.some((fa) => fa.yahooId === v.yahooId),
      );
      const pickups = findBestPickups(faValuations, roster.entries, valMap, 5);
      for (const rec of pickups) {
        waiverRecommendations.push({
          add: rec.add.name,
          drop: rec.drop.name,
          netValue: rec.netValue,
          reasoning: rec.reasoning,
        });
      }
    }
  } catch {
    // non-fatal
  }

  // 13. Streaming analysis (read-only)
  const streamingCandidates: SimulationResult["streamingCandidates"] = [];
  try {
    const faPitchers = await yahoo.getFreeAgents("SP", 25);
    if (faPitchers.length > 0 && games.length > 0) {
      const streamInputs = faPitchers.map((p) => ({
        player: p,
        projection: projectionMap.get(p.yahooId)?.pitching,
      }));
      const ranked = rankStreamingOptions(streamInputs, games);

      for (const candidate of ranked.slice(0, 5)) {
        // Compute net category impact
        const proj = projectionMap.get(candidate.player.yahooId)?.pitching;
        let helped = 0;
        let hurt = 0;
        if (proj) {
          const impact = estimateStreamingImpact(proj, detailed.detailedCategories);
          helped = impact.netCategoriesHelped;
          hurt = impact.netCategoriesHurt;
        }
        streamingCandidates.push({
          name: candidate.player.name,
          score: candidate.score,
          opponent: candidate.opponent,
          netImpact: { helped, hurt },
        });
      }
    }
  } catch {
    // non-fatal
  }

  // 14. Build the full matchup briefing (what the LLM would see)
  let llmBriefing: string | undefined;
  try {
    const budget = getAddBudget(env);
    const myVals = roster.entries
      .map((e) => valMap.get(e.player.yahooId))
      .filter((v): v is PlayerValuation => !!v);
    const rosterNeeds = myVals.length > 0 ? identifyCategoryNeeds(myVals).join(", ") : "unknown";

    // Streak summary
    let streakText = "";
    if (streakMap) {
      const streakArr = [...streakMap.values()];
      const { hot, cold } = getStreakSummary(streakArr);
      const parts: string[] = [];
      if (hot.length > 0) {
        parts.push(
          `Hot: ${hot
            .slice(0, 3)
            .map((s) => `${s.name} (.${(s.recentXwoba * 1000).toFixed(0)} xwOBA)`)
            .join(", ")}`,
        );
      }
      if (cold.length > 0) {
        parts.push(
          `Cold: ${cold
            .slice(0, 3)
            .map((s) => `${s.name} (.${(s.recentXwoba * 1000).toFixed(0)} xwOBA)`)
            .join(", ")}`,
        );
      }
      streakText = parts.join(". ");
    }

    const briefingData: MatchupBriefing = {
      summary: `Week ${matchup.week} vs ${matchup.opponentTeamName}, ${detailed.projectedWins}W-${detailed.projectedLosses}L, ${daysRemaining} days left`,
      categories: formatDetailedCategories(detailed),
      worthless:
        detailed.worthlessCategories.length > 0
          ? `${detailed.worthlessCategories.join(", ")} — production here is worthless`
          : "None — all categories still in play",
      streaming: `${detailed.streamingDecision.reasoning} (quality floor: ${detailed.streamingDecision.qualityFloor})`,
      ipStatus: `${ipStatus.currentIP.toFixed(1)} IP (${ipStatus.above ? "above" : "below"} ${ipStatus.minimum} min${ipStatus.ipNeeded > 0 ? `, need ${ipStatus.ipNeeded.toFixed(1)} more` : ""})`,
      streaks: streakText || undefined,
      addBudget: `${budget.addsRemaining} adds remaining (${budget.addsUsed} used)`,
      opponentScouting: rosterNeeds !== "unknown" ? `Our weakest cats: ${rosterNeeds}` : undefined,
    };
    llmBriefing = formatMatchupForLLM(briefingData);
  } catch {
    // non-fatal
  }

  return {
    date,
    matchupState: {
      week: matchup.week,
      opponent: matchup.opponentTeamName,
      daysRemaining,
      categoryStates: detailed.detailedCategories.map((c) => ({
        category: c.category,
        state: c.state,
        myValue: c.myValue,
        oppValue: c.opponentValue,
        margin: c.margin,
      })),
      worthlessCategories: detailed.worthlessCategories,
      streamingDecision: {
        canStream: detailed.streamingDecision.canStream,
        qualityFloor: detailed.streamingDecision.qualityFloor,
        reasoning: detailed.streamingDecision.reasoning,
      },
      ipStatus: {
        currentIP: ipStatus.currentIP,
        above: ipStatus.above,
        ipNeeded: ipStatus.ipNeeded,
      },
    },
    lineupDecisions: {
      starters,
      benched,
      parkFactors: parkFactorResults,
      platoonMatches,
      streaksApplied,
    },
    waiverRecommendations,
    streamingCandidates,
    playerIdMatchCount: matchCount,
    rosterSize: roster.entries.length,
    llmBriefing,
  };
}
