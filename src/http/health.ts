import * as Schema from "effect/Schema";

import { FREE_TIER_MODE } from "../infra/free-tier.ts";

export class HealthResponse extends Schema.Class<HealthResponse>("HealthResponse")({
  ok: Schema.Boolean,
  app: Schema.String,
  stack: Schema.Literal("effect-v4-alchemy-v2"),
  leagueId: Schema.String,
  teamId: Schema.String,
  scoringCategories: Schema.Array(Schema.String),
  weeklyAddLimit: Schema.Finite,
  cronCount: Schema.Finite,
  freeTier: Schema.Struct({
    mode: Schema.Literal("cloudflare-workers-free"),
    cronWithinLimit: Schema.Boolean,
    maxCronTriggers: Schema.Finite,
    workerRequestsPerDayBudget: Schema.Finite,
    maxExternalSubrequestsPerInvocation: Schema.Finite,
    dailyTaskLimits: Schema.Record(Schema.String, Schema.Finite),
    defaults: Schema.Struct({
      maxConfirmedLineupBoxscores: Schema.Finite,
      useStandingsHistory: Schema.Boolean,
      dailyMorningBriefingHourEastern: Schema.Finite,
      dailyBriefingHourUtcFallback: Schema.Finite,
    }),
  }),
}) {}

export const makeHealthResponse = (cronCount: number) =>
  new HealthResponse({
    ok: true,
    app: "fantasy-gm",
    stack: "effect-v4-alchemy-v2",
    leagueId: "62744",
    teamId: "12",
    scoringCategories: [
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
    ],
    weeklyAddLimit: 6,
    cronCount,
    freeTier: {
      ...FREE_TIER_MODE,
      cronWithinLimit: cronCount <= FREE_TIER_MODE.maxCronTriggers,
    },
  });
