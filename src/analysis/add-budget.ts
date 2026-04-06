import type { Env } from "../types";
import type { PickupRecommendation } from "./waivers";
import { loadTuning } from "../config/tuning";

// --- Interfaces ---

export interface AddBudgetState {
  weekStart: string; // ISO date string
  addsUsed: number; // 0-6
  addsRemaining: number;
  reserveForReactions: number; // how many to hold back for mid-week surprises
}

export type AddPriority = "critical" | "high" | "medium" | "low";

// --- Helpers ---

const KV_KEY = "add-budget";

/** Day-of-week aware reserve calculation. Reads thresholds from tuning config. */
function computeReserve(): number {
  const { budget } = loadTuning();
  const day = new Date().getDay(); // 0=Sun, 1=Mon, ...
  if (day === 1 || day === 2) return budget.reserveMonTue;
  if (day >= 5 || day === 0) return budget.reserveFriSun;
  return budget.reserveWedThu;
}

async function readState(env: Env): Promise<AddBudgetState> {
  try {
    const state = await env.KV.get<AddBudgetState>(KV_KEY, "json");
    if (state) return state;
  } catch {
    // fall through to defaults
  }
  const now = new Date();
  const weekStart = now.toISOString().slice(0, 10);
  return {
    weekStart,
    addsUsed: 0,
    addsRemaining: loadTuning().budget.maxAddsPerWeek,
    reserveForReactions: computeReserve(),
  };
}

async function writeState(env: Env, state: AddBudgetState): Promise<void> {
  await env.KV.put(KV_KEY, JSON.stringify(state));
}

// --- Core exports ---

/**
 * Read current add budget for this matchup week.
 * Recalculates reserve based on current day-of-week.
 */
export async function getAddBudget(env: Env): Promise<AddBudgetState> {
  const state = await readState(env);
  state.reserveForReactions = computeReserve();
  state.addsRemaining = loadTuning().budget.maxAddsPerWeek - state.addsUsed;
  return state;
}

/** Increment addsUsed and persist. */
export async function recordAdd(env: Env): Promise<void> {
  const state = await readState(env);
  state.addsUsed = Math.min(state.addsUsed + 1, loadTuning().budget.maxAddsPerWeek);
  state.addsRemaining = loadTuning().budget.maxAddsPerWeek - state.addsUsed;
  state.reserveForReactions = computeReserve();
  await writeState(env, state);
}

/** Reset budget for a new matchup week. */
export async function resetWeeklyBudget(env: Env, weekStart: string): Promise<void> {
  const state: AddBudgetState = {
    weekStart,
    addsUsed: 0,
    addsRemaining: loadTuning().budget.maxAddsPerWeek,
    reserveForReactions: computeReserve(),
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
 * Decide whether to spend an add given budget and priority.
 */
export function shouldSpendAdd(budget: AddBudgetState, priority: AddPriority): boolean {
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
