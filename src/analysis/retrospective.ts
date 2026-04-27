import type { Matchup, Category } from "../types";
import type { DetailedCategoryState, CategoryState } from "./matchup";
import { extractMentionedCategories } from "../recommendation/category-signals";
import {
  buildRecommendationScorecard as buildRecommendationAlignmentScorecard,
  formatRecommendationScorecardForTelegram as formatAlignmentScorecardForTelegram,
  type RecommendationScorecard as RecommendationAlignmentScorecard,
} from "./recommendation-scorecard";

// --- Interfaces ---

export interface WeeklyRetrospective {
  week: number;
  opponent: string;
  finalScore: string; // "7-5-1 WIN" or "4-8-1 LOSS"
  predictions: CategoryPrediction[];
  decisions: DecisionOutcome[];
  scorecard: RecommendationScorecard;
  alignmentScorecard?: RecommendationAlignmentScorecard;
  lessons: string[]; // computed insights
}

export interface CategoryPrediction {
  category: string;
  predictedState: string; // what engine said at start of week (swing/safe/losing)
  actualResult: "won" | "lost" | "tied";
  correct: boolean;
}

export interface DecisionOutcome {
  type: string; // waiver, stream, lineup, trade
  description: string;
  outcome: "good" | "bad" | "neutral" | "unknown";
  targetCategories?: string[];
  estimatedEdge?: number;
  date?: string;
  notes?: string;
}

export interface ProbabilityCall {
  label: string;
  date?: string;
  probability: number;
  actual: "win" | "loss" | "tie";
  brierScore: number;
}

export interface RecommendationScorecard {
  evaluatedDecisions: number;
  goodDecisions: number;
  badDecisions: number;
  neutralDecisions: number;
  unknownDecisions: number;
  decisionHitRate: number | null;
  probabilityCalls: ProbabilityCall[];
  averageBrierScore: number | null;
}

// --- Helpers ---

/** Map a predicted state to expected result */
function predictedToExpected(state: CategoryState): "won" | "lost" | "tied" {
  switch (state) {
    case "clinched":
    case "safe":
      return "won";
    case "lost":
    case "losing":
      return "lost";
    case "swing":
      return "tied"; // could go either way
  }
}

/** Determine actual category result from final matchup values */
function getActualResult(
  myValue: number,
  opponentValue: number,
  isInverse: boolean,
): "won" | "lost" | "tied" {
  if (myValue === opponentValue) return "tied";
  if (isInverse) {
    // ERA/WHIP: lower is better
    return myValue < opponentValue ? "won" : "lost";
  }
  return myValue > opponentValue ? "won" : "lost";
}

const INVERSE_CATS = new Set(["ERA", "WHIP"]);
const CATEGORY_ORDER = [
  "R",
  "H",
  "HR",
  "RBI",
  "SB",
  "TB",
  "OBP",
  "OUT",
  "K",
  "ERA",
  "WHIP",
  "QS",
  "SVHD",
] as const satisfies readonly Category[];

// --- Core export ---

/**
 * Build a weekly retrospective from the final matchup and optional start-of-week predictions.
 *
 * @param finalMatchup - completed matchup with final scores
 * @param weekStartPredictions - DetailedCategoryState[] from start-of-week analysis (optional)
 * @param weekDecisions - logged decisions from the decisions table (optional)
 */
