import type { PlayerProjection, BatterStats, PitcherStats, Category } from "../types";
import { BATTING_CATEGORIES, PITCHING_CATEGORIES } from "../types";
import type { MatchupAnalysis } from "./matchup";

// --- Interfaces ---

export interface CategoryVolatility {
  category: Category;
  weeklyStdDev: number; // how much this player's weekly output varies
  floorValue: number; // 10th percentile weekly output
  ceilingValue: number; // 90th percentile weekly output
}

export interface RosterVolatilityProfile {
  overallVariance: "high" | "medium" | "low";
  categoryVolatilities: Partial<
    Record<Category, { teamStdDev: number; teamFloor: number; teamCeiling: number }>
  >;
  highVariancePlayers: string[]; // yahooIds of most volatile players
  steadyPlayers: string[]; // yahooIds of most consistent players
}

export type MatchupApproach = "aggressive" | "balanced" | "conservative";

// --- CV constants ---
// Derived from historical MLB weekly stat distributions.
// Counting stats: stdDev ~ mean * CV.
// The floor/ceiling model assumes roughly normal distribution which isn't perfect
// for HR/SB (Poisson is better) but good enough for roster-level aggregation.

const COUNTING_CV: Record<string, number> = {
  HR: 1.2, // very high variance — projected 0.15 HR/game might hit 0 or 2
  SB: 1.5, // extremely volatile
  R: 0.6,
  H: 0.5,
  RBI: 0.8,
  TB: 0.7,
  // Pitching counting stats — reasonable defaults
  OUT: 0.4,
  K: 0.5,
  QS: 1.3, // binary outcome per start, very volatile week-to-week
  SVHD: 1.4, // opportunity-dependent
};

// Rate stat stdDev constants: stdDev ~ constant / sqrt(volume/week)
const RATE_STDDEV: Record<string, { base: number; volumeKey: "pa" | "ip" }> = {
  OBP: { base: 0.05, volumeKey: "pa" },
  ERA: { base: 2.0, volumeKey: "ip" },
  WHIP: { base: 0.3, volumeKey: "ip" },
};

// Z-score multiplier for 10th/90th percentile (normal approximation)
const PERCENTILE_Z = 1.3;

// --- Helpers ---

function getBatterCatValue(stats: BatterStats, cat: string): number {
  switch (cat) {
    case "R":
      return stats.r;
    case "H":
      return stats.h;
    case "HR":
      return stats.hr;
    case "RBI":
      return stats.rbi;
    case "SB":
      return stats.sb;
    case "TB":
      return stats.tb;
    case "OBP":
      return stats.obp;
    default:
      return 0;
  }
}

function getPitcherCatValue(stats: PitcherStats, cat: string): number {
  switch (cat) {
    case "OUT":
      return stats.outs;
    case "K":
      return stats.k;
    case "ERA":
      return stats.era;
    case "WHIP":
      return stats.whip;
    case "QS":
      return stats.qs;
    case "SVHD":
      return stats.svhd;
    default:
      return 0;
  }
}

function getWeeklyVolume(stats: BatterStats | PitcherStats, key: "pa" | "ip"): number {
  if (key === "pa") return (stats as BatterStats).pa || 1;
  return (stats as PitcherStats).ip || 1;
}

function computeCategoryStdDev(
  cat: string,
  value: number,
  stats: BatterStats | PitcherStats,
): number {
  const rateCfg = RATE_STDDEV[cat];
  if (rateCfg) {
    const volume = getWeeklyVolume(stats, rateCfg.volumeKey);
    return rateCfg.base / Math.sqrt(Math.max(volume, 0.1));
  }
  const cv = COUNTING_CV[cat];
  if (cv !== undefined) {
    return Math.abs(value) * cv;
  }
  return 0;
}

// --- Core exports ---

/**
 * Estimate per-category volatility for a single player's weekly projections.
 * Key insight for H2H: EXPECTED value matters less than PROBABILITY OF WINNING EACH CATEGORY.
 */
export function estimatePlayerVolatility(
  projection: PlayerProjection,
): Partial<Record<Category, CategoryVolatility>> {
  const result: Partial<Record<Category, CategoryVolatility>> = {};

  if (projection.playerType === "batter" && projection.batting) {
    for (const cat of BATTING_CATEGORIES) {
      const value = getBatterCatValue(projection.batting, cat);
      const sd = computeCategoryStdDev(cat, value, projection.batting);
      result[cat] = {
        category: cat,
        weeklyStdDev: sd,
        floorValue: value - PERCENTILE_Z * sd,
        ceilingValue: value + PERCENTILE_Z * sd,
      };
    }
  }

  if (projection.playerType === "pitcher" && projection.pitching) {
    for (const cat of PITCHING_CATEGORIES) {
      const value = getPitcherCatValue(projection.pitching, cat);
      const sd = computeCategoryStdDev(cat, value, projection.pitching);
      result[cat] = {
        category: cat,
        weeklyStdDev: sd,
        floorValue: value - PERCENTILE_Z * sd,
        ceilingValue: value + PERCENTILE_Z * sd,
      };
    }
  }

  return result;
}

