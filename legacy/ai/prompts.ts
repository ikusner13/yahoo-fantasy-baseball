import type { Touchpoint } from "./llm";

const CATS = "R, H, HR, RBI, SB, TB, OBP | OUT, K, ERA, WHIP, QS, SV+H";

// --- Shared context types (kept for gm.ts backward compat, will be removed when gm.ts is updated) ---

/** Matchup state injected into prompts for strategic context */
export interface MatchupContext {
  opponentName: string;
  daysRemaining: number;
  winning: string[]; // category names we're winning
  losing: string[]; // category names we're losing
  swing: string[]; // toss-up categories
  score: string; // e.g. "4-8-1"
  standingsRank?: number; // our rank in league
}

/** Weekly add budget state */
export interface AddBudgetContext {
  addsRemaining: number;
  addsUsed: number;
}

// --- Prompt return type ---

export interface LLMPrompt {
  system: string;
  user: string;
  touchpoint: Touchpoint;
}

// --- Lineup Summary (Qwen 3.5 Flash — RULES-based, 99% eval score) ---
// Receives pre-formatted LineupBriefing text. LLM summarizes in 2 sentences.

export function lineupSummaryPrompt(briefing: string): LLMPrompt {
  return {
    system: `RULES: (1) Plain text only (2) Max 2 sentences (3) Name key starters (4) Explain benchings. If MEMORY is provided, reference recent benching outcomes. Categories: ${CATS}`,
    user: briefing,
    touchpoint: "lineup",
  };
}

// --- Waiver Wire (Qwen 3.5 Flash — rules-v2, 93% eval score) ---
// Receives pre-formatted WaiverBriefing text. LLM evaluates engine recommendations.

export function waiverWirePrompt(briefing: string): LLMPrompt {
  return {
    system: `The stats engine has ranked waiver pickups below. Your job: assess whether the engine's recommendation makes sense given the full matchup context and add budget. Consider if this pickup addresses a swing category this week. The engine ranks by z-score, but you should consider factors the engine can't capture: role changes, batting order moves, upcoming schedule difficulty, sell-high regression risk. If the numbers say YES but context says NO (or vice versa), explain your reasoning. If MEMORY is provided, reference recent pickup outcomes and budget patterns. RULES: (1) 2-3 sentences only (2) Plain text, no markdown (3) Start with YES or NO (4) Name categories that improve (5) Address priority cost. Categories: ${CATS}`,
    user: briefing,
    touchpoint: "waiver",
  };
}

// --- Matchup Strategy (Qwen 3.5 Flash — RULES priorities, 95% eval score) ---
// Receives full MatchupBriefing text. LLM synthesizes into 3 actionable priorities.

export function matchupStrategyPrompt(briefing: string): LLMPrompt {
  return {
    system: `You are a H2H fantasy baseball strategist receiving a complete pre-computed matchup briefing. All numbers are computed by the stats engine — do not recalculate. Your job: synthesize all signals into 3 actionable priorities. Consider: category correlations (HR/RBI/TB/R move together, SB is independent, OUT/K/QS/ERA/WHIP are starter-driven, SV+H is reliever-driven). Flag worthless production and recommend reallocating effort to swing categories. You may override the engine's recommendation when you have strong contextual reasoning. Historical patterns, hot/cold streaks, park effects, and opponent tendencies are valid reasons to go against the numbers. When you disagree with the engine, state why clearly. If MEMORY is provided, reference it to avoid repeating past mistakes and build on successful strategies. Output exactly 3 numbered priorities, each naming specific categories. Plain text only. No markdown. Categories: ${CATS}`,
    user: briefing,
    touchpoint: "matchup",
  };
}

// --- Trade Proposal (DeepSeek V3 — friend-msg, 94% eval score) ---
// Receives pre-formatted TradeBriefing text. LLM crafts natural trade message.

export function tradeProposalPrompt(briefing: string): LLMPrompt {
  return {
    system: `You are a fantasy baseball trade negotiator. Craft a fair but favorable trade proposal. The message should sound natural, not robotic — you're sending this to a friend in a league. Consider sell-high and buy-low opportunities based on recent streaks. If MEMORY is provided, reference past trade attempts and roster evolution. Propose a trade that addresses category needs while offering fair value. Include a short trade message I can send. Categories: ${CATS}`,
    user: briefing,
    touchpoint: "trade",
  };
}

// --- Injury Assessment (Llama 3.3 70B — anti-preamble, 94% eval score) ---
// Receives pre-formatted InjuryBriefing text. LLM interprets injury news and recommends action.

export function injuryAssessmentPrompt(briefing: string): LLMPrompt {
  return {
    system: `You are interpreting injury news. The engine provides roster context and matchup impact. Your job: classify severity and recommend action based on the injury description. If MEMORY is provided, reference past IL decisions on this player. Output a decision: HOLD, IL_STASH, DROP, or REPLACE. Then explain in 1-2 sentences. No preamble. No markdown. Plain text only. Categories: ${CATS}`,
    user: briefing,
    touchpoint: "injury",
  };
}
