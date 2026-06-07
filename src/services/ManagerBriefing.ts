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

export class ManualAction extends Schema.Class<ManualAction>("ManualAction")({
  priority: Schema.Finite,
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
  categoryPlan: Schema.Array(Schema.String),
  addTriggers: Schema.Array(Schema.String),
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

const pitcherCategories = new Set(["OUT", "K", "ERA", "WHIP", "QS", "SV+H"]);

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
    return `Review waiver claim for ${step.addPlayerName}${step.dropPlayerName == null ? "" : `, dropping ${step.dropPlayerName}`}`;
  }
  if (step.type === "free-agent-add") return `Add ${step.addPlayerName} into the open active slot`;
  return `Review add/drop: add ${step.addPlayerName}, drop ${step.dropPlayerName}`;
};

const checksFor = (step: TransactionStep) => [
  "Confirm Yahoo still shows the add player available before acting.",
  "Confirm the player's game has not already locked for today's lineup.",
  ...(step.type === "waiver-claim"
    ? ["Confirm this is worth waiver priority; do not claim a short-term streamer."]
    : ["Confirm this is a free-agent add, not a waiver claim, before spending a move."]),
  ...(step.dropPlayerName == null
    ? []
    : [
        `Confirm ${step.dropPlayerName} is not your only usable C, 2B, 3B, or SS coverage.`,
        `Confirm ${step.dropPlayerName} is not in today's active lineup with a better schedule spot than the add.`,
      ]),
  ...(step.guardrails.includes("ip-floor")
    ? ["Confirm projected weekly IP is still below 20 before prioritizing pitcher volume."]
    : []),
  ...(step.guardrails.includes("ratio-protection")
    ? ["Confirm ERA/WHIP are not close enough that a risky pitcher could lose those categories."]
    : []),
];

const stopIfFor = (step: TransactionStep) => [
  "Stop if Yahoo availability, player status, or probable lineup differs from this plan.",
  ...(step.dropPlayerName == null
    ? []
    : [`Stop if dropping ${step.dropPlayerName} creates an unfillable active roster slot today.`]),
  ...(step.affectedCategories.includes("OBP")
    ? ["Stop if this move materially worsens OBP while OBP is a coin-flip category."]
    : []),
  ...(step.type === "waiver-claim"
    ? [
        "Stop if the player is not a durable role/skill upgrade; waiver priority is not for ordinary streamers.",
      ]
    : []),
];

const yahooStepsFor = (step: TransactionStep) => [
  "Open Yahoo Fantasy Baseball and re-check the current matchup categories first.",
  `Search for ${step.addPlayerName}.`,
  ...(step.type === "waiver-claim"
    ? ["If Yahoo labels the player on waivers, use Claim only after the checks pass."]
    : [
        "If Yahoo labels the player as FA, use Add. If it says Waiver, do not treat this as an automatic add.",
      ]),
  ...(step.dropPlayerName == null ? [] : [`Select ${step.dropPlayerName} as the drop.`]),
  "Review the confirmation screen for add count, waiver status, and lineup lock before confirming.",
];

const manualAction = (step: TransactionStep, priority: number) =>
  new ManualAction({
    priority,
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

const buildAddTriggers = (plan: TransactionPlan) => [
  "Add-only open slot: use it only for a player with unlocked remaining games.",
  "Hitter stream: only if HR/TB/RBI/H can move without dropping a protected player.",
  "SP stream: only if OUT/K/QS gain is worth the ERA/WHIP risk.",
  plan.projectedWeeklyIp < 20
    ? "Pitching volume: prioritize crossing the 20-IP floor."
    : "Pitching volume: floor is covered, so do not chase OUT/K with a risky arm.",
  "Late-week snipe: use adds when a category is within one small event, such as 1 SB, 1 HR, 3-5 TB, or 1 SV+H.",
];

export const buildManagerBriefing = (plan: TransactionPlan) => {
  const actions = plan.steps.map((step, index) => manualAction(step, index + 1));
  const doNow = actions.filter((action) => action.confidence === "act").slice(0, 1);
  const holdForLater = [
    ...actions.filter((action) => action.confidence === "review").slice(0, 3),
    ...actions.filter((action) => action.confidence === "hold"),
  ].slice(0, 5);
  const hasAddDrop = plan.steps.some((step) => step.type === "add-drop");
  const warnings = [
    "This is a manual-action briefing, not an auto-execution instruction.",
    ...(plan.steps.length > 0
      ? [
          "Treat listed add/drop actions as alternatives; do not execute more than one without regenerating the plan.",
        ]
      : []),
    ...(hasAddDrop
      ? [
          "Do not execute any add/drop until Yahoo availability, roster lock, and player status are re-checked.",
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

  return new ManagerBriefingReport({
    summary:
      plan.steps.length === 0
        ? "No transaction clears the current safety bar; available adds did not beat the replacement/drop threshold."
        : doNow.length > 0
          ? `Act-now move found for ${doNow[0]?.categories.join(", ") || "depth"}; closest categories are ${plan.closestCategories.join(", ")}.`
          : `No act-now move clears the bar; review only if Yahoo confirms a materially better setup. Closest categories are ${plan.closestCategories.join(", ")}.`,
    generatedAt: new Date().toISOString(),
    addsRemaining: plan.addsRemaining,
    reservedAdds: plan.reservedAdds,
    projectedWeeklyIp: plan.projectedWeeklyIp,
    closestCategories: plan.closestCategories,
    todayGameWindow: plan.todayGameWindow,
    categorySituations: plan.categorySituations,
    categoryPlan: buildCategoryPlan(plan),
    addTriggers: buildAddTriggers(plan),
    rejectedTransactions: plan.rejectedTransactions,
    doNow,
    holdForLater,
    warnings,
  });
};

const mapError = (error: TransactionPlannerError) =>
  new ManagerBriefingError({ message: `${error._tag}: ${error.message}` });

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
      return ManagerBriefing.of({
        currentBriefing: planner.currentPlan.pipe(
          Effect.map(buildManagerBriefing),
          Effect.mapError(mapError),
        ),
      });
    }),
  );
}
