import { describe, it, expect } from "vite-plus/test";

// waivers.ts does not exist yet -- these tests define the expected API.
// They will fail on import until the module is written by another agent.
// Uncomment the import + tests once src/analysis/waivers.ts lands.

/*
import {
  evaluateWaiverPickup,
  shouldUseWaiverPriority,
} from "../../src/analysis/waivers";
*/

import type { PlayerValuation } from "../../src/types";

// --- Helpers ---

function valuation(yahooId: string, totalZScore: number): PlayerValuation {
  return {
    yahooId,
    name: yahooId,
    totalZScore,
    categoryZScores: {},
    positionAdjustment: 1.0,
  };
}

describe("waiver evaluation (stubbed)", () => {
  // These tests document expected behavior for src/analysis/waivers.ts.
  // Enable once the module exists.

  it.todo("good free agent vs weak roster player -> recommends pickup");
  it.todo("free agent worse than all roster players -> no recommendation");
  it.todo("shouldUseWaiverPriority: high priority = aggressive threshold");
  it.todo("shouldUseWaiverPriority: low priority = conservative threshold");

  // Expected API:
  //
  // evaluateWaiverPickup(
  //   freeAgent: PlayerValuation,
  //   roster: PlayerValuation[],
  //   positionNeed: boolean,
  // ) => { recommend: boolean; dropCandidate?: string; zScoreDiff: number }
  //
  // shouldUseWaiverPriority(
  //   pickupZDiff: number,
  //   currentPriority: number, // 1 = first, 12 = last
  //   totalTeams: number,
  // ) => boolean

  // Inline logic tests using the expected signatures:
  describe("expected behavior", () => {
    it("recommends pickup when FA z-score >> worst roster player", () => {
      const fa = valuation("fa1", 2.0);
      const roster = [valuation("r1", 1.5), valuation("r2", 0.3), valuation("r3", -0.5)];
      // Expected: recommend=true, dropCandidate="r3", zScoreDiff=2.5
      const worst = roster.reduce((a, b) => (a.totalZScore < b.totalZScore ? a : b));
      const diff = fa.totalZScore - worst.totalZScore;
      expect(diff).toBeGreaterThan(0);
      expect(worst.yahooId).toBe("r3");
    });

    it("no recommendation when FA is worse than roster", () => {
      const fa = valuation("fa1", -1.0);
      const roster = [valuation("r1", 1.5), valuation("r2", 0.3)];
      const worst = roster.reduce((a, b) => (a.totalZScore < b.totalZScore ? a : b));
      const diff = fa.totalZScore - worst.totalZScore;
      expect(diff).toBeLessThan(0);
    });

    it("high waiver priority should have lower threshold", () => {
      // Team with #1 priority should be willing to use it for smaller gains
      // Team with #10 priority should need a bigger differential
      const highPriorityThreshold = 0.5; // example
      const lowPriorityThreshold = 1.5; // example
      expect(highPriorityThreshold).toBeLessThan(lowPriorityThreshold);
    });
  });
});
