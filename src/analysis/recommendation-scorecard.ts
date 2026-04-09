import type { Category, Matchup } from "../types";
import type { CategoryState } from "./matchup";

export interface LoggedDecisionRecord {
  type: string;
  action: string;
  reasoning?: string | null;
  result?: string | null;
  timestamp?: string | null;
}

export type RecommendationAlignment = "aligned" | "mixed" | "missed" | "unscored";

export interface ForecastScore {
  routine: string;
  winProbability?: number;
  actualOutcome: number;
  brierScore?: number;
  expectedCategoryWins?: number;
  actualCategoryPoints: number;
  categoryError?: number;
  calibration:
    | "well_calibrated"
    | "too_optimistic"
    | "too_pessimistic"
    | "slightly_optimistic"
    | "slightly_pessimistic"
    | "unknown";
}

export interface ScoredRecommendation {
  type: string;
  routine?: string;
  description: string;
  targetCategories: Category[];
  alignment: RecommendationAlignment;
  note: string;
  winProbabilityDelta?: number;
  expectedCategoryWinsDelta?: number;
  timestamp?: string;
}

export interface RecommendationScorecard {
  week: number;
  opponent: string;
  finalScore: string;
  forecast?: ForecastScore;
  recommendations: ScoredRecommendation[];
  alignedCount: number;
  mixedCount: number;
  missedCount: number;
  unscoredCount: number;
  lessons: string[];
}

type ActualCategoryResult = "won" | "lost" | "tied";

