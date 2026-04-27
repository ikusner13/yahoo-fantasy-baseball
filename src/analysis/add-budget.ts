import type { Env } from "../types";
import type { PickupRecommendation } from "./waivers";
import { loadTuning } from "../config/tuning";
import { loadLeagueSettings } from "../config/league";

// --- Interfaces ---

export type AddType = "streaming" | "waiver" | "emergency";

export interface AddBudgetAllocation {
  streaming: number; // adds reserved for streaming pitchers
  waivers: number; // adds reserved for waiver upgrades
  emergency: number; // adds reserved for injuries/closer changes
  total: number; // = streaming + waivers + emergency
}

export interface MatchupNeeds {
  /** categories where small gains could flip the matchup */
  swingCategories?: string[];
}

export interface AddBudgetState {
  weekStart: string; // ISO date string
  addsUsed: number; // 0-6 (kept for backward compat)
  addsRemaining: number; // (kept for backward compat)
  reserveForReactions: number; // (kept for backward compat)
  streamingAddsUsed: number;
  waiverAddsUsed: number;
  emergencyAddsUsed: number;
}

export type AddPriority = "critical" | "high" | "medium" | "low";

// --- Constants ---

const KV_KEY = "add-budget";

const PITCHING_COUNTING_CATS = new Set(["K", "QS", "OUT", "W", "SV"]);
const BATTING_CATS = new Set(["R", "HR", "RBI", "SB", "OBP", "AVG", "H", "TB"]);

// --- Day-of-week allocation tables ---

interface DayAllocation {
  streaming: number;
  waivers: number;
  emergency: number;
}

/** Base allocation by phase of matchup week (before matchup-need adjustments). */
function baseDayAllocation(day: number): DayAllocation {
  // 0=Sun, 1=Mon
  if (day === 1 || day === 2) return { streaming: 2, waivers: 1, emergency: 3 };
  if (day === 3 || day === 4) return { streaming: 2, waivers: 2, emergency: 2 };
  // Fri-Sun: spend freely
  return { streaming: 3, waivers: 3, emergency: 0 };
}

// --- Helpers ---

/** Day-of-week aware reserve calculation. Reads thresholds from tuning config. */
function computeReserve(): number {
  const { budget } = loadTuning();
  const day = new Date().getDay(); // 0=Sun, 1=Mon, ...
  if (day === 1 || day === 2) return budget.reserveMonTue;
  if (day >= 5 || day === 0) return budget.reserveFriSun;
  return budget.reserveWedThu;
}

function getMaxAddsPerWeek(): number {
  return loadLeagueSettings().transactions.addsPerWeek;
}

/**
 * Compute dynamic budget allocation for the current day of week,
 * remaining adds, and optional matchup context.
 */
export function computeAllocation(
  state: AddBudgetState,
  matchupNeeds?: MatchupNeeds,
  nowOverride?: Date,
): AddBudgetAllocation {
  const now = nowOverride ?? new Date();
  const day = now.getDay();
  const max = getMaxAddsPerWeek();
  const totalUsed = state.streamingAddsUsed + state.waiverAddsUsed + state.emergencyAddsUsed;
  const remaining = Math.max(0, max - totalUsed);

  const base = baseDayAllocation(day);
  let { streaming, waivers, emergency } = base;

  // Apply matchup-need adjustments
  if (matchupNeeds?.swingCategories?.length) {
    const pitchingSwing = matchupNeeds.swingCategories.some((c) => PITCHING_COUNTING_CATS.has(c));
    const battingSwing = matchupNeeds.swingCategories.some((c) => BATTING_CATS.has(c));
    if (pitchingSwing && !battingSwing && waivers > 0) {
      streaming += 1;
      waivers -= 1;
    } else if (battingSwing && !pitchingSwing && streaming > 0) {
      waivers += 1;
      streaming -= 1;
    }
  }

  // Promote unused emergency budget on Thu+ (day >= 4 or Sun=0)
  if (day >= 4 || day === 0) {
    const emergencyUsed = state.emergencyAddsUsed;
    const emergencyUnused = Math.max(0, emergency - emergencyUsed);
    if (emergencyUnused > 0) {
      const half = Math.floor(emergencyUnused / 2);
      streaming += half;
      waivers += emergencyUnused - half;
      emergency -= emergencyUnused;
    }
  }

  // Clamp each bucket so total doesn't exceed remaining adds
  const rawTotal = streaming + waivers + emergency;
  if (rawTotal > remaining && rawTotal > 0) {
    const scale = remaining / rawTotal;
    streaming = Math.floor(streaming * scale);
    waivers = Math.floor(waivers * scale);
    emergency = remaining - streaming - waivers;
  }

  return {
    streaming,
    waivers,
    emergency,
    total: streaming + waivers + emergency,
  };
}

