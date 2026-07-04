import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { YahooOAuth } from "./YahooOAuth.ts";

const BASE_URL = "https://fantasysports.yahooapis.com/fantasy/v2";
const YahooFinite = Schema.Union([Schema.Finite, Schema.FiniteFromString]);
const YahooString = Schema.Union([Schema.String, Schema.Finite]).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => String(value)),
    encode: SchemaGetter.transform((value) => value),
  }),
);

export class YahooApiError extends Data.TaggedError("YahooApiError")<{
  readonly message: string;
  readonly status?: number;
  readonly path?: string;
}> {}

const describeHttpCause = (cause: unknown) => {
  if (!HttpClientError.isHttpClientError(cause)) return String(cause);
  const nestedCause = "cause" in cause.reason ? cause.reason.cause : undefined;
  const nestedMessage =
    nestedCause instanceof Error
      ? nestedCause.message
      : nestedCause == null
        ? undefined
        : JSON.stringify(nestedCause);
  return [
    cause.message,
    `reason=${cause.reason._tag}`,
    nestedMessage == null ? undefined : `cause=${nestedMessage}`,
  ]
    .filter((part) => part != null && part !== "")
    .join("; ");
};

const YahooName = Schema.Struct({ full: YahooString });

const YahooEligiblePositions = Schema.Struct({
  eligible_positions: Schema.Array(Schema.Struct({ position: YahooString })),
});
const YahooEligiblePositionArray = Schema.Array(Schema.Struct({ position: YahooString }));

const YahooMetadataItem = Schema.Union([
  Schema.Record(Schema.String, Schema.Any),
  Schema.Array(Schema.Never),
]);

const YahooMetadataRecord = Schema.Array(YahooMetadataItem).pipe(
  Schema.decodeTo(Schema.Record(Schema.String, Schema.Any), {
    decode: SchemaGetter.transform((items) => Object.assign({}, ...items)),
    encode: SchemaGetter.transform((record) => [record]),
  }),
);

const YahooPlayerInfoItem = Schema.Union([
  Schema.Struct({ player_key: Schema.String }),
  Schema.Struct({ player_id: Schema.String }),
  Schema.Struct({ name: YahooName }),
  Schema.Struct({ editorial_team_abbr: Schema.String }),
  YahooEligiblePositions,
  Schema.Struct({ status: Schema.String }),
  Schema.Struct({ status_full: Schema.String }),
  Schema.Struct({ display_position: Schema.String }),
  Schema.Struct({ position_type: Schema.String }),
  Schema.Struct({ player_notes_last_timestamp: YahooFinite }),
  Schema.Struct({ has_player_notes: YahooFinite }),
  Schema.Struct({ has_recent_player_notes: YahooFinite }),
  Schema.Struct({ injury_note: Schema.String }),
  Schema.Array(Schema.Never),
  Schema.Record(Schema.String, Schema.Any),
]);

const YahooPlayerInfoRecord = Schema.Array(YahooPlayerInfoItem).pipe(
  Schema.decodeTo(Schema.Record(Schema.String, Schema.Any), {
    decode: SchemaGetter.transform((items) => Object.assign({}, ...items)),
    encode: SchemaGetter.transform((record) => [record]),
  }),
);

const YahooPlayerInfoShape = Schema.Struct({
  playerKey: YahooString,
  playerId: YahooString,
  name: Schema.String,
  team: YahooString,
  eligiblePositions: Schema.Array(Schema.String),
  status: Schema.optional(YahooString),
}).pipe(
  Schema.encodeKeys({
    playerKey: "player_key",
    playerId: "player_id",
    team: "editorial_team_abbr",
    eligiblePositions: "eligible_positions",
  }),
);

