import * as Effect from "effect/Effect";

import {
  ManagerDeliveryChannelResult,
  ManagerDeliveryReport,
} from "../services/ManagerDelivery.ts";
import type { ManagerBriefingReport } from "../services/ManagerBriefing.ts";

const DELIVERY_TIMEOUT = "20 seconds";

type TelegramDelivery = {
  readonly postManagerBriefing: (briefing: ManagerBriefingReport) => Effect.Effect<void, unknown>;
};

type DiscordDelivery = {
  readonly postManagerBriefing: (
    briefing: ManagerBriefingReport,
    date?: Date,
  ) => Effect.Effect<void, unknown>;
};

const postWithTimeout = (
  channel: "telegram" | "discord",
  post: Effect.Effect<void, unknown, never>,
) =>
  post.pipe(
    Effect.timeout(DELIVERY_TIMEOUT),
    Effect.as(
      new ManagerDeliveryChannelResult({
        channel,
        ok: true,
        completedAt: new Date().toISOString(),
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const error = String(cause);
        yield* Effect.logError("manager briefing delivery failed", { channel, cause: error });
        return new ManagerDeliveryChannelResult({
          channel,
          ok: false,
          completedAt: new Date().toISOString(),
          error,
        });
      }),
    ),
  );

export const deliverManagerBriefing = (
  briefing: ManagerBriefingReport,
  telegram: TelegramDelivery,
  discord: DiscordDelivery,
): Effect.Effect<ManagerDeliveryReport> =>
  Effect.gen(function* () {
    const channels = yield* Effect.all(
      [
        postWithTimeout("telegram", telegram.postManagerBriefing(briefing)),
        postWithTimeout("discord", discord.postManagerBriefing(briefing)),
      ],
      { concurrency: 1 },
    );
    return new ManagerDeliveryReport({
      generatedAt: briefing.generatedAt,
      deliveredAt: new Date().toISOString(),
      channels,
    });
  });
