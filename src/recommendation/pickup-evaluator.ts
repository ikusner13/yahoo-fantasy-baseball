import type { TeamWeekSchedule } from "../analysis/game-count";
import type { PickupRecommendation } from "../analysis/waivers";
import { estimateMatchupWinProbability } from "./probability-engine";
import type { Category, Matchup, PlayerProjection, Roster } from "../types";

function formatDeltaPrefix(winProbabilityDelta: number, expectedCategoryWinsDelta: number): string {
  const winPctPoints = winProbabilityDelta * 100;
  const winPart = `${winPctPoints >= 0 ? "+" : ""}${winPctPoints.toFixed(1)} pp win odds`;
  const catPart = `${expectedCategoryWinsDelta >= 0 ? "+" : ""}${expectedCategoryWinsDelta.toFixed(2)} expected cats`;
  return `${winPart}, ${catPart}`;
}

function topCategorySwings(
  baseline: Map<Category, number>,
  next: Map<Category, number>,
): string | null {
  const deltas = [...next.entries()]
    .map(([category, value]) => ({
      category,
      delta: value - (baseline.get(category) ?? 0),
    }))
    .filter((entry) => entry.delta > 0.06)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3);

  if (deltas.length === 0) return null;
  return deltas
    .map((entry) => `${entry.category} +${(entry.delta * 100).toFixed(0)}pp`)
    .join(", ");
}

export function rerankPickupRecommendationsByMatchupDelta(
  recommendations: PickupRecommendation[],
  roster: Roster,
  matchup: Matchup,
  projectionMap: Map<string, PlayerProjection>,
  weekSchedule: Map<string, TeamWeekSchedule>,
  options?: {
    asOf?: Date;
    simulations?: number;
    seed?: number;
    opponentRoster?: Roster;
    opponentProjectionMap?: Map<string, PlayerProjection>;
  },
): PickupRecommendation[] {
  if (recommendations.length === 0) return recommendations;

  const baseline = estimateMatchupWinProbability(matchup, roster, projectionMap, weekSchedule, {
    asOf: options?.asOf,
    simulations: options?.simulations ?? 400,
    seed: options?.seed,
    opponentRoster: options?.opponentRoster,
    opponentProjectionMap: options?.opponentProjectionMap,
  });
  const baselineCategoryMap = new Map(
    baseline.categoryWinProbabilities.map((entry) => [entry.category, entry.winProbability]),
  );

  const enriched = recommendations.map((recommendation, index) => {
    const candidateProjection = projectionMap.get(recommendation.add.yahooId);
    if (!candidateProjection) return recommendation;

    const entries = roster.entries
      .filter((entry) => entry.player.yahooId !== recommendation.drop.yahooId)
      .concat({
        player: recommendation.add,
        currentPosition: "BN",
      });

    const nextRoster: Roster = {
      entries,
      date: roster.date,
    };

    const next = estimateMatchupWinProbability(matchup, nextRoster, projectionMap, weekSchedule, {
      asOf: options?.asOf,
      simulations: options?.simulations ?? 400,
      seed: options?.seed ?? 17,
      opponentRoster: options?.opponentRoster,
      opponentProjectionMap: options?.opponentProjectionMap,
    });

    const winProbabilityDelta = next.winProbability - baseline.winProbability;
    const expectedCategoryWinsDelta = next.expectedCategoryWins - baseline.expectedCategoryWins;
    const categorySwing = topCategorySwings(
      baselineCategoryMap,
      new Map(next.categoryWinProbabilities.map((entry) => [entry.category, entry.winProbability])),
    );

    return {
      ...recommendation,
      winProbabilityDelta,
      expectedCategoryWinsDelta,
      reasoning: categorySwing
        ? `${formatDeltaPrefix(winProbabilityDelta, expectedCategoryWinsDelta)}. ${categorySwing}. ${recommendation.reasoning}`
        : `${formatDeltaPrefix(winProbabilityDelta, expectedCategoryWinsDelta)}. ${recommendation.reasoning}`,
    };
  });

  return enriched.sort((a, b) => {
    const winDelta = (b.winProbabilityDelta ?? -Infinity) - (a.winProbabilityDelta ?? -Infinity);
    if (winDelta !== 0) return winDelta;

    const catDelta =
      (b.expectedCategoryWinsDelta ?? -Infinity) - (a.expectedCategoryWinsDelta ?? -Infinity);
    if (catDelta !== 0) return catDelta;

    return b.netValue - a.netValue;
  });
}
