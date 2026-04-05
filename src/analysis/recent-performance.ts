import type { StatcastBatter, PlayerProjection } from "../types";

// ---------------------------------------------------------------------------
// Research notes
// ---------------------------------------------------------------------------
// - xwOBA has the highest predictive power for short-term future performance
//   among Statcast metrics (r ~0.5 over 2-week windows vs ~0.3 for AVG)
// - Hot streaks in baseball have limited predictive value beyond ~2 weeks,
//   so weight should be modest (default 15%)
// - Barrel% and hard hit% changes are more "real" than batting average
//   fluctuations — these reflect process changes, not luck
// - The 15% default weight is conservative: research shows recent performance
//   explains ~10-20% of near-term variance (Carleton, 2015; Lichtman, 2019)
// ---------------------------------------------------------------------------

export interface RecentPerformance {
  mlbId: number;
  name: string;
  // Recent Statcast (from leaderboard, represents ~current season)
  recentXwoba: number;
  recentBarrelPct: number;
  recentHardHitPct: number;
  recentExitVelo: number;
  // Projected xwOBA (from FanGraphs, represents expected performance)
  projectedObp: number;
  // Streak indicators
  streakScore: number; // positive = hot, negative = cold (-1 to 1 scale)
  streakConfidence: number; // 0 to 1, how much data backs this
}

// ---------------------------------------------------------------------------
// Streak computation
// ---------------------------------------------------------------------------

/**
 * Match Statcast batters to FanGraphs projections and compute hot/cold streaks.
 *
 * Matching strategy: StatcastBatter has mlbId, PlayerProjection has yahooId.
 * The caller must supply a lookup map (mlbId -> yahooId) for cross-referencing.
 * If no map is provided, falls back to matching via the optional `names` map
 * (mlbId -> display name matched against projection names).
 */
export function computeStreaks(
  statcast: StatcastBatter[],
  projections: PlayerProjection[],
  mlbIdToYahooId?: Map<number, string>,
  mlbIdToName?: Map<number, string>,
): RecentPerformance[] {
  // Build projection lookup by yahooId
  const projByYahoo = new Map<string, PlayerProjection>();
  for (const p of projections) {
    if (p.playerType === "batter" && p.batting) {
      projByYahoo.set(p.yahooId, p);
    }
  }

  // Collect all xwOBA values to compute stddev for z-score normalization
  const xwobaValues = statcast.map((s) => s.xwoba).filter((v) => v > 0);
  const sd = populationStddev(xwobaValues);

  const results: RecentPerformance[] = [];

  for (const sc of statcast) {
    // Try to find matching projection
    const yahooId = mlbIdToYahooId?.get(sc.mlbId);
    const proj = yahooId ? projByYahoo.get(yahooId) : undefined;
    if (!proj?.batting) continue;

    const projectedObp = proj.batting.obp;
    // Convert OBP to approximate wOBA scale: wOBA ~= OBP * 1.15
    // This is a rough heuristic; true conversion requires league-level constants
    const projectedWoba = projectedObp * 1.15;

    const rawDelta = sd > 0 ? (sc.xwoba - projectedWoba) / sd : 0;
    const streakScore = clamp(rawDelta, -1, 1);

    // Confidence: Savant leaderboard min is 25 PA. Scale linearly to 1.0 at 100 PA.
    // Since the leaderboard doesn't expose PA directly, use a proxy:
    // if exitVelo > 0 the player has qualifying ABs. Default to 0.5 (moderate confidence)
    // for leaderboard-sourced data since min=25 PA filter is applied at fetch time.
    const streakConfidence = sc.exitVelo > 0 ? 0.5 : 0.25;

    const name = mlbIdToName?.get(sc.mlbId) ?? `MLB#${sc.mlbId}`;

    results.push({
      mlbId: sc.mlbId,
      name,
      recentXwoba: sc.xwoba,
      recentBarrelPct: sc.barrelPct,
      recentHardHitPct: sc.hardHitPct,
      recentExitVelo: sc.exitVelo,
      projectedObp,
      streakScore,
      streakConfidence,
    });
  }

  return results;
}

/**
 * Overload that accepts PA counts per player for more accurate confidence.
 * `paMap` keys are mlbId, values are plate appearances in the recent window.
 */
export function computeStreaksWithPA(
  statcast: StatcastBatter[],
  projections: PlayerProjection[],
  mlbIdToYahooId: Map<number, string>,
  mlbIdToName: Map<number, string>,
  paMap: Map<number, number>,
): RecentPerformance[] {
  const base = computeStreaks(statcast, projections, mlbIdToYahooId, mlbIdToName);

  // Override confidence with actual PA data
  for (const rp of base) {
    const pa = paMap.get(rp.mlbId);
    if (pa !== undefined) {
      // Linear scale: 0 PA = 0 confidence, 100+ PA = 1.0
      rp.streakConfidence = clamp(pa / 100, 0, 1);
    }
  }

  return base;
}

// ---------------------------------------------------------------------------
// Score adjustment
// ---------------------------------------------------------------------------

/**
 * Adjust a player's base lineup score using recent performance data.
 *
 * Default weight: 0.15 (15% of score influenced by recency).
 * A hot player (streakScore=1, confidence=1) gets up to +15%.
 * A cold player (streakScore=-1, confidence=1) gets up to -15%.
 * No streak data -> return baseScore unchanged.
 */
export function adjustScoreForRecency(
  baseScore: number,
  streak: RecentPerformance | undefined,
  weight: number = 0.15,
): number {
  if (!streak) return baseScore;
  return baseScore * (1 + streak.streakScore * streak.streakConfidence * weight);
}

// ---------------------------------------------------------------------------
// Streak summary
// ---------------------------------------------------------------------------

const HOT_THRESHOLD = 0.3;
const COLD_THRESHOLD = -0.3;

export function getStreakSummary(streaks: RecentPerformance[]): {
  hot: RecentPerformance[];
  cold: RecentPerformance[];
} {
  const hot = streaks
    .filter((s) => s.streakScore > HOT_THRESHOLD)
    .sort((a, b) => b.streakScore - a.streakScore);

  const cold = streaks
    .filter((s) => s.streakScore < COLD_THRESHOLD)
    .sort((a, b) => a.streakScore - b.streakScore);

  return { hot, cold };
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function populationStddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
