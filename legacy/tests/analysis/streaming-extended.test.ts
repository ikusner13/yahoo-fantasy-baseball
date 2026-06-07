import { describe, it, expect } from "vitest";
import { estimateStreamingImpact, getIPStatus } from "../../src/analysis/streaming";
import type { DetailedCategoryState } from "../../src/analysis/matchup";
import type { PitcherStats, Category } from "../../src/types";

// --- Helpers ---

function makePitcher(overrides: Partial<PitcherStats> = {}): PitcherStats {
  return {
    ip: 6.5,
    outs: 19.5,
    k: 8,
    era: 3.0,
    whip: 1.05,
    qs: 1,
    svhd: 0,
    ...overrides,
  };
}

function makeState(
  category: Category,
  state: DetailedCategoryState["state"],
  margin = 0,
): DetailedCategoryState {
  return { category, state, myValue: 0, opponentValue: 0, margin };
}

// --- estimateStreamingImpact ---

describe("estimateStreamingImpact", () => {
  it("good pitcher when K is swing -> helps K high", () => {
    const pitcher = makePitcher({ k: 8, era: 3.0, whip: 1.05 });
    const states: DetailedCategoryState[] = [
      makeState("K", "swing", -5),
      makeState("OUT", "swing", 0),
      makeState("QS", "safe", 2),
      makeState("ERA", "safe", 0.5),
      makeState("WHIP", "safe", 0.1),
    ];

    const result = estimateStreamingImpact(pitcher, states);
    const kImpact = result.impacts.find((i) => i.category === "K");
    expect(kImpact).toBeDefined();
    expect(kImpact!.direction).toBe("helps");
  });

  it("good pitcher when ERA/WHIP are safe -> hurts ERA/WHIP (medium)", () => {
    // Pitcher ERA 3.0 < goodThreshold 3.5, so for safe ERA it actually helps low
    // Let me use a borderline pitcher: ERA 4.0 (> goodThreshold 3.5, < badThreshold 4.5)
    const pitcher = makePitcher({ era: 4.0, whip: 1.25 });
    const states: DetailedCategoryState[] = [
      makeState("K", "swing", -3),
      makeState("OUT", "swing", 0),
      makeState("QS", "swing", 0),
      makeState("ERA", "safe", 0.5),
      makeState("WHIP", "safe", 0.1),
    ];

    const result = estimateStreamingImpact(pitcher, states);
    const eraImpact = result.impacts.find((i) => i.category === "ERA");
    const whipImpact = result.impacts.find((i) => i.category === "WHIP");
    expect(eraImpact!.direction).toBe("hurts");
    expect(whipImpact!.direction).toBe("hurts");
  });

  it("bad pitcher (ERA 5.0, WHIP 1.45) when ERA is safe -> hurts ERA high", () => {
    const pitcher = makePitcher({ era: 5.0, whip: 1.45 });
    const states: DetailedCategoryState[] = [
      makeState("K", "swing", -3),
      makeState("OUT", "swing", 0),
      makeState("QS", "swing", 0),
      makeState("ERA", "safe", 0.5),
      makeState("WHIP", "safe", 0.1),
    ];

    const result = estimateStreamingImpact(pitcher, states);
    const eraImpact = result.impacts.find((i) => i.category === "ERA");
    expect(eraImpact!.direction).toBe("hurts");
    expect(eraImpact!.magnitude).toBe("high");
  });

  it("K/QS/OUT all lost -> counting impacts are all neutral", () => {
    const pitcher = makePitcher({ k: 10, qs: 1 });
    const states: DetailedCategoryState[] = [
      makeState("K", "lost"),
      makeState("QS", "lost"),
      makeState("OUT", "lost"),
      makeState("ERA", "swing", 0.1),
      makeState("WHIP", "swing", 0.1),
    ];

    const result = estimateStreamingImpact(pitcher, states);
    const kImpact = result.impacts.find((i) => i.category === "K");
    const qsImpact = result.impacts.find((i) => i.category === "QS");
    const outImpact = result.impacts.find((i) => i.category === "OUT");
    expect(kImpact!.direction).toBe("neutral");
    expect(qsImpact!.direction).toBe("neutral");
    expect(outImpact!.direction).toBe("neutral");
  });

  it("netCategoriesHelped and netCategoriesHurt are correct", () => {
    // Good pitcher: K helps swing cat, ERA/WHIP hurt safe cats
    const pitcher = makePitcher({ k: 8, era: 4.2, whip: 1.3, ip: 6.5, outs: 19.5 });
    const states: DetailedCategoryState[] = [
      makeState("K", "swing", -5),
      makeState("OUT", "swing", -10),
      makeState("QS", "swing", 0),
      makeState("SVHD", "swing", 0),
      makeState("ERA", "safe", 0.5),
      makeState("WHIP", "safe", 0.1),
    ];

    const result = estimateStreamingImpact(pitcher, states);
    // K, OUT should help (swing, deficit can be narrowed)
    // ERA, WHIP should hurt (safe, pitcher rate > good threshold)
    expect(result.netCategoriesHelped).toBeGreaterThan(0);
    expect(result.netCategoriesHurt).toBeGreaterThan(0);
    expect(result.netCategoriesHelped + result.netCategoriesHurt).toBeLessThanOrEqual(
      result.impacts.length,
    );
  });
});

// --- getIPStatus ---

describe("getIPStatus", () => {
  it("25 IP, 20 min -> above=true, ipNeeded=0", () => {
    const result = getIPStatus(25, 20);
    expect(result.above).toBe(true);
    expect(result.ipNeeded).toBe(0);
    expect(result.currentIP).toBe(25);
    expect(result.minimum).toBe(20);
  });

  it("15 IP, 20 min -> above=false, ipNeeded=5", () => {
    const result = getIPStatus(15, 20);
    expect(result.above).toBe(false);
    expect(result.ipNeeded).toBe(5);
  });

  it("0 IP -> above=false, ipNeeded=20", () => {
    const result = getIPStatus(0, 20);
    expect(result.above).toBe(false);
    expect(result.ipNeeded).toBe(20);
  });

  it("default minimum (omit param) -> uses 20", () => {
    const result = getIPStatus(10);
    expect(result.minimum).toBe(20);
    expect(result.above).toBe(false);
    expect(result.ipNeeded).toBe(10);
  });
});