/**
 * Aggregate individual player volatilities into a roster-level profile.
 * Classify overall variance: high if >4 categories have top-quartile stdDev.
 */
export function analyzeRosterVolatility(projections: PlayerProjection[]): RosterVolatilityProfile {
  const allCategories = [...BATTING_CATEGORIES, ...PITCHING_CATEGORIES] as Category[];

  // Accumulate per-category team-level stats: sum variances (independent players)
  const catVariance = new Map<Category, number>();
  const catFloor = new Map<Category, number>();
  const catCeiling = new Map<Category, number>();
  for (const cat of allCategories) {
    catVariance.set(cat, 0);
    catFloor.set(cat, 0);
    catCeiling.set(cat, 0);
  }

  // Track per-player total variance for identifying high/low variance players
  const playerVariance: { yahooId: string; totalVar: number }[] = [];

  for (const proj of projections) {
    const vols = estimatePlayerVolatility(proj);
    let totalVar = 0;

    for (const cat of allCategories) {
      const v = vols[cat];
      if (!v) continue;
      const variance = v.weeklyStdDev ** 2;
      totalVar += variance;
      catVariance.set(cat, (catVariance.get(cat) ?? 0) + variance);
      catFloor.set(cat, (catFloor.get(cat) ?? 0) + v.floorValue);
      catCeiling.set(cat, (catCeiling.get(cat) ?? 0) + v.ceilingValue);
    }

    playerVariance.push({ yahooId: proj.yahooId, totalVar });
  }

  // Build category volatilities
  const categoryVolatilities: RosterVolatilityProfile["categoryVolatilities"] = {};
  const stdDevs: number[] = [];
  for (const cat of allCategories) {
    const teamStdDev = Math.sqrt(catVariance.get(cat) ?? 0);
    stdDevs.push(teamStdDev);
    categoryVolatilities[cat] = {
      teamStdDev,
      teamFloor: catFloor.get(cat) ?? 0,
      teamCeiling: catCeiling.get(cat) ?? 0,
    };
  }

  // Classify overall: high if >4 categories have top-quartile stdDev
  const sorted = [...stdDevs].sort((a, b) => b - a);
  const topQuartileThreshold = sorted[Math.floor(sorted.length * 0.25)] ?? 0;
  const highVolCats = stdDevs.filter((sd) => sd >= topQuartileThreshold).length;

  const overallVariance: RosterVolatilityProfile["overallVariance"] =
    highVolCats > 4 ? "high" : highVolCats >= 2 ? "medium" : "low";

  // Sort players by variance to identify extremes
  const sortedPlayers = [...playerVariance].sort((a, b) => b.totalVar - a.totalVar);
  const topCount = Math.max(1, Math.ceil(sortedPlayers.length * 0.2));
  const highVariancePlayers = sortedPlayers.slice(0, topCount).map((p) => p.yahooId);
  const steadyPlayers = sortedPlayers.slice(-topCount).map((p) => p.yahooId);

  return {
    overallVariance,
    categoryVolatilities,
    highVariancePlayers,
    steadyPlayers,
  };
}

/**
 * Recommend matchup approach based on projected outcome.
 * In H2H categories, a 6-4 and 10-0 week count the same (1 win).
 * Against strong opponents: go high-variance to steal surprise categories.
 * Against weak opponents: go low-variance to lock in the safe win.
 */
export function recommendApproach(
  _myProfile: RosterVolatilityProfile,
  matchupAnalysis: MatchupAnalysis,
): MatchupApproach {
  if (matchupAnalysis.projectedWins >= 8) return "conservative";
  if (matchupAnalysis.projectedWins <= 5) return "aggressive";
  return "balanced";
}

/**
 * Adjust category weights based on matchup approach.
 * These weights feed into the lineup optimizer's category weighting system.
 *
 * - "aggressive": boost volatile categories (HR, SB), reduce safe ones (H)
 * - "conservative": boost consistent categories (H, OBP), reduce volatile (HR, SB)
 * - "balanced": return baseWeights unchanged
 */
export function getVolatilityAdjustedWeights(
  approach: MatchupApproach,
  baseWeights: Record<string, number>,
): Record<string, number> {
  if (approach === "balanced") return { ...baseWeights };

  const adjusted = { ...baseWeights };

  if (approach === "aggressive") {
    // Boost volatile categories to maximize upset potential
    if (adjusted.HR !== undefined) adjusted.HR *= 1.3;
    if (adjusted.SB !== undefined) adjusted.SB *= 1.3;
    if (adjusted.H !== undefined) adjusted.H *= 0.8;
  } else {
    // Conservative: boost consistent categories, reduce volatile
    if (adjusted.H !== undefined) adjusted.H *= 1.2;
    if (adjusted.OBP !== undefined) adjusted.OBP *= 1.2;
    if (adjusted.HR !== undefined) adjusted.HR *= 0.8;
    if (adjusted.SB !== undefined) adjusted.SB *= 0.8;
  }

  return adjusted;
}
