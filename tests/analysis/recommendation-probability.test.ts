import { describe, it, expect } from "vitest";
import type { Matchup, PlayerProjection, Roster, RosterEntry } from "../../src/types";
import type { TeamWeekSchedule } from "../../src/analysis/game-count";
import {
  estimateMatchupWinProbability,
  getInclusiveDaysRemaining,
} from "../../src/recommendation/probability-engine";

function batterProjection(id: string, team: string): [RosterEntry, PlayerProjection] {
  return [
    {
      player: {
        yahooId: id,
        name: id,
        team,
        positions: ["OF"],
        status: "healthy",
      },
      currentPosition: "OF",
    },
    {
      yahooId: id,
      playerType: "batter",
      batting: {
        pa: 520,
        r: 78,
        h: 140,
        hr: 22,
        rbi: 74,
        sb: 12,
        tb: 235,
        obp: 0.335,
      },
      updatedAt: "2026-04-09",
    },
  ];
}

function pitcherProjection(id: string, team: string): [RosterEntry, PlayerProjection] {
  return [
    {
      player: {
        yahooId: id,
        name: id,
        team,
        positions: ["SP"],
        status: "healthy",
      },
      currentPosition: "SP",
    },
    {
      yahooId: id,
      playerType: "pitcher",
      pitching: {
        ip: 165,
        outs: 495,
        k: 175,
        era: 3.55,
        whip: 1.18,
        qs: 14,
        svhd: 0,
      },
      updatedAt: "2026-04-09",
    },
  ];
}

function makeSchedule(team: string, gamesRemaining: number): Map<string, TeamWeekSchedule> {
  return new Map([
    [
      team,
      {
        team,
        gamesThisWeek: 7,
        gamesRemaining,
        opponents: ["BOS"],
      },
    ],
  ]);
}

describe("recommendation probability engine", () => {
  it("computes inclusive days remaining", () => {
    const asOf = new Date("2026-04-06T12:00:00Z");
    expect(getInclusiveDaysRemaining("2026-04-12", asOf)).toBe(7);
  });

  it("returns valid matchup probability outputs", () => {
    const [batterEntry, batterProj] = batterProjection("b1", "NYY");
    const [pitcherEntry, pitcherProj] = pitcherProjection("p1", "NYY");

    const roster: Roster = {
      entries: [batterEntry, pitcherEntry],
      date: "2026-04-06",
    };

    const projectionMap = new Map<string, PlayerProjection>([
      [batterProj.yahooId, batterProj],
      [pitcherProj.yahooId, pitcherProj],
    ]);

    const matchup: Matchup = {
      week: 2,
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      opponentTeamKey: "opp",
      opponentTeamName: "Opponent",
      categories: [
        { category: "R", myValue: 20, opponentValue: 19 },
        { category: "H", myValue: 32, opponentValue: 31 },
        { category: "HR", myValue: 6, opponentValue: 6 },
        { category: "RBI", myValue: 22, opponentValue: 21 },
        { category: "SB", myValue: 4, opponentValue: 5 },
        { category: "TB", myValue: 60, opponentValue: 58 },
        { category: "OBP", myValue: 0.31, opponentValue: 0.315 },
        { category: "OUT", myValue: 70, opponentValue: 68 },
        { category: "K", myValue: 38, opponentValue: 37 },
        { category: "ERA", myValue: 3.6, opponentValue: 3.7 },
        { category: "WHIP", myValue: 1.19, opponentValue: 1.21 },
        { category: "QS", myValue: 2, opponentValue: 2 },
        { category: "SVHD", myValue: 1, opponentValue: 2 },
      ],
    };

    const result = estimateMatchupWinProbability(
      matchup,
      roster,
      projectionMap,
      makeSchedule("NYY", 7),
      {
        asOf: new Date("2026-04-06T12:00:00Z"),
        simulations: 300,
        seed: 7,
      },
    );

    expect(result.daysRemaining).toBe(7);
    expect(result.winProbability).toBeGreaterThanOrEqual(0);
    expect(result.winProbability).toBeLessThanOrEqual(1);
    expect(result.expectedCategoryWins).toBeGreaterThanOrEqual(0);
    expect(result.expectedCategoryWins).toBeLessThanOrEqual(13);
    expect(result.categoryWinProbabilities).toHaveLength(13);
  });

  it("zero remaining games does not crash the probability estimate", () => {
    const [batterEntry, batterProj] = batterProjection("b1", "NYY");
    const roster: Roster = {
      entries: [batterEntry],
      date: "2026-04-12",
    };
    const projectionMap = new Map<string, PlayerProjection>([[batterProj.yahooId, batterProj]]);

    const matchup: Matchup = {
      week: 2,
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      opponentTeamKey: "opp",
      opponentTeamName: "Opponent",
      categories: [
        { category: "R", myValue: 40, opponentValue: 40 },
        { category: "H", myValue: 70, opponentValue: 70 },
        { category: "HR", myValue: 10, opponentValue: 10 },
        { category: "RBI", myValue: 35, opponentValue: 35 },
        { category: "SB", myValue: 4, opponentValue: 4 },
        { category: "TB", myValue: 110, opponentValue: 110 },
        { category: "OBP", myValue: 0.32, opponentValue: 0.32 },
        { category: "OUT", myValue: 90, opponentValue: 90 },
        { category: "K", myValue: 50, opponentValue: 50 },
        { category: "ERA", myValue: 3.5, opponentValue: 3.5 },
        { category: "WHIP", myValue: 1.2, opponentValue: 1.2 },
        { category: "QS", myValue: 3, opponentValue: 3 },
        { category: "SVHD", myValue: 2, opponentValue: 2 },
      ],
    };

    const result = estimateMatchupWinProbability(
      matchup,
      roster,
      projectionMap,
      makeSchedule("NYY", 0),
      {
        asOf: new Date("2026-04-12T12:00:00Z"),
        simulations: 200,
        seed: 9,
      },
    );

    expect(result.winProbability).toBeGreaterThanOrEqual(0);
    expect(result.winProbability).toBeLessThanOrEqual(1);
  });
});
