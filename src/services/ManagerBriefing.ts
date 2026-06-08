import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  TransactionPlanner,
  TransactionPlannerError,
  type TransactionPlan,
  type TransactionStep,
} from "./TransactionPlanner.ts";
import { ApiCache, type ApiCacheError } from "./ApiCache.ts";
import {
  DailyLineupAdvisor,
  DailyLineupAdvisorError,
  type DailyLineupReport,
} from "./DailyLineupAdvisor.ts";
import { LAST_MANAGER_WRITE_STATUS_CACHE_KEY, ManagerWriteStatus } from "./ManagerWriteStatus.ts";
import type { YahooTransactionWrite } from "./YahooClient.ts";

export class ManualAction extends Schema.Class<ManualAction>("ManualAction")({
  priority: Schema.Finite,
  transactionType: Schema.optional(
    Schema.Union([
      Schema.Literal("free-agent-add"),
      Schema.Literal("waiver-claim"),
      Schema.Literal("add-drop"),
    ]),
  ),
  timing: Schema.optional(
    Schema.Union([
      Schema.Literal("now"),
      Schema.Literal("reserve-late-week"),
      Schema.Literal("sat-sun-priority"),
    ]),
  ),
  addPlayerKey: Schema.optional(Schema.String),
  addPlayerName: Schema.optional(Schema.String),
  dropPlayerKey: Schema.optional(Schema.String),
  dropPlayerName: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Finite),
  guardrails: Schema.optional(Schema.Array(Schema.String)),
  action: Schema.String,
  confidence: Schema.Union([
    Schema.Literal("act"),
    Schema.Literal("review"),
    Schema.Literal("hold"),
  ]),
  categories: Schema.Array(Schema.String),
  rationale: Schema.String,
  checks: Schema.Array(Schema.String),
  stopIf: Schema.Array(Schema.String),
  yahooSteps: Schema.Array(Schema.String),
}) {}

export class ManagerBriefingReport extends Schema.Class<ManagerBriefingReport>(
  "ManagerBriefingReport",
)({
  summary: Schema.String,
  generatedAt: Schema.String,
  addsRemaining: Schema.Finite,
  reservedAdds: Schema.Finite,
  projectedWeeklyIp: Schema.Finite,
  closestCategories: Schema.Array(Schema.String),
  todayGameWindow: Schema.optional(
    Schema.Struct({
      date: Schema.String,
      games: Schema.Finite,
      remainingGames: Schema.Finite,
      firstGameTime: Schema.optional(Schema.String),
      lastGameTime: Schema.optional(Schema.String),
    }),
  ),
  categorySituations: Schema.Array(
    Schema.Struct({
      category: Schema.String,
      myValue: Schema.String,
      opponentValue: Schema.String,
      status: Schema.Union([
        Schema.Literal("winning"),
        Schema.Literal("losing"),
        Schema.Literal("tied"),
      ]),
    }),
  ),
  managerTakeaways: Schema.Array(Schema.String),
  categoryPlan: Schema.Array(Schema.String),
  addTriggers: Schema.Array(Schema.String),
  lineupAlerts: Schema.Array(Schema.String),
  pitcherStarts: Schema.optional(Schema.Array(Schema.String)),
  writeAlerts: Schema.optional(Schema.Array(Schema.String)),
  rejectedTransactions: Schema.Array(
    Schema.Struct({
      addPlayerName: Schema.String,
      dropPlayerName: Schema.optional(Schema.String),
      score: Schema.Finite,
      affectedCategories: Schema.Array(Schema.String),
      reason: Schema.String,
    }),
  ),
  doNow: Schema.Array(ManualAction),
  holdForLater: Schema.Array(ManualAction),
  warnings: Schema.Array(Schema.String),
}) {}

export class ManagerBriefingError extends Data.TaggedError("ManagerBriefingError")<{
  readonly message: string;
}> {}

export const LAST_MANAGER_BRIEFING_CACHE_KEY = "manager-briefing:last:v1";

export class YahooApplyStep extends Schema.Class<YahooApplyStep>("YahooApplyStep")({
  kind: Schema.Union([
    Schema.Literal("lineup"),
    Schema.Literal("transaction"),
    Schema.Literal("save"),
    Schema.Literal("rerun"),
  ]),
  text: Schema.String,
}) {}

