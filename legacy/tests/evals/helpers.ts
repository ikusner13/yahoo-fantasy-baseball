/**
 * Shared helpers for evalite evals.
 * Uses OpenRouter API when OPENROUTER_API_KEY is set, falls back to `claude -p`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createScorer } from "evalite";
import { config } from "dotenv";

config(); // load .env

const execFileAsync = promisify(execFile);

// --- Model registry ---

export interface ModelDef {
  id: string;
  label: string;
  openRouterId: string;
}

export const MODELS = {
  // Ultra-cheap ($0.03-0.10 in)
  "mistral-small-3.1": {
    id: "mistral-small-3.1",
    label: "Mistral Small 3.1",
    openRouterId: "mistralai/mistral-small-3.1-24b-instruct",
  },
  "gpt-5-nano": {
    id: "gpt-5-nano",
    label: "GPT-5 Nano",
    openRouterId: "openai/gpt-5-nano",
  },
  "qwen-3.5-flash": {
    id: "qwen-3.5-flash",
    label: "Qwen 3.5 Flash",
    openRouterId: "qwen/qwen3.5-flash-02-23",
  },
  "gemma-3-27b": {
    id: "gemma-3-27b",
    label: "Gemma 3 27B",
    openRouterId: "google/gemma-3-27b-it",
  },
  "gpt-4.1-nano": {
    id: "gpt-4.1-nano",
    label: "GPT-4.1 Nano",
    openRouterId: "openai/gpt-4.1-nano",
  },
  "llama-3.3-70b": {
    id: "llama-3.3-70b",
    label: "Llama 3.3 70B",
    openRouterId: "meta-llama/llama-3.3-70b-instruct",
  },
  // Mid-tier ($0.15-0.75 in)
  "llama-4-maverick": {
    id: "llama-4-maverick",
    label: "Llama 4 Maverick",
    openRouterId: "meta-llama/llama-4-maverick",
  },
  "deepseek-v3": {
    id: "deepseek-v3",
    label: "DeepSeek V3",
    openRouterId: "deepseek/deepseek-chat-v3-0324",
  },
  "gpt-5.4-nano": {
    id: "gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    openRouterId: "openai/gpt-5.4-nano",
  },
  "gemini-3.1-flash-lite": {
    id: "gemini-3.1-flash-lite",
    label: "Gemini 3.1 Flash Lite",
    openRouterId: "google/gemini-3.1-flash-lite-preview",
  },
  "gemini-2.5-flash": {
    id: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    openRouterId: "google/gemini-2.5-flash",
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    openRouterId: "openai/gpt-5.4-mini",
  },
  // Premium ($1+ in)
  "haiku-4.5": {
    id: "haiku-4.5",
    label: "Claude Haiku 4.5",
    openRouterId: "anthropic/claude-haiku-4.5",
  },
  "sonnet-4.6": {
    id: "sonnet-4.6",
    label: "Claude Sonnet 4.6",
    openRouterId: "anthropic/claude-sonnet-4.6",
  },
} as const satisfies Record<string, ModelDef>;

export type ModelId = keyof typeof MODELS;

// --- LLM call via OpenRouter ---

async function callOpenRouter(model: ModelDef, system: string, user: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "X-Title": "fantasy-baseball-evals",
    },
    body: JSON.stringify({
      model: model.openRouterId,
      max_tokens: 512,
      temperature: 0.3,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return `[error: ${model.openRouterId} ${res.status}: ${text.slice(0, 200)}]`;
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "[empty response]";
}

// --- Claude CLI fallback ---

async function callClaudeCLI(system: string, user: string): Promise<string> {
  const prompt = `${system}\n\n${user}`;
  try {
    const { stdout } = await execFileAsync("claude", ["-p", "--model", "sonnet", prompt], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    return stdout.trim() || "[empty response]";
  } catch (e) {
    return `[error: ${e instanceof Error ? e.message : "unknown"}]`;
  }
}

// --- Main call function ---

export async function callModel(modelId: ModelId, system: string, user: string): Promise<string> {
  const model = MODELS[modelId];

  if (process.env.OPENROUTER_API_KEY) {
    return callOpenRouter(model, system, user);
  }

  // Fallback to claude CLI (only supports claude models)
  return callClaudeCLI(system, user);
}

// --- Judge (uses cheapest model available) ---

const JUDGE_MODEL: ModelId = "gpt-5.4-mini";

async function callJudge(system: string, user: string): Promise<string> {
  if (process.env.OPENROUTER_API_KEY) {
    return callOpenRouter(MODELS[JUDGE_MODEL], system, user);
  }
  return callClaudeCLI(system, user);
}

// --- Evalite Scorers ---

/** Keyword synonyms for flexible matching */
const KEYWORD_SYNONYMS: Record<string, string[]> = {
  closer: ["closer", "save", "saves", "closing", "ninth-inning", "9th inning"],
  marginal: ["marginal", "modest", "minimal", "slight", "small", "negligible", "thin"],
  priority: ["priority", "waiver", "claim", "priority #"],
  hold: ["hold", "stand pat", "don't", "do not", "pass", "skip", "wait", "save"],
  protect: ["protect", "preserve", "maintain", "safeguard", "lock in", "don't risk"],
  stream: ["stream", "streaming", "start", "add", "pick up", "grab"],
  aggressive: ["aggressive", "aggressively", "push", "chase", "attack", "go for"],
  sell: ["sell", "sell high", "trade away", "move", "deal", "cash in"],
  drop: ["drop", "cut", "release", "let go", "move on from"],
  stash: ["stash", "stash on IL", "IL stash", "place on IL", "move to IL"],
};

