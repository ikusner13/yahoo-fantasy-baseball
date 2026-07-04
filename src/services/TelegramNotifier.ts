import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

import type { ManagerBriefingReport } from "./ManagerBriefing.ts";
import { splitDiscordMessage } from "./DiscordNotifier.ts";

const TELEGRAM_API_URL = "https://api.telegram.org";
const TELEGRAM_MESSAGE_LIMIT = 3900;

export class TelegramNotifierError extends Data.TaggedError("TelegramNotifierError")<{
  readonly message: string;
  readonly status?: number;
}> {}

const mapHttpError = (cause: unknown) =>
  new TelegramNotifierError({
    message: String(cause),
    status: HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined,
  });

const compactDateTime = (isoTime: string) => {
  const date = new Date(isoTime);
  if (!Number.isFinite(date.getTime())) return isoTime;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
};

const compactGameWindow = (briefing: ManagerBriefingReport) => {
  const window = briefing.todayGameWindow;
  if (window == null) return "Games: schedule unavailable";
  const first = window.firstGameTime == null ? "unknown" : compactDateTime(window.firstGameTime);
  return `Games: ${window.remainingGames}/${window.games} unlocked, first ${first}`;
};

const actionLabel = (
  confidence: ManagerBriefingReport["doNow"][number]["confidence"],
  options: { readonly afterLineupFix?: boolean } = {},
) => {
  if (confidence === "act") return "DO NOW";
  if (confidence === "hold") return "WAIT";
  if (options.afterLineupFix) return "AFTER LINEUP FIX";
  return "BLOCKED";
};

const compactAction = (
  action: ManagerBriefingReport["doNow"][number],
  index: number,
  options: { readonly afterLineupFix?: boolean } = {},
) => {
  const focus =
    action.categories.length > 0
      ? action.categories.join(", ")
      : action.action.includes("open active slot")
        ? "open active slot, no drop"
        : action.action.includes("open roster spot")
          ? "open roster spot, no drop"
          : "roster flexibility";
  const lines = [
    `${index}. [${actionLabel(action.confidence, options)}] ${action.action}`,
    `   Focus: ${focus}`,
    `   Why: ${action.rationale}`,
  ];
  const yahooSteps = action.yahooSteps.slice(1, 4);
  if (yahooSteps.length > 0) {
    lines.push("   Yahoo:");
    for (const step of yahooSteps) lines.push(`   - ${step}`);
  }
  return lines;
};

const isLineupProblem = (line: string) => line.includes(" is active at ");

const isLineupMove = (line: string) =>
  line.startsWith("Swap ") || line.startsWith("Move ") || line.startsWith("Replace ");

const compactCategoryLine = (situation: ManagerBriefingReport["categorySituations"][number]) => {
  const label =
    situation.status === "winning" ? "Lead" : situation.status === "losing" ? "Trail" : "Tie";
  return `${label} ${situation.category}: ${situation.myValue}-${situation.opponentValue}`;
};

const yahooLineupSteps = (lineupMoves: ReadonlyArray<string>) => [
  "1. Open Yahoo My Team for the briefing date.",
  "2. Apply the moves listed from the current Yahoo roster state.",
  ...lineupMoves.slice(0, 5).map((move, index) => `${index + 3}. ${move}`),
  `${Math.min(lineupMoves.length, 5) + 3}. Save roster changes, then re-run the lineup check.`,
];

const managerDecisionLine = (
  briefing: ManagerBriefingReport,
  lineupMoves: ReadonlyArray<string>,
  actions: ReadonlyArray<ManagerBriefingReport["doNow"][number]>,
) => {
  if (briefing.bestAction != null) return briefing.bestAction;
  if (lineupMoves.length > 0) {
    return `Fix lineup only: ${lineupMoves.length} internal move(s), then regenerate before any add/drop.`;
  }
  const actNow = actions.find((action) => action.confidence === "act");
  if (actNow != null) return actNow.action;
  const nextAction = actions[0];
  if (nextAction?.confidence === "hold") {
    return `Wait on ${nextAction.action}; timing guardrail is not clear yet.`;
  }
  if (nextAction != null) {
    return `Decision blocked: ${nextAction.action}; execute only after the listed gate clears.`;
  }
  if (briefing.addsRemaining <= 0) {
    return "No transaction available: weekly Yahoo add limit is exhausted.";
  }
  if (briefing.closestCategories.length > 0) {
    return `No add/drop clears the manager bar; protect ${briefing.closestCategories.slice(0, 3).join(", ")}.`;
  }
  return "No add/drop clears the manager bar right now.";
};

