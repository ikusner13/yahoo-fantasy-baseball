import { describe, expect, it } from "vitest";
import { shouldReviewPickup } from "../../src/recommendation/waiver-review";
import type { PickupRecommendation } from "../../src/analysis/waivers";

function makePickup(overrides: Partial<PickupRecommendation> = {}): PickupRecommendation {
  return {
    add: {
      yahooId: "add-1",
      name: "Spec Add",
      team: "SD",
      positions: ["RP"],
    },
    drop: {
      yahooId: "drop-1",
      name: "Bench Bat",
      team: "NYY",
      positions: ["OF"],
    },
    netValue: 1.2,
    reasoning: "Win odds 52% → 53.2%. Helps SVHD.",
    winProbabilityDelta: 0.012,
    expectedCategoryWinsDelta: 0.18,
    targetCategories: ["SVHD"],
    ...overrides,
  };
}

describe("shouldReviewPickup", () => {
  it("reviews marginal but actionable edges", () => {
    expect(shouldReviewPickup(makePickup())).toBe(true);
  });

  it("does not review strong, obvious upgrades", () => {
    expect(
      shouldReviewPickup(
        makePickup({
          winProbabilityDelta: 0.045,
          expectedCategoryWinsDelta: 0.5,
        }),
      ),
    ).toBe(false);
  });

  it("reviews recommendations with no clear target categories", () => {
    expect(
      shouldReviewPickup(
        makePickup({
          targetCategories: [],
          winProbabilityDelta: 0.003,
          expectedCategoryWinsDelta: 0.08,
        }),
      ),
    ).toBe(true);
  });
});
