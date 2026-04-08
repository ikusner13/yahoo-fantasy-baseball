import type {
  Env,
  Decision,
  ScheduledGame,
  PlayerProjection,
  PlayerValuation,
  LineupMove,
} from "./types";
import { YahooClient } from "./yahoo/client";
import { getTodaysGames } from "./data/mlb";
import { sendMessage } from "./notifications/telegram";
import {
  formatLineupNotification,
  formatILNotification,
  formatPickupNotification,
  formatStreamingNotification,
  formatLateScratchNotification,
  type PickupNotificationItem,
} from "./notifications/action-messages";
import { getILMoves, countILSlots, getInjuredActivePlayers } from "./analysis/il-manager";
import { optimizeLineup, type ScoringContext } from "./analysis/lineup";
import {
  computeStreaks,
  getStreakSummary,
  type RecentPerformance,
} from "./analysis/recent-performance";
import { computeZScores } from "./analysis/valuations";
import { analyzeMatchup, analyzeMatchupDetailed } from "./analysis/matchup";
import type { MatchupAnalysis, DetailedMatchupAnalysis } from "./analysis/matchup";
import { rankStreamingOptions, getIPStatus } from "./analysis/streaming";
import { findBestPickups, shouldUseWaiverPriority } from "./analysis/waivers";
import { fetchBatterProjections, fetchPitcherProjections } from "./data/projections";
import { identifyCategoryNeeds, identifySurplus } from "./analysis/trades";
import { askLLM } from "./ai/llm";
import {
  lineupSummaryPrompt,
  waiverWirePrompt,
  matchupStrategyPrompt,
  tradeProposalPrompt,
  injuryAssessmentPrompt,
} from "./ai/prompts";
import {
  formatMatchupForLLM,
  formatWaiverForLLM,
  formatTradeForLLM,
  formatInjuryForLLM,
  formatLineupForLLM,
} from "./ai/briefing";
import { getWeekSchedule, findGameCountEdge } from "./analysis/game-count";
import { getTwoStartPitchers } from "./analysis/two-start";
import {
  getAddBudget,
  recordAdd,
  shouldSpendAdd,
  classifyAddPriority,
  resetWeeklyBudget,
} from "./analysis/add-budget";
import { getActionableAlerts, formatAlertForTelegram } from "./monitors/news";
import type { NewsAlert } from "./monitors/news";
import { buildPlayerIdMap } from "./data/player-match";
import { upsertPlayerIds, lookupByYahooId } from "./data/player-ids";
import type { PlayerIdRow } from "./data/player-ids";
import { getBatterStatcast } from "./data/statcast";
import {
  getParkFactor,
  getPitcherHand,
  getBatchPlatoonSplits,
  type PlatoonSplit,
} from "./data/matchup-data";
import { buildRetrospective, formatRetrospectiveForTelegram } from "./analysis/retrospective";
import { loadTuning } from "./config/tuning";
import { logDecisionEvent, logError } from "./observability/log";
import { buildMemoryContext, generateReflection } from "./ai/memory";
import { eq, desc } from "drizzle-orm";
import {
  feedback as feedbackTable,
  decisions as decisionsTable,
  retrospectives,
} from "./db/schema";

/** Query recent feedback entries formatted for LLM context */
async function getRecentFeedback(env: Env, limit: number = 5): Promise<string | undefined> {
  try {
    const rows = await env.db
      .select({ type: feedbackTable.type, message: feedbackTable.message })
      .from(feedbackTable)
      .orderBy(desc(feedbackTable.timestamp))
      .limit(limit)
      .all();
    if (rows.length === 0) return undefined;
    return rows.map((r) => `\u2022 [${r.type}] ${r.message}`).join("\n");
  } catch (e) {
    logError("feedback_fetch", e);
    return undefined;
  }
}

// KV-backed alert dedup for news monitor
const ALERT_KV_KEY = "sent-alert-keys";

async function getSentAlertKeys(env: Env): Promise<Set<string>> {
  try {
    const raw = (await env.KV.get(ALERT_KV_KEY, "json")) as string[] | null;
    return new Set(raw ?? []);
  } catch (e) {
    logError("alert_keys_fetch", e);
    return new Set();
  }
}

async function addSentAlertKeys(env: Env, keys: string[]): Promise<void> {
  const existing = await getSentAlertKeys(env);
  for (const k of keys) existing.add(k);
  // TTL 24h — auto-cleanup
  await env.KV.put(ALERT_KV_KEY, JSON.stringify([...existing]), { expirationTtl: 86400 });
}

// Pitcher hand cache — handedness never changes, so cache forever (process lifetime)
const pitcherHandCache = new Map<number, "L" | "R">();

// Platoon split cache — keyed by mlbId, refreshed once per process lifetime
const platoonSplitCache = new Map<number, PlatoonSplit>();

/** Extract last name from a full name string. */
function extractLastName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return (parts[parts.length - 1] ?? fullName).toLowerCase();
}

/** Check if two player names match by last name. */
function namesMatch(a: string, b: string): boolean {
  return extractLastName(a) === extractLastName(b);
}

export type AlertRelevance = "OUR_PLAYER" | "FREE_AGENT" | "OTHER";

/** Tag alert relevance relative to our roster. */
function classifyAlertRelevance(alert: NewsAlert, rosterNames: string[]): AlertRelevance {
  if (rosterNames.some((n) => namesMatch(n, alert.playerName))) return "OUR_PLAYER";
  return "FREE_AGENT"; // no ownership data available in alert — treat non-roster as FA
}

/** Determine if alert should be sent based on relevance + type. */
function shouldSendAlert(alert: NewsAlert, relevance: AlertRelevance): boolean {
  if (relevance === "OUR_PLAYER") return true;
  if (relevance === "FREE_AGENT") {
    return alert.type === "closer_change" || alert.type === "callup";
  }
  return false;
}

// Helper to find player name from roster by ID
function findPlayerName(
  roster: { entries: Array<{ player: { yahooId: string; name: string } }> },
  playerId: string,
): string {
  return roster.entries.find((e) => e.player.yahooId === playerId)?.player.name ?? playerId;
}

/** Build category line for briefing: "HR: 10 vs 7 (WIN clinched, margin +3)" */
function formatDetailedCategories(detailed: DetailedMatchupAnalysis): string {
  return detailed.detailedCategories
    .map((c) => {
      const stateLabel = c.state.toUpperCase();
      const sign = c.margin >= 0 ? "+" : "";
      return `${c.category}: ${c.myValue} vs ${c.opponentValue} (${stateLabel}, margin ${sign}${c.margin.toFixed(c.category === "ERA" || c.category === "WHIP" || c.category === "OBP" ? 3 : 0)})`;
    })
    .join("\n");
}

/** Build Yahoo team key from env. */
function buildTeamKey(env: Env): string {
  return `mlb.l.${env.YAHOO_LEAGUE_ID}.t.${env.YAHOO_TEAM_ID}`;
}

/** Fetch our standings rank + record string, e.g. "#4 (6-4-3)" */
async function getOurRank(
  yahoo: YahooClient,
  teamKey: string,
): Promise<{ rank: number; label: string } | undefined> {
  try {
    const standings = await yahoo.getStandings();
    const us = standings.find((s) => s.teamKey === teamKey);
    if (!us) return undefined;
    return {
      rank: us.rank,
      label: `#${us.rank} (${us.wins}-${us.losses}-${us.ties})`,
    };
  } catch (e) {
    logError("standings_fetch", e);
    return undefined;
  }
}

/** Compute IP from matchup pitching stats */
function getCurrentIP(matchup: {
  categories: Array<{ category: string; myValue: number }>;
}): number {
  // OUT stat / 3 = IP, or use IP stat directly
  const outStat = matchup.categories.find((c) => c.category === "OUT");
  if (outStat) return outStat.myValue / 3;
  const ipStat = matchup.categories.find((c) => c.category === "IP");
  if (ipStat) return ipStat.myValue;
  return 0;
}

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/** Build a Map<yahooId, PlayerProjection> from FanGraphs raw projections.
 *  When rosterPlayers is provided, keys projections by Yahoo ID via name+team matching.
 *  Unmatched projections fall back to `fg:${fangraphsId}` key. */
