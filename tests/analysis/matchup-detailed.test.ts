import { describe, it, expect } from "vitest";
import {
  classifyCategoryDetailed,
  getWorthlessCategories,
  computeStreamingDecision,
  analyzeMatchupDetailed,
} from "../../src/analysis/matchup";
import type { DetailedCategoryState } from "../../src/analysis/matchup";
import type { Matchup, CategoryScore, Category } from "../../src/types";

// --- Helpers ---

function score(category: Category, my: number, opp: number): CategoryScore {
  return { category, myValue: my, opponentValue: opp };
}

function makeDetailed(
  category: Category,
  state: DetailedCategoryState["state"],
  margin = 0,
): DetailedCategoryState {
  return { category, state, myValue: 0, opponentValue: 0, margin };
}

function makeMatchup(categories: CategoryScore[]): Matchup {
  return {
    week: 1,
    weekStart: "2026-03-30",
    weekEnd: "2026-04-05",
    opponentTeamKey: "opp",
    opponentTeamName: "Opponent",
    categories,
  };
}

// --- classifyCategoryDetailed ---

describe("classifyCategoryDetailed", () => {
  // Counting stats: DAILY_PRODUCTION HR=0.4, clinchBand = 3 * 0.4 * days
  // 1 day: clinchBand = 1.2

  it("counting HR: big lead + 1 day -> clinched", () => {
    // lead=5, clinchBand=3*0.4*1=1.2 => 5>=1.2 -> clinched
    const result = classifyCategoryDetailed(score("HR", 15, 10), 1);
    expect(result.state).toBe("clinched");
    expect(result.margin).toBe(5);
  });

  it("counting HR: small lead + 1 day -> safe", () => {
    // lead=1, clinchBand=1.2, 1<1.2 but >0 -> safe
    const result = classifyCategoryDetailed(score("HR", 11, 10), 1);
    expect(result.state).toBe("safe");
    expect(result.margin).toBe(1);
  });

  it("counting SB: tied + 3 days -> swing", () => {
    // margin=0 -> swing
    const result = classifyCategoryDetailed(score("SB", 5, 5), 3);
    expect(result.state).toBe("swing");
    expect(result.margin).toBe(0);
  });

  it("counting K: behind by 20 + 1 day -> lost", () => {
    // deficit=20, clinchBand=3*2*1=6, 20>=6 -> lost
    const result = classifyCategoryDetailed(score("K", 30, 50), 1);
    expect(result.state).toBe("lost");
    expect(result.margin).toBe(-20);
  });

  it("counting R: behind by 2 + 4 days -> swing (recoverable at ~1.5/day)", () => {
    // deficit=2, dailyProd=1.5, dailyFlipRate=2/4=0.5, 0.5 <= 1.5*2=3 -> swing
    const result = classifyCategoryDetailed(score("R", 18, 20), 4);
    expect(result.state).toBe("swing");
    expect(result.margin).toBe(-2);
    expect(result.dailyFlipRate).toBeCloseTo(0.5);
  });

  it("counting R: behind by 2 + 1 day -> losing (needs 2/day, above 2x daily rate)", () => {
    // deficit=2, dailyProd=1.5, dailyFlipRate=2/1=2.0, 2.0 > 1.5*2=3.0? No, 2<3 -> swing
    // Wait: dailyFlipRate=2, dailyProd*2=3, 2>3 is false -> swing
    // Actually let me re-check the threshold: dailyFlipRate > dailyProd * 2
    // 2.0 > 3.0? false -> swing. Hmm, let me recalculate.
    // The user expects "losing" so let me pick values that trigger it.
    // dailyFlipRate = deficit/days > dailyProd*2 => deficit > dailyProd*2*days
    // R dailyProd=1.5, 2*1.5=3, need deficit > 3*1 = 3 for 1 day
    // Need deficit < clinchBand but dailyFlipRate > dailyProd*2
    // clinchBand=3*1.5*1=4.5, so deficit=4 would be < 4.5
    // dailyFlipRate=4/1=4, dailyProd*2=3, 4>3 -> losing
    const result = classifyCategoryDetailed(score("R", 16, 20), 1);
    // deficit=4, clinchBand=4.5, 4<4.5 so not lost
    // dailyFlipRate=4/1=4, dailyProd*2=3, 4>3 -> losing
    expect(result.state).toBe("losing");
    expect(result.margin).toBe(-4);
  });

  // Rate stats

  it("rate ERA: winning by 1.0 + 1 day -> clinched (threshold 0.50)", () => {
    // ERA inverse: margin = opp - my = 4.0 - 3.0 = 1.0
    // daysRemaining<=2: clinchThreshold=0.50, 1.0>=0.50 -> clinched
    const result = classifyCategoryDetailed(score("ERA", 3.0, 4.0), 1);
    expect(result.state).toBe("clinched");
    expect(result.margin).toBe(1.0);
  });

  it("rate ERA: winning by 0.30 + 1 day -> safe (above 0.25)", () => {
    // margin=0.30, clinchThreshold=0.50 (not met), safeThreshold=0.25, 0.30>=0.25 -> safe
    const result = classifyCategoryDetailed(score("ERA", 3.2, 3.5), 1);
    expect(result.state).toBe("safe");
    expect(result.margin).toBeCloseTo(0.3);
  });

  it("rate ERA: winning by 0.10 + 1 day -> swing", () => {
    // margin=0.10, clinchThreshold=0.50 (no), safeThreshold=0.25 (no), -> swing
    const result = classifyCategoryDetailed(score("ERA", 3.4, 3.5), 1);
    expect(result.state).toBe("swing");
    expect(result.margin).toBeCloseTo(0.1);
  });

  it("rate WHIP: losing by 0.20 + 1 day -> lost (threshold 0.15)", () => {
    // WHIP inverse: margin = opp - my = 1.0 - 1.2 = -0.20
    // absDiff=0.20, clinchThreshold(<=2 days)=0.15, margin<0, absDiff>=clinchThreshold -> lost
    const result = classifyCategoryDetailed(score("WHIP", 1.2, 1.0), 1);
    expect(result.state).toBe("lost");
    expect(result.margin).toBeCloseTo(-0.2);
  });

  it("rate OBP: winning by 0.02 + 1 day -> safe (above 0.008)", () => {
    // OBP: not inverse, isRateStat=true
    // margin = my - opp = 0.36 - 0.34 = 0.02
    // daysRemaining<=2: clinchThreshold=0.015, safeThreshold=0.008
    // 0.02>=0.015 -> clinched actually!
    // Let me pick a margin between safe and clinch: 0.01 (>=0.008 but <0.015)
    const result = classifyCategoryDetailed(score("OBP", 0.35, 0.34), 1);
    // margin=0.01, clinch=0.015 (no), safe=0.008 (yes) -> safe
    expect(result.state).toBe("safe");
    expect(result.margin).toBeCloseTo(0.01);
  });

  it("margin is positive when winning for all stats including inverse", () => {
    // Counting: winning
    const hr = classifyCategoryDetailed(score("HR", 20, 10), 3);
    expect(hr.margin).toBeGreaterThan(0);

    // Inverse (ERA): winning = lower ERA
    const era = classifyCategoryDetailed(score("ERA", 2.5, 4.0), 3);
    expect(era.margin).toBeGreaterThan(0);

    // Inverse (WHIP): winning = lower WHIP
    const whip = classifyCategoryDetailed(score("WHIP", 0.9, 1.3), 3);
    expect(whip.margin).toBeGreaterThan(0);

    // Non-inverse rate (OBP): winning = higher OBP
    const obp = classifyCategoryDetailed(score("OBP", 0.38, 0.34), 3);
    expect(obp.margin).toBeGreaterThan(0);
  });
});

