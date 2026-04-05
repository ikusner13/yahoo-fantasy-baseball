const CATEGORIES = "R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD";

// --- Lineup ---

interface LineupContext {
  roster: string;
  games: string;
  matchup?: string;
  injuries?: string;
}

export function lineupDecisionPrompt(context: LineupContext): {
  system: string;
  user: string;
} {
  const system = `You are an expert fantasy baseball analyst. Given the current roster, today's games, and matchup context, recommend lineup decisions. Focus on H2H category optimization. Categories: ${CATEGORIES}.`;

  let user = `ROSTER:\n${context.roster}\n\nTODAY'S GAMES:\n${context.games}`;
  if (context.matchup) user += `\n\nMATCHUP CONTEXT:\n${context.matchup}`;
  if (context.injuries) user += `\n\nINJURIES/ALERTS:\n${context.injuries}`;
  user += "\n\nRecommend who to start, bench, and any position swaps. Explain briefly.";

  return { system, user };
}

// --- Waiver Wire ---

interface WaiverContext {
  recommendations: string;
  rosterNeeds: string;
  waiverPriority: number;
}

export function waiverWirePrompt(context: WaiverContext): {
  system: string;
  user: string;
} {
  const system = `You are a fantasy baseball waiver wire expert. Evaluate pickups considering category needs, Statcast trends, and role changes. Categories: ${CATEGORIES}.`;

  const user = `WAIVER PRIORITY: #${context.waiverPriority}\n\nROSTER NEEDS:\n${context.rosterNeeds}\n\nRECOMMENDATIONS:\n${context.recommendations}\n\nRank the top pickups, noting which categories each helps and whether the waiver priority is worth spending.`;

  return { system, user };
}

// --- Trade ---

interface TradeContext {
  myRoster: string;
  targetRoster: string;
  categoryNeeds: string;
  surplusPlayers: string;
}

export function tradeProposalPrompt(context: TradeContext): {
  system: string;
  user: string;
} {
  const system = `You are a fantasy baseball trade negotiator. Craft a fair but favorable trade proposal. The message should sound natural, not robotic -- you're sending this to a friend in a league. Categories: ${CATEGORIES}.`;

  const user = `MY ROSTER:\n${context.myRoster}\n\nTARGET ROSTER:\n${context.targetRoster}\n\nMY CATEGORY NEEDS:\n${context.categoryNeeds}\n\nMY SURPLUS PLAYERS:\n${context.surplusPlayers}\n\nPropose a trade that addresses my needs while offering fair value. Include a short trade message I can send.`;

  return { system, user };
}

// --- Matchup Strategy ---

interface MatchupStrategyContext {
  analysis: string;
  currentScores: string;
  daysRemaining: number;
}

export function matchupStrategyPrompt(context: MatchupStrategyContext): {
  system: string;
  user: string;
} {
  const system = `You are a fantasy baseball strategist specializing in H2H categories. Given the current matchup state, recommend tactical adjustments. Categories: ${CATEGORIES}.`;

  const user = `DAYS REMAINING: ${context.daysRemaining}\n\nCURRENT SCORES:\n${context.currentScores}\n\nANALYSIS:\n${context.analysis}\n\nRecommend which categories to target or punt and any roster moves to optimize the week.`;

  return { system, user };
}

// --- Injury Assessment ---

interface InjuryContext {
  playerName: string;
  injuryInfo: string;
  rosterContext: string;
}

export function injuryAssessmentPrompt(context: InjuryContext): {
  system: string;
  user: string;
} {
  const system = `You are a fantasy baseball injury analyst. Assess the impact of this injury on the player's fantasy value and recommend an action (hold, IL stash, drop, or replace). Categories: ${CATEGORIES}.`;

  const user = `PLAYER: ${context.playerName}\n\nINJURY INFO:\n${context.injuryInfo}\n\nROSTER CONTEXT:\n${context.rosterContext}\n\nAssess the severity, expected timeline, and recommend an action.`;

  return { system, user };
}
