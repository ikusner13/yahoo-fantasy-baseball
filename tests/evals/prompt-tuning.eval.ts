/**
 * Model-specific prompt tuning evals.
 *
 * Tests model-optimized prompts against the generic prompts
 * for each touchpoint's top contenders.
 *
 * Run: npx evalite run tests/evals/prompt-tuning.eval.ts
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
  noHallucination,
  llmJudge,
  type ModelId,
} from "./helpers";
import { createScorer } from "evalite";

const CATEGORIES = "R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD";

// --- Model-specific prompt styles ---

interface PromptDef {
  id: string;
  modelId: ModelId;
  system: string;
  template: string;
}

// LINEUP SUMMARY — top contenders: GPT-5.4 Mini (92%), Llama 3.3 (90%), Qwen 3.5 (89%)

const lineupPrompts: PromptDef[] = [
  // GPT-5.4 Mini — responds well to structured, prescriptive instructions
  {
    id: "gpt54m-structured",
    modelId: "gpt-5.4-mini",
    system:
      "Fantasy baseball lineup reporter. Output exactly 2 plain-text sentences: (1) who's starting and why, (2) who's benched and why. No markdown. No headers. No lists.",
    template:
      "Starters: {{starters}}\nBenched: {{benched}}\nGames: {{games}}\nStrategy: {{strategy}}",
  },
  {
    id: "gpt54m-fewshot",
    modelId: "gpt-5.4-mini",
    system: "Fantasy baseball lineup reporter. Plain text only, 2-3 sentences max.",
    template: `Example: "Soto and Ohtani anchor the lineup with 5 games on the slate. Bohm sits — no game today and lowest projection on the bench."

Now summarize:
Starters: {{starters}}
Benched: {{benched}}
Games: {{games}}
Strategy: {{strategy}}`,
  },
  // Llama 3.3 — needs explicit anti-verbosity, few-shot helps most
  {
    id: "llama-tight",
    modelId: "llama-3.3-70b",
    system:
      "You are a fantasy baseball lineup reporter. Be concise. No preamble. No summary. No markdown. No headers. No bullet points. Plain text, 2 sentences max.",
    template:
      "Starters: {{starters}}\nBenched: {{benched}}\nGames: {{games}}\nStrategy: {{strategy}}\n\nSummarize lineup decisions in 2 sentences.",
  },
  {
    id: "llama-fewshot",
    modelId: "llama-3.3-70b",
    system: "Fantasy baseball lineup reporter. Respond like the example. No preamble. No markdown.",
    template: `Example input: Starters: Judge → OF, Cole → SP. Benched: Rizzo (no game). Games: NYY@BOS. Strategy: Chase HR.
Example output: Judge and Cole lead the charge against Boston in a power-heavy matchup. Rizzo rides the bench with the Yankees off tomorrow.

Input: Starters: {{starters}}. Benched: {{benched}}. Games: {{games}}. Strategy: {{strategy}}
Output:`,
  },
  // Qwen 3.5 Flash — reported issues with system prompt adherence, try user-only
  {
    id: "qwen-useronly",
    modelId: "qwen-3.5-flash",
    system: "Respond in plain text. No markdown. 2-3 sentences max.",
    template:
      "Summarize this fantasy baseball lineup in 2-3 plain text sentences.\n\nStarters: {{starters}}\nBenched: {{benched}}\nGames: {{games}}\nStrategy: {{strategy}}",
  },
  {
    id: "qwen-directive",
    modelId: "qwen-3.5-flash",
    system:
      "RULES: (1) Plain text only (2) Max 2 sentences (3) Name key starters (4) Explain benchings",
    template:
      "Starters: {{starters}}\nBenched: {{benched}}\nGames: {{games}}\nStrategy: {{strategy}}",
  },
  // Baseline: generic prompt for comparison
  {
    id: "generic-current",
    modelId: "gpt-5.4-mini",
    system:
      "You are a concise fantasy baseball assistant. Summarize into 1-3 short sentences for Telegram. No markdown, plain text. Be direct and actionable.",
    template:
      "Stats engine set the lineup. Summarize the key decisions:\nSTARTERS: {{starters}}\nBENCHED: {{benched}}\nGAMES: {{games}}\n{{strategy}}",
  },
  {
    id: "generic-current",
    modelId: "llama-3.3-70b",
    system:
      "You are a concise fantasy baseball assistant. Summarize into 1-3 short sentences for Telegram. No markdown, plain text. Be direct and actionable.",
    template:
      "Stats engine set the lineup. Summarize the key decisions:\nSTARTERS: {{starters}}\nBENCHED: {{benched}}\nGAMES: {{games}}\n{{strategy}}",
  },
  {
    id: "generic-current",
    modelId: "qwen-3.5-flash",
    system:
      "You are a concise fantasy baseball assistant. Summarize into 1-3 short sentences for Telegram. No markdown, plain text. Be direct and actionable.",
    template:
      "Stats engine set the lineup. Summarize the key decisions:\nSTARTERS: {{starters}}\nBENCHED: {{benched}}\nGAMES: {{games}}\n{{strategy}}",
  },
];

const lineupVariants = lineupPrompts.map((p) => ({
  name: `${MODELS[p.modelId].label} / ${p.id}`,
  input: p,
}));

interface LineupInput {
  starters: string;
  benched: string;
  games: string;
  strategy: string;
  keywords: string[];
  rejectKeywords?: string[];
}

function fillLineup(template: string, d: LineupInput): string {
  return template
    .replaceAll("{{starters}}", d.starters)
    .replaceAll("{{benched}}", d.benched)
    .replaceAll("{{games}}", d.games)
    .replaceAll("{{strategy}}", d.strategy);
}

evalite.each(lineupVariants)("Lineup Prompt Tuning", {
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
    const user = fillLineup(variant.template, input);
    return callModel(variant.modelId, variant.system, user);
  },

  scorers: [
    containsKeywords as never,
    concise as never,
    noMarkdown as never,
    actionable as never,
    noHallucination as never,
    llmJudge(
      "Is this a clear, concise 1-3 sentence summary of fantasy baseball lineup decisions? Does it avoid markdown and stay under 300 characters?",
    ) as never,
  ],
});

// WAIVER WIRE — top contenders: Qwen 3.5 (83%), Llama 3.3 (82%), DeepSeek V3 (82%)

const waiverPrompts: PromptDef[] = [
  // DeepSeek V3 — tends to be verbose but analytical, constrain output
  {
    id: "deepseek-binary",
    modelId: "deepseek-v3",
    system: `Waiver wire analyst. H2H categories: ${CATEGORIES}. Answer YES or NO, then 1 sentence explaining why. Consider waiver priority cost.`,
    template:
      "Priority #{{priority}} | Needs: {{needs}}\nRecommendation: {{recs}}\n\nExecute this move?",
  },
  {
    id: "deepseek-analytical",
    modelId: "deepseek-v3",
    system: `Fantasy baseball analyst. Categories: ${CATEGORIES}. Evaluate the waiver move in 2-3 sentences. State which categories improve and whether the priority cost is justified.`,
    template: "Waiver priority: #{{priority}}\nNeeds: {{needs}}\nMove: {{recs}}",
  },
  // Qwen — try rules-based and user-only
  {
    id: "qwen-rules",
    modelId: "qwen-3.5-flash",
    system: `RULES: (1) 2-3 sentences max (2) Name categories helped (3) State if priority is worth spending (4) Plain text, no markdown. Categories: ${CATEGORIES}`,
    template: "Priority: #{{priority}} | Needs: {{needs}}\n{{recs}}",
  },
  {
    id: "qwen-direct",
    modelId: "qwen-3.5-flash",
    system: "Fantasy baseball waiver analyst. Plain text. 2-3 sentences.",
    template: `Evaluate this waiver move for a H2H categories league (${CATEGORIES}):
Priority: #{{priority}} | Needs: {{needs}}
Recommendation: {{recs}}
Should we execute? Which categories improve?`,
  },
  // Llama — few-shot + anti-verbosity
  {
    id: "llama-fewshot",
    modelId: "llama-3.3-70b",
    system: `Fantasy baseball waiver analyst. Be concise. No preamble. No markdown. Categories: ${CATEGORIES}.`,
    template: `Example: "Yes, grab Helsley. He fills your SV+HLD hole directly and the K-rate is elite. Priority #1 is worth it for a locked-in closer."

Priority: #{{priority}} | Needs: {{needs}}
Move: {{recs}}
Should we execute?`,
  },
  // Baselines
  {
    id: "generic-decision",
    modelId: "deepseek-v3",
    system: `Fantasy baseball waiver expert. Given recommendations from a stats engine, answer: should we execute these moves? Consider waiver priority cost. Categories: ${CATEGORIES}. Reply in 2-3 sentences max.`,
    template:
      "Priority: #{{priority}}\nNeeds: {{needs}}\nRecommendations:\n{{recs}}\n\nShould we pull the trigger? Why or why not?",
  },
  {
    id: "generic-decision",
    modelId: "qwen-3.5-flash",
    system: `Fantasy baseball waiver expert. Given recommendations from a stats engine, answer: should we execute these moves? Consider waiver priority cost. Categories: ${CATEGORIES}. Reply in 2-3 sentences max.`,
    template:
      "Priority: #{{priority}}\nNeeds: {{needs}}\nRecommendations:\n{{recs}}\n\nShould we pull the trigger? Why or why not?",
  },
  {
    id: "generic-decision",
    modelId: "llama-3.3-70b",
    system: `Fantasy baseball waiver expert. Given recommendations from a stats engine, answer: should we execute these moves? Consider waiver priority cost. Categories: ${CATEGORIES}. Reply in 2-3 sentences max.`,
    template:
      "Priority: #{{priority}}\nNeeds: {{needs}}\nRecommendations:\n{{recs}}\n\nShould we pull the trigger? Why or why not?",
  },
];

const waiverVariants = waiverPrompts.map((p) => ({
  name: `${MODELS[p.modelId].label} / ${p.id}`,
  input: p,
}));

interface WaiverInput {
  priority: number;
  needs: string;
  recs: string;
  keywords: string[];
  rejectKeywords?: string[];
}

function fillWaiver(template: string, d: WaiverInput): string {
  return template
    .replaceAll("{{priority}}", String(d.priority))
    .replaceAll("{{needs}}", d.needs)
    .replaceAll("{{recs}}", d.recs);
}

evalite.each(waiverVariants)("Waiver Prompt Tuning", {
  data: (): Array<{ input: WaiverInput; expected: string }> => [
    {
      input: {
        priority: 3,
        needs: "SB, R, OBP",
        recs: "Add Masyn Winn (SS, +2.1 z-score): elite sprint speed, xwOBA surge .370, only 40% owned. Drop Bohm (3B, lowest z-score on roster).",
        keywords: ["Winn", "SB"],
      },
      expected: "Recommend pickup, explain SB upside, worth priority #3",
    },
    {
      input: {
        priority: 2,
        needs: "OBP",
        recs: "Add Yandy Diaz (1B, +0.3 z-score): solid OBP .355 but no power. Drop Mountcastle. Marginal upgrade.",
        keywords: ["marginal", "priority"],
      },
      expected: "Advise against — marginal upgrade not worth high priority",
    },
    {
      input: {
        priority: 1,
        needs: "SV+HLD, K",
        recs: "Add Ryan Helsley (RP, +3.5 z-score): named new closer for STL. 98mph fastball, 40% K-rate. Drop bench bat Bohm.",
        keywords: ["Helsley", "closer"],
      },
      expected: "Strongly recommend — elite closer, worth #1 priority",
    },
    {
      input: {
        priority: 4,
        needs: "SB, SV+HLD",
        recs: "No free agents found with positive z-score differential vs roster.",
        keywords: ["hold"],
        rejectKeywords: ["Winn", "Helsley", "Diaz"],
      },
      expected: "Hold — nothing available, keep priority",
    },
  ],

  task: async (input: WaiverInput, variant) => {
    const user = fillWaiver(variant.template, input);
    return callModel(variant.modelId, variant.system, user);
  },

  scorers: [
    containsKeywords as never,
    concise as never,
    noMarkdown as never,
    actionable as never,
    categoryAware as never,
    llmJudge(
      "Does this correctly assess waiver pickup value vs priority cost? Is it actionable, concise (2-3 sentences), and in plain text?",
    ) as never,
  ],
});

// TRADE PROPOSAL — top contender: DeepSeek V3 (90%)

const tradePrompts: PromptDef[] = [
  {
    id: "deepseek-casual",
    modelId: "deepseek-v3",
    system: `You help draft fantasy baseball trade messages to send friends. Sound casual and natural. Name specific players. Categories: ${CATEGORIES}. Keep under 4 sentences.`,
    template:
      "My team: {{myRoster}}\nTheir team: {{targetRoster}}\nI need help in: {{needs}}\nI can offer: {{surplus}}\n\nDraft a trade offer + message.",
  },
  {
    id: "deepseek-structured",
    modelId: "deepseek-v3",
    system: `Fantasy trade analyst. Format: SEND: [players] | RECEIVE: [players] | MESSAGE: [casual 1-2 sentence pitch]. Categories: ${CATEGORIES}.`,
    template:
      "My roster: {{myRoster}}\nTarget roster: {{targetRoster}}\nNeeds: {{needs}}\nSurplus: {{surplus}}",
  },
  // GPT-4.1 Nano was #3 at 83% — try tuned prompts
  {
    id: "gpt41n-concise",
    modelId: "gpt-4.1-nano",
    system: `Draft a fantasy baseball trade. Output format: "Trade: [my player] for [their player]. Message: [casual 1-sentence pitch]." Categories: ${CATEGORIES}.`,
    template:
      "My roster: {{myRoster}}\nTheir roster: {{targetRoster}}\nI need: {{needs}}\nSurplus: {{surplus}}",
  },
  // Baselines
  {
    id: "generic-friend",
    modelId: "deepseek-v3",
    system: `You are a fantasy baseball trade negotiator. Craft a fair but favorable trade proposal. The message should sound natural, not robotic — you're sending this to a friend in a league. Categories: ${CATEGORIES}.`,
    template:
      "MY ROSTER:\n{{myRoster}}\n\nTARGET ROSTER:\n{{targetRoster}}\n\nMY CATEGORY NEEDS:\n{{needs}}\n\nMY SURPLUS PLAYERS:\n{{surplus}}\n\nPropose a trade and include a short message I can send.",
  },
];

const naturalTone = createScorer<unknown, string, unknown>({
  name: "Natural Tone",
  description: "Sounds like a text to a friend",
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
  description: "Under 600 chars",
  scorer: ({ output }) => {
    const len = output.length;
    if (len <= 600) return 1;
    return Math.max(0, 1 - (len - 600) / 600);
  },
});

const tradeVariants = tradePrompts.map((p) => ({
  name: `${MODELS[p.modelId].label} / ${p.id}`,
  input: p,
}));

interface TradeInput {
  myRoster: string;
  targetRoster: string;
  needs: string;
  surplus: string;
  keywords: string[];
}

function fillTrade(template: string, d: TradeInput): string {
  return template
    .replaceAll("{{myRoster}}", d.myRoster)
    .replaceAll("{{targetRoster}}", d.targetRoster)
    .replaceAll("{{needs}}", d.needs)
    .replaceAll("{{surplus}}", d.surplus);
}

evalite.each(tradeVariants)("Trade Prompt Tuning", {
  data: (): Array<{ input: TradeInput; expected: string }> => [
    {
      input: {
        myRoster:
          "Soto (OF), Betts (SS/OF), Ohtani (SP/Util), Freeman (1B), Mountcastle (1B/OF), Bohm (3B), Clase (RP), Diaz (RP)",
        targetRoster:
          "Trea Turner (SS), Vlad Jr (1B), Yordan (OF), Seager (SS), Altuve (2B), Olson (1B), Salvy (C)",
        needs: "SV+HLD, K",
        surplus: "HR: Mountcastle, Bohm; TB: Mountcastle",
        keywords: ["Mountcastle"],
      },
      expected: "Trade surplus bats for pitching help",
    },
    {
      input: {
        myRoster:
          "Soto (OF), Betts (SS/OF), Ohtani (SP/Util), Freeman (1B), Mountcastle (1B/OF), Bohm (3B)",
        targetRoster:
          "Judge (OF), Vlad Jr (1B), Corbin Carroll (OF), Altuve (2B), Olson (1B), Salvy (C)",
        needs: "SB, R",
        surplus:
          "HR: Mountcastle (hot — 8 HR last 2 weeks, xwOBA .310 suggesting regression); TB: Mountcastle",
        keywords: ["Mountcastle", "sell"],
      },
      expected: "Sell high on Mountcastle before regression",
    },
  ],

  task: async (input: TradeInput, variant) => {
    const user = fillTrade(variant.template, input);
    return callModel(variant.modelId, variant.system, user);
  },

  scorers: [
    containsKeywords as never,
    naturalTone as never,
    tradeConcise as never,
    actionable as never,
    categoryAware as never,
    llmJudge(
      "Is this trade proposal fair, actionable (names specific players to trade), and does the message sound natural enough to send a friend?",
    ) as never,
  ],
});
