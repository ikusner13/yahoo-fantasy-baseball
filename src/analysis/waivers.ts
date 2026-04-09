import type { Player, RosterEntry, PlayerValuation, Category } from "../types";
import type { MatchupAnalysis } from "./matchup";

// --- Interfaces ---

export interface PickupRecommendation {
  add: Player;
  drop: Player;
  netValue: number;
  reasoning: string;
  winProbabilityDelta?: number;
  expectedCategoryWinsDelta?: number;
  targetCategories?: Category[];
}

interface DroppableCandidate {
  entry: RosterEntry;
  val: PlayerValuation;
  hasGameToday: boolean;
  depth: number;
}

// --- Constants ---

/** Minimum z-score improvement to recommend a pickup */
const MEANINGFUL_THRESHOLD = 0.5;

/** If FA net improvement exceeds this, allow dropping core players */
const ELITE_UPGRADE_THRESHOLD = 2.0;

/** Positions with only 1 roster slot — losing sole eligibility is catastrophic */
const SCARCE_POSITIONS = ["C", "SS", "2B", "3B"] as const;

// --- Helpers ---

/**
 * Compute matchup-weighted net value between candidate and drop.
 * Swing categories get 2× weight, safe 0.5×, lost 0×.
 */
function computeMatchupWeightedValue(
  candidate: PlayerValuation,
  drop: PlayerValuation,
  matchup: MatchupAnalysis,
): number {
  const swingSet = new Set<string>(matchup.swingCategories);
  const safeSet = new Set<string>(matchup.safeCategories);
  // lost categories get 0× weight (not in swing or safe)

  let total = 0;
  const allCats = new Set([
    ...Object.keys(candidate.categoryZScores),
    ...Object.keys(drop.categoryZScores),
  ]);

  for (const cat of allCats) {
    const candZ = candidate.categoryZScores[cat as Category] ?? 0;
    const dropZ = drop.categoryZScores[cat as Category] ?? 0;
    const diff = candZ - dropZ;

    if (swingSet.has(cat)) {
      total += diff * 2.0;
    } else if (safeSet.has(cat)) {
      total += diff * 0.5;
    }
    // lost categories: 0× weight, skip
  }

  return total;
}

function buildReasoning(
  candidate: PlayerValuation,
  drop: PlayerValuation,
  netValue: number,
  matchup?: MatchupAnalysis,
): string {
  // Find biggest category improvements
  const improvements: Array<{ cat: Category; diff: number }> = [];
  for (const [cat, zScore] of Object.entries(candidate.categoryZScores)) {
    const dropZ = drop.categoryZScores[cat as Category] ?? 0;
    const diff = (zScore ?? 0) - dropZ;
    if (diff > 0.3) {
      improvements.push({ cat: cat as Category, diff });
    }
  }
  improvements.sort((a, b) => b.diff - a.diff);

  const catStr =
    improvements.length > 0
      ? improvements
          .slice(0, 3)
          .map((i) => i.cat)
          .join(", ")
      : "overall depth";

  let base = `Add ${candidate.name} (z=${candidate.totalZScore.toFixed(2)}), drop ${drop.name} (z=${drop.totalZScore.toFixed(2)}). +${netValue.toFixed(2)} net value. Upgrades: ${catStr}.`;

  if (matchup && matchup.swingCategories.length > 0) {
    const swingSet = new Set<string>(matchup.swingCategories);
    const swingHits = improvements.filter((i) => swingSet.has(i.cat)).map((i) => i.cat);
    if (swingHits.length > 0) {
      base += ` Helps swing cats: ${swingHits.join(", ")}.`;
    }
  }

  return base;
}

/**
 * Count how many non-IL roster players are eligible for a given position.
 */
function countPositionEligible(roster: RosterEntry[], position: string): number {
  return roster.filter((e) => e.currentPosition !== "IL" && e.player.positions.includes(position))
    .length;
}

/**
 * Compute the z-score threshold that separates the top 50% (core) from the bottom 50%.
 * Returns the median z-score of non-IL roster players.
 */
