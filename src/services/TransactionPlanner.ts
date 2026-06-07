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
const MIN_ADD_DROP_REPLACEMENT_EDGE = 1.25;
const MIN_ACTIVE_DROP_REPLACEMENT_EDGE = 3;
const MIN_SCARCE_POSITION_DROP_EDGE = 6;
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
  | "two-start-planning"
  | "il-stash-stream";

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
      Schema.Literal("two-start-planning"),
      Schema.Literal("il-stash-stream"),
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
  closestCategories: Schema.Array(Schema.String),
  categorySituations: Schema.Array(TransactionCategorySituation),
  todayGameWindow: Schema.optional(TransactionDailyGameWindow),
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
      ? ACTIVE_BATTER_SLOTS.has(slot.position)
      : ACTIVE_PITCHER_SLOTS.has(slot.position),
  );

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

const isSvhReliever = (line: WeeklyLine) =>
  line.kind === "pitcher" && line.svh >= 0.5 && line.svh >= line.qs;

const passesStreamingGuardrails = (line: WeeklyLine, targetCategories: ReadonlySet<string>) => {
  if (line.kind !== "pitcher") return true;
  if (line.ip <= 0) return false;
  const skillPass = line.k / line.ip >= STREAMING_SKILL_MIN_K_PER_IP || line.qs >= 1.5;
  const ratioCoinFlip = targetCategories.has("ERA") || targetCategories.has("WHIP");
  const ratioPass =
    ratioCoinFlip ||
    (line.era <= STREAMING_RATIO_ERA_LIMIT && line.whip <= STREAMING_RATIO_WHIP_LIMIT);
  return skillPass && ratioPass;
};

const isBench = (player: LeagueStateSnapshot["roster"][number] | undefined) =>
  player != null && ["BN", "NA"].includes(player.selectedPosition);

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
        !["IL", "IL+"].includes(entry.selectedPosition) &&
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
      if (["IL", "IL+"].includes(rosterPlayer.selectedPosition)) return [];
      if (protectsScarcePosition(rosterPlayer, snapshot.roster)) return [];
      const value = replacementValue(line, weights);
      const activePenalty = isBench(rosterPlayer) ? 0 : 1000;
      return [{ line, rosterPlayer, score: activePenalty + value }];
    })
    .sort((a, b) => a.score - b.score)[0];
};

const candidateLine = (set: WeeklyProjectionSet, playerKey: string) =>
  set.freeAgents.find((line) => line.playerKey === playerKey);

const baseType = (availability: Availability, hasEmptySlot: boolean): TransactionType => {
  if (availability === "waiver") return "waiver-claim";
  return hasEmptySlot ? "free-agent-add" : "add-drop";
};

const buildRationale = (
  stepType: TransactionType,
  recommendation: AddRecommendation,
  guards: ReadonlyArray<Guardrail>,
) => {
  const action =
    stepType === "waiver-claim" ? "Claim" : stepType === "add-drop" ? "Add/drop" : "Add";
  const categoryText = affectedCategoryNames(recommendation).slice(0, 3).join(", ") || "depth";
  const guardrailText =
    guards.length > 0 ? guards.join(", ") : "replacement edge cleared; no extra urgency flags";
  return `${action} ${recommendation.playerName}: ${recommendation.weeklyDelta.toFixed(2)} weekly category EV, ${recommendation.seasonSgpDelta.toFixed(2)} season SGP, targeting ${categoryText}. Guardrails: ${guardrailText}.`;
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
      const emptySlots = activeEmptySlots(snapshot, line);
      const hasEmptySlot = slotCount(emptySlots) > 0;
      const availability = options.availabilityByPlayerKey?.[line.playerKey] ?? "free-agent";
      if (line.kind === "pitcher" && !passesStreamingGuardrails(line, targets) && !needIpFirst) {
        return [];
      }

      const guards: Array<Guardrail> = [];
      let score = recommendation.score;
      if (hasEmptySlot) {
        guards.push("empty-slot-urgency");
        score +=
          line.kind === "batter"
            ? line.pa * EMPTY_SLOT_VOLUME_MULTIPLIER
            : line.out * EMPTY_SLOT_VOLUME_MULTIPLIER;
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
      if (line.kind === "pitcher" && line.qs >= 1.5) guards.push("two-start-planning");
      if (isSvhReliever(line)) guards.push("svh-program");
      if (line.kind === "pitcher") guards.push("streaming-skills", "ratio-protection");
      if (
        snapshot.ilUsed < snapshot.ilSlots &&
        snapshot.roster.some((player) => player.status === "IL")
      ) {
        guards.push("il-stash-stream");
      }

      return [{ recommendation, line, hasEmptySlot, availability, guards, score }];
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
        affectedCategories: affectedCategoryNames(entry.recommendation),
        reason,
      }),
    );
  };

  for (const [index, entry] of ranked.slice(0, actionableCount).entries()) {
    const type = baseType(entry.availability, entry.hasEmptySlot);
    const weights = report.scout.categoryWeights;
    const drop = type === "add-drop" ? weakestDrop(set, entry.line, snapshot, weights) : undefined;
    let score = entry.score;
    let affectedCategories = affectedCategoryNames(entry.recommendation);
    const timing = timingFor(index, addsRemaining, reservedAdds, asOf, entry.hasEmptySlot);
    if (type === "add-drop") {
      if (drop == null) {
        recordRejection(entry, "no safe drop candidate was available");
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
          `replacement edge ${replacementEdge.toFixed(2)} is below the ${minimumEdge.toFixed(2)} drop threshold`,
          replacementEdge,
          drop.line.name,
        );
        continue;
      }
      score = Math.min(score, replacementEdge);
      affectedCategories = positiveReplacementCategories(entry.line, drop.line);
      if (affectedCategories.length === 0) {
        recordRejection(
          entry,
          "candidate did not improve any category enough over the drop",
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
        rationale: buildRationale(type, entry.recommendation, entry.guards),
      }),
    );
  }

  return new TransactionPlan({
    addsRemaining,
    reservedAdds,
    projectedWeeklyIp: ip,
    closestCategories: [...targets],
    categorySituations: categorySituations(snapshot),
    todayGameWindow: todayGameWindow(set, asOf),
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
      });
    }),
  );
}