const bestAvailableLine = (briefing: ManagerBriefingReport) => {
  const best = briefing.bestAvailableAdd;
  if (best == null || best.clearsBar) return [];
  const drop = best.dropPlayerName == null ? "" : `/${best.dropPlayerName}`;
  return [`Best available: ${best.playerName}${drop} (${best.score.toFixed(2)}) — ${best.reason}.`];
};

const confidenceLabel = (briefing: ManagerBriefingReport) => {
  const confidence = briefing.decisionConfidence;
  if (confidence == null) return undefined;
  if (confidence === "high") return "HIGH";
  if (confidence === "medium") return "MEDIUM";
  if (confidence === "low") return "LOW";
  return "HOLD";
};

const normalizeWarning = (warning: string) =>
  warning.includes("manual manager decision")
    ? "Manager decision generated from Yahoo roster, status, lock data, matchup context, and category guardrails."
    : warning;

const LINEUP_SLOT_ORDER = ["C", "1B", "2B", "3B", "SS", "OF", "Util", "SP", "RP", "P"];

const lineupSlotRank = (slot: string) => {
  const index = LINEUP_SLOT_ORDER.indexOf(slot);
  return index < 0 ? LINEUP_SLOT_ORDER.length : index;
};

const buildOptimalLineupBlock = (briefing: ManagerBriefingReport) => {
  if (briefing.optimalLineup.length === 0) return [];
  const slots = [...briefing.optimalLineup].sort(
    (a, b) => lineupSlotRank(a.slot) - lineupSlotRank(b.slot),
  );
  const lines = [
    "",
    "🟢 Lineup",
    ...slots.map((slot) => `${slot.slot}  ${slot.playerName}${slot.isCurrentStarter ? "" : " ⬆️"}`),
  ];
  if (briefing.optimalBench.length > 0) {
    lines.push(
      `Bench: ${briefing.optimalBench
        .slice(0, 6)
        .map((player) => player.playerName)
        .join(", ")}`,
    );
  }
  return lines;
};

const compactHeader = (briefing: ManagerBriefingReport) => {
  const window = briefing.todayGameWindow;
  const games =
    window == null
      ? "schedule unavailable"
      : `${window.remainingGames}/${window.games} games${
          window.firstGameTime == null ? "" : ` (first ${compactDateTime(window.firstGameTime)})`
        }`;
  return [
    `🕒 ${compactDateTime(briefing.generatedAt)} · ${games}`,
    `➕ ${briefing.addsRemaining} adds left · ⚾ ${briefing.projectedWeeklyIp.toFixed(1)} IP`,
  ];
};

const nextPitcherStartLine = (briefing: ManagerBriefingReport) => {
  const start = briefing.pitcherStarts?.[0];
  return start == null ? [] : [`🗓️ Next: ${start}`];
};