const YahooPlayerInfo = YahooPlayerInfoRecord.pipe(
  Schema.decodeTo(Schema.toType(YahooPlayerInfoShape), {
    decode: SchemaGetter.transform((record) => ({
      playerKey: Schema.decodeUnknownSync(YahooString)(record["player_key"]),
      playerId: Schema.decodeUnknownSync(YahooString)(record["player_id"]),
      name: Schema.decodeUnknownSync(YahooName)(record["name"]).full,
      team: Schema.decodeUnknownSync(YahooString)(record["editorial_team_abbr"]),
      eligiblePositions: Schema.decodeUnknownSync(YahooEligiblePositionArray)(
        record["eligible_positions"],
      ).map((position) => position.position),
      status:
        record["status"] == null
          ? undefined
          : Schema.decodeUnknownSync(YahooString)(record["status"]),
    })),
    encode: SchemaGetter.transform(() => ({})),
  }),
);

const YahooSelectedPosition = Schema.Struct({
  selected_position: YahooMetadataRecord,
}).pipe(
  Schema.decodeTo(Schema.toType(Schema.Struct({ position: YahooString })), {
    decode: SchemaGetter.transform((selected) => ({
      position: selected.selected_position["position"] ?? "BN",
    })),
    encode: SchemaGetter.transform((selected) => ({
      selected_position: [{ position: selected.position }],
    })),
  }),
);

const YahooRosterPlayer = Schema.Struct({
  player: Schema.TupleWithRest(
    Schema.Tuple([YahooPlayerInfo, Schema.optional(YahooSelectedPosition)]),
    [Schema.Record(Schema.String, Schema.Any)],
  ),
});

const YahooRosterPlayerEntry = Schema.Struct({
  player: YahooRosterPlayer.fields.player,
});

type YahooRosterPlayerEntryType = Schema.Schema.Type<typeof YahooRosterPlayerEntry>;

const YahooRosterPlayersRecord = Schema.Record(
  Schema.String,
  Schema.Union([YahooRosterPlayerEntry, YahooFinite]),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.Array(YahooRosterPlayerEntry)), {
    decode: SchemaGetter.transform(
      (record): ReadonlyArray<YahooRosterPlayerEntryType> =>
        Object.values(record).filter(
          (value): value is YahooRosterPlayerEntryType =>
            typeof value === "object" && value != null && "player" in value,
        ),
    ),
    encode: SchemaGetter.transform((players) =>
      Object.fromEntries(players.map((player, index) => [String(index), player])),
    ),
  }),
);

const YahooOutsPitched = Schema.Struct({
  coverage_type: Schema.String,
  coverage_value: YahooFinite,
  value: Schema.String,
});

const YahooRosterPayload = Schema.Struct({
  fantasy_content: Schema.Struct({
    team: Schema.Tuple([
      Schema.Any,
      Schema.Struct({
        roster: Schema.Struct({
          "0": Schema.Struct({
            players: YahooRosterPlayersRecord,
          }),
          coverage_type: Schema.String,
          date: Schema.String,
          is_prescoring: YahooFinite,
          is_editable: YahooFinite,
          outs_pitched: Schema.optional(YahooOutsPitched),
        }),
      }),
    ]),
  }),
});

const YahooPlayersPayload = Schema.Struct({
  fantasy_content: Schema.Struct({
    league: Schema.Tuple([
      Schema.Any,
      Schema.Struct({
        players: YahooRosterPlayersRecord,
      }),
    ]),
  }),
});

const YahooStat = Schema.Struct({
  stat_id: Schema.Union([Schema.String, Schema.Finite]),
  value: Schema.Union([Schema.String, Schema.Finite]),
});

const YahooTeamStats = Schema.Struct({
  team_stats: Schema.Struct({
    coverage_type: Schema.optional(Schema.String),
    week: Schema.optional(YahooFinite),
    stats: Schema.Array(Schema.Struct({ stat: YahooStat })),
  }),
});

