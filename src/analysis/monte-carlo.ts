import type { Category, CategoryScore } from "../types";
import { INVERSE_CATEGORIES } from "../types";

// --- Public interfaces ---

export interface DailyProjection {
  /** Player identifier */
  yahooId: string;
  playerType: "batter" | "pitcher";
  /** Expected daily counting stats (rate per day) */
  batting?: {
    r: number;
    h: number;
    hr: number;
    rbi: number;
    sb: number;
    tb: number;
    /** plate appearances per day — used to derive OBP */
    pa: number;
    /** times on base per day (H + BB + HBP) — used to derive OBP */
    obp_numerator: number;
  };
  pitching?: {
    /** earned runs per day */
    er: number;
    /** outs per day (IP × 3) */
    outs: number;
    k: number;
    qs: number;
    svhd: number;
    /** hits + walks per day — used to derive WHIP */
    whip_numerator: number;
  };
}

export interface SimulationResult {
  /** P(win >= 7 categories) */
  winProbability: number;
  /** E[categories won] */
  expectedCategoryWins: number;
  /** per-category P(win) */
  categoryWinProbs: Map<string, number>;
  /** number of simulations run */
  simulations: number;
}

// --- Constants ---

const INVERSE_SET = new Set<string>(INVERSE_CATEGORIES);
const WIN_THRESHOLD = 7; // need 7 out of 13 to win matchup
const DEFAULT_SIM_COUNT = 1_000;

// --- PRNG: xorshift128+ for reproducible, fast random numbers ---

/** Seedable PRNG state */
interface PrngState {
  s0: number;
  s1: number;
}

function createPrng(seed: number): PrngState {
  // Splitmix32 to expand seed into two state words
  let s = seed | 0;
  s = (s + 0x9e3779b9) | 0;
  let t = s ^ (s >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  const s0 = (t ^ (t >>> 15)) | 0;

  s = (s + 0x9e3779b9) | 0;
  t = s ^ (s >>> 16);
  t = Math.imul(t, 0x21f0aaad);
  t = t ^ (t >>> 15);
  t = Math.imul(t, 0x735a2d97);
  const s1 = (t ^ (t >>> 15)) | 0;

  return { s0: s0 || 1, s1: s1 || 1 };
}

/** Returns a float in [0, 1). Mutates state in-place. */
function nextFloat(state: PrngState): number {
  let s0 = state.s0;
  let s1 = state.s1;
  const result = (s0 + s1) | 0;
  s1 ^= s0;
  state.s0 = ((s0 << 24) | (s0 >>> 8)) ^ s1 ^ (s1 << 16);
  state.s1 = (s1 << 37) | (s1 >>> 27);
  // Convert to [0, 1)
  return (result >>> 0) / 4294967296;
}

// --- Sampling functions ---

/**
 * Sample from Poisson distribution using inverse-CDF method.
 * Fast for small lambda (< ~30), which covers all our daily stat rates.
 */
function samplePoisson(lambda: number, rng: PrngState): number {
  if (lambda <= 0) return 0;
  // For large lambda, use normal approximation
  if (lambda > 30) {
    return Math.max(0, Math.round(sampleNormal(lambda, Math.sqrt(lambda), rng)));
  }
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= nextFloat(rng);
  } while (p > L);
  return k - 1;
}

/**
 * Sample from normal distribution using Box-Muller transform.
 */
function sampleNormal(mean: number, stddev: number, rng: PrngState): number {
  let u1 = nextFloat(rng);
  // Avoid log(0)
  while (u1 === 0) u1 = nextFloat(rng);
  const u2 = nextFloat(rng);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stddev * z;
}

// --- Aggregate daily projections ---

interface AggregatedProjections {
  batting: {
    r: number;
    h: number;
    hr: number;
    rbi: number;
    sb: number;
    tb: number;
    pa: number;
    obp_numerator: number;
  };
  pitching: {
    er: number;
    outs: number;
    k: number;
    qs: number;
    svhd: number;
    whip_numerator: number;
  };
}

