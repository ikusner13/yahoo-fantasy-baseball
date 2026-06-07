import type {
  PlayerProjection,
  BatterStats,
  PitcherStats,
  PlayerValuation,
  VarianceAdjustedValuation,
  Category,
} from "../types";
import { BATTING_CATEGORIES, PITCHING_CATEGORIES, INVERSE_CATEGORIES } from "../types";

// --- Helpers ---

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function zScore(value: number, m: number, sd: number): number {
  if (sd === 0) return 0;
  return (value - m) / sd;
}

function isInverse(cat: string): boolean {
  return (INVERSE_CATEGORIES as readonly string[]).includes(cat);
}

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

// --- Rate stats for daily projections ---

export function getRateStats(stats: BatterStats): Record<string, number> {
  const pa = stats.pa || 1;
  return {
    R: stats.r / pa,
    H: stats.h / pa,
    HR: stats.hr / pa,
    RBI: stats.rbi / pa,
    SB: stats.sb / pa,
    TB: stats.tb / pa,
    OBP: stats.obp, // already a rate
  };
}

export function getPitcherRateStats(stats: PitcherStats): Record<string, number> {
  const ip = stats.ip || 1;
  return {
    OUT: stats.outs / ip, // always ~3, but consistent interface
    K: stats.k / ip,
    ERA: stats.era, // already a rate
    WHIP: stats.whip, // already a rate
    QS: stats.qs / ip,
    SVHD: stats.svhd / ip,
  };
}

// --- Z-score computation ---

export function computeZScores(projections: PlayerProjection[]): PlayerValuation[] {
  const batters = projections.filter((p) => p.playerType === "batter" && p.batting);
  const pitchers = projections.filter((p) => p.playerType === "pitcher" && p.pitching);

  // Pre-compute pool averages for rate stat time-weighting
  const poolAvgOBP =
    batters.length > 0
      ? batters.reduce((sum, p) => sum + p.batting!.obp, 0) / batters.length
      : 0.31;
  const poolAvgERA =
    pitchers.length > 0
      ? pitchers.reduce((sum, p) => sum + p.pitching!.era, 0) / pitchers.length
      : 4.2;
  const poolAvgWHIP =
    pitchers.length > 0
      ? pitchers.reduce((sum, p) => sum + p.pitching!.whip, 0) / pitchers.length
      : 1.3;

  const batterVals = computeGroupZScores(
    batters,
    BATTING_CATEGORIES as readonly string[],
    (p, cat) => {
      if (cat === "OBP") {
        // Time-weighted: (OBP - pool avg) × PA = "on-base events above average"
        return (p.batting!.obp - poolAvgOBP) * p.batting!.pa;
      }
      return getBatterCatValue(p.batting!, cat);
    },
    // OBP is now a counting equivalent (positive = good), skip inverse flip
    new Set(["OBP"]),
  );

  const pitcherVals = computeGroupZScores(
    pitchers,
    PITCHING_CATEGORIES as readonly string[],
    (p, cat) => {
      if (cat === "ERA") {
        // Time-weighted: "earned runs saved below average" (positive = good)
        return ((poolAvgERA - p.pitching!.era) * p.pitching!.ip) / 9;
      }
      if (cat === "WHIP") {
        // Time-weighted: "baserunners saved below average" (positive = good)
        return (poolAvgWHIP - p.pitching!.whip) * p.pitching!.ip;
      }
      return getPitcherCatValue(p.pitching!, cat);
    },
    // ERA/WHIP are now counting equivalents (positive = good), skip inverse flip
    new Set(["ERA", "WHIP"]),
  );

  return [...batterVals, ...pitcherVals].sort((a, b) => b.totalZScore - a.totalZScore);
}

function computeGroupZScores(
  players: PlayerProjection[],
  categories: readonly string[],
  getValue: (p: PlayerProjection, cat: string) => number,
  skipInverse?: Set<string>,
): PlayerValuation[] {
  // Pre-compute mean/stddev per category
  const stats = new Map<string, { mean: number; sd: number }>();
  for (const cat of categories) {
    const values = players.map((p) => getValue(p, cat));
    stats.set(cat, { mean: mean(values), sd: stddev(values) });
  }

  return players.map((p) => {
    const categoryZScores: Partial<Record<Category, number>> = {};
    let total = 0;

    for (const cat of categories) {
      const { mean: m, sd } = stats.get(cat)!;
      const raw = getValue(p, cat);
      let z = zScore(raw, m, sd);
      // Inverse categories: lower is better, so flip sign
      // Skip for time-weighted rate stats (already converted to "positive = good")
      if (isInverse(cat) && !skipInverse?.has(cat)) z = -z;
      categoryZScores[cat as Category] = z;
      total += z;
    }

    return {
      yahooId: p.yahooId,
      name: p.yahooId, // caller should enrich with real name
      totalZScore: total,
      categoryZScores,
      positionAdjustment: 1.0,
    };
  });
}

// --- Variance adjustment for H2H weekly consistency ---

