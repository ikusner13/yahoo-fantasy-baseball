import type {
  BatterStats,
  Category,
  CategoryScore,
  Matchup,
  PitcherStats,
  Player,
  PlayerProjection,
  Roster,
  RosterEntry,
} from "../../src/types";

export interface RecommendationScenario {
  name: string;
  matchup: Matchup;
  daysRemaining: number;
  currentIP: number;
  minimumIP: number;
}

export interface StreamerScenario extends RecommendationScenario {
  riskyPitcher: PitcherStats;
  safePitcher: PitcherStats;
}

export interface WaiverScenario extends RecommendationScenario {
  roster: Roster;
  freeAgents: PlayerProjection[];
  rosterValuations: PlayerProjection[];
}

export function makePlayer(
  yahooId: string,
  positions: string[],
  team: string,
  status: Player["status"] = "healthy",
): Player {
  return {
    yahooId,
    name: yahooId,
    team,
    positions,
    status,
  };
}

export function makeBatterProjection(
  yahooId: string,
  stats: Partial<BatterStats> = {},
): PlayerProjection {
  const batting: BatterStats = {
    pa: 550,
    r: 70,
    h: 135,
    hr: 18,
    rbi: 72,
    sb: 8,
    tb: 200,
    obp: 0.325,
    ...stats,
  };

  return {
    yahooId,
    playerType: "batter",
    batting,
    updatedAt: "2026-04-09",
  };
}

export function makePitcherProjection(
  yahooId: string,
  stats: Partial<PitcherStats> = {},
): PlayerProjection {
  const pitching: PitcherStats = {
    ip: 6,
    outs: 18,
    k: 6,
    era: 3.75,
    whip: 1.18,
    qs: 0.4,
    svhd: 0,
    ...stats,
  };

  return {
    yahooId,
    playerType: "pitcher",
    pitching,
    updatedAt: "2026-04-09",
  };
}

export function makeScore(category: Category, myValue: number, opponentValue: number): CategoryScore {
  return { category, myValue, opponentValue };
}

export function makeMatchup(
  categories: CategoryScore[],
  opponentTeamName: string = "Opponent",
): Matchup {
  return {
    week: 1,
    weekStart: "2026-09-21",
    weekEnd: "2026-09-27",
    opponentTeamKey: "mlb.l.1.t.2",
    opponentTeamName,
    categories,
  };
}

export function makeRoster(entries: RosterEntry[]): Roster {
  return {
    date: "2026-09-27",
    entries,
  };
}

export function makeEntry(player: Player, currentPosition: string = "BN"): RosterEntry {
  return { player, currentPosition };
}

export const recommendationScenarios = {
  ratioProtection: {
    name: "ratio-protection",
    matchup: makeMatchup([
      makeScore("ERA", 3.06, 3.44),
      makeScore("WHIP", 1.08, 1.20),
      makeScore("K", 78, 75),
      makeScore("HR", 15, 14),
      makeScore("SB", 6, 10),
      makeScore("SVHD", 8, 7),
    ]),
    daysRemaining: 2,
    currentIP: 34,
    minimumIP: 20,
  },
  inningsMinimumPressure: {
    name: "innings-minimum-pressure",
    matchup: makeMatchup([
      makeScore("ERA", 3.75, 3.82),
      makeScore("WHIP", 1.24, 1.22),
      makeScore("K", 65, 67),
      makeScore("OUT", 162, 171),
      makeScore("QS", 4, 5),
      makeScore("SVHD", 5, 5),
    ]),
    daysRemaining: 3,
    currentIP: 13.5,
    minimumIP: 20,
  },
  streamerVsRatioRisk: {
    name: "streamer-vs-ratio-risk",
    matchup: makeMatchup([
      makeScore("ERA", 3.18, 3.22),
      makeScore("WHIP", 1.09, 1.11),
      makeScore("K", 70, 68),
      makeScore("OUT", 189, 180),
      makeScore("QS", 6, 4),
      makeScore("SVHD", 4, 5),
    ]),
    daysRemaining: 4,
    currentIP: 24,
    minimumIP: 20,
    riskyPitcher: {
      ip: 6.2,
      outs: 19,
      k: 13,
      era: 4.35,
      whip: 1.29,
      qs: 0.5,
      svhd: 0,
    },
    safePitcher: {
      ip: 5.6,
      outs: 17,
      k: 5.4,
      era: 3.18,
      whip: 1.06,
      qs: 0.7,
      svhd: 0,
    },
  },
  mustAddCloser: {
    name: "must-add-closer",
    matchup: makeMatchup([
      makeScore("SVHD", 3, 2),
      makeScore("K", 77, 75),
      makeScore("ERA", 3.14, 3.25),
      makeScore("WHIP", 1.10, 1.15),
      makeScore("SB", 7, 13),
      makeScore("HR", 16, 15),
    ]),
    daysRemaining: 5,
    currentIP: 31,
    minimumIP: 20,
    roster: makeRoster([
      makeEntry(makePlayer("roster-bat-1", ["OF"], "NYY")),
      makeEntry(makePlayer("roster-bat-2", ["1B"], "NYY")),
      makeEntry(makePlayer("roster-bat-3", ["2B"], "NYY")),
      makeEntry(makePlayer("roster-bat-4", ["3B"], "NYY")),
    ]),
    freeAgents: [
      makePitcherProjection("closer-x", {
        ip: 2,
        outs: 6,
        k: 3,
        era: 2.35,
        whip: 0.98,
        qs: 0,
        svhd: 3.6,
      }),
    ],
    rosterValuations: [
      makeBatterProjection("roster-bat-1", { hr: 12, rbi: 55, obp: 0.305 }),
      makeBatterProjection("roster-bat-2", { hr: 13, rbi: 52, obp: 0.307 }),
      makeBatterProjection("roster-bat-3", { hr: 9, rbi: 48, obp: 0.298 }),
      makeBatterProjection("roster-bat-4", { hr: 8, rbi: 41, obp: 0.294 }),
      makePitcherProjection("closer-x", {
        ip: 2,
        outs: 6,
        k: 3,
        era: 2.35,
        whip: 0.98,
        qs: 0,
        svhd: 3.6,
      }),
    ],
  },
  sundayEndgame: {
    name: "sunday-endgame",
    matchup: makeMatchup([
      makeScore("R", 61, 60),
      makeScore("HR", 19, 19),
      makeScore("RBI", 64, 63),
      makeScore("SB", 7, 10),
      makeScore("TB", 182, 180),
      makeScore("OBP", 0.338, 0.335),
      makeScore("OUT", 245, 241),
      makeScore("K", 90, 89),
      makeScore("ERA", 3.19, 3.23),
      makeScore("WHIP", 1.11, 1.12),
      makeScore("QS", 8, 7),
      makeScore("SVHD", 5, 5),
    ]),
    daysRemaining: 1,
    currentIP: 18,
    minimumIP: 20,
  },
};