function aggregateProjections(projections: DailyProjection[]): AggregatedProjections {
  const agg: AggregatedProjections = {
    batting: { r: 0, h: 0, hr: 0, rbi: 0, sb: 0, tb: 0, pa: 0, obp_numerator: 0 },
    pitching: { er: 0, outs: 0, k: 0, qs: 0, svhd: 0, whip_numerator: 0 },
  };
  for (const p of projections) {
    if (p.batting) {
      agg.batting.r += p.batting.r;
      agg.batting.h += p.batting.h;
      agg.batting.hr += p.batting.hr;
      agg.batting.rbi += p.batting.rbi;
      agg.batting.sb += p.batting.sb;
      agg.batting.tb += p.batting.tb;
      agg.batting.pa += p.batting.pa;
      agg.batting.obp_numerator += p.batting.obp_numerator;
    }
    if (p.pitching) {
      agg.pitching.er += p.pitching.er;
      agg.pitching.outs += p.pitching.outs;
      agg.pitching.k += p.pitching.k;
      agg.pitching.qs += p.pitching.qs;
      agg.pitching.svhd += p.pitching.svhd;
      agg.pitching.whip_numerator += p.pitching.whip_numerator;
    }
  }
  return agg;
}

// --- Simulate remaining stats ---

interface SimulatedStats {
  R: number;
  H: number;
  HR: number;
  RBI: number;
  SB: number;
  TB: number;
  OBP: number;
  OUT: number;
  K: number;
  ERA: number;
  WHIP: number;
  QS: number;
  SVHD: number;
}

/**
 * Sample remaining production for one team.
 *
 * Counting stats: Poisson(daily_rate * daysRemaining).
 * HR-RBI correlation: each HR adds at least 1 RBI (already counted) + chance of extra.
 * Rate stats: derived from underlying counting stats.
 */
function sampleRemainingStats(
  dailyRates: AggregatedProjections,
  daysRemaining: number,
  rng: PrngState,
): SimulatedStats {
  const b = dailyRates.batting;
  const p = dailyRates.pitching;

  // Sample batting counting stats
  const hr = samplePoisson(b.hr * daysRemaining, rng);
  const h = samplePoisson(b.h * daysRemaining, rng);
  // HR-RBI correlation: HR guarantees at least 1 RBI each, plus other RBIs
  const nonHrRbi = samplePoisson(Math.max(0, (b.rbi - b.hr) * daysRemaining), rng);
  const rbi = hr + nonHrRbi;
  // R and H are correlated: a fraction of hits lead to runs
  const r = samplePoisson(b.r * daysRemaining, rng);
  const sb = samplePoisson(b.sb * daysRemaining, rng);
  // TB: at minimum HR*4 + (H-HR)*1, sample extra bases
  const extraBases = samplePoisson(Math.max(0, (b.tb - b.h) * daysRemaining), rng);
  const tb = h + extraBases;

  // OBP: sample PA and times-on-base, then compute rate
  const pa = samplePoisson(b.pa * daysRemaining, rng);
  const obpNum = samplePoisson(b.obp_numerator * daysRemaining, rng);
  // OBP will be combined with existing accumulated stats later

  // Sample pitching counting stats
  const outs = samplePoisson(p.outs * daysRemaining, rng);
  const k = samplePoisson(p.k * daysRemaining, rng);
  const qs = samplePoisson(p.qs * daysRemaining, rng);
  const svhd = samplePoisson(p.svhd * daysRemaining, rng);
  const er = samplePoisson(p.er * daysRemaining, rng);
  const whipNum = samplePoisson(p.whip_numerator * daysRemaining, rng);

  // Derive rate stats from accumulated counting stats
  const ip = outs / 3;
  const era = ip > 0 ? (9 * er) / ip : 0;
  const whip = ip > 0 ? whipNum / ip : 0;
  const obp = pa > 0 ? obpNum / pa : 0;

  return {
    R: r,
    H: h,
    HR: hr,
    RBI: rbi,
    SB: sb,
    TB: tb,
    OBP: obp,
    OUT: outs,
    K: k,
    ERA: era,
    WHIP: whip,
    QS: qs,
    SVHD: svhd,
  };
}

