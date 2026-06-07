/**
 * Lineup Summary evals — compare prompt variants × models via OpenRouter.
 */

import { evalite } from "evalite";
import {
  callModel,
  MODELS,
  containsKeywords,
  concise,
  noMarkdown,
  actionable,
  noHallucination,
  llmJudge,
  type ModelId,
} from "./helpers";

interface PromptDef {
  id: string;
  system: string;
  template: string;
}

const prompts: PromptDef[] = [
  {
    id: "current",
    system:
      "You are a concise fantasy baseball assistant. Summarize into 1-3 short sentences for Telegram. No markdown, plain text. Be direct and actionable.",
    template:
      "Stats engine set the lineup. Summarize the key decisions:\nSTARTERS: {{starters}}\nBENCHED: {{benched}}\nGAMES: {{games}}\n{{strategy}}",
  },
  {
    id: "minimal",
    system: "Summarize this fantasy baseball lineup in ONE sentence. Plain text. No fluff.",
    template:
      "Started: {{starters}}. Benched: {{benched}}. Games: {{games}}. Strategy: {{strategy}}",
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

interface LineupInput {
  starters: string;
  benched: string;
  games: string;
  strategy: string;
  keywords: string[];
  rejectKeywords?: string[];
}

function fill(template: string, d: LineupInput): string {
  return template
    .replaceAll("{{starters}}", d.starters)
    .replaceAll("{{benched}}", d.benched)
    .replaceAll("{{games}}", d.games)
    .replaceAll("{{strategy}}", d.strategy);
}

evalite.each(variants)("Lineup Summary", {
  data: (): Array<{ input: LineupInput; expected: string }> => [
    {
      input: {
        starters:
          "Soto → OF, Betts → SS, Ohtani → Util, Freeman → 1B, Witt → 3B, Turner → 2B, Realmuto → C, Acuna → OF, Tucker → OF",
        benched: "Mountcastle, Bohm",
        games: "NYY@BOS, LAD@SF, KC@CLE, PHI@ATL, HOU@SEA",
        strategy: "Balanced approach — winning 7 cats, swing in HR and SB",
        keywords: ["Soto", "Ohtani"],
        rejectKeywords: ["Trout", "Judge"],
      },
      expected: "Standard day summary mentioning key starters",
    },
    {
      input: {
        starters: "Betts → SS, Freeman → 1B, Tucker → OF",
        benched: "Soto, Ohtani, Acuna, Witt, Turner (no game)",
        games: "LAD@SF, HOU@SEA",
        strategy: "Only 2 games with our players. Protect ratios.",
        keywords: ["off"],
      },
      expected: "Note the off-day situation and limited lineup",
    },
    {
      input: {
        starters:
          "Betts → SS, Freeman → 1B, Mountcastle → Util (replacing Ohtani), Tucker → OF, Acuna → OF, Witt → 3B",
        benched: "Ohtani (DTD — back tightness)",
        games: "LAD@SF, KC@CLE, PHI@ATL, HOU@SEA",
        strategy: "Lost Ohtani. Chase counting stats to compensate.",
        keywords: ["Ohtani", "Mountcastle"],
      },
      expected: "Explain Ohtani injury and Mountcastle stepping in",
    },
  ],

  task: async (input: LineupInput, variant) => {
    const user = fill(variant.prompt.template, input);
    return callModel(variant.modelId, variant.prompt.system, user);
  },

  scorers: [
    containsKeywords as never,
    concise as never,
    noMarkdown as never,
    actionable as never,
    noHallucination as never,
    llmJudge(
      "Is this a clear, concise summary of fantasy baseball lineup decisions suitable for a Telegram message?",
    ) as never,
  ],
});