export const renderManagerBriefingForTelegram = (briefing: ManagerBriefingReport) => {
  const actions = briefing.doNow.length > 0 ? briefing.doNow : briefing.holdForLater.slice(0, 1);
  const lineupProblems = briefing.lineupAlerts.filter(isLineupProblem);
  const lineupMoves = briefing.lineupAlerts.filter(isLineupMove);
  const otherLineupAlerts = briefing.lineupAlerts.filter(
    (line) => !isLineupProblem(line) && !isLineupMove(line),
  );
  const hasUrgentLineup = lineupProblems.length > 0 || lineupMoves.length > 0;
  const hasActNow = actions.some((action) => action.confidence === "act");
  const hasBlockedDecision = actions.some((action) => action.confidence === "review");
  const addClearsBar = briefing.bestAvailableAdd?.clearsBar === true;
  const hasLineupPromotion = briefing.optimalLineup.some((slot) => !slot.isCurrentStarter);
  const isHold = !hasActNow && !hasUrgentLineup && !addClearsBar && !hasLineupPromotion;

  if (isHold) {
    const lines = [
      "⚾ Fantasy GM — HOLD",
      briefing.bestAction ?? briefing.summary,
      `Closest: ${briefing.closestCategories.join(", ") || "none"}`,
      ...bestAvailableLine(briefing),
      "",
      ...compactHeader(briefing),
    ];
    const alerts = [...lineupProblems, ...otherLineupAlerts];
    const writeAlerts = (briefing.writeAlerts ?? []).map((line) => `🔐 ${line}`);
    if (alerts.length > 0 || writeAlerts.length > 0) {
      lines.push("", ...alerts.slice(0, 5).map((line) => `🚨 ${line}`), ...writeAlerts.slice(0, 2));
    }
    lines.push(...nextPitcherStartLine(briefing));
    return lines.join("\n");
  }

  const actionHeader = hasActNow
    ? "✅ Do Now"
    : hasUrgentLineup
      ? "🎯 Next Add After Lineup Fix"
      : hasBlockedDecision
        ? "🧱 Blocked Decision"
        : "⏸️ Not Doing Now";
  const actionSection =
    actions.length === 0
      ? []
      : [
          "",
          actionHeader,
          ...actions.flatMap((action, index) =>
            compactAction(action, index + 1, { afterLineupFix: hasUrgentLineup }),
          ),
        ];
  const hasOptimalLineup = briefing.optimalLineup.length > 0;
  const lines = [
    "⚾ Fantasy GM",
    briefing.summary,
    "",
    `🕒 Generated: ${compactDateTime(briefing.generatedAt)}`,
    `🗓️ ${compactGameWindow(briefing)}`,
    `➕ Adds: ${briefing.addsRemaining} left (${briefing.reservedAdds} reserved)`,
    `⚾ IP: ${briefing.projectedWeeklyIp.toFixed(1)}`,
    `🎯 Closest: ${briefing.closestCategories.join(", ") || "none"}`,
    "",
    "✅ Best Current Action",
    ...(confidenceLabel(briefing) == null ? [] : [`Confidence: ${confidenceLabel(briefing)}`]),
    managerDecisionLine(briefing, lineupMoves, actions),
    ...bestAvailableLine(briefing),
  ];

  if ((briefing.bestActionSteps?.length ?? 0) > 0) {
    lines.push(
      "",
      "🧾 Do This",
      ...briefing.bestActionSteps!.slice(0, 5).map((line) => `• ${line}`),
    );
  }

  if (hasUrgentLineup) {
    lines.push(...actionSection);
  }

  if (briefing.managerTakeaways.length > 0) {
    lines.push(
      "",
      "🧠 Manager Read",
      ...briefing.managerTakeaways.slice(0, 5).map((line) => `• ${line}`),
    );
  }

  if (briefing.lineupAlerts.length > 0) {
    lines.push("", "🚨 Lineup");
    if (lineupProblems.length > 0) {
      lines.push("Problems", ...lineupProblems.slice(0, 5).map((line) => `• ${line}`));
    }
    if (lineupMoves.length > 0 && !hasOptimalLineup) {
      lines.push("Moves", ...lineupMoves.slice(0, 6).map((line) => `• ${line}`));
    }
    if (otherLineupAlerts.length > 0) {
      lines.push("Notes", ...otherLineupAlerts.slice(0, 3).map((line) => `• ${line}`));
    }
  }

  lines.push(...buildOptimalLineupBlock(briefing));

  if (lineupMoves.length > 0) {
    lines.push("", "📲 Yahoo Steps", ...yahooLineupSteps(lineupMoves));
  }

  if ((briefing.writeAlerts?.length ?? 0) > 0) {
    lines.push(
      "",
      "🔐 Yahoo Writes",
      ...briefing.writeAlerts!.slice(0, 2).map((line) => `• ${line}`),
    );
  }

  if ((briefing.pitcherStarts?.length ?? 0) > 0) {
    lines.push(
      "",
      "🗓️ Pitcher Starts",
      ...briefing.pitcherStarts!.slice(0, 5).map((line) => `• ${line}`),
    );
  }

  if (!hasUrgentLineup) {
    lines.push(...actionSection);
  }

  if (briefing.categorySituations.length > 0 && !hasUrgentLineup) {
    lines.push(
      "",
      "📊 Scoreboard",
      ...briefing.categorySituations.slice(0, 8).map(compactCategoryLine),
    );
  }

  if (briefing.addTriggers.length > 0) {
    lines.push(
      "",
      "🧭 Add Triggers",
      ...briefing.addTriggers.slice(0, 3).map((line) => `• ${line}`),
    );
  }

  if (briefing.rejectedTransactions.length > 0) {
    const best = briefing.bestAvailableAdd;
    const bestShown = best != null && !best.clearsBar;
    const skipped = briefing.rejectedTransactions.filter(
      (move) =>
        !(bestShown && move.addPlayerName === best!.playerName && move.reason === best!.reason),
    );
    if (skipped.length > 0) {
      lines.push(
        "",
        "⛔ Skipped",
        ...skipped.slice(0, 3).map((move) => `• ${move.addPlayerName}: ${move.reason}`),
      );
    }
  }

  if (briefing.warnings.length > 0) {
    lines.push(
      "",
      "🛑 Guardrails",
      ...briefing.warnings
        .slice(0, 2)
        .map(normalizeWarning)
        .map((line) => `• ${line}`),
    );
  }

  return lines.join("\n");
};