// --- Combine current stats with simulated remaining stats ---

/**
 * For counting stats, just add. For rate stats (ERA, WHIP, OBP), we need the
 * underlying counting stats to recompute properly. We store "accumulators"
 * alongside the category scores.
 */
export interface RateStatAccumulators {
  /** Total innings pitched (for ERA/WHIP) */
  ip: number;
  /** Total earned runs (for ERA) */
  er: number;
  /** Total hits + walks allowed (for WHIP numerator) */
  whip_numerator: number;
  /** Total plate appearances (for OBP) */
  pa: number;
  /** Total times on base (for OBP numerator) */
  obp_numerator: number;
}

/** Category values map for easy lookup */
type CatMap = Record<string, number>;

function buildCatMap(categories: CategoryScore[]): CatMap {
  const m: CatMap = {};
  for (const c of categories) m[c.category] = c.myValue;
  return m;
}

function buildOppCatMap(categories: CategoryScore[]): CatMap {
  const m: CatMap = {};
  for (const c of categories) m[c.category] = c.opponentValue;
  return m;
}

// --- Opponent pace extrapolation ---

function extrapolateOpponentStats(
  currentOpp: CatMap,
  daysElapsed: number,
  totalDays: number,
  daysRemaining: number,
  accumulators?: RateStatAccumulators,
): {
  dailyRates: AggregatedProjections;
  accumulators: RateStatAccumulators;
} {
  const pace = daysElapsed > 0 ? 1 / daysElapsed : 1;

  // Extrapolate counting stats to daily rates
  const dailyRates: AggregatedProjections = {
    batting: {
      r: (currentOpp["R"] ?? 0) * pace,
      h: (currentOpp["H"] ?? 0) * pace,
      hr: (currentOpp["HR"] ?? 0) * pace,
      rbi: (currentOpp["RBI"] ?? 0) * pace,
      sb: (currentOpp["SB"] ?? 0) * pace,
      tb: (currentOpp["TB"] ?? 0) * pace,
      pa: 0,
      obp_numerator: 0,
    },
    pitching: {
      er: 0,
      outs: (currentOpp["OUT"] ?? 0) * pace,
      k: (currentOpp["K"] ?? 0) * pace,
      qs: (currentOpp["QS"] ?? 0) * pace,
      svhd: (currentOpp["SVHD"] ?? 0) * pace,
      whip_numerator: 0,
    },
  };

  // For rate stats, we need to reverse-engineer the accumulators
  const oppIp = (currentOpp["OUT"] ?? 0) / 3;
  const oppEra = currentOpp["ERA"] ?? 0;
  const oppWhip = currentOpp["WHIP"] ?? 0;
  const oppObp = currentOpp["OBP"] ?? 0;

  const existingAcc = accumulators ?? {
    ip: oppIp,
    er: oppIp > 0 ? (oppEra * oppIp) / 9 : 0,
    whip_numerator: oppIp > 0 ? oppWhip * oppIp : 0,
    pa: 0,
    obp_numerator: 0,
  };

  // Estimate opponent PA from typical daily rate (~35 PA/day for a full lineup)
  const estimatedDailyPA = 35;
  if (existingAcc.pa === 0 && daysElapsed > 0) {
    existingAcc.pa = estimatedDailyPA * daysElapsed;
    existingAcc.obp_numerator = oppObp * existingAcc.pa;
  }

  // Daily rates for rate stat components
  if (daysElapsed > 0) {
    dailyRates.pitching.er = existingAcc.er / daysElapsed;
    dailyRates.pitching.whip_numerator = existingAcc.whip_numerator / daysElapsed;
    dailyRates.batting.pa = existingAcc.pa / daysElapsed;
    dailyRates.batting.obp_numerator = existingAcc.obp_numerator / daysElapsed;
  }

  return { dailyRates, accumulators: existingAcc };
}

