import type { Player, PitcherStats, ScheduledGame } from "../types";
import type { MatchupAnalysis } from "./matchup";

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

  // QS probability bonus
  const qsBonus = proj.ip > 5.5 && proj.era < 4.5 ? 1.0 : 0;

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