export function buildRetrospective(
  finalMatchup: Matchup,
  weekStartPredictions?: DetailedCategoryState[],
  weekDecisions?: Array<{
    id?: number;
    timestamp?: string;
    type: string;
    action: string;
    reasoning?: string | null;
  }>,
): WeeklyRetrospective {
  const normalizedWeekDecisions = dedupeDecisions(weekDecisions ?? []);
  const predictions: CategoryPrediction[] = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;

  // Build prediction map for lookup
  const predMap = new Map<string, DetailedCategoryState>();
  if (weekStartPredictions) {
    for (const p of weekStartPredictions) predMap.set(p.category, p);
  } else {
    for (const p of extractPredictionsFromDecisions(finalMatchup, normalizedWeekDecisions)) {
      predMap.set(p.category, p);
    }
  }

  for (const cs of finalMatchup.categories) {
    const isInverse = INVERSE_CATS.has(cs.category);
    const actual = getActualResult(cs.myValue, cs.opponentValue, isInverse);

    if (actual === "won") wins++;
    else if (actual === "lost") losses++;
    else ties++;

    const pred = predMap.get(cs.category);
    const predictedState = pred?.state ?? "unknown";
    const expected = pred ? predictedToExpected(pred.state) : "tied";
    // Correct if predicted outcome matches actual, or swing and any result
    const correct =
      predictedState === "unknown" ? false : expected === actual || predictedState === "swing";

    predictions.push({
      category: cs.category,
      predictedState,
      actualResult: actual,
      correct,
    });
  }

  const finalResults = new Map(
    finalMatchup.categories.map((score) => [
      score.category,
      getActualResult(score.myValue, score.opponentValue, INVERSE_CATS.has(score.category)),
    ]),
  );

  // Build decisions from audit log
  const decisions: DecisionOutcome[] = normalizedWeekDecisions.map((d) =>
    evaluateDecision(finalMatchup, finalResults, d),
  );

  // Compute lessons
  const lessons: string[] = [];
  const correctCount = predictions.filter((p) => p.correct).length;
  const total = predictions.length;

  // Biggest misses: predicted safe/clinched but lost, or predicted lost but won
  const bigMisses = predictions.filter((p) => {
    if (
      (p.predictedState === "safe" || p.predictedState === "clinched") &&
      p.actualResult === "lost"
    )
      return true;
    if ((p.predictedState === "lost" || p.predictedState === "losing") && p.actualResult === "won")
      return true;
    return false;
  });

  for (const miss of bigMisses) {
    if (miss.actualResult === "lost") {
      lessons.push(`Predicted ${miss.category} as ${miss.predictedState} but lost it`);
    } else {
      lessons.push(`Predicted ${miss.category} as ${miss.predictedState} but won it`);
    }
  }

  if (correctCount < total * 0.5) {
    lessons.push(
      `Low prediction accuracy (${correctCount}/${total}) — engine thresholds may need tuning`,
    );
  }

  const scorecard = buildRecommendationScorecard(finalMatchup, decisions, normalizedWeekDecisions);
  const alignmentScorecard = buildRecommendationAlignmentScorecard(
    finalMatchup,
    normalizedWeekDecisions,
  );

  if (scorecard.averageBrierScore != null && scorecard.averageBrierScore > 0.2) {
    lessons.push(
      `Win-odds calibration was noisy (Brier ${scorecard.averageBrierScore.toFixed(3)}) — confidence should tighten`,
    );
  }

  if (scorecard.badDecisions > scorecard.goodDecisions && scorecard.evaluatedDecisions >= 2) {
    lessons.push(
      `Action recommendations underperformed (${scorecard.goodDecisions} good, ${scorecard.badDecisions} bad)`,
    );
  }

  for (const lesson of alignmentScorecard.lessons) {
    if (!lessons.includes(lesson)) lessons.push(lesson);
  }

  const outcome = wins > losses ? "WIN" : wins < losses ? "LOSS" : "TIE";
  const finalScore = `${wins}-${losses}-${ties} ${outcome}`;

  return {
    week: finalMatchup.week,
    opponent: finalMatchup.opponentTeamName,
    finalScore,
    predictions,
    decisions,
    scorecard,
    alignmentScorecard,
    lessons,
  };
}

