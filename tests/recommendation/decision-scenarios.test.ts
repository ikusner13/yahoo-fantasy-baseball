import { describe, it, expect } from "vitest";
import { computeZScores } from "../../src/analysis/valuations";
import { analyzeMatchup, analyzeMatchupDetailed } from "../../src/analysis/matchup";
import { classifyAddPriority } from "../../src/analysis/add-budget";
import { shouldUseWaiverPriority } from "../../src/analysis/waivers";
import { estimateStreamingImpact, getIPStatus, scoreStreamingPitcher } from "../../src/analysis/streaming";
import type { PickupRecommendation } from "../../src/analysis/waivers";
import type { PlayerValuation, ScheduledGame } from "../../src/types";
import {
  makeEntry,
  makePlayer,
  recommendationScenarios,
} from "./scenarios";

function valuationMap(values: PlayerValuation[]): Map<string, PlayerValuation> {
  return new Map(values.map((v) => [v.yahooId, v]));
}

function makeGame(): ScheduledGame {
  return {
    gameId: 1,
    date: "2026-09-27",
    homeTeam: "NYY",
    awayTeam: "BOS",
    status: "scheduled",
  };
}

describe("recommendation scenarios", () => {
  it("ratio protection keeps ratios prioritized and avoids aggressive streaming", () => {
    const scenario = recommendationScenarios.ratioProtection;
    const analysis = analyzeMatchupDetailed(
      scenario.matchup,
      scenario.daysRemaining,
      scenario.currentIP,
      scenario.minimumIP,
    );

    expect(analyzeMatchup(scenario.matchup).strategy.protectRatios).toBe(true);
    expect(analysis.streamingDecision.qualityFloor).toBe("high-floor");
    expect(analysis.streamingDecision.canStream).toBe(true);
    expect(getIPStatus(scenario.currentIP, scenario.minimumIP).above).toBe(true);
  });

  it("innings minimum pressure forces streaming even when the ratio state is not ideal", () => {
    const scenario = recommendationScenarios.inningsMinimumPressure;
    const analysis = analyzeMatchupDetailed(
      scenario.matchup,
      scenario.daysRemaining,
      scenario.currentIP,
      scenario.minimumIP,
    );

    expect(getIPStatus(scenario.currentIP, scenario.minimumIP).above).toBe(false);
    expect(analysis.streamingDecision.canStream).toBe(true);
    expect(analysis.streamingDecision.qualityFloor).toBe("any");
    expect(analyzeMatchup(scenario.matchup).strategy.streamPitchers).toBe(true);
  });

  it("streamer-vs-ratio-risk ranks upside higher but flags ratio damage", () => {
    const scenario = recommendationScenarios.streamerVsRatioRisk;
    const detailed = analyzeMatchupDetailed(
      scenario.matchup,
      scenario.daysRemaining,
      scenario.currentIP,
      scenario.minimumIP,
    );

    const riskyScore = scoreStreamingPitcher({ projection: scenario.riskyPitcher, team: "NYY" }, makeGame());
    const safeScore = scoreStreamingPitcher(
      { projection: scenario.safePitcher, team: "NYY" },
      makeGame(),
    );

    const riskyImpact = estimateStreamingImpact(scenario.riskyPitcher, detailed.detailedCategories);
    const safeImpact = estimateStreamingImpact(scenario.safePitcher, detailed.detailedCategories);

    expect(riskyScore).toBeGreaterThan(safeScore);
    expect(riskyImpact.impacts.find((i) => i.category === "ERA")?.direction).toBe("hurts");
    expect(riskyImpact.impacts.find((i) => i.category === "WHIP")?.direction).toBe("hurts");
    expect(safeImpact.impacts.find((i) => i.category === "ERA")?.direction).not.toBe("hurts");
    expect(safeImpact.impacts.find((i) => i.category === "WHIP")?.direction).not.toBe("hurts");
  });

  it("must-add closer scenarios escalate to critical priority", () => {
    const scenario = recommendationScenarios.mustAddCloser;
    const pool = computeZScores([...scenario.rosterValuations, ...scenario.freeAgents]);
    const valMap = valuationMap(pool);
    const closer = valMap.get("closer-x");

    expect(closer).toBeDefined();

    const rec: PickupRecommendation = {
      add: { yahooId: "closer-x", name: "closer-x", team: "STL", positions: ["RP"] },
      drop: { yahooId: "roster-bat-4", name: "roster-bat-4", team: "NYY", positions: ["OF"] },
      netValue: 3.4,
      reasoning: "Add closer-x for saves and holds",
    };

    expect(classifyAddPriority(rec, { isCloserChange: true })).toBe("critical");
    expect(shouldUseWaiverPriority(rec, 1)).toBe(true);
  });

  it("sunday endgame shows final-day category pressure", () => {
    const scenario = recommendationScenarios.sundayEndgame;
    const detailed = analyzeMatchupDetailed(
      scenario.matchup,
      scenario.daysRemaining,
      scenario.currentIP,
      scenario.minimumIP,
    );

    expect(detailed.daysRemaining).toBe(1);
    expect(detailed.worthlessCategories).toContain("SB");
    expect(detailed.lostCategories).toContain("SB");
    expect(detailed.swingCategories.length).toBeGreaterThan(0);
    expect(analyzeMatchup(scenario.matchup).strategy.prioritizePower).toBe(true);
    expect(getIPStatus(scenario.currentIP, scenario.minimumIP).ipNeeded).toBe(2);
  });

  it("scenario fixtures build valid roster and player shapes", () => {
    const entry = makeEntry(makePlayer("fixture-player", ["OF"], "NYY"));
    expect(entry.player.yahooId).toBe("fixture-player");
    expect(entry.currentPosition).toBe("BN");
  });
});