/** Check that expected keywords appear in output (with synonym matching) */
export const containsKeywords = createScorer<{ keywords: string[] }, string, unknown>({
  name: "Keywords",
  description: "Expected keywords or synonyms present in output",
  scorer: ({ input, output }) => {
    const keywords = (input as { keywords: string[] }).keywords ?? [];
    if (keywords.length === 0) return 1;
    const lower = output.toLowerCase();
    const found = keywords.filter((k) => {
      const kl = k.toLowerCase();
      if (lower.includes(kl)) return true;
      const synonyms = KEYWORD_SYNONYMS[kl];
      return synonyms?.some((s) => lower.includes(s)) ?? false;
    });
    return found.length / keywords.length;
  },
});

/** Output length within bounds for Telegram */
export const concise = createScorer<unknown, string, unknown>({
  name: "Concise",
  description: "Output under 600 chars (Telegram-friendly)",
  scorer: ({ output }) => {
    const len = output.length;
    if (len <= 600) return 1;
    return Math.max(0, 1 - (len - 600) / 600);
  },
});

/** No markdown formatting (plain text for Telegram) */
export const noMarkdown = createScorer<unknown, string, unknown>({
  name: "No Markdown",
  description: "No markdown headers, bold, or code blocks",
  scorer: ({ output }) => {
    const patterns = [/^#{1,6}\s/m, /\*\*[^*]+\*\*/, /```/, /\[.*\]\(.*\)/];
    const violations = patterns.filter((p) => p.test(output));
    return violations.length === 0 ? 1 : 1 - violations.length / patterns.length;
  },
});

/** Contains fantasy baseball action verbs */
export const actionable = createScorer<unknown, string, unknown>({
  name: "Actionable",
  description: "Contains action verbs (start, bench, add, drop, etc.)",
  scorer: ({ output }) => {
    const verbs = [
      "start",
      "bench",
      "add",
      "drop",
      "stream",
      "pick up",
      "trade",
      "hold",
      "stash",
      "protect",
      "target",
      "punt",
      "chase",
      "sit",
      "activate",
      "claim",
      "avoid",
      "prioritize",
      "sell",
      "buy",
    ];
    const lower = output.toLowerCase();
    const found = verbs.filter((v) => lower.includes(v));
    return Math.min(1, found.length / 2);
  },
});

/** Mentions specific H2H categories from our league */
export const categoryAware = createScorer<unknown, string, unknown>({
  name: "Category Aware",
  description: "Mentions specific league categories",
  scorer: ({ output }) => {
    const cats = [
      "\\bR\\b",
      "\\bH\\b",
      "\\bHR\\b",
      "\\bRBI\\b",
      "\\bSB\\b",
      "\\bTB\\b",
      "\\bOBP\\b",
      "\\bERA\\b",
      "\\bWHIP\\b",
      "\\bK\\b",
      "\\bQS\\b",
      "\\bSV\\b",
      "\\bHLD\\b",
      "\\bOUT\\b",
    ];
    const found = cats.filter((c) => new RegExp(c, "i").test(output));
    return Math.min(1, found.length / 2);
  },
});

/** No hallucinated content (rejected keywords absent) */
export const noHallucination = createScorer<{ rejectKeywords?: string[] }, string, unknown>({
  name: "No Hallucination",
  description: "Does not mention players/facts not in input",
  scorer: ({ input, output }) => {
    const rejected = (input as { rejectKeywords?: string[] }).rejectKeywords ?? [];
    if (rejected.length === 0) return 1;
    const lower = output.toLowerCase();
    const found = rejected.filter((k) => lower.includes(k.toLowerCase()));
    return found.length === 0 ? 1 : 1 - found.length / rejected.length;
  },
});

/** LLM-as-judge using reliable mid-tier model */
export function llmJudge(criteria: string) {
  return createScorer<unknown, string, unknown>({
    name: "LLM Judge",
    description: criteria,
    scorer: async ({ output }) => {
      const judgePrompt = [
        "Score this fantasy baseball AI response 0-100.",
        "",
        "CRITERIA:",
        criteria,
        "",
        "SCORING GUIDE:",
        "90-100: Correct decision, names relevant categories, concise, actionable",
        "70-89: Mostly correct, minor issues (slightly verbose, missing a category)",
        "50-69: Partially correct but significant issues (wrong advice, too long, markdown)",
        "0-49: Wrong decision, hallucinated info, or completely off-topic",
        "",
        "RESPONSE TO EVALUATE:",
        output,
        "",
        'Output ONLY: {"score": <0-100>, "reason": "<1 sentence>"}',
      ].join("\n");

      const result = await callJudge(
        "Score the response. Output only valid JSON. Be fair — if the advice is correct and relevant, score 80+.",
        judgePrompt,
      );

      try {
        const cleaned = result.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "");
        const parsed = JSON.parse(cleaned) as { score: number; reason: string };
        return {
          score: (parsed.score ?? 0) / 100,
          metadata: { reason: parsed.reason },
        };
      } catch {
        return {
          score: 0,
          metadata: { reason: `Failed to parse judge response: ${result.slice(0, 100)}` },
        };
      }
    },
  });
}
