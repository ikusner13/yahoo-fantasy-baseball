import type { Player, PitcherStats, ScheduledGame, Category } from "../types";
import type { MatchupAnalysis, DetailedCategoryState } from "./matchup";
import { loadLeagueSettings } from "../config/league";

// --- Constants ---

const LEAGUE_AVG_WOBA = 0.32;
const DEFAULT_PARK_FACTOR = 1.0;

// --- Core exports ---

/**
 * Score a pitcher as a streaming candidate for a given game.
 *
 * Score = weighted sum of:
 *   - Projected K rate (K/IP, higher = better) x 2
 *   - Projected ERA (lower = better, inverted) x 1.5
 *   - Opponent weakness: (league avg wOBA - opponent wOBA) x 3
 *   - Park factor: (1 - parkFactor) x 0.5  (pitcher-friendly < 1.0 = boost)
 *   - QS probability bonus: +1.0 if IP > 5.5 and ERA < 4.5
 */
export function scoreStreamingPitcher(
  pitcher: { projection?: PitcherStats; team: string },
  game: ScheduledGame,
  opponentWoba: number = LEAGUE_AVG_WOBA,
  parkFactor: number = DEFAULT_PARK_FACTOR,
): number {
  const proj = pitcher.projection;
  if (!proj) return 0;

  // K rate: K per IP (handle zero IP)
  const kRate = proj.ip > 0 ? proj.k / proj.ip : 0;

  // ERA inverted: lower ERA = higher score. Use (5.0 - ERA) so a 3.0 ERA → 2.0, 5.0 → 0.0
  const eraScore = Math.max(0, 5.0 - proj.era);

  // Opponent weakness: positive when opponent is below league avg
  const opponentWeakness = LEAGUE_AVG_WOBA - opponentWoba;

  // Park factor: pitcher-friendly parks have factor < 1.0
  const parkAdjustment = 1.0 - parkFactor;

  // QS probability bonus — use projected QS rate, not season IP (always > 5.5)
  const estimatedGS = proj.ip >= 30 ? Math.round(proj.ip / 6) : 0;
  const qsRate = estimatedGS > 0 ? proj.qs / estimatedGS : 0;
  const qsBonus = qsRate > 0.25 && proj.era < 4.5 ? 1.0 : 0;

  return kRate * 2.0 + eraScore * 1.5 + opponentWeakness * 3.0 + parkAdjustment * 0.5 + qsBonus;
}

/**
 * Rank available streaming pitchers by score.
 * Filters to pitchers whose team has a game today, scores each, returns sorted desc.
 */
