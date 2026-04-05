/**
 * Prompt tuning v2 — model-specific optimizations based on research.
 *
 * Targets weaknesses found in v1:
 * - DeepSeek: suppress markdown/verbosity (scored 87% but verbose)
 * - Qwen: ensure system prompt present, rules-based (scored 99% on lineup, tune waivers)
 * - GPT-5.4 Mini: front-load constraints, no contradictions (scored 92% lineup, tune others)
 * - Llama: anti-preamble, max_tokens cap implicit via prompt (scored 99% lineup, tune waivers)
 *
 * Run: npx evalite run tests/evals/prompt-tuning-v2.eval.ts
 */

import { evalite } from "evalite";
import { createScorer } from "evalite";
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

const CATS = "R, H, HR, RBI, SB, TB, OBP | Outs, K, ERA, WHIP, QS, SV+HLD";

interface PromptDef {
  id: string;
  modelId: ModelId;
  system: string;
  template: string;
}

// ============================================================
// WAIVER WIRE — DeepSeek won (87%) but with markdown. Can we push higher?
// ============================================================

const waiverPrompts: PromptDef[] = [
  // DeepSeek: explicit anti-markdown, anti-eagerness, low verbosity
  {
    id: "ds-constrained",
    modelId: "deepseek-v3",
    system: `Waiver analyst. H2H cats: ${CATS}. RULES: plain text only. No markdown. No headers. No bullets. No explanations beyond what's asked. 2-3 sentences max.`,
    template:
      "Priority #{{priority}} | Needs: {{needs}}\nMove: {{recs}}\nShould we execute? Name categories helped.",
  },
  {
    id: "ds-structured",
    modelId: "deepseek-v3",
    system: [
      `<role>Fantasy baseball waiver analyst</role>`,
      `<categories>${CATS}</categories>`,
      `<constraints>`,
      `- Plain text only, no markdown formatting`,
      `- 2-3 sentences maximum`,
      `- State: execute or hold`,
      `- Name which categories improve`,
      `- Address waiver priority cost`,
      `</constraints>`,
    ].join("\n"),
    template: "Priority: #{{priority}} | Needs: {{needs}}\n{{recs}}",
  },
  // Qwen: rules-based won on lineup (99%), apply same pattern to waivers
  {
    id: "qwen-rules-v2",
    modelId: "qwen-3.5-flash",
    system: `RULES: (1) 2-3 sentences only (2) Plain text, no markdown (3) Start with YES or NO (4) Name categories that improve (5) Address priority cost. Categories: ${CATS}`,
    template: "Waiver priority #{{priority}} | Needs: {{needs}}\nRecommendation: {{recs}}",
  },
  // GPT-5.4 Mini: front-load constraints (research says critical rules must come first)
  {
    id: "gpt54m-frontload",
    modelId: "gpt-5.4-mini",
    system: `RESPOND IN 2-3 PLAIN TEXT SENTENCES. NO MARKDOWN. You are a fantasy baseball waiver analyst. Categories: ${CATS}. Evaluate whether the move is worth the waiver priority cost.`,
    template:
      "Priority: #{{priority}}\nNeeds: {{needs}}\nRecommendation: {{recs}}\n\nExecute or hold?",
  },
  // Llama: anti-preamble + concise directive
  {
    id: "llama-nopreamble",
    modelId: "llama-3.3-70b",
    system: `Fantasy baseball waiver analyst. Categories: ${CATS}. Be concise. No preamble. No summary. No markdown. No bullet points. Answer in 2-3 plain text sentences.`,
    template: "Priority: #{{priority}} | Needs: {{needs}}\nMove: {{recs}}\nShould we execute?",
  },
  // Baselines (best from v1)
  {
    id: "baseline-decision",
    modelId: "deepseek-v3",
    system: `Fantasy baseball waiver expert. Given recommendations from a stats engine, answer: should we execute these moves? Consider waiver priority cost. Categories: ${CATS}. Reply in 2-3 sentences max.`,
    template:
      "Priority: #{{priority}}\nNeeds: {{needs}}\nRecommendations:\n{{recs}}\n\nShould we pull the trigger? Why or why not?",
  },
  {
    id: "baseline-decision",
    modelId: "qwen-3.5-flash",
    system: `Fantasy baseball waiver expert. Given recommendations from a stats engine, answer: should we execute these moves? Consider waiver priority cost. Categories: ${CATS}. Reply in 2-3 sentences max.`,
    template:
      "Priority: #{{priority}}\nNeeds: {{needs}}\nRecommendations:\n{{recs}}\n\nShould we pull the trigger? Why or why not?",
  },
];