async function buildProjectionMap(
  batters: Awaited<ReturnType<typeof fetchBatterProjections>>,
  pitchers: Awaited<ReturnType<typeof fetchPitcherProjections>>,
  rosterPlayers?: Array<{ yahooId: string; name: string; team: string }>,
  env?: Env,
): Promise<Map<string, PlayerProjection>> {
  const map = new Map<string, PlayerProjection>();
  const now = new Date().toISOString();

  // Build fangraphsId → yahooId map if roster is available
  let fgToYahoo = new Map<number, string>();
  if (rosterPlayers && rosterPlayers.length > 0) {
    const allProjections = [
      ...batters.map((b) => ({ fangraphsId: b.fangraphsId, name: b.name, team: b.team })),
      ...pitchers.map((p) => ({ fangraphsId: p.fangraphsId, name: p.name, team: p.team })),
    ];
    const { idMap, matches } = buildPlayerIdMap(rosterPlayers, allProjections);
    fgToYahoo = idMap;

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
        await upsertPlayerIds(env, rows);
      } catch (e) {
        logError("player_ids_upsert", e);
        // non-fatal — DB write failure shouldn't break projection flow
      }
    }
  }

  for (const b of batters) {
    const yahooId = fgToYahoo.get(b.fangraphsId);
    const key = yahooId ?? `fg:${b.fangraphsId}`;
    map.set(key, {
      yahooId: key,
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

  return map;
}

/** Convert projection map values to array for z-score computation. */
function projectionsToArray(map: Map<string, PlayerProjection>): PlayerProjection[] {
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Daily morning routine (9am ET)
// ---------------------------------------------------------------------------

export async function runDailyMorning(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const today = new Date().toISOString().slice(0, 10);
  const summaryLines: string[] = [`<b>Daily GM Report — ${today}</b>`];
  const decisions: Decision[] = [];

  // 0. Check news alerts (closer changes, call-ups, injuries)
  try {
    const alerts = await getActionableAlerts(env);
    if (alerts.length > 0) {
      summaryLines.push(`\n<b>News Alerts (${alerts.length}):</b>`);
      for (const alert of alerts.slice(0, 5)) {
        summaryLines.push(formatAlertForTelegram(alert));

        // Run injury alerts through LLM injury assessment
        if (alert.type === "injury" && alert.playerName) {
          try {
            const injuryMemory = await buildMemoryContext(env, "injury");
            const briefing = formatInjuryForLLM({
              player: alert.playerName,
              injury: alert.headline,
              rosterContext: `Team: ${alert.team}. ${alert.fantasyImpact}`,
              ilSlots: "Check roster for availability",
              memory: injuryMemory,
            });
            const prompt = injuryAssessmentPrompt(briefing);
            const assessment = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
            if (!assessment.startsWith("[")) {
              summaryLines.push(`  → AI: ${assessment}`);
            }
          } catch (e) {
            logError("injury_assessment", e);
            // supplemental
          }
        }
      }
    }
  } catch (e) {
    logError("news_alerts", e);
    // non-fatal
  }

  // 1. Fetch roster
  let roster;
  try {
    roster = await yahoo.getRoster(today);
    summaryLines.push(`Roster: ${roster.entries.length} players`);
  } catch (e) {
    logError("roster_fetch", e);
    const msg = `Roster fetch failed: ${e instanceof Error ? e.message : "unknown"}`;
    summaryLines.push(msg);
    await sendMessage(env, summaryLines.join("\n"));
    return;
  }

  // 2. Fetch today's games
  let games: ScheduledGame[] = [];
  try {
    games = await getTodaysGames(today, env);
    summaryLines.push(`Games today: ${games.length}`);
    appendProbablePitchers(summaryLines, games);
  } catch (e) {
    logError("games_fetch", e);
    summaryLines.push(`Games fetch failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 2b. Weekly game count analysis
  try {
    // Get this week's schedule (Mon-Sun)
    const dayOfWeek = new Date(today).getDay(); // 0=Sun
    const weekStartOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStart = new Date(new Date(today).getTime() + weekStartOffset * 86400000)
      .toISOString()
      .slice(0, 10);
    const weekEnd = new Date(new Date(weekStart).getTime() + 6 * 86400000)
      .toISOString()
      .slice(0, 10);
    const weekSchedule = await getWeekSchedule(weekStart, weekEnd);
    const edgeTeams = findGameCountEdge(weekSchedule);
    if (edgeTeams.length > 0) {
      summaryLines.push(`7-game teams this week: ${edgeTeams.join(", ")}`);
    }
  } catch (e) {
    logError("week_schedule", e);
    // non-fatal
  }

  // 3. Fetch projections from FanGraphs
  let projectionMap = new Map<string, PlayerProjection>();
  let allProjections: PlayerProjection[] = [];
  let valuations: PlayerValuation[] = [];
  try {
    const [rawBatters, rawPitchers] = await Promise.all([
      fetchBatterProjections(undefined, env),
      fetchPitcherProjections(undefined, env),
    ]);
    const rosterForMatch = roster?.entries.map((e) => e.player) ?? [];
    projectionMap = await buildProjectionMap(rawBatters, rawPitchers, rosterForMatch, env);
    allProjections = projectionsToArray(projectionMap);
    summaryLines.push(`Projections: ${rawBatters.length} batters, ${rawPitchers.length} pitchers`);

    // 4. Compute z-scores
    valuations = computeZScores(allProjections);
    summaryLines.push(`Valuations: ${valuations.length} players scored`);
  } catch (e) {
    logError("projections_fetch", e);
    summaryLines.push(`Projections failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 5. Fetch current matchup for category weighting
  let matchup;
  let matchupAnalysis: MatchupAnalysis | null = null;
  try {
    matchup = await yahoo.getMatchup();
    if (matchup.categories.length > 0) {
      matchupAnalysis = analyzeMatchup(matchup);
    }
  } catch (e) {
    logError("matchup_fetch", e);
    // non-fatal, lineup optimization works without matchup context
  }

  // 5b. Statcast recent performance + park factors (contextual multipliers for lineup optimizer)
  let streakMap: Map<number, RecentPerformance> | undefined;
  let streakSummaryText = "";
  let contextMap: Map<string, ScoringContext> | undefined;

  // Build yahooId -> mlbId map from player_ids table (shared across statcast + platoon)
  const yahooToMlb = new Map<string, number>();
  const mlbToYahoo = new Map<number, string>();
  const mlbToName = new Map<number, string>();

  for (const entry of roster.entries) {
    const p = entry.player;
    let mlbId = p.mlbId;
    if (!mlbId) {
      const row = await lookupByYahooId(env, p.yahooId);
      if (row?.mlbId) mlbId = row.mlbId;
    }
    if (mlbId) {
      yahooToMlb.set(p.yahooId, mlbId);
      mlbToYahoo.set(mlbId, p.yahooId);
      mlbToName.set(mlbId, p.name);
    }
  }

  const rosterMlbIds = [...yahooToMlb.values()];

  try {
    if (rosterMlbIds.length > 0) {
      // Fetch Statcast batter data (1 HTTP call, cached per day)
      const statcast = await getBatterStatcast(rosterMlbIds, 2026, env);

      if (statcast.length > 0) {
        // Compute streaks: compare recent xwOBA vs ROS projections
        const streaks = computeStreaks(statcast, allProjections, mlbToYahoo, mlbToName);
        streakMap = new Map(streaks.map((s) => [s.mlbId, s]));

        // Build human-readable summary for LLM briefings
        const { hot, cold } = getStreakSummary(streaks);
        const parts: string[] = [];
        if (hot.length > 0) {
          parts.push(
            `Hot: ${hot
              .slice(0, 3)
              .map(
                (s) =>
                  `${s.name} (.${(s.recentXwoba * 1000).toFixed(0)} xwOBA, streak ${s.streakScore >= 0 ? "+" : ""}${s.streakScore.toFixed(2)})`,
              )
              .join(", ")}`,
          );
        }
        if (cold.length > 0) {
          parts.push(
            `Cold: ${cold
              .slice(0, 3)
              .map(
                (s) =>
                  `${s.name} (.${(s.recentXwoba * 1000).toFixed(0)} xwOBA, streak ${s.streakScore >= 0 ? "+" : ""}${s.streakScore.toFixed(2)})`,
              )
              .join(", ")}`,
          );
        }
        streakSummaryText = parts.join(". ");
        if (streakSummaryText) {
          summaryLines.push(`Statcast: ${statcast.length} batters tracked. ${streakSummaryText}`);
        } else {
          summaryLines.push(`Statcast: ${statcast.length} batters tracked, no notable streaks`);
        }
      } else {
        summaryLines.push("Statcast: no data for roster players");
      }
    } else {
      summaryLines.push("Statcast: skipped (no mlbId mappings)");
    }
  } catch (e) {
    logError("statcast_fetch", e);
    summaryLines.push(
      `Statcast: failed (${e instanceof Error ? e.message : "unknown"}) — continuing without`,
    );
    // Non-fatal: optimizer handles missing streaks gracefully
  }

  // Build per-player ScoringContext with park factors (static data, never fails)
  try {
    contextMap = new Map<string, ScoringContext>();
    for (const entry of roster.entries) {
      const team = entry.player.team;
      // Find the game this player's team is in today
      const game = games.find((g) => g.homeTeam === team || g.awayTeam === team);
      if (game) {
        // Park factor comes from the HOME team's park
        const parkFactor = getParkFactor(game.homeTeam);
        contextMap.set(entry.player.yahooId, { parkFactor });
      }
    }
    if (contextMap.size > 0) {
      summaryLines.push(`Park factors: ${contextMap.size} players in context`);
    }
  } catch (e) {
    logError("park_factors", e);
    // Park factors are static — this should never fail, but be safe
    contextMap = undefined;
  }

  // 5c. Platoon splits — highest signal-to-noise daily factor for batter lineup decisions
  try {
    if (!contextMap) contextMap = new Map<string, ScoringContext>();

    // Step 1: Resolve opposing pitcher hand for each game today
    // Build team -> opposing pitcher mlbId mapping
    const teamToOpposingPitcherId = new Map<string, number>();
    for (const game of games) {
      if (game.awayProbable?.mlbId) {
        // Home team faces the away probable
        teamToOpposingPitcherId.set(game.homeTeam, game.awayProbable.mlbId);
      }
      if (game.homeProbable?.mlbId) {
        // Away team faces the home probable
        teamToOpposingPitcherId.set(game.awayTeam, game.homeProbable.mlbId);
      }
    }

    // Fetch pitcher hands (only for pitchers not already cached)
    const uncachedPitcherIds = [...new Set(teamToOpposingPitcherId.values())].filter(
      (id) => !pitcherHandCache.has(id),
    );
    if (uncachedPitcherIds.length > 0) {
      const handResults = await Promise.all(
        uncachedPitcherIds.map((id) => getPitcherHand(id).then((hand) => ({ id, hand }))),
      );
      for (const { id, hand } of handResults) {
        if (hand) pitcherHandCache.set(id, hand);
      }
    }

    // Build team -> opposing pitcher hand
    const teamToOpposingHand = new Map<string, "L" | "R">();
    for (const [team, pitcherId] of teamToOpposingPitcherId) {
      const hand = pitcherHandCache.get(pitcherId);
      if (hand) teamToOpposingHand.set(team, hand);
    }

    // Step 2: Fetch platoon splits for batters who have a game today
    const battersWithGame: Array<{ yahooId: string; mlbId: number }> = [];
    for (const entry of roster.entries) {
      const team = entry.player.team;
      if (!teamToOpposingHand.has(team)) continue; // no game or no pitcher hand
      const mlbId = yahooToMlb.get(entry.player.yahooId);
      if (!mlbId) continue;
      // Skip pitchers — platoon splits only matter for batters
      const proj = projectionMap.get(entry.player.yahooId);
      if (proj?.playerType === "pitcher") continue;
      battersWithGame.push({ yahooId: entry.player.yahooId, mlbId });
    }

    // Only fetch splits for batters not already cached
    const uncachedBatterIds = battersWithGame
      .map((b) => b.mlbId)
      .filter((id) => !platoonSplitCache.has(id));
    if (uncachedBatterIds.length > 0) {
      const freshSplits = await getBatchPlatoonSplits(uncachedBatterIds);
      for (const [id, split] of freshSplits) {
        platoonSplitCache.set(id, split);
      }
    }

    // Step 3: Wire platoon + opposing pitcher hand into contextMap
    let platoonCount = 0;
    for (const { yahooId, mlbId } of battersWithGame) {
      const team = roster.entries.find((e) => e.player.yahooId === yahooId)?.player.team;
      if (!team) continue;
      const opposingPitcherHand = teamToOpposingHand.get(team);
      const platoon = platoonSplitCache.get(mlbId);
      if (!opposingPitcherHand) continue;

      const existing = contextMap.get(yahooId) ?? {};
      contextMap.set(yahooId, { ...existing, platoon, opposingPitcherHand });
      platoonCount++;
    }

    if (platoonCount > 0) {
      const lhpCount = [...teamToOpposingHand.values()].filter((h) => h === "L").length;
      const rhpCount = [...teamToOpposingHand.values()].filter((h) => h === "R").length;
      summaryLines.push(
        `Platoon: ${platoonCount} batters matched (${lhpCount}L/${rhpCount}R pitchers)`,
      );
    }
  } catch (e) {
    logError("platoon_splits", e);
    summaryLines.push(
      `Platoon: failed (${e instanceof Error ? e.message : "unknown"}) — continuing without`,
    );
    // Non-fatal: optimizer handles missing platoon data gracefully
  }

  // 6. IL moves
  try {
    const ilActions = getILMoves(roster);
    if (ilActions.length > 0) {
      summaryLines.push(`\n<b>IL Moves (${ilActions.length}):</b>`);

      // Convert IL actions to lineup moves and execute
      const ilMoves: LineupMove[] = [];
      for (const a of ilActions) {
        summaryLines.push(`• ${a.reasoning}`);
        if (a.type === "move_to_il") {
          ilMoves.push({ playerId: a.player.yahooId, position: "IL" });
        } else if (a.type === "activate_from_il") {
          ilMoves.push({ playerId: a.player.yahooId, position: "BN" });
        }
      }

      if (ilMoves.length > 0) {
        try {
          const ilMsg = formatILNotification(env, ilActions, ilMoves);
          await sendMessage(env, ilMsg);
          summaryLines.push(`IL moves notified: ${ilMoves.length}`);
        } catch (e) {
          logError("il_notification", e);
          summaryLines.push(
            `IL notification failed: ${e instanceof Error ? e.message : "unknown"}`,
          );
        }
      }
    } else {
      summaryLines.push("IL: no moves needed");
    }
    decisions.push({
      type: "il",
      action: { ilActions },
      reasoning: ilActions.map((a) => a.reasoning).join("; ") || "no moves",
      result: ilActions.length > 0 ? "notified" : "success",
    });
  } catch (e) {
    logError("il_check", e);
    summaryLines.push(`IL check failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 7. Optimize lineup + AI analysis
  try {
    const moves = optimizeLineup(roster, projectionMap, games, matchup, streakMap, contextMap);
    if (moves.length > 0) {
      const lineupMsg = formatLineupNotification(env, today, moves, roster);
      await sendMessage(env, lineupMsg);
      const activeCount = moves.filter((m) => m.position !== "BN" && m.position !== "IL").length;
      summaryLines.push(
        `Lineup changes notified: ${activeCount} active, ${moves.length} total moves`,
      );
    } else {
      summaryLines.push("Lineup: no changes needed");
    }

    // AI: explain lineup decisions (supplemental — stats engine already decided)
    try {
      const lineupMemory = await buildMemoryContext(env, "lineup");
      const starters = moves.filter((m) => m.position !== "BN" && m.position !== "IL");
      const benched = moves.filter((m) => m.position === "BN");
      const briefing = formatLineupForLLM({
        starters: starters
          .map((m) => `${findPlayerName(roster, m.playerId)} → ${m.position}`)
          .join(", "),
        benched: benched.map((m) => findPlayerName(roster, m.playerId)).join(", "),
        games: games
          .slice(0, 8)
          .map((g) => `${g.awayTeam}@${g.homeTeam}`)
          .join(", "),
        strategy: matchupAnalysis?.strategy.benchMessage,
        swingCategories: matchupAnalysis?.swingCategories.join(", "),
        streaks: streakSummaryText || undefined,
        memory: lineupMemory,
      });
      const prompt = lineupSummaryPrompt(briefing);
      const aiNotes = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
      if (!aiNotes.startsWith("[")) {
        summaryLines.push(`\n<b>AI Notes:</b> ${aiNotes}`);
      }
    } catch (e) {
      logError("lineup_ai_notes", e);
      // supplemental — don't fail
    }

    decisions.push({
      type: "lineup",
      action: { moves: moves.length },
      reasoning: `Set ${moves.length} lineup moves`,
      result: moves.length > 0 ? "notified" : "success",
    });
  } catch (e) {
    logError("lineup_optimization", e);
    summaryLines.push(`Lineup optimization failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 8. Waiver wire evaluation
  const budget = await getAddBudget(env);
  try {
    const freeAgents = await yahoo.getFreeAgents(undefined, 50);
    if (freeAgents.length > 0 && valuations.length > 0) {
      // Build valuation map for roster players
      const valMap = new Map<string, PlayerValuation>();
      for (const v of valuations) valMap.set(v.yahooId, v);

      // Build FA valuations from the z-score list (match by yahooId)
      const faValuations = valuations.filter((v) =>
        freeAgents.some((fa) => fa.yahooId === v.yahooId),
      );

      const pickups = findBestPickups(faValuations, roster.entries, valMap, 5);

      if (pickups.length > 0) {
        summaryLines.push(
          `\n<b>Waiver Picks (${pickups.length}):</b> [${budget.addsRemaining} adds left this week]`,
        );
        const pickupNotifications: PickupNotificationItem[] = [];
        for (const rec of pickups) {
          const reasoningLower = rec.reasoning.toLowerCase();
          const priority = classifyAddPriority(rec, {
            isCloserChange: reasoningLower.includes("closer") || reasoningLower.includes("saves"),
            isInjuryReplacement:
              reasoningLower.includes("injur") ||
              reasoningLower.includes("IL") ||
              rec.drop.status === "IL",
          });
          summaryLines.push(
            `• ${rec.add.name} for ${rec.drop.name} (+${rec.netValue.toFixed(1)}) [${priority}]`,
          );

          // Check add budget before spending
          if (!shouldSpendAdd(budget, priority)) {
            summaryLines.push(`  -> Skipped (saving adds for higher-impact moves)`);
            continue;
          }

          const method = shouldUseWaiverPriority(rec, 5)
            ? ("waiver" as const)
            : ("add/drop" as const);
          pickupNotifications.push({
            addName: rec.add.name,
            dropName: rec.drop.name,
            netValue: rec.netValue,
            priority,
            reasoning: rec.reasoning,
            method,
          });
          await recordAdd(env);
          decisions.push({
            type: "waiver",
            action: { add: rec.add.name, drop: rec.drop.name, net: rec.netValue },
            reasoning: rec.reasoning,
            result: "notified",
          });
        }

        if (pickupNotifications.length > 0) {
          try {
            const pickupMsg = formatPickupNotification(
              env,
              pickupNotifications,
              budget.addsRemaining,
            );
            await sendMessage(env, pickupMsg);
            summaryLines.push(`  -> ${pickupNotifications.length} pickup(s) notified`);
          } catch (e) {
            logError("pickup_notification", e);
            summaryLines.push(
              `  -> Pickup notification failed: ${e instanceof Error ? e.message : "unknown"}`,
            );
          }
        }

        // LLM: commentary on waiver recommendations (supplemental — stats engine already decided)
        try {
          const waiverMemory = await buildMemoryContext(env, "waiver");
          const rosterNeeds =
            valuations.length > 0 ? identifyCategoryNeeds(valuations).join(", ") : "unknown";
          const swingCats = matchupAnalysis?.swingCategories.join(", ") ?? "unknown";
          const briefing = formatWaiverForLLM({
            matchupContext: `Swing categories this week: ${swingCats}`,
            addBudget: `${budget.addsRemaining} adds remaining (${budget.addsUsed} used)`,
            recommendations: pickups.map((r) => r.reasoning).join("\n"),
            rosterNeeds,
            memory: waiverMemory,
          });
          const prompt = waiverWirePrompt(briefing);
          const waiverInsight = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
          if (!waiverInsight.startsWith("[")) {
            summaryLines.push(`\n<b>AI Waiver Notes:</b> ${waiverInsight}`);
          }
        } catch (e) {
          logError("waiver_ai_notes", e);
          // supplemental — don't fail
        }
      } else {
        summaryLines.push("Waivers: no upgrades found");
      }
    } else {
      summaryLines.push("Waivers: skipped (no FAs or valuations)");
    }
  } catch (e) {
    logError("waiver_scan", e);
    summaryLines.push(`Waiver scan failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 9. Streaming pitchers
  try {
    const faPitchers = await yahoo.getFreeAgents("SP", 25);
    if (faPitchers.length > 0 && games.length > 0) {
      // Build pitcher streaming inputs
      const streamCandidates = faPitchers.map((p) => {
        const proj = projectionMap.get(p.yahooId);
        return {
          player: p,
          projection: proj?.pitching,
        };
      });

      const ranked = rankStreamingOptions(streamCandidates, games);

      // Compute days remaining from day-of-week (Sun=1, Mon=7, Tue=6, ...)
      const dow = new Date().getDay(); // 0=Sun
      const daysRemaining = dow === 0 ? 1 : 8 - dow;

      // Use smart streaming decision from detailed matchup analysis
      let canStream = true;
      let minScore = 3.0;
      let streamReasoning = "No matchup data — streaming freely";
      if (matchup) {
        const currentIP = getCurrentIP(matchup);
        const detailed = analyzeMatchupDetailed(matchup, daysRemaining, currentIP);
        const decision = detailed.streamingDecision;
        canStream = decision.canStream;
        streamReasoning = decision.reasoning;

        // Map quality floors to minimum score thresholds (from tuning config)
        const streamMinimums = loadTuning().streaming.scoreMinimum;
        switch (decision.qualityFloor) {
          case "any":
            minScore = streamMinimums.any;
            break;
          case "high-floor":
            minScore = streamMinimums["high-floor"];
            break;
          case "elite-only":
            minScore = streamMinimums["elite-only"];
            break;
          case "none":
            canStream = false;
            break;
        }
      }

      if (canStream && ranked.length > 0 && ranked[0].score > minScore) {
        const top = ranked[0];
        summaryLines.push(`\n<b>Streaming SP:</b> (${streamReasoning})`);
        summaryLines.push(
          `• ${top.player.name} vs ${top.opponent} (score: ${top.score.toFixed(1)}, floor: ${minScore.toFixed(1)})`,
        );

        // Check add budget before streaming
        const streamPriority = classifyAddPriority(
          { add: top.player, drop: top.player, netValue: top.score, reasoning: "streaming" },
          {},
        );
        if (!shouldSpendAdd(budget, streamPriority)) {
          summaryLines.push("  -> Skipped (saving adds for higher-impact moves)");
        } else {
          // Find worst bench pitcher to drop
          const benchPitchers = roster.entries.filter(
            (e) =>
              e.currentPosition === "BN" &&
              e.player.positions.some((p) => p === "SP" || p === "RP"),
          );

          if (benchPitchers.length > 0) {
            const dropTarget = benchPitchers[benchPitchers.length - 1];
            try {
              const streamMsg = formatStreamingNotification(
                env,
                top.player.name,
                top.opponent,
                top.score,
                dropTarget.player.name,
                streamReasoning,
              );
              await sendMessage(env, streamMsg);
              await recordAdd(env);
              summaryLines.push(`  -> Streaming pickup notified, drop ${dropTarget.player.name}`);
              decisions.push({
                type: "stream",
                action: {
                  add: top.player.name,
                  drop: dropTarget.player.name,
                  score: top.score,
                  opponent: top.opponent,
                },
                reasoning: `Streaming ${top.player.name} vs ${top.opponent} (score ${top.score.toFixed(1)}, ${streamReasoning})`,
                result: "notified",
              });
            } catch (e) {
              logError("stream_notification", e);
              summaryLines.push(
                `  -> Stream notification failed: ${e instanceof Error ? e.message : "unknown"}`,
              );
            }
          } else {
            summaryLines.push("  -> No droppable bench pitcher");
          }
        }
      } else if (!canStream) {
        summaryLines.push(`Streaming: skipped (${streamReasoning})`);
      } else {
        summaryLines.push(
          `Streaming: no strong options (top: ${ranked[0]?.score.toFixed(1) ?? "none"}, need >${minScore.toFixed(1)})`,
        );
      }
    } else {
      summaryLines.push("Streaming: skipped (no FA pitchers or games)");
    }
  } catch (e) {
    logError("streaming_analysis", e);
    summaryLines.push(`Streaming analysis failed: ${e instanceof Error ? e.message : "unknown"}`);
  }

  // 10. Send rich Telegram summary
  try {
    await sendMessage(env, summaryLines.join("\n"));
  } catch (e) {
    logError("telegram_summary", e);
    // last-resort: try a simpler message
    try {
      await sendMessage(
        env,
        `GM report generated but Telegram formatting failed: ${e instanceof Error ? e.message : "unknown"}`,
      );
    } catch (e) {
      logError("telegram_summary_fallback", e);
      // truly nothing we can do
    }
  }

  // 11. Log all decisions to SQLite
  for (const d of decisions) {
    try {
      await logDecision(env, d);
    } catch (e) {
      logError("decision_logging", e);
      // db logging is best-effort
    }
  }
  try {
    await logDecision(env, {
      type: "lineup",
      action: { routine: "daily_morning", date: today, gamesCount: games.length },
      reasoning: `Morning routine completed for ${today}`,
      result: "success",
    });
  } catch (e) {
    logError("completion_logging", e);
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Late scratch check (6pm ET)
// ---------------------------------------------------------------------------

export async function runLateScratchCheck(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const today = new Date().toISOString().slice(0, 10);

  let roster;
  let games: ScheduledGame[];
  try {
    [roster, games] = await Promise.all([yahoo.getRoster(today), getTodaysGames(today, env)]);
  } catch (e) {
    const msg = `Late scratch check failed: ${e instanceof Error ? e.message : "unknown"}`;
    logError("late_scratch_fetch", e);
    console.error(msg);
    try {
      await sendMessage(env, `<b>Late Scratch Error</b>\n${msg}`);
    } catch (e) {
      logError("late_scratch_telegram", e);
      // telegram send itself failed
    }
    return;
  }

  const injured = getInjuredActivePlayers(roster);
  const ilStatus = countILSlots(roster);

  const changes: string[] = [];

  if (injured.length > 0) {
    for (const entry of injured) {
      changes.push(
        `${entry.player.name} (${entry.player.status}) still in active slot ${entry.currentPosition}`,
      );
    }

    // Re-optimize lineup with empty projection map (best-effort with no projections)
    try {
      const moves = optimizeLineup(roster, new Map(), games);
      if (moves.length > 0) {
        const scratchMsg = formatLateScratchNotification(env, today, moves, injured, roster);
        await sendMessage(env, scratchMsg);
        changes.push(`Lineup re-optimization notified: ${moves.length} moves`);
      }
    } catch (e) {
      logError("late_scratch_reoptimize", e);
      changes.push(`Re-optimization failed: ${e instanceof Error ? e.message : "unknown"}`);
    }
  }

  if (changes.length > 0) {
    const msg = [
      `<b>Late Scratch Alert — ${today}</b>`,
      ...changes.map((c) => `• ${c}`),
      `IL slots: ${ilStatus.used}/${ilStatus.used + ilStatus.available} used`,
    ].join("\n");
    await sendMessage(env, msg);

    await logDecision(env, {
      type: "lineup",
      action: { routine: "late_scratch", changes },
      reasoning: `${changes.length} late changes detected`,
      result: "notified",
    });
  }
}

// ---------------------------------------------------------------------------
// Weekly matchup analysis (Monday morning)
// ---------------------------------------------------------------------------

export async function runWeeklyMatchupAnalysis(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);

  // --- Retrospective: analyze completed previous week before starting new analysis ---
  try {
    const currentMatchup = await yahoo.getMatchup();
    const prevWeek = currentMatchup.week - 1;
    if (prevWeek >= 1) {
      // Check if we already have a retrospective for this week
      const existing = await env.db
        .select({ week: retrospectives.week })
        .from(retrospectives)
        .where(eq(retrospectives.week, prevWeek))
        .get();

      if (!existing) {
        const prevMatchup = await yahoo.getMatchup(prevWeek);
        const retro = buildRetrospective(prevMatchup);

        // Store retrospective
        await env.db
          .insert(retrospectives)
          .values({ week: prevWeek, data: JSON.stringify(retro) })
          .onConflictDoUpdate({
            target: retrospectives.week,
            set: { data: JSON.stringify(retro) },
          });

        // Send Telegram summary
        await sendMessage(env, formatRetrospectiveForTelegram(retro));

        // Log decision for audit trail
        await logDecision(env, {
          type: "lineup",
          action: { routine: "retrospective", week: prevWeek, score: retro.finalScore },
          reasoning: `Week ${prevWeek} retrospective: ${retro.finalScore}`,
          result: "success",
        });

        // Generate compressed reflection from recent decisions + retrospective
        try {
          await generateReflection(env, []);
        } catch (e) {
          logError("reflection_generation", e);
        }
      }
    }
  } catch (e) {
    logError("weekly_retrospective", e);
  }

  let matchup;
  try {
    matchup = await yahoo.getMatchup();
  } catch (e) {
    logError("matchup_fetch", e);
    await sendMessage(
      env,
      `<b>Weekly Matchup</b>\nFailed to fetch matchup: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  let analysis: MatchupAnalysis | null = null;
  try {
    analysis = analyzeMatchup(matchup);
  } catch (e) {
    logError("matchup_analysis", e);
    await sendMessage(
      env,
      `<b>Weekly Matchup</b>\nAnalysis failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  // Opponent scouting
  let scoutReport = "";
  try {
    const myRoster = await yahoo.getRoster();
    const [rawBat, rawPit] = await Promise.all([
      fetchBatterProjections(undefined, env),
      fetchPitcherProjections(undefined, env),
    ]);
    const rosterPlayers = myRoster.entries.map((e) => e.player);
    const projMap = await buildProjectionMap(rawBat, rawPit, rosterPlayers, env);
    const allVals = computeZScores(projectionsToArray(projMap));
    const valMap = new Map(allVals.map((v) => [v.yahooId, v]));

    const myVals = myRoster.entries
      .map((e) => valMap.get(e.player.yahooId))
      .filter((v): v is PlayerValuation => !!v);

    // TODO: fetch opponent roster once API parsing is improved
    // For now, use category scores from matchup to infer opponent strength
    if (myVals.length > 0) {
      const needs = identifyCategoryNeeds(myVals);
      scoutReport = `\n<b>Our weakest cats:</b> ${needs.slice(0, 3).join(", ")}`;
    }
  } catch (e) {
    logError("opponent_scouting", e);
  }

  // Fetch standings rank (non-fatal)
  const rankInfo = await getOurRank(yahoo, buildTeamKey(env));

  // Reset weekly add budget on Monday
  try {
    const today = new Date().toISOString().slice(0, 10);
    await resetWeeklyBudget(env, today);
  } catch (e) {
    logError("weekly_budget_reset", e);
  }

  const lines = [
    `<b>Weekly Matchup Preview — Week ${matchup.week}</b>`,
    `vs. ${matchup.opponentTeamName}`,
    "",
    `<b>Projected:</b> ${analysis.projectedWins}W - ${analysis.projectedLosses}L - ${analysis.swingCategories.length} swing`,
    "",
  ];

  if (analysis.safeCategories.length > 0) {
    lines.push(`<b>Winning:</b> ${analysis.safeCategories.join(", ")}`);
  }
  if (analysis.swingCategories.length > 0) {
    lines.push(`<b>Swing:</b> ${analysis.swingCategories.join(", ")}`);
  }
  if (scoutReport) lines.push(scoutReport);
  if (analysis.lostCategories.length > 0) {
    lines.push(`<b>Losing:</b> ${analysis.lostCategories.join(", ")}`);
  }

  lines.push("");
  lines.push(`<b>Strategy:</b> ${analysis.strategy.benchMessage}`);

  // LLM: generate strategy memo with full briefing (supplemental)
  try {
    const matchupMemory = await buildMemoryContext(env, "matchup");
    const currentIP = getCurrentIP(matchup);
    const detailed = analyzeMatchupDetailed(matchup, 7);
    const ipInfo = getIPStatus(currentIP);
    const briefing = formatMatchupForLLM({
      summary: `Week ${matchup.week} vs ${matchup.opponentTeamName}, ${detailed.projectedWins}W-${detailed.projectedLosses}L, 7 days left`,
      categories: formatDetailedCategories(detailed),
      worthless:
        detailed.worthlessCategories.length > 0
          ? `${detailed.worthlessCategories.join(", ")} — production here is worthless`
          : "None — all categories still in play",
      streaming: `${detailed.streamingDecision.reasoning} (quality floor: ${detailed.streamingDecision.qualityFloor})`,
      ipStatus: `${ipInfo.currentIP.toFixed(1)} IP (${ipInfo.above ? "above" : "below"} ${ipInfo.minimum} min${ipInfo.ipNeeded > 0 ? `, need ${ipInfo.ipNeeded.toFixed(1)} more` : ""})`,
      opponentScouting: scoutReport || undefined,
      standings: rankInfo?.label,
      recentFeedback: await getRecentFeedback(env),
      memory: matchupMemory,
    });
    const prompt = matchupStrategyPrompt(briefing);
    const strategyMemo = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
    if (!strategyMemo.startsWith("[")) {
      lines.push("");
      lines.push(`<b>AI Strategy Memo:</b> ${strategyMemo}`);
    }
  } catch (e) {
    logError("matchup_strategy_llm", e);
  }

  try {
    await sendMessage(env, lines.join("\n"));
  } catch (e) {
    logError("matchup_send", e);
    await sendMessage(env, `Week ${matchup.week} analysis generated but send failed`);
  }

  await logDecision(env, {
    type: "lineup",
    action: {
      routine: "weekly_matchup",
      week: matchup.week,
      opponent: matchup.opponentTeamName,
      projected: `${analysis.projectedWins}-${analysis.projectedLosses}`,
      swing: analysis.swingCategories,
    },
    reasoning: `Week ${matchup.week} matchup analysis vs ${matchup.opponentTeamName}: ${analysis.projectedWins}W-${analysis.projectedLosses}L`,
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Mid-week adjustment (Wednesday)
// ---------------------------------------------------------------------------

export async function runMidWeekAdjustment(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);

  let matchup;
  try {
    matchup = await yahoo.getMatchup();
  } catch (e) {
    logError("midweek_matchup_fetch", e);
    await sendMessage(
      env,
      `<b>Mid-Week Adjustment</b>\nFailed to fetch matchup: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  let analysis: MatchupAnalysis | null = null;
  try {
    analysis = analyzeMatchup(matchup);
  } catch (e) {
    logError("midweek_analysis", e);
    await sendMessage(
      env,
      `<b>Mid-Week Adjustment</b>\nAnalysis failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  // Fetch standings rank (non-fatal)
  const rankInfo = await getOurRank(yahoo, buildTeamKey(env));

  // Build current category scoreboard
  const catLines: string[] = [];
  for (const cs of matchup.categories) {
    const indicator =
      cs.myValue > cs.opponentValue ? "+" : cs.myValue < cs.opponentValue ? "-" : "=";
    catLines.push(`  ${indicator} ${cs.category}: ${cs.myValue} vs ${cs.opponentValue}`);
  }

  const lines = [
    `<b>Mid-Week Adjustment — Week ${matchup.week}</b>`,
    `vs. ${matchup.opponentTeamName}`,
    "",
    `<b>Current scores:</b>`,
    ...catLines,
    "",
    `<b>Updated projection:</b> ${analysis.projectedWins}W - ${analysis.projectedLosses}L - ${analysis.swingCategories.length} swing`,
    "",
  ];

  if (analysis.swingCategories.length > 0) {
    lines.push(`<b>Swing cats:</b> ${analysis.swingCategories.join(", ")}`);
  }

  lines.push("");
  lines.push(`<b>Adjustments:</b> ${analysis.strategy.benchMessage}`);

  if (analysis.strategy.protectRatios) {
    lines.push("<b>Note:</b> Protecting ERA/WHIP lead — avoid streaming risky arms.");
  }
  if (analysis.strategy.streamPitchers) {
    lines.push("<b>Note:</b> Streaming pitchers recommended to chase counting stats.");
  }

  // LLM: mid-week tactical memo with full briefing (supplemental)
  try {
    const midweekMemory = await buildMemoryContext(env, "matchup");
    const currentIP = getCurrentIP(matchup);
    const detailed = analyzeMatchupDetailed(matchup, 4);
    const ipInfo = getIPStatus(currentIP);
    const briefing = formatMatchupForLLM({
      summary: `Mid-week ${matchup.week} vs ${matchup.opponentTeamName}, ${detailed.projectedWins}W-${detailed.projectedLosses}L, 4 days left`,
      categories: formatDetailedCategories(detailed),
      worthless:
        detailed.worthlessCategories.length > 0
          ? `${detailed.worthlessCategories.join(", ")} — production here is worthless`
          : "None — all categories still in play",
      streaming: `${detailed.streamingDecision.reasoning} (quality floor: ${detailed.streamingDecision.qualityFloor})`,
      ipStatus: `${ipInfo.currentIP.toFixed(1)} IP (${ipInfo.above ? "above" : "below"} ${ipInfo.minimum} min${ipInfo.ipNeeded > 0 ? `, need ${ipInfo.ipNeeded.toFixed(1)} more` : ""})`,
      standings: rankInfo?.label,
      recentFeedback: await getRecentFeedback(env),
      memory: midweekMemory,
    });
    const prompt = matchupStrategyPrompt(briefing);
    const strategyMemo = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
    if (!strategyMemo.startsWith("[")) {
      lines.push("");
      lines.push(`<b>AI Mid-Week Tactics:</b> ${strategyMemo}`);
    }
  } catch (e) {
    logError("midweek_tactics_llm", e);
  }

  try {
    await sendMessage(env, lines.join("\n"));
  } catch (e) {
    logError("midweek_send", e);
    await sendMessage(env, `Week ${matchup.week} mid-week adjustment generated but send failed`);
  }

  await logDecision(env, {
    type: "lineup",
    action: {
      routine: "midweek_adjustment",
      week: matchup.week,
      projected: `${analysis.projectedWins}-${analysis.projectedLosses}`,
      swing: analysis.swingCategories,
      strategy: analysis.strategy,
    },
    reasoning: `Mid-week adjustment for week ${matchup.week}: ${analysis.projectedWins}W-${analysis.projectedLosses}L, strategy: ${analysis.strategy.benchMessage}`,
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Trade evaluation (Saturday)
// ---------------------------------------------------------------------------

export async function runTradeEvaluation(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const lines: string[] = ["<b>Trade Evaluation Scan</b>"];

  // Fetch standings rank (non-fatal)
  const rankInfo = await getOurRank(yahoo, buildTeamKey(env));

  try {
    // 1. Fetch our roster + projections
    const roster = await yahoo.getRoster();
    const [batProj, pitProj] = await Promise.all([
      fetchBatterProjections(undefined, env),
      fetchPitcherProjections(undefined, env),
    ]);
    const rosterPlayers = roster.entries.map((e) => e.player);
    const projMap = await buildProjectionMap(batProj, pitProj, rosterPlayers, env);
    const projArr = projectionsToArray(projMap);
    const valuations = computeZScores(projArr);

    // 2. Identify our needs and surplus
    const needs = identifyCategoryNeeds(valuations);
    const surplus = identifySurplus(valuations);

    lines.push(`\nWeakest categories: ${needs.slice(0, 3).join(", ")}`);
    lines.push(
      `Surplus categories: ${surplus
        .slice(0, 3)
        .map((s) => s.category)
        .join(", ")}`,
    );

    // 3. Fetch other teams' rosters
    await yahoo.getTeamRosters();

    // TODO: parse other teams' rosters into valuations
    // For now, log that we scanned and send needs analysis
    lines.push("\nOther team roster parsing: coming next iteration");
    lines.push(`\nScanned ${needs.length} weak categories, ${surplus.length} surplus categories`);

    if (needs.length > 0 && surplus.length > 0) {
      lines.push("\n<b>Trade targets to explore:</b>");
      for (const s of surplus.slice(0, 2)) {
        const topPlayer = s.players[0];
        if (topPlayer) {
          lines.push(
            `• Could trade ${topPlayer.name} (surplus ${s.category}) for help in ${needs[0]}`,
          );
        }
      }

      // LLM: evaluate trade opportunities (supplemental — stats engine identified needs/surplus)
      try {
        const tradeMemory = await buildMemoryContext(env, "trade");
        const rosterSummary = roster.entries
          .map((e) => `${e.player.name} (${e.player.positions.join("/")})`)
          .join(", ");
        const surplusDesc = surplus
          .slice(0, 3)
          .map((s) => `${s.category}: ${s.players.map((p) => p.name).join(", ")}`)
          .join("; ");
        const briefing = formatTradeForLLM({
          roster: rosterSummary,
          needs: needs.join(", "),
          surplus: surplusDesc,
          targetInfo: "Scouting other teams — target teams with inverse category needs",
          standings: rankInfo?.label,
          memory: tradeMemory,
        });
        const prompt = tradeProposalPrompt(briefing);
        const tradeIdeas = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
        if (!tradeIdeas.startsWith("[")) {
          lines.push("");
          lines.push(`<b>AI Trade Ideas:</b> ${tradeIdeas}`);
        }
      } catch (e) {
        logError("trade_ideas_llm", e);
      }
    } else {
      lines.push("\nRoster is balanced — no urgent trade needs.");
    }
  } catch (e) {
    logError("trade_evaluation", e);
    lines.push(`\nError: ${e instanceof Error ? e.message : "unknown"}`);
  }

  await sendMessage(env, lines.join("\n"));

  await logDecision(env, {
    type: "trade",
    action: { routine: "trade_evaluation" },
    reasoning: lines.join(" | "),
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Real-time news monitor (every 30min)
// ---------------------------------------------------------------------------

export async function runNewsMonitor(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const today = new Date().toISOString().slice(0, 10);

  // 1. Fetch alerts
  let alerts: NewsAlert[];
  try {
    alerts = await getActionableAlerts(env);
  } catch (e) {
    logError("news_alert_fetch", e);
    return;
  }
  if (alerts.length === 0) return;

  // 1b. Dedup: filter out alerts already sent (KV-backed, 24h TTL)
  const sentKeys = await getSentAlertKeys(env);
  alerts = alerts.filter((a) => {
    const key = `${a.playerName}:${a.type}:${today}`;
    return !sentKeys.has(key);
  });
  if (alerts.length === 0) return;

  // 1c. Fetch today's schedule — only alert if player's game hasn't started yet
  let games: ScheduledGame[] = [];
  try {
    games = await getTodaysGames(today, env);
  } catch (e) {
    logError("news_schedule_fetch", e);
  }

  if (games.length > 0) {
    const now = Date.now();
    alerts = alerts.filter((a) => {
      if (!a.team) return true; // no team info = can't filter, send it
      // Find the game for this player's team
      const game = games.find((g) => g.homeTeam === a.team || g.awayTeam === a.team);
      if (!game) return true; // team not playing today = always actionable (e.g., trade/IL move)
      if (game.status === "final") return false; // game over, too late
      if (game.gameTime) {
        const startTime = new Date(game.gameTime).getTime();
        // Alert is actionable if game hasn't started yet (15min buffer for late scratches)
        return now < startTime + 15 * 60 * 1000;
      }
      // No gameTime available but game isn't final — still actionable
      return true;
    });
    if (alerts.length === 0) return;
  }

  // 2. Fetch roster for relevance filtering (light call, runs every 30min)
  let rosterNames: string[] = [];
  try {
    const roster = await yahoo.getRoster();
    rosterNames = roster.entries.map((e) => e.player.name);
  } catch (e) {
    logError("news_roster_fetch", e);
  }

  // 3. Filter + enrich alerts
  const messageParts: string[] = [];
  let urgentWaiverFlag = false;

  for (const alert of alerts) {
    const relevance =
      rosterNames.length > 0
        ? classifyAlertRelevance(alert, rosterNames)
        : ("OUR_PLAYER" as AlertRelevance); // no roster = send everything

    if (!shouldSendAlert(alert, relevance)) continue;

    const tag =
      relevance === "OUR_PLAYER" ? " [ROSTER]" : relevance === "FREE_AGENT" ? " [FA]" : "";
    let line = formatAlertForTelegram(alert) + tag;

    // LLM injury assessment for injury + closer_change alerts
    if (alert.type === "injury" || alert.type === "closer_change") {
      try {
        const newsInjuryMemory = await buildMemoryContext(env, "injury");
        const rosterCtx =
          relevance === "OUR_PLAYER"
            ? `ON OUR ROSTER. Team: ${alert.team}. ${alert.fantasyImpact}`
            : `Free agent. Team: ${alert.team}. ${alert.fantasyImpact}`;
        const briefing = formatInjuryForLLM({
          player: alert.playerName,
          injury: alert.headline,
          rosterContext: rosterCtx,
          ilSlots: relevance === "OUR_PLAYER" ? "Check roster" : "N/A",
          memory: newsInjuryMemory,
        });
        const prompt = injuryAssessmentPrompt(briefing);
        const assessment = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
        if (!assessment.startsWith("[")) {
          line += `\n  → AI: ${assessment}`;
        }
      } catch (e) {
        logError("news_injury_llm", e);
      }
    }

    // Flag closer changes for urgent waiver consideration
    if (alert.type === "closer_change" && relevance === "FREE_AGENT") {
      urgentWaiverFlag = true;
    }

    messageParts.push(line);
  }

  if (messageParts.length === 0) return;

  // 4. Build and send message
  const header = urgentWaiverFlag
    ? "<b>🚨 News Alert (URGENT — closer change detected)</b>"
    : "<b>News Alert</b>";
  const msg = [header, ...messageParts].join("\n");

  try {
    await sendMessage(env, msg);
    // Mark all alerts as sent after successful delivery (KV-backed, 24h TTL)
    const newKeys = alerts.map((a) => `${a.playerName}:${a.type}:${today}`);
    await addSentAlertKeys(env, newKeys);
  } catch (e) {
    logError("news_monitor_send", e);
  }

  // 5. Log
  try {
    await logDecision(env, {
      type: "waiver",
      action: {
        routine: "news_monitor",
        alertCount: messageParts.length,
        urgentWaiver: urgentWaiverFlag,
      },
      reasoning: `News monitor: ${messageParts.length} relevant alerts${urgentWaiverFlag ? " (urgent closer change)" : ""}`,
      result: "success",
    });
  } catch (e) {
    logError("news_monitor_log", e);
  }
}

// ---------------------------------------------------------------------------
// Sunday tactical analysis (Sunday 10am ET — final day of matchup week)
// ---------------------------------------------------------------------------

export async function runSundayTactics(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);

  let matchup;
  try {
    matchup = await yahoo.getMatchup();
  } catch (e) {
    logError("sunday_matchup_fetch", e);
    await sendMessage(
      env,
      `<b>Sunday Tactics</b>\nFailed to fetch matchup: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  try {
    const today = new Date().toISOString().slice(0, 10);
    await yahoo.getRoster(today); // validate roster access
  } catch (e) {
    logError("sunday_roster_fetch", e);
    await sendMessage(
      env,
      `<b>Sunday Tactics</b>\nRoster fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  // Fetch standings rank (non-fatal)
  const rankInfo = await getOurRank(yahoo, buildTeamKey(env));

  // Detailed matchup analysis with 1 day remaining
  const detailed = analyzeMatchupDetailed(matchup, 1);
  const currentIP = getCurrentIP(matchup);
  const ipInfo = getIPStatus(currentIP);

  // Build category scoreboard with +/- indicators
  const catLines: string[] = [];
  for (const cs of matchup.categories) {
    const indicator =
      cs.myValue > cs.opponentValue ? "+" : cs.myValue < cs.opponentValue ? "-" : "=";
    catLines.push(`  ${indicator} ${cs.category}: ${cs.myValue} vs ${cs.opponentValue}`);
  }

  // Build rich LLM briefing with ALL available data
  const sundayMemory = await buildMemoryContext(env, "matchup");
  const briefing = formatMatchupForLLM({
    summary: `FINAL DAY Week ${matchup.week} vs ${matchup.opponentTeamName}, ${detailed.projectedWins}W-${detailed.projectedLosses}L-${detailed.swingCategories.length}T, 1 day left`,
    categories: formatDetailedCategories(detailed),
    worthless:
      detailed.worthlessCategories.length > 0
        ? `${detailed.worthlessCategories.join(", ")} — production here is worthless`
        : "None — all categories still in play",
    streaming: `${detailed.streamingDecision.reasoning} (quality floor: ${detailed.streamingDecision.qualityFloor})`,
    ipStatus: `${ipInfo.currentIP.toFixed(1)} IP (${ipInfo.above ? "above" : "below"} ${ipInfo.minimum} min${ipInfo.ipNeeded > 0 ? `, need ${ipInfo.ipNeeded.toFixed(1)} more` : ""})`,
    addBudget: `${(await getAddBudget(env)).addsRemaining} adds remaining`,
    standings: rankInfo?.label,
    recentFeedback: await getRecentFeedback(env),
    memory: sundayMemory,
  });

  let aiTactics = "";
  try {
    const prompt = matchupStrategyPrompt(briefing);
    aiTactics = await askLLM(env, prompt.system, prompt.user, prompt.touchpoint);
  } catch (e) {
    logError("sunday_tactics_llm", e);
    aiTactics = `LLM failed: ${e instanceof Error ? e.message : "unknown"}`;
  }

  const score = `${detailed.projectedWins}-${detailed.projectedLosses}-${detailed.swingCategories.length}`;
  const lines = [
    `<b>Sunday Tactics — Week ${matchup.week} Final Day</b>`,
    `vs. ${matchup.opponentTeamName} | Score: ${score}`,
    "",
    ...catLines,
    "",
    `IP: ${ipInfo.currentIP.toFixed(1)} / ${ipInfo.minimum} min${ipInfo.ipNeeded > 0 ? ` (need ${ipInfo.ipNeeded.toFixed(1)} more)` : " (met)"}`,
    "",
    `<b>AI Tactics:</b> ${aiTactics}`,
  ];

  try {
    await sendMessage(env, lines.join("\n"));
  } catch (e) {
    logError("sunday_send", e);
    try {
      await sendMessage(env, `Sunday tactics generated for week ${matchup.week} but send failed`);
    } catch (e) {
      logError("sunday_send_fallback", e);
    }
  }

  await logDecision(env, {
    type: "lineup",
    action: {
      routine: "sunday_tactics",
      week: matchup.week,
      opponent: matchup.opponentTeamName,
      score,
      worthless: detailed.worthlessCategories,
      swing: detailed.swingCategories,
      ip: ipInfo.currentIP,
    },
    reasoning: `Sunday tactics for week ${matchup.week}: ${score} vs ${matchup.opponentTeamName}`,
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Friday two-start SP preview (Friday 10am ET)
// ---------------------------------------------------------------------------

export async function runTwoStartPreview(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);

  // Compute next week's Mon-Sun date range
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun
  // Days until next Monday: if Sun=0 -> 1, Mon=1 -> 7, Tue=2 -> 6, etc.
  const daysUntilMon = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
  const nextMon = new Date(today.getTime() + daysUntilMon * 86400000);
  const nextSun = new Date(nextMon.getTime() + 6 * 86400000);
  const weekStart = nextMon.toISOString().slice(0, 10);
  const weekEnd = nextSun.toISOString().slice(0, 10);

  // Current matchup week + 1 for display
  let currentWeek = 0;
  try {
    const matchup = await yahoo.getMatchup();
    currentWeek = matchup.week;
  } catch (e) {
    logError("two_start_week_fetch", e);
  }
  const nextWeek = currentWeek > 0 ? currentWeek + 1 : 0;

  let twoStarters;
  try {
    twoStarters = await getTwoStartPitchers(weekStart, weekEnd);
  } catch (e) {
    logError("two_start_fetch", e);
    await sendMessage(
      env,
      `<b>Two-Start Preview</b>\nFailed to fetch two-start pitchers: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return;
  }

  if (twoStarters.length === 0) {
    await sendMessage(
      env,
      `<b>Two-Start Preview</b>\nNo two-start pitchers identified for ${weekStart} — ${weekEnd}. Probables may not be posted yet.`,
    );
    await logDecision(env, {
      type: "stream",
      action: { routine: "two_start_preview", weekStart, weekEnd, count: 0 },
      reasoning: "No two-start pitchers found (probables may not be posted)",
      result: "success",
    });
    return;
  }

  // Fetch free agent SPs from Yahoo
  let faSPs: Array<{ yahooId: string; name: string }> = [];
  try {
    faSPs = await yahoo.getFreeAgents("SP", 50);
  } catch (e) {
    logError("two_start_fa_fetch", e);
  }

  // Cross-reference: which two-start pitchers are available?
  const faNames = new Set(faSPs.map((p) => p.name.toLowerCase()));
  const available = twoStarters.filter((p) => faNames.has(p.name.toLowerCase()));
  const rostered = twoStarters.filter((p) => !faNames.has(p.name.toLowerCase()));

  // Get add budget
  const budget = await getAddBudget(env);

  const weekLabel = nextWeek > 0 ? ` — Week ${nextWeek}` : "";
  const lines = [
    `<b>Two-Start SP Preview${weekLabel}</b>`,
    `${budget.addsRemaining} adds remaining`,
    `${weekStart} to ${weekEnd}`,
    "",
  ];

  if (available.length > 0) {
    lines.push(`<b>Available two-start SPs (${available.length}):</b>`);
    for (const p of available) {
      const opponents = p.starts.map((s) => `vs ${s.opponent}`).join(" / ");
      const conf = p.confidence !== "confirmed" ? ` [${p.confidence}]` : "";
      lines.push(`  • ${p.name} (${p.team}) ${opponents}${conf}`);
    }
  } else {
    lines.push("No two-start SPs available on waivers.");
  }

  if (rostered.length > 0) {
    lines.push("");
    lines.push(`<b>Rostered two-start SPs (${rostered.length}):</b>`);
    for (const p of rostered.slice(0, 10)) {
      const opponents = p.starts.map((s) => `vs ${s.opponent}`).join(" / ");
      const conf = p.confidence !== "confirmed" ? ` [${p.confidence}]` : "";
      lines.push(`  • ${p.name} (${p.team}) ${opponents}${conf}`);
    }
  }

  if (available.length > 0) {
    lines.push("");
    lines.push("Consider grabbing before Sunday waivers process.");
  }

  try {
    await sendMessage(env, lines.join("\n"));
  } catch (e) {
    logError("two_start_send", e);
    try {
      await sendMessage(env, `Two-start preview generated but send failed`);
    } catch (e) {
      logError("two_start_send_fallback", e);
    }
  }

  await logDecision(env, {
    type: "stream",
    action: {
      routine: "two_start_preview",
      weekStart,
      weekEnd,
      totalTwoStarters: twoStarters.length,
      available: available.map((p) => p.name),
      rostered: rostered.slice(0, 10).map((p) => p.name),
    },
    reasoning: `Two-start preview: ${twoStarters.length} total, ${available.length} available on waivers`,
    result: "success",
  });
}

// ---------------------------------------------------------------------------
// Decision logging
// ---------------------------------------------------------------------------

export async function logDecision(env: Env, decision: Decision): Promise<void> {
  logDecisionEvent(decision.type, decision.action, decision.result);
  await env.db.insert(decisionsTable).values({
    type: decision.type,
    action: JSON.stringify(decision.action),
    reasoning: decision.reasoning ?? null,
    result: decision.result,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendProbablePitchers(lines: string[], games: ScheduledGame[]): void {
  const pitchers = games.flatMap((g) => {
    const out: string[] = [];
    if (g.homeProbable) out.push(`${g.homeProbable.name} (${g.homeTeam})`);
    if (g.awayProbable) out.push(`${g.awayProbable.name} (${g.awayTeam})`);
    return out;
  });
  if (pitchers.length > 0) {
    lines.push(
      `Probable SPs: ${pitchers.slice(0, 8).join(", ")}${pitchers.length > 8 ? "..." : ""}`,
    );
  }
}
