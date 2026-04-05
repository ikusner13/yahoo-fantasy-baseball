/**
 * Injury Assessment evals — compare prompt variants × models via OpenRouter.
 */

import { evalite } from "evalite";
import {
  callModel,
  MODELS,
  containsKeywords,
  concise,
  noMarkdown,
  actionable,
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
    id: "full-assessment",
    system: `You are a fantasy baseball injury analyst. Assess the impact on fantasy value and recommend an action (hold, IL stash, drop, or replace). Categories: ${CATEGORIES}.`,
    template:
      "PLAYER: {{player}}\n\nINJURY INFO:\n{{injury}}\n\nROSTER CONTEXT:\n{{context}}\n\nAssess severity, expected timeline, and recommend an action.",
  },
  {
    id: "decision-tree",
    system: `Fantasy baseball injury analyst. Output a decision: HOLD, IL_STASH, DROP, or REPLACE. Then explain in 1-2 sentences. Categories: ${CATEGORIES}.`,
    template:
      "Player: {{player}}\nInjury: {{injury}}\nRoster: {{context}}\n\nDecision and reasoning:",
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

interface InjuryInput {
  player: string;
  injury: string;
  context: string;
  keywords: string[];
}

function fill(template: string, d: InjuryInput): string {
  return template
    .replaceAll("{{player}}", d.player)
    .replaceAll("{{injury}}", d.injury)
    .replaceAll("{{context}}", d.context);
}

evalite.each(variants)("Injury Assessment", {
  data: (): Array<{ input: InjuryInput; expected: string }> => [
    {
      input: {
        player: "Ronald Acuna Jr.",
        injury:
          "Day-to-day with right knee soreness. Left game in 5th inning. MRI scheduled tomorrow.",
        context:
          "4 OF on roster (Soto, Tucker, Acuna, Mountcastle OF-eligible). 1 IL slot open. Acuna is top-5 z-score on team.",
        keywords: ["hold", "IL", "MRI"],
      },
      expected: "Hold Acuna, move to IL if MRI shows anything, he's too valuable to drop",
    },
    {
      input: {
        player: "Edwin Diaz",
        injury:
          "Not injured. Lost closer role to Reed Garrett after 3 blown saves. Manager confirmed role change.",
        context:
          "Have 2 RP: Diaz and Clase. Helsley available on waivers. SV+HLD is a need. Diaz z-score dropped from +1.8 to -0.3.",
        keywords: ["drop", "Helsley"],
      },
      expected: "Drop Diaz, pick up Helsley as new closer",
    },
    {
      input: {
        player: "Gerrit Cole",
        injury: "UCL tear confirmed. Season over. Tommy John surgery scheduled.",
        context:
          "Cole was #1 pitcher (z-score +4.2). Have Cease and Fried as other SP. Crochet available as FA.",
        keywords: ["drop", "replace", "Crochet"],
      },
      expected: "Drop Cole, devastating loss, grab best available SP immediately",
    },
    {
      input: {
        player: "Alec Bohm",
        injury: "10-day IL, hand contusion. Expected 2 weeks.",
        context:
          "Bohm is lowest z-score on roster (-0.4). 1 IL slot open. Bregman available at 3B (55% owned).",
        keywords: ["IL", "stash"],
      },
      expected: "IL stash Bohm (short timeline), consider Bregman as temp replacement",
    },
  ],

  task: async (input: InjuryInput, variant) => {
    const user = fill(variant.prompt.template, input);
    return callModel(variant.modelId, variant.prompt.system, user);
  },

  scorers: [
    containsKeywords as never,
    concise as never,
    noMarkdown as never,
    actionable as never,
    llmJudge(
      "Does this injury assessment correctly evaluate severity, give a clear actionable recommendation (hold/IL/drop/replace), and consider the roster context?",
    ) as never,
  ],
});
