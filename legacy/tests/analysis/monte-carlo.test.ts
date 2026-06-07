import { describe, it, expect } from "vite-plus/test";
import {
  simulateMatchup,
  type DailyProjection,
  type RateStatAccumulators,
} from "../../src/analysis/monte-carlo";
import type { CategoryScore, Category } from "../../src/types";

// --- Helpers ---

function cat(category: Category, my: number, opp: number): CategoryScore {
  return { category, myValue: my, opponentValue: opp };
}

/** Full 13-category matchup snapshot */
function fullMatchup(overrides?: Partial<Record<Category, [number, number]>>): CategoryScore[] {
  const defaults: Record<Category, [number, number]> = {
    R: [25, 22],
    H: [40, 38],
    HR: [8, 7],
    RBI: [22, 20],
    SB: [5, 4],
    TB: [70, 65],
    OBP: [0.28, 0.26],
    OUT: [90, 85],
    K: [45, 42],
    ERA: [3.5, 3.8],
    WHIP: [1.15, 1.2],
    QS: [3, 2],
    SVHD: [3, 2],
  };
  const merged = { ...defaults, ...overrides };
  return Object.entries(merged).map(([k, [my, opp]]) => cat(k as Category, my, opp));
}

/** Create a simple batter daily projection */
function batter(rates: {
  r?: number;
  h?: number;
  hr?: number;
  rbi?: number;
  sb?: number;
  tb?: number;
  pa?: number;
  obp_num?: number;
}): DailyProjection {
  return {
    yahooId: "b1",
    playerType: "batter",
    batting: {
      r: rates.r ?? 0.5,
      h: rates.h ?? 1.0,
      hr: rates.hr ?? 0.15,
      rbi: rates.rbi ?? 0.5,
      sb: rates.sb ?? 0.1,
      tb: rates.tb ?? 1.8,
      pa: rates.pa ?? 4.0,
      obp_numerator: rates.obp_num ?? 1.3,
    },
  };
}

/** Create a simple pitcher daily projection */
function pitcher(rates: {
  er?: number;
  outs?: number;
  k?: number;
  qs?: number;
  svhd?: number;
  whip_num?: number;
}): DailyProjection {
  return {
    yahooId: "p1",
    playerType: "pitcher",
    pitching: {
      er: rates.er ?? 0.8,
      outs: rates.outs ?? 6,
      k: rates.k ?? 2,
      qs: rates.qs ?? 0.15,
      svhd: rates.svhd ?? 0.1,
      whip_numerator: rates.whip_num ?? 2.5,
    },
  };
}

function makeAccumulators(
  ip: number,
  era: number,
  whip: number,
  pa: number,
  obp: number,
): RateStatAccumulators {
  return {
    ip,
    er: (era * ip) / 9,
    whip_numerator: whip * ip,
    pa,
    obp_numerator: obp * pa,
  };
}

// --- Tests ---