// --- Core simulation ---

/**
 * Simulate the rest of the matchup week to estimate win probability.
 *
 * For each simulation:
 * 1. Sample remaining production from Poisson distributions
 * 2. Add to current accumulated stats
 * 3. Count categories won
 * 4. Track how often we win >= 7
 */
export function simulateMatchup(
  currentStats: CategoryScore[],
  daysRemaining: number,
  myRosterProjections: DailyProjection[],
  opponentProjections?: DailyProjection[],
  simCount: number = DEFAULT_SIM_COUNT,
  options?: {
    /** Total days in the matchup week (default 7) */
    totalDays?: number;
    /** Rate stat accumulators for my team */
    myAccumulators?: RateStatAccumulators;
    /** Rate stat accumulators for opponent */
    oppAccumulators?: RateStatAccumulators;
    /** PRNG seed for reproducibility (default: Date.now()) */
    seed?: number;
  },
): SimulationResult {
  const totalDays = options?.totalDays ?? 7;
  const daysElapsed = totalDays - daysRemaining;
  const seed = options?.seed ?? Date.now();
  const rng = createPrng(seed);

  // Current stat snapshots
  const myCurrent = buildCatMap(currentStats);
  const oppCurrent = buildOppCatMap(currentStats);

  // Aggregate my roster's daily projections
  const myDailyRates = aggregateProjections(myRosterProjections);

  // Opponent daily rates: use provided projections or extrapolate from pace
  let oppDailyRates: AggregatedProjections;
  let oppAccumulators: RateStatAccumulators;
  if (opponentProjections && opponentProjections.length > 0) {
    oppDailyRates = aggregateProjections(opponentProjections);
    oppAccumulators = options?.oppAccumulators ?? {
      ip: (oppCurrent["OUT"] ?? 0) / 3,
      er: 0,
      whip_numerator: 0,
      pa: 0,
      obp_numerator: 0,
    };
  } else {
    const extrapolated = extrapolateOpponentStats(
      oppCurrent,
      daysElapsed,
      totalDays,
      daysRemaining,
      options?.oppAccumulators,
    );
    oppDailyRates = extrapolated.dailyRates;
    oppAccumulators = extrapolated.accumulators;
  }

  // My rate stat accumulators
  const myIp = (myCurrent["OUT"] ?? 0) / 3;
  const myAcc: RateStatAccumulators = options?.myAccumulators ?? {
    ip: myIp,
    er: myIp > 0 ? ((myCurrent["ERA"] ?? 0) * myIp) / 9 : 0,
    whip_numerator: myIp > 0 ? (myCurrent["WHIP"] ?? 0) * myIp : 0,
    pa: 0,
    obp_numerator: 0,
  };
  // Estimate PA for OBP if not provided
  if (myAcc.pa === 0 && daysElapsed > 0) {
    const estimatedDailyPA = 35;
    myAcc.pa = estimatedDailyPA * daysElapsed;
    myAcc.obp_numerator = (myCurrent["OBP"] ?? 0) * myAcc.pa;
  }

  // Categories to simulate
  const categories = currentStats.map((c) => c.category);
  const catWinCounts = new Map<string, number>();
  for (const cat of categories) catWinCounts.set(cat, 0);

  let matchupWins = 0;
  let totalCatWins = 0;

  for (let sim = 0; sim < simCount; sim++) {
    // Sample remaining production
    const myRemaining = sampleRemainingStats(myDailyRates, daysRemaining, rng);
    const oppRemaining = sampleRemainingStats(oppDailyRates, daysRemaining, rng);

    // Compute final stats for each category
    let catWins = 0;
    for (const cat of categories) {
      const myFinal = computeFinalStat(cat, myCurrent, myRemaining, myAcc, daysRemaining);
      const oppFinal = computeFinalStat(
        cat,
        oppCurrent,
        oppRemaining,
        oppAccumulators,
        daysRemaining,
      );

      const isInverse = INVERSE_SET.has(cat);
      const iWin = isInverse ? myFinal < oppFinal : myFinal > oppFinal;

      if (iWin) {
        catWins++;
        catWinCounts.set(cat, (catWinCounts.get(cat) ?? 0) + 1);
      }
    }

    totalCatWins += catWins;
    if (catWins >= WIN_THRESHOLD) matchupWins++;
  }

  // Build results
  const categoryWinProbs = new Map<string, number>();
  for (const [cat, wins] of catWinCounts) {
    categoryWinProbs.set(cat, wins / simCount);
  }

  return {
    winProbability: matchupWins / simCount,
    expectedCategoryWins: totalCatWins / simCount,
    categoryWinProbs,
    simulations: simCount,
  };
}

