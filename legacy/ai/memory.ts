import { desc } from "drizzle-orm";
import type { Env } from "../types";
import type { Touchpoint } from "./llm";
import { askLLM } from "./llm";
import { decisions, retrospectives, gmReflections } from "../db/schema";
import type { WeeklyRetrospective } from "../analysis/retrospective";

// Which decision types are relevant to each touchpoint
const TOUCHPOINT_DECISION_TYPES: Record<Touchpoint, string[]> = {
  matchup: ["lineup", "waiver", "stream", "trade", "il"],
  waiver: ["waiver", "stream"],
  trade: ["trade"],
  lineup: ["lineup"],
  injury: ["il"],
  summary: ["lineup", "waiver", "stream"],
};

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
      .limit(2)
      .all();

    if (reflections.length > 0) {
      sections.push("\nPATTERNS:");
      for (const r of reflections) {
        sections.push(`• ${r.reflection}`);
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
  const recentDecisions = await env.db
    .select({
      id: decisions.id,
      type: decisions.type,
      action: decisions.action,
      reasoning: decisions.reasoning,
      result: decisions.result,
    })
    .from(decisions)
    .orderBy(desc(decisions.timestamp))
    .limit(20)
    .all();

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

  const reflection = await askLLM(
    env,
    "Summarize key patterns from these GM decisions in 2-3 sentences. What worked, what didn't, any consistent errors. Be concrete — name categories and players. No preamble.",
    `Decisions:\n${decisionSummaries}${retroContext}`,
    "summary",
  );

  if (reflection.startsWith("[LLM")) return;

  await env.db.insert(gmReflections).values({
    reflection,
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
