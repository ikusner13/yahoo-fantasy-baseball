import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { HttpBody, HttpClient, HttpClientError, HttpClientRequest } from "effect/unstable/http";

import type { ManagerBriefingReport } from "./ManagerBriefing.ts";
import { renderManagerBriefingForDiscord, splitDiscordMessage } from "./DiscordNotifier.ts";

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

export const renderManagerBriefingForTelegram = (briefing: ManagerBriefingReport) =>
  renderManagerBriefingForDiscord(briefing)
    .replace(/\*\*/g, "")
    .replace(/\[(ACT|REVIEW|HOLD)\]/g, "[$1]");

export class TelegramNotifier extends Context.Service<
  TelegramNotifier,
  {
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
          postManagerBriefing: () =>
            Effect.log(
              "Telegram delivery disabled; missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID",
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
