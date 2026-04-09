import { simulateMatchup, type DailyProjection, type SimulationResult } from "../analysis/monte-carlo";
import type { TeamWeekSchedule } from "../analysis/game-count";
import type { Category, Matchup, PlayerProjection, Roster } from "../types";

const ROS_GAMES = 130;

export interface CategoryWinProbability {
  category: Category;
  currentValue: number;
  opponentValue: number;
  winProbability: number;
}

export interface MatchupProbabilitySnapshot {
  daysRemaining: number;
  winProbability: number;
  expectedCategoryWins: number;
  categoryWinProbabilities: CategoryWinProbability[];
  simulations: number;
}

function buildRemainingDailyProjections(
  roster: Roster,
  projectionMap: Map<string, PlayerProjection>,
  weekSchedule: Map<string, TeamWeekSchedule>,
  daysRemaining: number,
): DailyProjection[] {
  const safeDaysRemaining = Math.max(daysRemaining, 1);
  const dailyProjections: DailyProjection[] = [];

  for (const entry of roster.entries) {
    const player = entry.player;
    const projection = projectionMap.get(player.yahooId);

    if (!projection) continue;
    if (entry.currentPosition === "IL" || player.status === "IL" || player.status === "OUT") continue;

    const teamSchedule = weekSchedule.get(player.team);
    const gamesRemaining = teamSchedule?.gamesRemaining ?? safeDaysRemaining;
    if (gamesRemaining <= 0) continue;

    const gamesPerDay = gamesRemaining / safeDaysRemaining;

    if (projection.playerType === "batter" && projection.batting) {
      const batting = projection.batting;
      const paPerGame = batting.pa / ROS_GAMES;
      const paPerDay = paPerGame * gamesPerDay;

      dailyProjections.push({
        yahooId: player.yahooId,
        playerType: "batter",
        batting: {
          r: (batting.r / ROS_GAMES) * gamesPerDay,
          h: (batting.h / ROS_GAMES) * gamesPerDay,
          hr: (batting.hr / ROS_GAMES) * gamesPerDay,
          rbi: (batting.rbi / ROS_GAMES) * gamesPerDay,
          sb: (batting.sb / ROS_GAMES) * gamesPerDay,
          tb: (batting.tb / ROS_GAMES) * gamesPerDay,
          pa: paPerDay,
          obp_numerator: batting.obp * paPerDay,
        },
      });
      continue;
    }

    if (projection.playerType === "pitcher" && projection.pitching) {
      const pitching = projection.pitching;
      const ipPerGame = pitching.ip / ROS_GAMES;
      const ipPerDay = ipPerGame * gamesPerDay;

      dailyProjections.push({
        yahooId: player.yahooId,
        playerType: "pitcher",
        pitching: {
          er: (pitching.era * ipPerDay) / 9,
          outs: (pitching.outs / ROS_GAMES) * gamesPerDay,
          k: (pitching.k / ROS_GAMES) * gamesPerDay,
          qs: (pitching.qs / ROS_GAMES) * gamesPerDay,
          svhd: (pitching.svhd / ROS_GAMES) * gamesPerDay,
          whip_numerator: pitching.whip * ipPerDay,
        },
      });
    }
  }

  return dailyProjections;
}

export function getInclusiveDaysRemaining(weekEnd: string, asOf: Date = new Date()): number {
  const today = new Date(asOf.toISOString().slice(0, 10));
  const end = new Date(weekEnd);
  const diffDays = Math.ceil((end.getTime() - today.getTime()) / 86400000);
  return Math.max(1, diffDays + 1);
}

export function estimateMatchupWinProbability(
  matchup: Matchup,
  roster: Roster,
  projectionMap: Map<string, PlayerProjection>,
  weekSchedule: Map<string, TeamWeekSchedule>,
  options?: {
    asOf?: Date;
    simulations?: number;
    seed?: number;
  },
): MatchupProbabilitySnapshot {
  const daysRemaining = getInclusiveDaysRemaining(matchup.weekEnd, options?.asOf);
  const myDailyProjections = buildRemainingDailyProjections(
    roster,
    projectionMap,
    weekSchedule,
    daysRemaining,
  );

  const result: SimulationResult = simulateMatchup(
    matchup.categories,
    daysRemaining,
    myDailyProjections,
    undefined,
    options?.simulations,
    {
      totalDays: 7,
      seed: options?.seed,
    },
  );

  const categoryWinProbabilities = matchup.categories
    .map((score) => ({
      category: score.category,
      currentValue: score.myValue,
      opponentValue: score.opponentValue,
      winProbability: result.categoryWinProbs.get(score.category) ?? 0,
    }))
    .sort((a, b) => Math.abs(a.winProbability - 0.5) - Math.abs(b.winProbability - 0.5));

  return {
    daysRemaining,
    winProbability: result.winProbability,
    expectedCategoryWins: result.expectedCategoryWins,
    categoryWinProbabilities,
    simulations: result.simulations,
  };
}
