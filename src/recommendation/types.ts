import type { Category } from "../types";

export type RecommendationKind =
  | "lineup"
  | "waiver"
  | "stream"
  | "trade"
  | "il"
  | "watchlist";

export type RecommendationAction =
  | "start"
  | "sit"
  | "add"
  | "drop"
  | "stream"
  | "hold"
  | "watch"
  | "move_to_il"
  | "activate_il";

export type RecommendationPriority = "critical" | "high" | "medium" | "low";

export type ConfidenceBand = "high" | "medium" | "low";

export interface RecommendationSignal {
  source: string;
  direction: "positive" | "negative" | "neutral";
  weight: number;
  evidence: number;
}

export interface RecommendationBasis {
  delta: number;
  uncertainty: number;
  dataQuality: number;
  signalAgreement?: number;
}

export interface ConfidenceBreakdown {
  deltaMagnitude: number;
  uncertaintyPenalty: number;
  dataQualityBonus: number;
  agreementBonus: number;
}

export interface ConfidenceAssessment {
  score: number;
  band: ConfidenceBand;
  breakdown: ConfidenceBreakdown;
}

export interface RecommendationInput {
  kind: RecommendationKind;
  action: RecommendationAction;
  title: string;
  summary: string;
  basis: RecommendationBasis;
  targetCategories?: Category[];
  avoidCategories?: Category[];
  signals?: RecommendationSignal[];
  priority?: RecommendationPriority;
}

export interface Recommendation extends RecommendationInput {
  id: string;
  confidence: ConfidenceAssessment;
}

function clamp01(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function makeId(input: Pick<RecommendationInput, "kind" | "action" | "title">): string {
  const slug = input.title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${input.kind}:${input.action}:${slug || "recommendation"}`;
}

export function createRecommendation(input: RecommendationInput): Recommendation {
  const confidence: ConfidenceAssessment = {
    score: 0,
    band: "low",
    breakdown: {
      deltaMagnitude: 0,
      uncertaintyPenalty: 0,
      dataQualityBonus: 0,
      agreementBonus: 0,
    },
  };

  return {
    id: makeId(input),
    ...input,
    confidence,
  };
}

export function isRecommendation(value: unknown): value is Recommendation {
  if (!value || typeof value !== "object") return false;
  const rec = value as Partial<Recommendation>;
  return (
    typeof rec.id === "string" &&
    typeof rec.kind === "string" &&
    typeof rec.action === "string" &&
    typeof rec.title === "string" &&
    typeof rec.summary === "string" &&
    typeof rec.basis === "object" &&
    rec.basis != null
  );
}

export function normalizeBasis(input: RecommendationBasis): RecommendationBasis {
  return {
    delta: input.delta,
    uncertainty: clamp01(input.uncertainty),
    dataQuality: clamp01(input.dataQuality),
    signalAgreement:
      input.signalAgreement == null ? undefined : clamp01(input.signalAgreement),
  };
}

