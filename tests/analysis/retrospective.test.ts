import { describe, expect, it } from "vitest";
import { buildRetrospective, formatRetrospectiveForTelegram } from "../../src/analysis/retrospective";
import type { Matchup } from "../../src/types";

describe("retrospective scoring", () => {
  const finalMatchup: Matchup = {
    week: 3,
    weekStart: "2026-04-06",
    weekEnd: "2026-04-12",
    opponentTeamKey: "opp.1",
    opponentTeamName: "Opps",
    categories: [
      { category: "R", myValue: 40, opponentValue: 35 },
      { category: "H", myValue: 70, opponentValue: 60 },
      { category: "HR", myValue: 10, opponentValue: 9 },
      { category: "RBI", myValue: 38, opponentValue: 39 },
      { category: "SB", myValue: 5, opponentValue: 7 },
      { category: "TB", myValue: 115, opponentValue: 110 },
      { category: "OBP", myValue: 0.341, opponentValue: 0.328 },
      { category: "OUT", myValue: 145, opponentValue: 132 },
      { category: "K", myValue: 55, opponentValue: 49 },
      { category: "ERA", myValue: 3.45, opponentValue: 3.9 },
      { category: "WHIP", myValue: 1.1, opponentValue: 1.19 },
      { category: "QS", myValue: 4, opponentValue: 3 },
      { category: "SVHD", myValue: 7, opponentValue: 4 },
    ],
  };

  it("reconstructs weekly predictions and evaluates targeted decisions", () => {
    const retro = buildRetrospective(finalMatchup, undefined, [
      {
        timestamp: "2026-04-06 09:00:00",
        type: "lineup",
        action: JSON.stringify({
          routine: "weekly_matchup",
          week: 3,
          safe: ["R", "H", "ERA", "WHIP"],
          swing: ["SVHD", "QS"],
          lost: ["SB"],
          winProbability: 0.74,
        }),
        reasoning: "Week 3 matchup analysis",
      },
      {
        timestamp: "2026-04-07 09:00:00",
        type: "waiver",
        action: JSON.stringify({
          date: "2026-04-07",
          add: "Robert Suarez",
          drop: "Bench Bat",
          winProbabilityDelta: 0.031,
          targetCategories: ["SVHD"],
        }),
        reasoning: "Win odds 71% → 74%. Helps SVHD.",
      },
      {
        timestamp: "2026-04-08 09:00:00",
        type: "stream",
        action: JSON.stringify({
          date: "2026-04-08",
          add: "Risky Streamer",
          drop: "Last Bench Arm",
          targetCategories: ["SB"],
        }),
        reasoning: "Chases SB somehow",
      },
    ]);

    expect(retro.predictions.find((prediction) => prediction.category === "R")?.predictedState).toBe(
      "safe",
    );
    expect(
      retro.predictions.find((prediction) => prediction.category === "SVHD")?.predictedState,
    ).toBe("swing");
    expect(retro.decisions.find((decision) => decision.type === "waiver")?.outcome).toBe("good");
    expect(retro.decisions.find((decision) => decision.type === "stream")?.outcome).toBe("bad");
    expect(retro.scorecard.goodDecisions).toBe(1);
    expect(retro.scorecard.badDecisions).toBe(1);
    expect(retro.scorecard.averageBrierScore).toBeCloseTo((0.74 - 1) ** 2, 5);
  });

  it("formats scorecard details in telegram output", () => {
    const retro = buildRetrospective(finalMatchup, undefined, [
      {
        timestamp: "2026-04-06 09:00:00",
        type: "lineup",
        action: JSON.stringify({
          routine: "weekly_matchup",
          week: 3,
          safe: ["R", "H"],
          swing: ["SVHD"],
          lost: ["SB"],
          winProbability: 0.74,
        }),
        reasoning: "Week 3 matchup analysis",
      },
      {
        timestamp: "2026-04-07 09:00:00",
        type: "waiver",
        action: JSON.stringify({
          add: "Robert Suarez",
          drop: "Bench Bat",
          targetCategories: ["SVHD"],
        }),
        reasoning: "Helps SVHD",
      },
    ]);

    const message = formatRetrospectiveForTelegram(retro);

    expect(message).toContain("Recs: 1 good / 0 bad / 0 neutral");
    expect(message).toContain("Win-odds Brier:");
    expect(message).toContain("SVHD won");
  });

  it("falls back to daily forecasts and dedupes repeated probability calls", () => {
    const retro = buildRetrospective(finalMatchup, undefined, [
      {
        id: 10,
        timestamp: "2026-04-07 09:00:00",
        type: "lineup",
        action: JSON.stringify({
          routine: "daily_morning",
          date: "2026-04-07",
          safe: ["R", "H", "ERA"],
          swing: ["SVHD"],
          lost: ["SB"],
          winProbability: 0.68,
        }),
        reasoning: "Morning routine completed for 2026-04-07",
      },
      {
        id: 11,
        timestamp: "2026-04-07 09:05:00",
        type: "lineup",
        action: JSON.stringify({
          routine: "daily_morning",
          date: "2026-04-07",
          safe: ["R", "H", "ERA"],
          swing: ["SVHD"],
          lost: ["SB"],
          winProbability: 0.68,
        }),
        reasoning: "Morning routine completed for 2026-04-07",
      },
    ]);

    expect(
      retro.predictions.find((prediction) => prediction.category === "R")?.predictedState,
    ).toBe("safe");
    expect(retro.predictions.find((prediction) => prediction.category === "SB")?.predictedState).toBe(
      "losing",
    );
    expect(retro.scorecard.probabilityCalls).toHaveLength(1);
    expect(retro.scorecard.averageBrierScore).toBeCloseTo((0.68 - 1) ** 2, 5);
  });
});
