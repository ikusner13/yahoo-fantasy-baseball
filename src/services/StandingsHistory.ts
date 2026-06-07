import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  YahooApiError,
  YahooClient,
  type YahooLeagueSettingsPayload,
  type YahooStandingsPayload,
} from "./YahooClient.ts";

const SCORING_CATEGORIES = [
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

type ScoringCategory = (typeof SCORING_CATEGORIES)[number];

const isScoringCategory = (value: string): value is ScoringCategory =>
  SCORING_CATEGORIES.includes(value as ScoringCategory);

export class StandingCategoryTotal extends Schema.Class<StandingCategoryTotal>(
  "StandingCategoryTotal",
)({
  teamKey: Schema.String,
  rank: Schema.Finite,
  categories: Schema.Record(Schema.String, Schema.Finite),
}) {}

export class StandingsHistoryError extends Data.TaggedError("StandingsHistoryError")<{
  readonly message: string;
}> {}

const objectValues = (record: unknown) =>
  record != null && typeof record === "object" ? Object.values(record) : [];

const metadataValue = (items: unknown, key: string) => {
  if (!Array.isArray(items)) return undefined;
  for (const item of items) {
    if (item != null && typeof item === "object" && key in item) {
      const value = (item as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number") return String(value);
    }
  }
  return undefined;
};

const numericValue = (value: unknown) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized === "" || normalized.includes("/")) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const categoryByStatId = (settingsPayload: YahooLeagueSettingsPayload) => {
  const settings = settingsPayload.fantasy_content.league[1].settings;
  const scoringSettings = settings.find((entry) => entry.stat_categories != null);
  return new Map(
    scoringSettings?.stat_categories?.stats.flatMap((entry) => {
      const stat = entry.stat;
      if (stat.is_only_display_stat === "1" || !isScoringCategory(stat.display_name)) return [];
      return [[String(stat.stat_id), stat.display_name] as const];
    }) ?? [],
  );
};

export const parseStandingsCategoryTotals = (
  settingsPayload: YahooLeagueSettingsPayload,
  standingsPayload: YahooStandingsPayload,
) => {
  const categoryIndex = categoryByStatId(settingsPayload);
  const teams = standingsPayload.fantasy_content.league[1].standings[0].teams;

  return objectValues(teams).flatMap((entry) => {
    const team = (entry as { readonly team?: unknown })?.team;
    if (!Array.isArray(team)) return [];

    const teamKey = metadataValue(team[0], "team_key");
    const rank = numericValue(
      (team[2] as { readonly team_standings?: { readonly rank?: unknown } } | undefined)
        ?.team_standings?.rank,
    );
    const stats = (team[1] as { readonly team_stats?: { readonly stats?: ReadonlyArray<unknown> } })
      ?.team_stats?.stats;
    if (teamKey == null || rank == null || !Array.isArray(stats)) return [];

    const categories: Record<string, number> = {};
    for (const statEntry of stats) {
      const stat = (
        statEntry as { readonly stat?: { readonly stat_id?: unknown; readonly value?: unknown } }
      )?.stat;
      const category = categoryIndex.get(String(stat?.stat_id));
      const value = numericValue(stat?.value);
      if (category != null && value != null) categories[category] = value;
    }

    return [new StandingCategoryTotal({ teamKey, rank, categories })];
  });
};

const mapError = (error: YahooApiError) =>
  new StandingsHistoryError({ message: `${error._tag}: ${error.message}` });

export class StandingsHistory extends Context.Service<
  StandingsHistory,
  {
    readonly categoryTotals: Effect.Effect<
      ReadonlyArray<StandingCategoryTotal>,
      StandingsHistoryError
    >;
  }
>()("fantasy-gm/StandingsHistory") {
  static readonly layerLive = Layer.effect(
    StandingsHistory,
    Effect.gen(function* () {
      const yahoo = yield* YahooClient;
      return StandingsHistory.of({
        categoryTotals: Effect.gen(function* () {
          const [settings, standings] = yield* Effect.all([
            yahoo.getLeagueSettings,
            yahoo.getLeagueStandings,
          ]);
          return parseStandingsCategoryTotals(settings, standings);
        }).pipe(Effect.mapError(mapError)),
      });
    }),
  );

  static readonly layerEmpty = Layer.succeed(
    StandingsHistory,
    StandingsHistory.of({
      categoryTotals: Effect.succeed([]),
    }),
  );
}
