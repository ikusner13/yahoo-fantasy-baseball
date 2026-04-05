import { describe, it, expect } from "vite-plus/test";
import { computeZScores } from "../../src/analysis/valuations";
import type { PlayerProjection } from "../../src/types";

function batter(
  id: string,
  stats: {
    pa?: number;
    r?: number;
    h?: number;
    hr?: number;
    rbi?: number;
    sb?: number;
    tb?: number;
    obp?: number;
  },
): PlayerProjection {
  return {
    yahooId: id,
    playerType: "batter",
    batting: {
      pa: stats.pa ?? 600,
      r: stats.r ?? 70,
      h: stats.h ?? 140,
      hr: stats.hr ?? 20,
      rbi: stats.rbi ?? 70,
      sb: stats.sb ?? 10,
      tb: stats.tb ?? 230,
      obp: stats.obp ?? 0.33,
    },
    updatedAt: "2026-04-01",
  };
}

function pitcher(
  id: string,
  stats: {
    ip?: number;
    outs?: number;
    k?: number;
    era?: number;
    whip?: number;
    qs?: number;
    svhd?: number;
  },
): PlayerProjection {
  return {
    yahooId: id,
    playerType: "pitcher",
    pitching: {
      ip: stats.ip ?? 180,
      outs: stats.outs ?? (stats.ip ?? 180) * 3,
      k: stats.k ?? 180,
      era: stats.era ?? 3.5,
      whip: stats.whip ?? 1.2,
      qs: stats.qs ?? 15,
      svhd: stats.svhd ?? 0,
    },
    updatedAt: "2026-04-01",
  };
}

describe("computeZScores", () => {
  it("returns empty array for empty input", () => {
    expect(computeZScores([])).toEqual([]);
  });

  it("single batter gets z-score of 0 (no variance)", () => {
    const result = computeZScores([batter("p1", { hr: 30 })]);
    expect(result).toHaveLength(1);
    expect(result[0].totalZScore).toBe(0);
    // Every category z-score should be 0
    for (const z of Object.values(result[0].categoryZScores)) {
      expect(z).toBe(0);
    }
  });

  it("single pitcher gets z-score of 0 (no variance)", () => {
    const result = computeZScores([pitcher("sp1", { era: 2.5 })]);
    expect(result).toHaveLength(1);
    expect(result[0].totalZScore).toBe(0);
  });

  it("best batter has highest totalZScore", () => {
    const projections: PlayerProjection[] = [
      batter("star", { r: 110, h: 190, hr: 40, rbi: 120, sb: 30, tb: 340, obp: 0.4 }),
      batter("avg", { r: 75, h: 150, hr: 22, rbi: 75, sb: 12, tb: 240, obp: 0.33 }),
      batter("weak", { r: 50, h: 120, hr: 10, rbi: 45, sb: 3, tb: 170, obp: 0.28 }),
    ];
    const result = computeZScores(projections);
    expect(result[0].yahooId).toBe("star");
    expect(result[0].totalZScore).toBeGreaterThan(result[1].totalZScore);
    expect(result[1].totalZScore).toBeGreaterThan(result[2].totalZScore);
  });

  it("inverse categories: low ERA yields positive z-score", () => {
    const projections: PlayerProjection[] = [
      pitcher("ace", { era: 2.0, whip: 0.9, k: 250 }),
      pitcher("mid", { era: 3.8, whip: 1.2, k: 170 }),
      pitcher("bad", { era: 5.5, whip: 1.5, k: 120 }),
    ];
    const result = computeZScores(projections);
    const ace = result.find((v) => v.yahooId === "ace")!;
    const bad = result.find((v) => v.yahooId === "bad")!;

    // Ace should have positive ERA z-score (low ERA = good = positive after inversion)
    expect(ace.categoryZScores.ERA).toBeGreaterThan(0);
    // Bad pitcher should have negative ERA z-score
    expect(bad.categoryZScores.ERA).toBeLessThan(0);

    // Same for WHIP
    expect(ace.categoryZScores.WHIP).toBeGreaterThan(0);
    expect(bad.categoryZScores.WHIP).toBeLessThan(0);
  });

  it("all players get category-level z-scores", () => {
    const projections: PlayerProjection[] = [
      batter("b1", { hr: 30, sb: 20 }),
      batter("b2", { hr: 15, sb: 5 }),
      pitcher("p1", { era: 3.0, k: 200 }),
      pitcher("p2", { era: 4.5, k: 150 }),
    ];
    const result = computeZScores(projections);
    expect(result).toHaveLength(4);

    // Batters should have batting category z-scores
    const b1 = result.find((v) => v.yahooId === "b1")!;
    expect(b1.categoryZScores.HR).toBeDefined();
    expect(b1.categoryZScores.SB).toBeDefined();
    expect(b1.categoryZScores.R).toBeDefined();

    // Pitchers should have pitching category z-scores
    const p1 = result.find((v) => v.yahooId === "p1")!;
    expect(p1.categoryZScores.ERA).toBeDefined();
    expect(p1.categoryZScores.K).toBeDefined();
    expect(p1.categoryZScores.WHIP).toBeDefined();
  });

  it("results are sorted by totalZScore descending", () => {
    const projections: PlayerProjection[] = [
      batter("b1", { hr: 10, rbi: 40 }),
      batter("b2", { hr: 40, rbi: 120 }),
      batter("b3", { hr: 25, rbi: 80 }),
    ];
    const result = computeZScores(projections);
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].totalZScore).toBeGreaterThanOrEqual(result[i].totalZScore);
    }
  });

  it("mixed batters and pitchers are all included and sorted", () => {
    const projections: PlayerProjection[] = [
      batter("b1", { hr: 40, rbi: 120, obp: 0.42 }),
      pitcher("p1", { era: 1.8, whip: 0.85, k: 280 }),
      batter("b2", { hr: 5, rbi: 30, obp: 0.25 }),
      pitcher("p2", { era: 5.8, whip: 1.6, k: 90 }),
    ];
    const result = computeZScores(projections);
    expect(result).toHaveLength(4);
    // Sorted descending
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].totalZScore).toBeGreaterThanOrEqual(result[i].totalZScore);
    }
  });
});