const YahooTeamInfo = YahooMetadataRecord.pipe(
  Schema.decodeTo(Schema.Struct({ teamKey: Schema.String, teamName: Schema.String }), {
    decode: SchemaGetter.transform((team) => ({
      teamKey: Schema.decodeUnknownSync(YahooString)(team["team_key"]),
      teamName: Schema.decodeUnknownSync(YahooString)(team["name"]),
    })),
    encode: SchemaGetter.transform(() => ({})),
  }),
);

const YahooMatchupTeam = Schema.Struct({
  team: Schema.Tuple([YahooTeamInfo, YahooTeamStats, Schema.optional(Schema.Any)]),
});

const YahooMatchupPayload = Schema.Struct({
  fantasy_content: Schema.Struct({
    team: Schema.Tuple([
      Schema.Any,
      Schema.Struct({
        matchups: Schema.Struct({
          "0": Schema.Struct({
            matchup: Schema.Struct({
              week: YahooFinite,
              week_start: Schema.String,
              week_end: Schema.String,
              status: Schema.optional(Schema.String),
              is_playoffs: Schema.optional(Schema.String),
              is_consolation: Schema.optional(Schema.String),
              "0": Schema.Struct({
                teams: Schema.Struct({
                  "0": YahooMatchupTeam,
                  "1": YahooMatchupTeam,
                  count: YahooFinite,
                }),
              }),
            }),
          }),
          count: YahooFinite,
        }),
      }),
    ]),
  }),
});

const YahooRosterPositionValue = Schema.Struct({
  position: Schema.String,
  position_type: Schema.optional(Schema.String),
  count: YahooFinite,
});

const YahooRosterPosition = Schema.Union([
  YahooRosterPositionValue,
  Schema.Struct({ roster_position: YahooRosterPositionValue }),
]).pipe(
  Schema.decodeTo(Schema.toType(YahooRosterPositionValue), {
    decode: SchemaGetter.transform((slot) =>
      "roster_position" in slot ? slot.roster_position : slot,
    ),
    encode: SchemaGetter.transform((slot) => slot),
  }),
);

const YahooStatCategory = Schema.Struct({
  stat: Schema.Struct({
    stat_id: Schema.Union([Schema.String, Schema.Finite]),
    name: Schema.String,
    display_name: Schema.String,
    sort_order: Schema.optional(Schema.String),
    position_type: Schema.optional(Schema.String),
    is_only_display_stat: Schema.optional(Schema.String),
  }),
});

const YahooLeagueSettingsObject = Schema.Struct({
  max_weekly_adds: Schema.optional(YahooFinite),
  roster_positions: Schema.optional(Schema.Array(YahooRosterPosition)),
  stat_categories: Schema.optional(Schema.Struct({ stats: Schema.Array(YahooStatCategory) })),
  uses_faab: Schema.optional(Schema.String),
  waiver_type: Schema.optional(Schema.String),
  waiver_rule: Schema.optional(Schema.String),
  season_type: Schema.optional(Schema.String),
  min_innings_pitched: Schema.optional(Schema.String),
  week_has_enough_qualifying_days: Schema.optional(Schema.Record(Schema.String, YahooFinite)),
});

const YahooLeagueSettingsPayload = Schema.Struct({
  fantasy_content: Schema.Struct({
    league: Schema.Tuple([
      Schema.Any,
      Schema.Struct({
        settings: Schema.Array(YahooLeagueSettingsObject),
      }),
    ]),
  }),
});

const YahooTeamMetadataPayload = Schema.Struct({
  fantasy_content: Schema.Struct({
    team: Schema.Tuple([
      YahooMetadataRecord.pipe(
        Schema.decodeTo(
          Schema.Struct({
            numberOfMoves: Schema.optional(Schema.Finite),
            waiverPriority: Schema.optional(Schema.Finite),
            faabBalance: Schema.optional(Schema.Finite),
          }),
          {
            decode: SchemaGetter.transform((record) => ({
              numberOfMoves:
                record["number_of_moves"] == null
                  ? undefined
                  : Schema.decodeUnknownSync(YahooFinite)(record["number_of_moves"]),
              waiverPriority:
                record["waiver_priority"] == null
                  ? undefined
                  : Schema.decodeUnknownSync(YahooFinite)(record["waiver_priority"]),
              faabBalance:
                record["faab_balance"] == null
                  ? undefined
                  : Schema.decodeUnknownSync(YahooFinite)(record["faab_balance"]),
            })),
            encode: SchemaGetter.transform(() => ({})),
          },
        ),
      ),
    ]),
  }),
});

