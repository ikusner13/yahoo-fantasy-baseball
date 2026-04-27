import type {
  Category,
  Env,
  Roster,
  RosterEntry,
  Player,
  Matchup,
  CategoryScore,
} from "../types";
import { getValidToken } from "./auth";
import { logApiCall } from "../observability/log";

// --- Yahoo league transaction types ---

export interface LeagueTransactionPlayer {
  playerKey: string;
  name: string;
  type: string; // "add", "drop", "trade"
  sourceTeamKey: string;
  destinationTeamKey: string;
}

export interface LeagueTransaction {
  transactionKey: string;
  type: string; // "add/drop", "trade", "waiver"
  timestamp: string; // ISO string
  status: string; // "successful", "pending", etc.
  players: LeagueTransactionPlayer[];
}

/** Yahoo stat_id → our Category type. Only scoring categories (not display-only like IP/H/AB). */
export const STAT_ID_TO_CATEGORY: Record<string, Category> = {
  "7": "R",
  "8": "H",
  "12": "HR",
  "13": "RBI",
  "16": "SB",
  "23": "TB",
  "4": "OBP",
  "33": "OUT",
  "42": "K",
  "26": "ERA",
  "27": "WHIP",
  "83": "QS",
  "89": "SVHD",
};

const BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";

// TODO: discover game key dynamically via /fantasy/v2/game/mlb
const GAME_KEY = "mlb";

// --- Standings types ---

export interface StandingsEntry {
  teamKey: string;
  teamName: string;
  rank: number;
  wins: number;
  losses: number;
  ties: number;
  percentage: number;
}

// --- Team roster types ---

export interface TeamRoster {
  teamKey: string;
  teamName: string;
  players: Player[];
}

export class YahooClient {
  constructor(private env: Env) {}

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private getLeagueKey(): string {
    return `${GAME_KEY}.l.${this.env.YAHOO_LEAGUE_ID}`;
  }

  private getTeamKey(): string {
    return `${GAME_KEY}.l.${this.env.YAHOO_LEAGUE_ID}.t.${this.env.YAHOO_TEAM_ID}`;
  }

