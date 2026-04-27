import { desc } from "drizzle-orm";
import type { Env } from "../types";
import type { Touchpoint } from "./llm";
import { askLLM, askLLMJson } from "./llm";
import { decisions, retrospectives, gmReflections } from "../db/schema";
import type { WeeklyRetrospective } from "../analysis/retrospective";
import { z } from "zod";

// Which decision types are relevant to each touchpoint
const TOUCHPOINT_DECISION_TYPES: Record<Touchpoint, string[]> = {
  matchup: ["lineup", "waiver", "stream", "trade", "il"],
  waiver: ["waiver", "stream"],
  trade: ["trade"],
  lineup: ["lineup"],
  injury: ["il"],
  news: ["waiver", "il"],
  review: ["waiver", "stream", "il"],
  summary: ["lineup", "waiver", "stream"],
};

const REFLECTION_TAGS = [
  "missed_role_change",
  "missed_injury_context",
  "too_aggressive_ratios",
  "too_passive_on_saves",
  "small_sample_bias",
  "underweighted_schedule",
  "budget_mismanagement",
  "correct_process",
] as const;

export type ReflectionTag = (typeof REFLECTION_TAGS)[number];

export interface GMReflectionRecord {
  summary: string;
  strengths: string[];
  misses: string[];
  tags: ReflectionTag[];
  tuningIdeas: string[];
  confidence: number;
}

const REFLECTION_TAG_SET = new Set<string>(REFLECTION_TAGS);
const reflectionRecordSchema = z.object({
  summary: z.string().min(4).max(400),
  strengths: z.array(z.string()).max(5),
  misses: z.array(z.string()).max(5),
  tags: z.array(z.enum(REFLECTION_TAGS)).max(6),
  tuningIdeas: z.array(z.string()).max(5),
  confidence: z.number().min(0).max(1),
});

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function normalizeReflectionRecord(value: Partial<GMReflectionRecord>): GMReflectionRecord {
  return {
    summary: typeof value.summary === "string" && value.summary.trim().length > 0
      ? value.summary.trim()
      : "No clear pattern identified.",
    strengths: Array.isArray(value.strengths)
      ? value.strengths
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 3)
      : [],
    misses: Array.isArray(value.misses)
      ? value.misses
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 3)
      : [],
    tags: Array.isArray(value.tags)
      ? value.tags.filter((item): item is ReflectionTag => REFLECTION_TAG_SET.has(String(item))).slice(0, 5)
      : [],
    tuningIdeas: Array.isArray(value.tuningIdeas)
      ? value.tuningIdeas
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, 3)
      : [],
    confidence: clamp01(value.confidence ?? 0.5),
  };
}

export function parseReflectionRecord(reflection: string): GMReflectionRecord | null {
  try {
    return normalizeReflectionRecord(JSON.parse(reflection) as Partial<GMReflectionRecord>);
  } catch {
    return null;
  }
}

function formatReflectionSummary(reflection: string): string {
  const parsed = parseReflectionRecord(reflection);
  return parsed ? parsed.summary : reflection;
}

function summarizeReflectionTags(reflections: string[]): string[] {
  const counts = new Map<ReflectionTag, number>();
  for (const reflection of reflections) {
    const parsed = parseReflectionRecord(reflection);
    if (!parsed) continue;
    for (const tag of parsed.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag, count]) => `${tag}${count > 1 ? ` x${count}` : ""}`);
}

/**
 * Build memory context for a given touchpoint by querying recent decisions,
 * retrospective lessons, and compressed reflections from D1.
 * Follows the same pattern as getRecentFeedback() — non-fatal, returns undefined on error.
 */