/** Format retrospective as Telegram HTML message */
export function formatRetrospectiveForTelegram(retro: WeeklyRetrospective): string {
  const correctCount = retro.predictions.filter((p) => p.correct).length;
  const total = retro.predictions.length;

  const lines = [
    `<b>Week ${retro.week} Retrospective</b>`,
    `vs. ${retro.opponent}: ${retro.finalScore}`,
    "",
    `Prediction accuracy: ${correctCount}/${total} categories correct`,
  ];

  if (retro.scorecard.evaluatedDecisions > 0 || retro.scorecard.probabilityCalls.length > 0) {
    const parts: string[] = [];
    if (retro.scorecard.evaluatedDecisions > 0) {
      parts.push(
        `Recs: ${retro.scorecard.goodDecisions} good / ${retro.scorecard.badDecisions} bad / ${retro.scorecard.neutralDecisions} neutral`,
      );
    }
    if (retro.scorecard.averageBrierScore != null) {
      parts.push(`Win-odds Brier: ${retro.scorecard.averageBrierScore.toFixed(3)}`);
    }
    lines.push(parts.join(" | "));
  }

  if (retro.alignmentScorecard) {
    lines.push("");
    lines.push(formatAlignmentScorecardForTelegram(retro.alignmentScorecard));
  }

  // Biggest misses
  const misses = retro.predictions.filter(
    (p) => !p.correct && p.predictedState !== "unknown" && p.predictedState !== "swing",
  );
  if (misses.length > 0) {
    lines.push("Biggest misses:");
    for (const m of misses.slice(0, 5)) {
      lines.push(
        `  \u2022 Predicted ${m.category} as ${m.predictedState}, actually ${m.actualResult}`,
      );
    }
  }

  // Decisions with known outcomes
  const knownDecisions = retro.decisions.filter((d) => d.outcome !== "unknown");
  if (knownDecisions.length > 0) {
    lines.push("\nDecisions:");
    for (const d of knownDecisions.slice(0, 5)) {
      const label = d.outcome.toUpperCase();
      const note = d.notes ? ` (${d.notes})` : "";
      lines.push(`  \u2022 ${d.description}: ${label}${note}`);
    }
  }

  // Lessons
  if (retro.lessons.length > 0) {
    lines.push("\nLessons:");
    for (const l of retro.lessons) {
      lines.push(`  \u2022 ${l}`);
    }
  }

  return lines.join("\n");
}

function extractPredictionsFromDecisions(
  finalMatchup: Matchup,
  weekDecisions: Array<{ id?: number; timestamp?: string; type: string; action: string }>,
): DetailedCategoryState[] {
  const weeklyDecision = weekDecisions
    .map((decision, index) => ({
      action: parseAction(decision.action),
      index,
      id: decision.id,
      timestamp: decision.timestamp,
    }))
    .filter(({ action }) => hasForecastCategories(action))
    .sort((a, b) => {
      const routineOrder = forecastRoutineRank(readString(a.action.routine)) -
        forecastRoutineRank(readString(b.action.routine));
      if (routineOrder !== 0) return routineOrder;
      return compareDecisionOrder(a, b);
    })[0]?.action;

  if (!weeklyDecision) return [];

  const categoriesByState = new Map<CategoryState, Set<string>>([
    ["safe", new Set(readStringArray(weeklyDecision.safe))],
    ["swing", new Set(readStringArray(weeklyDecision.swing))],
    ["losing", new Set(readStringArray(weeklyDecision.lost))],
  ]);

  return finalMatchup.categories
    .map((score) => {
      const state = getLoggedCategoryState(score.category, categoriesByState);
      if (!state) return null;
      return {
        category: score.category,
        state,
        myValue: score.myValue,
        opponentValue: score.opponentValue,
        margin: 0,
      };
    })
    .filter((value): value is DetailedCategoryState => value != null);
}

function getLoggedCategoryState(
  category: string,
  categoriesByState: Map<CategoryState, Set<string>>,
): CategoryState | null {
  if (categoriesByState.get("safe")?.has(category)) return "safe";
  if (categoriesByState.get("swing")?.has(category)) return "swing";
  if (categoriesByState.get("losing")?.has(category)) return "losing";
  return null;
}