function corePlayerThreshold(
  roster: RosterEntry[],
  valuations: Map<string, PlayerValuation>,
): number {
  const scores: number[] = [];
  for (const entry of roster) {
    if (entry.currentPosition === "IL") continue;
    const val = valuations.get(entry.player.yahooId);
    if (val) scores.push(val.totalZScore);
  }
  if (scores.length === 0) return 0;
  scores.sort((a, b) => a - b);
  const mid = Math.floor(scores.length / 2);
  return scores.length % 2 === 0 ? (scores[mid - 1]! + scores[mid]!) / 2 : scores[mid]!;
}

/**
 * Check if dropping this player would leave zero eligible players for a scarce position.
 */
function isSolePositionHolder(entry: RosterEntry, roster: RosterEntry[]): boolean {
  for (const pos of SCARCE_POSITIONS) {
    if (!entry.player.positions.includes(pos)) continue;
    const othersEligible = roster.filter(
      (e) =>
        e.player.yahooId !== entry.player.yahooId &&
        e.currentPosition !== "IL" &&
        e.player.positions.includes(pos),
    ).length;
    if (othersEligible === 0) return true;
  }
  return false;
}

/**
 * Compute a "position depth" score — higher means more depth, more droppable.
 * Sum of eligible-player counts for each position the player can fill.
 */
function positionDepthScore(entry: RosterEntry, roster: RosterEntry[]): number {
  let depth = 0;
  for (const pos of entry.player.positions) {
    depth += countPositionEligible(roster, pos);
  }
  return depth;
}

// --- Core exports ---

/**
 * Find the best droppable player from the roster.
 *
 * A player is NOT droppable if:
 *   - They are on IL
 *   - They are the sole eligible player for a scarce position (C, SS, 2B, 3B)
 *   - They are a "core player" (top 50% by z-score), UNLESS eliteOverride is true
 *
 * Among droppable players, prefer dropping:
 *   1. Players not contributing today (no game)
 *   2. Players at positions with the most depth
 *   3. Lowest z-score as final tiebreaker
 */
export function rankDroppablePlayers(
  roster: RosterEntry[],
  valuations: Map<string, PlayerValuation>,
  positionFilter?: string | string[],
  options?: { eliteOverride?: boolean; teamsPlayingToday?: Set<string> },
): RosterEntry[] {
  const eliteOverride = options?.eliteOverride ?? false;
  const teamsPlaying = options?.teamsPlayingToday;
  const coreThreshold = corePlayerThreshold(roster, valuations);

  const droppable: DroppableCandidate[] = [];

  for (const entry of roster) {
    if (entry.currentPosition === "IL") continue;

    if (positionFilter) {
      const filters = Array.isArray(positionFilter) ? positionFilter : [positionFilter];
      if (!filters.some((f) => entry.player.positions.includes(f))) continue;
    }

    const val = valuations.get(entry.player.yahooId);
    if (!val) continue;

    // Position scarcity protection — never drop sole holder of scarce position
    if (isSolePositionHolder(entry, roster)) continue;

    // Core player protection (skip if elite upgrade overrides)
    if (!eliteOverride && val.totalZScore >= coreThreshold) continue;

    const hasGameToday = teamsPlaying ? teamsPlaying.has(entry.player.team) : true;
    const depth = positionDepthScore(entry, roster);

    droppable.push({ entry, val, hasGameToday, depth });
  }

  if (droppable.length === 0) return [];

  // Sort: prefer no-game-today, then most depth, then lowest z-score
  droppable.sort((a, b) => {
    if (a.hasGameToday !== b.hasGameToday) return a.hasGameToday ? 1 : -1;
    if (a.depth !== b.depth) return b.depth - a.depth;
    return a.val.totalZScore - b.val.totalZScore;
  });

  return droppable.map((candidate) => candidate.entry);
}

export function findDroppablePlayer(
  roster: RosterEntry[],
  valuations: Map<string, PlayerValuation>,
  positionFilter?: string | string[],
  options?: { eliteOverride?: boolean; teamsPlayingToday?: Set<string> },
): RosterEntry | null {
  return rankDroppablePlayers(roster, valuations, positionFilter, options)[0] ?? null;
}

/**
 * Evaluate whether picking up a candidate FA improves the roster.
 * Uses smart drop protection: position scarcity, core player threshold, depth preference.
 * Returns null if no meaningful improvement found.
 * When matchup is provided, scores by swing/safe category contribution instead of overall z-score.
 */
