import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  AddRecommendation,
  activeWeeklyLines,
  DecisionEngineError,
  rankAddCandidates,
  type DecisionReport,
} from "./DecisionEngine.ts";
import { LeagueState, type LeagueStateSnapshot, type RosterSlotCount } from "./LeagueState.ts";
import {
  type WeeklyBatterLine,
  WeeklyProjectionSet,
  type WeeklyPitcherLine,
} from "./ProjectionModel.ts";
import { StandingsHistory, StandingsHistoryError } from "./StandingsHistory.ts";
import { WeeklyProjections, WeeklyProjectionsError } from "./WeeklyProjections.ts";
import { type YahooApiError } from "./YahooClient.ts";

const WEEKLY_IP_FLOOR = 20;
const EARLY_WEEK_RESERVE_ADDS = 3;
const MID_WEEK_RESERVE_ADDS = 2;
const EMPTY_SLOT_VOLUME_MULTIPLIER = 0.35;
const STREAMING_SKILL_MIN_K_PER_IP = 0.85;
const STREAMING_RATIO_ERA_LIMIT = 4.5;
const STREAMING_RATIO_WHIP_LIMIT = 1.35;
const STREAMING_RATIO_COIN_FLIP_ERA_LIMIT = 3.95;
const STREAMING_RATIO_COIN_FLIP_WHIP_LIMIT = 1.24;
const MIN_ADD_DROP_REPLACEMENT_EDGE = 1.25;
const MIN_ACTIVE_DROP_REPLACEMENT_EDGE = 3;
const MIN_SCARCE_POSITION_DROP_EDGE = 6;
const TOP_WAIVER_PRIORITY_CUTOFF = 3;
const TOP_WAIVER_MIN_SEASON_SGP = 1;
// F1: weeklyDelta is now Δ(expected-category-wins) units (≈ percentage points of category wins),
// not the old weighted-EV scale. 0.05 ≈ a 5-point swing in expected category wins.
const TOP_WAIVER_MIN_WEEKLY_DELTA = 0.05;
const LEAGUE_AVG_OBP = 0.32;
const LEAGUE_AVG_ERA = 4.1;
const LEAGUE_AVG_WHIP = 1.28;

type Availability = "free-agent" | "waiver";
type TransactionType = "free-agent-add" | "waiver-claim" | "add-drop";
type TransactionTiming = "now" | "reserve-late-week" | "sat-sun-priority";
type Guardrail =
  | "empty-slot-urgency"
  | "reserve-adds"
  | "sixth-add-weekend"
  | "svh-program"
  | "streaming-skills"
  | "ratio-protection"
  | "ip-floor"
  | "remaining-start"
  | "two-start-planning"
  | "il-stash-stream"
  | "open-roster-capacity";

type WeeklyLine = WeeklyBatterLine | WeeklyPitcherLine;

const ACTIVE_BATTER_SLOTS = new Set(["C", "1B", "2B", "3B", "SS", "OF", "Util"]);
const ACTIVE_PITCHER_SLOTS = new Set(["P", "SP", "RP"]);
const SCARCE_POSITIONS = new Set(["C", "2B", "3B", "SS"]);
const LOWER_IS_BETTER = new Set(["ERA", "WHIP"]);

type CategoryWeightMap = Readonly<Record<string, number>>;

export class TransactionStep extends Schema.Class<TransactionStep>("TransactionStep")({
  type: Schema.Union([
    Schema.Literal("free-agent-add"),
    Schema.Literal("waiver-claim"),
    Schema.Literal("add-drop"),
  ]),
  timing: Schema.Union([
    Schema.Literal("now"),
    Schema.Literal("reserve-late-week"),
    Schema.Literal("sat-sun-priority"),
  ]),
  addPlayerKey: Schema.String,
  addPlayerName: Schema.String,
  dropPlayerKey: Schema.optional(Schema.String),
  dropPlayerName: Schema.optional(Schema.String),
  score: Schema.Finite,
  affectedCategories: Schema.Array(Schema.String),
  guardrails: Schema.Array(
    Schema.Union([
      Schema.Literal("empty-slot-urgency"),
      Schema.Literal("reserve-adds"),
      Schema.Literal("sixth-add-weekend"),
      Schema.Literal("svh-program"),
      Schema.Literal("streaming-skills"),
      Schema.Literal("ratio-protection"),
      Schema.Literal("ip-floor"),
      Schema.Literal("remaining-start"),
      Schema.Literal("two-start-planning"),
      Schema.Literal("il-stash-stream"),
      Schema.Literal("open-roster-capacity"),
    ]),
  ),
  rationale: Schema.String,
}) {}

