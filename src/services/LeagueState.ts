import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { YahooApiError, YahooClient, type YahooLeagueTransaction } from "./YahooClient.ts";

const stringField = (value: unknown) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

const parseDateBoundary = (date: string, boundary: "start" | "end") => {
  const suffix = boundary === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
  const millis = Date.parse(`${date}${suffix}`);
  return Number.isFinite(millis) ? millis / 1000 : undefined;
};

const weeklyAddsUsed = (
  transactions: ReadonlyArray<YahooLeagueTransaction>,
  teamKey: string,
  weekStart: string,
  weekEnd: string,
) => {
  const start = parseDateBoundary(weekStart, "start");
  const end = parseDateBoundary(weekEnd, "end");
  if (start == null || end == null) return 0;
  const yahooTeamKeySuffix = teamKey.slice(teamKey.indexOf(".l."));
  const counted = new Set<string>();
  for (const transaction of transactions) {
    if (transaction.timestamp < start || transaction.timestamp > end) continue;
    if (transaction.status !== "successful") continue;
    if (!["add", "add/drop", "waiver"].includes(transaction.type)) continue;
    if (
      !transaction.addsToTeamKeys.some(
        (addTeamKey) => addTeamKey === teamKey || addTeamKey.endsWith(yahooTeamKeySuffix),
      )
    ) {
      continue;
    }
    counted.add(transaction.transactionKey);
  }
  return counted.size;
};

export class RosterSlotCount extends Schema.Class<RosterSlotCount>("RosterSlotCount")({
  position: Schema.String,
  count: Schema.Finite,
}) {}

export class LeagueStatePlayer extends Schema.Class<LeagueStatePlayer>("LeagueStatePlayer")({
  playerKey: Schema.String,
  name: Schema.String,
  team: Schema.String,
  eligiblePositions: Schema.Array(Schema.String),
  selectedPosition: Schema.String,
  status: Schema.optional(Schema.String),
}) {}

export class MatchupCategoryScore extends Schema.Class<MatchupCategoryScore>(
  "MatchupCategoryScore",
)({
  category: Schema.String,
  myValue: Schema.String,
  opponentValue: Schema.String,
}) {}

export class LeagueStateSnapshot extends Schema.Class<LeagueStateSnapshot>("LeagueStateSnapshot")({
  leagueId: Schema.String,
  teamId: Schema.String,
  scoringFormat: Schema.Literal("cumulative-category-h2h"),
  scoringCategories: Schema.Array(Schema.String),
  weeklyAddLimit: Schema.Finite,
  addsUsed: Schema.Finite,
  waiverPriority: Schema.optional(Schema.Finite),
  faabBalance: Schema.optional(Schema.Finite),
  roster: Schema.Array(LeagueStatePlayer),
  rosterSlots: Schema.Array(RosterSlotCount),
  emptySlots: Schema.Array(RosterSlotCount),
  ilUsed: Schema.Finite,
  ilSlots: Schema.Finite,
  matchup: Schema.Struct({
    week: Schema.Finite,
    weekStart: Schema.String,
    weekEnd: Schema.String,
    opponentTeamKey: Schema.String,
    opponentTeamName: Schema.String,
    categories: Schema.Array(MatchupCategoryScore),
  }),
}) {}

export class LeagueState extends Context.Service<
  LeagueState,
  {
    readonly snapshot: Effect.Effect<LeagueStateSnapshot, YahooApiError>;
  }