export const YahooLeagueTransaction = Schema.Struct({
  transactionKey: Schema.String,
  type: Schema.String,
  status: Schema.String,
  timestamp: Schema.Finite,
  addsToTeamKeys: Schema.Array(Schema.String),
});

const YahooTransactionData = Schema.Struct({
  type: YahooString,
  destination_team_key: Schema.optional(YahooString),
});

const YahooTransactionDataList = Schema.Union([
  YahooTransactionData,
  Schema.Array(YahooTransactionData),
]).pipe(
  Schema.decodeTo(Schema.Array(YahooTransactionData), {
    decode: SchemaGetter.transform((data) => (Array.isArray(data) ? data : [data])),
    encode: SchemaGetter.transform(
      (data) =>
        (data.length === 1 ? data[0] : data) as unknown as
          | Schema.Schema.Type<typeof YahooTransactionData>
          | ReadonlyArray<Schema.Schema.Type<typeof YahooTransactionData>>,
    ),
  }),
);

const YahooTransactionPlayerInfoItem = Schema.Union([
  Schema.Struct({ player_key: YahooString }),
  Schema.Struct({ player_id: YahooString }),
  Schema.Struct({ name: Schema.Any }),
  Schema.Struct({ transaction_data: YahooTransactionDataList }),
  Schema.Record(Schema.String, Schema.Any),
]);

const YahooTransactionPlayerInfo = Schema.Array(YahooTransactionPlayerInfoItem).pipe(
  Schema.decodeTo(
    Schema.Struct({
      transactionData: Schema.Array(YahooTransactionData),
    }),
    {
      decode: SchemaGetter.transform((items) => {
        const record = Object.assign({}, ...items);
        return {
          transactionData:
            record["transaction_data"] == null
              ? []
              : Schema.decodeUnknownSync(YahooTransactionDataList)(record["transaction_data"]),
        };
      }),
      encode: SchemaGetter.transform(() => []),
    },
  ),
);

const YahooTransactionPlayerTuple = Schema.Tuple([
  Schema.Any,
  Schema.Struct({ transaction_data: YahooTransactionDataList }),
]).pipe(
  Schema.decodeTo(Schema.Struct({ transactionData: Schema.Array(YahooTransactionData) }), {
    decode: SchemaGetter.transform((player) => ({
      transactionData: player[1].transaction_data,
    })),
    encode: SchemaGetter.transform(
      (player) =>
        [undefined, { transaction_data: player.transactionData }] as unknown as readonly [
          unknown,
          { transaction_data: Schema.Schema.Type<typeof YahooTransactionDataList> },
        ],
    ),
  }),
);

const YahooTransactionPlayerEntry = Schema.Struct({
  player: Schema.Union([YahooTransactionPlayerInfo, YahooTransactionPlayerTuple]),
});

type YahooTransactionPlayerEntryType = Schema.Schema.Type<typeof YahooTransactionPlayerEntry>;

const YahooTransactionPlayersRecord = Schema.Record(
  Schema.String,
  Schema.Union([YahooTransactionPlayerEntry, YahooFinite]),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.Array(YahooTransactionPlayerEntry)), {
    decode: SchemaGetter.transform(
      (record): ReadonlyArray<YahooTransactionPlayerEntryType> =>
        Object.values(record).filter(
          (value): value is YahooTransactionPlayerEntryType =>
            typeof value === "object" && value != null && "player" in value,
        ),
    ),
    encode: SchemaGetter.transform((players) =>
      Object.fromEntries(players.map((player, index) => [String(index), player])),
    ),
  }),
);