export class TransactionCategorySituation extends Schema.Class<TransactionCategorySituation>(
  "TransactionCategorySituation",
)({
  category: Schema.String,
  myValue: Schema.String,
  opponentValue: Schema.String,
  status: Schema.Union([
    Schema.Literal("winning"),
    Schema.Literal("losing"),
    Schema.Literal("tied"),
  ]),
}) {}

export class RejectedTransaction extends Schema.Class<RejectedTransaction>("RejectedTransaction")({
  addPlayerName: Schema.String,
  dropPlayerName: Schema.optional(Schema.String),
  score: Schema.Finite,
  affectedCategories: Schema.Array(Schema.String),
  reason: Schema.String,
}) {}

export class TransactionLineupRecommendation extends Schema.Class<TransactionLineupRecommendation>(
  "TransactionLineupRecommendation",
)({
  startPlayerKey: Schema.String,
  startPlayerName: Schema.String,
  sitPlayerKey: Schema.String,
  sitPlayerName: Schema.String,
  scoreDelta: Schema.Finite,
  affectedCategories: Schema.Array(Schema.String),
}) {}

export class TransactionOptimalLineupSlot extends Schema.Class<TransactionOptimalLineupSlot>(
  "TransactionOptimalLineupSlot",
)({
  slot: Schema.String,
  kind: Schema.Union([Schema.Literal("batter"), Schema.Literal("pitcher")]),
  playerKey: Schema.String,
  playerName: Schema.String,
  score: Schema.Finite,
  isCurrentStarter: Schema.Boolean,
}) {}

export class TransactionOptimalLineupBench extends Schema.Class<TransactionOptimalLineupBench>(
  "TransactionOptimalLineupBench",
)({
  kind: Schema.Union([Schema.Literal("batter"), Schema.Literal("pitcher")]),
  playerKey: Schema.String,
  playerName: Schema.String,
  score: Schema.Finite,
}) {}

export class TransactionPitcherStart extends Schema.Class<TransactionPitcherStart>(
  "TransactionPitcherStart",
)({
  playerKey: Schema.String,
  playerName: Schema.String,
  selectedPosition: Schema.String,
  expectedStarts: Schema.Finite,
  projectedIp: Schema.Finite,
  projectedK: Schema.Finite,
  starts: Schema.Array(
    Schema.Struct({
      date: Schema.String,
      opponentTeam: Schema.String,
      gameTime: Schema.optional(Schema.String),
      homeAway: Schema.Union([Schema.Literal("home"), Schema.Literal("away")]),
    }),
  ),
}) {}

export class TransactionDailyGameWindow extends Schema.Class<TransactionDailyGameWindow>(
  "TransactionDailyGameWindow",
)({
  date: Schema.String,
  games: Schema.Finite,
  remainingGames: Schema.Finite,
  firstGameTime: Schema.optional(Schema.String),
  lastGameTime: Schema.optional(Schema.String),
}) {}

export class TransactionPlan extends Schema.Class<TransactionPlan>("TransactionPlan")({
  addsRemaining: Schema.Finite,
  reservedAdds: Schema.Finite,
  projectedWeeklyIp: Schema.Finite,
  sgpDenominatorSource: Schema.optional(
    Schema.Union([Schema.Literal("standings-history"), Schema.Literal("fallback")]),
  ),
  closestCategories: Schema.Array(Schema.String),
  categorySituations: Schema.Array(TransactionCategorySituation),
  todayGameWindow: Schema.optional(TransactionDailyGameWindow),
  lineupRecommendations: Schema.Array(TransactionLineupRecommendation),
  optimalLineup: Schema.Array(TransactionOptimalLineupSlot),
  optimalBench: Schema.Array(TransactionOptimalLineupBench),
  pitcherStarts: Schema.optional(Schema.Array(TransactionPitcherStart)),
  rejectedTransactions: Schema.Array(RejectedTransaction),
  steps: Schema.Array(TransactionStep),
}) {}

export class TransactionPlannerError extends Data.TaggedError("TransactionPlannerError")<{
  readonly message: string;
}> {}

export interface TransactionPlanOptions {
  readonly asOf?: Date;
  readonly availabilityByPlayerKey?: Readonly<Record<string, Availability>>;
}

const activeEmptySlots = (snapshot: LeagueStateSnapshot, line: WeeklyLine) =>
  snapshot.emptySlots.filter((slot) =>
    line.kind === "batter"
      ? ACTIVE_BATTER_SLOTS.has(slot.position) && lineCanFillSlot(line, slot.position)
      : ACTIVE_PITCHER_SLOTS.has(slot.position) && lineCanFillSlot(line, slot.position),
  );

const lineCanFillSlot = (line: WeeklyLine, slot: string) => {
  const positions = line.eligiblePositions;
  if (positions == null || positions.length === 0) return true;
  if (line.kind === "batter") {
    if (slot === "Util") {
      return positions.some((position) =>
        ["C", "1B", "2B", "3B", "SS", "OF", "Util"].includes(position),
      );
    }
    return positions.includes(slot);
  }
  if (slot === "P") return positions.some((position) => ["SP", "RP", "P"].includes(position));
  return positions.includes(slot);
};

