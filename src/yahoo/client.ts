import type {
  Env,
  Roster,
  RosterEntry,
  Player,
  Matchup,
  CategoryScore,
  LineupMove,
  TradeProposal,
} from "../types";
import { getValidToken } from "./auth";

const BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";

// TODO: discover game key dynamically via /fantasy/v2/game/mlb
const GAME_KEY = "mlb";

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

  private async request(path: string, method: string = "GET", body?: string): Promise<any> {
    const token = await getValidToken(this.env);
    const isGet = method === "GET";
    const url = `${BASE_URL}${path}${isGet ? "?format=json" : ""}`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (!isGet && body) {
      headers["Content-Type"] = "application/xml";
    }

    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Yahoo API ${method} ${path} failed (${res.status}): ${text}`);
    }

    if (isGet) {
      return res.json();
    }
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

  async getMatchup(): Promise<Matchup> {
    const data = await this.request(`/team/${this.getTeamKey()}/matchups;weeks=current`);

    // TODO: verify exact shape against live response
    const fc = data.fantasy_content;
    const matchupData = fc.team[1]?.matchups?.["0"]?.matchup;
    const week = matchupData?.week ?? 0;
    const teams = matchupData?.["0"]?.teams;

    // teams object: "0" = my team, "1" = opponent
    const opponentTeam = teams?.["1"]?.team;
    const opponentInfo = opponentTeam?.[0];
    const opponentTeamKey = opponentInfo?.[0]?.team_key ?? "";
    const opponentTeamName = opponentInfo?.[2]?.name ?? "";

    // TODO: parse actual category scores from matchup stat_winners
    const categories: CategoryScore[] = [];

    return {
      week,
      opponentTeamKey,
      opponentTeamName,
      categories,
    };
  }

  async getStandings(): Promise<any> {
    return this.request(`/league/${this.getLeagueKey()}/standings`);
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

  async getTeamRosters(): Promise<any> {
    return this.request(`/league/${this.getLeagueKey()}/teams/roster`);
  }

  // ---------------------------------------------------------------------------
  // Writes (XML payloads)
  // ---------------------------------------------------------------------------

  async setLineup(date: string, moves: LineupMove[]): Promise<void> {
    const playerEntries = moves
      .map(
        (m) => `
      <player>
        <player_key>${m.playerId}</player_key>
        <position>${m.position}</position>
      </player>`,
      )
      .join("");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fantasy_content>
  <roster>
    <coverage_type>date</coverage_type>
    <date>${date}</date>
    <players>${playerEntries}
    </players>
  </roster>
</fantasy_content>`;

    await this.request(`/team/${this.getTeamKey()}/roster`, "PUT", xml);
  }

  async addDrop(addPlayerId: string, dropPlayerId: string): Promise<void> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fantasy_content>
  <transaction>
    <type>add/drop</type>
    <players>
      <player>
        <player_key>${addPlayerId}</player_key>
        <transaction_data>
          <type>add</type>
          <destination_team_key>${this.getTeamKey()}</destination_team_key>
        </transaction_data>
      </player>
      <player>
        <player_key>${dropPlayerId}</player_key>
        <transaction_data>
          <type>drop</type>
          <source_team_key>${this.getTeamKey()}</source_team_key>
        </transaction_data>
      </player>
    </players>
  </transaction>
</fantasy_content>`;

    await this.request(`/league/${this.getLeagueKey()}/transactions`, "POST", xml);
  }

  async claimWaiver(addPlayerId: string, dropPlayerId: string): Promise<void> {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fantasy_content>
  <transaction>
    <type>add/drop</type>
    <players>
      <player>
        <player_key>${addPlayerId}</player_key>
        <transaction_data>
          <type>add</type>
          <destination_team_key>${this.getTeamKey()}</destination_team_key>
          <type>waiver</type>
        </transaction_data>
      </player>
      <player>
        <player_key>${dropPlayerId}</player_key>
        <transaction_data>
          <type>drop</type>
          <source_team_key>${this.getTeamKey()}</source_team_key>
        </transaction_data>
      </player>
    </players>
  </transaction>
</fantasy_content>`;

    await this.request(`/league/${this.getLeagueKey()}/transactions`, "POST", xml);
  }

  async proposeTrade(proposal: TradeProposal): Promise<void> {
    const sendPlayers = proposal.playersToSend
      .map(
        (id) => `
      <player>
        <player_key>${id}</player_key>
        <transaction_data>
          <type>pending_trade</type>
          <source_team_key>${this.getTeamKey()}</source_team_key>
          <destination_team_key>${proposal.targetTeamKey}</destination_team_key>
        </transaction_data>
      </player>`,
      )
      .join("");

    const receivePlayers = proposal.playersToReceive
      .map(
        (id) => `
      <player>
        <player_key>${id}</player_key>
        <transaction_data>
          <type>pending_trade</type>
          <source_team_key>${proposal.targetTeamKey}</source_team_key>
          <destination_team_key>${this.getTeamKey()}</destination_team_key>
        </transaction_data>
      </player>`,
      )
      .join("");

    const notePart = proposal.message ? `<trade_note>${proposal.message}</trade_note>` : "";

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<fantasy_content>
  <transaction>
    <type>trade</type>
    <trader_team_key>${this.getTeamKey()}</trader_team_key>
    <tradee_team_key>${proposal.targetTeamKey}</tradee_team_key>
    ${notePart}
    <players>${sendPlayers}${receivePlayers}
    </players>
  </transaction>
</fantasy_content>`;

    await this.request(`/league/${this.getLeagueKey()}/transactions`, "POST", xml);
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