>()("fantasy-gm/LeagueState") {
  static readonly layerLive = Layer.effect(
    LeagueState,
    Effect.gen(function* () {
      const yahoo = yield* YahooClient;
      const snapshot = Effect.gen(function* () {
        const [settingsPayload, teamPayload, rosterPayload, matchupPayload, transactionsPayload] =
          yield* Effect.all([
            yahoo.getLeagueSettings,
            yahoo.getTeamMetadata,
            yahoo.getRoster,
            yahoo.getCurrentMatchup,
            yahoo.getLeagueTransactions(100),
          ]);

        const settings = settingsPayload.fantasy_content.league[1].settings;
        const scoringSettings = settings.find((entry) => entry.stat_categories != null);
        const rosterSettings = settings.find((entry) => entry.roster_positions != null);
        const rosterSlots =
          rosterSettings?.roster_positions?.map(
            (slot) => new RosterSlotCount({ position: slot.position, count: slot.count }),
          ) ?? [];
        const scoringCategories =
          scoringSettings?.stat_categories?.stats
            .filter((entry) => entry.stat.is_only_display_stat !== "1")
            .map((entry) => entry.stat.display_name) ?? [];

        const rosterPlayers = rosterPayload.fantasy_content.team[1].roster["0"].players;
        const roster = rosterPlayers.map((entry) => {
          const [player, selectedPosition] = entry.player;
          return new LeagueStatePlayer({
            playerKey: player.playerKey,
            name: player.name,
            team: player.team,
            eligiblePositions: player.eligiblePositions,
            selectedPosition: selectedPosition?.position ?? "BN",
            status: player.status,
          });
        });

        const usedSlots = new Map<string, number>();
        for (const player of roster) {
          usedSlots.set(player.selectedPosition, (usedSlots.get(player.selectedPosition) ?? 0) + 1);
        }
        const emptySlots = rosterSlots
          .map(
            (slot) =>
              new RosterSlotCount({
                position: slot.position,
                count: Math.max(0, slot.count - (usedSlots.get(slot.position) ?? 0)),
              }),
          )
          .filter((slot) => slot.count > 0);

        const matchup = matchupPayload.fantasy_content.team[1].matchups["0"].matchup;
        const teamMetadata = teamPayload.fantasy_content.team[0];
        const teamKey = `mlb.l.${yahoo.config.leagueId}.t.${yahoo.config.teamId}`;
        const inferredAddsUsed = weeklyAddsUsed(
          transactionsPayload.transactions,
          teamKey,
          matchup.week_start,
          matchup.week_end,
        );
        const opponentTeam = matchup["0"].teams["1"].team;
        const opponentInfo = opponentTeam[0];
        const myStats = matchup["0"].teams["0"].team[1].team_stats.stats;
        const opponentStats = matchup["0"].teams["1"].team[1].team_stats.stats;
        const opponentStatsById = new Map(
          opponentStats.map((entry) => [String(entry.stat.stat_id), stringField(entry.stat.value)]),
        );
        const categoryNameById = new Map(
          scoringSettings?.stat_categories?.stats.map((entry) => [
            String(entry.stat.stat_id),
            entry.stat.display_name,
          ]) ?? [],
        );

        return new LeagueStateSnapshot({
          leagueId: yahoo.config.leagueId,
          teamId: yahoo.config.teamId,
          scoringFormat: "cumulative-category-h2h",
          scoringCategories,
          weeklyAddLimit: rosterSettings?.max_weekly_adds ?? scoringSettings?.max_weekly_adds ?? 0,
          addsUsed: inferredAddsUsed,
          waiverPriority: teamMetadata.waiverPriority,
          faabBalance: teamMetadata.faabBalance,
          roster,
          rosterSlots,
          emptySlots,
          ilUsed: usedSlots.get("IL") ?? 0,
          ilSlots: rosterSlots.find((slot) => slot.position === "IL")?.count ?? 0,
          matchup: {
            week: matchup.week,
            weekStart: matchup.week_start,
            weekEnd: matchup.week_end,
            opponentTeamKey: opponentInfo.teamKey,
            opponentTeamName: opponentInfo.teamName,
            categories: myStats
              .map((entry) => {
                const statId = String(entry.stat.stat_id);
                const category = categoryNameById.get(statId);
                const opponentValue = opponentStatsById.get(statId);
                if (category == null || opponentValue == null) return undefined;
                return new MatchupCategoryScore({
                  category,
                  myValue: stringField(entry.stat.value),
                  opponentValue,
                });
              })
              .filter((entry): entry is MatchupCategoryScore => entry != null),
          },
        });
      });

      return LeagueState.of({
        snapshot,
      });
    }),
  );

  static readonly layerStub = Layer.succeed(
    LeagueState,
    LeagueState.of({
      snapshot: Effect.succeed(
        new LeagueStateSnapshot({
          leagueId: "62744",
          teamId: "12",
          scoringFormat: "cumulative-category-h2h",
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
          addsUsed: 0,
          roster: [],
          rosterSlots: [],
          emptySlots: [],
          ilUsed: 0,
          ilSlots: 0,
          matchup: {
            week: 0,
            weekStart: "",
            weekEnd: "",
            opponentTeamKey: "",
            opponentTeamName: "",
            categories: [],
          },
        }),
      ),
    }),
  );
}
