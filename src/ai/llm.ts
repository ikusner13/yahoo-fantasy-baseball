import type { Env } from "../types";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, Output } from "ai";
import { logLLM, logError } from "../observability/log";
import type { z } from "zod";

// --- Touchpoint → Model routing ---

export type Touchpoint =
  | "lineup"
  | "waiver"
  | "matchup"
  | "trade"
  | "injury"
  | "news"
  | "review"
  | "summary";

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
  news: { openRouterId: "qwen/qwen3.5-flash-02-23", temperature: 0.2, maxTokens: 256 },
  review: { openRouterId: "qwen/qwen3.5-flash-02-23", temperature: 0.2, maxTokens: 256 },
  summary: { openRouterId: "qwen/qwen3.5-flash-02-23", temperature: 0.3, maxTokens: 256 },
};

const DEFAULT_MODEL: ModelConfig = {
  openRouterId: "qwen/qwen3.5-flash-02-23",
  temperature: 0.3,
  maxTokens: 512,
};

// --- AI SDK provider calls ---

async function callOpenRouterText(
  apiKey: string,
  model: ModelConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const openrouter = createOpenRouter({
      apiKey,
      headers: {
        "X-Title": "fantasy-baseball-gm",
      },
    });
    const result = await generateText({
      model: openrouter(model.openRouterId),
      system: systemPrompt,
      prompt: userPrompt,
      temperature: model.temperature,
      maxOutputTokens: model.maxTokens,
      abortSignal: AbortSignal.timeout(15_000),
    });
    return result.text.trim() || null;
  } catch (e) {
    logError("openrouter", e);
    return null;
  }
}

async function callOpenRouterObject<T>(
  apiKey: string,
  model: ModelConfig,
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const openrouter = createOpenRouter({
      apiKey,
      headers: {
        "X-Title": "fantasy-baseball-gm",
      },
    });
    const result = await generateText({
      model: openrouter(model.openRouterId),
      system: systemPrompt,
      prompt: userPrompt,
      temperature: model.temperature,
      maxOutputTokens: model.maxTokens,
      abortSignal: AbortSignal.timeout(15_000),
      output: Output.object({ schema }),
      providerOptions: {
        openrouter: {
          plugins: [{ id: "response-healing" }],
        },
      },
    });
    return result.output;
  } catch (e) {
    logError("openrouter_object", e);
    return null;
  }
}

// --- Anthropic fallback ---

async function callAnthropicText(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  try {
    const anthropic = createAnthropic({ apiKey });
    const result = await generateText({
      model: anthropic("claude-3-5-haiku-latest"),
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.3,
      maxOutputTokens: 512,
      abortSignal: AbortSignal.timeout(15_000),
    });
    return result.text.trim() || null;
  } catch (e) {
    logError("anthropic", e);
  }
  return null;
}

async function callAnthropicObject<T>(
  apiKey: string,
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const anthropic = createAnthropic({ apiKey });
    const result = await generateText({
      model: anthropic("claude-3-5-haiku-latest"),
      system: systemPrompt,
      prompt: userPrompt,
      temperature: 0.2,
      maxOutputTokens: 512,
      abortSignal: AbortSignal.timeout(15_000),
      output: Output.object({ schema }),
    });
    return result.output;
  } catch (e) {
    logError("anthropic_object", e);
  }
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
  const start = Date.now();

  // Primary: OpenRouter with per-touchpoint model routing
  if (env.OPENROUTER_API_KEY) {
    const result = await callOpenRouterText(env.OPENROUTER_API_KEY, model, systemPrompt, userPrompt);
    if (result) {
      logLLM(model.openRouterId, touchpoint, Date.now() - start, true, false);
      return result;
    }
  }

  // Fallback: Anthropic API (Haiku — cheap)
  if (env.ANTHROPIC_API_KEY) {
    const result = await callAnthropicText(env.ANTHROPIC_API_KEY, systemPrompt, userPrompt);
    if (result) {
      logLLM("claude-3-5-haiku-latest", touchpoint, Date.now() - start, true, true);
      return result;
    }
  }

  logLLM(model.openRouterId, touchpoint, Date.now() - start, false, false);
  return "[LLM unavailable — set OPENROUTER_API_KEY or ANTHROPIC_API_KEY]";
}

export async function askLLMJson<T>(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  schema: z.ZodType<T>,
  touchpoint?: Touchpoint,
): Promise<T | null> {
  const model = touchpoint ? MODEL_ROUTING[touchpoint] : DEFAULT_MODEL;
  const start = Date.now();

  if (env.OPENROUTER_API_KEY) {
    const result = await callOpenRouterObject(
      env.OPENROUTER_API_KEY,
      model,
      systemPrompt,
      userPrompt,
      schema,
    );
    if (result) {
      logLLM(model.openRouterId, touchpoint, Date.now() - start, true, false);
      return result;
    }
  }

  if (env.ANTHROPIC_API_KEY) {
    const result = await callAnthropicObject(
      env.ANTHROPIC_API_KEY,
      systemPrompt,
      userPrompt,
      schema,
    );
    if (result) {
      logLLM("claude-3-5-haiku-latest", touchpoint, Date.now() - start, true, true);
      return result;
    }
  }

  logLLM(model.openRouterId, touchpoint, Date.now() - start, false, false);
  return null;
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
