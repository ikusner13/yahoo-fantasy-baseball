import type { Matchup, CategoryScore, Category } from "../types";
import { INVERSE_CATEGORIES } from "../types";

// --- Interfaces ---

export interface MatchupAnalysis {
  projectedWins: number;
  projectedLosses: number;
  swingCategories: Category[];
  safeCategories: Category[];
  lostCategories: Category[];
  strategy: StrategyRecommendation;
}

export interface StrategyRecommendation {
  protectRatios: boolean;
  chaseStrikeouts: boolean;
  prioritizePower: boolean;
  prioritizeSpeed: boolean;
  streamPitchers: boolean;
  benchMessage: string;
}

// --- Helpers ---

const INVERSE_SET = new Set<string>(INVERSE_CATEGORIES);

// OBP is also a rate stat (higher is better, but needs tighter thresholds)
const RATE_STATS = new Set<string>([...INVERSE_CATEGORIES, "OBP"]);

function isRateStat(cat: Category): boolean {
  return RATE_STATS.has(cat);
}

// --- Core exports ---

/**
 * Classify a single category score as winning, losing, or swing.
 * Counting stats: >15% margin = decisive. Rate stats (lower=better): 5% margin.
 */
export function classifyCategory(score: CategoryScore): "winning" | "losing" | "swing" {
  const { category, myValue, opponentValue } = score;

  if (isRateStat(category)) {
    const isInverse = INVERSE_SET.has(category); // ERA, WHIP: lower is better
    if (myValue === 0 && opponentValue === 0) return "swing";

    if (isInverse) {
      // Lower is better
      if (opponentValue === 0) return "losing";
      if (myValue === 0) return "winning";
      const pctDiff = (opponentValue - myValue) / opponentValue;
      if (pctDiff > 0.05) return "winning";
      if (pctDiff < -0.05) return "losing";
    } else {
      // OBP: higher is better, use 5% threshold
      if (myValue === 0) return "losing";
      if (opponentValue === 0) return "winning";
      const pctDiff = (myValue - opponentValue) / Math.max(myValue, opponentValue);
      if (pctDiff > 0.05) return "winning";
      if (pctDiff < -0.05) return "losing";
    }
    return "swing";
  }

  // Counting stats — higher is better
  if (myValue === 0 && opponentValue === 0) return "swing";
  const denom = Math.max(myValue, opponentValue, 1);
  const pctDiff = (myValue - opponentValue) / denom;
  if (pctDiff > 0.15) return "winning";
  if (pctDiff < -0.15) return "losing";
  return "swing";
}

/**
 * True if we're winning ERA AND WHIP and they're safe or swing categories.
 */
export function shouldProtectRatios(matchup: Matchup): boolean {
  const eraScore = matchup.categories.find((c) => c.category === "ERA");
  const whipScore = matchup.categories.find((c) => c.category === "WHIP");

  if (!eraScore || !whipScore) return false;

  const eraClass = classifyCategory(eraScore);
  const whipClass = classifyCategory(whipScore);

  // Protect if winning both, or winning one and the other is a swing
  const eraOk = eraClass === "winning" || eraClass === "swing";
  const whipOk = whipClass === "winning" || whipClass === "swing";

  // Must be winning at least one to bother protecting
  const winningAtLeastOne = eraClass === "winning" || whipClass === "winning";

  return eraOk && whipOk && winningAtLeastOne;
}

/**
 * Full matchup analysis with strategy recommendation.
 */
export function analyzeMatchup(matchup: Matchup): MatchupAnalysis {
  const safe: Category[] = [];
  const swing: Category[] = [];
  const lost: Category[] = [];

  for (const score of matchup.categories) {
    const classification = classifyCategory(score);
    switch (classification) {
      case "winning":
        safe.push(score.category);
        break;
      case "swing":
        swing.push(score.category);
        break;
      case "losing":
        lost.push(score.category);
        break;
    }
  }

  const protectRatios = shouldProtectRatios(matchup);

  const swingSet = new Set<string>(swing);
  const chaseStrikeouts = swingSet.has("K");
  const prioritizePower = swingSet.has("HR") || swingSet.has("TB") || swingSet.has("RBI");
  const prioritizeSpeed = swingSet.has("SB");

  // Stream pitchers if we need counting pitching stats
  const pitchingCountingSwing = swingSet.has("OUT") || swingSet.has("K") || swingSet.has("QS");
  const pitchingCountingLost =
    new Set<string>(lost).has("OUT") ||
    new Set<string>(lost).has("K") ||
    new Set<string>(lost).has("QS");
  const streamPitchers = !protectRatios && (pitchingCountingSwing || pitchingCountingLost);

  // Build human-readable message
  const parts: string[] = [];
  if (protectRatios) parts.push("Protect ERA/WHIP lead — bench risky SPs (ERA > 4.0).");
  if (chaseStrikeouts) parts.push("K is a swing cat — prioritize high-K arms.");
  if (prioritizePower) parts.push("Power cats are close — start sluggers.");
  if (prioritizeSpeed) parts.push("SB is close — start speed guys.");
  if (streamPitchers) parts.push("Stream pitchers to chase counting stats.");
  if (parts.length === 0) parts.push("Hold steady — no major strategic shifts needed.");

  return {
    projectedWins: safe.length,
    projectedLosses: lost.length,
    swingCategories: swing,
    safeCategories: safe,
    lostCategories: lost,
    strategy: {
      protectRatios,
      chaseStrikeouts,
      prioritizePower,
      prioritizeSpeed,
      streamPitchers,
      benchMessage: parts.join(" "),
    },
  };
}
