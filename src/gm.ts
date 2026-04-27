import type {
  Env,
  Decision,
  Roster,
  Matchup,
  Player,
  ScheduledGame,
  PlayerProjection,
  PlayerValuation,
  LineupMove,
} from "./types";
// Monte Carlo simulation available for future matchup-level decisions
import { type DailyProjection } from "./analysis/monte-carlo";
import { YahooClient } from "./yahoo/client";
import { getTodaysGames } from "./data/mlb";
import { sendMessage } from "./notifications/telegram";
import {
  formatLineupNotification,
  formatILNotification,
  formatPickupNotification,
  formatStreamingNotification,
  formatPitcherPickupNotification,
  formatLateScratchNotification,
  type PickupNotificationItem,
} from "./notifications/action-messages";
import { getILMoves, countILSlots, getInjuredActivePlayers } from "./analysis/il-manager";
import {
  optimizeLineup,
  type ScoringContext,
  type TeamRateContext,
  type RateStatState,
} from "./analysis/lineup";
import {
  computeStreaks,
  getStreakSummary,
  type RecentPerformance,
} from "./analysis/recent-performance";
import { computeZScores, applyVarianceAdjustment } from "./analysis/valuations";
import { analyzeMatchup, analyzeMatchupDetailed, classifyCategory } from "./analysis/matchup";
import type { MatchupAnalysis, DetailedMatchupAnalysis } from "./analysis/matchup";
import { rankStreamingOptions, getIPStatus } from "./analysis/streaming";
import { rankPitcherPickups } from "./analysis/pitcher-pickups";
import { findBestPickups, findDroppablePlayer } from "./analysis/waivers";
import { fetchBatterProjections, fetchPitcherProjections } from "./data/projections";
import { identifyCategoryNeeds, identifySurplus } from "./analysis/trades";
import { askLLM } from "./ai/llm";
import { matchupStrategyPrompt, tradeProposalPrompt, injuryAssessmentPrompt } from "./ai/prompts";
import { formatMatchupForLLM, formatTradeForLLM, formatInjuryForLLM } from "./ai/briefing";
import { getWeekSchedule, findGameCountEdge } from "./analysis/game-count";
import { getTwoStartPitchers } from "./analysis/two-start";
import {
  getAddBudget,
  canSpendAdd,
  classifyAddPriority,
  resetWeeklyBudget,
} from "./analysis/add-budget";
import { getActionableAlerts, formatAlertForTelegram, enrichNewsAlerts } from "./monitors/news";
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
import { getImpliedRunsMap } from "./data/vegas";
import { loadTuning } from "./config/tuning";
import {
  estimateMatchupWinProbability,
  type MatchupProbabilitySnapshot,
} from "./recommendation/probability-engine";
import { scoreRecommendationConfidence, summarizeConfidence } from "./recommendation/confidence";
import { evaluateMatchupPickups } from "./recommendation/pickups";
import { buildWatchlistRecommendations } from "./recommendation/watchlist";
import { extractMentionedCategories } from "./recommendation/category-signals";
import { reviewWaiverRecommendation, shouldReviewPickup } from "./recommendation/waiver-review";
import { logDecisionEvent, logError, logRoutineStep } from "./observability/log";
import { buildMemoryContext, generateReflection } from "./ai/memory";
import { eq, desc, sql } from "drizzle-orm";
import { getEnvNow, getTodayIso } from "./time";
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
const MAX_WAIVER_REVIEWS_PER_RUN = 2;

function isDryRun(env: Env): boolean {
  return env._dryRun === true;
}

function formatWinOdds(probability: number): string {
  if (probability >= 0.995) return ">99%";
  if (probability <= 0.005) return "<1%";
  return `${Math.round(probability * 100)}%`;
}

function formatShortDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

