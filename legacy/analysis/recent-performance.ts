import type { StatcastBatter, PlayerProjection } from "../types";

// ---------------------------------------------------------------------------
// Research notes (updated 2026-04)
// ---------------------------------------------------------------------------
// - Barrel% and hard hit% stabilize in ~50 BIP (~18 games) — far faster
//   than xwOBA (~300 PA). These reflect PROCESS changes (swing decisions,
//   bat speed, pitch selection) not spray-chart luck.
// - Exit velocity on FB/LD explains r²=0.62 of HR/FB variance — stickiest
//   individual Statcast metric.
// - K% is the fastest-stabilizing outcome stat (~60 PA).
// - xwOBA was designed as descriptive, not predictive. Needs hundreds of PA.
// - Optimal recency weight is 10-20% for process metrics (15% default correct).
// - Primary value of recency monitoring = structural change detection:
//   velocity drops, barrel% shifts, mechanical adjustments.
// ---------------------------------------------------------------------------

// --- League-average baselines (2025 season) ---
const LEAGUE_AVG_BARREL_PCT = 7.5;
const LEAGUE_AVG_HARD_HIT_PCT = 37.0;
const LEAGUE_AVG_EXIT_VELO = 88.5;
const LEAGUE_AVG_K_PCT = 22.7;

// --- Composite signal weights ---
const W_BARREL = 0.35;
const W_HARD_HIT = 0.25;
const W_EXIT_VELO = 0.2;
const W_K_PCT = 0.2;

// --- Structural change threshold (in SDs) ---
const STRUCTURAL_CHANGE_SD = 1.5;

export type StructuralChange = "power-surge" | "power-drop" | "k-rate-spike" | "k-rate-drop";

export interface RecentPerformance {
  mlbId: number;
  name: string;
  // Statcast process metrics (primary signal)
  recentBarrelPct: number;
  recentHardHitPct: number;
  recentExitVelo: number;
  recentXwoba: number; // kept for reference/display, de-emphasized in scoring
  // Projected baseline
  projectedObp: number;
  // Composite streak score (-1 to 1)
  streakScore: number;
  streakConfidence: number; // 0 to 1
  // Structural change detection
  structuralChange?: StructuralChange | null;
}

// ---------------------------------------------------------------------------
// Streak computation
// ---------------------------------------------------------------------------