const YahooTransactionMetadata = Schema.Struct({
  transaction_key: Schema.optional(YahooString),
  type: YahooString,
  status: Schema.optional(YahooString),
  timestamp: YahooFinite,
});

const YahooTransactionObject = Schema.Struct({
  transaction_key: Schema.optional(YahooString),
  type: YahooString,
  status: Schema.optional(YahooString),
  timestamp: YahooFinite,
  players: Schema.optional(YahooTransactionPlayersRecord),
});

const YahooTransactionTuple = Schema.Tuple([
  YahooTransactionMetadata,
  Schema.Struct({ players: YahooTransactionPlayersRecord }),
]);

const YahooTransaction = Schema.Union([YahooTransactionObject, YahooTransactionTuple]).pipe(
  Schema.decodeTo(Schema.toType(YahooLeagueTransaction), {
    decode: SchemaGetter.transform((source) => {
      const transaction = Array.isArray(source)
        ? { ...source[0], players: source[1].players }
        : source;
      return {
        transactionKey: transaction.transaction_key ?? `${transaction.timestamp}`,
        type: transaction.type,
        status: transaction.status ?? "successful",
        timestamp: transaction.timestamp,
        addsToTeamKeys:
          transaction.players?.flatMap((entry: YahooTransactionPlayerEntryType) => {
            return entry.player.transactionData.flatMap((data) =>
              data.type === "add" && data.destination_team_key != null
                ? [data.destination_team_key]
                : [],
            );
          }) ?? [],
      };
    }),
    encode: SchemaGetter.transform((transaction) => ({
      transaction_key: transaction.transactionKey,
      type: transaction.type,
      status: transaction.status,
      timestamp: transaction.timestamp,
      players: undefined,
    })),
  }),
);

const YahooTransactionEntry = Schema.Struct({
  transaction: YahooTransaction,
});

type YahooTransactionEntryType = Schema.Schema.Type<typeof YahooTransactionEntry>;

const YahooTransactionsRecord = Schema.Record(
  Schema.String,
  Schema.Union([YahooTransactionEntry, YahooFinite]),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.Array(YahooTransactionEntry)), {
    decode: SchemaGetter.transform(
      (record): ReadonlyArray<YahooTransactionEntryType> =>
        Object.values(record).filter(
          (value): value is YahooTransactionEntryType =>
            typeof value === "object" && value != null && "transaction" in value,
        ),
    ),
    encode: SchemaGetter.transform((transactions) =>
      Object.fromEntries(transactions.map((transaction, index) => [String(index), transaction])),
    ),
  }),
);

const YahooLeagueTransactionsRawPayload = Schema.Struct({
  fantasy_content: Schema.Struct({
    league: Schema.Tuple([
      Schema.Any,
      Schema.Struct({
        transactions: YahooTransactionsRecord,
      }),
    ]),
  }),
});

type YahooLeagueTransactionsRawPayloadType = Schema.Schema.Type<
  typeof YahooLeagueTransactionsRawPayload
>;

const YahooLeagueTransactionsPayload = YahooLeagueTransactionsRawPayload.pipe(
  Schema.decodeTo(Schema.Struct({ transactions: Schema.Array(YahooLeagueTransaction) }), {
    decode: SchemaGetter.transform((payload) => ({
      transactions: payload.fantasy_content.league[1].transactions.map(
        (entry) => entry.transaction,
      ),
    })),
    encode: SchemaGetter.transform(
      (payload) =>
        ({
          fantasy_content: {
            league: [
              {},
              {
                transactions: Object.fromEntries(
                  payload.transactions.map((transaction, index) => [
                    String(index),
                    {
                      transaction: {
                        transaction_key: transaction.transactionKey,
                        type: transaction.type,
                        status: transaction.status,
                        timestamp: transaction.timestamp,
                        players: undefined,
                      },
                    },
                  ]),
                ),
              },
            ],
          },
        }) as unknown as YahooLeagueTransactionsRawPayloadType,
    ),
  }),
);

