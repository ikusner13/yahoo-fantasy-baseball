import type { PickupRecommendation } from "../analysis/waivers";
import { askLLMJson } from "../ai/llm";
import { waiverReviewPrompt } from "../ai/prompts";
import type { NewsAlert } from "../monitors/news";
import type { Env, Matchup } from "../types";
import { z } from "zod";

export interface WaiverReviewResult {
  verdict: "approve" | "reject" | "needs_human";
  confidence: number;
  summary: string;
  riskFlags: string[];
}

export interface WaiverReviewInput {
  recommendation: PickupRecommendation;
  matchup?: Matchup;
  addsRemaining?: number;
  memory?: string;
  relatedAlerts?: NewsAlert[];
}

const waiverReviewSchema = z.object({
  verdict: z.enum(["approve", "reject", "needs_human"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(4).max(120),
  riskFlags: z.array(z.string()).max(6),
});

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function shouldReviewPickup(recommendation: PickupRecommendation): boolean {
  const winDelta = recommendation.winProbabilityDelta ?? 0;
  const catDelta = recommendation.expectedCategoryWinsDelta ?? 0;
  const targets = recommendation.targetCategories ?? [];

  return (
    (winDelta >= 0.005 && winDelta < 0.025) ||
    (catDelta >= 0.12 && catDelta < 0.35) ||
    targets.length === 0
  );
}

function formatAlerts(alerts: NewsAlert[] | undefined): string {
  if (!alerts || alerts.length === 0) return "none";
  return alerts
    .slice(0, 3)
    .map((alert) => {
      const structured = alert.structured;
      const structuredBits = structured
        ? [
            structured.summary,
            `impact=${structured.impactLevel}`,
            `bias=${structured.actionBias}`,
            structured.targetCategories.length > 0
              ? `cats=${structured.targetCategories.join("/")}`
              : "",
          ]
            .filter(Boolean)
            .join(", ")
        : "";
      return `${alert.type}: ${alert.headline}${structuredBits ? ` (${structuredBits})` : ""}`;
    })
    .join("\n");
}

function formatReviewBriefing(input: WaiverReviewInput): string {
  const { recommendation, matchup, addsRemaining, memory, relatedAlerts } = input;
  const targetCategories =
    recommendation.targetCategories && recommendation.targetCategories.length > 0
      ? recommendation.targetCategories.join(", ")
      : "none";

  const sections = [
    `ENGINE MOVE: add ${recommendation.add.name}, drop ${recommendation.drop.name}`,
    `ENGINE REASONING: ${recommendation.reasoning}`,
    `WIN DELTA: ${((recommendation.winProbabilityDelta ?? 0) * 100).toFixed(1)} percentage points`,
    `CATEGORY DELTA: ${(recommendation.expectedCategoryWinsDelta ?? 0).toFixed(2)}`,
    `TARGET CATEGORIES: ${targetCategories}`,
    `ADDS REMAINING: ${addsRemaining ?? "unknown"}`,
    `RELATED NEWS: ${formatAlerts(relatedAlerts)}`,
  ];

  if (matchup) {
    sections.push(
      `MATCHUP: Week ${matchup.week} vs ${matchup.opponentTeamName}; current categories ${matchup.categories
        .map((category) => `${category.category} ${category.myValue}-${category.opponentValue}`)
        .join(" | ")}`,
    );
  }

  if (memory) sections.push(`MEMORY:\n${memory}`);
  return sections.join("\n");
}

export async function reviewWaiverRecommendation(
  env: Env,
  input: WaiverReviewInput,
): Promise<WaiverReviewResult | null> {
  if (!shouldReviewPickup(input.recommendation)) return null;
  if (!env.OPENROUTER_API_KEY && !env.ANTHROPIC_API_KEY) return null;

  const prompt = waiverReviewPrompt(formatReviewBriefing(input));
  const result = await askLLMJson<WaiverReviewResult>(
    env,
    prompt.system,
    prompt.user,
    waiverReviewSchema,
    prompt.touchpoint,
  );
  if (!result) return null;

  const verdict =
    result.verdict === "approve" || result.verdict === "reject" || result.verdict === "needs_human"
      ? result.verdict
      : "needs_human";

  return {
    verdict,
    confidence: clamp01(result.confidence),
    summary: typeof result.summary === "string" && result.summary.trim().length > 0
      ? result.summary.trim()
      : "Context check was inconclusive.",
    riskFlags: Array.isArray(result.riskFlags)
      ? result.riskFlags
          .filter((flag): flag is string => typeof flag === "string" && flag.trim().length > 0)
          .slice(0, 4)
      : [],
  };
}