/**
 * Compute the final value for a category by combining current accumulated stats
 * with simulated remaining production.
 *
 * Counting stats: simple addition.
 * Rate stats (ERA, WHIP, OBP): recompute from underlying counting stats.
 */
function computeFinalStat(
  cat: Category,
  current: CatMap,
  remaining: SimulatedStats,
  accumulators: RateStatAccumulators,
  _daysRemaining: number,
): number {
  switch (cat) {
    case "ERA": {
      const totalIp = accumulators.ip + remaining.OUT / 3;
      const totalEr = accumulators.er + (remaining.ERA * (remaining.OUT / 3)) / 9;
      return totalIp > 0 ? (9 * totalEr) / totalIp : 0;
    }
    case "WHIP": {
      const totalIp = accumulators.ip + remaining.OUT / 3;
      const remainingIp = remaining.OUT / 3;
      const totalWhipNum =
        accumulators.whip_numerator + (remainingIp > 0 ? remaining.WHIP * remainingIp : 0);
      return totalIp > 0 ? totalWhipNum / totalIp : 0;
    }
    case "OBP": {
      const remainingPa = remaining.OBP > 0 ? remaining.H / remaining.OBP : 0;
      const totalPa = accumulators.pa + (remainingPa || 0);
      const totalObpNum = accumulators.obp_numerator + remaining.H;
      return totalPa > 0 ? totalObpNum / totalPa : 0;
    }
    default: {
      // Counting stat: just add
      const currentVal = current[cat] ?? 0;
      const remainingVal = remaining[cat as keyof SimulatedStats] as number;
      return currentVal + (remainingVal ?? 0);
    }
  }
}

// --- Lineup comparison helper ---

/**
 * Compare two lineup options by their effect on matchup win probability.
 * Returns the delta in win probability (positive = option A is better).
 */
export function compareLineupOptions(
  currentStats: CategoryScore[],
  daysRemaining: number,
  optionAProjections: DailyProjection[],
  optionBProjections: DailyProjection[],
  opponentProjections?: DailyProjection[],
  simCount: number = DEFAULT_SIM_COUNT,
  options?: {
    totalDays?: number;
    myAccumulators?: RateStatAccumulators;
    oppAccumulators?: RateStatAccumulators;
    seed?: number;
  },
): number {
  // Use same seed for both so randomness differences reflect projection differences
  const seed = options?.seed ?? Date.now();

  const resultA = simulateMatchup(
    currentStats,
    daysRemaining,
    optionAProjections,
    opponentProjections,
    simCount,
    {
      ...options,
      seed,
    },
  );
  const resultB = simulateMatchup(
    currentStats,
    daysRemaining,
    optionBProjections,
    opponentProjections,
    simCount,
    {
      ...options,
      seed,
    },
  );

  return resultA.winProbability - resultB.winProbability;
}