const YahooStandingsPayload = Schema.Struct({
  fantasy_content: Schema.Struct({
    league: Schema.Tuple([
      Schema.Any,
      Schema.Struct({
        standings: Schema.Tuple([
          Schema.Struct({
            teams: Schema.Record(Schema.String, Schema.Any),
          }),
        ]),
      }),
    ]),
  }),
});

export type YahooPlayerInfoItem = Schema.Schema.Type<typeof YahooPlayerInfoItem>;
export type YahooLeagueSettingsObject = Schema.Schema.Type<typeof YahooLeagueSettingsObject>;
export type YahooRosterPayload = Schema.Schema.Type<typeof YahooRosterPayload>;
export type YahooPlayersPayload = Schema.Schema.Type<typeof YahooPlayersPayload>;
export type YahooMatchupPayload = Schema.Schema.Type<typeof YahooMatchupPayload>;
export type YahooLeagueSettingsPayload = Schema.Schema.Type<typeof YahooLeagueSettingsPayload>;
export type YahooTeamMetadataPayload = Schema.Schema.Type<typeof YahooTeamMetadataPayload>;
export type YahooLeagueTransaction = Schema.Schema.Type<typeof YahooLeagueTransaction>;
export type YahooLeagueTransactionsPayload = Schema.Schema.Type<
  typeof YahooLeagueTransactionsPayload
>;
export type YahooStandingsPayload = Schema.Schema.Type<typeof YahooStandingsPayload>;

export interface YahooClientConfig {
  readonly leagueId: string;
  readonly teamId: string;
}

export interface YahooRosterPositionMove {
  readonly playerKey: string;
  readonly position: string;
}

export type YahooTransactionWrite =
  | {
      readonly type: "add";
      readonly playerKey: string;
    }
  | {
      readonly type: "drop";
      readonly playerKey: string;
    }
  | {
      readonly type: "add/drop";
      readonly addPlayerKey: string;
      readonly dropPlayerKey: string;
      readonly faabBid?: number;
    }
  | {
      readonly type: "waiver";
      readonly addPlayerKey: string;
      readonly dropPlayerKey?: string;
      readonly faabBid?: number;
    };

const xmlEscape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export const buildRosterPositionsXml = (
  date: string,
  moves: ReadonlyArray<YahooRosterPositionMove>,
) => `<?xml version="1.0" encoding="UTF-8"?>
<fantasy_content>
  <roster>
    <coverage_type>date</coverage_type>
    <date>${xmlEscape(date)}</date>
    <players>
${moves
  .map(
    (move) => `      <player>
        <player_key>${xmlEscape(move.playerKey)}</player_key>
        <selected_position>
          <coverage_type>date</coverage_type>
          <date>${xmlEscape(date)}</date>
          <position>${xmlEscape(move.position)}</position>
        </selected_position>
      </player>`,
  )
  .join("\n")}
    </players>
  </roster>
</fantasy_content>`;

const buildTransactionPlayerXml = (
  playerKey: string,
  transactionType: "add" | "drop",
  teamKey: string,
) => `      <player>
        <player_key>${xmlEscape(playerKey)}</player_key>
        <transaction_data>
          <type>${transactionType}</type>
          ${
            transactionType === "add"
              ? `<destination_team_key>${xmlEscape(teamKey)}</destination_team_key>`
              : `<source_team_key>${xmlEscape(teamKey)}</source_team_key>`
          }
        </transaction_data>
      </player>`;

const buildOptionalFaabBidXml = (faabBid: number | undefined) =>
  faabBid == null ? "" : `    <faab_bid>${xmlEscape(String(faabBid))}</faab_bid>\n`;

