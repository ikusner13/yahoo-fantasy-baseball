/**
 * Matchup Strategy evals — compare prompt variants × models via OpenRouter.
 */

import { evalite } from "evalite";
import {
  callModel,
  MODELS,
  containsKeywords,
  concise,
  noMarkdown,
  actionable,
  categoryAware,
  llmJudge,
  type ModelId,
} from "./helpers";

const CATEGORIES = "R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD";

interface PromptDef {
  id: string;
  system: string;
  template: string;
}

const prompts: PromptDef[] = [
  {
    id: "current",
    system: `You are a fantasy baseball strategist specializing in H2H categories. Given the current matchup state, recommend tactical adjustments. Categories: ${CATEGORIES}.`,
    template:
      "DAYS REMAINING: {{days}}\n\nCURRENT SCORES:\n{{scores}}\n\nANALYSIS:\n{{analysis}}\n\nRecommend which categories to target or punt and any roster moves to optimize the week.",
  },
  {
    id: "priorities",
    system: `H2H fantasy baseball strategist. Categories: ${CATEGORIES}. Give exactly 3 prioritized actions, numbered. Each action must name specific categories. Plain text, no markdown.`,
    template:
      "{{days}} days left.\nScores: {{scores}}\nAnalysis: {{analysis}}\n\nTop 3 priorities:",
  },
];

const modelIds: ModelId[] = [
  "mistral-small-3.1",
  "gpt-5-nano",
  "qwen-3.5-flash",
  "gpt-4.1-nano",
  "llama-3.3-70b",
  "deepseek-v3",
  "gpt-5.4-nano",
  "gemini-2.5-flash",
  "gpt-5.4-mini",
  "haiku-4.5",
  "sonnet-4.6",
];

const variants = modelIds.flatMap((modelId) =>
  prompts.map((prompt) => ({
    name: `${MODELS[modelId].label} / ${prompt.id}`,
    input: { modelId, prompt },
  })),
);

interface MatchupInput {
  days: number;
  scores: string;
  analysis: string;
  keywords: string[];
}

function fill(template: string, d: MatchupInput): string {
  return template
    .replaceAll("{{days}}", String(d.days))
    .replaceAll("{{scores}}", d.scores)
    .replaceAll("{{analysis}}", d.analysis);
}

evalite.each(variants)("Matchup Strategy", {
  data: (): Array<{ input: MatchupInput; expected: string }> => [
    {
      input: {
        days: 3,
        scores:
          "R: 45 vs 32, H: 78 vs 55, HR: 12 vs 6, RBI: 42 vs 28, SB: 2 vs 9, TB: 130 vs 90, OBP: .285 vs .270, OUT: 210 vs 195, K: 72 vs 60, ERA: 2.85 vs 3.40, WHIP: 1.05 vs 1.20, QS: 5 vs 3, SVHD: 4 vs 5",
        analysis: "Winning 9-4. Protect ERA/WHIP lead. SB is lost. SVHD is swing.",
        keywords: ["protect", "ERA", "WHIP"],
      },
      expected: "Protect ratio leads, don't stream risky arms",
    },
    {
      input: {
        days: 4,
        scores:
          "R: 20 vs 48, H: 40 vs 82, HR: 3 vs 14, RBI: 18 vs 50, SB: 1 vs 8, TB: 60 vs 140, OBP: .230 vs .290, OUT: 150 vs 200, K: 40 vs 75, ERA: 2.50 vs 3.80, WHIP: 1.30 vs 1.15, QS: 2 vs 5, SVHD: 2 vs 6",
        analysis: "Losing 1-12. Only winning ERA. Need aggressive streaming.",
        keywords: ["stream", "aggressive"],
      },
      expected: "Go aggressive, stream pitchers, chase counting stats",
    },
    {
      input: {
        days: 2,
        scores:
          "R: 38 vs 36, H: 65 vs 63, HR: 10 vs 7, RBI: 35 vs 33, SB: 5 vs 6, TB: 110 vs 100, OBP: .275 vs .272, ERA: 3.10 vs 3.15, WHIP: 1.12 vs 1.14, K: 62 vs 60, QS: 4 vs 4, SVHD: 5 vs 5",
        analysis: "Every category within striking distance. No clear leads.",
        keywords: ["close", "swing"],
      },
      expected: "Every decision matters, maximize every edge",
    },
  ],

  task: async (input: MatchupInput, variant) => {
    const user = fill(variant.prompt.template, input);
    return callModel(variant.modelId, variant.prompt.system, user);
  },

  scorers: [
    containsKeywords as never,
    concise as never,
    noMarkdown as never,
    actionable as never,
    categoryAware as never,
    llmJudge(
      "Does this H2H category matchup strategy correctly assess which categories to protect vs chase, given the current scores and days remaining?",
    ) as never,
  ],
});
