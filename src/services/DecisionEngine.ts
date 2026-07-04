import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  LeagueState,
  type LeagueStateSnapshot,
  type RosterSlotCount,
  type LeagueStatePlayer,
} from "./LeagueState.ts";
import { WeeklyBatterLine, WeeklyProjectionSet, WeeklyPitcherLine } from "./ProjectionModel.ts";
import {
  BankedTotals,
  SimJobCandidate,
  SimJobBankedTotals,
  SimJobSpec,
  StoredSimJobSpec,
  UnitPartial,
  UnitPartialCounter,
} from "./SimJob.ts";
import {
  StandingsHistory,
  StandingsHistoryError,
  type StandingCategoryTotal,
} from "./StandingsHistory.ts";
import { WeeklyProjections, WeeklyProjectionsError } from "./WeeklyProjections.ts";
import { type YahooApiError } from "./YahooClient.ts";

export const PRODUCTION_SIMULATION_COUNT = 5_000;
export const MAX_SIMULATED_ADD_CANDIDATES = 20;
const WEEKLY_WEIGHT_ALPHA = 0.75;
const TEAM_SEASON_OBP_DENOMINATOR = 6500;
const TEAM_SEASON_IP = 1400;
const LEAGUE_AVG_OBP = 0.32;
const LEAGUE_AVG_ERA = 4.1;
const LEAGUE_AVG_WHIP = 1.28;
const AVG_PA_PER_STARTED_GAME = 4.2;
const AVG_GAMES_PER_WEEK = 6.2;
export const ENGINE_VERSION = "phase2-banked-v1";

const CATEGORIES = [
  "R",
  "H",
  "HR",
  "RBI",
  "SB",
  "TB",
  "OBP",
  "OUT",
  "K",
  "ERA",
  "WHIP",
  "QS",
  "SV+H",
] as const;

type Category = (typeof CATEGORIES)[number];
type WeeklyLine = WeeklyBatterLine | WeeklyPitcherLine;

const SUPPORTED_CATEGORIES = new Set<string>(CATEGORIES);
const LOWER_IS_BETTER = new Set<Category>(["ERA", "WHIP"]);
const BATTER_CATEGORIES = new Set<Category>(["R", "H", "HR", "RBI", "SB", "TB", "OBP"]);
const PITCHER_CATEGORIES = new Set<Category>(["OUT", "K", "ERA", "WHIP", "QS", "SV+H"]);

const SGP_DENOMINATORS: Record<Category, number> = {
  R: 35,
  H: 45,
  HR: 12,
  RBI: 35,
  SB: 10,
  TB: 75,
  OBP: 0.01,
  OUT: 120,
  K: 55,
  ERA: 0.12,
  WHIP: 0.035,
  QS: 6,
  "SV+H": 10,
};

export class DecisionEngineError extends Data.TaggedError("DecisionEngineError")<{
  readonly message: string;
}> {}

export class CategoryProbability extends Schema.Class<CategoryProbability>("CategoryProbability")({
  category: Schema.String,
  winProbability: Schema.Finite,
  tieProbability: Schema.Finite,
  expectedPoints: Schema.Finite,
  // F2 diagnostics: per-sim margin (my value − opponent value) distribution. Documents the
  // variance the win-prob ranking now reflects. Optional so existing constructions are unchanged.
  marginMean: Schema.optional(Schema.Finite),
  marginStdDev: Schema.optional(Schema.Finite),
  tag: Schema.Union([
    Schema.Literal("lock"),
    Schema.Literal("coin-flip"),
    Schema.Literal("lost-cause"),
    Schema.Literal("lean"),
  ]),
}) {}

export class CategoryDelta extends Schema.Class<CategoryDelta>("CategoryDelta")({
  category: Schema.String,
  weeklyDelta: Schema.Finite,
  seasonSgpDelta: Schema.Finite,
}) {}

export class AddRecommendation extends Schema.Class<AddRecommendation>("AddRecommendation")({
  type: Schema.Literal("add"),
  playerKey: Schema.String,
  playerName: Schema.String,
  score: Schema.Finite,
  weeklyDelta: Schema.Finite,
  seasonSgpDelta: Schema.Finite,
  affectedCategories: Schema.Array(CategoryDelta),
}) {}

export class LineupRecommendation extends Schema.Class<LineupRecommendation>(
  "LineupRecommendation",
)({
  type: Schema.Literal("lineup"),
  startPlayerKey: Schema.String,
  startPlayerName: Schema.String,
  sitPlayerKey: Schema.String,
  sitPlayerName: Schema.String,
  scoreDelta: Schema.Finite,
  affectedCategories: Schema.Array(CategoryDelta),
}) {}

export class OptimalLineupSlot extends Schema.Class<OptimalLineupSlot>("OptimalLineupSlot")({
  slot: Schema.String,
  kind: Schema.Union([Schema.Literal("batter"), Schema.Literal("pitcher")]),
  playerKey: Schema.String,
  playerName: Schema.String,
  score: Schema.Finite,
  isCurrentStarter: Schema.Boolean,
}) {}

export class OptimalLineupBench extends Schema.Class<OptimalLineupBench>("OptimalLineupBench")({
  kind: Schema.Union([Schema.Literal("batter"), Schema.Literal("pitcher")]),
  playerKey: Schema.String,
  playerName: Schema.String,
  score: Schema.Finite,
}) {}

export class OpponentScout extends Schema.Class<OpponentScout>("OpponentScout")({
  locks: Schema.Array(Schema.String),
  coinFlips: Schema.Array(Schema.String),
  lostCauses: Schema.Array(Schema.String),
  categoryWeights: Schema.Record(Schema.String, Schema.Finite),
}) {}

export class MatchupSimulation extends Schema.Class<MatchupSimulation>("MatchupSimulation")({
  expectedCategoryPoints: Schema.Finite,
  categories: Schema.Array(CategoryProbability),
}) {}

export class DecisionReport extends Schema.Class<DecisionReport>("DecisionReport")({
  baseline: MatchupSimulation,
  scout: OpponentScout,
  sgpDenominatorSource: Schema.optional(
    Schema.Union([Schema.Literal("standings-history"), Schema.Literal("fallback")]),
  ),
  recommendations: Schema.Array(AddRecommendation),
  lineupRecommendations: Schema.Array(LineupRecommendation),
  optimalLineup: Schema.Array(OptimalLineupSlot),
  optimalBench: Schema.Array(OptimalLineupBench),
}) {}

type Totals = {
  R: number;
  H: number;
  HR: number;
  RBI: number;
  SB: number;
  TB: number;
  obpNumerator: number;
  obpDenominator: number;
  OUT: number;
  K: number;
  er: number;
  baserunners: number;
  ip: number;
  QS: number;
  "SV+H": number;
};

