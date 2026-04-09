import type {
  ConfidenceAssessment,
  ConfidenceBand,
  ConfidenceBreakdown,
  RecommendationSignal,
  RecommendationBasis,
} from "./types";
import { normalizeBasis } from "./types";

export interface ConfidenceInput extends RecommendationBasis {
  signals?: RecommendationSignal[];
  deltaScale?: number;
}

const DEFAULT_DELTA_SCALE = 1;

function clamp01(value: number): number {
  if (Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function bandFromScore(score: number): ConfidenceBand {
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function deltaComponent(delta: number, scale: number): number {
  const normalizedScale = scale > 0 ? scale : DEFAULT_DELTA_SCALE;
  return clamp01(Math.abs(delta) / normalizedScale);
}

function signalAgreement(signals?: RecommendationSignal[]): number {
  if (!signals || signals.length === 0) return 0.5;

  const totalWeight = signals.reduce((sum, signal) => sum + Math.max(0, signal.weight), 0);
  if (totalWeight === 0) return 0.5;

  const directionalWeight = signals.reduce((sum, signal) => {
    if (signal.direction === "neutral") return sum;
    const signed = signal.direction === "positive" ? 1 : -1;
    return sum + signed * Math.max(0, signal.weight) * clamp01(signal.evidence);
  }, 0);

  const balance = Math.abs(directionalWeight) / totalWeight;
  return clamp01(0.5 + balance / 2);
}

export function scoreRecommendationConfidence(input: ConfidenceInput): ConfidenceAssessment {
  const basis = normalizeBasis(input);
  const scale = input.deltaScale ?? DEFAULT_DELTA_SCALE;
  const deltaMagnitude = deltaComponent(basis.delta, scale);
  const uncertaintyPenalty = clamp01(basis.uncertainty);
  const dataQualityBonus = clamp01(basis.dataQuality);
  const agreementBonus = clamp01(
    basis.signalAgreement ?? signalAgreement(input.signals),
  );

  const rawScore =
    0.2 +
    deltaMagnitude * 0.5 +
    dataQualityBonus * 0.2 +
    agreementBonus * 0.15 -
    uncertaintyPenalty * 0.25;

  const score = clamp01(rawScore);

  const breakdown: ConfidenceBreakdown = {
    deltaMagnitude,
    uncertaintyPenalty,
    dataQualityBonus,
    agreementBonus,
  };

  return {
    score,
    band: bandFromScore(score),
    breakdown,
  };
}

export function summarizeConfidence(assessment: ConfidenceAssessment): string {
  const percent = Math.min(99, Math.round(assessment.score * 100));
  return `${assessment.band} (${percent}%)`;
}