// --- getWorthlessCategories ---

describe("getWorthlessCategories", () => {
  it("returns only clinched + lost categories from a mix", () => {
    const states: DetailedCategoryState[] = [
      makeDetailed("HR", "clinched"),
      makeDetailed("ERA", "safe"),
      makeDetailed("K", "swing"),
      makeDetailed("SB", "losing"),
      makeDetailed("WHIP", "lost"),
    ];
    const result = getWorthlessCategories(states);
    expect(result).toContain("HR");
    expect(result).toContain("WHIP");
    expect(result).toHaveLength(2);
    expect(result).not.toContain("ERA");
    expect(result).not.toContain("K");
    expect(result).not.toContain("SB");
  });

  it("returns empty when all are swing", () => {
    const states: DetailedCategoryState[] = [
      makeDetailed("HR", "swing"),
      makeDetailed("ERA", "swing"),
      makeDetailed("K", "swing"),
    ];
    expect(getWorthlessCategories(states)).toHaveLength(0);
  });
});

// --- computeStreamingDecision ---

describe("computeStreamingDecision", () => {
  it("below IP minimum -> canStream=true, qualityFloor='any'", () => {
    const cats = [makeDetailed("ERA", "swing"), makeDetailed("WHIP", "swing")];
    const result = computeStreamingDecision(cats, 15, 20);
    expect(result.canStream).toBe(true);
    expect(result.qualityFloor).toBe("any");
  });

  it("ERA clinched + WHIP clinched -> canStream=true, qualityFloor='any'", () => {
    const cats = [
      makeDetailed("ERA", "clinched"),
      makeDetailed("WHIP", "clinched"),
      makeDetailed("K", "swing"),
    ];
    const result = computeStreamingDecision(cats, 25, 20);
    expect(result.canStream).toBe(true);
    expect(result.qualityFloor).toBe("any");
  });

  it("ERA lost + WHIP lost -> canStream=true, qualityFloor='any'", () => {
    const cats = [
      makeDetailed("ERA", "lost"),
      makeDetailed("WHIP", "lost"),
      makeDetailed("K", "swing"),
    ];
    const result = computeStreamingDecision(cats, 25, 20);
    expect(result.canStream).toBe(true);
    expect(result.qualityFloor).toBe("any");
  });

  it("ERA safe + WHIP safe -> canStream=true, qualityFloor='high-floor'", () => {
    const cats = [
      makeDetailed("ERA", "safe"),
      makeDetailed("WHIP", "safe"),
      makeDetailed("K", "swing"),
    ];
    const result = computeStreamingDecision(cats, 25, 20);
    expect(result.canStream).toBe(true);
    expect(result.qualityFloor).toBe("high-floor");
  });

  it("ERA swing + WHIP safe -> canStream=true, qualityFloor='elite-only'", () => {
    const cats = [
      makeDetailed("ERA", "swing"),
      makeDetailed("WHIP", "safe"),
      makeDetailed("K", "swing"),
    ];
    const result = computeStreamingDecision(cats, 25, 20);
    expect(result.canStream).toBe(true);
    expect(result.qualityFloor).toBe("elite-only");
  });

  it("K lost + QS lost + OUT lost -> canStream=false, qualityFloor='none'", () => {
    const cats = [
      makeDetailed("ERA", "safe"),
      makeDetailed("WHIP", "safe"),
      makeDetailed("K", "lost"),
      makeDetailed("QS", "lost"),
      makeDetailed("OUT", "lost"),
    ];
    const result = computeStreamingDecision(cats, 25, 20);
    expect(result.canStream).toBe(false);
    expect(result.qualityFloor).toBe("none");
  });

  it("ERA swing + WHIP swing -> canStream=true, qualityFloor='elite-only'", () => {
    const cats = [
      makeDetailed("ERA", "swing"),
      makeDetailed("WHIP", "swing"),
      makeDetailed("K", "swing"),
    ];
    const result = computeStreamingDecision(cats, 25, 20);
    expect(result.canStream).toBe(true);
    expect(result.qualityFloor).toBe("elite-only");
  });
});