async function timedRoutineStep<T>(
  step: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown> | ((result: T) => Record<string, unknown>),
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    logRoutineStep(
      step,
      Date.now() - start,
      typeof metadata === "function" ? metadata(result) : metadata,
    );
    return result;
  } catch (error) {
    logRoutineStep(step, Date.now() - start, {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function getDecisionsForDateRange(
  env: Env,
  startDate: string,
  endDate: string,
  week?: number,
): Promise<Array<{ id?: number; timestamp?: string; type: string; action: string; reasoning?: string | null }>> {
  const rows = await env.db
    .select({
      id: decisionsTable.id,
      timestamp: decisionsTable.timestamp,
      type: decisionsTable.type,
      action: decisionsTable.action,
      reasoning: decisionsTable.reasoning,
    })
    .from(decisionsTable)
    .orderBy(desc(decisionsTable.timestamp))
    .limit(400)
    .all();

  return rows
    .filter((row) => {
      const action = parseDecisionAction(row.action);
      const actionDate =
        readDecisionString(action.date) ??
        readDecisionString(action.weekStart) ??
        row.timestamp?.slice(0, 10);
      const actionWeek = readDecisionNumber(action.week);
      return (
        (!!actionDate && actionDate >= startDate && actionDate <= endDate) ||
        (week != null && actionWeek === week)
      );
    })
    .sort((a, b) => {
      if ((a.timestamp ?? "") !== (b.timestamp ?? "")) {
        return (a.timestamp ?? "").localeCompare(b.timestamp ?? "");
      }
      return (a.id ?? 0) - (b.id ?? 0);
    });
}

function parseDecisionAction(action: string): Record<string, unknown> {
  try {
    return JSON.parse(action) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readDecisionString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readDecisionNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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
  if (isDryRun(env)) return;
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
    // Only high-impact FA alerts: closer changes always, injuries for popular FAs
    return alert.type === "closer_change";
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

    // Persist matches to player_ids table (including mlbId from FanGraphs)
    if (env && matches.length > 0) {
      const projByFg = new Map<number, { name: string; team: string; mlbId?: number }>();
      for (const b of batters)
        projByFg.set(b.fangraphsId, { name: b.name, team: b.team, mlbId: b.mlbId });
      for (const p of pitchers)
        projByFg.set(p.fangraphsId, { name: p.name, team: p.team, mlbId: p.mlbId });

      const rows: PlayerIdRow[] = matches.map((m) => {
        const proj = projByFg.get(m.fangraphsId);
        return {
          yahooId: m.yahooId,
          mlbId: proj?.mlbId ?? null,
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

function buildRosterFromTeamPlayers(
  players: Player[],
  date: string,
): Roster {
  return {
    entries: players.map((player) => ({
      player,
      currentPosition: player.status === "IL" || player.status === "OUT" ? "IL" : "BN",
    })),
    date,
  };
}

async function buildOpponentProjectionContext(
  yahoo: YahooClient,
  matchup: Matchup,
  date: string,
  rawBatters: Awaited<ReturnType<typeof fetchBatterProjections>>,
  rawPitchers: Awaited<ReturnType<typeof fetchPitcherProjections>>,
  env: Env,
): Promise<{ opponentRoster: Roster; opponentProjectionMap: Map<string, PlayerProjection> } | undefined> {
  const teamRosters = await yahoo.getTeamRosters();
  const opponent = teamRosters.find((team) => team.teamKey === matchup.opponentTeamKey);
  if (!opponent || opponent.players.length === 0) return undefined;

  const opponentRoster = buildRosterFromTeamPlayers(opponent.players, date);
  const opponentProjectionMap = await buildProjectionMap(
    rawBatters,
    rawPitchers,
    opponent.players,
    env,
  );

  if (opponentProjectionMap.size === 0) return undefined;
  return { opponentRoster, opponentProjectionMap };
}

// ---------------------------------------------------------------------------
// Daily morning routine (9am ET)
// ---------------------------------------------------------------------------

export async function runDailyMorning(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const today = getTodayIso(env);
  const actionItems: string[] = []; // things the user needs to DO
  const summaryLines: string[] = []; // background context
  const decisions: Decision[] = [];
  let probabilitySnapshot: MatchupProbabilitySnapshot | null = null;
  let matchupConfidence: string | null = null;

  // 0. Fetch news alerts (filtered after roster is available)
  let rawAlerts: NewsAlert[] = [];
  try {
    rawAlerts = await timedRoutineStep(
      "daily_news_alerts",
      () => getActionableAlerts(env),
      (alerts) => ({ alerts: alerts.length }),
    );
  } catch (e) {
    logError("news_alerts", e);
  }

  // 1. Fetch roster
  let roster;
  try {
    roster = await timedRoutineStep(
      "daily_roster",
      () => yahoo.getRoster(today),
      (result) => ({ entries: result.entries.length }),
    );
  } catch (e) {
    logError("roster_fetch", e);
    await sendMessage(env, `Roster fetch failed: ${e instanceof Error ? e.message : "unknown"}`);
    return;
  }

  // 1b. Filter news alerts to roster-relevant items
  if (rawAlerts.length > 0) {
    const rosterNames = roster.entries.map((e) => e.player.name);
    for (const alert of rawAlerts) {
      const relevance = classifyAlertRelevance(alert, rosterNames);
      if (shouldSendAlert(alert, relevance)) {
        actionItems.push(formatAlertForTelegram(alert));
      }
    }
  }

  // 2. Fetch today's games
  let games: ScheduledGame[] = [];
  try {
    games = await timedRoutineStep(
      "daily_games",
      () => getTodaysGames(today, env),
      (result) => ({ games: result.length }),
    );
  } catch (e) {
    logError("games_fetch", e);
  }

  // 2b. Weekly game count analysis
  try {
    const edgeTeams = await timedRoutineStep("daily_week_schedule", async () => {
      const dayOfWeek = new Date(today).getDay();
      const weekStartOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const weekStart = new Date(new Date(today).getTime() + weekStartOffset * 86400000)
        .toISOString()
        .slice(0, 10);
      const weekEnd = new Date(new Date(weekStart).getTime() + 6 * 86400000)
        .toISOString()
        .slice(0, 10);
      const weekSchedule = await getWeekSchedule(weekStart, weekEnd);
      return findGameCountEdge(weekSchedule);
    }, (result) => ({ edgeTeams: result.length }));
    if (edgeTeams.length > 0) {
      summaryLines.push(`7-game teams: ${edgeTeams.join(", ")}`);
    }
  } catch (e) {
    logError("week_schedule", e);
  }

  // 3. Fetch projections from FanGraphs
  let projectionMap = new Map<string, PlayerProjection>();
  let allProjections: PlayerProjection[] = [];
  let valuations: PlayerValuation[] = [];
  let rawBatterProjections: Awaited<ReturnType<typeof fetchBatterProjections>> = [];
  let rawPitcherProjections: Awaited<ReturnType<typeof fetchPitcherProjections>> = [];
  let opponentProbabilityContext:
    | { opponentRoster: Roster; opponentProjectionMap: Map<string, PlayerProjection> }
    | undefined;
  try {
    const projectionResult = await timedRoutineStep("daily_projections", async () => {
      const [rawBatters, rawPitchers] = await Promise.all([
        fetchBatterProjections(undefined, env),
        fetchPitcherProjections(undefined, env),
      ]);
      const rosterForMatch = roster?.entries.map((e) => e.player) ?? [];
      const builtProjectionMap = await buildProjectionMap(rawBatters, rawPitchers, rosterForMatch, env);
      const builtProjections = projectionsToArray(builtProjectionMap);
      const rawValuations = computeZScores(builtProjections);
      const adjustedValuations = applyVarianceAdjustment(rawValuations, builtProjections);
      return {
        rawBatters,
        rawPitchers,
        builtProjectionMap,
        builtProjections,
        adjustedValuations,
      };
    }, (result) => ({
      batterProjections: result.rawBatters.length,
      pitcherProjections: result.rawPitchers.length,
      matchedPlayers: result.builtProjectionMap.size,
    }));
    rawBatterProjections = projectionResult.rawBatters;
    rawPitcherProjections = projectionResult.rawPitchers;
    projectionMap = projectionResult.builtProjectionMap;
    allProjections = projectionResult.builtProjections;
    valuations = projectionResult.adjustedValuations;
  } catch (e) {
    logError("projections_fetch", e);
    actionItems.push("Data issue: projections unavailable — lineup may be suboptimal");
  }

  // 5. Fetch current matchup for category weighting
  let matchup: Matchup | undefined;
  let matchupAnalysis: MatchupAnalysis | null = null;
  try {
    const matchupResult = await timedRoutineStep("daily_matchup", async () => {
      const currentMatchup = await yahoo.getMatchup();
      let currentMatchupAnalysis: MatchupAnalysis | null = null;
      let currentProbabilitySnapshot: MatchupProbabilitySnapshot | null = null;
      let currentConfidence: string | null = null;
      let currentOpponentContext:
        | { opponentRoster: Roster; opponentProjectionMap: Map<string, PlayerProjection> }
        | undefined;

      if (currentMatchup.categories.length > 0) {
        currentMatchupAnalysis = analyzeMatchup(currentMatchup);
        if (projectionMap.size > 0) {
          const weekSchedule = await getWeekSchedule(currentMatchup.weekStart, currentMatchup.weekEnd);
          try {
            if (rawBatterProjections.length > 0 || rawPitcherProjections.length > 0) {
              currentOpponentContext = await buildOpponentProjectionContext(
                yahoo,
                currentMatchup,
                today,
                rawBatterProjections,
                rawPitcherProjections,
                env,
              );
            }
          } catch (e) {
            logError("opponent_projection_context", e);
          }
          currentProbabilitySnapshot = estimateMatchupWinProbability(
            currentMatchup,
            roster,
            projectionMap,
            weekSchedule,
            {
              asOf: getEnvNow(env),
              simulations: 500,
              seed: 42,
              opponentRoster: currentOpponentContext?.opponentRoster,
              opponentProjectionMap: currentOpponentContext?.opponentProjectionMap,
            },
          );

          const swingCategoryRate =
            currentProbabilitySnapshot.categoryWinProbabilities.filter(
              (category) => category.winProbability >= 0.4 && category.winProbability <= 0.6,
            ).length / Math.max(currentProbabilitySnapshot.categoryWinProbabilities.length, 1);
          const dataQuality = Math.min(
            1,
            Math.min(
              projectionMap.size / Math.max(roster.entries.length, 1),
              currentOpponentContext
                ? currentOpponentContext.opponentProjectionMap.size /
                    Math.max(currentOpponentContext.opponentRoster.entries.length, 1)
                : 0.75,
            ),
          );
          const assessment = scoreRecommendationConfidence({
            delta: Math.abs(currentProbabilitySnapshot.winProbability - 0.5),
            deltaScale: 0.25,
            dataQuality,
            uncertainty: Math.min(1, swingCategoryRate * 0.7),
            signalAgreement: currentMatchupAnalysis ? 0.75 : 0.6,
          });
          currentConfidence = summarizeConfidence(assessment);
        }
      }

      return {
        currentMatchup,
        currentMatchupAnalysis,
        currentProbabilitySnapshot,
        currentConfidence,
        currentOpponentContext,
      };
    }, (result) => ({
      categories: result.currentMatchup.categories.length,
      hasProbabilitySnapshot: result.currentProbabilitySnapshot != null,
      opponentRosterSize: result.currentOpponentContext?.opponentRoster.entries.length ?? 0,
    }));
    matchup = matchupResult.currentMatchup;
    matchupAnalysis = matchupResult.currentMatchupAnalysis;
    probabilitySnapshot = matchupResult.currentProbabilitySnapshot;
    matchupConfidence = matchupResult.currentConfidence;
    opponentProbabilityContext = matchupResult.currentOpponentContext;
  } catch (e) {
    logError("matchup_fetch", e);
    // non-fatal, lineup optimization works without matchup context
  }

  const dailyDecisionContext = {
    date: today,
    week: matchup?.week,
    opponent: matchup?.opponentTeamName,
  };

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
      const statcast = await timedRoutineStep(
        "daily_statcast",
        () => getBatterStatcast(rosterMlbIds, 2026, env),
        (result) => ({ players: result.length }),
      );

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
        // Surface hot/cold streaks as actionable info
        if (streakSummaryText) {
          summaryLines.push(streakSummaryText);
        }
      }
    }
  } catch (e) {
    logError("statcast_fetch", e);
  }

  // Build per-player ScoringContext with park factors (static data, never fails)
  try {
    contextMap = new Map<string, ScoringContext>();
    for (const entry of roster.entries) {
      const team = entry.player.team;
      const game = games.find((g) => g.homeTeam === team || g.awayTeam === team);
      if (game) {
        const parkFactor = getParkFactor(game.homeTeam);
        contextMap.set(entry.player.yahooId, { parkFactor });
      }
    }
  } catch (e) {
    logError("park_factors", e);
    contextMap = undefined;
  }

  // 5c. Platoon splits — highest signal-to-noise daily factor for batter lineup decisions
  try {
    const platoonStart = Date.now();
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
    logRoutineStep("daily_platoon_splits", Date.now() - platoonStart, { players: platoonCount });
  } catch (e) {
    logError("platoon_splits", e);
  }

  // 5d. Inject z-scores into context map (proper player quality ranking)
  if (valuations.length > 0) {
    if (!contextMap) contextMap = new Map<string, ScoringContext>();
    const valMap = new Map(valuations.map((v) => [v.yahooId, v.totalZScore]));
    for (const entry of roster.entries) {
      const zScore = valMap.get(entry.player.yahooId);
      if (zScore != null) {
        const existing = contextMap.get(entry.player.yahooId) ?? {};
        contextMap.set(entry.player.yahooId, { ...existing, zScore });
      }
    }
  }

  // 5e. Inject team rate stat context for pitcher marginal impact scoring
  if (matchup && matchup.categories.length > 0) {
    try {
      if (!contextMap) contextMap = new Map<string, ScoringContext>();

      const currentIP = getCurrentIP(matchup);
      const eraStat = matchup.categories.find((c) => c.category === "ERA");
      const whipStat = matchup.categories.find((c) => c.category === "WHIP");

      if (eraStat && whipStat && currentIP > 0) {
        // Derive counting accumulators from rate stats
        const teamCurrentER = (eraStat.myValue * currentIP) / 9;
        const teamCurrentWhipNum = whipStat.myValue * currentIP;

        // Map classifyCategory output to RateStatState
        const toRateState = (c: "winning" | "losing" | "swing"): RateStatState =>
          c === "winning" ? "won" : c === "losing" ? "lost" : "swing";

        const eraState = toRateState(classifyCategory(eraStat));
        const whipState = toRateState(classifyCategory(whipStat));

        const teamRateContext: TeamRateContext = {
          teamCurrentER,
          teamCurrentIP: currentIP,
          teamCurrentWhipNum,
          eraState,
          whipState,
        };

        // Inject into context for all pitchers on roster
        for (const entry of roster.entries) {
          const isPitcher =
            entry.player.positions.includes("SP") || entry.player.positions.includes("RP");
          if (!isPitcher) continue;
          const existing = contextMap.get(entry.player.yahooId) ?? {};
          contextMap.set(entry.player.yahooId, { ...existing, teamRateContext });
        }
      }
    } catch (e) {
      logError("rate_context", e);
    }
  }

  // 6. IL moves
  try {
    const ilStart = Date.now();
    const ilActions = getILMoves(roster);
      if (ilActions.length > 0) {
      for (const a of ilActions) {
        actionItems.push(`IL: ${a.reasoning}`);
      }

      // Convert IL actions to lineup moves and execute
      const ilMoves: LineupMove[] = [];
      for (const a of ilActions) {
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
        } catch (e) {
          logError("il_notification", e);
        }
      }
    }
    decisions.push({
      type: "il",
      action: { routine: "daily_il", ...dailyDecisionContext, ilActions },
      reasoning: ilActions.map((a) => a.reasoning).join("; ") || "no moves",
      result: ilActions.length > 0 ? "notified" : "success",
    });
    logRoutineStep("daily_il", Date.now() - ilStart, { actions: ilActions.length });
  } catch (e) {
    logError("il_check", e);
  }

  // 7. Optimize lineup + AI analysis
  try {
    const lineupStart = Date.now();
    const moves = optimizeLineup(roster, projectionMap, games, matchup, streakMap, contextMap);

    // Separate starters from bench in optimized lineup
    const starterMoves = moves.filter((m) => m.position !== "BN" && m.position !== "IL");
    const benchMoves = moves.filter((m) => m.position === "BN");

    // Detect if most moves come from BN (fresh lineup day — user hasn't set lineup yet)
    const changedStarters = starterMoves.filter((m) => {
      const current = roster.entries.find((e) => e.player.yahooId === m.playerId)?.currentPosition;
      return current !== m.position;
    });
    const freshLineup = changedStarters.length > starterMoves.length * 0.7;

    // Compute bench reasons from algorithm data
    const benchReasons = new Map<string, string>();
    for (const m of benchMoves) {
      const entry = roster.entries.find((e) => e.player.yahooId === m.playerId);
      if (!entry) continue;
      const hasGame = games.some(
        (g) =>
          (g.homeTeam === entry.player.team || g.awayTeam === entry.player.team) &&
          g.status !== "final",
      );
      if (!hasGame) {
        benchReasons.set(m.playerId, "off day");
      } else if (!projectionMap.get(m.playerId)) {
        benchReasons.set(m.playerId, "no projection");
      } else {
        benchReasons.set(m.playerId, "outscored");
      }
    }

    if (starterMoves.length > 0 || benchMoves.length > 0) {
      const lineupMsg = formatLineupNotification(
        env,
        today,
        moves,
        roster,
        freshLineup,
        benchReasons,
      );
      await sendMessage(env, lineupMsg);
    }

    decisions.push({
      type: "lineup",
      action: {
        routine: "daily_lineup",
        ...dailyDecisionContext,
        moves: moves.length,
        targetCategories: matchupAnalysis?.swingCategories ?? [],
      },
      reasoning: `Set ${moves.length} lineup moves`,
      result: moves.length > 0 ? "notified" : "success",
    });
    logRoutineStep("daily_lineup", Date.now() - lineupStart, { moves: moves.length });
  } catch (e) {
    logError("lineup_optimization", e);
    actionItems.push("Lineup optimization failed — set lineup manually");
  }

  // 8. Waiver wire evaluation
  const budget = await getAddBudget(env);
  try {
    const waiverStart = Date.now();
    const freeAgents = await yahoo.getFreeAgents(undefined, 50);
    if (freeAgents.length > 0 && valuations.length > 0) {
      // Build valuation map for roster players
      const valMap = new Map<string, PlayerValuation>();
      for (const v of valuations) valMap.set(v.yahooId, v);

      let pickups = [];
      if (matchup) {
        const freeAgentProjectionMap = await buildProjectionMap(
          rawBatterProjections,
          rawPitcherProjections,
          freeAgents,
          env,
        );
        const weekSchedule = await getWeekSchedule(matchup.weekStart, matchup.weekEnd);
        pickups = evaluateMatchupPickups({
          roster,
          freeAgents,
          rosterValuations: valMap,
          rosterProjectionMap: projectionMap,
          freeAgentProjectionMap,
          matchup,
          weekSchedule,
          asOf: getEnvNow(env),
          simulations: 350,
          seed: 23,
          limit: 5,
          opponentRoster: opponentProbabilityContext?.opponentRoster,
          opponentProjectionMap: opponentProbabilityContext?.opponentProjectionMap,
        });
      } else {
        const freeAgentProjectionMap = await buildProjectionMap(
          rawBatterProjections,
          rawPitcherProjections,
          freeAgents,
          env,
        );
        const faProjectionValues = [...freeAgentProjectionMap.values()];
        const faValuations = applyVarianceAdjustment(
          computeZScores(faProjectionValues),
          faProjectionValues,
        );
        pickups = findBestPickups(
          faValuations,
          roster.entries,
          valMap,
          5,
          matchupAnalysis ?? undefined,
        );
      }

      if (pickups.length > 0) {
        const waiverReviewMemory =
          env.OPENROUTER_API_KEY || env.ANTHROPIC_API_KEY
            ? await buildMemoryContext(env, "review")
            : undefined;
        const reviewTargets = pickups
          .filter((rec) => shouldReviewPickup(rec))
          .slice(0, MAX_WAIVER_REVIEWS_PER_RUN);
        const reviewResults = await Promise.allSettled(
          reviewTargets.map(async (rec) => {
            const review = await reviewWaiverRecommendation(env, {
              recommendation: rec,
              matchup,
              addsRemaining: budget.addsRemaining,
              memory: waiverReviewMemory,
            });
            return [`${rec.add.yahooId}:${rec.drop.yahooId}`, review] as const;
          }),
        );
        const reviewMap = new Map<string, Awaited<ReturnType<typeof reviewWaiverRecommendation>>>();
        for (const result of reviewResults) {
          if (result.status !== "fulfilled") continue;
          const [key, review] = result.value;
          reviewMap.set(key, review);
        }
        const pickupNotifications: PickupNotificationItem[] = [];
        for (const rec of pickups) {
          const review = reviewMap.get(`${rec.add.yahooId}:${rec.drop.yahooId}`) ?? null;
          if (review?.verdict === "reject") continue;

          const reviewedReasoning =
            review == null
              ? rec.reasoning
              : `${rec.reasoning} Review: ${review.summary}${review.riskFlags.length > 0 ? ` Risks: ${review.riskFlags.join(", ")}.` : ""}`;
          const reasoningLower = reviewedReasoning.toLowerCase();
          const priority = classifyAddPriority(
            {
              ...rec,
              reasoning: reviewedReasoning,
            },
            {
            isCloserChange: reasoningLower.includes("closer") || reasoningLower.includes("saves"),
            isInjuryReplacement:
              reasoningLower.includes("injur") ||
              reasoningLower.includes("IL") ||
              rec.drop.status === "IL",
            },
          );

          // Check add budget before spending (type-aware)
          if (!canSpendAdd(budget, "waiver", priority)) continue;

          actionItems.push(
            rec.winProbabilityDelta != null
              ? `Pickup: add ${rec.add.name}, drop ${rec.drop.name} (${rec.winProbabilityDelta >= 0 ? "+" : ""}${(rec.winProbabilityDelta * 100).toFixed(1)}pp win odds)`
              : `Pickup: add ${rec.add.name}, drop ${rec.drop.name} (+${rec.netValue.toFixed(1)})`,
          );

          pickupNotifications.push({
            addName: rec.add.name,
            dropName: rec.drop.name,
            netValue: rec.netValue,
            winProbabilityDelta: rec.winProbabilityDelta,
            expectedCategoryWinsDelta: rec.expectedCategoryWinsDelta,
            priority,
            reasoning: reviewedReasoning,
            method: "waiver",
          });
          decisions.push({
            type: "waiver",
            action: {
              routine: "daily_waiver",
              ...dailyDecisionContext,
              add: rec.add.name,
              drop: rec.drop.name,
              net: rec.netValue,
              winProbabilityDelta: rec.winProbabilityDelta,
              expectedCategoryWinsDelta: rec.expectedCategoryWinsDelta,
              targetCategories: rec.targetCategories ?? extractMentionedCategories(rec.reasoning),
              reviewVerdict: review?.verdict,
              reviewRiskFlags: review?.riskFlags ?? [],
            },
            reasoning: reviewedReasoning,
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
          } catch (e) {
            logError("pickup_notification", e);
          }
        }
      }
    }
    logRoutineStep("daily_waiver_scan", Date.now() - waiverStart, {
      freeAgents: freeAgents.length,
      valuations: valuations.length,
    });
  } catch (e) {
    logError("waiver_scan", e);
  }

  // 9. Schedule-aware pitcher pickups (rest of matchup week)
  try {
    const streamingStart = Date.now();
    const faPitchers = await yahoo.getFreeAgents("SP", 25);
    if (faPitchers.length > 0) {
      // Match FA pitchers to FanGraphs projections by name/team
      const faForMatch = faPitchers.map((p) => ({
        yahooId: p.yahooId,
        name: p.name,
        team: p.team,
      }));
      const faProjEntries = rawPitcherProjections.map((p) => ({
        fangraphsId: p.fangraphsId,
        name: p.name,
        team: p.team,
      }));
      const { idMap: faIdMap } = buildPlayerIdMap(faForMatch, faProjEntries);
      const yahooToFgFA = new Map<string, number>();
      for (const [fgId, yId] of faIdMap) yahooToFgFA.set(yId, fgId);
      const pitcherByFg = new Map(rawPitcherProjections.map((p) => [p.fangraphsId, p]));

      // Enrich FA pitchers with mlbId from FanGraphs match or D1 database
      for (const p of faPitchers) {
        if (p.mlbId) continue;
        const fgId = yahooToFgFA.get(p.yahooId);
        const raw = fgId ? pitcherByFg.get(fgId) : undefined;
        if (raw?.mlbId) {
          p.mlbId = raw.mlbId;
        } else {
          const row = await lookupByYahooId(env, p.yahooId);
          if (row?.mlbId) p.mlbId = row.mlbId;
        }
      }

      const streamCandidates = faPitchers.map((p) => {
        const existing = projectionMap.get(p.yahooId);
        if (existing?.pitching) return { player: p, projection: existing.pitching };

        const fgId = yahooToFgFA.get(p.yahooId);
        const raw = fgId ? pitcherByFg.get(fgId) : undefined;
        return {
          player: p,
          projection: raw
            ? {
                ip: raw.ip,
                outs: Math.round(raw.ip * 3),
                k: raw.k,
                era: raw.era,
                whip: raw.whip,
                qs: raw.qs,
                svhd: raw.svhd,
              }
            : undefined,
        };
      });

      // Vegas implied runs → opponent wOBA
      const opponentWobas = new Map<string, number>();
      if (env.ODDS_API_KEY) {
        try {
          const impliedRuns = await getImpliedRunsMap(env.ODDS_API_KEY);
          for (const [team, runs] of impliedRuns) {
            opponentWobas.set(team, 0.32 * (runs / 4.5));
          }
        } catch (e) {
          logError("streaming_vegas", e);
        }
      }

      // Compute matchup window end date + streaming decision
      const now = getEnvNow(env);
      const dow = now.getDay();
      const daysRemaining = dow === 0 ? 1 : 8 - dow;
      const matchupEnd =
        matchup?.weekEnd ??
        new Date(now.getTime() + daysRemaining * 86400000).toISOString().slice(0, 10);

      let canStream = true;
      let minScore = 3.0;
      let streamReasoning = "No matchup data — streaming freely";
      let categoryStates;

      if (matchup) {
        const currentIP = getCurrentIP(matchup);
        const detailed = analyzeMatchupDetailed(matchup, daysRemaining, currentIP);
        const decision = detailed.streamingDecision;
        canStream = decision.canStream;
        streamReasoning = decision.reasoning;
        categoryStates = detailed.detailedCategories;

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

      if (canStream) {
        // Rank pitchers across all remaining starts in the matchup window
        const ranked = await rankPitcherPickups(streamCandidates, today, matchupEnd, {
          opponentWobas,
          categoryStates,
        });

        // Filter to pitchers with starts and above score threshold
        const viable = ranked.filter((r) => !r.noStartsInWindow && r.totalScore > minScore);

        if (viable.length > 0) {
          const top = viable[0];
          const topProj = top.projection;
          const metricsStr = topProj
            ? ` — ${topProj.era.toFixed(2)} ERA, ${(topProj.ip > 0 ? (topProj.k / topProj.ip) * 9 : 0).toFixed(1)} K/9`
            : "";

          const streamPriority = classifyAddPriority(
            { add: top.player, drop: top.player, netValue: top.totalScore, reasoning: "streaming" },
            {},
          );
          if (canSpendAdd(budget, "streaming", streamPriority)) {
            const streamValMap = new Map<string, PlayerValuation>();
            for (const v of valuations) streamValMap.set(v.yahooId, v);
            const dropEntry =
              findDroppablePlayer(roster.entries, streamValMap, ["SP", "RP"]) ??
              findDroppablePlayer(roster.entries, streamValMap) ??
              findDroppablePlayer(roster.entries, streamValMap, ["SP", "RP"], {
                eliteOverride: true,
              }) ??
              findDroppablePlayer(roster.entries, streamValMap, undefined, { eliteOverride: true });

            if (dropEntry) {
              const startsSummary = top.starts
                .map((s) => `${s.isHome ? "vs" : "@"} ${s.opponent}`)
                .join(", ");
              actionItems.push(
                `Stream: add ${top.player.name} (${startsSummary})${metricsStr}, drop ${dropEntry.player.name}`,
              );
              try {
                const streamMsg = formatPitcherPickupNotification(
                  env,
                  top,
                  dropEntry.player.name,
                  streamReasoning,
                  metricsStr,
                );
                await sendMessage(env, streamMsg);
                decisions.push({
                  type: "stream",
                  action: {
                    routine: "daily_stream",
                    ...dailyDecisionContext,
                    add: top.player.name,
                    drop: dropEntry.player.name,
                    score: top.totalScore,
                    targetCategories: extractMentionedCategories(top.reasoning, streamReasoning),
                    starts: top.starts.map((s) => ({
                      date: s.date,
                      opponent: s.opponent,
                      confidence: s.confidence,
                    })),
                    isTwoStart: top.isTwoStart,
                  },
                  reasoning: `${top.player.name}: ${top.reasoning} (score ${top.totalScore.toFixed(1)}, ${streamReasoning})`,
                  result: "notified",
                });
              } catch (e) {
                logError("stream_notification", e);
              }
            }
          }
        }
      }
    }
    logRoutineStep("daily_streaming_scan", Date.now() - streamingStart, {
      freeAgentPitchers: faPitchers.length,
    });
  } catch (e) {
    logError("streaming_analysis", e);
  }

  // 10. Build and send action-first summary
  const finalLines: string[] = [`<b>Today's Plan — ${today}</b>`];
  if (probabilitySnapshot) {
    const confidenceLine = matchupConfidence ? ` | <b>Confidence:</b> ${matchupConfidence}` : "";
    finalLines.push(
      "",
      `<b>Win Odds:</b> ${formatWinOdds(probabilitySnapshot.winProbability)} | <b>Expected Cats:</b> ${probabilitySnapshot.expectedCategoryWins.toFixed(1)}${confidenceLine}`,
    );
  }

  if (actionItems.length > 0) {
    finalLines.push("");
    for (const item of actionItems) finalLines.push(`• ${item}`);
  }

  // Strategy section: what to do to win the week
  if (matchupAnalysis) {
    const { swingCategories, lostCategories, safeCategories, strategy } = matchupAnalysis;
    finalLines.push("");
    finalLines.push(`<b>Strategy:</b>`);
    if (swingCategories.length > 0) {
      finalLines.push(`Chase: ${swingCategories.join(", ")}`);
    }
    if (safeCategories.length > 0) {
      finalLines.push(`Protect: ${safeCategories.join(", ")}`);
    }
    if (lostCategories.length > 0) {
      finalLines.push(`Ignore today: ${lostCategories.join(", ")}`);
    }

    // Concrete actions from strategy flags
    const actions: string[] = [];
    const avoid: string[] = [];
    if (strategy.protectRatios) actions.push("sit risky SPs to protect ERA/WHIP");
    if (strategy.chaseStrikeouts) actions.push("start high-K pitchers");
    if (strategy.prioritizePower) actions.push("start power bats");
    if (strategy.prioritizeSpeed) actions.push("start speed guys");
    if (strategy.streamPitchers) actions.push("stream pitchers for counting stats");
    if (strategy.protectRatios) avoid.push("risky SPs");
    if (lostCategories.length > 0) avoid.push("low-impact moves in ignored cats");
    if (actions.length > 0) {
      finalLines.push(`Today: ${actions.join(", ")}`);
    }
    if (avoid.length > 0) {
      finalLines.push(`Avoid: ${avoid.join(", ")}`);
    }
  }
  // Append AI context if available (already filtered to non-empty)
  if (summaryLines.length > 0) {
    finalLines.push("", ...summaryLines);
  }

  if (finalLines.length === 1) {
    finalLines.push("", "No changes needed today.");
  }

  try {
    const summaryStart = Date.now();
    await sendMessage(env, finalLines.join("\n"));
    logRoutineStep("daily_summary_send", Date.now() - summaryStart, {
      lines: finalLines.length,
      actionItems: actionItems.length,
    });
  } catch (e) {
    logError("telegram_summary", e);
    try {
      await sendMessage(env, `Today's Plan generated but send failed`);
    } catch (e) {
      logError("telegram_summary_fallback", e);
    }
  }

  // 11. Log all decisions to SQLite
  const decisionLoggingStart = Date.now();
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
      action: {
        routine: "daily_morning",
        ...dailyDecisionContext,
        gamesCount: games.length,
        winProbability: probabilitySnapshot?.winProbability,
        expectedCategoryWins: probabilitySnapshot?.expectedCategoryWins,
        confidence: matchupConfidence,
        safe: matchupAnalysis?.safeCategories ?? [],
        swing: matchupAnalysis?.swingCategories ?? [],
        lost: matchupAnalysis?.lostCategories ?? [],
      },
      reasoning: `Morning routine completed for ${today}`,
      result: "success",
    });
  } catch (e) {
    logError("completion_logging", e);
    // best-effort
  }
  logRoutineStep("daily_decision_logging", Date.now() - decisionLoggingStart, {
    decisions: decisions.length + 1,
  });
}

// ---------------------------------------------------------------------------
// Late scratch check (6pm ET)
// ---------------------------------------------------------------------------

export async function runLateScratchCheck(env: Env): Promise<void> {
  const yahoo = new YahooClient(env);
  const today = getTodayIso(env);

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
        const prevWeekDecisions = await getDecisionsForDateRange(
          env,
          prevMatchup.weekStart,
          prevMatchup.weekEnd,
          prevMatchup.week,
        );
        const retro = buildRetrospective(prevMatchup, undefined, prevWeekDecisions);

        if (!isDryRun(env)) {
          // Store retrospective
          await env.db
            .insert(retrospectives)
            .values({ week: prevWeek, data: JSON.stringify(retro) })
            .onConflictDoUpdate({
              target: retrospectives.week,
              set: { data: JSON.stringify(retro) },
            });
        }

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
        if (!isDryRun(env)) {
          try {
            await generateReflection(
              env,
              prevWeekDecisions
                .map((decision) => decision.id)
                .filter((id): id is number => typeof id === "number"),
            );
          } catch (e) {
            logError("reflection_generation", e);
          }
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
  let probabilitySnapshot:
    | {
        winProbability: number;
        expectedCategoryWins: number;
        daysRemaining: number;
      }
    | undefined;
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
    const weekSchedule = await getWeekSchedule(matchup.weekStart, matchup.weekEnd);
    const opponentProbabilityContext = await buildOpponentProjectionContext(
      yahoo,
      matchup,
      matchup.weekStart,
      rawBat,
      rawPit,
      env,
    );

    probabilitySnapshot = estimateMatchupWinProbability(matchup, myRoster, projMap, weekSchedule, {
      simulations: 1000,
      seed: 42,
      opponentRoster: opponentProbabilityContext?.opponentRoster,
      opponentProjectionMap: opponentProbabilityContext?.opponentProjectionMap,
    });

    const myVals = myRoster.entries
      .map((e) => valMap.get(e.player.yahooId))
      .filter((v): v is PlayerValuation => !!v);

    if (myVals.length > 0) {
      const needs = identifyCategoryNeeds(myVals);
      scoutReport = `\n<b>Our weakest cats:</b> ${needs.slice(0, 3).join(", ")}`;
      if (opponentProbabilityContext) {
        const oppVals = computeZScores(
          projectionsToArray(opponentProbabilityContext.opponentProjectionMap),
        );
        const oppStrengths = identifySurplus(oppVals)
          .slice(0, 3)
          .map((entry) => entry.category);
        if (oppStrengths.length > 0) {
          scoutReport += `\n<b>Opponent likely strengths:</b> ${oppStrengths.join(", ")}`;
        }
      }
    }
  } catch (e) {
    logError("opponent_scouting", e);
  }

  // Fetch standings rank (non-fatal)
  const rankInfo = await getOurRank(yahoo, buildTeamKey(env));

  // Reset weekly add budget on Monday
  try {
    const today = getTodayIso(env);
    await resetWeeklyBudget(env, today);
  } catch (e) {
    logError("weekly_budget_reset", e);
  }

  const lines = [
    `<b>Weekly Matchup Preview — Week ${matchup.week}</b>`,
    `vs. ${matchup.opponentTeamName}`,
    "",
    probabilitySnapshot
      ? `<b>Win Odds:</b> ${(probabilitySnapshot.winProbability * 100).toFixed(0)}% | <b>Expected Cats:</b> ${probabilitySnapshot.expectedCategoryWins.toFixed(1)}`
      : `<b>Current Read:</b> ${analysis.projectedWins}W - ${analysis.projectedLosses}L - ${analysis.swingCategories.length} swing`,
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
      summary: probabilitySnapshot
        ? `Week ${matchup.week} vs ${matchup.opponentTeamName}, ${(probabilitySnapshot.winProbability * 100).toFixed(0)}% win odds, ${probabilitySnapshot.expectedCategoryWins.toFixed(1)} expected categories, ${probabilitySnapshot.daysRemaining} days left`
        : `Week ${matchup.week} vs ${matchup.opponentTeamName}, ${detailed.projectedWins}W-${detailed.projectedLosses}L, 7 days left`,
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
        weekStart: matchup.weekStart,
        weekEnd: matchup.weekEnd,
        opponent: matchup.opponentTeamName,
        projected: `${analysis.projectedWins}-${analysis.projectedLosses}`,
        safe: analysis.safeCategories,
        swing: analysis.swingCategories,
        lost: analysis.lostCategories,
        winProbability: probabilitySnapshot?.winProbability,
        expectedCategoryWins: probabilitySnapshot?.expectedCategoryWins,
      },
    reasoning: probabilitySnapshot
      ? `Week ${matchup.week} matchup analysis vs ${matchup.opponentTeamName}: ${(probabilitySnapshot.winProbability * 100).toFixed(0)}% win odds, ${probabilitySnapshot.expectedCategoryWins.toFixed(1)} expected categories`
      : `Week ${matchup.week} matchup analysis vs ${matchup.opponentTeamName}: ${analysis.projectedWins}W-${analysis.projectedLosses}L`,
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

  // Classify categories into actionable groups
  const winning: string[] = [];
  const losing: string[] = [];
  const swing: string[] = [];
  for (const cs of matchup.categories) {
    const cat = cs.category;
    if (analysis.swingCategories.includes(cat)) {
      swing.push(`${cat} (${cs.myValue} vs ${cs.opponentValue})`);
    } else if (cs.myValue > cs.opponentValue) {
      winning.push(cat);
    } else if (cs.myValue < cs.opponentValue) {
      losing.push(cat);
    } else {
      swing.push(`${cat} (tied ${cs.myValue})`);
    }
  }

  // Build action-first message
  const lines = [
    `<b>Mid-Week — Week ${matchup.week} vs ${matchup.opponentTeamName}</b>`,
    `${analysis.projectedWins}W-${analysis.projectedLosses}L`,
    "",
  ];

  // DO section
  const doItems: string[] = [];
  if (swing.length > 0) doItems.push(`Chase: ${swing.join(", ")}`);
  if (winning.length > 0 && analysis.strategy.protectRatios) {
    doItems.push(`Protect: ${winning.join(", ")}`);
  }
  if (analysis.strategy.streamPitchers) doItems.push("Stream pitchers for counting stats");
  if (analysis.strategy.prioritizeSpeed) doItems.push("Start speed guys for SB");
  if (analysis.strategy.prioritizePower) doItems.push("Start power bats for HR/TB");
  if (analysis.strategy.chaseStrikeouts) doItems.push("Start high-K pitchers");
  if (doItems.length > 0) {
    lines.push("<b>DO:</b>");
    for (const item of doItems) lines.push(`• ${item}`);
  }

  // DON'T section
  if (analysis.lostCategories.length > 0) {
    lines.push("");
    lines.push(`<b>DON'T chase:</b> ${analysis.lostCategories.join(", ")} — too far behind`);
  }

  if (winning.length > 0) {
    lines.push("");
    lines.push(`<b>Winning:</b> ${winning.join(", ")}`);
  }

  // Concrete algorithmic context: IP status + streaming decision
  try {
    const currentIP = getCurrentIP(matchup);
    const detailed = analyzeMatchupDetailed(matchup, 4);
    const ipInfo = getIPStatus(currentIP);

    if (!ipInfo.above) {
      lines.push("");
      lines.push(
        `<b>IP alert:</b> ${ipInfo.currentIP.toFixed(1)}/${ipInfo.minimum} IP — need ${ipInfo.ipNeeded.toFixed(1)} more`,
      );
    }
    if (detailed.streamingDecision.canStream) {
      lines.push("");
      lines.push(
        `<b>Streaming:</b> ${detailed.streamingDecision.reasoning} (floor: ${detailed.streamingDecision.qualityFloor})`,
      );
    }
  } catch (e) {
    logError("midweek_context", e);
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
  const today = getTodayIso(env);

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
    const now = getEnvNow(env).getTime();
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

  try {
    alerts = await enrichNewsAlerts(env, alerts);
  } catch (e) {
    logError("news_alert_enrichment", e);
  }

  // 2. Fetch roster for relevance filtering (light call, runs every 30min)
  let rosterNames: string[] = [];
  let liveRoster: Roster | undefined;
  try {
    liveRoster = await yahoo.getRoster();
    rosterNames = liveRoster.entries.map((e) => e.player.name);
  } catch (e) {
    logError("news_roster_fetch", e);
  }

  const candidateWatchAlerts = alerts.filter(
    (alert) => alert.type === "closer_change" || alert.type === "callup",
  );
  let watchlistLines = new Map<string, string>();
  let urgentWatchFlag = false;

  if (liveRoster && candidateWatchAlerts.length > 0) {
    try {
      const freeAgents = await yahoo.getFreeAgents(undefined, 100);
      const [rawBatters, rawPitchers, matchup] = await Promise.all([
        fetchBatterProjections(undefined, env),
        fetchPitcherProjections(undefined, env),
        yahoo.getMatchup(),
      ]);

      const rosterPlayers = liveRoster.entries.map((entry) => entry.player);
      const rosterProjectionMap = await buildProjectionMap(rawBatters, rawPitchers, rosterPlayers, env);
      const rosterValuations = new Map(
        applyVarianceAdjustment(
          computeZScores([...rosterProjectionMap.values()]),
          [...rosterProjectionMap.values()],
        ).map((valuation) => [valuation.yahooId, valuation]),
      );
      const freeAgentProjectionMap = await buildProjectionMap(rawBatters, rawPitchers, freeAgents, env);
      const weekSchedule = await getWeekSchedule(matchup.weekStart, matchup.weekEnd);
      const pickupRecommendations = evaluateMatchupPickups({
        roster: liveRoster,
        freeAgents,
        rosterValuations,
        rosterProjectionMap,
        freeAgentProjectionMap,
        matchup,
        weekSchedule,
        asOf: getEnvNow(env),
        simulations: 300,
        seed: 31,
        limit: 8,
      });

      const watchlist = buildWatchlistRecommendations(
        candidateWatchAlerts,
        freeAgents,
        pickupRecommendations,
      );

      for (const recommendation of watchlist) {
        if (recommendation.tier === "monitor") continue;
        const prefix = recommendation.tier === "must_add_now" ? "  → MUST ADD: " : "  → WATCH: ";
        watchlistLines.set(
          `${recommendation.alert.playerName}:${recommendation.alert.type}`,
          `${prefix}${recommendation.summary}`,
        );
        if (recommendation.tier === "must_add_now") urgentWatchFlag = true;
      }
    } catch (e) {
      logError("news_watchlist_eval", e);
    }
  }

  // 3. Filter + enrich alerts
  const messageParts: string[] = [];
  let urgentWaiverFlag = false;

  for (const alert of alerts) {
    const relevance =
      rosterNames.length > 0
        ? classifyAlertRelevance(alert, rosterNames)
        : ("OUR_PLAYER" as AlertRelevance); // no roster = send everything

    const watchKey = `${alert.playerName}:${alert.type}`;
    const watchlistLine = watchlistLines.get(watchKey);

    if (!shouldSendAlert(alert, relevance) && !watchlistLine) continue;

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
    if (
      relevance === "FREE_AGENT" &&
      (
        alert.type === "closer_change" ||
        (
          alert.structured?.impactLevel === "high" &&
          alert.structured.actionBias === "add"
        )
      )
    ) {
      urgentWaiverFlag = true;
    }

    if (watchlistLine) {
      line += `\n${watchlistLine}`;
    }

    messageParts.push(line);
  }

  if (messageParts.length === 0) return;

  // 4. Build and send message
  const header = urgentWaiverFlag
    ? "<b>🚨 News Alert (URGENT — closer change detected)</b>"
    : urgentWatchFlag
      ? "<b>🚨 News Alert (URGENT — must-add candidate detected)</b>"
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
    const today = getTodayIso(env);
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
  const today = getEnvNow(env);
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
      const opponents = p.starts
        .map((s) => `${formatShortDate(s.date)} vs ${s.opponent}`)
        .join(" / ");
      const conf = p.confidence !== "confirmed" ? ` [${p.confidence}]` : "";
      lines.push(`  • ${p.name} (${p.team}) ${opponents}${conf}`);
    }
    lines.push("");
    lines.push("Consider grabbing before Sunday waivers process.");
  } else {
    lines.push("No actionable two-start SP adds on waivers right now.");
    lines.push("Hold your adds unless the waiver pool changes.");
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
  if (isDryRun(env)) return;
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

/** Build daily projection inputs for Monte Carlo from roster + projections + today's games. */
function _buildDailyProjections(
  roster: Roster,
  projectionMap: Map<string, PlayerProjection>,
  games: ScheduledGame[],
): DailyProjection[] {
  const ROS_GAMES = 130; // approximate remaining games for per-game conversion
  const projections: DailyProjection[] = [];

  for (const entry of roster.entries) {
    const p = entry.player;
    const proj = projectionMap.get(p.yahooId);
    if (!proj) continue;
    // Only include players with a game today
    const hasGame = games.some(
      (g) => (g.homeTeam === p.team || g.awayTeam === p.team) && g.status !== "final",
    );
    if (!hasGame) continue;

    if (proj.playerType === "batter" && proj.batting) {
      const b = proj.batting;
      const pa = b.pa / ROS_GAMES;
      projections.push({
        yahooId: p.yahooId,
        playerType: "batter",
        batting: {
          r: b.r / ROS_GAMES,
          h: b.h / ROS_GAMES,
          hr: b.hr / ROS_GAMES,
          rbi: b.rbi / ROS_GAMES,
          sb: b.sb / ROS_GAMES,
          tb: b.tb / ROS_GAMES,
          pa,
          obp_numerator: b.obp * pa,
        },
      });
    } else if (proj.playerType === "pitcher" && proj.pitching) {
      const pi = proj.pitching;
      const ipPerGame = pi.ip / ROS_GAMES;
      projections.push({
        yahooId: p.yahooId,
        playerType: "pitcher",
        pitching: {
          er: (pi.era * ipPerGame) / 9,
          outs: pi.outs / ROS_GAMES,
          k: pi.k / ROS_GAMES,
          qs: pi.qs / ROS_GAMES,
          svhd: pi.svhd / ROS_GAMES,
          whip_numerator: pi.whip * ipPerGame,
        },
      });
    }
  }

  return projections;
}
