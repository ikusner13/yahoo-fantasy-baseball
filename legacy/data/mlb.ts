import type { Env, ScheduledGame, ProbablePitcher } from "../types";
import { getCachedData, setCachedData } from "./cache";

const BASE = "https://statsapi.mlb.com/api/v1";

// All 30 MLB team abbreviations → API team IDs
const TEAM_IDS: Record<string, number> = {
  ARI: 109,
  ATL: 144,
  BAL: 110,
  BOS: 111,
  CHC: 112,
  CWS: 145,
  CIN: 113,
  CLE: 114,
  COL: 115,
  DET: 116,
  HOU: 117,
  KC: 118,
  LAA: 108,
  LAD: 119,
  MIA: 146,
  MIL: 158,
  MIN: 142,
  NYM: 121,
  NYY: 147,
  OAK: 133,
  PHI: 143,
  PIT: 134,
  SD: 135,
  SF: 137,
  SEA: 136,
  STL: 138,
  TB: 139,
  TEX: 140,
  TOR: 141,
  WSH: 120,
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function mapStatus(abstractState: string): "scheduled" | "in_progress" | "final" {
  switch (abstractState) {
    case "Live":
      return "in_progress";
    case "Final":
      return "final";
    default:
      return "scheduled";
  }
}

function parseProbable(
  pitcher: Record<string, unknown> | undefined | null,
  teamAbbr: string,
): ProbablePitcher | undefined {
  if (!pitcher || !pitcher.id) return undefined;
  return {
    mlbId: pitcher.id as number,
    name: pitcher.fullName as string,
    team: teamAbbr,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseGame(g: any): ScheduledGame {
  const homeAbbr: string = g.teams.home.team.abbreviation;
  const awayAbbr: string = g.teams.away.team.abbreviation;
  return {
    gameId: g.gamePk,
    date: g.officialDate,
    gameTime: g.gameDate as string | undefined, // ISO datetime from MLB API
    homeTeam: homeAbbr,
    awayTeam: awayAbbr,
    homeProbable: parseProbable(g.teams.home.probablePitcher, homeAbbr),
    awayProbable: parseProbable(g.teams.away.probablePitcher, awayAbbr),
    status: mapStatus(g.status.abstractGameState),
  };
}

export async function getTodaysGames(date?: string, env?: Env): Promise<ScheduledGame[]> {
  const d = date ?? today();

  if (env) {
    const cached = await getCachedData<ScheduledGame[]>(env, `mlb_schedule_${d}`, 2);
    if (cached) return cached;
  }

  const url = `${BASE}/schedule?sportId=1&date=${d}&hydrate=probablePitcher(note),team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB schedule fetch failed: ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const games = json.dates?.[0]?.games ?? [];
  const result: ScheduledGame[] = games.map(parseGame);

  if (env) {
    await setCachedData(env, `mlb_schedule_${d}`, JSON.stringify(result));
  }

  return result;
}

export async function getInjuries(): Promise<
  Array<{ mlbId: number; name: string; team: string; status: string }>
> {
  // MLB Stats API has no /injuries endpoint — use recent IL transactions
  const end = today();
  const start = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
  const url = `${BASE}/transactions?sportId=1&startDate=${start}&endDate=${end}&transactionTypes=injured_list`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB injuries fetch failed: ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const seen = new Set<number>();
  const results: Array<{ mlbId: number; name: string; team: string; status: string }> = [];

  for (const tx of json.transactions ?? []) {
    const player = tx.person;
    if (!player?.id || seen.has(player.id)) continue;
    // Only include placements, not activations
    if (tx.typeCode === "PL" || tx.description?.includes("placed")) {
      seen.add(player.id);
      results.push({
        mlbId: player.id,
        name: player.fullName ?? "",
        team: tx.team?.abbreviation ?? tx.fromTeam?.abbreviation ?? "",
        status: tx.typeDesc ?? "IL",
      });
    }
  }
  return results;
}

export async function getTeamSchedule(
  teamAbbr: string,
  startDate: string,
  endDate: string,
): Promise<ScheduledGame[]> {
  const teamId = TEAM_IDS[teamAbbr.toUpperCase()];
  if (!teamId) throw new Error(`Unknown team abbreviation: ${teamAbbr}`);
  const url = `${BASE}/schedule?sportId=1&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&hydrate=probablePitcher(note),team`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MLB team schedule fetch failed: ${res.status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  // schedule can span multiple dates
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (json.dates ?? []).flatMap((d: any) => (d.games ?? []).map(parseGame));
}