const benchEmptySlots = (snapshot: LeagueStateSnapshot) =>
  snapshot.emptySlots.filter((slot) => slot.position === "BN");

const slotCount = (slots: ReadonlyArray<RosterSlotCount>) =>
  slots.reduce((sum, slot) => sum + slot.count, 0);

const projectedIp = (lines: ReadonlyArray<WeeklyLine>) =>
  lines.reduce((sum, line) => sum + (line.kind === "pitcher" ? line.ip : 0), 0);

const currentMatchupIp = (snapshot: LeagueStateSnapshot) => {
  const outCategory = snapshot.matchup.categories.find((category) => category.category === "OUT");
  const out = outCategory == null ? undefined : numericValue(outCategory.myValue);
  return out == null ? 0 : out / 3;
};

const easternDateKey = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const todayGameWindow = (set: WeeklyProjectionSet, asOf: Date) => {
  const window = set.dailyGameWindows?.find((entry) => entry.date === easternDateKey(asOf));
  if (window == null) return undefined;
  return new TransactionDailyGameWindow({
    date: window.date,
    games: window.games,
    remainingGames: window.remainingGames,
    firstGameTime: window.firstGameTime,
    lastGameTime: window.lastGameTime,
  });
};

const weekDayIndex = (date: Date) => {
  const day = date.getUTCDay();
  return day === 0 ? 6 : day - 1;
};

const reserveAdds = (addsRemaining: number, asOf: Date) => {
  const day = weekDayIndex(asOf);
  if (day <= 1) return Math.min(EARLY_WEEK_RESERVE_ADDS, Math.max(0, addsRemaining - 1));
  if (day <= 3) return Math.min(MID_WEEK_RESERVE_ADDS, Math.max(0, addsRemaining - 1));
  return 0;
};

const timingFor = (
  scoreRank: number,
  addsRemaining: number,
  reservedAdds: number,
  asOf: Date,
  hasEmptySlot: boolean,
): TransactionTiming => {
  if (addsRemaining === 1 && weekDayIndex(asOf) >= 5) return "sat-sun-priority";
  if (!hasEmptySlot && scoreRank >= Math.max(1, addsRemaining - reservedAdds))
    return "reserve-late-week";
  return "now";
};

const closestCategories = (report: DecisionReport) =>
  report.baseline.categories
    .filter((category) => category.tag === "coin-flip" || category.tag === "lean")
    .sort((a, b) => Math.abs(0.5 - a.winProbability) - Math.abs(0.5 - b.winProbability))
    .map((category) => category.category)
    .slice(0, 5);