/** Counting stats where Poisson variance model applies */
const COUNTING_BATTER_CATS = ["R", "H", "HR", "RBI", "SB", "TB"] as const;
const COUNTING_PITCHER_CATS = ["OUT", "K", "QS", "SVHD"] as const;

const DEFAULT_REMAINING_WEEKS = 22;
const CONSISTENCY_WEIGHT = 0.15;

/**
 * Penalize boom-or-bust players and reward consistent weekly contributors.
 * Uses Poisson assumption: weekly variance ≈ weekly expected value for counting stats.
 * CV = 1/sqrt(weeklyExpected), so low-volume players have higher CV (less consistent).
 */
export function applyVarianceAdjustment(
  valuations: PlayerValuation[],
  projections: PlayerProjection[],
  remainingWeeks: number = DEFAULT_REMAINING_WEEKS,
): VarianceAdjustedValuation[] {
  const projMap = new Map(projections.map((p) => [p.yahooId, p]));

  // Compute per-player CV
  const playerCVs: { yahooId: string; cv: number }[] = [];

  for (const v of valuations) {
    const proj = projMap.get(v.yahooId);
    if (!proj) {
      playerCVs.push({ yahooId: v.yahooId, cv: 0 });
      continue;
    }

    const countingCats =
      proj.playerType === "batter" ? COUNTING_BATTER_CATS : COUNTING_PITCHER_CATS;

    const getCatTotal = (cat: string): number => {
      if (proj.playerType === "batter" && proj.batting) {
        return getBatterCatValue(proj.batting, cat);
      }
      if (proj.playerType === "pitcher" && proj.pitching) {
        return getPitcherCatValue(proj.pitching, cat);
      }
      return 0;
    };

    const cvs: number[] = [];
    for (const cat of countingCats) {
      const weeklyExpected = getCatTotal(cat) / remainingWeeks;
      if (weeklyExpected > 0) {
        // Poisson: CV = 1/sqrt(expected)
        cvs.push(1 / Math.sqrt(weeklyExpected));
      }
    }

    const avgCV = cvs.length > 0 ? cvs.reduce((a, b) => a + b, 0) / cvs.length : 0;
    playerCVs.push({ yahooId: v.yahooId, cv: avgCV });
  }

  // Compute median CV across all players
  const sortedCVs = playerCVs
    .map((p) => p.cv)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  const medianCV =
    sortedCVs.length > 0
      ? sortedCVs.length % 2 === 1
        ? sortedCVs[Math.floor(sortedCVs.length / 2)]
        : (sortedCVs[sortedCVs.length / 2 - 1] + sortedCVs[sortedCVs.length / 2]) / 2
      : 0;

  const cvMap = new Map(playerCVs.map((p) => [p.yahooId, p.cv]));

  return valuations
    .map((v): VarianceAdjustedValuation => {
      const cv = cvMap.get(v.yahooId) ?? 0;
      // consistencyFactor > 1 for consistent (low CV), < 1 for volatile (high CV)
      const consistencyFactor = 1.0 + (medianCV - cv) * CONSISTENCY_WEIGHT;
      // Clamp to [0.85, 1.15] to prevent extreme adjustments
      const clamped = Math.max(0.85, Math.min(1.15, consistencyFactor));

      return {
        ...v,
        rawZScore: v.totalZScore,
        totalZScore: v.totalZScore * clamped,
        consistencyFactor: clamped,
        weeklyVariance: cv,
      };
    })
    .sort((a, b) => b.totalZScore - a.totalZScore);
}

// --- Positional scarcity ---

const BATTER_SCARCITY: Record<string, number> = {
  C: 1.3,
  SS: 1.15,
  "2B": 1.1,
  "3B": 1.05,
  "1B": 1.0,
  OF: 0.95,
  Util: 0.9,
};

const PITCHER_SCARCITY: Record<string, number> = {
  SP: 1.0,
  RP: 1.1,
};

export function applyPositionalScarcity(
  valuations: PlayerValuation[],
  projections: PlayerProjection[],
  positionMap: Record<string, string[]>,
): PlayerValuation[] {
  const typeMap = new Map(projections.map((p) => [p.yahooId, p.playerType]));

  return valuations
    .map((v) => {
      const positions = positionMap[v.yahooId] ?? [];
      const playerType = typeMap.get(v.yahooId);
      const scarcityTable = playerType === "pitcher" ? PITCHER_SCARCITY : BATTER_SCARCITY;

      // Use the highest scarcity multiplier among eligible positions
      let maxMultiplier = playerType === "pitcher" ? 1.0 : 0.9; // default to Util/SP
      for (const pos of positions) {
        const mult = scarcityTable[pos];
        if (mult !== undefined && mult > maxMultiplier) {
          maxMultiplier = mult;
        }
      }

      return {
        ...v,
        totalZScore: v.totalZScore * maxMultiplier,
        positionAdjustment: maxMultiplier,
      };
    })
    .sort((a, b) => b.totalZScore - a.totalZScore);
}
