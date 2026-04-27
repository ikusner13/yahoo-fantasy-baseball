import { describe, expect, it, vi } from "vitest";
import type {
  Category,
  Matchup,
  Player,
  PlayerProjection,
  PlayerValuation,
  Roster,
  RosterEntry,
} from "../../src/types";
import type { TeamWeekSchedule } from "../../src/analysis/game-count";
import { evaluateMatchupPickups } from "../../src/recommendation/pickups";
import { estimateMatchupWinProbability } from "../../src/recommendation/probability-engine";

vi.mock("../../src/recommendation/probability-engine", () => ({
  estimateMatchupWinProbability: vi.fn((matchup: Matchup, roster: Roster) => {
    const ids = new Set(roster.entries.map((entry) => entry.player.yahooId));
    const makeCategory = (category: Category, winProbability: number) => ({
      category,
      currentValue: matchup.categories.find((item) => item.category === category)?.myValue ?? 0,
      opponentValue: matchup.categories.find((item) => item.category === category)?.opponentValue ?? 0,
      winProbability,
    });

    if (ids.has("closer-x")) {
      return {
        daysRemaining: 3,
        winProbability: 0.61,
        expectedCategoryWins: 6.8,
        categoryWinProbabilities: [
          makeCategory("SVHD", 0.78),
          makeCategory("K", 0.62),
          makeCategory("ERA", 0.64),
          makeCategory("WHIP", 0.63),
          makeCategory("HR", 0.18),
          makeCategory("RBI", 0.14),
        ],
        simulations: 350,
      };
    }

    if (ids.has("power-bat")) {
      return {
        daysRemaining: 3,
        winProbability: 0.53,
        expectedCategoryWins: 6.2,
        categoryWinProbabilities: [
          makeCategory("SVHD", 0.41),
          makeCategory("K", 0.57),
          makeCategory("ERA", 0.59),
          makeCategory("WHIP", 0.58),
          makeCategory("HR", 0.21),
          makeCategory("RBI", 0.19),
        ],
        simulations: 350,
      };
    }

    return {
      daysRemaining: 3,
      winProbability: 0.52,
      expectedCategoryWins: 6.1,
      categoryWinProbabilities: [
        makeCategory("SVHD", 0.35),
        makeCategory("K", 0.56),
        makeCategory("ERA", 0.58),
        makeCategory("WHIP", 0.57),
        makeCategory("HR", 0.18),
        makeCategory("RBI", 0.16),
      ],
      simulations: 350,
    };
  }),
}));

function makePlayer(yahooId: string, name: string, team: string, positions: string[]): Player {
  return {
    yahooId,
    name,
    team,
    positions,
    status: "healthy",
  };
}

function makeEntry(player: Player): RosterEntry {
  return {
    player,
    currentPosition: "BN",
  };
}

function makeBatterProjection(
  yahooId: string,
  team: string,
  overrides: Partial<NonNullable<PlayerProjection["batting"]>> = {},
): PlayerProjection {
  return {
    yahooId,
    playerType: "batter",
    batting: {
      pa: 550,
      r: 65,
      h: 125,
      hr: 14,
      rbi: 58,
      sb: 5,
      tb: 185,
      obp: 0.308,
      ...overrides,
    },
    updatedAt: "2026-04-09T00:00:00Z",
  };
}

function makePitcherProjection(
  yahooId: string,
  overrides: Partial<NonNullable<PlayerProjection["pitching"]>> = {},
): PlayerProjection {
  return {
    yahooId,
    playerType: "pitcher",
    pitching: {
      ip: 4,
      outs: 12,
      k: 4,
      era: 3.4,
      whip: 1.1,
      qs: 0,
      svhd: 0,
      ...overrides,
    },
    updatedAt: "2026-04-09T00:00:00Z",
  };
}

function makeWeekSchedule(teams: string[]): Map<string, TeamWeekSchedule> {
  return new Map(
    teams.map((team) => [
      team,
      {
        team,
        gamesThisWeek: 7,
        gamesRemaining: 5,
        opponents: [],
      },
    ]),
  );
}

