import type { Matchup, CategoryScore, Category } from "../types";
import { INVERSE_CATEGORIES } from "../types";
import { loadTuning } from "../config/tuning";
import { loadLeagueSettings } from "../config/league";

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

// --- Time-aware detailed analysis ---

export type CategoryState = "clinched" | "safe" | "swing" | "losing" | "lost";

export interface DetailedCategoryState {
  category: Category;
  state: CategoryState;
  myValue: number;
  opponentValue: number;
  margin: number; // positive = winning
  /** For counting stats: estimated daily production needed to flip */
  dailyFlipRate?: number;
}

export interface StreamingDecision {
  canStream: boolean;
  qualityFloor: "any" | "high-floor" | "elite-only" | "none";
  reasoning: string;
}

export interface DetailedMatchupAnalysis extends MatchupAnalysis {
  detailedCategories: DetailedCategoryState[];
  worthlessCategories: Category[];
  streamingDecision: StreamingDecision;
  daysRemaining: number;
}

// Average daily production per counting category (league-typical full roster)
const DAILY_PRODUCTION: Partial<Record<Category, number>> = {
  R: 1.5,
  H: 2.5,
  HR: 0.4,
  RBI: 1.2,
  SB: 0.3,
  TB: 4,
  K: 2,
  OUT: 5,
  QS: 0.3,
  SVHD: 0.3,
};

// Clinch/lost multiplier: lead/deficit > N× daily production × days remaining (tunable)
function getClinchMultiplier(): number {
  return loadTuning().matchup.clinchMultiplier;
}

/**
 * Time-aware category classification that accounts for days remaining.
 * Counting stats: compares margin against recoverable production.
 * Rate stats: uses absolute margin thresholds that tighten as the week ends.
 */
export function classifyCategoryDetailed(
  score: CategoryScore,
  daysRemaining: number,
): DetailedCategoryState {
  const { category, myValue, opponentValue } = score;
  const isInverse = INVERSE_SET.has(category);

  // margin > 0 means "winning" for all stats including inverse
  const rawDiff = isInverse
    ? opponentValue - myValue // lower is better → winning when opp > me
    : myValue - opponentValue;

  const base: Omit<DetailedCategoryState, "state" | "dailyFlipRate"> = {
    category,
    myValue,
    opponentValue,
    margin: rawDiff,
  };

  // Rate stats: ERA, WHIP, OBP
  if (isRateStat(category)) {
    const absDiff = Math.abs(rawDiff);

    // Thresholds widen early, tighten late
    let clinchThreshold: number;
    let safeThreshold: number;

    if (category === "ERA") {
      const t = loadTuning().matchup.rateStatClinchERA;
      clinchThreshold = daysRemaining <= 2 ? t.endOfWeek : t.startOfWeek;
      safeThreshold = clinchThreshold / 2;
    } else if (category === "WHIP") {
      const t = loadTuning().matchup.rateStatClinchWHIP;
      clinchThreshold = daysRemaining <= 2 ? t.endOfWeek : t.startOfWeek;
      safeThreshold = clinchThreshold / 2;
    } else {
      // OBP (higher = better, not inverse)
      clinchThreshold = daysRemaining <= 2 ? 0.015 : 0.03;
      safeThreshold = daysRemaining <= 2 ? 0.008 : 0.015;
    }

    let state: CategoryState;
    if (rawDiff > 0 && absDiff >= clinchThreshold) state = "clinched";
    else if (rawDiff > 0 && absDiff >= safeThreshold) state = "safe";
    else if (rawDiff < 0 && absDiff >= clinchThreshold) state = "lost";
    else if (rawDiff < 0 && absDiff >= safeThreshold) state = "losing";
    else state = "swing";

    return { ...base, state };
  }

  // Counting stats
  const dailyProd = DAILY_PRODUCTION[category] ?? 1;
  const recoverable = dailyProd * daysRemaining;
  const clinchBand = getClinchMultiplier() * recoverable;

  let state: CategoryState;
  let dailyFlipRate: number | undefined;

  if (rawDiff > 0 && rawDiff >= clinchBand) {
    state = "clinched";
  } else if (rawDiff > 0) {
    state = "safe";
  } else if (rawDiff < 0 && Math.abs(rawDiff) >= clinchBand) {
    state = "lost";
  } else if (rawDiff < 0) {
    // How much daily production needed to close the gap?
    dailyFlipRate = daysRemaining > 0 ? Math.abs(rawDiff) / daysRemaining : Infinity;
    // Tighter threshold on final day - 1.25x is "losing", otherwise 2x
    const losingMultiplier = daysRemaining <= 1 ? 1.25 : 2;
    state = dailyFlipRate > dailyProd * losingMultiplier ? "losing" : "swing";
  } else {
    state = "swing";
  }

  return { ...base, state, dailyFlipRate };
}