function parseAction(actionJson: string): Record<string, unknown> {
  try {
    return JSON.parse(actionJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isCategory(value: string): value is Category {
  return [
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
  ].includes(value);
}

function toCategoryArray(value: unknown): Category[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim().toUpperCase())
    .filter(isCategory);
}

function extractHelpedCategories(reasoning?: string | null): Category[] {
  if (!reasoning) return [];
  const helpMatch = reasoning.match(/Helps\s+([A-Z+, ]+)/i);
  if (!helpMatch?.[1]) return [];
  return helpMatch[1]
    .split(/[,+]/)
    .map((part) => part.trim().toUpperCase())
    .filter(isCategory);
}

function buildActualResultMap(finalMatchup: Matchup): Map<Category, ActualCategoryResult> {
  const map = new Map<Category, ActualCategoryResult>();
  for (const category of finalMatchup.categories) {
    const inverse = category.category === "ERA" || category.category === "WHIP";
    let result: ActualCategoryResult;
    if (category.myValue === category.opponentValue) {
      result = "tied";
    } else if (inverse) {
      result = category.myValue < category.opponentValue ? "won" : "lost";
    } else {
      result = category.myValue > category.opponentValue ? "won" : "lost";
    }
    map.set(category.category, result);
  }
  return map;
}

function actualOutcomeValue(finalMatchup: Matchup): number {
  const resultMap = buildActualResultMap(finalMatchup);
  let wins = 0;
  let losses = 0;
  let ties = 0;

  for (const result of resultMap.values()) {
    if (result === "won") wins++;
    else if (result === "lost") losses++;
    else ties++;
  }

  if (wins > losses) return 1;
  if (wins < losses) return 0;
  return 0.5;
}

function actualCategoryPoints(finalMatchup: Matchup): number {
  const resultMap = buildActualResultMap(finalMatchup);
  let points = 0;
  for (const result of resultMap.values()) {
    if (result === "won") points += 1;
    else if (result === "tied") points += 0.5;
  }
  return points;
}

function formatDescription(decision: LoggedDecisionRecord, action: Record<string, unknown>): string {
  if (decision.reasoning) return decision.reasoning;
  const routine = typeof action.routine === "string" ? action.routine : undefined;
  const add = typeof action.add === "string" ? action.add : undefined;
  const drop = typeof action.drop === "string" ? action.drop : undefined;
  const player = typeof action.player === "string" ? action.player : undefined;

  if (add && drop) return `${add} for ${drop}`;
  if (add) return add;
  if (player) return player;
  if (routine) return routine;
  return decision.type;
}

function inferAlignment(
  targetCategories: Category[],
  resultMap: Map<Category, ActualCategoryResult>,
): { alignment: RecommendationAlignment; note: string } {
  if (targetCategories.length === 0) {
    return { alignment: "unscored", note: "No target categories logged" };
  }

  let wins = 0;
  let ties = 0;
  let losses = 0;
  const parts: string[] = [];

  for (const category of targetCategories) {
    const result = resultMap.get(category) ?? "tied";
    parts.push(`${category} ${result}`);
    if (result === "won") wins++;
    else if (result === "lost") losses++;
    else ties++;
  }

  if (losses === 0 && (wins > 0 || ties > 0)) {
    return { alignment: "aligned", note: parts.join(", ") };
  }
  if (wins > 0 || ties > 0) {
    return { alignment: "mixed", note: parts.join(", ") };
  }
  return { alignment: "missed", note: parts.join(", ") };
}

function scoreForecast(
  action: Record<string, unknown>,
  finalMatchup: Matchup,
): ForecastScore | undefined {
  const winProbability =
    typeof action.winProbability === "number" ? action.winProbability : undefined;
  const expectedCategoryWins =
    typeof action.expectedCategoryWins === "number" ? action.expectedCategoryWins : undefined;
  const routine = typeof action.routine === "string" ? action.routine : "weekly_matchup";
  const actualOutcome = actualOutcomeValue(finalMatchup);
  const actualPoints = actualCategoryPoints(finalMatchup);

  const brierScore =
    winProbability != null ? (winProbability - actualOutcome) * (winProbability - actualOutcome) : undefined;
  const categoryError =
    expectedCategoryWins != null ? Math.abs(expectedCategoryWins - actualPoints) : undefined;

  let calibration: ForecastScore["calibration"] = "unknown";
  if (winProbability != null) {
    if (winProbability >= 0.7 && actualOutcome < 0.5) calibration = "too_optimistic";
    else if (winProbability >= 0.6 && actualOutcome < 1) calibration = "slightly_optimistic";
    else if (winProbability <= 0.3 && actualOutcome > 0.5) calibration = "too_pessimistic";
    else if (winProbability <= 0.4 && actualOutcome > 0) calibration = "slightly_pessimistic";
    else calibration = "well_calibrated";
  }

  return {
    routine,
    winProbability,
    actualOutcome,
    brierScore,
    expectedCategoryWins,
    actualCategoryPoints: actualPoints,
    categoryError,
    calibration,
  };
}

export function extractPredictedCategoryStates(
  decisions: LoggedDecisionRecord[],
): Map<Category, CategoryState> {
  const forecastDecision = decisions
    .map((decision) => parseAction(decision.action))
    .find((action) => {
      const routine = typeof action.routine === "string" ? action.routine : "";
      return routine === "weekly_matchup" || routine === "midweek_adjustment";
    });

  const map = new Map<Category, CategoryState>();
  if (!forecastDecision) return map;

  for (const category of toCategoryArray(forecastDecision.safe)) {
    map.set(category, "safe");
  }
  for (const category of toCategoryArray(forecastDecision.swing)) {
    map.set(category, "swing");
  }
  for (const category of toCategoryArray(forecastDecision.lost)) {
    map.set(category, "losing");
  }

  return map;
}

export function buildRecommendationScorecard(
  finalMatchup: Matchup,
  decisions: LoggedDecisionRecord[] = [],
): RecommendationScorecard {
  const resultMap = buildActualResultMap(finalMatchup);
  const scored: ScoredRecommendation[] = [];

  const forecastDecision = decisions.find((decision) => {
    const action = parseAction(decision.action);
    return action.routine === "weekly_matchup" && typeof action.week === "number";
  });
  const forecast = forecastDecision
    ? scoreForecast(parseAction(forecastDecision.action), finalMatchup)
    : undefined;

  for (const decision of decisions) {
    const action = parseAction(decision.action);
    const routine = typeof action.routine === "string" ? action.routine : undefined;

    if (
      routine === "weekly_matchup" ||
      routine === "midweek_adjustment" ||
      routine === "daily_morning" ||
      routine === "retrospective"
    ) {
      continue;
    }

    const targetCategories = [
      ...new Set([
        ...toCategoryArray(action.targetCategories),
        ...extractHelpedCategories(decision.reasoning),
      ]),
    ];

    const { alignment, note } = inferAlignment(targetCategories, resultMap);
    scored.push({
      type: decision.type,
      routine,
      description: formatDescription(decision, action),
      targetCategories,
      alignment,
      note,
      winProbabilityDelta:
        typeof action.winProbabilityDelta === "number" ? action.winProbabilityDelta : undefined,
      expectedCategoryWinsDelta:
        typeof action.expectedCategoryWinsDelta === "number"
          ? action.expectedCategoryWinsDelta
          : undefined,
      timestamp: decision.timestamp ?? undefined,
    });
  }

  const alignedCount = scored.filter((item) => item.alignment === "aligned").length;
  const mixedCount = scored.filter((item) => item.alignment === "mixed").length;
  const missedCount = scored.filter((item) => item.alignment === "missed").length;
  const unscoredCount = scored.filter((item) => item.alignment === "unscored").length;

  const lessons: string[] = [];
  if (forecast?.calibration === "too_optimistic") {
    lessons.push("Weekly forecast was too optimistic relative to the final matchup.");
  } else if (forecast?.calibration === "too_pessimistic") {
    lessons.push("Weekly forecast was too pessimistic relative to the final matchup.");
  }
  if ((forecast?.categoryError ?? 0) >= 1.5) {
    lessons.push(
      `Expected category total missed by ${forecast?.categoryError?.toFixed(1)} cats.`,
    );
  }
  if (missedCount > alignedCount && missedCount > 0) {
    lessons.push("Too many recommendations targeted categories that still finished lost.");
  } else if (alignedCount >= 2 && missedCount === 0) {
    lessons.push("Recommendation targets matched the categories that held up by week end.");
  }

  const score = finalMatchup.categories.reduce(
    (acc, category) => {
      const result = resultMap.get(category.category);
      if (result === "won") acc.wins++;
      else if (result === "lost") acc.losses++;
      else acc.ties++;
      return acc;
    },
    { wins: 0, losses: 0, ties: 0 },
  );
  const outcome = score.wins > score.losses ? "WIN" : score.wins < score.losses ? "LOSS" : "TIE";

  return {
    week: finalMatchup.week,
    opponent: finalMatchup.opponentTeamName,
    finalScore: `${score.wins}-${score.losses}-${score.ties} ${outcome}`,
    forecast,
    recommendations: scored,
    alignedCount,
    mixedCount,
    missedCount,
    unscoredCount,
    lessons,
  };
}

export function formatRecommendationScorecardForTelegram(
  scorecard: RecommendationScorecard,
): string {
  const lines = [
    `<b>Week ${scorecard.week} Scorecard</b>`,
    `vs. ${scorecard.opponent}: ${scorecard.finalScore}`,
  ];

  if (scorecard.forecast) {
    const forecast = scorecard.forecast;
    const probability =
      forecast.winProbability != null
        ? `${Math.round(forecast.winProbability * 100)}%`
        : "n/a";
    const brier = forecast.brierScore != null ? forecast.brierScore.toFixed(3) : "n/a";
    const catError = forecast.categoryError != null ? forecast.categoryError.toFixed(1) : "n/a";
    lines.push(
      `Forecast: ${probability} win odds | Brier ${brier} | Cat error ${catError} | ${forecast.calibration.replaceAll("_", " ")}`,
    );
  }

  lines.push(
    `Recommendation alignment: ${scorecard.alignedCount} aligned, ${scorecard.mixedCount} mixed, ${scorecard.missedCount} missed, ${scorecard.unscoredCount} unscored`,
  );

  const aligned = scorecard.recommendations.filter((item) => item.alignment === "aligned");
  if (aligned.length > 0) {
    lines.push("");
    lines.push("Best aligned:");
    for (const item of aligned.slice(0, 3)) {
      lines.push(`  • ${item.description} — ${item.note}`);
    }
  }

  const misses = scorecard.recommendations.filter((item) => item.alignment === "missed");
  if (misses.length > 0) {
    lines.push("");
    lines.push("Misses:");
    for (const item of misses.slice(0, 2)) {
      lines.push(`  • ${item.description} — ${item.note}`);
    }
  }

  if (scorecard.lessons.length > 0) {
    lines.push("");
    lines.push("Lessons:");
    for (const lesson of scorecard.lessons) {
      lines.push(`  • ${lesson}`);
    }
  }

  return lines.join("\n");
}