describe("evaluateMatchupPickups", () => {
  it("prefers a closer that materially improves matchup win odds", () => {
    const rosterPlayers = [
      makePlayer("bat-1", "Bat 1", "NYY", ["OF"]),
      makePlayer("bat-2", "Bat 2", "NYY", ["OF"]),
      makePlayer("bat-3", "Bat 3", "NYY", ["OF"]),
      makePlayer("weak-rp", "Weak RP", "NYY", ["RP"]),
    ];
    const roster: Roster = {
      date: "2026-04-10",
      entries: rosterPlayers.map(makeEntry),
    };

    const rosterProjectionMap = new Map<string, PlayerProjection>([
      ["bat-1", makeBatterProjection("bat-1", "NYY", { hr: 12, rbi: 52, obp: 0.302 })],
      ["bat-2", makeBatterProjection("bat-2", "NYY", { hr: 11, rbi: 50, obp: 0.301 })],
      ["bat-3", makeBatterProjection("bat-3", "NYY", { hr: 10, rbi: 48, obp: 0.298 })],
      [
        "weak-rp",
        makePitcherProjection("weak-rp", {
          ip: 3,
          outs: 9,
          k: 2,
          era: 5.6,
          whip: 1.52,
          svhd: 0.4,
        }),
      ],
    ]);

    const rosterValuations = new Map<string, PlayerValuation>([
      [
        "bat-1",
        { yahooId: "bat-1", name: "Bat 1", totalZScore: 1.4, categoryZScores: {} },
      ],
      [
        "bat-2",
        { yahooId: "bat-2", name: "Bat 2", totalZScore: 1.2, categoryZScores: {} },
      ],
      [
        "bat-3",
        { yahooId: "bat-3", name: "Bat 3", totalZScore: 1.1, categoryZScores: {} },
      ],
      [
        "weak-rp",
        { yahooId: "weak-rp", name: "Weak RP", totalZScore: -1.5, categoryZScores: {} },
      ],
    ]);

    const closer = makePlayer("closer-x", "Closer X", "STL", ["RP"]);
    const genericBat = makePlayer("power-bat", "Power Bat", "BOS", ["OF"]);
    const freeAgents = [closer, genericBat];

    const freeAgentProjectionMap = new Map<string, PlayerProjection>([
      [
        "closer-x",
        makePitcherProjection("closer-x", {
          ip: 3,
          outs: 9,
          k: 5,
          era: 2.4,
          whip: 0.96,
          svhd: 3.8,
        }),
      ],
      ["power-bat", makeBatterProjection("power-bat", "BOS", { hr: 26, rbi: 90, obp: 0.326 })],
    ]);

    const matchup: Matchup = {
      week: 3,
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      opponentTeamKey: "opp",
      opponentTeamName: "Opponent",
      categories: [
        { category: "SVHD", myValue: 1, opponentValue: 2 },
        { category: "K", myValue: 44, opponentValue: 43 },
        { category: "ERA", myValue: 3.19, opponentValue: 3.28 },
        { category: "WHIP", myValue: 1.09, opponentValue: 1.14 },
        { category: "HR", myValue: 12, opponentValue: 19 },
        { category: "RBI", myValue: 46, opponentValue: 59 },
      ],
    };

    const recommendations = evaluateMatchupPickups({
      roster,
      freeAgents,
      rosterValuations,
      rosterProjectionMap,
      freeAgentProjectionMap,
      matchup,
      weekSchedule: makeWeekSchedule(["NYY", "STL", "BOS"]),
      asOf: new Date("2026-04-10T12:00:00Z"),
      simulations: 350,
      seed: 42,
      limit: 3,
    });

    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0]?.add.yahooId).toBe("closer-x");
    expect(recommendations[0]?.winProbabilityDelta).toBeGreaterThan(0);
    expect(recommendations[0]?.reasoning).toContain("Helps SVHD");
    const powerBat = recommendations.find((rec) => rec.add.yahooId === "power-bat");
    expect(powerBat).toBeDefined();
    expect((recommendations[0]?.winProbabilityDelta ?? 0)).toBeGreaterThan(
      powerBat?.winProbabilityDelta ?? 0,
    );
  });

  it("forwards opponent roster context into probability calls", () => {
    vi.mocked(estimateMatchupWinProbability).mockClear();

    const roster: Roster = {
      date: "2026-04-10",
      entries: [makeEntry(makePlayer("weak-rp", "Weak RP", "NYY", ["RP"]))],
    };
    const opponentRoster: Roster = {
      date: "2026-04-10",
      entries: [makeEntry(makePlayer("opp-1", "Opp Bat", "BOS", ["OF"]))],
    };
    const matchup: Matchup = {
      week: 3,
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      opponentTeamKey: "opp",
      opponentTeamName: "Opponent",
      categories: [
        { category: "SVHD", myValue: 1, opponentValue: 2 },
        { category: "K", myValue: 44, opponentValue: 43 },
      ] as Matchup["categories"],
    };

    evaluateMatchupPickups({
      roster,
      freeAgents: [makePlayer("closer-x", "Closer X", "STL", ["RP"])],
      rosterValuations: new Map([
        ["weak-rp", { yahooId: "weak-rp", name: "Weak RP", totalZScore: -1.5, categoryZScores: {} }],
      ]),
      rosterProjectionMap: new Map([
        ["weak-rp", makePitcherProjection("weak-rp", { svhd: 0.4 })],
      ]),
      freeAgentProjectionMap: new Map([
        ["closer-x", makePitcherProjection("closer-x", { svhd: 3.8 })],
      ]),
      matchup,
      weekSchedule: makeWeekSchedule(["NYY", "STL", "BOS"]),
      asOf: new Date("2026-04-10T12:00:00Z"),
      simulations: 350,
      seed: 42,
      limit: 1,
      opponentRoster,
      opponentProjectionMap: new Map([
        ["opp-1", makeBatterProjection("opp-1", "BOS")],
      ]),
    });

    const mocked = vi.mocked(estimateMatchupWinProbability);
    expect(mocked).toHaveBeenCalled();
    const options = mocked.mock.calls.at(-1)?.[4];
    expect(options?.opponentRoster).toBe(opponentRoster);
    expect(options?.opponentProjectionMap).toBeInstanceOf(Map);
  });
});