/**
 * Match Statcast batters to FanGraphs projections and compute hot/cold streaks.
 *
 * Uses a composite signal weighted toward fast-stabilizing process metrics
 * (barrel%, hard hit%, exit velo) rather than relying solely on xwOBA.
 *
 * Matching strategy: StatcastBatter has mlbId, PlayerProjection has yahooId.
 * The caller must supply a lookup map (mlbId -> yahooId) for cross-referencing.
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

  // Compute population SDs from the leaderboard for z-score normalization
  const barrelValues = statcast.map((s) => s.barrelPct).filter((v) => v > 0);
  const hardHitValues = statcast.map((s) => s.hardHitPct).filter((v) => v > 0);
  const exitVeloValues = statcast.map((s) => s.exitVelo).filter((v) => v > 0);
  const kPctValues = statcast.map((s) => s.kPct).filter((v): v is number => v != null && v > 0);

  const sdBarrel = populationStddev(barrelValues);
  const sdHardHit = populationStddev(hardHitValues);
  const sdExitVelo = populationStddev(exitVeloValues);
  const sdKPct = populationStddev(kPctValues);

  const results: RecentPerformance[] = [];

  for (const sc of statcast) {
    // Try to find matching projection
    const yahooId = mlbIdToYahooId?.get(sc.mlbId);
    const proj = yahooId ? projByYahoo.get(yahooId) : undefined;
    if (!proj?.batting) continue;

    const projectedObp = proj.batting.obp;

    // --- Composite streak score ---
    // For each metric: z-score = (recent - baseline) / SD, clamped to [-1, 1]
    // Barrel%, hardHit%, exitVelo: positive delta = hot (higher is better)
    // K%: INVERTED — positive delta = cold (higher K% is worse)

    const barrelZ =
      sdBarrel > 0 ? clamp((sc.barrelPct - LEAGUE_AVG_BARREL_PCT) / sdBarrel, -1, 1) : 0;
    const hardHitZ =
      sdHardHit > 0 ? clamp((sc.hardHitPct - LEAGUE_AVG_HARD_HIT_PCT) / sdHardHit, -1, 1) : 0;
    const exitVeloZ =
      sdExitVelo > 0 ? clamp((sc.exitVelo - LEAGUE_AVG_EXIT_VELO) / sdExitVelo, -1, 1) : 0;

    // K%: use population avg as baseline when player kPct available, else 0 weight
    let kPctZ = 0;
    let effectiveKWeight = 0;
    if (sc.kPct != null && sdKPct > 0) {
      // Invert: lower K% = better = positive contribution
      kPctZ = clamp((LEAGUE_AVG_K_PCT - sc.kPct) / sdKPct, -1, 1);
      effectiveKWeight = W_K_PCT;
    }

    // Renormalize weights if kPct unavailable
    const totalWeight = W_BARREL + W_HARD_HIT + W_EXIT_VELO + effectiveKWeight;
    const streakScore =
      totalWeight > 0
        ? clamp(
            (barrelZ * W_BARREL +
              hardHitZ * W_HARD_HIT +
              exitVeloZ * W_EXIT_VELO +
              kPctZ * effectiveKWeight) /
              totalWeight,
            -1,
            1,
          )
        : 0;

    // Confidence: Savant leaderboard min is 25 PA. Scale linearly to 1.0 at 100 PA.
    // Since the leaderboard doesn't expose PA directly, use exitVelo as proxy for
    // qualifying ABs. Default to 0.5 for leaderboard-sourced data (min=25 PA filter).
    const streakConfidence = sc.exitVelo > 0 ? 0.5 : 0.25;

    // --- Structural change detection ---
    const structuralChange = detectStructuralChange(sc, sdBarrel, sdExitVelo, sdKPct);

    const name = mlbIdToName?.get(sc.mlbId) ?? `MLB#${sc.mlbId}`;

    results.push({
      mlbId: sc.mlbId,
      name,
      recentBarrelPct: sc.barrelPct,
      recentHardHitPct: sc.hardHitPct,
      recentExitVelo: sc.exitVelo,
      recentXwoba: sc.xwoba,
      projectedObp,
      streakScore,
      streakConfidence,
      structuralChange,
    });
  }

  return results;
}

/**
 * Detect structural changes — the #1 value of recency monitoring.
 * Flags when barrel%, exit velo, or K% has shifted >1.5 SD from league avg.
 */
function detectStructuralChange(
  sc: StatcastBatter,
  sdBarrel: number,
  sdExitVelo: number,
  sdKPct: number,
): StructuralChange | null {
  // Check barrel% first (fastest-stabilizing, most actionable)
  if (sdBarrel > 0) {
    const barrelDeviation = (sc.barrelPct - LEAGUE_AVG_BARREL_PCT) / sdBarrel;
    if (barrelDeviation >= STRUCTURAL_CHANGE_SD) return "power-surge";
    if (barrelDeviation <= -STRUCTURAL_CHANGE_SD) return "power-drop";
  }

  // Check exit velo (stickiest metric)
  if (sdExitVelo > 0) {
    const veloDeviation = (sc.exitVelo - LEAGUE_AVG_EXIT_VELO) / sdExitVelo;
    if (veloDeviation >= STRUCTURAL_CHANGE_SD) return "power-surge";
    if (veloDeviation <= -STRUCTURAL_CHANGE_SD) return "power-drop";
  }

  // Check K% (inverted: high K% = bad)
  if (sc.kPct != null && sdKPct > 0) {
    const kDeviation = (sc.kPct - LEAGUE_AVG_K_PCT) / sdKPct;
    if (kDeviation >= STRUCTURAL_CHANGE_SD) return "k-rate-spike";
    if (kDeviation <= -STRUCTURAL_CHANGE_SD) return "k-rate-drop";
  }

  return null;
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