type MatchupSample = Record<Category, number>;
type BankedSide = "mine" | "opponent";

const isCategory = (category: string): category is Category => SUPPORTED_CATEGORIES.has(category);

const scoringCategoriesForSnapshot = (snapshot: LeagueStateSnapshot | undefined) => {
  const scoringCategories = snapshot?.scoringCategories.filter(isCategory) ?? [];
  return scoringCategories.length > 0 ? scoringCategories : [...CATEGORIES];
};

const emptyTotals = (): Totals => ({
  R: 0,
  H: 0,
  HR: 0,
  RBI: 0,
  SB: 0,
  TB: 0,
  obpNumerator: 0,
  obpDenominator: 0,
  OUT: 0,
  K: 0,
  er: 0,
  baserunners: 0,
  ip: 0,
  QS: 0,
  "SV+H": 0,
});

const zeroBankedTotals = () =>
  new BankedTotals({
    counting: {},
    era: { er: 0, outs: 0 },
    whip: { baserunners: 0, outs: 0 },
    obp: { numerator: 0, denominator: 0 },
  });

const zeroBanked = () =>
  new SimJobBankedTotals({
    mine: zeroBankedTotals(),
    opponent: zeroBankedTotals(),
  });

const matchupNumber = (value: string | undefined) => {
  if (value == null || value.trim() === "" || value.trim() === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const elapsedWeekGames = (
  snapshot: LeagueStateSnapshot | undefined,
  contextAt: string | undefined,
) => {
  if (snapshot == null || snapshot.matchup.weekStart === "") return 0;
  const weekStart = Date.parse(`${snapshot.matchup.weekStart}T00:00:00.000Z`);
  const at = contextAt == null ? Date.now() : Date.parse(contextAt);
  if (!Number.isFinite(weekStart) || !Number.isFinite(at) || at <= weekStart) return 0;
  const elapsedDays = Math.min(7, Math.max(0, (at - weekStart) / (24 * 60 * 60 * 1000)));
  return (elapsedDays / 7) * AVG_GAMES_PER_WEEK;
};

const estimatedConsumedPa = (
  lines: ReadonlyArray<WeeklyLine>,
  snapshot: LeagueStateSnapshot | undefined,
  contextAt: string | undefined,
) => {
  const activeHitters = lines.filter((line) => line.kind === "batter").length;
  return activeHitters * elapsedWeekGames(snapshot, contextAt) * AVG_PA_PER_STARTED_GAME;
};

export const bankedFromMatchup = (
  categories: ReadonlyArray<LeagueStateSnapshot["matchup"]["categories"][number]>,
  side: BankedSide,
  paEstimate: number,
) => {
  const valueByCategory = new Map(
    categories.map((category) => [
      category.category,
      side === "mine" ? category.myValue : category.opponentValue,
    ]),
  );
  const numberFor = (category: string) => matchupNumber(valueByCategory.get(category));
  const counting = Object.fromEntries(
    ["R", "H", "HR", "RBI", "SB", "TB", "OUT", "K", "QS", "SV+H"].map((category) => [
      category,
      numberFor(category),
    ]),
  );
  const outs = numberFor("OUT");
  const ip = outs / 3;
  const eraValue = numberFor("ERA");
  const whipValue = numberFor("WHIP");
  const obpDenominator = Math.max(0, paEstimate);
  const obpValue = numberFor("OBP");

  // Yahoo matchup OBP has no recoverable AB/PA components. This approximates the denominator as
  // consumed active-lineup PA so early-week OBP anchors weakly and late-week OBP anchors strongly.
  return new BankedTotals({
    counting,
    era: { er: outs > 0 ? (eraValue * ip) / 9 : 0, outs },
    whip: { baserunners: outs > 0 ? whipValue * ip : 0, outs },
    obp: {
      numerator: obpDenominator > 0 ? obpValue * obpDenominator : 0,
      denominator: obpDenominator,
    },
  });
};

const addBankedTotals = (totals: Totals, banked: BankedTotals): Totals => ({
  R: totals.R + (banked.counting["R"] ?? 0),
  H: totals.H + (banked.counting["H"] ?? 0),
  HR: totals.HR + (banked.counting["HR"] ?? 0),
  RBI: totals.RBI + (banked.counting["RBI"] ?? 0),
  SB: totals.SB + (banked.counting["SB"] ?? 0),
  TB: totals.TB + (banked.counting["TB"] ?? 0),
  obpNumerator: totals.obpNumerator + banked.obp.numerator,
  obpDenominator: totals.obpDenominator + banked.obp.denominator,
  OUT: totals.OUT + (banked.counting["OUT"] ?? banked.era.outs),
  K: totals.K + (banked.counting["K"] ?? 0),
  er: totals.er + (banked.era.er ?? 0),
  baserunners: totals.baserunners + (banked.whip.baserunners ?? 0),
  ip: totals.ip + banked.era.outs / 3,
  QS: totals.QS + (banked.counting["QS"] ?? 0),
  "SV+H": totals["SV+H"] + (banked.counting["SV+H"] ?? 0),
});

const addExpectedLine = (totals: Totals, line: WeeklyLine) => {
  if (line.kind === "batter") {
    totals.R += line.r;
    totals.H += line.h;
    totals.HR += line.hr;
    totals.RBI += line.rbi;
    totals.SB += line.sb;
    totals.TB += line.tb;
    totals.obpNumerator += line.obpNumerator;
    totals.obpDenominator += line.obpDenominator;
  } else {
    totals.OUT += line.out;
    totals.K += line.k;
    totals.er += line.er;
    totals.baserunners += line.baserunners;
    totals.ip += line.ip;
    totals.QS += line.qs;
    totals["SV+H"] += line.svh;
  }
};

const expectedTotals = (lines: ReadonlyArray<WeeklyLine>) => {
  const totals = emptyTotals();
  for (const line of lines) addExpectedLine(totals, line);
  return totals;
};

const toCategoryValues = (totals: Totals): MatchupSample => ({
  R: totals.R,
  H: totals.H,
  HR: totals.HR,
  RBI: totals.RBI,
  SB: totals.SB,
  TB: totals.TB,
  OBP: totals.obpDenominator > 0 ? totals.obpNumerator / totals.obpDenominator : 0,
  OUT: totals.OUT,
  K: totals.K,
  ERA: totals.ip > 0 ? (totals.er * 9) / totals.ip : 0,
  WHIP: totals.ip > 0 ? totals.baserunners / totals.ip : 0,
  QS: totals.QS,
  "SV+H": totals["SV+H"],
});

const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const sampleNormal = (mean: number, sd: number, random: () => number) => {
  if (mean <= 0 || sd <= 0) return Math.max(0, mean);
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + z * sd);
};

// `volatility` scales the sampling sd (1 = neutral). F2: a higher-σ line raises team σ, which
// raises P(win) for underdog categories and lowers it for favorites — so F1's Δ(win-prob)
// ranking is automatically variance-aware. A volatility ≤ 0 yields sd 0 (deterministic floor).
const sampleCounting = (mean: number, random: () => number, volatility = 1) =>
  sampleNormal(mean, Math.sqrt(Math.max(mean, 0.05)) * volatility, random);

const sampleTeam = (lines: ReadonlyArray<WeeklyLine>, random: () => number) => {
  const totals = emptyTotals();
  for (const line of lines) {
    const vol = line.volatility ?? 1;
    if (line.kind === "batter") {
      totals.R += sampleCounting(line.r, random, vol);
      totals.H += sampleCounting(line.h, random, vol);
      totals.HR += sampleCounting(line.hr, random, vol);
      totals.RBI += sampleCounting(line.rbi, random, vol);
      totals.SB += sampleCounting(line.sb, random, vol);
      totals.TB += sampleCounting(line.tb, random, vol);
      totals.obpDenominator += sampleCounting(line.obpDenominator, random, vol);
      totals.obpNumerator += sampleCounting(line.obpNumerator, random, vol);
    } else {
      totals.OUT += sampleCounting(line.out, random, vol);
      totals.K += sampleCounting(line.k, random, vol);
      totals.er += sampleCounting(line.er, random, vol);
      totals.baserunners += sampleCounting(line.baserunners, random, vol);
      totals.ip += sampleNormal(line.ip, Math.max(0.1, line.ip * 0.12) * vol, random);
      totals.QS += sampleCounting(line.qs, random, vol);
      totals["SV+H"] += sampleCounting(line.svh, random, vol);
    }
  }
  return totals;
};

const tagCategory = (winProbability: number) => {
  if (winProbability >= 0.85) return "lock" as const;
  if (winProbability <= 0.15) return "lost-cause" as const;
  if (winProbability >= 0.35 && winProbability <= 0.65) return "coin-flip" as const;
  return "lean" as const;
};

// Inverse standard-normal CDF (Acklam's rational approximation). Used to map a win
// probability back to the z-score (margin/σ) that produced it. The a/b/c/d coefficients and the
// 0.02425 breakpoint are FIXED constants of the published algorithm (accurate to ~1e-9), not
// tunable parameters; 1e-9 just keeps p inside the open interval (0,1).
function probit(p: number) {
  const clamped = Math.min(Math.max(p, 1e-9), 1 - 1e-9);
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (clamped < plow) {
    const q = Math.sqrt(-2 * Math.log(clamped));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (clamped > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - clamped));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = clamped - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

// F7: continuous category importance weight. Marginal value of one stat-unit is proportional to
// the probability density of the win-prob curve at the 0/0 margin threshold — i.e. φ(z) where
// z = Φ⁻¹(P(win)) (§1.3, §4.2). Peaks at a coin-flip (z=0 → exp(0)=1) and decays smoothly toward a
// non-zero floor for locks/lost-causes (soft-punt). exp(-z²/2) == φ(z)/φ(0), so no constant needed.
const CATEGORY_WEIGHT_PEAK = 1.75;
const CATEGORY_WEIGHT_FLOOR = 0.2;
export const categoryWeight = (winProbability: number) =>
  CATEGORY_WEIGHT_FLOOR +
  (CATEGORY_WEIGHT_PEAK - CATEGORY_WEIGHT_FLOOR) * Math.exp(-(probit(winProbability) ** 2) / 2);

const slope = (points: ReadonlyArray<readonly [number, number]>) => {
  const count = points.length;
  if (count < 2) return 0;
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / count;
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / count;
  const numerator = points.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0);
  const denominator = points.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
  return denominator > 0 ? numerator / denominator : 0;
};

export const computeSgpDenominators = (standingsHistory: ReadonlyArray<StandingCategoryTotal>) => {
  const denominators = { ...SGP_DENOMINATORS };
  for (const category of CATEGORIES) {
    const points = standingsHistory.flatMap((entry) => {
      const value = entry.categories[category];
      return value == null ? [] : [[entry.rank, value] as const];
    });
    const categorySlope = Math.abs(slope(points));
    if (Number.isFinite(categorySlope) && categorySlope > 0) denominators[category] = categorySlope;
  }
  return denominators;
};

const hasUsableSgpHistory = (standingsHistory: ReadonlyArray<StandingCategoryTotal>) =>
  CATEGORIES.some((category) => {
    const pointCount = standingsHistory.reduce(
      (count, entry) => count + (entry.categories[category] == null ? 0 : 1),
      0,
    );
    return pointCount >= 2;
  });

// Single source of truth for the Monte Carlo loop: runs `iterations` sims of myRoster vs
// opponentRoster and returns the RAW per-category counters (wins/ties/marginSum/marginSqSum) as a
// serializable UnitPartial. `simulateMatchup` and `simulateUnit` are both thin wrappers over this so
// there is exactly one RNG/draw implementation.
//
// Decoupled mine/opp RNG streams (was a single shared `createRandom(62744)` stream). The opp stream
// is seeded distinctly + deterministically so it is identical for the baseline and every candidate
// (candidates only append to myRoster) → Common Random Numbers: candidate Δ is low-variance and
// chunks are independent/summable. This deliberately changes sim outputs vs. the old single-stream
// scheme; calibrated against F8 as of 2026-06-20.
const simulateRawCounters = (
  myRoster: ReadonlyArray<WeeklyLine>,
  opponentRoster: ReadonlyArray<WeeklyLine>,
  seed: number,
  iterations: number,
  scoringCategories: ReadonlyArray<Category>,
  banked: SimJobBankedTotals = zeroBanked(),
): UnitPartial => {
  const randomMine = createRandom(seed);
  const randomOpp = createRandom((seed ^ 0x9e3779b9) >>> 0);
  const results = new Map<
    string,
    { wins: number; ties: number; marginSum: number; marginSqSum: number }
  >(
    scoringCategories.map((category) => [
      category,
      { wins: 0, ties: 0, marginSum: 0, marginSqSum: 0 },
    ]),
  );

  for (let index = 0; index < iterations; index += 1) {
    const mine = toCategoryValues(addBankedTotals(sampleTeam(myRoster, randomMine), banked.mine));
    const opponent = toCategoryValues(
      addBankedTotals(sampleTeam(opponentRoster, randomOpp), banked.opponent),
    );
    for (const category of scoringCategories) {
      const myValue = mine[category];
      const opponentValue = opponent[category];
      const result = results.get(category);
      if (result == null) continue;
      // Orient the margin so positive always means "winning" (categories where lower is better
      // flip the sign), so marginMean/marginStdDev read consistently across all categories.
      const margin = LOWER_IS_BETTER.has(category)
        ? opponentValue - myValue
        : myValue - opponentValue;
      result.marginSum += margin;
      result.marginSqSum += margin * margin;
      if (Math.abs(myValue - opponentValue) < 0.0001) {
        result.ties += 1;
      } else if (
        LOWER_IS_BETTER.has(category) ? myValue < opponentValue : myValue > opponentValue
      ) {
        result.wins += 1;
      }
    }
  }

  return new UnitPartial({
    iters: iterations,
    categories: scoringCategories.map((category) => {
      const result = results.get(category) ?? { wins: 0, ties: 0, marginSum: 0, marginSqSum: 0 };
      return new UnitPartialCounter({ category, ...result });
    }),
  });
};

// Sum a set of UnitPartials with matching category sets into one (used by reduce to add chunk
// partials, and baseline-from-spec scenarios). Counters are additive so summing partials is
// identical to a single run over the union of their iterations.
export const sumUnitPartials = (partials: ReadonlyArray<UnitPartial>): UnitPartial => {
  const totals = new Map<
    string,
    { wins: number; ties: number; marginSum: number; marginSqSum: number }
  >();
  let iters = 0;
  for (const partial of partials) {
    iters += partial.iters;
    for (const counter of partial.categories) {
      const acc = totals.get(counter.category) ?? {
        wins: 0,
        ties: 0,
        marginSum: 0,
        marginSqSum: 0,
      };
      acc.wins += counter.wins;
      acc.ties += counter.ties;
      acc.marginSum += counter.marginSum;
      acc.marginSqSum += counter.marginSqSum;
      totals.set(counter.category, acc);
    }
  }
  return new UnitPartial({
    iters,
    categories: [...totals].map(([category, acc]) => new UnitPartialCounter({ category, ...acc })),
  });
};

// Convert a unit's raw counters → the existing MatchupSimulation/CategoryProbability aggregation.
// `scoringCategories` fixes the output order to match the old simulateMatchup exactly.
const aggregateMatchup = (
  partial: UnitPartial,
  scoringCategories: ReadonlyArray<Category>,
): MatchupSimulation => {
  const byCategory = new Map(partial.categories.map((counter) => [counter.category, counter]));
  const iterations = partial.iters;
  const categories = scoringCategories.map((category) => {
    const result = byCategory.get(category) ?? { wins: 0, ties: 0, marginSum: 0, marginSqSum: 0 };
    const winProbability = result.wins / iterations;
    const tieProbability = result.ties / iterations;
    const marginMean = iterations > 0 ? result.marginSum / iterations : 0;
    const marginVariance =
      iterations > 0 ? Math.max(0, result.marginSqSum / iterations - marginMean * marginMean) : 0;
    return new CategoryProbability({
      category,
      winProbability,
      tieProbability,
      expectedPoints: winProbability + 0.5 * tieProbability,
      marginMean,
      marginStdDev: Math.sqrt(marginVariance),
      tag: tagCategory(winProbability),
    });
  });

  return new MatchupSimulation({
    expectedCategoryPoints: categories.reduce((sum, category) => sum + category.expectedPoints, 0),
    categories,
  });
};

export const simulateMatchup = (
  myRoster: ReadonlyArray<WeeklyLine>,
  opponentRoster: ReadonlyArray<WeeklyLine>,
  iterations = PRODUCTION_SIMULATION_COUNT,
  seed = 62744,
  scoringCategories: ReadonlyArray<Category> = CATEGORIES,
  banked: SimJobBankedTotals = zeroBanked(),
) =>
  aggregateMatchup(
    simulateRawCounters(myRoster, opponentRoster, seed, iterations, scoringCategories, banked),
    scoringCategories,
  );

const categoryWeightsFromScout = (baseline: MatchupSimulation) =>
  Object.fromEntries(
    baseline.categories.map((category) => [
      category.category,
      categoryWeight(category.winProbability),
    ]),
  ) as Record<Category, number>;

const scoutOpponent = (baseline: MatchupSimulation) => {
  const locks: Array<string> = [];
  const coinFlips: Array<string> = [];
  const lostCauses: Array<string> = [];
  for (const category of baseline.categories) {
    if (category.tag === "lock") locks.push(category.category);
    if (category.tag === "coin-flip") coinFlips.push(category.category);
    if (category.tag === "lost-cause") lostCauses.push(category.category);
  }
  return new OpponentScout({
    locks,
    coinFlips,
    lostCauses,
    categoryWeights: categoryWeightsFromScout(baseline),
  });
};

const seasonSgp = (
  line: WeeklyLine,
  denominators: Record<Category, number>,
  weights: Record<Category, number>,
) => {
  const totals = expectedTotals([line]);
  return CATEGORIES.reduce((sum, category) => {
    return sum + categorySgpValue(category, totals, denominators, weights);
  }, 0);
};

const playerKeyCompare = (a: WeeklyLine, b: WeeklyLine) => a.playerKey.localeCompare(b.playerKey);

const withVolatilityScale = (line: WeeklyLine, scale: number): WeeklyLine => {
  const volatility = (line.volatility ?? 1) * scale;
  if (line.kind === "batter") {
    const { volatility: _previous, ...rest } = line;
    return new WeeklyBatterLine({ ...rest, volatility });
  }
  const { volatility: _previous, ...rest } = line;
  return new WeeklyPitcherLine({ ...rest, volatility });
};

const weeklyFlipScore = (
  line: WeeklyLine,
  denominators: Record<Category, number>,
  weights: Record<Category, number>,
  scoringCategories: ReadonlySet<Category>,
) => {
  const totals = expectedTotals([line]);
  const applicableCategories = line.kind === "batter" ? BATTER_CATEGORIES : PITCHER_CATEGORIES;
  return [...scoringCategories].reduce((sum, category) => {
    if (!applicableCategories.has(category)) return sum;
    return sum + categorySgpValue(category, totals, denominators, weights);
  }, 0);
};

const selectSimCandidates = (
  freeAgents: ReadonlyArray<WeeklyLine>,
  denominators: Record<Category, number>,
  weights: Record<Category, number>,
  scoringCategories: ReadonlyArray<Category>,
) => {
  const scoringCategorySet = new Set(scoringCategories);
  const scored = freeAgents.map((candidate) => ({
    candidate,
    flipScore: weeklyFlipScore(candidate, denominators, weights, scoringCategorySet),
    seasonSgpDelta: seasonSgp(candidate, denominators, weights),
  }));
  const byFlip = [...scored].sort(
    (a, b) =>
      b.flipScore - a.flipScore ||
      b.seasonSgpDelta - a.seasonSgpDelta ||
      playerKeyCompare(a.candidate, b.candidate),
  );
  const bySeason = [...scored].sort(
    (a, b) =>
      b.seasonSgpDelta - a.seasonSgpDelta ||
      b.flipScore - a.flipScore ||
      playerKeyCompare(a.candidate, b.candidate),
  );

  const selected = new Map<string, (typeof scored)[number]>();
  for (const entry of bySeason.slice(0, 3)) selected.set(entry.candidate.playerKey, entry);
  for (const entry of byFlip) {
    if (selected.size >= MAX_SIMULATED_ADD_CANDIDATES) break;
    selected.set(entry.candidate.playerKey, entry);
  }

  return [...selected.values()]
    .sort(
      (a, b) =>
        b.flipScore - a.flipScore ||
        b.seasonSgpDelta - a.seasonSgpDelta ||
        playerKeyCompare(a.candidate, b.candidate),
    )
    .map(
      ({ candidate, seasonSgpDelta }) => new SimJobCandidate({ line: candidate, seasonSgpDelta }),
    );
};

const categorySgpValue = (
  category: Category,
  totals: Totals,
  denominators: Record<Category, number>,
  weights: Record<Category, number>,
) => {
  const values = toCategoryValues(totals);
  const denominator = denominators[category];
  const weight = weights[category] ?? 0;
  if (category === "OBP") {
    const impact =
      ((values.OBP - LEAGUE_AVG_OBP) * totals.obpDenominator) / TEAM_SEASON_OBP_DENOMINATOR;
    return (impact / denominator) * weight;
  }
  if (category === "ERA") {
    const impact = ((LEAGUE_AVG_ERA - values.ERA) * totals.ip) / TEAM_SEASON_IP;
    return (impact / denominator) * weight;
  }
  if (category === "WHIP") {
    const impact = ((LEAGUE_AVG_WHIP - values.WHIP) * totals.ip) / TEAM_SEASON_IP;
    return (impact / denominator) * weight;
  }
  return (values[category] / denominator) * weight;
};

const categoryDelta = (
  before: MatchupSimulation,
  after: MatchupSimulation,
  candidate: WeeklyLine,
  denominators: Record<Category, number>,
  weights: Record<Category, number>,
  scoringCategories: ReadonlySet<Category>,
) => {
  const beforeByCategory = new Map(
    before.categories.map((category) => [category.category, category]),
  );
  const candidateTotals = expectedTotals([candidate]);
  const applicableCategories = candidate.kind === "batter" ? BATTER_CATEGORIES : PITCHER_CATEGORIES;
  return after.categories
    .filter(
      (category) =>
        applicableCategories.has(category.category as Category) &&
        scoringCategories.has(category.category as Category),
    )
    .map((category) => {
      const name = category.category as Category;
      const weeklyDelta =
        (category.expectedPoints - (beforeByCategory.get(category.category)?.expectedPoints ?? 0)) *
        weights[name];
      const seasonSgpDelta = categorySgpValue(name, candidateTotals, denominators, weights);
      return new CategoryDelta({
        category: category.category,
        weeklyDelta,
        seasonSgpDelta,
      });
    })
    .filter((delta) => delta.weeklyDelta > 0.01 || delta.seasonSgpDelta > 0.01)
    .sort(
      (a, b) =>
        Math.max(b.weeklyDelta, b.seasonSgpDelta) - Math.max(a.weeklyDelta, a.seasonSgpDelta),
    )
    .slice(0, 5);
};

const activeSlotCount = (snapshot: LeagueStateSnapshot | undefined, kind: WeeklyLine["kind"]) => {
  if (snapshot == null) return 0;
  const slots = snapshot.rosterSlots.filter((slot) =>
    kind === "batter" ? isBatterSlot(slot) : isPitcherSlot(slot),
  );
  return slots.reduce((sum, slot) => sum + slot.count, 0);
};

const isBatterSlot = (slot: RosterSlotCount) =>
  ["C", "1B", "2B", "3B", "SS", "OF", "Util"].includes(slot.position);

const isPitcherSlot = (slot: RosterSlotCount) => ["P", "SP", "RP"].includes(slot.position);

const isActive = (player: LeagueStatePlayer | undefined) =>
  player != null && !["BN", "IL", "IL+", "NA"].includes(player.selectedPosition);

const isActiveSelectedPosition = (selectedPosition: string | undefined) =>
  selectedPosition != null && !["BN", "IL", "IL+", "NA"].includes(selectedPosition);

const isHardUnavailableStatus = (status: string | undefined) =>
  status != null &&
  (status.startsWith("IL") || status === "NA" || status === "O" || status === "SUSP");

const isStartableReserve = (player: LeagueStatePlayer | undefined) =>
  player != null && player.selectedPosition === "BN" && !isHardUnavailableStatus(player.status);

const canFillSelectedPosition = (
  player: LeagueStatePlayer | undefined,
  selectedPosition: string,
  kind: WeeklyLine["kind"],
) => {
  if (player == null) return false;
  if (kind === "batter") {
    if (selectedPosition === "Util") return true;
    return player.eligiblePositions.includes(selectedPosition);
  }
  if (selectedPosition === "P") return true;
  return player.eligiblePositions.includes(selectedPosition);
};

type LineupAssignment = {
  readonly line: WeeklyLine;
  readonly score: number;
  readonly slot: string;
};

const optimalAssignments = (
  ranked: ReadonlyArray<{ readonly line: WeeklyLine; readonly score: number }>,
  slots: ReadonlyArray<string>,
  rosterByKey: ReadonlyMap<string, LeagueStatePlayer>,
  kind: WeeklyLine["kind"],
) => {
  const orderedSlots = [...slots].sort((a, b) => {
    const aEligible = ranked.filter((entry) =>
      canFillSelectedPosition(rosterByKey.get(entry.line.playerKey), a, kind),
    ).length;
    const bEligible = ranked.filter((entry) =>
      canFillSelectedPosition(rosterByKey.get(entry.line.playerKey), b, kind),
    ).length;
    return aEligible - bEligible;
  });

  let bestScore = -Infinity;
  let bestAssignments: ReadonlyArray<LineupAssignment> = [];

  const search = (
    slotIndex: number,
    usedKeys: ReadonlySet<string>,
    score: number,
    assignments: ReadonlyArray<LineupAssignment>,
  ) => {
    if (slotIndex >= orderedSlots.length) {
      if (score > bestScore) {
        bestScore = score;
        bestAssignments = assignments;
      }
      return;
    }

    const slot = orderedSlots[slotIndex]!;
    for (const entry of ranked) {
      if (usedKeys.has(entry.line.playerKey)) continue;
      if (!canFillSelectedPosition(rosterByKey.get(entry.line.playerKey), slot, kind)) continue;
      search(slotIndex + 1, new Set([...usedKeys, entry.line.playerKey]), score + entry.score, [
        ...assignments,
        { ...entry, slot },
      ]);
    }
  };

  search(0, new Set(), 0, []);
  return bestAssignments;
};

export const activeWeeklyLines = (
  lines: ReadonlyArray<WeeklyLine>,
  snapshot: LeagueStateSnapshot | undefined,
) => {
  if (snapshot == null) return lines;
  const rosterByKey = new Map(snapshot.roster.map((player) => [player.playerKey, player]));
  return lines.filter((line) => {
    const player = rosterByKey.get(line.playerKey);
    if (player != null) return isActive(player);
    return isActiveSelectedPosition(line.selectedPosition) || line.selectedPosition == null;
  });
};

const lineScore = (
  line: WeeklyLine,
  denominators: Record<Category, number>,
  weights: Record<Category, number>,
) => seasonSgp(line, denominators, weights);

export const optimizeLineup = (
  set: WeeklyProjectionSet,
  baseline: MatchupSimulation,
  snapshot?: LeagueStateSnapshot,
  denominators: Record<Category, number> = SGP_DENOMINATORS,
) => {
  const weights = categoryWeightsFromScout(baseline);
  const scoringCategorySet = new Set(scoringCategoriesForSnapshot(snapshot));
  const rosterByKey = new Map(snapshot?.roster.map((player) => [player.playerKey, player]) ?? []);
  const currentActive = new Set(
    snapshot?.roster.filter((player) => isActive(player)).map((player) => player.playerKey) ?? [],
  );
  const buildRecommendations = (kind: WeeklyLine["kind"]) => {
    const lines = set.myRoster.filter((line) => {
      if (line.kind !== kind) return false;
      if (snapshot == null) return true;
      const player = rosterByKey.get(line.playerKey);
      return currentActive.has(line.playerKey) || isStartableReserve(player);
    });
    const activeSlots =
      snapshot == null
        ? Array.from(
            { length: Math.min(activeSlotCount(snapshot, kind) || lines.length, lines.length) },
            () => (kind === "batter" ? "Util" : "P"),
          )
        : lines.flatMap((line) => {
            if (!currentActive.has(line.playerKey)) return [];
            const position = rosterByKey.get(line.playerKey)?.selectedPosition;
            return position == null ? [] : [position];
          });
    if (activeSlots.length <= 0)
      return {
        recommendations: [] as Array<LineupRecommendation>,
        optimalLineup: [] as Array<OptimalLineupSlot>,
        optimalBench: [] as Array<OptimalLineupBench>,
      };
    const ranked = lines
      .map((line) => ({ line, score: lineScore(line, denominators, weights) }))
      .sort((a, b) => b.score - a.score);
    const assignments =
      snapshot == null
        ? ranked.slice(0, activeSlots.length).map((entry, index) => ({
            ...entry,
            slot: activeSlots[index] ?? (kind === "batter" ? "Util" : "P"),
          }))
        : optimalAssignments(ranked, activeSlots, rosterByKey, kind);
    const shouldStart = new Set(assignments.map((entry) => entry.line.playerKey));
    const optimalLineup = assignments.map(
      (entry) =>
        new OptimalLineupSlot({
          slot: entry.slot,
          kind,
          playerKey: entry.line.playerKey,
          playerName: entry.line.name,
          score: entry.score,
          isCurrentStarter: currentActive.has(entry.line.playerKey),
        }),
    );
    const sitCandidates = ranked
      .filter(
        (entry) =>
          currentActive.has(entry.line.playerKey) && !shouldStart.has(entry.line.playerKey),
      )
      .sort((a, b) => a.score - b.score);
    const optimalBench = sitCandidates.map(
      (entry) =>
        new OptimalLineupBench({
          kind,
          playerKey: entry.line.playerKey,
          playerName: entry.line.name,
          score: entry.score,
        }),
    );
    const startCandidates = ranked.filter(
      (entry) =>
        !currentActive.has(entry.line.playerKey) &&
        shouldStart.has(entry.line.playerKey) &&
        (snapshot == null || isStartableReserve(rosterByKey.get(entry.line.playerKey))),
    );
    const usedSitKeys = new Set<string>();
    const recommendations = startCandidates.flatMap((bench) => {
      const benchPlayer = rosterByKey.get(bench.line.playerKey);
      const sit = sitCandidates.find((candidate) => {
        if (usedSitKeys.has(candidate.line.playerKey)) return false;
        const sitPlayer = rosterByKey.get(candidate.line.playerKey);
        if (snapshot == null) return true;
        return canFillSelectedPosition(benchPlayer, sitPlayer?.selectedPosition ?? "", kind);
      });
      if (sit == null) return [];
      const scoreDelta = bench.score - sit.score;
      if (scoreDelta <= 0) return [];
      usedSitKeys.add(sit.line.playerKey);
      return [
        new LineupRecommendation({
          type: "lineup",
          startPlayerKey: bench.line.playerKey,
          startPlayerName: bench.line.name,
          sitPlayerKey: sit.line.playerKey,
          sitPlayerName: sit.line.name,
          scoreDelta,
          affectedCategories: categoryLineDeltas(
            bench.line,
            sit.line,
            denominators,
            weights,
            scoringCategorySet,
          ),
        }),
      ];
    });
    return { recommendations, optimalLineup, optimalBench };
  };
  const batter = buildRecommendations("batter");
  const pitcher = buildRecommendations("pitcher");
  return {
    recommendations: [...batter.recommendations, ...pitcher.recommendations].sort(
      (a, b) => b.scoreDelta - a.scoreDelta,
    ),
    optimalLineup: [...batter.optimalLineup, ...pitcher.optimalLineup],
    optimalBench: [...batter.optimalBench, ...pitcher.optimalBench],
  };
};

const categoryLineDeltas = (
  add: WeeklyLine,
  remove: WeeklyLine,
  denominators: Record<Category, number>,
  weights: Record<Category, number>,
  scoringCategories: ReadonlySet<Category> = new Set(CATEGORIES),
) => {
  const addTotals = expectedTotals([add]);
  const removeTotals = expectedTotals([remove]);
  return [...scoringCategories]
    .map((category) => {
      const seasonSgpDelta =
        categorySgpValue(category, addTotals, denominators, weights) -
        categorySgpValue(category, removeTotals, denominators, weights);
      return new CategoryDelta({
        category,
        weeklyDelta: seasonSgpDelta,
        seasonSgpDelta,
      });
    })
    .filter((delta) => delta.weeklyDelta > 0.01 || delta.seasonSgpDelta > 0.01)
    .sort(
      (a, b) =>
        Math.max(b.weeklyDelta, b.seasonSgpDelta) - Math.max(a.weeklyDelta, a.seasonSgpDelta),
    )
    .slice(0, 5);
};

// The optimal-lineup pieces optimizeLineup produces. Precomputed in prepareSimJob (which has
// set+snapshot+baseline+denominators) and carried in the stored payload so reduceSimJob — which
// only receives the stored spec + candidate partials — can attach them without re-reading
// set/snapshot (approach (a) for the optimizeLineup data dependency).
export class StoredLineup extends Schema.Class<StoredLineup>("StoredLineup")({
  recommendations: Schema.Array(LineupRecommendation),
  optimalLineup: Schema.Array(OptimalLineupSlot),
  optimalBench: Schema.Array(OptimalLineupBench),
}) {}

// Everything stage 1 persists: the serializable SimJobSpec + baseline UnitPartial + unitCount
// (from SimJob.ts), plus the precomputed lineup and the sgpDenominatorSource flag (both derived in
// prepareSimJob and needed by reduce). Composed in DecisionEngine.ts so it can reference the lineup
// Schema.Classes without SimJob.ts importing DecisionEngine (avoids an import cycle).
export class StoredSimJob extends Schema.Class<StoredSimJob>("StoredSimJob")({
  stored: StoredSimJobSpec,
  lineup: StoredLineup,
  sgpDenominatorSource: Schema.Union([
    Schema.Literal("standings-history"),
    Schema.Literal("fallback"),
  ]),
}) {}

// CRN: the seed is unit-INDEPENDENT — every unit (baseline + each candidate) shares it so the
// opponent stream (and the shared-roster part of mine's stream) draws identically across units,
// making Δ = candidate − baseline low-variance. The ONLY seed perturbation is chunkIndex, used when
// a unit's iterations are split across chunks (simChunksPerUnit > 1). This corrects the outline's
// `seed = baseSeed + unitIndex*STRIDE + chunkIndex`: the `unitIndex*STRIDE` term would give each
// unit a different opponent stream and destroy CRN. Per-unit distinctness comes from the differing
// roster (and the D1 partial key), not the seed. With the default chunkCount=1 every unit uses
// `baseSeed` (= 62744), exactly reproducing today's rankAddCandidates.
const unitSeed = (baseSeed: number, chunkIndex: number) => (baseSeed + chunkIndex) >>> 0;

// Partition `total` iterations across `chunkCount` chunks: each chunk gets floor(total/chunkCount),
// and the first `total % chunkCount` chunks get one extra (deterministic remainder handling). Summed
// across chunks this is exactly `total`.
const chunkIterations = (total: number, chunkIndex: number, chunkCount: number) => {
  const base = Math.floor(total / chunkCount);
  const remainder = total % chunkCount;
  return base + (chunkIndex < remainder ? 1 : 0);
};

const rosterForUnit = (spec: SimJobSpec, unitIndex: number): ReadonlyArray<WeeklyLine> =>
  unitIndex === 0
    ? (spec.scoringRoster as ReadonlyArray<WeeklyLine>)
    : [
        ...(spec.scoringRoster as ReadonlyArray<WeeklyLine>),
        spec.candidates[unitIndex - 1]!.line as WeeklyLine,
      ];

// STAGE 1 (cheap except 1 baseline sim). Builds the fan-out-able job spec: runs the baseline sim
// INLINE (approach (A)) to derive scout weights, which drive candidate selection (the "weights
// ordering gotcha"), selects the top MAX_SIMULATED_ADD_CANDIDATES candidates exactly as today, and
// precomputes the optimal lineup. unitCount = number of CANDIDATE units (candidates.length); the
// heavy fan-out is over candidate units only, not the baseline.
export const prepareSimJob = (
  set: WeeklyProjectionSet,
  snapshot?: LeagueStateSnapshot,
  standingsHistory: ReadonlyArray<StandingCategoryTotal> = [],
  contextAt?: string,
  volatilityScale = 1,
): StoredSimJob => {
  const scoringCategories = scoringCategoriesForSnapshot(snapshot);
  const scaledSet = new WeeklyProjectionSet({
    myRoster: set.myRoster.map((line) => withVolatilityScale(line, volatilityScale)),
    opponentRoster: set.opponentRoster.map((line) => withVolatilityScale(line, volatilityScale)),
    freeAgents: set.freeAgents.map((line) => withVolatilityScale(line, volatilityScale)),
    schedules: set.schedules,
    dailyGameWindows: set.dailyGameWindows,
    probablePitcherStarts: set.probablePitcherStarts,
  });
  const scoringRoster = activeWeeklyLines(scaledSet.myRoster, snapshot);
  const opponentRoster = activeWeeklyLines(scaledSet.opponentRoster, snapshot);
  const banked =
    snapshot == null
      ? zeroBanked()
      : new SimJobBankedTotals({
          mine: bankedFromMatchup(
            snapshot.matchup.categories,
            "mine",
            estimatedConsumedPa(scoringRoster, snapshot, contextAt),
          ),
          opponent: bankedFromMatchup(
            snapshot.matchup.categories,
            "opponent",
            estimatedConsumedPa(opponentRoster, snapshot, contextAt),
          ),
        });
  const baselinePartial = simulateRawCounters(
    scoringRoster,
    opponentRoster,
    62744,
    PRODUCTION_SIMULATION_COUNT,
    scoringCategories,
    banked,
  );
  const baseline = aggregateMatchup(baselinePartial, scoringCategories);
  const scout = scoutOpponent(baseline);
  const weights = scout.categoryWeights as Record<Category, number>;
  const denominators = computeSgpDenominators(standingsHistory);
  const candidates = selectSimCandidates(
    scaledSet.freeAgents,
    denominators,
    weights,
    scoringCategories,
  );

  const spec = new SimJobSpec({
    scoringCategories,
    scoringRoster,
    opponentRoster,
    candidates,
    denominators,
    baseSeed: 62744,
    banked,
    volatilityScale,
  });

  const lineup = optimizeLineup(scaledSet, baseline, snapshot, denominators);

  return new StoredSimJob({
    stored: new StoredSimJobSpec({
      spec,
      baseline: baselinePartial,
      unitCount: candidates.length,
      contextAt,
    }),
    lineup: new StoredLineup({
      recommendations: lineup.recommendations,
      optimalLineup: lineup.optimalLineup,
      optimalBench: lineup.optimalBench,
    }),
    sgpDenominatorSource: hasUsableSgpHistory(standingsHistory) ? "standings-history" : "fallback",
  });
};

// STAGE 2 (the heavy work, one invocation per unit). Runs ONE sim unit and returns its raw
// counters. unitIndex 0 = baseline; 1..N = candidate i-1. The roster differs per unit (baseline vs
// roster+candidate); the seed does NOT depend on unitIndex (see unitSeed — CRN). chunkIndex/chunkCount
// slice PRODUCTION_SIMULATION_COUNT so a unit can be split across cheap invocations; the per-chunk
// partials sum exactly to a single full run (each chunk = seed baseSeed+chunkIndex over its iteration
// slice). chunkCount=1 ⇒ seed=baseSeed over all iterations, identical to today.
export const simulateUnit = (
  stored: StoredSimJob,
  unitIndex: number,
  chunkIndex = 0,
  chunkCount = 1,
): UnitPartial => {
  const spec = stored.stored.spec;
  const scoringCategories = spec.scoringCategories as ReadonlyArray<Category>;
  const iterations = chunkIterations(PRODUCTION_SIMULATION_COUNT, chunkIndex, chunkCount);
  return simulateRawCounters(
    rosterForUnit(spec, unitIndex),
    spec.opponentRoster as ReadonlyArray<WeeklyLine>,
    unitSeed(spec.baseSeed, chunkIndex),
    iterations,
    scoringCategories,
    spec.banked ?? zeroBanked(),
  );
};

// STAGE 3 (cheap). Sums the baseline partial (from the stored spec) + the candidate unit partials,
// aggregates each to a MatchupSimulation, then runs the existing post-sim logic (weeklyDelta/score
// per candidate + affected categories) and attaches the precomputed lineup → a DecisionReport
// byte-identical to today's rankAddCandidates. `candidateUnitPartials[i]` is the (chunk-summed)
// partial for candidate i (unit i+1), in candidate order.
export const reduceSimJob = (
  stored: StoredSimJob,
  candidateUnitPartials: ReadonlyArray<UnitPartial>,
): DecisionReport => {
  const spec = stored.stored.spec;
  const scoringCategories = spec.scoringCategories as ReadonlyArray<Category>;
  const scoringCategorySet = new Set(scoringCategories);
  const denominators = spec.denominators as Record<Category, number>;
  const baseline = aggregateMatchup(stored.stored.baseline, scoringCategories);
  const scout = scoutOpponent(baseline);
  const weights = scout.categoryWeights as Record<Category, number>;

  const recommendations = spec.candidates
    .map((entry, index) => {
      const candidate = entry.line as WeeklyLine;
      const seasonSgpDelta = entry.seasonSgpDelta;
      const after = aggregateMatchup(candidateUnitPartials[index]!, scoringCategories);
      const weeklyDelta = after.categories.reduce((sum, category) => {
        const name = category.category as Category;
        const applicableCategories =
          candidate.kind === "batter" ? BATTER_CATEGORIES : PITCHER_CATEGORIES;
        if (!applicableCategories.has(name) || !scoringCategorySet.has(name)) return sum;
        const before = baseline.categories.find((entry) => entry.category === category.category);
        // F1: pure Σ_c Δ(expected category wins+ties). The win-prob gradient already encodes
        // marginal value (§1.3) — a locked/lost category's Δ is ≈0 by saturation — so the bucket
        // weight is intentionally NOT applied here; it would double-count and distort the objective.
        return sum + (category.expectedPoints - (before?.expectedPoints ?? 0));
      }, 0);
      const score = WEEKLY_WEIGHT_ALPHA * weeklyDelta + (1 - WEEKLY_WEIGHT_ALPHA) * seasonSgpDelta;
      return new AddRecommendation({
        type: "add",
        playerKey: candidate.playerKey,
        playerName: candidate.name,
        score,
        weeklyDelta,
        seasonSgpDelta,
        affectedCategories: categoryDelta(
          baseline,
          after,
          candidate,
          denominators,
          weights,
          scoringCategorySet,
        ),
      });
    })
    .sort((a, b) => b.score - a.score);

  return new DecisionReport({
    baseline,
    scout,
    sgpDenominatorSource: stored.sgpDenominatorSource,
    recommendations,
    lineupRecommendations: stored.lineup.recommendations,
    optimalLineup: stored.lineup.optimalLineup,
    optimalBench: stored.lineup.optimalBench,
  });
};

// Cheap reuse path for F8 calibration. Derives the baseline MatchupSimulation + the exact simulated
// rosters from an ALREADY-built spec, whose baseline counters are computed ONCE during spec-build and
// persisted. Calibration previously called rankAddCandidates on every scheduler tick, which re-ran
// the FULL Monte Carlo (baseline + every candidate) inline — the dominant per-tick CPU cost that
// defeated the fan-out and stalled the briefing pipeline. This is pure aggregation (no sim).
export const calibrationInputsFromSpec = (
  stored: StoredSimJob,
): {
  readonly baseline: MatchupSimulation;
  readonly myRoster: ReadonlyArray<WeeklyLine>;
  readonly opponentRoster: ReadonlyArray<WeeklyLine>;
} => ({
  baseline: aggregateMatchup(
    stored.stored.baseline,
    stored.stored.spec.scoringCategories as ReadonlyArray<Category>,
  ),
  myRoster: stored.stored.spec.scoringRoster as ReadonlyArray<WeeklyLine>,
  opponentRoster: stored.stored.spec.opponentRoster as ReadonlyArray<WeeklyLine>,
});

// Thin wrapper: in-process composition of the three stages. Keeps every existing caller
// (currentBriefing live path, /admin/preview/briefing?live=1, /debug/*) working unchanged, and is
// byte-identical to the old monolithic implementation. With chunkCount defaulting to 1, the seed is
// baseSeed (62744) for every unit — exactly the old per-call seed.
export const rankAddCandidates = (
  set: WeeklyProjectionSet,
  snapshot?: LeagueStateSnapshot,
  standingsHistory: ReadonlyArray<StandingCategoryTotal> = [],
): DecisionReport => {
  const stored = prepareSimJob(set, snapshot, standingsHistory);
  const partials = stored.stored.spec.candidates.map((_, index) => simulateUnit(stored, index + 1));
  return reduceSimJob(stored, partials);
};

const mapError = (error: WeeklyProjectionsError | YahooApiError | StandingsHistoryError) =>
  new DecisionEngineError({ message: `${error._tag}: ${error.message}` });

export class DecisionEngine extends Context.Service<
  DecisionEngine,
  {
    readonly currentAddRecommendations: Effect.Effect<DecisionReport, DecisionEngineError>;
  }
>()("fantasy-gm/DecisionEngine") {
  static readonly layerLive = Layer.effect(
    DecisionEngine,
    Effect.gen(function* () {
      const weeklyProjections = yield* WeeklyProjections;
      const leagueState = yield* LeagueState;
      const standingsHistory = yield* StandingsHistory;
      return DecisionEngine.of({
        currentAddRecommendations: Effect.gen(function* () {
          const [set, snapshot, categoryTotals] = yield* Effect.all([
            weeklyProjections.currentMatchup,
            leagueState.snapshot,
            standingsHistory.categoryTotals,
          ]);
          return rankAddCandidates(set, snapshot, categoryTotals);
        }).pipe(Effect.mapError(mapError)),
      });
    }),
  );
}