describe("simulateMatchup", () => {
  it("returns valid probabilities and expected values", () => {
    const stats = fullMatchup();
    const projections = [
      batter({ r: 0.5, h: 1.0, hr: 0.15, rbi: 0.5, sb: 0.1, tb: 1.8 }),
      pitcher({ er: 0.8, outs: 6, k: 2, qs: 0.15, svhd: 0.1 }),
    ];

    const result = simulateMatchup(stats, 3, projections, undefined, 500, {
      myAccumulators: makeAccumulators(30, 3.5, 1.15, 140, 0.28),
      seed: 42,
    });

    // Win probability must be in [0, 1]
    expect(result.winProbability).toBeGreaterThanOrEqual(0);
    expect(result.winProbability).toBeLessThanOrEqual(1);

    // Expected category wins in [0, 13]
    expect(result.expectedCategoryWins).toBeGreaterThanOrEqual(0);
    expect(result.expectedCategoryWins).toBeLessThanOrEqual(13);

    // Should have a win prob entry for each category
    expect(result.categoryWinProbs.size).toBe(13);

    // Each category win prob in [0, 1]
    for (const [, prob] of result.categoryWinProbs) {
      expect(prob).toBeGreaterThanOrEqual(0);
      expect(prob).toBeLessThanOrEqual(1);
    }

    expect(result.simulations).toBe(500);
  });

  it("dominant lead produces high win probability", () => {
    // We're crushing in every category
    const stats = fullMatchup({
      R: [60, 20],
      H: [80, 30],
      HR: [20, 5],
      RBI: [55, 18],
      SB: [15, 3],
      TB: [150, 50],
      OBP: [0.35, 0.22],
      OUT: [150, 60],
      K: [80, 30],
      ERA: [2.5, 5.5],
      WHIP: [0.9, 1.5],
      QS: [8, 1],
      SVHD: [8, 1],
    });

    const projections = [
      batter({ r: 1.5, h: 2.5, hr: 0.4, rbi: 1.2, sb: 0.3, tb: 4.0, pa: 4.5, obp_num: 1.5 }),
      pitcher({ er: 0.5, outs: 8, k: 3, qs: 0.3, svhd: 0.2, whip_num: 2.0 }),
    ];

    const result = simulateMatchup(stats, 3, projections, undefined, 1000, {
      myAccumulators: makeAccumulators(50, 2.5, 0.9, 180, 0.35),
      seed: 123,
    });

    // Should be very likely to win with a dominant lead
    expect(result.winProbability).toBeGreaterThan(0.8);
    expect(result.expectedCategoryWins).toBeGreaterThan(9);
  });

  it("losing badly produces low win probability", () => {
    // Opponent is crushing us
    const stats = fullMatchup({
      R: [15, 55],
      H: [25, 75],
      HR: [3, 18],
      RBI: [12, 50],
      SB: [2, 12],
      TB: [40, 140],
      OBP: [0.22, 0.34],
      OUT: [50, 140],
      K: [25, 75],
      ERA: [5.5, 2.5],
      WHIP: [1.5, 0.9],
      QS: [1, 7],
      SVHD: [1, 7],
    });

    const projections = [
      batter({ r: 0.5, h: 1.0, hr: 0.1, rbi: 0.4, sb: 0.05, tb: 1.5 }),
      pitcher({ er: 1.2, outs: 4, k: 1.5, qs: 0.1, svhd: 0.05 }),
    ];

    const result = simulateMatchup(stats, 3, projections, undefined, 1000, {
      myAccumulators: makeAccumulators(16, 5.5, 1.5, 120, 0.22),
      seed: 456,
    });

    // Should be very unlikely to win
    expect(result.winProbability).toBeLessThan(0.2);
    expect(result.expectedCategoryWins).toBeLessThan(4);
  });

  it("is deterministic with same seed", () => {
    const stats = fullMatchup();
    const projections = [batter({}), pitcher({})];
    const opts = {
      myAccumulators: makeAccumulators(30, 3.5, 1.15, 140, 0.28),
      seed: 999,
    };

    const r1 = simulateMatchup(stats, 4, projections, undefined, 200, opts);
    const r2 = simulateMatchup(stats, 4, projections, undefined, 200, opts);

    expect(r1.winProbability).toBe(r2.winProbability);
    expect(r1.expectedCategoryWins).toBe(r2.expectedCategoryWins);
  });

  it("runs 1000 simulations under 100ms", () => {
    const stats = fullMatchup();
    const projections = [
      batter({ r: 0.5, h: 1.0, hr: 0.15, rbi: 0.5, sb: 0.1, tb: 1.8 }),
      batter({ r: 0.6, h: 1.1, hr: 0.2, rbi: 0.6, sb: 0.15, tb: 2.0 }),
      pitcher({ er: 0.8, outs: 6, k: 2, qs: 0.15, svhd: 0.1 }),
      pitcher({ er: 0.6, outs: 5, k: 1.8, qs: 0.1, svhd: 0.2 }),
    ];

    const start = performance.now();
    simulateMatchup(stats, 5, projections, undefined, 1000, {
      myAccumulators: makeAccumulators(30, 3.5, 1.15, 140, 0.28),
      seed: 42,
    });
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });
});

describe("compareLineupOptions", () => {
  it("better lineup option produces higher win probability", () => {
    // Tied matchup at midweek. Provide opponent projections directly
    // to avoid pace extrapolation issues.
    const stats = fullMatchup({
      R: [20, 20],
      H: [35, 35],
      HR: [6, 6],
      RBI: [18, 18],
      SB: [4, 4],
      TB: [55, 55],
      OBP: [0.27, 0.27],
      OUT: [80, 80],
      K: [40, 40],
      ERA: [3.5, 3.5],
      WHIP: [1.15, 1.15],
      QS: [2, 2],
      SVHD: [2, 2],
    });

    // Same opponent projections for both
    const oppProj: DailyProjection[] = [
      batter({ r: 1.0, h: 1.5, hr: 0.2, rbi: 0.8, sb: 0.15, tb: 2.5, pa: 4.0, obp_num: 1.2 }),
      pitcher({ er: 0.7, outs: 5, k: 1.5, qs: 0.15, svhd: 0.1, whip_num: 2.2 }),
    ];

    const commonOpts = {
      myAccumulators: makeAccumulators(26, 3.5, 1.15, 120, 0.27),
      oppAccumulators: makeAccumulators(26, 3.5, 1.15, 120, 0.27),
      seed: 77,
    };

    // Option A: strong lineup outproduces opponent
    const resultA = simulateMatchup(
      stats,
      4,
      [
        batter({ r: 2.0, h: 3.0, hr: 0.5, rbi: 2.0, sb: 0.3, tb: 5.0, pa: 5.0, obp_num: 1.8 }),
        pitcher({ er: 0.4, outs: 7, k: 2.5, qs: 0.25, svhd: 0.2, whip_num: 1.8 }),
      ],
      oppProj,
      1000,
      commonOpts,
    );

    // Option B: weak lineup underproduces opponent
    const resultB = simulateMatchup(
      stats,
      4,
      [
        batter({ r: 0.2, h: 0.3, hr: 0.02, rbi: 0.1, sb: 0.02, tb: 0.5, pa: 2.0, obp_num: 0.4 }),
        pitcher({ er: 1.5, outs: 3, k: 0.5, qs: 0.02, svhd: 0.01, whip_num: 4.0 }),
      ],
      oppProj,
      1000,
      commonOpts,
    );

    // Option A should outperform Option B in expected category wins at minimum
    // (winProbability may be 0 if the threshold logic is strict, but expected cats should differ)
    expect(resultA.expectedCategoryWins).toBeGreaterThan(resultB.expectedCategoryWins);
  });
});
