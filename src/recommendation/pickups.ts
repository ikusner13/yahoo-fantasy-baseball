import type { TeamWeekSchedule } from "../analysis/game-count";
import { rankDroppablePlayers, type PickupRecommendation } from "../analysis/waivers";
import { estimateMatchupWinProbability } from "./probability-engine";
import type {
  Category,
  Matchup,
  Player,
  PlayerProjection,
  PlayerValuation,
  Roster,
  RosterEntry,
} from "../types";

export interface MatchupPickupOptions {
  roster: Roster;
  freeAgents: Player[];
  rosterValuations: Map<string, PlayerValuation>;
  rosterProjectionMap: Map<string, PlayerProjection>;
  freeAgentProjectionMap: Map<string, PlayerProjection>;
  matchup: Matchup;
  weekSchedule: Map<string, TeamWeekSchedule>;
  asOf?: Date;
  simulations?: number;
  seed?: number;
  limit?: number;
  dropCandidatesPerPlayer?: number;
  opponentRoster?: Roster;
  opponentProjectionMap?: Map<string, PlayerProjection>;
}

function replaceRosterEntry(roster: Roster, drop: RosterEntry, add: Player): Roster {
  return {
    date: roster.date,
    entries: [
      ...roster.entries.filter((entry) => entry.player.yahooId !== drop.player.yahooId),
      {
        player: add,
        currentPosition: drop.currentPosition === "IL" ? "BN" : drop.currentPosition,
      },
    ],
  };
}

function isPitcher(projection: PlayerProjection | undefined, player: Player): boolean {
  if (projection) return projection.playerType === "pitcher";
  return player.positions.includes("SP") || player.positions.includes("RP") || player.positions.includes("P");
}

function topCategoryGains(
  baseline: ReturnType<typeof estimateMatchupWinProbability>,
  upgraded: ReturnType<typeof estimateMatchupWinProbability>,
): Category[] {
  const baselineMap = new Map(
    baseline.categoryWinProbabilities.map((category) => [category.category, category.winProbability]),
  );

  return upgraded.categoryWinProbabilities
    .map((category) => ({
      category: category.category,
      baseline: baselineMap.get(category.category) ?? 0,
      delta: category.winProbability - (baselineMap.get(category.category) ?? 0),
    }))
    .filter(
      (category) =>
        category.delta >= 0.02 &&
        category.baseline >= 0.35 &&
        category.baseline <= 0.65,
    )
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
    .map((category) => category.category);
}

function formatPickupReasoning(
  baseline: ReturnType<typeof estimateMatchupWinProbability>,
  upgraded: ReturnType<typeof estimateMatchupWinProbability>,
): string {
  const gains = topCategoryGains(baseline, upgraded);
  const gainText = gains.length > 0 ? ` Helps ${gains.join(", ")}.` : "";

  return `Win odds ${Math.round(baseline.winProbability * 100)}% → ${Math.round(upgraded.winProbability * 100)}%. Expected cats ${baseline.expectedCategoryWins.toFixed(1)} → ${upgraded.expectedCategoryWins.toFixed(1)}.${gainText}`;
}

export function evaluateMatchupPickups(options: MatchupPickupOptions): PickupRecommendation[] {
  const {
    roster,
    freeAgents,
    rosterValuations,
    rosterProjectionMap,
    freeAgentProjectionMap,
    matchup,
    weekSchedule,
    asOf,
    simulations = 500,
    seed = 42,
    limit = 3,
    dropCandidatesPerPlayer = 3,
    opponentRoster,
    opponentProjectionMap,
  } = options;

  if (freeAgents.length === 0 || rosterProjectionMap.size === 0 || freeAgentProjectionMap.size === 0) {
    return [];
  }

  const baseline = estimateMatchupWinProbability(matchup, roster, rosterProjectionMap, weekSchedule, {
    asOf,
    simulations,
    seed,
    opponentRoster,
    opponentProjectionMap,
  });

  const preferredDrops = rankDroppablePlayers(roster.entries, rosterValuations);
  if (preferredDrops.length === 0) return [];

  const recommendations: PickupRecommendation[] = [];

  for (const freeAgent of freeAgents) {
    const freeAgentProjection = freeAgentProjectionMap.get(freeAgent.yahooId);
    if (!freeAgentProjection) continue;

    const sameTypeDrops = preferredDrops.filter((entry) => {
      const dropProjection = rosterProjectionMap.get(entry.player.yahooId);
      return isPitcher(dropProjection, entry.player) === isPitcher(freeAgentProjection, freeAgent);
    });
    const orderedDrops = [...sameTypeDrops, ...preferredDrops.filter((entry) => !sameTypeDrops.includes(entry))]
      .slice(0, dropCandidatesPerPlayer);

    let bestRecommendation: PickupRecommendation | null = null;

    for (const drop of orderedDrops) {
      const upgradedRoster = replaceRosterEntry(roster, drop, freeAgent);
      const upgradedProjectionMap = new Map(rosterProjectionMap);
      upgradedProjectionMap.set(freeAgent.yahooId, freeAgentProjection);

      const upgraded = estimateMatchupWinProbability(
        matchup,
        upgradedRoster,
        upgradedProjectionMap,
        weekSchedule,
        {
          asOf,
          simulations,
          seed,
          opponentRoster,
          opponentProjectionMap,
        },
      );

      const winProbabilityDelta = upgraded.winProbability - baseline.winProbability;
      const expectedCategoryWinsDelta =
        upgraded.expectedCategoryWins - baseline.expectedCategoryWins;
      const gains = topCategoryGains(baseline, upgraded);

      if (
        winProbabilityDelta < 0.01 &&
        (expectedCategoryWinsDelta < 0.15 || gains.length === 0)
      ) {
        continue;
      }

      const recommendation: PickupRecommendation = {
        add: freeAgent,
        drop: drop.player,
        netValue: winProbabilityDelta * 100,
        winProbabilityDelta,
        expectedCategoryWinsDelta,
        targetCategories: gains,
        reasoning: formatPickupReasoning(baseline, upgraded),
      };

      if (
        !bestRecommendation ||
        (recommendation.winProbabilityDelta ?? 0) > (bestRecommendation.winProbabilityDelta ?? 0) ||
        (
          (recommendation.winProbabilityDelta ?? 0) === (bestRecommendation.winProbabilityDelta ?? 0) &&
          (recommendation.expectedCategoryWinsDelta ?? 0) >
            (bestRecommendation.expectedCategoryWinsDelta ?? 0)
        )
      ) {
        bestRecommendation = recommendation;
      }
    }

    if (bestRecommendation) recommendations.push(bestRecommendation);
  }

  recommendations.sort((a, b) => {
    const winDelta = (b.winProbabilityDelta ?? 0) - (a.winProbabilityDelta ?? 0);
    if (winDelta !== 0) return winDelta;
    return (b.expectedCategoryWinsDelta ?? 0) - (a.expectedCategoryWinsDelta ?? 0);
  });

  return recommendations.slice(0, limit);
}