function evaluateDecision(
  finalMatchup: Matchup,
  finalResults: Map<string, "won" | "lost" | "tied">,
  decision: { timestamp?: string; type: string; action: string; reasoning?: string | null },
): DecisionOutcome {
  const parsed = parseAction(decision.action);
  const description = describeDecision(decision.type, parsed, decision.reasoning);
  const targetCategories = getDecisionTargetCategories(parsed, decision.reasoning);
  const estimatedEdge = getEstimatedEdge(parsed);
  const date = readString(parsed.date) ?? extractDateFromTimestamp(decision.timestamp);

  if (isAdministrativeDecision(parsed)) {
    return { type: decision.type, description, outcome: "unknown", date };
  }

  if (targetCategories.length === 0) {
    return { type: decision.type, description, outcome: "unknown", estimatedEdge, date };
  }

  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const category of targetCategories) {
    const result = finalResults.get(category);
    if (result === "won") wins++;
    else if (result === "lost") losses++;
    else if (result === "tied") ties++;
  }

  let outcome: DecisionOutcome["outcome"] = "neutral";
  if (wins > losses) outcome = "good";
  else if (losses > wins) outcome = "bad";
  else if (wins === 0 && losses === 0 && ties > 0) outcome = "neutral";

  const actual = summarizeFinalCategoryResults(finalMatchup, targetCategories);
  return {
    type: decision.type,
    description,
    outcome,
    targetCategories,
    estimatedEdge,
    date,
    notes: actual || undefined,
  };
}

function buildRecommendationScorecard(
  finalMatchup: Matchup,
  decisions: DecisionOutcome[],
  weekDecisions: Array<{
    id?: number;
    timestamp?: string;
    type: string;
    action: string;
    reasoning?: string | null;
  }>,
): RecommendationScorecard {
  const goodDecisions = decisions.filter((decision) => decision.outcome === "good").length;
  const badDecisions = decisions.filter((decision) => decision.outcome === "bad").length;
  const neutralDecisions = decisions.filter((decision) => decision.outcome === "neutral").length;
  const unknownDecisions = decisions.filter((decision) => decision.outcome === "unknown").length;
  const evaluatedDecisions = decisions.length - unknownDecisions;
  const decisionHitRate =
    goodDecisions + badDecisions > 0 ? goodDecisions / (goodDecisions + badDecisions) : null;

  const actualOutcome = summarizeMatchupOutcome(finalMatchup);

  const probabilityCallMap = new Map<string, ProbabilityCall>();
  for (const decision of weekDecisions) {
      const action = parseAction(decision.action);
      const probability = readNumber(action.winProbability);
      if (probability == null) continue;

      const label = readString(action.routine) ?? decision.type;
      const date = extractDecisionDate(action, decision.timestamp);
      const dedupeKey = `${label}|${date ?? "unknown"}`;
      if (probabilityCallMap.has(dedupeKey)) continue;

      const expected = actualOutcome === "win" ? 1 : actualOutcome === "loss" ? 0 : 0.5;
      const brierScore = (probability - expected) ** 2;
      probabilityCallMap.set(dedupeKey, {
        label,
        date,
        probability,
        actual: actualOutcome,
        brierScore,
      });
    }

  const probabilityCalls = [...probabilityCallMap.values()];

  const averageBrierScore =
    probabilityCalls.length > 0
      ? probabilityCalls.reduce((sum, call) => sum + call.brierScore, 0) / probabilityCalls.length
      : null;

  return {
    evaluatedDecisions,
    goodDecisions,
    badDecisions,
    neutralDecisions,
    unknownDecisions,
    decisionHitRate,
    probabilityCalls,
    averageBrierScore,
  };
}

function describeDecision(
  type: string,
  action: Record<string, unknown>,
  reasoning?: string | null,
): string {
  if (reasoning) return reasoning;

  const routine = readString(action.routine);
  const add = readString(action.add);
  const drop = readString(action.drop);

  if ((type === "waiver" || type === "stream") && add && drop) {
    return `Add ${add}, drop ${drop}`;
  }
  if (routine) return routine;
  return type;
}

function getDecisionTargetCategories(
  action: Record<string, unknown>,
  reasoning?: string | null,
): Category[] {
  const explicit = readStringArray(action.targetCategories).filter(isCategory);
  if (explicit.length > 0) return sortCategories(explicit);

  const mentioned = extractMentionedCategories(
    reasoning,
    readString(action.reason),
    readString(action.summary),
  );
  return sortCategories(mentioned);
}

