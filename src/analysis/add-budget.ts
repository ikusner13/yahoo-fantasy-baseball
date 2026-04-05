import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Env } from "../types";
import type { PickupRecommendation } from "./waivers";

// --- Interfaces ---

export interface AddBudgetState {
  weekStart: string; // ISO date string
  addsUsed: number; // 0-6
  addsRemaining: number;
  reserveForReactions: number; // how many to hold back for mid-week surprises
}

export type AddPriority = "critical" | "high" | "medium" | "low";

// --- Constants ---

const MAX_ADDS_PER_WEEK = 6;

// --- Helpers ---

function budgetPath(env: Env): string {
  return `${env.DATA_DIR}/add-budget.json`;
}

/** Day-of-week aware reserve calculation. Mon/Tue = 3, Wed/Thu = 2, Fri-Sun = 0. */
function computeReserve(): number {
  const day = new Date().getDay(); // 0=Sun, 1=Mon, ...
  if (day === 1 || day === 2) return 3; // Mon-Tue: save more
  if (day >= 5 || day === 0) return 0; // Fri-Sun: spend freely
  return 2; // Wed-Thu: default
}

function readState(env: Env): AddBudgetState {
  try {
    const raw = readFileSync(budgetPath(env), "utf-8");
    return JSON.parse(raw) as AddBudgetState;
  } catch {
    // No file yet — return defaults
    const now = new Date();
    const weekStart = now.toISOString().slice(0, 10);
    return {
      weekStart,
      addsUsed: 0,
      addsRemaining: MAX_ADDS_PER_WEEK,
      reserveForReactions: computeReserve(),
    };
  }
}

function writeState(env: Env, state: AddBudgetState): void {
  const path = budgetPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

// --- Core exports ---

/**
 * Read current add budget for this matchup week.
 * Recalculates reserve based on current day-of-week.
 */
export function getAddBudget(env: Env): AddBudgetState {
  const state = readState(env);
  // Always refresh reserve based on current day
  state.reserveForReactions = computeReserve();
  state.addsRemaining = MAX_ADDS_PER_WEEK - state.addsUsed;
  return state;
}

/** Increment addsUsed and persist. */
export function recordAdd(env: Env): void {
  const state = readState(env);
  state.addsUsed = Math.min(state.addsUsed + 1, MAX_ADDS_PER_WEEK);
  state.addsRemaining = MAX_ADDS_PER_WEEK - state.addsUsed;
  state.reserveForReactions = computeReserve();
  writeState(env, state);
}

/** Reset budget for a new matchup week. */
export function resetWeeklyBudget(env: Env, weekStart: string): void {
  const state: AddBudgetState = {
    weekStart,
    addsUsed: 0,
    addsRemaining: MAX_ADDS_PER_WEEK,
    reserveForReactions: computeReserve(),
  };
  writeState(env, state);
}

/**
 * Classify how urgent a pickup is.
 *
 * - critical: closer change or injury to starter — always use an add
 * - high: netValue > 2.0
 * - medium: netValue 1.0-2.0
 * - low: netValue < 1.0
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
 *
 * - Critical: always true (can't miss a closer change)
 * - High: true if any adds remain
 * - Medium: true if adds remain beyond reserve
 * - Low: true if adds remain beyond reserve + 1
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