async function readState(env: Env): Promise<AddBudgetState> {
  try {
    const raw = await env.KV.get<Record<string, unknown>>(KV_KEY, "json");
    if (raw && typeof raw.weekStart === "string") {
      return {
        weekStart: raw.weekStart as string,
        addsUsed: (raw.addsUsed as number) ?? 0,
        addsRemaining: (raw.addsRemaining as number) ?? getMaxAddsPerWeek(),
        reserveForReactions: (raw.reserveForReactions as number) ?? computeReserve(),
        streamingAddsUsed: (raw.streamingAddsUsed as number) ?? 0,
        waiverAddsUsed: (raw.waiverAddsUsed as number) ?? 0,
        emergencyAddsUsed: (raw.emergencyAddsUsed as number) ?? 0,
      };
    }
  } catch {
    // fall through to defaults
  }
  const now = new Date();
  const weekStart = now.toISOString().slice(0, 10);
  return {
    weekStart,
    addsUsed: 0,
    addsRemaining: getMaxAddsPerWeek(),
    reserveForReactions: computeReserve(),
    streamingAddsUsed: 0,
    waiverAddsUsed: 0,
    emergencyAddsUsed: 0,
  };
}

async function writeState(env: Env, state: AddBudgetState): Promise<void> {
  if (env._dryRun) return;
  await env.KV.put(KV_KEY, JSON.stringify(state));
}

// --- Core exports ---

/**
 * Read current add budget for this matchup week.
 * Recalculates reserve based on current day-of-week.
 */
export async function getAddBudget(env: Env): Promise<AddBudgetState> {
  const state = await readState(env);
  const max = getMaxAddsPerWeek();
  state.reserveForReactions = computeReserve();
  state.addsUsed = state.streamingAddsUsed + state.waiverAddsUsed + state.emergencyAddsUsed;
  state.addsRemaining = max - state.addsUsed;
  return state;
}

/**
 * Increment adds and persist. Tracks by add type.
 */
export async function recordAdd(env: Env, type?: AddType): Promise<void> {
  const state = await readState(env);
  const max = getMaxAddsPerWeek();

  if (type === "streaming") {
    state.streamingAddsUsed += 1;
  } else if (type === "waiver") {
    state.waiverAddsUsed += 1;
  } else if (type === "emergency") {
    state.emergencyAddsUsed += 1;
  } else {
    // Legacy: no type specified, count as waiver
    state.waiverAddsUsed += 1;
  }

  state.addsUsed = Math.min(
    state.streamingAddsUsed + state.waiverAddsUsed + state.emergencyAddsUsed,
    max,
  );
  state.addsRemaining = max - state.addsUsed;
  state.reserveForReactions = computeReserve();
  await writeState(env, state);
}

/** Reset budget for a new matchup week. */
export async function resetWeeklyBudget(env: Env, weekStart: string): Promise<void> {
  const state: AddBudgetState = {
    weekStart,
    addsUsed: 0,
    addsRemaining: getMaxAddsPerWeek(),
    reserveForReactions: computeReserve(),
    streamingAddsUsed: 0,
    waiverAddsUsed: 0,
    emergencyAddsUsed: 0,
  };
  await writeState(env, state);
}

/**
 * Classify how urgent a pickup is.
 */
export function classifyAddPriority(
  recommendation: PickupRecommendation,
  context: {
    isCloserChange?: boolean;
    isCallUp?: boolean;
    isInjuryReplacement?: boolean;
  },
): AddPriority {
  if (context.isCloserChange || context.isInjuryReplacement) return "critical";
  if (recommendation.netValue > 2.0) return "high";
  if (recommendation.netValue >= 1.0) return "medium";
  return "low";
}

/**
 * Check whether a specific type of add is allowed given the budget allocation.
 */
export function canSpendAdd(
  budget: AddBudgetState,
  type: AddType,
  priority: AddPriority,
  matchupNeeds?: MatchupNeeds,
  nowOverride?: Date,
): boolean {
  const max = getMaxAddsPerWeek();
  const totalUsed = budget.streamingAddsUsed + budget.waiverAddsUsed + budget.emergencyAddsUsed;
  const totalRemaining = max - totalUsed;

  // Critical always goes through if any adds remain (or even if not — emergency override)
  if (priority === "critical") return true;

  // No adds left at all
  if (totalRemaining <= 0) return false;

  const alloc = computeAllocation(budget, matchupNeeds, nowOverride);

  // How many adds have been used in this specific bucket?
  const usedInBucket =
    type === "streaming"
      ? budget.streamingAddsUsed
      : type === "waiver"
        ? budget.waiverAddsUsed
        : budget.emergencyAddsUsed;

  // How many are allocated to this bucket?
  const allocForBucket =
    type === "streaming" ? alloc.streaming : type === "waiver" ? alloc.waivers : alloc.emergency;

  const bucketRemaining = Math.max(0, allocForBucket - usedInBucket);

  switch (priority) {
    case "high":
      return bucketRemaining > 0;
    case "medium":
      return bucketRemaining > 1;
    case "low":
      return bucketRemaining > 2;
  }
}

/**
 * Backward-compat wrapper. Delegates to canSpendAdd with "waiver" type.
 */
export function shouldSpendAdd(budget: AddBudgetState, priority: AddPriority): boolean {
  // Legacy behavior: check against total remaining and reserve
  switch (priority) {
    case "critical":
      return true;
    case "high":
      return budget.addsRemaining > 0;
    case "medium":
      return budget.addsRemaining > budget.reserveForReactions;
    case "low":
      return budget.addsRemaining > budget.reserveForReactions + 1;
  }
}
