/**
 * Trade Proposal evals — compare prompt variants × models via OpenRouter.
 */

import { evalite } from "evalite";
import { createScorer } from "evalite";
import {
  callModel,
  MODELS,
  containsKeywords,
  actionable,
  categoryAware,
  llmJudge,
  type ModelId,
} from "./helpers";

const CATEGORIES = "R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD";

const naturalTone = createScorer<unknown, string, unknown>({
  name: "Natural Tone",
  description: "Sounds like a text to a friend, not corporate or robotic",
  scorer: ({ output }) => {
    const roboticPhrases = [
      "i propose",
      "pursuant to",
      "therefore",
      "in conclusion",
      "i would like to suggest",
      "it is recommended",
      "hereby",
    ];
    const lower = output.toLowerCase();
    const found = roboticPhrases.filter((p) => lower.includes(p));
    return found.length === 0 ? 1 : Math.max(0, 1 - found.length * 0.25);
  },
});

const tradeConcise = createScorer<unknown, string, unknown>({
  name: "Trade Concise",
  description: "Under 800 chars for a trade pitch",
  scorer: ({ output }) => {
    const len = output.length;
    if (len <= 800) return 1;
    return Math.max(0, 1 - (len - 800) / 800);
  },
});

interface PromptDef {
  id: string;
  system: string;
  template: string;
}

const prompts: PromptDef[] = [
  {
    id: "friend-msg",
    system: `You are a fantasy baseball trade negotiator. Craft a fair but favorable trade proposal. The message should sound natural, not robotic — you're sending this to a friend in a league. Categories: ${CATEGORIES}.`,
    template:
      "MY ROSTER:\n{{myRoster}}\n\nTARGET ROSTER:\n{{targetRoster}}\n\nMY CATEGORY NEEDS:\n{{needs}}\n\nMY SURPLUS PLAYERS:\n{{surplus}}\n\nPropose a trade and include a short message I can send.",
  },
  {
    id: "analytical",
    system: `Fantasy baseball trade analyst. Propose trades backed by category analysis. For each trade, explain what each side gains/loses. Categories: ${CATEGORIES}. Be concise.`,
    template:
      "My team: {{myRoster}}\nTheir team: {{targetRoster}}\nI need: {{needs}}\nMy surplus: {{surplus}}\n\nPropose 1-2 trades with category impact.",
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

interface TradeInput {
  myRoster: string;
  targetRoster: string;
  needs: string;
  surplus: string;
  keywords: string[];
}

function fill(template: string, d: TradeInput): string {
  return template
    .replaceAll("{{myRoster}}", d.myRoster)
    .replaceAll("{{targetRoster}}", d.targetRoster)
    .replaceAll("{{needs}}", d.needs)
    .replaceAll("{{surplus}}", d.surplus);
}

evalite.each(variants)("Trade Proposal", {
  data: (): Array<{ input: TradeInput; expected: string }> => [
    {
      input: {
        myRoster:
          "Soto (OF), Betts (SS/OF), Ohtani (SP/Util), Freeman (1B), Witt (SS/3B), Tucker (OF), Acuna (OF), Mountcastle (1B/OF), Bohm (3B), Clase (RP), Diaz (RP)",
        targetRoster:
          "Trea Turner (SS), Vlad Jr (1B), Yordan (OF), Seager (SS), Altuve (2B), Olson (1B), Castellanos (OF), Mullins (OF), Salvy (C)",
        needs: "SV+HLD, K",
        surplus: "HR: Mountcastle, Bohm; TB: Mountcastle",
        keywords: ["Mountcastle", "fair"],
      },
      expected: "Propose trading surplus bats for pitching help",
    },
    {
      input: {
        myRoster:
          "Soto (OF), Betts (SS/OF), Ohtani (SP/Util), Freeman (1B), Witt (SS/3B), Tucker (OF), Acuna (OF), Mountcastle (1B/OF), Bohm (3B)",
        targetRoster:
          "Judge (OF), Vlad Jr (1B), Yordan (OF), Corbin Carroll (OF), Altuve (2B), Olson (1B), Mullins (OF), Salvy (C)",
        needs: "SB, R",
        surplus:
          "HR: Mountcastle (hot — 8 HR last 2 weeks, xwOBA .310 suggesting regression); TB: Mountcastle",
        keywords: ["Mountcastle", "sell"],
      },
      expected: "Sell high on Mountcastle's hot streak before regression",
    },
  ],

  task: async (input: TradeInput, variant) => {
    const user = fill(variant.prompt.template, input);
    return callModel(variant.modelId, variant.prompt.system, user);
  },

  scorers: [
    containsKeywords as never,
    naturalTone as never,
    tradeConcise as never,
    actionable as never,
    categoryAware as never,
    llmJudge(
      "Is this fantasy baseball trade proposal fair (not lopsided), actionable (names specific players), and does the message sound natural enough to send to a friend?",
    ) as never,
  ],
});
