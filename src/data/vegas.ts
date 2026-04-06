/**
 * Fetches MLB game odds from The Odds API and computes implied team run totals.
 *
 * Implied team total = gameTotal * teamWinProbability
 * Win probability from American odds:
 *   negative (favorite): prob = |odds| / (|odds| + 100)
 *   positive (underdog): prob = 100 / (odds + 100)
 */

// --- Types ---

export interface GameOdds {
  homeTeam: string; // full name like "New York Yankees"
  awayTeam: string;
  homeImpliedRuns: number;
  awayImpliedRuns: number;
  gameTotal: number; // over/under
  homeMoneyline: number; // American odds e.g. -150
  awayMoneyline: number; // e.g. +130
}

/** Map from team abbreviation to implied runs today */
export type ImpliedRunsMap = Map<string, number>;

// --- Team name mapping (Odds API full names -> standard abbreviations) ---

const TEAM_NAME_MAP: Record<string, string> = {
  "Arizona Diamondbacks": "ARI",
  "Atlanta Braves": "ATL",
  "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS",
  "Chicago Cubs": "CHC",
  "Chicago White Sox": "CWS",
  "Cincinnati Reds": "CIN",
  "Cleveland Guardians": "CLE",
  "Colorado Rockies": "COL",
  "Detroit Tigers": "DET",
  "Houston Astros": "HOU",
  "Kansas City Royals": "KC",
  "Los Angeles Angels": "LAA",
  "Los Angeles Dodgers": "LAD",
  "Miami Marlins": "MIA",
  "Milwaukee Brewers": "MIL",
  "Minnesota Twins": "MIN",
  "New York Mets": "NYM",
  "New York Yankees": "NYY",
  "Oakland Athletics": "OAK",
  "Philadelphia Phillies": "PHI",
  "Pittsburgh Pirates": "PIT",
  "San Diego Padres": "SD",
  "San Francisco Giants": "SF",
  "Seattle Mariners": "SEA",
  "St. Louis Cardinals": "STL",
  "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX",
  "Toronto Blue Jays": "TOR",
  "Washington Nationals": "WSH",
};

// --- Odds math ---

/** Convert American odds to implied win probability */
function americanToProb(odds: number): number {
  if (odds < 0) {
    return Math.abs(odds) / (Math.abs(odds) + 100);
  }
  return 100 / (odds + 100);
}

/** Compute implied runs for a team given game total and both moneylines */
function impliedTeamRuns(gameTotal: number, teamOdds: number, opponentOdds: number): number {
  const teamProb = americanToProb(teamOdds);
  const oppProb = americanToProb(opponentOdds);
  // Normalize probabilities (vig removal)
  const totalProb = teamProb + oppProb;
  const normalizedProb = teamProb / totalProb;
  return gameTotal * normalizedProb;
}

// --- Odds API response types ---

interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

interface OddsApiMarket {
  key: string; // "h2h" | "totals"
  outcomes: OddsApiOutcome[];
}

interface OddsApiBookmaker {
  key: string;
  markets: OddsApiMarket[];
}

interface OddsApiEvent {
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

// --- Core fetch ---

const ODDS_API_BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds";

export async function fetchTodaysOdds(apiKey: string): Promise<GameOdds[]> {
  const url = `${ODDS_API_BASE}/?apiKey=${apiKey}&regions=us&markets=h2h,totals&oddsFormat=american`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Odds API error ${res.status}: ${await res.text()}`);
  }

  const events = (await res.json()) as OddsApiEvent[];
  const results: GameOdds[] = [];

  for (const event of events) {
    // Average moneylines and totals across all bookmakers for accuracy
    let homeMlSum = 0,
      awayMlSum = 0,
      mlCount = 0;
    let totalSum = 0,
      totalCount = 0;

    for (const bk of event.bookmakers) {
      for (const market of bk.markets) {
        if (market.key === "h2h") {
          const homeOutcome = market.outcomes.find((o) => o.name === event.home_team);
          const awayOutcome = market.outcomes.find((o) => o.name === event.away_team);
          if (homeOutcome && awayOutcome) {
            homeMlSum += homeOutcome.price;
            awayMlSum += awayOutcome.price;
            mlCount++;
          }
        } else if (market.key === "totals") {
          const over = market.outcomes.find((o) => o.name === "Over");
          if (over?.point) {
            totalSum += over.point;
            totalCount++;
          }
        }
      }
    }

    if (mlCount === 0 || totalCount === 0) continue;

    const homeMoneyline = Math.round(homeMlSum / mlCount);
    const awayMoneyline = Math.round(awayMlSum / mlCount);
    const gameTotal = totalSum / totalCount;

    const homeImpliedRuns = impliedTeamRuns(gameTotal, homeMoneyline, awayMoneyline);
    const awayImpliedRuns = impliedTeamRuns(gameTotal, awayMoneyline, homeMoneyline);

    results.push({
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      homeImpliedRuns: Math.round(homeImpliedRuns * 100) / 100,
      awayImpliedRuns: Math.round(awayImpliedRuns * 100) / 100,
      gameTotal: Math.round(gameTotal * 10) / 10,
      homeMoneyline,
      awayMoneyline,
    });
  }

  return results;
}

// --- Public API ---

export async function getImpliedRunsMap(apiKey: string): Promise<ImpliedRunsMap> {
  const odds = await fetchTodaysOdds(apiKey);
  const map: ImpliedRunsMap = new Map();

  for (const game of odds) {
    const homeAbbr = TEAM_NAME_MAP[game.homeTeam];
    const awayAbbr = TEAM_NAME_MAP[game.awayTeam];
    if (homeAbbr) map.set(homeAbbr, game.homeImpliedRuns);
    if (awayAbbr) map.set(awayAbbr, game.awayImpliedRuns);
  }

  return map;
}

const LEAGUE_AVG_IMPLIED_RUNS = 4.5;

/**
 * Vegas multiplier for a team's implied run total.
 * Higher implied runs = offense expected to produce more.
 * Clamped to [0.75, 1.30].
 */
export function computeVegasMultiplier(impliedRuns: number): number {
  const raw = impliedRuns / LEAGUE_AVG_IMPLIED_RUNS;
  return Math.max(0.75, Math.min(1.3, raw));
}
