import { describe, it, expect } from "vite-plus/test";
import { classifyCategory, shouldProtectRatios, analyzeMatchup } from "../../src/analysis/matchup";
import type { Matchup, CategoryScore, Category } from "../../src/types";

// --- Helpers ---

function cat(category: Category, my: number, opp: number): CategoryScore {
  return { category, myValue: my, opponentValue: opp };
}

function makeMatchup(categories: CategoryScore[]): Matchup {
  return {
    week: 1,
    opponentTeamKey: "opp",
    opponentTeamName: "Opponent",
    categories,
  };
}

describe("classifyCategory", () => {
  it("counting stat: big lead = winning", () => {
    expect(classifyCategory(cat("HR", 20, 8))).toBe("winning");
  });

  it("counting stat: big deficit = losing", () => {
    expect(classifyCategory(cat("SB", 2, 15))).toBe("losing");
  });

  it("counting stat: close = swing", () => {
    expect(classifyCategory(cat("HR", 12, 14))).toBe("swing");
  });

  it("rate stat: lower ERA = winning", () => {
    // myValue 2.5 vs opponent 4.0 => pctDiff = (4.0 - 2.5)/4.0 = 0.375 > 0.05
    expect(classifyCategory(cat("ERA", 2.5, 4.0))).toBe("winning");
  });

  it("rate stat: higher ERA = losing", () => {
    expect(classifyCategory(cat("ERA", 5.0, 3.0))).toBe("losing");
  });

  it("rate stat: close WHIP = swing", () => {
    // 1.20 vs 1.22 => pctDiff = (1.22 - 1.20)/1.22 = 0.016 < 0.05
    expect(classifyCategory(cat("WHIP", 1.2, 1.22))).toBe("swing");
  });

  it("both zero = swing", () => {
    expect(classifyCategory(cat("HR", 0, 0))).toBe("swing");
    expect(classifyCategory(cat("ERA", 0, 0))).toBe("swing");
  });
});

describe("shouldProtectRatios", () => {
  it("true when winning ERA and WHIP", () => {
    const m = makeMatchup([cat("ERA", 2.5, 4.5), cat("WHIP", 0.95, 1.35), cat("HR", 10, 12)]);
    expect(shouldProtectRatios(m)).toBe(true);
  });

  it("true when winning ERA + swing WHIP", () => {
    const m = makeMatchup([
      cat("ERA", 2.5, 4.5),
      cat("WHIP", 1.2, 1.22), // swing
    ]);
    expect(shouldProtectRatios(m)).toBe(true);
  });

  it("false when losing both ERA and WHIP", () => {
    const m = makeMatchup([cat("ERA", 5.0, 3.0), cat("WHIP", 1.5, 1.1)]);
    expect(shouldProtectRatios(m)).toBe(false);
  });

  it("false when no ERA/WHIP categories present", () => {
    const m = makeMatchup([cat("HR", 10, 12)]);
    expect(shouldProtectRatios(m)).toBe(false);
  });
});

describe("analyzeMatchup", () => {
  it("winning all categories -> all safe, conservative strategy", () => {
    // Note: OBP excluded because classifyCategory uses max(my,opp,1) as denom
    // for counting stats, so sub-1.0 values can't hit the 15% threshold
    const m = makeMatchup([
      cat("R", 80, 40),
      cat("H", 120, 60),
      cat("HR", 25, 10),
      cat("RBI", 90, 45),
      cat("SB", 20, 5),
      cat("TB", 200, 100),
      cat("K", 100, 50),
      cat("ERA", 2.0, 5.0),
      cat("WHIP", 0.9, 1.5),
      cat("QS", 8, 2),
      cat("SVHD", 6, 1),
      cat("OUT", 200, 100),
    ]);
    const analysis = analyzeMatchup(m);
    expect(analysis.safeCategories.length).toBe(m.categories.length);
    expect(analysis.lostCategories.length).toBe(0);
    expect(analysis.swingCategories.length).toBe(0);
    expect(analysis.strategy.protectRatios).toBe(true);
    expect(analysis.strategy.streamPitchers).toBe(false);
  });

  it("losing all categories -> all lost", () => {
    const m = makeMatchup([
      cat("R", 40, 80),
      cat("H", 60, 120),
      cat("HR", 10, 25),
      cat("RBI", 45, 90),
      cat("SB", 5, 20),
      cat("TB", 100, 200),
      cat("K", 50, 100),
      cat("ERA", 5.0, 2.0),
      cat("WHIP", 1.5, 0.9),
      cat("QS", 2, 8),
      cat("SVHD", 1, 6),
      cat("OUT", 100, 200),
    ]);
    const analysis = analyzeMatchup(m);
    expect(analysis.lostCategories.length).toBe(m.categories.length);
    expect(analysis.safeCategories.length).toBe(0);
  });

  it("close matchup -> identifies swing categories", () => {
    const m = makeMatchup([
      cat("HR", 12, 14), // swing
      cat("SB", 2, 15), // losing
      cat("K", 85, 82), // swing
      cat("ERA", 3.5, 3.6), // swing (close)
    ]);
    const analysis = analyzeMatchup(m);
    expect(analysis.swingCategories).toContain("HR");
    expect(analysis.swingCategories).toContain("K");
    expect(analysis.lostCategories).toContain("SB");
  });

  it("ahead in ERA/WHIP -> protectRatios true", () => {
    const m = makeMatchup([cat("ERA", 2.5, 4.5), cat("WHIP", 1.0, 1.4), cat("K", 60, 80)]);
    const analysis = analyzeMatchup(m);
    expect(analysis.strategy.protectRatios).toBe(true);
  });

  it("behind in K -> chaseStrikeouts true", () => {
    const m = makeMatchup([
      cat("K", 55, 58), // swing
      cat("ERA", 2.5, 4.5),
      cat("WHIP", 1.0, 1.4),
    ]);
    const analysis = analyzeMatchup(m);
    expect(analysis.strategy.chaseStrikeouts).toBe(true);
  });

  it("SB is swing -> prioritizeSpeed true", () => {
    const m = makeMatchup([
      cat("SB", 10, 11), // swing
      cat("ERA", 3.5, 3.5),
      cat("WHIP", 1.2, 1.2),
    ]);
    const analysis = analyzeMatchup(m);
    expect(analysis.strategy.prioritizeSpeed).toBe(true);
  });

  it("streamPitchers false when protecting ratios", () => {
    const m = makeMatchup([
      cat("ERA", 2.0, 4.5),
      cat("WHIP", 0.9, 1.4),
      cat("K", 50, 52), // swing
      cat("QS", 4, 5), // swing
    ]);
    const analysis = analyzeMatchup(m);
    expect(analysis.strategy.protectRatios).toBe(true);
    expect(analysis.strategy.streamPitchers).toBe(false);
  });

  it("projectedWins + projectedLosses + swing = total categories", () => {
    const m = makeMatchup([
      cat("HR", 12, 14),
      cat("K", 85, 82),
      cat("ERA", 2.5, 4.5),
      cat("SB", 2, 15),
    ]);
    const analysis = analyzeMatchup(m);
    const total =
      analysis.safeCategories.length +
      analysis.lostCategories.length +
      analysis.swingCategories.length;
    expect(total).toBe(m.categories.length);
    expect(analysis.projectedWins).toBe(analysis.safeCategories.length);
    expect(analysis.projectedLosses).toBe(analysis.lostCategories.length);
  });
});