// ============================================================
// MATCHUP STRATEGY — Sonnet won (85%), can cheaper models match?
// ============================================================

const matchupPrompts: PromptDef[] = [
  // DeepSeek: XML structure (research says it responds well to XML delimiters)
  {
    id: "ds-xml",
    modelId: "deepseek-v3",
    system: [
      `<role>H2H fantasy baseball strategist</role>`,
      `<categories>${CATS}</categories>`,
      `<output_rules>`,
      `- Plain text, no markdown`,
      `- Exactly 3 numbered priorities`,
      `- Each priority must name specific categories`,
      `- No preamble or summary`,
      `</output_rules>`,
    ].join("\n"),
    template:
      "{{days}} days left | Scores: {{scores}}\nAnalysis: {{analysis}}\n\nTop 3 priorities:",
  },
  // GPT-5.4 Mini: front-loaded format constraint
  {
    id: "gpt54m-priorities",
    modelId: "gpt-5.4-mini",
    system: `OUTPUT EXACTLY 3 NUMBERED PRIORITIES IN PLAIN TEXT. NO MARKDOWN. You are a H2H fantasy baseball strategist. Categories: ${CATS}. Each priority must name specific categories to target or protect.`,
    template: "{{days}} days left.\nScores: {{scores}}\nAnalysis: {{analysis}}",
  },
  // Llama: concise with anti-verbosity
  {
    id: "llama-priorities",
    modelId: "llama-3.3-70b",
    system: `H2H fantasy baseball strategist. Categories: ${CATS}. Give exactly 3 prioritized actions, numbered. Each action must name specific categories. No preamble. No summary. No markdown. Plain text only.`,
    template:
      "{{days}} days left.\nScores: {{scores}}\nAnalysis: {{analysis}}\n\nTop 3 priorities:",
  },
  // Qwen: rules-based
  {
    id: "qwen-priorities",
    modelId: "qwen-3.5-flash",
    system: `RULES: (1) Output exactly 3 numbered priorities (2) Each must name specific categories (3) Plain text only (4) No markdown, headers, or bullets beyond the numbers. H2H league categories: ${CATS}`,
    template: "{{days}} days left | Scores: {{scores}} | Analysis: {{analysis}}",
  },
];

// ============================================================
// INJURY ASSESSMENT — Haiku won (84%), can cheaper models compete?
// ============================================================

const injuryPrompts: PromptDef[] = [
  // DeepSeek: structured assessment
  {
    id: "ds-injury",
    modelId: "deepseek-v3",
    system: [
      `<role>Fantasy baseball injury analyst</role>`,
      `<categories>${CATS}</categories>`,
      `<output_rules>`,
      `- Start with decision: HOLD, IL_STASH, DROP, or REPLACE`,
      `- Then 1-2 sentences explaining why`,
      `- Plain text, no markdown`,
      `</output_rules>`,
    ].join("\n"),
    template: "Player: {{player}}\nInjury: {{injury}}\nRoster: {{context}}",
  },
  // GPT-5.4 Mini
  {
    id: "gpt54m-injury",
    modelId: "gpt-5.4-mini",
    system: `START WITH ONE WORD: HOLD, IL_STASH, DROP, or REPLACE. THEN 1-2 SENTENCES WHY. NO MARKDOWN. Fantasy baseball injury analyst. Categories: ${CATS}.`,
    template: "Player: {{player}}\nInjury: {{injury}}\nRoster context: {{context}}",
  },
  // Llama
  {
    id: "llama-injury",
    modelId: "llama-3.3-70b",
    system: `Fantasy baseball injury analyst. Output a decision: HOLD, IL_STASH, DROP, or REPLACE. Then explain in 1-2 sentences. No preamble. No markdown. Plain text only. Categories: ${CATS}.`,
    template: "Player: {{player}}\nInjury: {{injury}}\nRoster: {{context}}\n\nDecision:",
  },
  // Qwen
  {
    id: "qwen-injury",
    modelId: "qwen-3.5-flash",
    system: `RULES: (1) First word must be HOLD, IL_STASH, DROP, or REPLACE (2) Then 1-2 sentences explaining (3) Plain text only (4) No markdown. Categories: ${CATS}`,
    template: "Player: {{player}} | Injury: {{injury}} | Roster: {{context}}",
  },
];