export async function buildMemoryContext(
  env: Env,
  touchpoint: Touchpoint,
): Promise<string | undefined> {
  try {
    const sections: string[] = [];
    const relevantTypes = TOUCHPOINT_DECISION_TYPES[touchpoint];

    // 1. Recent decisions (last 10, filtered by touchpoint relevance)
    const recentDecisions = await env.db
      .select({
        type: decisions.type,
        action: decisions.action,
        reasoning: decisions.reasoning,
        result: decisions.result,
      })
      .from(decisions)
      .orderBy(desc(decisions.timestamp))
      .limit(20)
      .all();

    const filtered = recentDecisions.filter((d) => relevantTypes.includes(d.type)).slice(0, 5);

    if (filtered.length > 0) {
      sections.push("RECENT DECISIONS:");
      for (const d of filtered) {
        const summary = formatDecisionSummary(d.type, d.action, d.reasoning);
        sections.push(`• [${d.type}] ${summary} — ${d.result}`);
      }
    }

    // 2. Retrospective lessons (last 2 weeks)
    const retros = await env.db
      .select({ data: retrospectives.data })
      .from(retrospectives)
      .orderBy(desc(retrospectives.week))
      .limit(2)
      .all();

    const allLessons: string[] = [];
    for (const r of retros) {
      try {
        const parsed = JSON.parse(r.data) as WeeklyRetrospective;
        if (parsed.lessons?.length) allLessons.push(...parsed.lessons);
      } catch {
        // skip malformed
      }
    }

    if (allLessons.length > 0) {
      sections.push("\nLESSONS (recent weeks):");
      for (const l of allLessons.slice(0, 4)) {
        sections.push(`• ${l}`);
      }
    }

    // 3. Compressed reflections (last 2)
    const reflections = await env.db
      .select({ reflection: gmReflections.reflection })
      .from(gmReflections)
      .orderBy(desc(gmReflections.createdAt))
      .limit(4)
      .all();

    if (reflections.length > 0) {
      sections.push("\nPATTERNS:");
      for (const r of reflections) {
        sections.push(`• ${formatReflectionSummary(r.reflection)}`);
      }

      const repeatedTags = summarizeReflectionTags(reflections.map((reflection) => reflection.reflection));
      if (repeatedTags.length > 0) {
        sections.push("\nREPEATED TAGS:");
        for (const tag of repeatedTags) {
          sections.push(`• ${tag}`);
        }
      }

      const tuningIdeas = reflections
        .flatMap((reflection) => parseReflectionRecord(reflection.reflection)?.tuningIdeas ?? [])
        .slice(0, 3);
      if (tuningIdeas.length > 0) {
        sections.push("\nTUNING:");
        for (const idea of tuningIdeas) {
          sections.push(`• ${idea}`);
        }
      }
    }

    return sections.length > 0 ? sections.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generate a compressed reflection from recent decisions and an optional retrospective.
 * Called weekly, stores result in gm_reflections table.
 */
export async function generateReflection(env: Env, _recentDecisionIds: number[]): Promise<void> {
  // Fetch recent decisions for summarization
  const recentDecisionRows = await env.db
    .select({
      id: decisions.id,
      type: decisions.type,
      action: decisions.action,
      reasoning: decisions.reasoning,
      result: decisions.result,
    })
    .from(decisions)
    .orderBy(desc(decisions.timestamp))
    .limit(40)
    .all();

  const recentDecisions =
    _recentDecisionIds.length > 0
      ? recentDecisionRows.filter((decision) => _recentDecisionIds.includes(decision.id)).slice(0, 20)
      : recentDecisionRows.slice(0, 20);

  if (recentDecisions.length === 0) return;

  // Fetch latest retrospective for additional context
  const latestRetro = await env.db
    .select({ data: retrospectives.data })
    .from(retrospectives)
    .orderBy(desc(retrospectives.week))
    .limit(1)
    .get();

  let retroContext = "";
  if (latestRetro) {
    try {
      const parsed = JSON.parse(latestRetro.data) as WeeklyRetrospective;
      retroContext = `\nWeek result: ${parsed.finalScore}. Lessons: ${parsed.lessons.join("; ")}`;
    } catch {
      // skip
    }
  }

  const decisionSummaries = recentDecisions
    .map((d) => `[${d.type}] ${formatDecisionSummary(d.type, d.action, d.reasoning)} — ${d.result}`)
    .join("\n");

  const structuredReflection = await askLLMJson<GMReflectionRecord>(
    env,
    `You are reviewing recent fantasy baseball GM decisions. Identify what worked, what failed, and the repeatable tuning lessons. Return JSON with exactly these keys:
{
  "summary": string,
  "strengths": string[],
  "misses": string[],
  "tags": string[],
  "tuningIdeas": string[],
  "confidence": number
}
    Allowed tags: ${REFLECTION_TAGS.join(", ")}.
    Use "correct_process" only when a decision process was sound even if the outcome was noisy. Keep each list short and concrete.`,
    `Decisions:\n${decisionSummaries}${retroContext}`,
    reflectionRecordSchema,
    "summary",
  );

  let reflectionRecord: GMReflectionRecord | null =
    structuredReflection ? normalizeReflectionRecord(structuredReflection) : null;
  if (!reflectionRecord) {
    const reflection = await askLLM(
      env,
      "Summarize key patterns from these GM decisions in 2-3 sentences. What worked, what didn't, any consistent errors. Be concrete — name categories and players. No preamble.",
      `Decisions:\n${decisionSummaries}${retroContext}`,
      "summary",
    );
    if (reflection.startsWith("[LLM")) return;
    reflectionRecord = normalizeReflectionRecord({
      summary: reflection,
      confidence: 0.4,
    });
  }

  await env.db.insert(gmReflections).values({
    reflection: JSON.stringify(reflectionRecord),
    runsCovered: JSON.stringify(recentDecisions.map((d) => d.id)),
  });
}

/** Extract a concise summary from a decision's action JSON + reasoning */
function formatDecisionSummary(
  type: string,
  actionJson: string,
  reasoning?: string | null,
): string {
  if (reasoning) return reasoning.slice(0, 80);
  try {
    const action = JSON.parse(actionJson) as Record<string, unknown>;
    const s = (v: unknown, fallback: string) => (v != null ? String(v) : fallback);
    switch (type) {
      case "waiver":
        return `${s(action.player ?? action.add, "pickup")} (${s(action.reason, "z-score")})`;
      case "stream":
        return `${s(action.pitcher ?? action.add, "streamer")} (${s(action.reason, "score")})`;
      case "lineup":
        return s(action.moves ?? action.routine, "optimization");
      case "trade":
        return s(action.target, "trade proposal");
      case "il":
        return s(action.player, "IL move");
      default:
        return s(action.routine, type);
    }
  } catch {
    return type;
  }
}