export function rankStreamingOptions(
  pitchers: Array<{ player: Player; projection?: PitcherStats }>,
  games: ScheduledGame[],
  opponentWobas?: Map<string, number>,
  parkFactors?: Map<string, number>,
): Array<{ player: Player; score: number; opponent: string }> {
  // Build team → game + opponent lookup
  const teamGameMap = new Map<string, { game: ScheduledGame; opponent: string }>();
  for (const game of games) {
    teamGameMap.set(game.homeTeam, { game, opponent: game.awayTeam });
    teamGameMap.set(game.awayTeam, { game, opponent: game.homeTeam });
  }

  const results: Array<{ player: Player; score: number; opponent: string }> = [];

  for (const p of pitchers) {
    const entry = teamGameMap.get(p.player.team);
    if (!entry) continue; // team doesn't play today

    const oppWoba = opponentWobas?.get(entry.opponent) ?? LEAGUE_AVG_WOBA;

    // Park factor keyed by home team (the venue)
    const homeTeam = entry.game.homeTeam === p.player.team ? p.player.team : entry.opponent;
    const pf = parkFactors?.get(homeTeam) ?? DEFAULT_PARK_FACTOR;

    const score = scoreStreamingPitcher(
      { projection: p.projection, team: p.player.team },
      entry.game,
      oppWoba,
      pf,
    );

    results.push({ player: p.player, score, opponent: entry.opponent });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Decide whether to stream a pitcher given current matchup state.
 *
 * - No matchup data → always stream
 * - Protecting ratios AND good current ratios → DON'T stream
 * - Otherwise → stream
 */
export function shouldStream(
  matchup: MatchupAnalysis | null,
  currentEra: number,
  currentWhip: number,
): boolean {
  if (!matchup) return true;

  if (matchup.strategy.protectRatios && currentEra < 3.5 && currentWhip < 1.2) return false;

  return true;
}

// --- Net category impact & IP tracking ---

export interface CategoryImpact {
  category: Category;
  direction: "helps" | "hurts" | "neutral";
  magnitude: "high" | "medium" | "low";
}

/**
 * Estimate how a streaming pitcher start affects each matchup category.
 * Compares projected stat contributions against current category margins.
 *
 * Assumptions for a typical streaming start: ~6 IP (18 outs), ~6 K, possible QS.
 * ERA/WHIP impact depends on pitcher projection quality vs current team rates.
 */
export function estimateStreamingImpact(
  pitcherProjection: PitcherStats,
  categoryStates: DetailedCategoryState[],
): {
  impacts: CategoryImpact[];
  netCategoriesHelped: number;
  netCategoriesHurt: number;
} {
  const stateMap = new Map(categoryStates.map((c) => [c.category, c]));
  const impacts: CategoryImpact[] = [];
  let helped = 0;
  let hurt = 0;

  // Projected contributions from this start
  const projectedOuts = pitcherProjection.outs || pitcherProjection.ip * 3;
  const projectedK = pitcherProjection.k;
  const projectedQS = pitcherProjection.ip >= 6 && pitcherProjection.era < 4.5 ? 1 : 0;
  const projectedSVHD = pitcherProjection.svhd;

  // Counting stat contributions: K, OUT, QS, SVHD
  const countingContributions: Array<{
    cat: Category;
    projected: number;
  }> = [
    { cat: "K", projected: projectedK },
    { cat: "OUT", projected: projectedOuts },
    { cat: "QS", projected: projectedQS },
    { cat: "SVHD", projected: projectedSVHD },
  ];

  for (const { cat, projected } of countingContributions) {
    const state = stateMap.get(cat);
    if (!state) continue;

    // No impact if category is clinched or lost
    if (state.state === "clinched" || state.state === "lost") {
      impacts.push({ category: cat, direction: "neutral", magnitude: "low" });
      continue;
    }

    if (projected <= 0) {
      impacts.push({ category: cat, direction: "neutral", magnitude: "low" });
      continue;
    }

    // If we're losing/swing and this contribution could flip or narrow the gap
    const deficit = Math.abs(state.margin);
    if (state.state === "swing" || state.state === "losing") {
      if (state.margin < 0 && projected >= deficit) {
        // Could flip the category
        impacts.push({ category: cat, direction: "helps", magnitude: "high" });
        helped++;
      } else if (state.margin < 0 && projected >= deficit * 0.5) {
        impacts.push({ category: cat, direction: "helps", magnitude: "medium" });
        helped++;
      } else if (state.margin >= 0) {
        // We're winning a swing cat — padding the lead
        impacts.push({ category: cat, direction: "helps", magnitude: "low" });
      } else {
        impacts.push({ category: cat, direction: "helps", magnitude: "low" });
      }
    } else if (state.state === "safe") {
      // Padding a safe lead — minor help
      impacts.push({ category: cat, direction: "helps", magnitude: "low" });
    }
  }

  // Rate stat impact: ERA, WHIP
  // Adding IP with a certain ERA/WHIP moves team totals toward the pitcher's rates
  for (const rateCat of ["ERA", "WHIP"] as const) {
    const state = stateMap.get(rateCat);
    if (!state) continue;

    if (state.state === "clinched" || state.state === "lost") {
      impacts.push({ category: rateCat, direction: "neutral", magnitude: "low" });
      continue;
    }

    // Compare pitcher's rate to a "neutral" threshold
    // ERA < 3.50 = good, 3.50-4.50 = risky, > 4.50 = bad
    // WHIP < 1.15 = good, 1.15-1.35 = risky, > 1.35 = bad
    const pitcherRate = rateCat === "ERA" ? pitcherProjection.era : pitcherProjection.whip;
    const goodThreshold = rateCat === "ERA" ? 3.5 : 1.15;
    const badThreshold = rateCat === "ERA" ? 4.5 : 1.35;

    if (state.state === "safe" || (state.state === "swing" && state.margin > 0)) {
      // We're winning — a bad pitcher hurts
      if (pitcherRate > badThreshold) {
        impacts.push({ category: rateCat, direction: "hurts", magnitude: "high" });
        hurt++;
      } else if (pitcherRate > goodThreshold) {
        impacts.push({ category: rateCat, direction: "hurts", magnitude: "medium" });
        hurt++;
      } else {
        impacts.push({ category: rateCat, direction: "helps", magnitude: "low" });
      }
    } else {
      // We're losing — a good pitcher helps
      if (pitcherRate < goodThreshold) {
        impacts.push({ category: rateCat, direction: "helps", magnitude: "medium" });
        helped++;
      } else if (pitcherRate < badThreshold) {
        impacts.push({ category: rateCat, direction: "neutral", magnitude: "low" });
      } else {
        impacts.push({ category: rateCat, direction: "hurts", magnitude: "low" });
      }
    }
  }

  return { impacts, netCategoriesHelped: helped, netCategoriesHurt: hurt };
}

/**
 * Track IP status against the weekly minimum requirement.
 */
export function getIPStatus(
  currentIP: number,
  minimum: number = loadLeagueSettings().pitching.minimumInningsPerWeek,
): {
  currentIP: number;
  minimum: number;
  above: boolean;
  ipNeeded: number;
} {
  return {
    currentIP,
    minimum,
    above: currentIP >= minimum,
    ipNeeded: Math.max(0, minimum - currentIP),
  };
}