export class YahooApplyPlan extends Schema.Class<YahooApplyPlan>("YahooApplyPlan")({
  mode: Schema.Union([Schema.Literal("manual"), Schema.Literal("automated")]),
  generatedAt: Schema.String,
  summary: Schema.String,
  transaction: Schema.optional(
    Schema.Struct({
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
      guardrails: Schema.Array(Schema.String),
      confidence: Schema.Union([
        Schema.Literal("act"),
        Schema.Literal("review"),
        Schema.Literal("hold"),
      ]),
    }),
  ),
  yahooTransaction: Schema.optional(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("add"),
        playerKey: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("drop"),
        playerKey: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal("add/drop"),
        addPlayerKey: Schema.String,
        dropPlayerKey: Schema.String,
        faabBid: Schema.optional(Schema.Finite),
      }),
      Schema.Struct({
        type: Schema.Literal("waiver"),
        addPlayerKey: Schema.String,
        dropPlayerKey: Schema.optional(Schema.String),
        faabBid: Schema.optional(Schema.Finite),
      }),
    ]),
  ),
  steps: Schema.Array(YahooApplyStep),
}) {}

const pitcherCategories = new Set(["OUT", "K", "ERA", "WHIP", "QS", "SV+H"]);
const activeRosterSlots = new Set(["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"]);

const confidenceFor = (step: TransactionStep): ManualAction["confidence"] => {
  if (step.type === "waiver-claim") return "review";
  if (step.type === "add-drop") return "review";
  if (step.timing !== "now") return "hold";
  if (step.score <= 0) return "review";
  if (step.affectedCategories.some((category) => pitcherCategories.has(category))) return "review";
  return "act";
};

const actionText = (step: TransactionStep) => {
  if (step.type === "waiver-claim") {
    return `Claim ${step.addPlayerName}${step.dropPlayerName == null ? "" : `, dropping ${step.dropPlayerName}`}`;
  }
  if (step.type === "free-agent-add") {
    return step.guardrails.includes("open-roster-capacity")
      ? `Add ${step.addPlayerName} into the open roster spot`
      : `Add ${step.addPlayerName} into the open active slot`;
  }
  return `Add ${step.addPlayerName}, drop ${step.dropPlayerName}`;
};

const checksFor = (step: TransactionStep) => [
  "Yahoo availability was read before this briefing was generated.",
  "Roster lock state was evaluated before this briefing was generated.",
  ...(step.type === "waiver-claim"
    ? ["Waiver priority guardrail was applied by the manager."]
    : ["Free-agent add guardrail was applied by the manager."]),
  ...(step.dropPlayerName == null
    ? []
    : [
        `${step.dropPlayerName} passed the protected-position coverage check.`,
        `${step.dropPlayerName} passed the active-lineup schedule check.`,
      ]),
  ...(step.guardrails.includes("ip-floor")
    ? ["Projected weekly IP is below 20, so pitcher volume is prioritized."]
    : []),
  ...(step.guardrails.includes("ratio-protection")
    ? ["ERA/WHIP risk guardrail was applied to the pitcher decision."]
    : []),
];

const stopIfFor = (step: TransactionStep) => [
  "Regenerate the plan after making Yahoo changes.",
  ...(step.dropPlayerName == null
    ? []
    : [`Do not make another add/drop until ${step.dropPlayerName}'s slot is re-evaluated.`]),
  ...(step.affectedCategories.includes("OBP")
    ? ["OBP guardrail was applied because OBP is a coin-flip category."]
    : []),
  ...(step.type === "waiver-claim"
    ? ["Waiver priority is reserved for durable role or skill upgrades."]
    : []),
];

const yahooStepsFor = (step: TransactionStep) => [
  "Open Yahoo Fantasy Baseball.",
  `Search for ${step.addPlayerName}.`,
  ...(step.type === "waiver-claim"
    ? ["Place the waiver claim selected by the manager."]
    : ["Use Add for the free-agent move selected by the manager."]),
  ...(step.dropPlayerName == null ? [] : [`Select ${step.dropPlayerName} as the drop.`]),
  "Save the selected move, then regenerate the manager plan.",
];

const manualAction = (step: TransactionStep, priority: number) =>
  new ManualAction({
    priority,
    transactionType: step.type,
    timing: step.timing,
    addPlayerKey: step.addPlayerKey,
    addPlayerName: step.addPlayerName,
    dropPlayerKey: step.dropPlayerKey,
    dropPlayerName: step.dropPlayerName,
    score: step.score,
    guardrails: [...step.guardrails],
    action: actionText(step),
    confidence: confidenceFor(step),
    categories: step.affectedCategories,
    rationale: step.rationale,
    checks: checksFor(step),
    stopIf: stopIfFor(step),
    yahooSteps: yahooStepsFor(step),
  });