export const buildTransactionXml = (teamKey: string, transaction: YahooTransactionWrite) => {
  if (transaction.type === "add" || transaction.type === "drop") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<fantasy_content>
  <transaction>
    <type>${transaction.type}</type>
    <player>
      <player_key>${xmlEscape(transaction.playerKey)}</player_key>
      <transaction_data>
        <type>${transaction.type}</type>
        ${
          transaction.type === "add"
            ? `<destination_team_key>${xmlEscape(teamKey)}</destination_team_key>`
            : `<source_team_key>${xmlEscape(teamKey)}</source_team_key>`
        }
      </transaction_data>
    </player>
  </transaction>
</fantasy_content>`;
  }

  const dropPlayerXml =
    transaction.dropPlayerKey == null
      ? ""
      : `\n${buildTransactionPlayerXml(transaction.dropPlayerKey, "drop", teamKey)}`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<fantasy_content>
  <transaction>
    <type>${transaction.type}</type>
${buildOptionalFaabBidXml(transaction.faabBid)}    <players>
${buildTransactionPlayerXml(transaction.addPlayerKey, "add", teamKey)}${dropPlayerXml}
    </players>
  </transaction>
</fantasy_content>`;
};

export class YahooClient extends Context.Service<
  YahooClient,
  {
    readonly config: YahooClientConfig;
    readonly getLeagueSettings: Effect.Effect<YahooLeagueSettingsPayload, YahooApiError>;
    readonly getTeamMetadata: Effect.Effect<YahooTeamMetadataPayload, YahooApiError>;
    readonly getRoster: Effect.Effect<YahooRosterPayload, YahooApiError>;
    readonly getRosterForDate: (date: string) => Effect.Effect<YahooRosterPayload, YahooApiError>;
    readonly getRosterForTeam: (
      teamKey: string,
    ) => Effect.Effect<YahooRosterPayload, YahooApiError>;
    readonly getAvailablePlayers: (
      count: number,
    ) => Effect.Effect<YahooPlayersPayload, YahooApiError>;
    readonly getLeagueTransactions: (
      count: number,
    ) => Effect.Effect<YahooLeagueTransactionsPayload, YahooApiError>;
    readonly getCurrentMatchup: Effect.Effect<YahooMatchupPayload, YahooApiError>;
    readonly getMatchupForWeek: (week: number) => Effect.Effect<YahooMatchupPayload, YahooApiError>;
    readonly getLeagueStandings: Effect.Effect<YahooStandingsPayload, YahooApiError>;
    readonly putRosterPositions: (
      date: string,
      moves: ReadonlyArray<YahooRosterPositionMove>,
    ) => Effect.Effect<void, YahooApiError>;
  }
>()("fantasy-gm/YahooClient") {
  static readonly layer = Layer.effect(
    YahooClient,
    Effect.gen(function* () {
      const oauth = yield* YahooOAuth;
      const httpClient = yield* HttpClient.HttpClient;
      const leagueId = yield* Config.string("YAHOO_LEAGUE_ID");
      const teamId = yield* Config.string("YAHOO_TEAM_ID");

      return YahooClient.of(makeYahooClient({ leagueId, teamId }, oauth, httpClient));
    }),
  );
}

