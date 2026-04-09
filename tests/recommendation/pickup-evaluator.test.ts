import { describe, expect, it, vi } from "vitest";
import type { TeamWeekSchedule } from "../../src/analysis/game-count";
import type { Matchup, PlayerProjection, Roster } from "../../src/types";
import type { PickupRecommendation } from "../../src/analysis/waivers";

vi.mock("../../src/recommendation/probability-engine", () => ({
  estimateMatchupWinProbability: vi.fn((_: Matchup, roster: Roster) => {
    const ids = new Set(roster.entries.map((entry) => entry.player.yahooId));

    if (ids.has("fa-power")) {
      return {
        daysRemaining: 3,
        winProbability: 0.62,
        expectedCategoryWins: 7.3,
        categoryWinProbabilities: [
          { category: "HR", currentValue: 7, opponentValue: 8, winProbability: 0.58 },
          { category: "RBI", currentValue: 28, opponentValue: 31, winProbability: 0.55 },
        ],
        simulations: 400,
      };
    }

    if (ids.has("fa-speed")) {
      return {
        daysRemaining: 3,
        winProbability: 0.55,
        expectedCategoryWins: 6.9,
        categoryWinProbabilities: [
          { category: "SB", currentValue: 12, opponentValue: 3, winProbability: 0.97 },
          { category: "OBP", currentValue: 0.351, opponentValue: 0.309, winProbability: 0.94 },
        ],
        simulations: 400,
      };
    }

    return {
      daysRemaining: 3,
      winProbability: 0.5,
      expectedCategoryWins: 6.5,
      categoryWinProbabilities: [
        { category: "HR", currentValue: 7, opponentValue: 8, winProbability: 0.43 },
        { category: "RBI", currentValue: 28, opponentValue: 31, winProbability: 0.4 },
      ],
      simulations: 400,
    };
  }),
}));

import { rerankPickupRecommendationsByMatchupDelta } from "../../src/recommendation/pickup-evaluator";

function weekSchedule(team: string): Map<string, TeamWeekSchedule> {
  return new Map([
    [
      team,
      {
        team,
        gamesThisWeek: 7,
        gamesRemaining: 3,
        opponents: ["BOS"],
      },
    ],
  ]);
}

describe("pickup evaluator", () => {
  it("reranks waiver suggestions by matchup win-probability delta", () => {
    const roster: Roster = {
      date: "2026-04-10",
      entries: [
        {
          player: {
            yahooId: "drop-bat",
            name: "drop-bat",
            team: "NYY",
            positions: ["OF"],
            status: "healthy",
          },
          currentPosition: "OF",
        },
      ],
    };

    const matchup: Matchup = {
      week: 2,
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      opponentTeamKey: "opp",
      opponentTeamName: "Opponent",
      categories: [
        { category: "HR", myValue: 7, opponentValue: 8 },
        { category: "RBI", myValue: 28, opponentValue: 31 },
      ] as Matchup["categories"],
    };

    const recommendations: PickupRecommendation[] = [
      {
        add: { yahooId: "fa-speed", name: "fa-speed", team: "NYY", positions: ["OF"] },
        drop: roster.entries[0]!.player,
        netValue: 2.2,
        reasoning: "speed-oriented upgrade",
      },
      {
        add: { yahooId: "fa-power", name: "fa-power", team: "NYY", positions: ["OF"] },
        drop: roster.entries[0]!.player,
        netValue: 1.8,
        reasoning: "power-oriented upgrade",
      },
    ];

    const reranked = rerankPickupRecommendationsByMatchupDelta(
      recommendations,
      roster,
      matchup,
      new Map<string, PlayerProjection>([
        [
          "fa-speed",
          {
            yahooId: "fa-speed",
            playerType: "batter",
            batting: { pa: 500, r: 70, h: 140, hr: 3, rbi: 35, sb: 40, tb: 145, obp: 0.355 },
            updatedAt: "2026-04-09",
          },
        ],
        [
          "fa-power",
          {
            yahooId: "fa-power",
            playerType: "batter",
            batting: { pa: 500, r: 78, h: 138, hr: 42, rbi: 108, sb: 3, tb: 315, obp: 0.328 },
            updatedAt: "2026-04-09",
          },
        ],
      ]),
      weekSchedule("NYY"),
      {
        asOf: new Date("2026-04-10T12:00:00Z"),
        simulations: 400,
        seed: 11,
      },
    );

    expect(reranked[0]?.add.yahooId).toBe("fa-power");
    expect(reranked[0]?.winProbabilityDelta).toBeCloseTo(0.12);
    expect(reranked[0]?.reasoning).toContain("win odds");
  });
});