const numericValue = (value: string) => {
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const categoryStatus = (category: string, myValue: string, opponentValue: string) => {
  const mine = numericValue(myValue);
  const opponent = numericValue(opponentValue);
  if (mine == null || opponent == null || Math.abs(mine - opponent) < 0.0001) return "tied";
  const winning = LOWER_IS_BETTER.has(category) ? mine < opponent : mine > opponent;
  return winning ? "winning" : "losing";
};

const categorySituations = (snapshot: LeagueStateSnapshot) =>
  snapshot.matchup.categories
    .filter((category) => snapshot.scoringCategories.includes(category.category))
    .map(
      (category) =>
        new TransactionCategorySituation({
          category: category.category,
          myValue: category.myValue,
          opponentValue: category.opponentValue,
          status: categoryStatus(category.category, category.myValue, category.opponentValue),
        }),
    );

const affectedCategoryNames = (recommendation: AddRecommendation) =>
  recommendation.affectedCategories.map((delta) => delta.category);

const isCredibleLineCategory = (line: WeeklyLine, category: string) => {
  if (line.kind === "batter") {
    if (category === "R") return line.r >= 2;
    if (category === "H") return line.h >= 3;
    if (category === "HR") return line.hr >= 0.5;
    if (category === "RBI") return line.rbi >= 2;
    if (category === "SB") return line.sb >= 1;
    if (category === "TB") return line.tb >= 5;
    if (category === "OBP") return line.obp >= LEAGUE_AVG_OBP + 0.015 && line.obpDenominator >= 10;
    return false;
  }
  if (category === "OUT") return line.out >= 12;
  if (category === "K") return line.k >= 4;
  if (category === "QS") return line.qs >= 0.5;
  if (category === "SV+H") return line.svh >= 0.5;
  if (category === "ERA") return line.era <= LEAGUE_AVG_ERA - 0.25 && line.ip >= 3;
  if (category === "WHIP") return line.whip <= LEAGUE_AVG_WHIP - 0.08 && line.ip >= 3;
  return false;
};

const profileCategoryNames = (line: WeeklyLine) => {
  const categories =
    line.kind === "batter"
      ? ["RBI", "R", "H", "TB", "HR", "OBP", "SB"]
      : ["OUT", "K", "QS", "SV+H", "ERA", "WHIP"];
  return categories.filter((category) => isCredibleLineCategory(line, category));
};

const decisionCategoryNames = (
  recommendation: AddRecommendation,
  line: WeeklyLine,
  targetCategories: ReadonlySet<string>,
) => {
  const affected = affectedCategoryNames(recommendation).filter((category) =>
    isCredibleLineCategory(line, category),
  );
  const targeted = affected.filter((category) => targetCategories.has(category));
  const profile = profileCategoryNames(line);
  return (targeted.length > 0 ? targeted : affected.length > 0 ? affected : profile).slice(0, 3);
};

const isSvhReliever = (line: WeeklyLine) =>
  line.kind === "pitcher" && line.svh >= 0.5 && line.svh >= line.qs;

const isStartingPitcherStream = (line: WeeklyLine) =>
  line.kind === "pitcher" &&
  !isSvhReliever(line) &&
  (line.eligiblePositions?.some((position) => position === "SP") === true ||
    (line.eligiblePositions == null && ((line.expectedStarts ?? 0) > 0 || line.qs >= 0.5)));

const hasRemainingExpectedStart = (line: WeeklyLine) =>
  line.kind === "pitcher" && (line.expectedStarts ?? 0) > 0;

const teamGamesRemaining = (set: WeeklyProjectionSet, team: string) =>
  set.schedules?.find((schedule) => schedule.team === team)?.gamesRemaining;

const hasUnlockedLineupVolume = (set: WeeklyProjectionSet, line: WeeklyLine) => {
  if (line.kind === "pitcher" && hasRemainingExpectedStart(line)) return true;
  const remaining = teamGamesRemaining(set, line.team);
  return remaining == null || remaining > 0;
};

const passesStreamingGuardrails = (line: WeeklyLine, targetCategories: ReadonlySet<string>) => {
  if (line.kind !== "pitcher") return true;
  if (line.ip <= 0) return false;
  const skillPass = line.k / line.ip >= STREAMING_SKILL_MIN_K_PER_IP || line.qs >= 1.5;
  const ratioCoinFlip = targetCategories.has("ERA") || targetCategories.has("WHIP");
  const eraLimit = ratioCoinFlip ? STREAMING_RATIO_COIN_FLIP_ERA_LIMIT : STREAMING_RATIO_ERA_LIMIT;
  const whipLimit = ratioCoinFlip
    ? STREAMING_RATIO_COIN_FLIP_WHIP_LIMIT
    : STREAMING_RATIO_WHIP_LIMIT;
  const ratioPass = line.era <= eraLimit && line.whip <= whipLimit;
  return skillPass && ratioPass;
};

const isBench = (player: LeagueStateSnapshot["roster"][number] | undefined) =>
  player != null && player.selectedPosition === "BN";

const hasScarceEligibility = (player: LeagueStateSnapshot["roster"][number] | undefined) =>
  player != null && player.eligiblePositions.some((position) => SCARCE_POSITIONS.has(position));

const categoryWeight = (weights: CategoryWeightMap, category: string) => weights[category] ?? 0.2;

const batterReplacementValue = (line: WeeklyBatterLine, weights: CategoryWeightMap) =>
  line.pa * 0.03 +
  line.r * 0.28 * categoryWeight(weights, "R") +
  line.h * 0.2 * categoryWeight(weights, "H") +
  line.hr * 1.4 * categoryWeight(weights, "HR") +
  line.rbi * 0.28 * categoryWeight(weights, "RBI") +
  line.sb * 0.8 * categoryWeight(weights, "SB") +
  line.tb * 0.13 * categoryWeight(weights, "TB") +
  (line.obp - LEAGUE_AVG_OBP) * line.obpDenominator * 1.1 * categoryWeight(weights, "OBP");

const pitcherReplacementValue = (line: WeeklyPitcherLine, weights: CategoryWeightMap) =>
  line.ip * 0.28 * categoryWeight(weights, "OUT") +
  line.k * 0.22 * categoryWeight(weights, "K") +
  line.qs * 1.1 * categoryWeight(weights, "QS") +
  line.svh * 1 * categoryWeight(weights, "SV+H") +
  (LEAGUE_AVG_ERA - line.era) * line.ip * 0.12 * categoryWeight(weights, "ERA") +
  (LEAGUE_AVG_WHIP - line.whip) * line.ip * 0.9 * categoryWeight(weights, "WHIP");

const replacementValue = (line: WeeklyLine, weights: CategoryWeightMap) =>
  line.kind === "batter"
    ? batterReplacementValue(line, weights)
    : pitcherReplacementValue(line, weights);

const positiveReplacementCategories = (candidate: WeeklyLine, drop: WeeklyLine) => {
  if (candidate.kind !== drop.kind) return [];
  if (candidate.kind === "batter" && drop.kind === "batter") {
    const categories = [
      ["R", candidate.r - drop.r],
      ["H", candidate.h - drop.h],
      ["HR", candidate.hr - drop.hr],
      ["RBI", candidate.rbi - drop.rbi],
      ["SB", candidate.sb - drop.sb],
      ["TB", candidate.tb - drop.tb],
      ["OBP", (candidate.obp - drop.obp) * Math.min(candidate.obpDenominator, drop.obpDenominator)],
    ] as const;
    return categories
      .filter(([, delta]) => delta > 0.01)
      .sort((a, b) => b[1] - a[1])
      .map(([category]) => category);
  }
  if (candidate.kind === "pitcher" && drop.kind === "pitcher") {
    const categories = [
      ["OUT", candidate.out - drop.out],
      ["K", candidate.k - drop.k],
      ["QS", candidate.qs - drop.qs],
      ["SV+H", candidate.svh - drop.svh],
      ["ERA", drop.era - candidate.era],
      ["WHIP", drop.whip - candidate.whip],
    ] as const;
    return categories
      .filter(([, delta]) => delta > 0.01)
      .sort((a, b) => b[1] - a[1])
      .map(([category]) => category);
  }
  return [];
};

const protectsScarcePosition = (
  player: LeagueStateSnapshot["roster"][number] | undefined,
  roster: LeagueStateSnapshot["roster"],
) => {
  if (player == null) return false;
  for (const position of player.eligiblePositions) {
    if (!SCARCE_POSITIONS.has(position)) continue;
    const alternatives = roster.filter(
      (entry) =>
        entry.playerKey !== player.playerKey &&
        !["IL", "IL+", "NA"].includes(entry.selectedPosition) &&
        entry.eligiblePositions.includes(position),
    );
    if (alternatives.length === 0) return true;
  }
  return false;
};

const weakestDrop = (
  set: WeeklyProjectionSet,
  candidate: WeeklyLine,
  snapshot: LeagueStateSnapshot,
  weights: CategoryWeightMap,
) => {
  const rosterByKey = new Map(snapshot.roster.map((player) => [player.playerKey, player]));
  return set.myRoster
    .filter((line) => line.kind === candidate.kind)
    .flatMap((line) => {
      const rosterPlayer = rosterByKey.get(line.playerKey);
      if (rosterPlayer == null) return [];
      if (["IL", "IL+", "NA"].includes(rosterPlayer.selectedPosition)) return [];
      if (protectsScarcePosition(rosterPlayer, snapshot.roster)) return [];
      const value = replacementValue(line, weights);
      const activePenalty = isBench(rosterPlayer) ? 0 : 1000;
      return [{ line, rosterPlayer, score: activePenalty + value }];
    })
    .sort((a, b) => a.score - b.score)[0];
};

const candidateLine = (set: WeeklyProjectionSet, playerKey: string) =>
  set.freeAgents.find((line) => line.playerKey === playerKey);

const pitcherStarts = (set: WeeklyProjectionSet, snapshot: LeagueStateSnapshot) => {
  const rosterByKey = new Map(snapshot.roster.map((player) => [player.playerKey, player]));
  const startsByPlayerKey = new Map<
    string,
    Array<NonNullable<WeeklyProjectionSet["probablePitcherStarts"]>[number]>
  >();
  for (const start of set.probablePitcherStarts ?? []) {
    const starts = startsByPlayerKey.get(start.playerKey) ?? [];
    starts.push(start);
    startsByPlayerKey.set(start.playerKey, starts);
  }
  return set.myRoster
    .flatMap((line) => {
      if (line.kind !== "pitcher") return [];
      const rosterPlayer = rosterByKey.get(line.playerKey);
      if (rosterPlayer == null) return [];
      const starts = startsByPlayerKey.get(line.playerKey) ?? [];
      return [
        new TransactionPitcherStart({
          playerKey: line.playerKey,
          playerName: line.name,
          selectedPosition: rosterPlayer.selectedPosition,
          expectedStarts: line.expectedStarts ?? 0,
          projectedIp: line.ip,
          projectedK: line.k,
          starts: starts.map((start) => ({
            date: start.date,
            opponentTeam: start.opponentTeam,
            gameTime: start.gameTime,
            homeAway: start.homeAway,
          })),
        }),
      ];
    })
    .sort(
      (a, b) =>
        b.expectedStarts - a.expectedStarts ||
        b.projectedIp - a.projectedIp ||
        a.playerName.localeCompare(b.playerName),
    );
};

const baseType = (availability: Availability, hasEmptySlot: boolean): TransactionType => {
  if (availability === "waiver") return "waiver-claim";
  return hasEmptySlot ? "free-agent-add" : "add-drop";
};

const clearsWaiverSpendThreshold = (
  recommendation: AddRecommendation,
  snapshot: LeagueStateSnapshot,
) => {
  if (snapshot.waiverPriority == null || snapshot.waiverPriority > TOP_WAIVER_PRIORITY_CUTOFF) {
    return true;
  }
  return (
    recommendation.seasonSgpDelta >= TOP_WAIVER_MIN_SEASON_SGP ||
    recommendation.weeklyDelta >= TOP_WAIVER_MIN_WEEKLY_DELTA
  );
};

const guardrailReason = (guardrail: Guardrail) => {
  switch (guardrail) {
    case "empty-slot-urgency":
      return "open active slot creates immediate lineup value";
    case "open-roster-capacity":
      return "open bench capacity avoids dropping long-term value";
    case "reserve-adds":
      return "weekly add budget is being protected";
    case "sixth-add-weekend":
      return "late-week move must directly affect the matchup";
    case "svh-program":
      return "reliever helps the SV+H category";
    case "streaming-skills":
      return "pitcher clears strikeout/role streaming skill checks";
    case "ratio-protection":
      return "ERA/WHIP risk is inside the matchup guardrail";
    case "ip-floor":
      return "projected innings are below the 20-IP floor";
    case "remaining-start":
      return "starter has a remaining expected start";
    case "two-start-planning":
      return "probable schedule shows multi-start volume";
    case "il-stash-stream":
      return "IL capacity can preserve injured long-term value";
  }
};

const buildRationale = (
  stepType: TransactionType,
  recommendation: AddRecommendation,
  affectedCategories: ReadonlyArray<string>,
  guards: ReadonlyArray<Guardrail>,
) => {
  const action =
    stepType === "waiver-claim" ? "Claim" : stepType === "add-drop" ? "Add/drop" : "Add";
  const decisionFocus =
    affectedCategories.slice(0, 3).join(", ") ||
    (guards.includes("empty-slot-urgency")
      ? "open active slot without dropping long-term value"
      : guards.includes("open-roster-capacity")
        ? "open roster spot without dropping long-term value"
        : "roster flexibility");
  const guardrailText =
    guards.length > 0
      ? guards.map(guardrailReason).join("; ")
      : "replacement edge cleared; no extra urgency flag is needed";
  return `${action} ${recommendation.playerName}: ${recommendation.weeklyDelta.toFixed(2)} weekly category EV, ${recommendation.seasonSgpDelta.toFixed(2)} season SGP; focus ${decisionFocus}. Guardrails: ${guardrailText}.`;
};

export const planTransactions = (
  report: DecisionReport,
  set: WeeklyProjectionSet,
  snapshot: LeagueStateSnapshot,
  options: TransactionPlanOptions = {},
) => {
  const asOf = options.asOf ?? new Date();
  const addsRemaining = Math.max(0, snapshot.weeklyAddLimit - snapshot.addsUsed);
  const reservedAdds = reserveAdds(addsRemaining, asOf);
  const activeRoster = activeWeeklyLines(set.myRoster, snapshot);
  const ip = currentMatchupIp(snapshot) + projectedIp(activeRoster);
  const targets = new Set(closestCategories(report));
  const needIpFirst = ip < WEEKLY_IP_FLOOR;

  const ranked = report.recommendations
    .flatMap((recommendation) => {
      const line = candidateLine(set, recommendation.playerKey);
      if (line == null) return [];
      const activeSlots = activeEmptySlots(snapshot, line);
      const hasActiveEmptySlot = slotCount(activeSlots) > 0;
      const hasBenchEmptySlot = slotCount(benchEmptySlots(snapshot)) > 0;
      const hasEmptySlot = hasActiveEmptySlot || hasBenchEmptySlot;
      const availability = options.availabilityByPlayerKey?.[line.playerKey] ?? "free-agent";
      const type = baseType(availability, hasEmptySlot);
      const weights = report.scout.categoryWeights;
      const drop = type === "add-drop" ? weakestDrop(set, line, snapshot, weights) : undefined;
      const hasUnlockedVolume = hasUnlockedLineupVolume(set, line);
      if (line.kind === "pitcher" && !passesStreamingGuardrails(line, targets) && !needIpFirst) {
        return [];
      }

      const guards: Array<Guardrail> = [];
      let score = recommendation.score;
      if (hasActiveEmptySlot) {
        guards.push("empty-slot-urgency");
        score +=
          line.kind === "batter"
            ? line.pa * EMPTY_SLOT_VOLUME_MULTIPLIER
            : line.out * EMPTY_SLOT_VOLUME_MULTIPLIER;
      } else if (hasBenchEmptySlot) {
        guards.push("open-roster-capacity");
        score += line.kind === "batter" ? line.pa * 0.08 : line.out * 0.08;
      }
      if (addsRemaining <= reservedAdds && !hasEmptySlot) guards.push("reserve-adds");
      if (addsRemaining === 1 && weekDayIndex(asOf) >= 5) {
        guards.push("sixth-add-weekend");
        score *= 1.25;
      }
      if (needIpFirst && line.kind === "pitcher") {
        guards.push("ip-floor");
        score += (WEEKLY_IP_FLOOR - ip) * 0.5 + line.ip;
      }
      if (isStartingPitcherStream(line) && hasRemainingExpectedStart(line)) {
        guards.push("remaining-start");
      }
      if (line.kind === "pitcher" && line.qs >= 1.5) guards.push("two-start-planning");
      if (isSvhReliever(line)) guards.push("svh-program");
      if (line.kind === "pitcher") guards.push("streaming-skills", "ratio-protection");
      if (
        snapshot.ilUsed < snapshot.ilSlots &&
        snapshot.roster.some((player) => player.status === "IL")
      ) {
        guards.push("il-stash-stream");
      }
      if (type === "add-drop" && drop != null) {
        score = replacementValue(line, weights) - replacementValue(drop.line, weights);
      }

      return [
        {
          recommendation,
          line,
          hasEmptySlot,
          hasUnlockedVolume,
          availability,
          guards,
          score,
          drop,
        },
      ];
    })
    .sort((a, b) => b.score - a.score);

  const actionableCount = Math.max(0, addsRemaining);
  const steps: Array<TransactionStep> = [];
  const rejectedTransactions: Array<RejectedTransaction> = [];
  const recordRejection = (
    entry: (typeof ranked)[number],
    reason: string,
    score = entry.score,
    dropName?: string,
  ) => {
    if (rejectedTransactions.length >= 3) return;
    rejectedTransactions.push(
      new RejectedTransaction({
        addPlayerName: entry.recommendation.playerName,
        dropPlayerName: dropName,
        score,
        affectedCategories: decisionCategoryNames(entry.recommendation, entry.line, targets),
        reason,
      }),
    );
  };

  if (addsRemaining <= 0) {
    const top = ranked[0];
    if (top != null) {
      recordRejection(
        top,
        "weekly add limit is exhausted; no transaction can be made until the next matchup period",
      );
    }
  }

  for (const [index, entry] of ranked.slice(0, actionableCount).entries()) {
    const type = baseType(entry.availability, entry.hasEmptySlot);
    const weights = report.scout.categoryWeights;
    const drop = entry.drop;
    let score = entry.score;
    let affectedCategories = decisionCategoryNames(entry.recommendation, entry.line, targets);
    const timing = timingFor(index, addsRemaining, reservedAdds, asOf, entry.hasEmptySlot);
    if (!entry.hasUnlockedVolume) {
      recordRejection(
        entry,
        "player's team has no remaining games, so the add has no unlocked lineup volume",
      );
      continue;
    }
    if (type === "waiver-claim" && !clearsWaiverSpendThreshold(entry.recommendation, snapshot)) {
      recordRejection(
        entry,
        `waiver priority ${snapshot.waiverPriority} is too valuable for a short-term streamer below the claim threshold`,
      );
      continue;
    }
    if (
      isStartingPitcherStream(entry.line) &&
      !hasRemainingExpectedStart(entry.line) &&
      !entry.guards.includes("ip-floor")
    ) {
      recordRejection(
        entry,
        "SP stream has no remaining expected start in the current matchup window",
      );
      continue;
    }
    if (
      type === "free-agent-add" &&
      (entry.guards.includes("open-roster-capacity") ||
        entry.guards.includes("empty-slot-urgency")) &&
      affectedCategories.length === 0
    ) {
      const reason = entry.guards.includes("empty-slot-urgency")
        ? "open active slot alone is not enough; add needs credible category value before using a move"
        : "open bench slot alone is not enough; add needs credible category value before using a move";
      recordRejection(entry, reason);
      continue;
    }
    if (type === "add-drop") {
      if (drop == null) {
        recordRejection(entry, "no safe drop was available");
        continue;
      }
      if (entry.guards.length === 0 && timing === "now") {
        recordRejection(
          entry,
          "add/drop had no urgency guardrail, so spending a move now is not justified",
          entry.score,
          drop.line.name,
        );
        continue;
      }
      const replacementEdge =
        replacementValue(entry.line, weights) - replacementValue(drop.line, weights);
      const minimumEdge = Math.max(
        isBench(drop.rosterPlayer)
          ? MIN_ADD_DROP_REPLACEMENT_EDGE
          : MIN_ACTIVE_DROP_REPLACEMENT_EDGE,
        hasScarceEligibility(drop.rosterPlayer) ? MIN_SCARCE_POSITION_DROP_EDGE : 0,
      );
      if (replacementEdge < minimumEdge) {
        recordRejection(
          entry,
          `replacement edge ${replacementEdge.toFixed(2)} is below the ${minimumEdge.toFixed(2)} drop threshold, so the manager is protecting roster value instead of forcing a drop`,
          replacementEdge,
          drop.line.name,
        );
        continue;
      }
      score = replacementEdge;
      affectedCategories = positiveReplacementCategories(entry.line, drop.line);
      if (affectedCategories.length === 0) {
        recordRejection(
          entry,
          "add player did not improve any category enough over the drop",
          score,
          drop.line.name,
        );
        continue;
      }
    }
    steps.push(
      new TransactionStep({
        type,
        timing,
        addPlayerKey: entry.recommendation.playerKey,
        addPlayerName: entry.recommendation.playerName,
        dropPlayerKey: drop?.line.playerKey,
        dropPlayerName: drop?.line.name,
        score,
        affectedCategories,
        guardrails: entry.guards,
        rationale: buildRationale(type, entry.recommendation, affectedCategories, entry.guards),
      }),
    );
  }

  return new TransactionPlan({
    addsRemaining,
    reservedAdds,
    projectedWeeklyIp: ip,
    sgpDenominatorSource: report.sgpDenominatorSource ?? "fallback",
    closestCategories: [...targets],
    categorySituations: categorySituations(snapshot),
    todayGameWindow: todayGameWindow(set, asOf),
    lineupRecommendations: report.lineupRecommendations.slice(0, 5).map(
      (recommendation) =>
        new TransactionLineupRecommendation({
          startPlayerKey: recommendation.startPlayerKey,
          startPlayerName: recommendation.startPlayerName,
          sitPlayerKey: recommendation.sitPlayerKey,
          sitPlayerName: recommendation.sitPlayerName,
          scoreDelta: recommendation.scoreDelta,
          affectedCategories: recommendation.affectedCategories.map((delta) => delta.category),
        }),
    ),
    optimalLineup: report.optimalLineup.map(
      (slot) =>
        new TransactionOptimalLineupSlot({
          slot: slot.slot,
          kind: slot.kind,
          playerKey: slot.playerKey,
          playerName: slot.playerName,
          score: slot.score,
          isCurrentStarter: slot.isCurrentStarter,
        }),
    ),
    optimalBench: report.optimalBench.map(
      (player) =>
        new TransactionOptimalLineupBench({
          kind: player.kind,
          playerKey: player.playerKey,
          playerName: player.playerName,
          score: player.score,
        }),
    ),
    pitcherStarts: pitcherStarts(set, snapshot),
    rejectedTransactions,
    steps,
  });
};

const mapError = (
  error: DecisionEngineError | WeeklyProjectionsError | YahooApiError | StandingsHistoryError,
) => new TransactionPlannerError({ message: `${error._tag}: ${error.message}` });

export class TransactionPlanner extends Context.Service<
  TransactionPlanner,
  {
    readonly currentPlan: Effect.Effect<TransactionPlan, TransactionPlannerError>;
    // Build a plan from an ALREADY-COMPUTED DecisionReport (the precompute reduce output) without
    // re-running rankAddCandidates/the sim. Fetches only the cheap set+snapshot inputs that
    // planTransactions needs, so reduce stays CPU-cheap.
    readonly planFromReport: (
      report: DecisionReport,
    ) => Effect.Effect<TransactionPlan, TransactionPlannerError>;
  }
>()("fantasy-gm/TransactionPlanner") {
  static readonly layerLive = Layer.effect(
    TransactionPlanner,
    Effect.gen(function* () {
      const weeklyProjections = yield* WeeklyProjections;
      const leagueState = yield* LeagueState;
      const standingsHistory = yield* StandingsHistory;
      const useStandingsHistory = yield* Config.boolean("USE_STANDINGS_HISTORY").pipe(
        Config.withDefault(true),
      );
      const planFromReport = (report: DecisionReport) =>
        Effect.gen(function* () {
          const [set, snapshot] = yield* Effect.all([
            weeklyProjections.currentMatchup,
            leagueState.snapshot,
          ]);
          return planTransactions(report, set, snapshot);
        }).pipe(Effect.mapError(mapError));
      return TransactionPlanner.of({
        currentPlan: Effect.gen(function* () {
          const [set, snapshot] = yield* Effect.all([
            weeklyProjections.currentMatchup,
            leagueState.snapshot,
          ]);
          const categoryTotals = useStandingsHistory ? yield* standingsHistory.categoryTotals : [];
          const report = rankAddCandidates(set, snapshot, categoryTotals);
          return planTransactions(report, set, snapshot);
        }).pipe(Effect.mapError(mapError)),
        planFromReport,
      });
    }),
  );
}
