import type { Player } from "../types";

// --- Interfaces ---

export interface TeamWeekSchedule {
  team: string;
  gamesThisWeek: number;
  gamesRemaining: number;
  opponents: string[];
}

export interface RosterGameCount {
  totalGames: number;
  avgGamesPerPlayer: number;
  teamBreakdown: TeamWeekSchedule[];
  advantageVsOpponent?: number;
}

// --- Constants ---

/** Historical average games per team per week (Mon-Sun) */
const AVG_GAMES_PER_WEEK = 6.2;

// Reverse lookup: MLB Stats API team ID → abbreviation
const ID_TO_ABBR: Record<number, string> = {
  109: "ARI",
  144: "ATL",
  110: "BAL",
  111: "BOS",
  112: "CHC",
  145: "CWS",
  113: "CIN",
  114: "CLE",
  115: "COL",
  116: "DET",
  117: "HOU",
  118: "KC",
  108: "LAA",
  119: "LAD",
  146: "MIA",
  158: "MIL",
  142: "MIN",
  121: "NYM",
  147: "NYY",
  133: "OAK",
  143: "PHI",
  134: "PIT",
  135: "SD",
  137: "SF",
  136: "SEA",
  138: "STL",
  139: "TB",
  140: "TEX",
  141: "TOR",
  120: "WSH",
};

// --- Schedule fetching ---

/**
 * Fetch MLB schedule for a date range and count games per team.
 * Returns Map keyed by team abbreviation.
 */
export async function getWeekSchedule(
  startDate: string,
  endDate: string,
): Promise<Map<string, TeamWeekSchedule>> {
  const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();

  // Accumulate per-team game counts and opponents
  const teamMap = new Map<string, { games: number; opponents: Set<string> }>();

  const ensureTeam = (abbr: string) => {
    if (!teamMap.has(abbr)) teamMap.set(abbr, { games: 0, opponents: new Set() });
    return teamMap.get(abbr)!;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const dateEntry of json.dates ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const game of dateEntry.games ?? []) {
      const homeId: number | undefined = game.teams?.home?.team?.id;
      const awayId: number | undefined = game.teams?.away?.team?.id;
      const homeAbbr =
        (game.teams?.home?.team?.abbreviation as string | undefined) ??
        (homeId != null ? ID_TO_ABBR[homeId] : undefined);
      const awayAbbr =
        (game.teams?.away?.team?.abbreviation as string | undefined) ??
        (awayId != null ? ID_TO_ABBR[awayId] : undefined);

      if (!homeAbbr || !awayAbbr) continue;

      const home = ensureTeam(homeAbbr);
      home.games++;
      home.opponents.add(awayAbbr);

      const away = ensureTeam(awayAbbr);
      away.games++;
      away.opponents.add(homeAbbr);
    }
  }

  // Calculate remaining games relative to today
  const todayStr = new Date().toISOString().slice(0, 10);
  const gamesPlayed = new Map<string, number>();

  // Count games already played (dates before today)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const dateEntry of json.dates ?? []) {
    if ((dateEntry.date as string) >= todayStr) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const game of dateEntry.games ?? []) {
      const homeAbbr =
        (game.teams?.home?.team?.abbreviation as string | undefined) ??
        (game.teams?.home?.team?.id != null ? ID_TO_ABBR[game.teams.home.team.id] : undefined);
      const awayAbbr =
        (game.teams?.away?.team?.abbreviation as string | undefined) ??
        (game.teams?.away?.team?.id != null ? ID_TO_ABBR[game.teams.away.team.id] : undefined);

      if (homeAbbr) gamesPlayed.set(homeAbbr, (gamesPlayed.get(homeAbbr) ?? 0) + 1);
      if (awayAbbr) gamesPlayed.set(awayAbbr, (gamesPlayed.get(awayAbbr) ?? 0) + 1);
    }
  }

  const result = new Map<string, TeamWeekSchedule>();
  for (const [abbr, data] of teamMap) {
    const played = gamesPlayed.get(abbr) ?? 0;
    result.set(abbr, {
      team: abbr,
      gamesThisWeek: data.games,
      gamesRemaining: data.games - played,
      opponents: [...data.opponents],
    });
  }

  return result;
}

// --- Roster analysis ---

/**
 * Sum games across all rostered players' teams and compute advantage vs opponent.
 */
export function analyzeRosterGameCount(
  myRoster: Player[],
  opponentRoster: Player[],
  weekSchedule: Map<string, TeamWeekSchedule>,
): RosterGameCount {
  const sumGames = (roster: Player[]): { total: number; breakdown: TeamWeekSchedule[] } => {
    let total = 0;
    const seen = new Set<string>();
    const breakdown: TeamWeekSchedule[] = [];

    for (const player of roster) {
      const sched = weekSchedule.get(player.team);
      if (!sched) continue;
      total += sched.gamesThisWeek;
      if (!seen.has(player.team)) {
        seen.add(player.team);
        breakdown.push(sched);
      }
    }
    return { total, breakdown };
  };

  const my = sumGames(myRoster);
  const opp = sumGames(opponentRoster);

  return {
    totalGames: my.total,
    avgGamesPerPlayer: myRoster.length > 0 ? my.total / myRoster.length : 0,
    teamBreakdown: my.breakdown,
    advantageVsOpponent: my.total - opp.total,
  };
}

// --- Edge finders ---

/**
 * Return teams with 7 games this week (max in a Mon-Sun matchup).
 * These are prime streaming targets — extra games = extra counting stats.
 */
export function findGameCountEdge(weekSchedule: Map<string, TeamWeekSchedule>): string[] {
  const targets: string[] = [];
  for (const [abbr, sched] of weekSchedule) {
    if (sched.gamesThisWeek >= 7) targets.push(abbr);
  }
  return targets;
}

/**
 * Compute a multiplier for counting stat expectations based on game count.
 * Average ~6.2 games/week: 7 games → 1.13x, 5 games → 0.81x.
 */
export function computeGameCountMultiplier(
  playerTeam: string,
  weekSchedule: Map<string, TeamWeekSchedule>,
): number {
  const sched = weekSchedule.get(playerTeam);
  if (!sched) return 1.0;
  return sched.gamesThisWeek / AVG_GAMES_PER_WEEK;
}