// ============================================================
// Build variant arrays
// ============================================================

const waiverVariants = waiverPrompts.map((p) => ({
  name: `${MODELS[p.modelId].label} / ${p.id}`,
  input: p,
}));

const matchupVariants = matchupPrompts.map((p) => ({
  name: `${MODELS[p.modelId].label} / ${p.id}`,
  input: p,
}));

const injuryVariants = injuryPrompts.map((p) => ({
  name: `${MODELS[p.modelId].label} / ${p.id}`,
  input: p,
}));

// ============================================================
// Shared scorers
// ============================================================

const ultraConcise = createScorer<unknown, string, unknown>({
  name: "Ultra Concise",
  description: "Under 400 chars",
  scorer: ({ output }) => {
    const len = output.length;
    if (len <= 400) return 1;
    return Math.max(0, 1 - (len - 400) / 400);
  },
});

// ============================================================
// Waiver eval
// ============================================================

interface WaiverInput {
  priority: number;
  needs: string;
  recs: string;
  keywords: string[];
  rejectKeywords?: string[];
}

function fillW(t: string, d: WaiverInput): string {
  return t
    .replaceAll("{{priority}}", String(d.priority))
    .replaceAll("{{needs}}", d.needs)
    .replaceAll("{{recs}}", d.recs);
}

evalite.each(waiverVariants)("Waiver v2", {
  data: (): Array<{ input: WaiverInput; expected: string }> => [
    {
      input: {
        priority: 3,
        needs: "SB, R, OBP",
        recs: "Add Masyn Winn (SS, +2.1 z-score): elite sprint speed, xwOBA surge .370, only 40% owned. Drop Bohm.",
        keywords: ["Winn", "SB"],
      },
      expected: "Recommend pickup for SB upside",
    },
    {
      input: {
        priority: 2,
        needs: "OBP",
        recs: "Add Yandy Diaz (1B, +0.3 z-score): solid OBP .355 but no power. Drop Mountcastle. Marginal upgrade.",
        keywords: ["marginal", "priority"],
      },
      expected: "Advise against — not worth high priority",
    },
    {
      input: {
        priority: 1,
        needs: "SV+HLD, K",
        recs: "Add Ryan Helsley (RP, +3.5 z-score): named new closer for STL. 98mph fastball, 40% K-rate. Drop Bohm.",
        keywords: ["Helsley", "closer"],
      },
      expected: "Strongly recommend — elite closer worth #1",
    },
    {
      input: {
        priority: 4,
        needs: "SB, SV+HLD",
        recs: "No free agents found with positive z-score differential vs roster.",
        keywords: ["hold"],
        rejectKeywords: ["Winn", "Helsley", "Diaz"],
      },
      expected: "Hold — nothing worth picking up",
    },
  ],
  task: async (input: WaiverInput, variant) => {
    const user = fillW(variant.template, input);
    return callModel(variant.modelId, variant.system, user);
  },
  scorers: [
    containsKeywords as never,
    ultraConcise as never,
    noMarkdown as never,
    actionable as never,
    categoryAware as never,
    llmJudge("Correct waiver assessment? Concise plain text? Categories named?") as never,
  ],
});

// ============================================================
// Matchup eval
// ============================================================