const categoryLine = (category: TransactionPlan["categorySituations"][number]) =>
  `${category.category} ${category.myValue}-${category.opponentValue}`;

const numericValue = (value: string) => {
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const categoryDeficit = (category: TransactionPlan["categorySituations"][number]) => {
  const mine = numericValue(category.myValue);
  const opponent = numericValue(category.opponentValue);
  if (mine == null || opponent == null) return Number.POSITIVE_INFINITY;
  if (category.category === "ERA" || category.category === "WHIP") return mine - opponent;
  return opponent - mine;
};

const isPlausibleFlip = (category: TransactionPlan["categorySituations"][number]) => {
  if (category.status === "tied") return true;
  if (category.status !== "losing") return false;
  const deficit = categoryDeficit(category);
  const thresholds: Readonly<Record<string, number>> = {
    R: 8,
    H: 6,
    HR: 2,
    RBI: 8,
    SB: 2,
    TB: 12,
    OBP: 0.015,
    OUT: 12,
    K: 8,
    ERA: 0.5,
    WHIP: 0.12,
    QS: 1,
    "SV+H": 1,
  };
  return deficit <= (thresholds[category.category] ?? 0);
};

const buildCategoryPlan = (plan: TransactionPlan) => {
  const protect = plan.categorySituations.filter((category) => category.status === "winning");
  const chase = plan.categorySituations.filter(isPlausibleFlip);
  const lowProbability = plan.categorySituations.filter(
    (category) => category.status === "losing" && !isPlausibleFlip(category),
  );
  return [
    protect.length > 0
      ? `Protect: ${protect.map(categoryLine).join(", ")}.`
      : "Protect: no category lead is secure yet.",
    chase.length > 0
      ? `Possible flips: ${chase.map(categoryLine).join(", ")}.`
      : "Possible flips: none currently clear the model's close-category filter.",
    lowProbability.length > 0
      ? `Low-probability chases: ${lowProbability.map(categoryLine).join(", ")}.`
      : "Low-probability chases: none.",
  ];
};

const buildAddTriggers = (plan: TransactionPlan, hasUrgentLineupFix: boolean) =>
  hasUrgentLineupFix
    ? [
        "Transactions are paused until the listed lineup/IL moves are saved and the manager plan is regenerated.",
      ]
    : plan.addsRemaining <= 0
      ? ["No add triggers are active because the weekly Yahoo add limit is exhausted."]
      : [
          "Add-only open slot: use it only for a player with unlocked remaining games.",
          "Hitter stream: only if HR/TB/RBI/H can move without dropping a protected player.",
          "SP stream: only if OUT/K/QS gain is worth the ERA/WHIP risk.",
          plan.projectedWeeklyIp < 20
            ? "Pitching volume: prioritize crossing the 20-IP floor."
            : "Pitching volume: floor is covered, so do not chase OUT/K with a risky arm.",
          "Late-week snipe: use adds when a category is within one small event, such as 1 SB, 1 HR, 3-5 TB, or 1 SV+H.",
        ];

const buildPitcherStarts = (plan: TransactionPlan) => {
  const activePitchers =
    plan.pitcherStarts?.filter((pitcher) => !["IL", "IL+"].includes(pitcher.selectedPosition)) ??
    [];
  const scheduledStarts = activePitchers.filter((pitcher) => pitcher.expectedStarts > 0);
  if (scheduledStarts.length === 0) {
    return activePitchers.length === 0
      ? []
      : ["No remaining probable starts in the current unlocked matchup window."];
  }
  const startDetails = (pitcher: (typeof scheduledStarts)[number]) =>
    pitcher.starts.length === 0
      ? ""
      : ` (${pitcher.starts
          .map(
            (start) =>
              `${start.date} ${start.homeAway === "home" ? "vs" : "@"} ${start.opponentTeam}`,
          )
          .join("; ")})`;
  return scheduledStarts
    .slice(0, 6)
    .map(
      (pitcher) =>
        `${pitcher.playerName} (${pitcher.selectedPosition}): ${pitcher.expectedStarts.toFixed(1)} expected start(s), ${pitcher.projectedIp.toFixed(1)} IP, ${pitcher.projectedK.toFixed(1)} K${startDetails(pitcher)}.`,
    );
};

const buildWriteAlerts = (writeStatus: ManagerWriteStatus | undefined) => {
  if (writeStatus == null) {
    return [
      "Write status not checked in this preview; the briefing is read-only and will not attempt Yahoo lineup writes.",
    ];
  }
  if (writeStatus.capability === "authorized" && writeStatus.ok) return [];
  if (writeStatus.capability === "unauthorized") {
    return [
      "Yahoo writes are not authorized yet; complete read/write Yahoo auth before auto-apply can work.",
    ];
  }
  return [`Yahoo write capability is ${writeStatus.capability}; lineup execution remains guarded.`];
};

const buildManagerTakeaways = (
  plan: TransactionPlan,
  lineup: DailyLineupReport | undefined,
  writeStatus: ManagerWriteStatus | undefined,
  doNow: ReadonlyArray<ManualAction>,
  holdForLater: ReadonlyArray<ManualAction>,
) => {
  const urgentUnavailable = lineup?.activeUnavailable.length ?? 0;
  const openRosterSlots = lineup?.emptySlots.find((slot) => slot.position === "BN")?.count ?? 0;
  const openActiveSlots =
    lineup?.emptySlots.filter((slot) => activeRosterSlots.has(slot.position)) ?? [];
  const openActiveSlotText = openActiveSlots
    .flatMap((slot) => Array.from({ length: slot.count }, () => slot.position))
    .join(", ");
  const gameWindow = plan.todayGameWindow;
  const lockedGames =
    gameWindow == null ? undefined : Math.max(0, gameWindow.games - gameWindow.remainingGames);
  const takeaways = [
    urgentUnavailable > 0
      ? `Lineup first: ${urgentUnavailable} active player(s) are unavailable, so transaction adds come after the roster is legal.`
      : "Lineup is the first check; no hard-unavailable active player is blocking transaction decisions.",
    gameWindow == null
      ? "Lock status: today's MLB slate is unavailable; the manager limited advice to conservative roster moves."
      : gameWindow.remainingGames === 0
        ? `Lock status: all ${gameWindow.games} MLB game(s) appear started; same-day lineup/add advice is treated as next-day only.`
        : lockedGames === 0
          ? `Lock status: all ${gameWindow.games} MLB game(s) appear unlocked in the manager data.`
          : `Lock status: ${lockedGames} of ${gameWindow.games} MLB game(s) appear started; the manager used that lock context.`,
    openRosterSlots > 0
      ? `Use roster capacity: ${openRosterSlots} open BN slot(s) make add-only moves preferable to drops.`
      : "No open BN capacity; any add/drop must clear the protected-player threshold.",
    openActiveSlotText.length > 0
      ? `Open active slot(s): ${openActiveSlotText}; prioritize legal unlocked fill-ins before speculative add/drop churn.`
      : "No open active roster slot is visible in the Yahoo lineup read.",
    lineup?.ilUsed != null && lineup.ilSlots != null && lineup.openIlSlots != null
      ? `IL capacity: ${lineup.ilUsed}/${lineup.ilSlots} used, ${lineup.openIlSlots} open (${lineup.ilBatterUsed ?? 0} batter, ${lineup.ilPitcherUsed ?? 0} pitcher).`
      : "IL capacity: unavailable in the current Yahoo roster read.",
    plan.projectedWeeklyIp < 20
      ? `Pitching floor: projected ${plan.projectedWeeklyIp.toFixed(1)} IP is below 20, so safe pitcher volume is urgent.`
      : `Pitching floor: projected ${plan.projectedWeeklyIp.toFixed(1)} IP clears 20, so protect ERA/WHIP from risky streams.`,
    plan.addsRemaining <= 0
      ? "Add budget: weekly add limit is exhausted, so no add/drop, claim, or streamer can be made until the next matchup period."
      : `Add budget: ${plan.addsRemaining} add(s) remain, with ${plan.reservedAdds} reserved for later category flips.`,
    plan.closestCategories.length > 0
      ? `Category focus: spend moves only where they can affect ${plan.closestCategories.slice(0, 4).join(", ")}.`
      : "Category focus: no clear coin-flip category is available right now.",
  ];
  if (writeStatus?.capability === "unauthorized") {
    takeaways.unshift(
      "Execution status: Yahoo write auth is missing, so the manager can decide and dry-run lineup moves but cannot auto-apply them yet.",
    );
  }
  if (doNow.length === 0 && holdForLater.length > 0) {
    takeaways.push(
      "Drop protection: make the single best add only after lineup, lock, and status checks still match.",
    );
  }
  return takeaways;
};

const buildLineupAlerts = (plan: TransactionPlan, report: DailyLineupReport | undefined) => {
  const pairedActivationKeys = new Set<string>();
  const pairedIlMoveKeys = new Set<string>();
  const pairedReplacementKeys = new Set<string>();
  const openPitcherSlots =
    report?.emptySlots.filter((slot) => ["SP", "P"].includes(slot.position)) ?? [];
  const openPitcherSlotNames = openPitcherSlots.flatMap((slot) =>
    Array.from({ length: slot.count }, () => slot.position),
  );
  const benchScheduledStarts =
    openPitcherSlotNames.length === 0
      ? []
      : (plan.pitcherStarts ?? [])
          .filter((pitcher) => pitcher.selectedPosition === "BN" && pitcher.expectedStarts > 0)
          .slice(0, openPitcherSlotNames.length)
          .map((pitcher, index) => {
            const slot = openPitcherSlotNames[index] ?? "SP/P";
            return `Bench scheduled start: ${pitcher.playerName} has ${pitcher.expectedStarts.toFixed(1)} expected start(s); fill ${slot} before lock.`;
          });
  const fullSlateUnlocked =
    plan.todayGameWindow != null &&
    plan.todayGameWindow.remainingGames === plan.todayGameWindow.games;
  const canApplyProjectionLineupMoves =
    (report?.activeUnavailable.length ?? 0) === 0 && fullSlateUnlocked;
  const pairedIlSwapAlerts =
    report?.ilActivationMoves.flatMap((activation) => {
      if (activation.to === "BN") return [];
      const ilMove = report.activeToIlMoves.find(
        (move) => !pairedIlMoveKeys.has(move.playerKey) && move.from === activation.to,
      );
      if (ilMove == null) return [];
      pairedActivationKeys.add(activation.playerKey);
      pairedIlMoveKeys.add(ilMove.playerKey);
      return [
        `Swap ${activation.playerName} into ${activation.to} and move ${ilMove.playerName} to IL (${ilMove.status}).`,
      ];
    }) ?? [];
  const pairedBenchSwapAlerts =
    report?.activeToIlMoves.flatMap((ilMove) => {
      if (pairedIlMoveKeys.has(ilMove.playerKey)) return [];
      const replacement = report.replacementOptions.find(
        (move) =>
          !pairedReplacementKeys.has(move.replacementPlayerKey) &&
          move.outPlayerKey === ilMove.playerKey &&
          move.slot === ilMove.from,
      );
      if (replacement == null) return [];
      pairedIlMoveKeys.add(ilMove.playerKey);
      pairedReplacementKeys.add(replacement.replacementPlayerKey);
      return [
        `Swap ${replacement.replacementPlayerName} into ${replacement.slot} and move ${ilMove.playerName} to IL (${ilMove.status}).`,
      ];
    }) ?? [];
  const residualOpenSlotAlerts =
    report?.fillableOpenSlots.flatMap((move) => {
      if (!pairedReplacementKeys.has(move.playerKey)) return [];
      return [
        `${move.slot} remains open after using ${move.playerName} in the IL swap; fill it only with an unlocked player who clears the add guardrails.`,
      ];
    }) ?? [];

  const alerts = [
    ...(report?.activeUnavailable.map(
      (player) =>
        `${player.name} is active at ${player.selectedPosition} with status ${player.status}.`,
    ) ?? []),
    ...pairedIlSwapAlerts,
    ...pairedBenchSwapAlerts,
    ...(report?.ilActivationMoves
      .filter((move) => !pairedActivationKeys.has(move.playerKey))
      .map((move) => `Move ${move.playerName} from IL to ${move.to} to free an IL slot.`) ?? []),
    ...(report?.activeToIlMoves
      .filter((move) => !pairedIlMoveKeys.has(move.playerKey))
      .map((move) => `Move ${move.playerName} from ${move.from} to IL (${move.status}).`) ?? []),
    ...(report?.replacementOptions.map((move) => {
      if (pairedReplacementKeys.has(move.replacementPlayerKey)) return undefined;
      return `Replace ${move.outPlayerName} at ${move.slot} with ${move.replacementPlayerName} from BN.`;
    }) ?? []),
    ...(report?.fillableOpenSlots.map((move) => {
      if (pairedReplacementKeys.has(move.playerKey)) return undefined;
      return `Move ${move.playerName} from BN to ${move.slot}.`;
    }) ?? []),
    ...residualOpenSlotAlerts,
    ...(canApplyProjectionLineupMoves
      ? plan.lineupRecommendations.map((recommendation) => {
          const categories =
            recommendation.affectedCategories.length > 0
              ? ` for ${recommendation.affectedCategories.slice(0, 3).join(", ")}`
              : "";
          return `Start ${recommendation.startPlayerName} over ${recommendation.sitPlayerName}${categories}.`;
        })
      : []),
    ...benchScheduledStarts,
  ].filter((alert): alert is string => alert != null);
  if ((report?.blockedIlMoves ?? 0) > 0) {
    alerts.push(
      `${report?.blockedIlMoves} additional active unavailable player(s) cannot move to IL until capacity opens.`,
    );
  }
  return alerts;
};

const lineupMoveCount = (lineup: DailyLineupReport | undefined) => {
  if (lineup == null) return 0;
  const pairedActivationKeys = new Set<string>();
  const pairedIlMoveKeys = new Set<string>();
  const pairedReplacementKeys = new Set<string>();
  let count = 0;

  for (const activation of lineup.ilActivationMoves) {
    if (activation.to === "BN") continue;
    const ilMove = lineup.activeToIlMoves.find(
      (move) => !pairedIlMoveKeys.has(move.playerKey) && move.from === activation.to,
    );
    if (ilMove == null) continue;
    pairedActivationKeys.add(activation.playerKey);
    pairedIlMoveKeys.add(ilMove.playerKey);
    count += 1;
  }

  for (const ilMove of lineup.activeToIlMoves) {
    if (pairedIlMoveKeys.has(ilMove.playerKey)) continue;
    const replacement = lineup.replacementOptions.find(
      (move) =>
        !pairedReplacementKeys.has(move.replacementPlayerKey) &&
        move.outPlayerKey === ilMove.playerKey &&
        move.slot === ilMove.from,
    );
    if (replacement == null) continue;
    pairedIlMoveKeys.add(ilMove.playerKey);
    pairedReplacementKeys.add(replacement.replacementPlayerKey);
    count += 1;
  }

  count += lineup.ilActivationMoves.filter(
    (move) => !pairedActivationKeys.has(move.playerKey),
  ).length;
  count += lineup.activeToIlMoves.filter((move) => !pairedIlMoveKeys.has(move.playerKey)).length;
  count += lineup.replacementOptions.filter(
    (move) => !pairedReplacementKeys.has(move.replacementPlayerKey),
  ).length;
  count += lineup.fillableOpenSlots.filter(
    (move) => !pairedReplacementKeys.has(move.playerKey),
  ).length;
  return count;
};

const buildSummary = (
  plan: TransactionPlan,
  doNow: ReadonlyArray<ManualAction>,
  lineup: DailyLineupReport | undefined,
  lineupAlerts: ReadonlyArray<string>,
) => {
  const categoryText =
    plan.closestCategories.length > 0
      ? `Closest categories are ${plan.closestCategories.join(", ")}.`
      : "No close category target is reliable right now.";
  const openActiveSlots =
    lineup?.emptySlots.filter((slot) => activeRosterSlots.has(slot.position)) ?? [];
  const openActiveSlotText = openActiveSlots
    .flatMap((slot) => Array.from({ length: slot.count }, () => slot.position))
    .join(", ");
  if ((lineup?.activeUnavailable.length ?? 0) > 0) {
    const unavailable = lineup?.activeUnavailable.length ?? 0;
    const moveCount = lineupMoveCount(lineup);
    const moveText =
      moveCount > 0
        ? `${moveCount} internal lineup move(s) are available without dropping anyone`
        : "no complete internal lineup fix is available yet";
    return `${unavailable} active player(s) are unavailable; ${moveText}. ${categoryText}`;
  }
  if (openActiveSlotText.length > 0) {
    return `Open active slot(s): ${openActiveSlotText}; fill legal unlocked lineup volume before add/drop speculation. ${categoryText}`;
  }
  if (lineupAlerts.length > 0) {
    return `Lineup improvement found; ${lineupAlerts.length} lineup alert(s) need action. ${categoryText}`;
  }
  if (plan.addsRemaining <= 0) {
    return `No transaction available: weekly add limit is exhausted. ${categoryText}`;
  }
  if (plan.steps.length === 0) {
    return "No transaction clears the current safety bar; available adds did not beat the replacement/drop threshold.";
  }
  if (doNow.length > 0) {
    return `Act-now move found for ${doNow[0]?.categories.join(", ") || "depth"}; ${categoryText}`;
  }
  return `No act-now move clears the bar from the current Yahoo setup. ${categoryText}`;
};

export const buildManagerBriefing = (
  plan: TransactionPlan,
  lineup?: DailyLineupReport,
  writeStatus?: ManagerWriteStatus,
) => {
  const actions = plan.steps.map((step, index) => manualAction(step, index + 1));
  const hasUrgentLineupFix = (lineup?.activeUnavailable.length ?? 0) > 0;
  const openRosterCapacity =
    lineup?.emptySlots.find((slot) => slot.position === "BN")?.count ?? Number.POSITIVE_INFINITY;
  const openRosterActionKeys = new Set<string>();
  const transactionActions = hasUrgentLineupFix
    ? actions.map(
        (action) =>
          new ManualAction({
            priority: action.priority,
            action: action.action,
            confidence: action.confidence === "act" ? "review" : action.confidence,
            categories: action.categories,
            rationale: action.rationale,
            checks: action.checks,
            stopIf: action.stopIf,
            yahooSteps: action.yahooSteps,
          }),
      )
    : actions;
  const capacityScopedActions = transactionActions.filter((action) => {
    if (!action.action.includes("open roster spot")) return true;
    if (openRosterActionKeys.size >= openRosterCapacity) return false;
    openRosterActionKeys.add(action.action);
    return true;
  });
  const doNow = hasUrgentLineupFix
    ? []
    : capacityScopedActions.filter((action) => action.confidence === "act").slice(0, 1);
  const doNowKeys = new Set(doNow.map((action) => action.priority));
  const holdCandidates = [
    ...capacityScopedActions
      .filter((action) => action.confidence === "act" && !doNowKeys.has(action.priority))
      .map(
        (action) =>
          new ManualAction({
            priority: action.priority,
            action: action.action,
            confidence: "review",
            categories: action.categories,
            rationale: action.rationale,
            checks: action.checks,
            stopIf: action.stopIf,
            yahooSteps: action.yahooSteps,
          }),
      ),
    ...capacityScopedActions.filter((action) => action.confidence === "review").slice(0, 3),
    ...capacityScopedActions.filter((action) => action.confidence === "hold"),
  ];
  const holdForLater = doNow.length > 0 ? [] : holdCandidates.slice(0, 1);
  const hasAddDrop = plan.steps.some((step) => step.type === "add-drop");
  const warnings = [
    "Manager decision generated from Yahoo roster, status, lock data, matchup context, and category guardrails.",
    ...(plan.steps.length > 0
      ? ["Make only the listed next add, then regenerate the plan before spending another move."]
      : []),
    ...(hasAddDrop
      ? ["After any add/drop, regenerate the manager plan before making another move."]
      : []),
    ...(plan.sgpDenominatorSource === "fallback"
      ? [
          "Season-value confidence is degraded: SGP denominators are using fallback league estimates until Yahoo standings-history slopes are available.",
        ]
      : []),
    ...(plan.projectedWeeklyIp < 20
      ? ["The 20-IP floor is not yet met; pitcher volume takes priority until it is secure."]
      : ["The 20-IP floor appears covered; do not add risky pitchers just for volume."]),
    ...(plan.reservedAdds > 0
      ? [
          `Reserve ${plan.reservedAdds} add(s) for late-week coin-flip categories unless an active slot is empty.`,
        ]
      : []),
  ];
  const lineupAlerts = buildLineupAlerts(plan, lineup);
  const managerTakeaways = buildManagerTakeaways(plan, lineup, writeStatus, doNow, holdForLater);

  return new ManagerBriefingReport({
    summary: buildSummary(plan, doNow, lineup, lineupAlerts),
    generatedAt: new Date().toISOString(),
    addsRemaining: plan.addsRemaining,
    reservedAdds: plan.reservedAdds,
    projectedWeeklyIp: plan.projectedWeeklyIp,
    closestCategories: plan.closestCategories,
    todayGameWindow: plan.todayGameWindow,
    categorySituations: plan.categorySituations,
    managerTakeaways,
    categoryPlan: buildCategoryPlan(plan),
    addTriggers: buildAddTriggers(plan, hasUrgentLineupFix),
    lineupAlerts,
    pitcherStarts: buildPitcherStarts(plan),
    writeAlerts: buildWriteAlerts(writeStatus),
    rejectedTransactions: hasUrgentLineupFix ? [] : plan.rejectedTransactions,
    doNow,
    holdForLater,
    warnings,
  });
};

const isLineupMove = (line: string) =>
  line.startsWith("Swap ") || line.startsWith("Move ") || line.startsWith("Replace ");

export const buildYahooApplyPlan = (briefing: ManagerBriefingReport) => {
  const lineupMoves = briefing.lineupAlerts.filter(isLineupMove);
  const actions = briefing.doNow.length > 0 ? briefing.doNow : briefing.holdForLater.slice(0, 1);
  const steps: Array<YahooApplyStep> = [];
  let transaction: YahooApplyPlan["transaction"];

  for (const move of lineupMoves) {
    steps.push(new YahooApplyStep({ kind: "lineup", text: move }));
  }

  if (lineupMoves.length > 0) {
    steps.push(new YahooApplyStep({ kind: "save", text: "Save roster changes." }));
    steps.push(
      new YahooApplyStep({
        kind: "rerun",
        text: "Regenerate the manager plan before applying any transaction.",
      }),
    );
  } else {
    for (const action of actions) {
      if (transaction == null && action.transactionType != null && action.addPlayerKey != null) {
        transaction = {
          type: action.transactionType,
          timing: action.timing ?? "now",
          addPlayerKey: action.addPlayerKey,
          addPlayerName: action.addPlayerName ?? action.action,
          dropPlayerKey: action.dropPlayerKey,
          dropPlayerName: action.dropPlayerName,
          score: action.score ?? 0,
          affectedCategories: [...action.categories],
          guardrails: [...(action.guardrails ?? [])],
          confidence: action.confidence,
        };
      }
      for (const step of action.yahooSteps.slice(1)) {
        steps.push(new YahooApplyStep({ kind: "transaction", text: step }));
      }
    }
  }

  return new YahooApplyPlan({
    mode: "manual",
    generatedAt: briefing.generatedAt,
    summary: briefing.summary,
    transaction,
    yahooTransaction: buildYahooTransactionWrite(transaction),
    steps,
  });
};

export const buildYahooTransactionWrite = (
  transaction: YahooApplyPlan["transaction"],
): YahooTransactionWrite | undefined => {
  if (transaction == null) return undefined;
  if (transaction.type === "free-agent-add") {
    return { type: "add", playerKey: transaction.addPlayerKey };
  }
  if (transaction.type === "waiver-claim") {
    return {
      type: "waiver",
      addPlayerKey: transaction.addPlayerKey,
      dropPlayerKey: transaction.dropPlayerKey,
    };
  }
  if (transaction.dropPlayerKey == null) return undefined;
  return {
    type: "add/drop",
    addPlayerKey: transaction.addPlayerKey,
    dropPlayerKey: transaction.dropPlayerKey,
  };
};

const mapError = (error: TransactionPlannerError | DailyLineupAdvisorError | ApiCacheError) =>
  new ManagerBriefingError({ message: `${error._tag}: ${error.message}` });

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

export class ManagerBriefing extends Context.Service<
  ManagerBriefing,
  {
    readonly currentBriefing: Effect.Effect<ManagerBriefingReport, ManagerBriefingError>;
  }
>()("fantasy-gm/ManagerBriefing") {
  static readonly layerLive = Layer.effect(
    ManagerBriefing,
    Effect.gen(function* () {
      const planner = yield* TransactionPlanner;
      const lineupAdvisor = yield* DailyLineupAdvisor;
      const cache = yield* ApiCache;
      return ManagerBriefing.of({
        currentBriefing: Effect.gen(function* () {
          const plan = yield* planner.currentPlan;
          const lineup = yield* lineupAdvisor.forDate(easternDateKey(new Date()));
          const writeStatus = yield* cache.get(
            LAST_MANAGER_WRITE_STATUS_CACHE_KEY,
            ManagerWriteStatus,
            30 * 24 * 60 * 60 * 1000,
          );
          return buildManagerBriefing(plan, lineup, writeStatus);
        }).pipe(Effect.mapError(mapError)),
      });
    }),
  );
}
