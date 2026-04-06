// Semantic layer: aggregates pre-computed engine data into structured briefings for LLM consumption.
// The LLM never does math — it receives pre-digested analysis and provides synthesis/judgment.

// --- Briefing types ---

export interface MatchupBriefing {
  summary: string; // "Week 2 vs Professor Chaos, losing 4-8-1, 1 day left"
  categories: string; // each category with state, values, and margin
  worthless: string; // "OUT, K, QS already lost — production here is worthless"
  streaming: string; // "Engine recommends: sit pitchers to protect WHIP (0.06 margin)"
  ipStatus: string; // "35.2 IP (above 20 min — safe to sit)"
  volatility?: string; // "High-variance pitching roster"
  opponentScouting?: string; // "Opponent strong in K/QS, weak in SB/SV+H"
  gameCountEdge?: string; // "NYY has 7 games this week"
  streaks?: string; // "Hot: Schwarber (.410 xwOBA). Cold: Clement (.240)"
  twoStartPitchers?: string; // "Pivetta: 2 starts (vs BOS Tue, vs NYY Sun)"
  standings?: string; // "#4 (6-4-3), need wins for playoffs"
  addBudget?: string; // "3 adds remaining this week"
  recentFeedback?: string; // user feedback from /feedback command
}

export interface WaiverBriefing {
  matchupContext: string; // swing categories this week
  addBudget: string;
  recommendations: string; // engine's ranked pickups with z-scores
  rosterNeeds: string;
  standings?: string;
}

export interface TradeBriefing {
  roster: string;
  needs: string;
  surplus: string;
  targetInfo: string;
  standings?: string;
  streaks?: string; // sell-high / buy-low candidates
}

export interface InjuryBriefing {
  player: string;
  injury: string;
  rosterContext: string;
  ilSlots: string;
  matchupImpact?: string; // "Losing X hurts HR which is a swing category"
  replacementOptions?: string;
}

export interface LineupBriefing {
  starters: string;
  benched: string;
  games: string;
  strategy?: string;
  swingCategories?: string;
  streaks?: string; // "Hot: Schwarber (.410 xwOBA). Cold: Clement (.240)"
}

// --- Formatters: briefing → structured text for LLM user prompt ---

export function formatMatchupForLLM(b: MatchupBriefing): string {
  const sections = [b.summary, "", b.categories];
  if (b.worthless) sections.push("", `WORTHLESS PRODUCTION: ${b.worthless}`);
  if (b.streaming) sections.push(`STREAMING: ${b.streaming}`);
  if (b.ipStatus) sections.push(`IP STATUS: ${b.ipStatus}`);
  if (b.volatility) sections.push(`VOLATILITY: ${b.volatility}`);
  if (b.opponentScouting) sections.push(`OPPONENT: ${b.opponentScouting}`);
  if (b.gameCountEdge) sections.push(`GAME COUNT: ${b.gameCountEdge}`);
  if (b.streaks) sections.push(`STREAKS: ${b.streaks}`);
  if (b.twoStartPitchers) sections.push(`TWO-START SP: ${b.twoStartPitchers}`);
  if (b.standings) sections.push(`STANDINGS: ${b.standings}`);
  if (b.addBudget) sections.push(`ADD BUDGET: ${b.addBudget}`);
  if (b.recentFeedback) sections.push(`\nRECENT FEEDBACK:\n${b.recentFeedback}`);
  return sections.join("\n");
}

export function formatWaiverForLLM(b: WaiverBriefing): string {
  const sections = [
    `MATCHUP CONTEXT: ${b.matchupContext}`,
    `ADD BUDGET: ${b.addBudget}`,
    `ROSTER NEEDS: ${b.rosterNeeds}`,
    "",
    `RECOMMENDATIONS:\n${b.recommendations}`,
  ];
  if (b.standings) sections.push(`STANDINGS: ${b.standings}`);
  return sections.join("\n");
}

export function formatTradeForLLM(b: TradeBriefing): string {
  const sections = [
    `MY ROSTER: ${b.roster}`,
    `CATEGORY NEEDS: ${b.needs}`,
    `SURPLUS: ${b.surplus}`,
    "",
    `TARGET: ${b.targetInfo}`,
  ];
  if (b.standings) sections.push(`STANDINGS: ${b.standings}`);
  if (b.streaks) sections.push(`STREAKS: ${b.streaks}`);
  return sections.join("\n");
}

export function formatInjuryForLLM(b: InjuryBriefing): string {
  const sections = [
    `PLAYER: ${b.player}`,
    `INJURY: ${b.injury}`,
    `ROSTER: ${b.rosterContext}`,
    `IL SLOTS: ${b.ilSlots}`,
  ];
  if (b.matchupImpact) sections.push(`MATCHUP IMPACT: ${b.matchupImpact}`);
  if (b.replacementOptions) sections.push(`REPLACEMENTS: ${b.replacementOptions}`);
  return sections.join("\n");
}

export function formatLineupForLLM(b: LineupBriefing): string {
  const sections = [`STARTERS: ${b.starters}`, `BENCHED: ${b.benched}`, `GAMES: ${b.games}`];
  if (b.strategy) sections.push(`STRATEGY: ${b.strategy}`);
  if (b.swingCategories) sections.push(`SWING CATEGORIES: ${b.swingCategories}`);
  if (b.streaks) sections.push(`STREAKS: ${b.streaks}`);
  return sections.join("\n");
}