interface MatchupInput {
  days: number;
  scores: string;
  analysis: string;
  keywords: string[];
}

function fillM(t: string, d: MatchupInput): string {
  return t
    .replaceAll("{{days}}", String(d.days))
    .replaceAll("{{scores}}", d.scores)
    .replaceAll("{{analysis}}", d.analysis);
}

evalite.each(matchupVariants)("Matchup v2", {
  data: (): Array<{ input: MatchupInput; expected: string }> => [
    {
      input: {
        days: 3,
        scores:
          "R: 45 vs 32, H: 78 vs 55, HR: 12 vs 6, RBI: 42 vs 28, SB: 2 vs 9, TB: 130 vs 90, OBP: .285 vs .270, ERA: 2.85 vs 3.40, WHIP: 1.05 vs 1.20, K: 72 vs 60, QS: 5 vs 3, SVHLD: 4 vs 5",
        analysis: "Winning 9-4. Protect ERA/WHIP lead. SB is lost. SVHD is swing.",
        keywords: ["protect", "ERA"],
      },
      expected: "Protect ratios, don't risk ERA/WHIP",
    },
    {
      input: {
        days: 4,
        scores:
          "R: 20 vs 48, H: 40 vs 82, HR: 3 vs 14, RBI: 18 vs 50, SB: 1 vs 8, ERA: 2.50 vs 3.80, WHIP: 1.30 vs 1.15, K: 40 vs 75, QS: 2 vs 5, SVHLD: 2 vs 6",
        analysis: "Losing 1-12. Only winning ERA. Need aggressive streaming.",
        keywords: ["stream", "aggressive"],
      },
      expected: "Go aggressive, stream pitchers",
    },
  ],
  task: async (input: MatchupInput, variant) => {
    const user = fillM(variant.template, input);
    return callModel(variant.modelId, variant.system, user);
  },
  scorers: [
    containsKeywords as never,
    ultraConcise as never,
    noMarkdown as never,
    actionable as never,
    categoryAware as never,
    llmJudge("Correct H2H strategy? Names specific categories? 3 numbered priorities?") as never,
  ],
});

// ============================================================
// Injury eval
// ============================================================

interface InjuryInput {
  player: string;
  injury: string;
  context: string;
  keywords: string[];
}

function fillI(t: string, d: InjuryInput): string {
  return t
    .replaceAll("{{player}}", d.player)
    .replaceAll("{{injury}}", d.injury)
    .replaceAll("{{context}}", d.context);
}

evalite.each(injuryVariants)("Injury v2", {
  data: (): Array<{ input: InjuryInput; expected: string }> => [
    {
      input: {
        player: "Ronald Acuna Jr.",
        injury: "Day-to-day with right knee soreness. MRI scheduled tomorrow.",
        context: "4 OF on roster. 1 IL slot open. Acuna is top-5 z-score.",
        keywords: ["hold", "IL"],
      },
      expected: "Hold, move to IL if needed",
    },
    {
      input: {
        player: "Gerrit Cole",
        injury: "UCL tear. Season over. Tommy John scheduled.",
        context: "Cole was #1 pitcher (z-score +4.2). Crochet available as FA.",
        keywords: ["drop", "Crochet"],
      },
      expected: "Drop, grab replacement immediately",
    },
    {
      input: {
        player: "Edwin Diaz",
        injury: "Not injured. Lost closer role after 3 blown saves.",
        context: "Have 2 RP: Diaz and Clase. Helsley available on waivers. SV+HLD is a need.",
        keywords: ["drop", "Helsley"],
      },
      expected: "Drop for Helsley",
    },
  ],
  task: async (input: InjuryInput, variant) => {
    const user = fillI(variant.template, input);
    return callModel(variant.modelId, variant.system, user);
  },
  scorers: [
    containsKeywords as never,
    ultraConcise as never,
    noMarkdown as never,
    actionable as never,
    llmJudge(
      "Does it start with a clear decision (HOLD/DROP/IL_STASH/REPLACE)? Is the reasoning sound given the injury and roster context?",
    ) as never,
  ],
});
