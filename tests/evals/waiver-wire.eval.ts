/**
 * Waiver Wire evals — compare prompt variants × models via OpenRouter.
 * Run: npx evalite run tests/evals/waiver-wire.eval.ts
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

// --- Prompt variants ---

interface PromptDef {
  id: string;
  system: string;
  userTemplate: string;
}

const prompts: PromptDef[] = [
  {
    id: "current",
    system: `You are a fantasy baseball waiver wire expert. Evaluate pickups considering category needs, Statcast trends, and role changes. Categories: ${CATEGORIES}.`,
    userTemplate:
      "WAIVER PRIORITY: #{{priority}}\n\nROSTER NEEDS:\n{{needs}}\n\nRECOMMENDATIONS:\n{{recs}}\n\nRank the top pickups, noting which categories each helps and whether the waiver priority is worth spending.",
  },
  {
    id: "decision-only",
    system: `Fantasy baseball waiver expert. Given recommendations from a stats engine, answer: should we execute these moves? Consider waiver priority cost. Categories: ${CATEGORIES}. Reply in 2-3 sentences max.`,
    userTemplate:
      "Priority: #{{priority}}\nNeeds: {{needs}}\nRecommendations:\n{{recs}}\n\nShould we pull the trigger? Why or why not?",
  },
  {
    id: "risk-reward",
    system: `Fantasy baseball waiver analyst. Frame each pickup as risk vs reward. Consider: floor/ceiling, role security, Statcast sustainability. Categories: ${CATEGORIES}. 2-4 sentences.`,
    userTemplate:
      "Priority: #{{priority}} | Needs: {{needs}}\n\n{{recs}}\n\nAssess risk vs reward for each move.",
  },
];

// Models to test
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

// Build variant matrix: model × prompt
const variants = modelIds.flatMap((modelId) =>
  prompts.map((prompt) => ({
    name: `${MODELS[modelId].label} / ${prompt.id}`,
    input: { modelId, prompt },
  })),
);

// --- Scenario data ---

interface WaiverInput {
  priority: number;
  needs: string;
  recs: string;
  keywords: string[];
  rejectKeywords?: string[];
}

function fill(template: string, data: WaiverInput): string {
  return template
    .replaceAll("{{priority}}", String(data.priority))
    .replaceAll("{{needs}}", data.needs)
    .replaceAll("{{recs}}", data.recs);
}

// --- Eval ---

evalite.each(variants)("Waiver Wire", {
  data: (): Array<{ input: WaiverInput; expected: string }> => [
    {
      input: {
        priority: 3,
        needs: "SB, R, OBP",
        recs: "Add Masyn Winn (SS, +2.1 z-score): elite sprint speed, xwOBA surge .370, only 40% owned. Drop Bohm (3B, lowest z-score on roster).",
        keywords: ["Winn", "SB"],
      },
      expected: "Recommend picking up Winn, explain SB/speed upside, worth priority #3",
    },
    {
      input: {
        priority: 2,
        needs: "OBP",
        recs: "Add Yandy Diaz (1B, +0.3 z-score): solid OBP .355 but no power. Drop Mountcastle (1B, slightly lower z). Marginal upgrade.",
        keywords: ["marginal", "priority"],
      },
      expected: "Advise against spending #2 priority on a marginal +0.3 upgrade",
    },
    {
      input: {
        priority: 1,
        needs: "SV+HLD, K",
        recs: "Add Ryan Helsley (RP, +3.5 z-score): named new closer for STL. 98mph fastball, 40% K-rate. Drop bench bat Bohm. Immediate SV+HLD boost.",
        keywords: ["Helsley", "closer"],
      },
      expected: "Strongly recommend using #1 priority for new closer Helsley",
    },
    {
      input: {
        priority: 4,
        needs: "SB, SV+HLD",
        recs: "No free agents found with positive z-score differential vs roster.",
        keywords: ["hold"],
        rejectKeywords: ["Winn", "Helsley", "Diaz"],
      },
      expected: "Acknowledge no pickups available, recommend holding",
    },
  ],

  task: async (input: WaiverInput, variant) => {
    const user = fill(variant.prompt.userTemplate, input);
    return callModel(variant.modelId, variant.prompt.system, user);
  },

  scorers: [
    containsKeywords as never,
    concise as never,
    noMarkdown as never,
    actionable as never,
    categoryAware as never,
    llmJudge(
      "Does this fantasy baseball waiver wire advice correctly assess the pickup value relative to waiver priority cost? Is it actionable and concise?",
    ) as never,
  ],
});
