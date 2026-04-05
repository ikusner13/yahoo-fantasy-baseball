import type { Player, PlayerValuation, Category } from "../types";
import { BATTING_CATEGORIES, PITCHING_CATEGORIES } from "../types";

// --- Interfaces ---

export interface OpponentAnalysis {
  teamName: string;
  weakCategories: Category[];
  strongCategories: Category[];
  targetableCategories: Category[];
  untargetable: Category[];
  recommendation: string;
}

// --- Constants ---

/** If opponent leads by more than this in aggregate z-score, don't bother competing */
const UNTARGETABLE_THRESHOLD = 3.0;

/** Toss-up threshold for weekly projection */
const TOSSUP_THRESHOLD = 1.0;

/** Weight multipliers for lineup optimizer */
const TARGETABLE_WEIGHT = 1.3;
const UNTARGETABLE_WEIGHT = 0.5;
const DEFAULT_WEIGHT = 1.0;

// --- Helpers ---

const ALL_CATEGORIES: Category[] = [...BATTING_CATEGORIES, ...PITCHING_CATEGORIES];

/**
 * Sum z-scores for a given category across a roster's valuations.
 */
function aggregateZScore(valuations: PlayerValuation[], category: Category): number {
  let total = 0;
  for (const v of valuations) {
    total += v.categoryZScores[category] ?? 0;
  }
  return total;
}

/**
 * Build a sorted array of { category, zTotal } for a roster, sorted ascending by z-score.
 */
function rankCategories(
  valuations: PlayerValuation[],
): Array<{ category: Category; zTotal: number }> {
  return ALL_CATEGORIES.map((cat) => ({
    category: cat,
    zTotal: aggregateZScore(valuations, cat),
  })).sort((a, b) => a.zTotal - b.zTotal);
}

// --- Core functions ---

/**
 * Scout the opponent's roster: identify weak/strong categories and where we can compete.
 */
export function scoutOpponent(
  myValuations: PlayerValuation[],
  opponentValuations: PlayerValuation[],
  _myRoster: Player[],
  _opponentRoster: Player[],
): OpponentAnalysis {
  const oppRanked = rankCategories(opponentValuations);
  const weakCategories = oppRanked.slice(0, 3).map((e) => e.category);
  const strongCategories = oppRanked
    .slice(-3)
    .reverse()
    .map((e) => e.category);

  const targetableCategories: Category[] = [];
  const untargetable: Category[] = [];

  for (const cat of ALL_CATEGORIES) {
    const myTotal = aggregateZScore(myValuations, cat);
    const oppTotal = aggregateZScore(opponentValuations, cat);
    const diff = oppTotal - myTotal;

    if (diff > UNTARGETABLE_THRESHOLD) {
      untargetable.push(cat);
    } else if (myTotal >= oppTotal || diff <= TOSSUP_THRESHOLD) {
      targetableCategories.push(cat);
    }
  }

  // Build recommendation string
  const targetStr = targetableCategories.slice(0, 3).join(" and ");
  const weakStr = weakCategories.slice(0, 2).join(" and ");
  const untargetStr = untargetable.slice(0, 2).join(" and ");

  const parts: string[] = [];
  if (targetStr) parts.push(`Target ${targetStr} (opponent weak in ${weakStr})`);
  if (strongCategories.length > 0) parts.push(`protect ${strongCategories[0]} lead`);
  if (untargetStr) parts.push(`punt ${untargetStr} (they dominate)`);

  const recommendation = parts.join(", ");

  return {
    teamName: "",
    weakCategories,
    strongCategories,
    targetableCategories,
    untargetable,
    recommendation,
  };
}

/**
 * Project each category outcome: who wins based on aggregate z-scores.
 */
export function getWeeklyMatchupProjection(
  myValuations: PlayerValuation[],
  opponentValuations: PlayerValuation[],
): Array<{
  category: Category;
  myProjected: number;
  opponentProjected: number;
  winner: "me" | "opponent" | "toss-up";
}> {
  return ALL_CATEGORIES.map((cat) => {
    const myProjected = aggregateZScore(myValuations, cat);
    const opponentProjected = aggregateZScore(opponentValuations, cat);
    const diff = myProjected - opponentProjected;

    let winner: "me" | "opponent" | "toss-up";
    if (Math.abs(diff) <= TOSSUP_THRESHOLD) {
      winner = "toss-up";
    } else if (diff > 0) {
      winner = "me";
    } else {
      winner = "opponent";
    }

    return { category: cat, myProjected, opponentProjected, winner };
  });
}

/**
 * Return weight multipliers for the lineup optimizer based on opponent analysis.
 * Targetable: 1.3x, Untargetable: 0.5x, Others: 1.0x.
 */
export function recommendCategoryTilt(analysis: OpponentAnalysis): Record<Category, number> {
  const weights = {} as Record<Category, number>;

  for (const cat of ALL_CATEGORIES) {
    if (analysis.untargetable.includes(cat)) {
      weights[cat] = UNTARGETABLE_WEIGHT;
    } else if (analysis.targetableCategories.includes(cat)) {
      weights[cat] = TARGETABLE_WEIGHT;
    } else {
      weights[cat] = DEFAULT_WEIGHT;
    }
  }

  return weights;
}