/**
 * Returns categories where additional production has zero marginal matchup value
 * (clinched or lost — the outcome won't change).
 */
export function getWorthlessCategories(categories: DetailedCategoryState[]): Category[] {
  return categories
    .filter((c) => c.state === "clinched" || c.state === "lost")
    .map((c) => c.category);
}

/**
 * Determines streaming aggressiveness based on pitching category states and IP status.
 */
export function computeStreamingDecision(
  categories: DetailedCategoryState[],
  currentIP: number,
  minimumIP: number = loadLeagueSettings().pitching.minimumInningsPerWeek,
): StreamingDecision {
  // Must start pitchers to hit IP minimum regardless
  if (currentIP < minimumIP) {
    return {
      canStream: true,
      qualityFloor: "any",
      reasoning: `Only ${currentIP.toFixed(1)} IP — need ${minimumIP} minimum. Must start pitchers.`,
    };
  }

  const byCategory = new Map(categories.map((c) => [c.category, c]));
  const era = byCategory.get("ERA");
  const whip = byCategory.get("WHIP");
  const k = byCategory.get("K");
  const qs = byCategory.get("QS");
  const out = byCategory.get("OUT");

  const eraState = era?.state ?? "swing";
  const whipState = whip?.state ?? "swing";

  // If pitching counting stats are all lost, streaming has no upside
  const countingAllLost = k?.state === "lost" && qs?.state === "lost" && out?.state === "lost";
  if (countingAllLost) {
    return {
      canStream: false,
      qualityFloor: "none",
      reasoning: "K/QS/OUT all lost — streaming has no upside.",
    };
  }

  const bothClinched = eraState === "clinched" && whipState === "clinched";
  const bothLost =
    (eraState === "lost" || eraState === "losing") &&
    (whipState === "lost" || whipState === "losing");
  const bothSafe =
    (eraState === "clinched" || eraState === "safe") &&
    (whipState === "clinched" || whipState === "safe");
  const eitherSwing = eraState === "swing" || whipState === "swing";

  if (bothClinched) {
    return {
      canStream: true,
      qualityFloor: "any",
      reasoning: "ERA & WHIP clinched — stream freely.",
    };
  }

  if (bothLost) {
    return {
      canStream: true,
      qualityFloor: "any",
      reasoning: "ERA & WHIP already lost — nothing to protect, stream freely.",
    };
  }

  if (bothSafe && !eitherSwing) {
    return {
      canStream: true,
      qualityFloor: "high-floor",
      reasoning: "ERA & WHIP safe — stream high-floor arms only (ERA < 4.0).",
    };
  }

  if (eitherSwing) {
    return {
      canStream: true,
      qualityFloor: "elite-only",
      reasoning: "ERA or WHIP is swing — only stream elite arms (ERA < 3.5).",
    };
  }

  // One is safe/clinched and the other is losing — protect the lead
  return {
    canStream: true,
    qualityFloor: "elite-only",
    reasoning: "Protecting one ratio lead — elite arms only.",
  };
}

/**
 * Full matchup analysis with time-aware detailed category states,
 * worthless categories, and streaming decision.
 */
export function analyzeMatchupDetailed(
  matchup: Matchup,
  daysRemaining: number,
  currentIP: number = 0,
  minimumIP: number = loadLeagueSettings().pitching.minimumInningsPerWeek,
): DetailedMatchupAnalysis {
  // Compute base analysis for strategy recommendations
  const base = analyzeMatchup(matchup);

  // Compute detailed time-aware states
  const detailedCategories = matchup.categories.map((score) =>
    classifyCategoryDetailed(score, daysRemaining),
  );

  // Recalculate projected wins/losses from time-aware states
  // "clinched" and "safe" count as wins; "lost" and "losing" count as losses
  const safeCategories: Category[] = [];
  const swingCategories: Category[] = [];
  const lostCategories: Category[] = [];

  for (const dc of detailedCategories) {
    switch (dc.state) {
      case "clinched":
      case "safe":
        safeCategories.push(dc.category);
        break;
      case "swing":
        swingCategories.push(dc.category);
        break;
      case "losing":
      case "lost":
        lostCategories.push(dc.category);
        break;
    }
  }

  const worthlessCategories = getWorthlessCategories(detailedCategories);
  const streamingDecision = computeStreamingDecision(detailedCategories, currentIP, minimumIP);

  return {
    ...base,
    // Override with time-aware classifications
    projectedWins: safeCategories.length,
    projectedLosses: lostCategories.length,
    safeCategories,
    swingCategories,
    lostCategories,
    detailedCategories,
    worthlessCategories,
    streamingDecision,
    daysRemaining,
  };
}
