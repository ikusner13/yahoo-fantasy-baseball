import type {
  PlayerProjection,
  BatterStats,
  PitcherStats,
  PlayerValuation,
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

  const batterVals = computeGroupZScores(
    batters,
    BATTING_CATEGORIES as readonly string[],
    (p, cat) => getBatterCatValue(p.batting!, cat),
  );

  const pitcherVals = computeGroupZScores(
    pitchers,
    PITCHING_CATEGORIES as readonly string[],
    (p, cat) => getPitcherCatValue(p.pitching!, cat),
  );

  return [...batterVals, ...pitcherVals].sort((a, b) => b.totalZScore - a.totalZScore);
}

function computeGroupZScores(
  players: PlayerProjection[],
  categories: readonly string[],
  getValue: (p: PlayerProjection, cat: string) => number,
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
      if (isInverse(cat)) z = -z;
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