const makeYahooClientShape = (
  config: YahooClientConfig,
  request: <A>(path: string, schema: Schema.Schema<A>) => Effect.Effect<A, YahooApiError>,
  writeRosterPositions: (
    path: string,
    date: string,
    moves: ReadonlyArray<YahooRosterPositionMove>,
  ) => Effect.Effect<void, YahooApiError>,
): Context.Service.Shape<typeof YahooClient> => {
  const leagueKey = `mlb.l.${config.leagueId}`;
  const teamKey = `${leagueKey}.t.${config.teamId}`;

  return {
    config,
    getLeagueSettings: request(`/league/${leagueKey}/settings`, YahooLeagueSettingsPayload),
    getTeamMetadata: request(`/team/${teamKey}/metadata`, YahooTeamMetadataPayload),
    getRoster: request(`/team/${teamKey}/roster/players`, YahooRosterPayload),
    getRosterForDate: (date) =>
      request(`/team/${teamKey}/roster/players;date=${date}`, YahooRosterPayload),
    getRosterForTeam: (targetTeamKey) =>
      request(`/team/${targetTeamKey}/roster/players`, YahooRosterPayload),
    getAvailablePlayers: (count) => {
      const pageSize = 25;
      const starts = Array.from(
        { length: Math.max(1, Math.ceil(Math.max(0, count) / pageSize)) },
        (_, index) => index * pageSize,
      );
      return Effect.gen(function* () {
        const pages = yield* Effect.forEach(
          starts,
          (start) => {
            const pageCount = Math.min(pageSize, Math.max(0, count - start));
            const startParam = start === 0 ? "" : `;start=${start}`;
            return request(
              `/league/${leagueKey}/players;status=FA;count=${pageCount}${startParam}`,
              YahooPlayersPayload,
            );
          },
          { concurrency: 3 },
        );
        const players = pages.flatMap((page) => page.fantasy_content.league[1].players);
        return {
          fantasy_content: {
            league: [{}, { players: players.slice(0, count) }],
          },
        } satisfies YahooPlayersPayload;
      });
    },
    getLeagueTransactions: (count) =>
      request(
        `/league/${leagueKey}/transactions;team_key=${teamKey};types=add,drop;count=${count}`,
        YahooLeagueTransactionsPayload,
      ),
    getCurrentMatchup: request(`/team/${teamKey}/matchups;weeks=current`, YahooMatchupPayload),
    getMatchupForWeek: (week) =>
      request(`/team/${teamKey}/matchups;weeks=${week}`, YahooMatchupPayload),
    getLeagueStandings: request(`/league/${leagueKey}/standings`, YahooStandingsPayload),
    putRosterPositions: (date, moves) =>
      writeRosterPositions(`/team/${teamKey}/roster/players`, date, moves),
  };
};

export const makeYahooClient = (
  config: YahooClientConfig,
  oauth: Context.Service.Shape<typeof YahooOAuth>,
  httpClient: HttpClient.HttpClient,
): Context.Service.Shape<typeof YahooClient> => {
  const request = <A>(path: string, schema: Schema.Schema<A>) =>
    Effect.gen(function* () {
      const accessToken = yield* oauth.getAccessToken.pipe(
        Effect.mapError((cause) => new YahooApiError({ message: cause.message, path })),
      );

      const yahooHttpClient = httpClient.pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(BASE_URL),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(accessToken),
          ),
        ),
        HttpClient.filterStatusOk,
      );

      return yield* yahooHttpClient.get(path, { urlParams: { format: "json" } }).pipe(
        Effect.flatMap(
          (response) =>
            HttpClientResponse.schemaBodyJson(schema)(response) as Effect.Effect<A, unknown, never>,
        ),
        Effect.mapError(
          (cause) =>
            new YahooApiError({
              message: describeHttpCause(cause),
              status: HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined,
              path,
            }),
        ),
      );
    });

  const writeRosterPositions = (
    path: string,
    date: string,
    moves: ReadonlyArray<YahooRosterPositionMove>,
  ) =>
    Effect.gen(function* () {
      if (moves.length === 0) return;
      const accessToken = yield* oauth.getAccessToken.pipe(
        Effect.mapError((cause) => new YahooApiError({ message: cause.message, path })),
      );
      const yahooHttpClient = httpClient.pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(BASE_URL),
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(accessToken),
          ),
        ),
        HttpClient.filterStatusOk,
      );
      yield* yahooHttpClient
        .put(path, {
          body: HttpBody.text(buildRosterPositionsXml(date, moves), "application/xml"),
          urlParams: { format: "json" },
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause) =>
              new YahooApiError({
                message: describeHttpCause(cause),
                status: HttpClientError.isHttpClientError(cause)
                  ? cause.response?.status
                  : undefined,
                path,
              }),
          ),
        );
    });

  return makeYahooClientShape(config, request, writeRosterPositions);
};