export function evaluatePickup(
  candidate: PlayerValuation,
  roster: RosterEntry[],
  valuations: Map<string, PlayerValuation>,
  matchup?: MatchupAnalysis,
  options?: { teamsPlayingToday?: Set<string> },
): PickupRecommendation | null {
  // First try without elite override (protect core players)
  let dropEntry = findDroppablePlayer(roster, valuations, undefined, {
    eliteOverride: false,
    teamsPlayingToday: options?.teamsPlayingToday,
  });

  let dropVal = dropEntry ? (valuations.get(dropEntry.player.yahooId) ?? null) : null;

  let netValue =
    dropVal && matchup
      ? computeMatchupWeightedValue(candidate, dropVal, matchup)
      : dropVal
        ? candidate.totalZScore - dropVal.totalZScore
        : 0;

  // If no droppable player found or net value insufficient, try with elite override
  const basePassEmpty = !dropEntry || !dropVal;
  if (basePassEmpty || netValue <= MEANINGFUL_THRESHOLD) {
    const eliteEntry = findDroppablePlayer(roster, valuations, undefined, {
      eliteOverride: true,
      teamsPlayingToday: options?.teamsPlayingToday,
    });
    const eliteVal = eliteEntry ? (valuations.get(eliteEntry.player.yahooId) ?? null) : null;
    const eliteNet =
      eliteVal && matchup
        ? computeMatchupWeightedValue(candidate, eliteVal, matchup)
        : eliteVal
          ? candidate.totalZScore - eliteVal.totalZScore
          : 0;

    // When base pass found no one (all core), use normal threshold.
    // When base pass found someone but net too low, require elite threshold to override.
    const requiredThreshold = basePassEmpty ? MEANINGFUL_THRESHOLD : ELITE_UPGRADE_THRESHOLD;

    if (eliteEntry && eliteVal && eliteNet > requiredThreshold) {
      dropEntry = eliteEntry;
      dropVal = eliteVal;
      netValue = eliteNet;
    } else if (basePassEmpty || netValue <= MEANINGFUL_THRESHOLD) {
      return null;
    }
  }

  return {
    add: {
      yahooId: candidate.yahooId,
      name: candidate.name,
      team: "",
      positions: [],
    },
    drop: dropEntry!.player,
    netValue,
    reasoning: buildReasoning(candidate, dropVal!, netValue, matchup),
  };
}

/**
 * Evaluate all free agents against roster, return top N recommendations.
 * When matchup is provided, ranks by swing category contribution instead of overall z-score.
 */
export function findBestPickups(
  freeAgents: PlayerValuation[],
  roster: RosterEntry[],
  valuations: Map<string, PlayerValuation>,
  limit: number = 5,
  matchup?: MatchupAnalysis,
  options?: { teamsPlayingToday?: Set<string> },
): PickupRecommendation[] {
  const recs: PickupRecommendation[] = [];

  for (const fa of freeAgents) {
    const rec = evaluatePickup(fa, roster, valuations, matchup, options);
    if (rec) recs.push(rec);
  }

  recs.sort((a, b) => b.netValue - a.netValue);
  return recs.slice(0, limit);
}

/**
 * Decide whether to spend waiver priority on a pickup.
 *
 * Rolling waiver — using a claim costs you priority position.
 *   - High priority (1-3): netValue > 0.5
 *   - Mid priority (4-8): netValue > 1.5
 *   - Low priority (9-12): netValue > 3.0 (elite only)
 */
export function shouldUseWaiverPriority(
  recommendation: PickupRecommendation,
  priorityPosition: number,
): boolean {
  const { netValue, winProbabilityDelta } = recommendation;
  const winDeltaPct = (winProbabilityDelta ?? 0) * 100;

  if (winProbabilityDelta != null) {
    if (priorityPosition <= 3) return winDeltaPct >= 1.0 || netValue > 0.5;
    if (priorityPosition <= 8) return winDeltaPct >= 2.5 || netValue > 1.5;
    return winDeltaPct >= 5.0 || netValue > 3.0;
  }

  if (priorityPosition <= 3) return netValue > 0.5;
  if (priorityPosition <= 8) return netValue > 1.5;
  return netValue > 3.0;
}
