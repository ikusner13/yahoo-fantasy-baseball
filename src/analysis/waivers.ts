import type { Player, RosterEntry, PlayerValuation, Category } from "../types";

// --- Interfaces ---

export interface PickupRecommendation {
  add: Player;
  drop: Player;
  netValue: number;
  reasoning: string;
}

// --- Constants ---

/** Minimum z-score improvement to recommend a pickup */
const MEANINGFUL_THRESHOLD = 0.5;

// --- Helpers ---

function buildReasoning(
  candidate: PlayerValuation,
  drop: PlayerValuation,
  netValue: number,
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

  return `Add ${candidate.name} (z=${candidate.totalZScore.toFixed(2)}), drop ${drop.name} (z=${drop.totalZScore.toFixed(2)}). +${netValue.toFixed(2)} net value. Upgrades: ${catStr}.`;
}

// --- Core exports ---

/**
 * Evaluate whether picking up a candidate FA improves the roster.
 * Returns null if no meaningful improvement found.
 */
export function evaluatePickup(
  candidate: PlayerValuation,
  roster: RosterEntry[],
  valuations: Map<string, PlayerValuation>,
): PickupRecommendation | null {
  // Need to know the candidate's positions — look up from roster context
  // The candidate's Player object isn't directly available via PlayerValuation,
  // so we need the candidate to have positions. We'll look them up from the
  // roster entries or assume the caller provides a player with positions.
  // For now, use a broad search — find the lowest valued roster player overall.
  // (The candidate's eligible positions come from the Player object we'll construct.)

  // Find worst player on roster overall (position-agnostic fallback)
  let worstEntry: RosterEntry | null = null;
  let worstVal: PlayerValuation | null = null;

  for (const entry of roster) {
    if (entry.currentPosition === "IL") continue;
    const val = valuations.get(entry.player.yahooId);
    if (!val) continue;
    if (!worstVal || val.totalZScore < worstVal.totalZScore) {
      worstEntry = entry;
      worstVal = val;
    }
  }

  if (!worstEntry || !worstVal) return null;

  const netValue = candidate.totalZScore - worstVal.totalZScore;
  if (netValue <= MEANINGFUL_THRESHOLD) return null;

  return {
    add: {
      yahooId: candidate.yahooId,
      name: candidate.name,
      team: "",
      positions: [],
    },
    drop: worstEntry.player,
    netValue,
    reasoning: buildReasoning(candidate, worstVal, netValue),
  };
}

/**
 * Evaluate all free agents against roster, return top N recommendations.
 */
export function findBestPickups(
  freeAgents: PlayerValuation[],
  roster: RosterEntry[],
  valuations: Map<string, PlayerValuation>,
  limit: number = 5,
): PickupRecommendation[] {
  const recs: PickupRecommendation[] = [];

  for (const fa of freeAgents) {
    const rec = evaluatePickup(fa, roster, valuations);
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
  const { netValue } = recommendation;

  if (priorityPosition <= 3) return netValue > 0.5;
  if (priorityPosition <= 8) return netValue > 1.5;
  return netValue > 3.0;
}
