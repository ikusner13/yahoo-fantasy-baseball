import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Env } from "../types";

const execFileAsync = promisify(execFile);

/**
 * Call Claude via the Claude Code CLI (`claude -p`).
 * Uses the user's existing Claude subscription — no API key needed.
 * Falls back to API calls if ANTHROPIC_API_KEY or OPENAI_API_KEY is set.
 */
async function callClaudeCLI(systemPrompt: string, userPrompt: string): Promise<string | null> {
  try {
    const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const { stdout } = await execFileAsync("claude", ["-p", combinedPrompt], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    });
    return stdout.trim() || null;
  } catch (e) {
    console.error("Claude CLI error:", e);
    return null;
  }
}

async function callAPIFallback(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
): Promise<string | null> {
  // Anthropic API
  if (env.ANTHROPIC_API_KEY) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: "user", content: userPrompt }],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          content: Array<{ text: string }>;
        };
        return data.content?.[0]?.text ?? null;
      }
    } catch {}
  }

  // OpenAI API
  if (env.OPENAI_API_KEY) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          max_tokens: 1024,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        return data.choices?.[0]?.message?.content ?? null;
      }
    } catch {}
  }

  return null;
}

export async function askLLM(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  // Try Claude CLI first (uses subscription, no API key needed)
  const cliResult = await callClaudeCLI(systemPrompt, userPrompt);
  if (cliResult) return cliResult;

  // Fall back to API if keys configured
  const apiResult = await callAPIFallback(env, systemPrompt, userPrompt);
  if (apiResult) return apiResult;

  return "[LLM unavailable — install Claude Code CLI or set API keys]";
}

export async function askLLMJson<T>(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
): Promise<T | null> {
  const jsonPrompt = `${systemPrompt}\n\nRespond ONLY with valid JSON, no markdown or explanation.`;
  const text = await askLLM(env, jsonPrompt, userPrompt);
  if (text.startsWith("[LLM")) return null;
  try {
    // Strip markdown code fences if present
    const cleaned = text.replace(/^```json?\n?/m, "").replace(/\n?```$/m, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

export async function summarizeForTelegram(env: Env, context: string): Promise<string> {
  return askLLM(
    env,
    "You are a concise fantasy baseball assistant. Summarize into 1-3 short sentences for Telegram. No markdown, plain text. Be direct and actionable.",
    context,
  );
}
