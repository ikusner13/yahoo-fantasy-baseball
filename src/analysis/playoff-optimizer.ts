import type { PlayerValuation } from "../types";

// --- Interfaces ---

export interface PlayoffWeekForecast {
  week: number;
  startDate: string;
  endDate: string;
  teamGameCounts: Map<string, number>; // team abbr → games that week
}

export interface PlayerPlayoffValue {
  yahooId: string;
  name: string;
  team: string;
  totalPlayoffGames: number; // across all playoff weeks
  avgGamesPerWeek: number;
  playoffMultiplier: number; // >1 = favorable schedule
  baseZScore: number;
  adjustedZScore: number; // base × playoff multiplier
}

// --- Constants ---

/** Historical average games per team per week (Mon-Sun) */
const AVG_GAMES_PER_WEEK = 6.2;

/** 2026 MLB season: week 1 starts Mon March 30 */
const SEASON_WEEK1_START = "2026-03-30";

const BASE = "https://statsapi.mlb.com/api/v1";

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

const ALL_TEAM_ABBRS = Object.values(ID_TO_ABBR);

// --- Date helpers ---

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekStartDate(week: number): string {
  return addDays(SEASON_WEEK1_START, (week - 1) * 7);
}

function weekEndDate(week: number): string {
  return addDays(weekStartDate(week), 6);
}

// --- Schedule fetching ---

async function fetchTeamGameCounts(
  startDate: string,
  endDate: string,
): Promise<Map<string, number>> {
  const url = `${BASE}/schedule?sportId=1&startDate=${startDate}&endDate=${endDate}&hydrate=team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const counts = new Map<string, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const dateEntry of json.dates ?? []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const game of dateEntry.games ?? []) {
      const homeAbbr =
        (game.teams?.home?.team?.abbreviation as string | undefined) ??
        (game.teams?.home?.team?.id != null
          ? ID_TO_ABBR[game.teams.home.team.id as number]
          : undefined);
      const awayAbbr =
        (game.teams?.away?.team?.abbreviation as string | undefined) ??
        (game.teams?.away?.team?.id != null
          ? ID_TO_ABBR[game.teams.away.team.id as number]
          : undefined);

      if (homeAbbr) counts.set(homeAbbr, (counts.get(homeAbbr) ?? 0) + 1);
      if (awayAbbr) counts.set(awayAbbr, (counts.get(awayAbbr) ?? 0) + 1);
    }
  }

  return counts;
}

// --- Team resolution ---

/**
 * Extract team abbreviation from player name string.
 * Callers typically format names as "FirstName LastName" with team stored separately,
 * but PlayerValuation.name may contain the team abbr. Falls back to empty string.
 */
function resolveTeam(name: string): string {
  // Sort by length descending so "CWS" matches before "WS", etc.
  const sorted = [...ALL_TEAM_ABBRS].sort((a, b) => b.length - a.length);
  for (const abbr of sorted) {
    // Word-boundary check: avoid matching "SF" inside "SFord"
    const re = new RegExp(`\\b${abbr}\\b`);
    if (re.test(name)) return abbr;
  }
  return "";
}

// --- Exports ---

/**
 * Build playoff week forecasts by fetching the MLB schedule for each playoff week.
 * Yahoo fantasy weeks run Mon-Sun. Week 1 = ~March 30 in 2026.
 */
export async function getPlayoffSchedule(
  playoffStartWeek: number,
  numWeeks: number,
): Promise<PlayoffWeekForecast[]> {
  const weeks: PlayoffWeekForecast[] = [];

  for (let i = 0; i < numWeeks; i++) {
    const week = playoffStartWeek + i;
    const start = weekStartDate(week);
    const end = weekEndDate(week);
    const teamGameCounts = await fetchTeamGameCounts(start, end);
    weeks.push({ week, startDate: start, endDate: end, teamGameCounts });
  }

  return weeks;
}

/**
 * Compute playoff-adjusted valuations for every player.
 * Players on teams with more games during playoff weeks get a multiplier boost.
 *
 * Team resolution: extracts team abbreviation from PlayerValuation.name.
 * Callers should enrich the name field with team info (e.g., "Mike Trout LAA")
 * or the player gets a neutral 1.0 multiplier.
 */
export function computePlayoffValues(
  valuations: PlayerValuation[],
  playoffSchedule: PlayoffWeekForecast[],
  positionMap: Record<string, string[]>,
): PlayerPlayoffValue[] {
  const numWeeks = playoffSchedule.length;
  if (numWeeks === 0) return [];

  // Total games per team across all playoff weeks
  const teamTotalGames = new Map<string, number>();
  for (const week of playoffSchedule) {
    for (const [team, games] of week.teamGameCounts) {
      teamTotalGames.set(team, (teamTotalGames.get(team) ?? 0) + games);
    }
  }

  const neutralTotal = numWeeks * AVG_GAMES_PER_WEEK;

  return valuations
    .filter((v) => positionMap[v.yahooId] != null)
    .map((v): PlayerPlayoffValue => {
      const team = resolveTeam(v.name);
      const totalGames = team ? (teamTotalGames.get(team) ?? neutralTotal) : neutralTotal;
      const avgGames = totalGames / numWeeks;
      const multiplier = avgGames / AVG_GAMES_PER_WEEK;

      return {
        yahooId: v.yahooId,
        name: v.name,
        team,
        totalPlayoffGames: totalGames,
        avgGamesPerWeek: avgGames,
        playoffMultiplier: multiplier,
        baseZScore: v.totalZScore,
        adjustedZScore: v.totalZScore * multiplier,
      };
    })
    .sort((a, b) => b.adjustedZScore - a.adjustedZScore);
}

/**
 * Identify trade targets based on playoff schedule advantage.
 * - buy: high multiplier players NOT on your roster
 * - sell: low multiplier players ON your roster
 */
export function getPlayoffTargets(
  playoffValues: PlayerPlayoffValue[],
  currentRoster: string[],
): { buy: PlayerPlayoffValue[]; sell: PlayerPlayoffValue[] } {
  const rosterSet = new Set(currentRoster);

  const buy = playoffValues
    .filter((p) => !rosterSet.has(p.yahooId) && p.playoffMultiplier > 1.05)
    .sort((a, b) => b.adjustedZScore - a.adjustedZScore);

  const sell = playoffValues
    .filter((p) => rosterSet.has(p.yahooId) && p.playoffMultiplier < 0.95)
    .sort((a, b) => a.playoffMultiplier - b.playoffMultiplier);

  return { buy, sell };
}

/**
 * Returns true when it's time to factor playoff schedule into decisions.
 * Activates 8 weeks before playoffs — enough lead time for trade acquisitions.
 */
export function shouldActivatePlayoffMode(currentWeek: number, playoffStartWeek: number): boolean {
  return currentWeek >= playoffStartWeek - 8;
}
