import { describe, it, expect } from "vite-plus/test";
import { computeZScores, applyVarianceAdjustment } from "../../src/analysis/valuations";
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

describe("applyVarianceAdjustment", () => {
  it("full-time batter gets consistency bonus over part-timer", () => {
    const projections: PlayerProjection[] = [
      // Full-time: high counting stats -> low CV -> consistency bonus
      batter("fulltime", { pa: 650, r: 100, h: 180, hr: 35, rbi: 110, sb: 20, tb: 320 }),
      // Part-timer: low counting stats -> high CV -> consistency penalty
      batter("parttime", { pa: 250, r: 30, h: 55, hr: 8, rbi: 30, sb: 3, tb: 85 }),
      // Average filler for meaningful z-scores
      batter("avg1", {}),
      batter("avg2", {}),
    ];

    const zScores = computeZScores(projections);
    const adjusted = applyVarianceAdjustment(zScores, projections);

    const fulltime = adjusted.find((v) => v.yahooId === "fulltime")!;
    const parttime = adjusted.find((v) => v.yahooId === "parttime")!;

    // Full-timer should have consistencyFactor >= 1 (bonus)
    expect(fulltime.consistencyFactor).toBeGreaterThanOrEqual(1.0);
    // Part-timer should have consistencyFactor < 1 (penalty)
    expect(parttime.consistencyFactor).toBeLessThan(1.0);

    // Full-timer's weekly variance (CV) should be lower
    expect(fulltime.weeklyVariance).toBeLessThan(parttime.weeklyVariance);

    // rawZScore preserved
    const origFulltime = zScores.find((v) => v.yahooId === "fulltime")!;
    expect(fulltime.rawZScore).toBeCloseTo(origFulltime.totalZScore);
  });

  it("pitcher with high K/QS volume gets consistency bonus over low-volume reliever", () => {
    const projections: PlayerProjection[] = [
      // Workhorse SP: 200 IP, 220 K, 20 QS
      pitcher("workhorse", { ip: 200, outs: 600, k: 220, qs: 20, svhd: 0 }),
      // Low-leverage RP: 50 IP, 45 K, 0 QS, 5 SVHD
      pitcher("middleRP", { ip: 50, outs: 150, k: 45, qs: 0, svhd: 5 }),
      // Filler
      pitcher("avg1", {}),
      pitcher("avg2", {}),
    ];

    const zScores = computeZScores(projections);
    const adjusted = applyVarianceAdjustment(zScores, projections);

    const workhorse = adjusted.find((v) => v.yahooId === "workhorse")!;
    const middleRP = adjusted.find((v) => v.yahooId === "middleRP")!;

    // Workhorse has higher volume -> lower CV -> higher consistency factor
    expect(workhorse.consistencyFactor).toBeGreaterThan(middleRP.consistencyFactor);
    expect(workhorse.weeklyVariance).toBeLessThan(middleRP.weeklyVariance);
  });

  it("consistency factor is clamped to [0.85, 1.15]", () => {
    // Extreme spread: one massive player, one tiny
    const projections: PlayerProjection[] = [
      batter("monster", { pa: 700, r: 130, h: 210, hr: 50, rbi: 140, sb: 40, tb: 400 }),
      batter("bench", { pa: 80, r: 5, h: 12, hr: 1, rbi: 5, sb: 0, tb: 14 }),
      batter("avg1", {}),
    ];

    const zScores = computeZScores(projections);
    const adjusted = applyVarianceAdjustment(zScores, projections);

    for (const v of adjusted) {
      expect(v.consistencyFactor).toBeGreaterThanOrEqual(0.85);
      expect(v.consistencyFactor).toBeLessThanOrEqual(1.15);
    }
  });

  it("returns empty array for empty input", () => {
    expect(applyVarianceAdjustment([], [])).toEqual([]);
  });

  it("results are sorted by adjusted totalZScore descending", () => {
    const projections: PlayerProjection[] = [
      batter("b1", { hr: 40, rbi: 120, r: 100 }),
      batter("b2", { hr: 10, rbi: 40, r: 50 }),
      batter("b3", { hr: 25, rbi: 80, r: 75 }),
    ];

    const zScores = computeZScores(projections);
    const adjusted = applyVarianceAdjustment(zScores, projections);

    for (let i = 1; i < adjusted.length; i++) {
      expect(adjusted[i - 1].totalZScore).toBeGreaterThanOrEqual(adjusted[i].totalZScore);
    }
  });

  it("custom remainingWeeks parameter changes CV values", () => {
    const projections: PlayerProjection[] = [
      batter("b1", { hr: 20, r: 70, rbi: 70 }),
      batter("b2", { hr: 10, r: 40, rbi: 35 }),
      batter("b3", {}),
    ];

    const zScores = computeZScores(projections);
    const adj22 = applyVarianceAdjustment(zScores, projections, 22);
    const adj10 = applyVarianceAdjustment(zScores, projections, 10);

    const b1_22 = adj22.find((v) => v.yahooId === "b1")!;
    const b1_10 = adj10.find((v) => v.yahooId === "b1")!;

    // Fewer remaining weeks -> higher weekly expected -> lower CV
    expect(b1_10.weeklyVariance).toBeLessThan(b1_22.weeklyVariance);
  });
});
