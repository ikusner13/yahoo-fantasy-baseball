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
import {
  type WeeklyBatterLine,
  WeeklyProjectionSet,
  type WeeklyPitcherLine,
} from "./ProjectionModel.ts";
import {
  StandingsHistory,
  StandingsHistoryError,
  type StandingCategoryTotal,
} from "./StandingsHistory.ts";
import { WeeklyProjections, WeeklyProjectionsError } from "./WeeklyProjections.ts";
import { type YahooApiError } from "./YahooClient.ts";

export const PRODUCTION_SIMULATION_COUNT = 5_000;
export const MAX_SIMULATED_ADD_CANDIDATES = 6;
const WEEKLY_WEIGHT_ALPHA = 0.75;
const TEAM_SEASON_OBP_DENOMINATOR = 6500;
const TEAM_SEASON_IP = 1400;
const LEAGUE_AVG_OBP = 0.32;
const LEAGUE_AVG_ERA = 4.1;
const LEAGUE_AVG_WHIP = 1.28;

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
  return toCategoryValues(totals);
};

const tagCategory = (winProbability: number) => {
  if (winProbability >= 0.85) return "lock" as const;
  if (winProbability <= 0.15) return "lost-cause" as const;
  if (winProbability >= 0.35 && winProbability <= 0.65) return "coin-flip" as const;
  return "lean" as const;
};

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

export const simulateMatchup = (
  myRoster: ReadonlyArray<WeeklyLine>,
  opponentRoster: ReadonlyArray<WeeklyLine>,
  iterations = PRODUCTION_SIMULATION_COUNT,
  seed = 62744,
  scoringCategories: ReadonlyArray<Category> = CATEGORIES,
) => {
  const random = createRandom(seed);
  const results = new Map<
    Category,
    { wins: number; ties: number; marginSum: number; marginSqSum: number }
  >(
    scoringCategories.map((category) => [
      category,
      { wins: 0, ties: 0, marginSum: 0, marginSqSum: 0 },
    ]),
  );

  for (let index = 0; index < iterations; index += 1) {
    const mine = sampleTeam(myRoster, random);
    const opponent = sampleTeam(opponentRoster, random);
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

  const categories = scoringCategories.map((category) => {
    const result = results.get(category) ?? { wins: 0, ties: 0, marginSum: 0, marginSqSum: 0 };
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

const categoryWeightsFromScout = (baseline: MatchupSimulation) =>
  Object.fromEntries(
    baseline.categories.map((category) => {
      const weight = category.tag === "coin-flip" ? 1.75 : category.tag === "lean" ? 1 : 0.2;
      return [category.category, weight];
    }),
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
  const activeKeys = new Set(
    snapshot.roster.filter((player) => isActive(player)).map((player) => player.playerKey),
  );
  return lines.filter((line) => activeKeys.has(line.playerKey));
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

export const rankAddCandidates = (
  set: WeeklyProjectionSet,
  snapshot?: LeagueStateSnapshot,
  standingsHistory: ReadonlyArray<StandingCategoryTotal> = [],
) => {
  const scoringCategories = scoringCategoriesForSnapshot(snapshot);
  const scoringCategorySet = new Set(scoringCategories);
  const scoringRoster = activeWeeklyLines(set.myRoster, snapshot);
  const baseline = simulateMatchup(
    scoringRoster,
    set.opponentRoster,
    undefined,
    62744,
    scoringCategories,
  );
  const scout = scoutOpponent(baseline);
  const weights = scout.categoryWeights as Record<Category, number>;
  const denominators = computeSgpDenominators(standingsHistory);
  const candidates = set.freeAgents
    .map((candidate) => ({
      candidate,
      seasonSgpDelta: seasonSgp(candidate, denominators, weights),
    }))
    .sort((a, b) => b.seasonSgpDelta - a.seasonSgpDelta)
    .slice(0, MAX_SIMULATED_ADD_CANDIDATES);
  const recommendations = candidates
    .map(({ candidate, seasonSgpDelta }) => {
      const after = simulateMatchup(
        [...scoringRoster, candidate],
        set.opponentRoster,
        undefined,
        62744,
        scoringCategories,
      );
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

  const lineup = optimizeLineup(set, baseline, snapshot, denominators);

  return new DecisionReport({
    baseline,
    scout,
    sgpDenominatorSource: hasUsableSgpHistory(standingsHistory) ? "standings-history" : "fallback",
    recommendations,
    lineupRecommendations: lineup.recommendations,
    optimalLineup: lineup.optimalLineup,
    optimalBench: lineup.optimalBench,
  });
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