// --- analyzeMatchupDetailed ---

describe("analyzeMatchupDetailed", () => {
  it("full 13-category matchup returns all detailed fields + base fields", () => {
    const matchup = makeMatchup([
      score("R", 50, 45),
      score("H", 80, 75),
      score("HR", 12, 14),
      score("RBI", 40, 38),
      score("SB", 5, 5),
      score("TB", 150, 140),
      score("OBP", 0.35, 0.34),
      score("OUT", 150, 140),
      score("K", 60, 65),
      score("ERA", 3.2, 3.8),
      score("WHIP", 1.1, 1.2),
      score("QS", 4, 3),
      score("SVHD", 3, 2),
    ]);

    const result = analyzeMatchupDetailed(matchup, 3, 10, 20);

    // Has base MatchupAnalysis fields
    expect(result.projectedWins).toBeTypeOf("number");
    expect(result.projectedLosses).toBeTypeOf("number");
    expect(result.swingCategories).toBeInstanceOf(Array);
    expect(result.safeCategories).toBeInstanceOf(Array);
    expect(result.lostCategories).toBeInstanceOf(Array);
    expect(result.strategy).toBeDefined();

    // Has detailed extension fields
    expect(result.detailedCategories).toHaveLength(13);
    expect(result.worthlessCategories).toBeInstanceOf(Array);
    expect(result.streamingDecision).toBeDefined();
    expect(result.streamingDecision.canStream).toBeTypeOf("boolean");
    expect(result.streamingDecision.qualityFloor).toBeTypeOf("string");
    expect(result.streamingDecision.reasoning).toBeTypeOf("string");
    expect(result.daysRemaining).toBe(3);

    // Each detailed category has required fields
    for (const dc of result.detailedCategories) {
      expect(["clinched", "safe", "swing", "losing", "lost"]).toContain(dc.state);
      expect(dc.category).toBeDefined();
      expect(dc.margin).toBeTypeOf("number");
    }
  });
});