function summarizeFinalCategoryResults(finalMatchup: Matchup, targetCategories: Category[]): string {
  const results = targetCategories
    .map((category) => {
      const score = finalMatchup.categories.find((entry) => entry.category === category);
      if (!score) return null;
      const result = getActualResult(score.myValue, score.opponentValue, INVERSE_CATS.has(category));
      return `${category} ${result}`;
    })
    .filter((value): value is string => value != null);

  return results.join(", ");
}

function isAdministrativeDecision(action: Record<string, unknown>): boolean {
  const routine = readString(action.routine);
  return routine === "retrospective" || routine === "news_monitor";
}

function getEstimatedEdge(action: Record<string, unknown>): number | undefined {
  const winProbabilityDelta = readNumber(action.winProbabilityDelta);
  if (winProbabilityDelta != null) return winProbabilityDelta;
  const expectedCategoryWinsDelta = readNumber(action.expectedCategoryWinsDelta);
  if (expectedCategoryWinsDelta != null) return expectedCategoryWinsDelta;
  return undefined;
}

function parseAction(action: string): Record<string, unknown> {
  try {
    return JSON.parse(action) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isCategory(value: string): value is Category {
  return CATEGORY_ORDER.includes(value as Category);
}

function sortCategories(categories: Category[]): Category[] {
  return [...new Set(categories)].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
  );
}

function extractDateFromTimestamp(timestamp?: string): string | undefined {
  return timestamp?.slice(0, 10);
}

function extractDecisionDate(
  action: Record<string, unknown>,
  timestamp?: string,
): string | undefined {
  return readString(action.date) ?? readString(action.weekStart) ?? extractDateFromTimestamp(timestamp);
}

function hasForecastCategories(action: Record<string, unknown>): boolean {
  return (
    readStringArray(action.safe).length > 0 ||
    readStringArray(action.swing).length > 0 ||
    readStringArray(action.lost).length > 0
  );
}

function forecastRoutineRank(routine?: string): number {
  switch (routine) {
    case "weekly_matchup":
      return 0;
    case "daily_morning":
      return 1;
    case "midweek_adjustment":
      return 2;
    default:
      return 3;
  }
}

function compareDecisionOrder(
  a: { id?: number; timestamp?: string; index: number },
  b: { id?: number; timestamp?: string; index: number },
): number {
  if (a.id != null && b.id != null && a.id !== b.id) return a.id - b.id;
  if (a.timestamp && b.timestamp && a.timestamp !== b.timestamp) {
    return a.timestamp.localeCompare(b.timestamp);
  }
  return a.index - b.index;
}

function dedupeDecisions<
  T extends { id?: number; timestamp?: string; type: string; action: string; reasoning?: string | null },
>(weekDecisions: T[]): T[] {
  const deduped = new Map<string, T>();

  for (const decision of weekDecisions) {
    const action = parseAction(decision.action);
    const key = buildDecisionKey(decision, action);
    if (!deduped.has(key)) deduped.set(key, decision);
  }

  return [...deduped.values()];
}

function buildDecisionKey(
  decision: { timestamp?: string; type: string },
  action: Record<string, unknown>,
): string {
  const targetCategories = sortCategories(
    readStringArray(action.targetCategories).filter(isCategory),
  ).join(",");

  return [
    decision.type,
    readString(action.routine) ?? "",
    extractDecisionDate(action, decision.timestamp) ?? "",
    readString(action.weekStart) ?? "",
    readString(action.add) ?? "",
    readString(action.drop) ?? "",
    readString(action.player) ?? "",
    readString(action.opponent) ?? "",
    readNumber(action.week) ?? "",
    readNumber(action.moves) ?? "",
    targetCategories,
  ].join("|");
}

function summarizeMatchupOutcome(finalMatchup: Matchup): "win" | "loss" | "tie" {
  let wins = 0;
  let losses = 0;

  for (const score of finalMatchup.categories) {
    const result = getActualResult(
      score.myValue,
      score.opponentValue,
      INVERSE_CATS.has(score.category),
    );
    if (result === "won") wins++;
    else if (result === "lost") losses++;
  }

  if (wins > losses) return "win";
  if (losses > wins) return "loss";
  return "tie";
}