  private async request(path: string): Promise<any> {
    const token = await getValidToken(this.env);
    const url = `${BASE_URL}${path}?format=json`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    const start = Date.now();
    const res = await fetch(url, { method: "GET", headers });
    const durationMs = Date.now() - start;

    if (!res.ok) {
      const text = await res.text();
      logApiCall(`yahoo:GET:${path}`, durationMs, res.status);
      throw new Error(`Yahoo API GET ${path} failed (${res.status}): ${text}`);
    }

    logApiCall(`yahoo:GET:${path}`, durationMs, res.status);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async getRoster(date?: string): Promise<Roster> {
    const dateSuffix = date ? `;date=${date}` : "";
    const data = await this.request(`/team/${this.getTeamKey()}/roster/players${dateSuffix}`);

    // TODO: verify exact shape against live response
    const fc = data.fantasy_content;
    const teamData = fc.team;
    const rosterData = teamData[1]?.roster;
    const playersArr: any[] = rosterData?.["0"]?.players
      ? Object.values(rosterData["0"].players).filter((v: any) => typeof v === "object" && v.player)
      : [];

    const entries: RosterEntry[] = playersArr.map((p: any) => {
      const info = p.player[0];
      const selectedPos = p.player[1]?.selected_position?.[1]?.selected_position?.position ?? "BN";

      return {
        player: parsePlayer(info),
        currentPosition: selectedPos,
      };
    });

    return {
      entries,
      date: date ?? new Date().toISOString().slice(0, 10),
    };
  }

  async getMatchup(weekNum?: number): Promise<Matchup> {
    const weekParam = weekNum != null ? `weeks=${weekNum}` : "weeks=current";
    const data = await this.request(`/team/${this.getTeamKey()}/matchups;${weekParam}`);

    const fc = data.fantasy_content;
    const matchupData = fc.team[1]?.matchups?.["0"]?.matchup;
    const week: number = matchupData?.week ?? 0;
    const weekStart: string = matchupData?.week_start ?? "";
    const weekEnd: string = matchupData?.week_end ?? "";
    const teams = matchupData?.["0"]?.teams;

    // teams object: "0" = my team, "1" = opponent
    const opponentTeam = teams?.["1"]?.team;
    const opponentInfo = opponentTeam?.[0];
    const opponentTeamKey = opponentInfo?.[0]?.team_key ?? "";
    const opponentTeamName = opponentInfo?.[2]?.name ?? "";

    // Parse category scores from each team's stat arrays
    const myTeamStats = teams?.["0"]?.team?.[1]?.team_stats?.stats;
    const oppTeamStats = teams?.["1"]?.team?.[1]?.team_stats?.stats;

    const categories: CategoryScore[] = [];

    if (Array.isArray(myTeamStats) && Array.isArray(oppTeamStats)) {
      // Build stat_id → value maps
      const myStatMap: Record<string, string> = {};
      for (const entry of myTeamStats) {
        const s = entry?.stat;
        if (s?.stat_id != null && s?.value != null) {
          myStatMap[String(s.stat_id)] = String(s.value);
        }
      }

      const oppStatMap: Record<string, string> = {};
      for (const entry of oppTeamStats) {
        const s = entry?.stat;
        if (s?.stat_id != null && s?.value != null) {
          oppStatMap[String(s.stat_id)] = String(s.value);
        }
      }

      // Map only scoring categories (skip display-only stat IDs)
      for (const [statId, category] of Object.entries(STAT_ID_TO_CATEGORY)) {
        const myRaw = myStatMap[statId];
        const oppRaw = oppStatMap[statId];
        if (myRaw == null || oppRaw == null) continue;

        const myValue = parseFloat(myRaw);
        const opponentValue = parseFloat(oppRaw);
        if (Number.isNaN(myValue) || Number.isNaN(opponentValue)) continue;

        categories.push({ category, myValue, opponentValue });
      }
    }

    return {
      week,
      weekStart,
      weekEnd,
      opponentTeamKey,
      opponentTeamName,
      categories,
    };
  }

  async getStandings(): Promise<StandingsEntry[]> {
    const data = await this.request(`/league/${this.getLeagueKey()}/standings`);

    const fc = data.fantasy_content;
    const teamsObj = fc.league?.[1]?.standings?.[0]?.teams;
    if (!teamsObj) return [];

    const entries: StandingsEntry[] = [];
    for (const key of Object.keys(teamsObj)) {
      if (key === "count") continue;
      const teamArr = teamsObj[key]?.team;
      if (!teamArr) continue;

      // info_array is teamArr[0], team_standings is in teamArr[2]
      const infoArr: any[] = teamArr[0] ?? [];
      const standingsData = teamArr[2]?.team_standings;
      if (!standingsData) continue;

      let teamKey = "";
      let teamName = "";
      for (const item of infoArr) {
        if (item.team_key) teamKey = item.team_key;
        if (item.name) teamName = item.name;
      }

      const ot = standingsData.outcome_totals ?? {};
      entries.push({
        teamKey,
        teamName,
        rank: Number(standingsData.rank) || 0,
        wins: Number(ot.wins) || 0,
        losses: Number(ot.losses) || 0,
        ties: Number(ot.ties) || 0,
        percentage: parseFloat(ot.percentage) || 0,
      });
    }

    return entries;
  }

  async getFreeAgents(position?: string, count = 25): Promise<Player[]> {
    const posSuffix = position ? `;position=${position}` : "";
    const data = await this.request(
      `/league/${this.getLeagueKey()}/players;status=FA${posSuffix};count=${count}`,
    );

    // TODO: verify exact shape against live response
    const fc = data.fantasy_content;
    const leagueData = fc.league;
    const playersObj = leagueData?.[1]?.players;
    if (!playersObj) return [];

    const players: Player[] = [];
    for (const key of Object.keys(playersObj)) {
      if (key === "count") continue;
      const p = playersObj[key]?.player;
      if (!p) continue;
      players.push(parsePlayer(p[0]));
    }
    return players;
  }

  async getTeamRosters(): Promise<TeamRoster[]> {
    const data = await this.request(`/league/${this.getLeagueKey()}/teams/roster`);

    const fc = data.fantasy_content;
    const teamsObj = fc.league?.[1]?.teams;
    if (!teamsObj) return [];

    const rosters: TeamRoster[] = [];
    for (const key of Object.keys(teamsObj)) {
      if (key === "count") continue;
      const teamArr = teamsObj[key]?.team;
      if (!teamArr) continue;

      const infoArr: any[] = teamArr[0] ?? [];
      let teamKey = "";
      let teamName = "";
      for (const item of infoArr) {
        if (item.team_key) teamKey = item.team_key;
        if (item.name) teamName = item.name;
      }

      const rosterData = teamArr[1]?.roster;
      const playersObj = rosterData?.["0"]?.players;
      const players: Player[] = [];
      if (playersObj) {
        for (const pk of Object.keys(playersObj)) {
          if (pk === "count") continue;
          const p = playersObj[pk]?.player;
          if (!p) continue;
          players.push(parsePlayer(p[0]));
        }
      }

      rosters.push({ teamKey, teamName, players });
    }

    return rosters;
  }

  /**
   * Fetch recent league transactions (add/drops, trades, waivers by all managers).
   * Returns up to `count` most recent transactions.
   */
  async getRecentTransactions(count = 25): Promise<LeagueTransaction[]> {
    const data = await this.request(`/league/${this.getLeagueKey()}/transactions;count=${count}`);

    const fc = data.fantasy_content;
    const leagueData = fc.league;
    const txObj = leagueData?.[1]?.transactions;
    if (!txObj) return [];

    const transactions: LeagueTransaction[] = [];
    for (const key of Object.keys(txObj)) {
      if (key === "count") continue;
      const tx = txObj[key]?.transaction;
      if (!tx) continue;

      const meta = tx[0];
      const playersObj = tx[1]?.players;

      const players: LeagueTransactionPlayer[] = [];
      if (playersObj) {
        for (const pk of Object.keys(playersObj)) {
          if (pk === "count") continue;
          const p = playersObj[pk]?.player;
          if (!p) continue;
          const info = p[0];
          const txData = p[1]?.transaction_data;
          let name = "";
          let playerKey = "";
          for (const item of info ?? []) {
            if (item.name) name = item.name.full ?? item.name;
            if (item.player_key) playerKey = item.player_key;
          }
          players.push({
            playerKey,
            name,
            type: txData?.[0]?.type ?? "unknown",
            sourceTeamKey: txData?.[0]?.source_team_key ?? "",
            destinationTeamKey: txData?.[0]?.destination_team_key ?? "",
          });
        }
      }

      transactions.push({
        transactionKey: meta?.transaction_key ?? "",
        type: meta?.type ?? "unknown",
        timestamp: meta?.timestamp ? new Date(Number(meta.timestamp) * 1000).toISOString() : "",
        status: meta?.status ?? "",
        players,
      });
    }

    return transactions;
  }

}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/** Parse a Yahoo player info array into our Player type. */
function parsePlayer(infoArr: any[]): Player {
  // TODO: verify indices against live response — Yahoo nests player info
  // as an array of single-key objects
  let yahooId = "";
  let name = "";
  let team = "";
  let positions: string[] = [];
  let status: Player["status"] = "healthy";
  let ownership: number | undefined;

  for (const item of infoArr) {
    if (item.player_key) yahooId = item.player_key;
    if (item.name) name = item.name.full ?? item.name;
    if (item.editorial_team_abbr) team = item.editorial_team_abbr;
    if (item.eligible_positions) {
      const posArr = item.eligible_positions;
      positions = Array.isArray(posArr) ? posArr.map((p: any) => p.position).filter(Boolean) : [];
    }
    if (item.status) {
      const s = item.status as string;
      if (s === "IL") status = "IL";
      else if (s === "DTD") status = "DTD";
      else if (s === "O") status = "OUT";
      else if (s === "NA") status = "NA";
    }
    if (item.percent_owned) {
      ownership = item.percent_owned?.[1]?.value ?? undefined;
    }
  }

  return { yahooId, name, team, positions, status, ownership };
}
