import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import type { ManagerBriefingReport, ManualAction } from "./ManagerBriefing.ts";

const DISCORD_API_URL = "https://discord.com/api/v10";
const DISCORD_PUBLIC_THREAD = 11;
const DISCORD_MESSAGE_LIMIT = 1900;

const DiscordThread = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
});

const DiscordActiveThreads = Schema.Struct({
  threads: Schema.Array(DiscordThread),
});

const threadNameForDate = (date: Date) => `Fantasy GM ${date.toISOString().slice(0, 10)}`;

const actionLine = (action: ManualAction) => {
  const categories = action.categories.length > 0 ? action.categories.join(", ") : "depth";
  return `${action.priority}. [${action.confidence.toUpperCase()}] ${action.action} (${categories})`;
};

const actionBlock = (action: ManualAction) => {
  const lines = [actionLine(action), `   Why: ${action.rationale}`];
  const checks = action.checks.slice(0, 2);
  if (checks.length > 0) lines.push(`   Check: ${checks.join(" ")}`);
  const stopIf = action.stopIf[0];
  if (stopIf != null) lines.push(`   Stop if: ${stopIf}`);
  return lines;
};

const categoryStatusLabel = (status: string) =>
  status === "winning" ? "W" : status === "losing" ? "L" : "T";

const categorySituationLine = (situation: ManagerBriefingReport["categorySituations"][number]) =>
  `${categoryStatusLabel(situation.status)} ${situation.category}: ${situation.myValue}-${situation.opponentValue}`;

const rejectedLine = (
  rejection: ManagerBriefingReport["rejectedTransactions"][number],
  index: number,
) => {
  const drop = rejection.dropPlayerName == null ? "" : ` over ${rejection.dropPlayerName}`;
  const categories =
    rejection.affectedCategories.length > 0 ? rejection.affectedCategories.join(", ") : "depth";
  return `${index + 1}. ${rejection.addPlayerName}${drop}: ${rejection.reason} (${categories}, score ${rejection.score.toFixed(2)})`;
};

const formatEasternTime = (isoTime: string | undefined) => {
  if (isoTime == null) return "unknown";
  const date = new Date(isoTime);
  if (!Number.isFinite(date.getTime())) return isoTime;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
};

const todayGameWindowLine = (briefing: ManagerBriefingReport) => {
  const window = briefing.todayGameWindow;
  if (window == null) return "Today MLB games: schedule unavailable";
  const first = formatEasternTime(window.firstGameTime);
  const last = formatEasternTime(window.lastGameTime);
  return `Today MLB games: ${window.remainingGames}/${window.games} not started; first ${first}; last ${last}`;
};

export const renderManagerBriefingForDiscord = (briefing: ManagerBriefingReport) => {
  const lines = [
    `**${briefing.summary}**`,
    "",
    `As of: ${briefing.generatedAt}`,
    todayGameWindowLine(briefing),
    `Adds remaining: ${briefing.addsRemaining}`,
    `Reserved adds: ${briefing.reservedAdds}`,
    `Projected weekly IP: ${briefing.projectedWeeklyIp.toFixed(1)}`,
    `Closest categories: ${briefing.closestCategories.join(", ") || "none"}`,
  ];

  if (briefing.categorySituations.length > 0) {
    lines.push(
      "",
      "**Current categories**",
      ...briefing.categorySituations.map(categorySituationLine),
    );
  }

  if (briefing.categoryPlan.length > 0) {
    lines.push("", "**Category plan**", ...briefing.categoryPlan.map((line) => `- ${line}`));
  }

  if (briefing.addTriggers.length > 0) {
    lines.push(
      "",
      "**What would trigger an add**",
      ...briefing.addTriggers.map((line) => `- ${line}`),
    );
  }

  if (briefing.doNow.length > 0) {
    lines.push("", "**Do now**", ...briefing.doNow.flatMap(actionBlock));
  }

  if (briefing.holdForLater.length > 0) {
    lines.push("", "**Review / alternatives**", ...briefing.holdForLater.flatMap(actionBlock));
  }

  if (briefing.rejectedTransactions.length > 0) {
    lines.push("", "**Rejected moves**", ...briefing.rejectedTransactions.map(rejectedLine));
  }

  if (briefing.warnings.length > 0) {
    lines.push("", "**Checks**", ...briefing.warnings.map((warning) => `- ${warning}`));
  }

  return lines.join("\n");
};

export const splitDiscordMessage = (message: string, maxLength = DISCORD_MESSAGE_LIMIT) => {
  if (message.length <= maxLength) return [message];
  const chunks: Array<string> = [];
  let remaining = message;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt <= 0) splitAt = maxLength;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
};

export class DiscordNotifierError extends Data.TaggedError("DiscordNotifierError")<{
  readonly message: string;
  readonly status?: number;
}> {}

const mapHttpError = (cause: unknown) =>
  new DiscordNotifierError({
    message: String(cause),
    status: HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined,
  });

export class DiscordNotifier extends Context.Service<
  DiscordNotifier,
  {
    readonly postManagerBriefing: (
      briefing: ManagerBriefingReport,
      date?: Date,
    ) => Effect.Effect<void, DiscordNotifierError>;
  }
>()("fantasy-gm/DiscordNotifier") {
  static readonly layerLive = Layer.effect(
    DiscordNotifier,
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
      const tokenOption = yield* Config.redacted("DISCORD_BOT_TOKEN").pipe(Config.option);
      const channelIdOption = yield* Config.string("DISCORD_CHANNEL_ID").pipe(Config.option);

      if (Option.isNone(tokenOption) || Option.isNone(channelIdOption)) {
        return DiscordNotifier.of({
          postManagerBriefing: () =>
            Effect.log(
              "Discord delivery disabled; missing DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID",
            ),
        });
      }

      const token = Redacted.value(tokenOption.value);
      const channelId = channelIdOption.value;
      const client = httpClient.pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl(DISCORD_API_URL),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(token),
          ),
        ),
      );

      const getOrCreateDailyThread = (date: Date) => {
        const name = threadNameForDate(date);
        return client.get(`/channels/${channelId}/threads/active`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(DiscordActiveThreads)),
          Effect.map((payload) => payload.threads.find((thread) => thread.name === name)?.id),
          Effect.flatMap((threadId) => {
            if (threadId != null) return Effect.succeed(threadId);
            return client
              .post(`/channels/${channelId}/threads`, {
                body: HttpBody.jsonUnsafe({
                  name,
                  type: DISCORD_PUBLIC_THREAD,
                  auto_archive_duration: 1440,
                }),
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.schemaBodyJson(DiscordThread)),
                Effect.map((thread) => thread.id),
              );
          }),
          Effect.mapError(mapHttpError),
        );
      };

      const postMessage = (threadId: string, content: string) =>
        client
          .post(`/channels/${threadId}/messages`, {
            body: HttpBody.jsonUnsafe({
              content,
              allowed_mentions: { parse: [] },
            }),
          })
          .pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? Effect.void
                : Effect.fail(
                    new DiscordNotifierError({
                      message: `Discord sendMessage failed with status ${response.status}`,
                      status: response.status,
                    }),
                  ),
            ),
            Effect.mapError(mapHttpError),
          );

      return DiscordNotifier.of({
        postManagerBriefing: (briefing, date = new Date()) =>
          Effect.gen(function* () {
            const threadId = yield* getOrCreateDailyThread(date);
            for (const chunk of splitDiscordMessage(renderManagerBriefingForDiscord(briefing))) {
              yield* postMessage(threadId, chunk);
            }
          }),
      });
    }),
  );
}