export class TelegramNotifier extends Context.Service<
  TelegramNotifier,
  {
    readonly postMessage: (content: string) => Effect.Effect<void, TelegramNotifierError>;
    readonly postManagerBriefing: (
      briefing: ManagerBriefingReport,
    ) => Effect.Effect<void, TelegramNotifierError>;
  }
>()("fantasy-gm/TelegramNotifier") {
  static readonly layerLive = Layer.effect(
    TelegramNotifier,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const tokenOption = yield* Config.redacted("TELEGRAM_BOT_TOKEN").pipe(Config.option);
      const chatIdOption = yield* Config.string("TELEGRAM_CHAT_ID").pipe(Config.option);

      if (Option.isNone(tokenOption) || Option.isNone(chatIdOption)) {
        return TelegramNotifier.of({
          postMessage: () =>
            Effect.fail(
              new TelegramNotifierError({
                message:
                  "Telegram delivery disabled; missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID",
              }),
            ),
          postManagerBriefing: () =>
            Effect.fail(
              new TelegramNotifierError({
                message:
                  "Telegram delivery disabled; missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID",
              }),
            ),
        });
      }

      const token = Redacted.value(tokenOption.value);
      const chatId = chatIdOption.value;
      const client = httpClient.pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(`${TELEGRAM_API_URL}/bot${token}`),
            HttpClientRequest.acceptJson,
          ),
        ),
      );

      const postMessage = (content: string) =>
        client
          .post("/sendMessage", {
            body: HttpBody.jsonUnsafe({
              chat_id: chatId,
              text: content,
              disable_web_page_preview: true,
            }),
          })
          .pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.void
                : Effect.fail(
                    new TelegramNotifierError({
                      message: `Telegram sendMessage failed with status ${response.status}`,
                      status: response.status,
                    }),
                  ),
            ),
            Effect.mapError(mapHttpError),
          );

      return TelegramNotifier.of({
        postMessage,
        postManagerBriefing: (briefing) =>
          Effect.gen(function* () {
            for (const chunk of splitDiscordMessage(
              renderManagerBriefingForTelegram(briefing),
              TELEGRAM_MESSAGE_LIMIT,
            )) {
              yield* postMessage(chunk);
            }
          }),
      });
    }),
  );
}
