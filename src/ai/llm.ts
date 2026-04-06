import type { Env } from "../types";

// --- Touchpoint → Model routing ---

export type Touchpoint = "lineup" | "waiver" | "matchup" | "trade" | "injury" | "summary";

interface ModelConfig {
  openRouterId: string;
  temperature: number;
  maxTokens: number;
}

/**
 * Per-touchpoint model routing based on eval results (v2 tuning, April 2026).
 * Qwen 3.5 Flash: best rules-follower, cheapest ($0.07/MTok)
 * DeepSeek V3: best natural tone, good XML structure ($0.20/MTok)
 * Llama 3.3 70B: best anti-verbosity discipline ($0.10/MTok)
 */
const MODEL_ROUTING: Record<Touchpoint, ModelConfig> = {
  lineup: { openRouterId: "qwen/qwen3.5-flash-02-23", temperature: 0.3, maxTokens: 256 },
  waiver: { openRouterId: "qwen/qwen3.5-flash-02-23", temperature: 0.3, maxTokens: 384 },
  matchup: { openRouterId: "qwen/qwen3.5-flash-02-23", temperature: 0.3, maxTokens: 384 },
  trade: { openRouterId: "deepseek/deepseek-chat-v3-0324", temperature: 0.3, maxTokens: 512 },
  injury: { openRouterId: "meta-llama/llama-3.3-70b-instruct", temperature: 0.3, maxTokens: 256 },
  summary: { openRouterId: "qwen/qwen3.5-flash-02-23", temperature: 0.3, maxTokens: 256 },
};

const DEFAULT_MODEL: ModelConfig = {
  openRouterId: "qwen/qwen3.5-flash-02-23",
  temperature: 0.3,
  maxTokens: 512,
};

// --- OpenRouter (primary) ---

async function callOpenRouter(
  apiKey: string,
  model: ModelConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "X-Title": "fantasy-baseball-gm",
      },
      body: JSON.stringify({
        model: model.openRouterId,
        max_tokens: model.maxTokens,
        temperature: model.temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!res.ok) {
      console.error(`OpenRouter error (${model.openRouterId}): ${res.status}`);
      return null;
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) {
    console.error("OpenRouter call failed:", e);
    return null;
  }
}

// --- Anthropic API fallback ---

async function callAnthropicFallback(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as { content: Array<{ text: string }> };
      return data.content?.[0]?.text?.trim() ?? null;
    }
  } catch {}
  return null;
}

// --- Public API ---

export async function askLLM(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  touchpoint?: Touchpoint,
): Promise<string> {
  const model = touchpoint ? MODEL_ROUTING[touchpoint] : DEFAULT_MODEL;

  // Primary: OpenRouter with per-touchpoint model routing
  if (env.OPENROUTER_API_KEY) {
    const result = await callOpenRouter(env.OPENROUTER_API_KEY, model, systemPrompt, userPrompt);
    if (result) return result;
  }

  // Fallback: Anthropic API (Haiku — cheap)
  if (env.ANTHROPIC_API_KEY) {
    const result = await callAnthropicFallback(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);
    if (result) return result;
  }

  return "[LLM unavailable — set OPENROUTER_API_KEY or ANTHROPIC_API_KEY]";
}

export async function askLLMJson<T>(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  touchpoint?: Touchpoint,
): Promise<T | null> {
  const jsonPrompt = `${systemPrompt}\n\nRespond ONLY with valid JSON, no markdown or explanation.`;
  const text = await askLLM(env, jsonPrompt, userPrompt, touchpoint);
  if (text.startsWith("[LLM")) return null;
  try {
    const cleaned = text.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export async function summarizeForTelegram(
  env: Env,
  context: string,
  touchpoint?: Touchpoint,
): Promise<string> {
  return askLLM(
    env,
    "RULES: (1) Plain text only (2) Max 2 sentences (3) Be direct and actionable (4) No markdown",
    context,
    touchpoint ?? "summary",
  );
}
