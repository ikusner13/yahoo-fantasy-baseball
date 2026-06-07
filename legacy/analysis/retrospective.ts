import type { Matchup } from "../types";
import type { DetailedCategoryState, CategoryState } from "./matchup";

// --- Interfaces ---

export interface WeeklyRetrospective {
  week: number;
  opponent: string;
  finalScore: string; // "7-5-1 WIN" or "4-8-1 LOSS"
  predictions: CategoryPrediction[];
  decisions: DecisionOutcome[];
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
  weekDecisions?: Array<{ type: string; action: string; reasoning?: string }>,
): WeeklyRetrospective {
  const predictions: CategoryPrediction[] = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;

  // Build prediction map for lookup
  const predMap = new Map<string, DetailedCategoryState>();
  if (weekStartPredictions) {
    for (const p of weekStartPredictions) predMap.set(p.category, p);
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

  // Build decisions from audit log
  const decisions: DecisionOutcome[] = (weekDecisions ?? []).map((d) => {
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(d.action) as Record<string, unknown>;
    } catch {
      // ignore
    }
    return {
      type: d.type,
      description: d.reasoning ?? (parsed.routine as string) ?? d.type,
      outcome: "unknown" as const,
    };
  });

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

  const outcome = wins > losses ? "WIN" : wins < losses ? "LOSS" : "TIE";
  const finalScore = `${wins}-${losses}-${ties} ${outcome}`;

  return {
    week: finalMatchup.week,
    opponent: finalMatchup.opponentTeamName,
    finalScore,
    predictions,
    decisions,
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
      lines.push(`  \u2022 ${d.description}: ${label}`);
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
