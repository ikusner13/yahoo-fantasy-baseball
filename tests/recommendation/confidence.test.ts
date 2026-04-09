import { describe, it, expect } from "vitest";
import {
  createRecommendation,
  isRecommendation,
  scoreRecommendationConfidence,
  summarizeConfidence,
} from "../../src/recommendation";

describe("recommendation primitives", () => {
  it("creates a stable recommendation id", () => {
    const rec = createRecommendation({
      kind: "waiver",
      action: "add",
      title: "Add a closer",
      summary: "Target the new saves source",
      basis: { delta: 0.25, uncertainty: 0.2, dataQuality: 0.9 },
    });

    expect(rec.id).toBe("waiver:add:add-a-closer");
    expect(isRecommendation(rec)).toBe(true);
    expect(rec.confidence.band).toBe("low");
  });
});

describe("scoreRecommendationConfidence", () => {
  it("returns high confidence for large delta, low uncertainty, high data quality", () => {
    const result = scoreRecommendationConfidence({
      delta: 0.85,
      uncertainty: 0.1,
      dataQuality: 0.95,
      deltaScale: 1,
      signals: [
        { source: "projection", direction: "positive", weight: 3, evidence: 0.9 },
        { source: "news", direction: "positive", weight: 2, evidence: 1 },
      ],
    });

    expect(result.score).toBeGreaterThanOrEqual(0.75);
    expect(result.band).toBe("high");
    expect(result.breakdown.deltaMagnitude).toBeGreaterThan(0.8);
    expect(result.breakdown.uncertaintyPenalty).toBeLessThan(0.2);
    expect(summarizeConfidence(result)).toBe("high");
  });

  it("returns medium confidence for a positive but noisy edge", () => {
    const result = scoreRecommendationConfidence({
      delta: 0.35,
      uncertainty: 0.45,
      dataQuality: 0.7,
      deltaScale: 1,
      signals: [
        { source: "projection", direction: "positive", weight: 2, evidence: 0.6 },
        { source: "statcast", direction: "positive", weight: 1, evidence: 0.5 },
        { source: "news", direction: "neutral", weight: 1, evidence: 0.5 },
      ],
    });

    expect(result.score).toBeGreaterThanOrEqual(0.45);
    expect(result.score).toBeLessThan(0.75);
    expect(result.band).toBe("medium");
  });

  it("returns low confidence when uncertainty overwhelms a small edge", () => {
    const result = scoreRecommendationConfidence({
      delta: 0.12,
      uncertainty: 0.9,
      dataQuality: 0.4,
      deltaScale: 1,
      signals: [
        { source: "projection", direction: "positive", weight: 1, evidence: 0.4 },
        { source: "news", direction: "negative", weight: 1, evidence: 0.9 },
      ],
    });

    expect(result.score).toBeLessThan(0.45);
    expect(result.band).toBe("low");
    expect(result.breakdown.uncertaintyPenalty).toBeCloseTo(0.9);
  });

  it("normalizes signal agreement when the caller provides it directly", () => {
    const result = scoreRecommendationConfidence({
      delta: 0.5,
      uncertainty: 0.25,
      dataQuality: 0.8,
      signalAgreement: 0.95,
    });

    expect(result.breakdown.agreementBonus).toBeCloseTo(0.95);
  });
});
