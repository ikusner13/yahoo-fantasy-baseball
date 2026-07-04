import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { flow } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  BatterProjectionSource,
  BattingOrderContext,
  DailyGameWindow,
  ParkFactorContext,
  PitcherProjectionSource,
  ProbablePitcherStart,
  StatcastPlayerContext,
  WeeklyContext,
  WeeklySchedule,
} from "./ProjectionModel.ts";
import { ApiCache } from "./ApiCache.ts";

const FANGRAPHS_URL = "https://www.fangraphs.com/api/projections";
const MLB_STATS_URL = "https://statsapi.mlb.com/api/v1";
const ODDS_API_URL = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds";
const SAVANT_CUSTOM_LEADERBOARD_URL = "https://baseballsavant.mlb.com/leaderboard/custom";

export const projectionSystems = ["rthebatx", "steamerr", "ratcdc", "zipsdc"] as const;
export type ProjectionSystem = (typeof projectionSystems)[number];

const TEAM_NAME_TO_ABBR: Record<string, string> = {
  "Arizona Diamondbacks": "ARI",
  "Atlanta Braves": "ATL",
  "Baltimore Orioles": "BAL",
  "Boston Red Sox": "BOS",
  "Chicago Cubs": "CHC",
  "Chicago White Sox": "CWS",
  "Cincinnati Reds": "CIN",
  "Cleveland Guardians": "CLE",
  "Colorado Rockies": "COL",
  "Detroit Tigers": "DET",
  "Houston Astros": "HOU",
  "Kansas City Royals": "KC",
  "Los Angeles Angels": "LAA",
  "Los Angeles Dodgers": "LAD",
  "Miami Marlins": "MIA",
  "Milwaukee Brewers": "MIL",
  "Minnesota Twins": "MIN",
  "New York Mets": "NYM",
  "New York Yankees": "NYY",
  "Philadelphia Phillies": "PHI",
  "Pittsburgh Pirates": "PIT",
  "San Diego Padres": "SD",
  "San Francisco Giants": "SF",
  "Seattle Mariners": "SEA",
  "St. Louis Cardinals": "STL",
  "Tampa Bay Rays": "TB",
  "Texas Rangers": "TEX",
  "Toronto Blue Jays": "TOR",
  "Washington Nationals": "WSH",
  // A's relocated to Sutter Health Park (Sacramento) for 2025+; odds feeds vary on the city prefix.
  Athletics: "ATH",
  "Oakland Athletics": "ATH",
  "Sacramento Athletics": "ATH",
};

// Team abbreviations differ across our three external sources — FanGraphs (projection.team:
// CHW/KCR/SDP/SFG/TBR/WSN/ATH), MLB StatsAPI (schedule/lineups: AZ/CWS/KC/SD/SF/TB/WSH/ATH), and
// our internal park-factor / odds convention (ARI/CWS/KC/SD/SF/TB/WSH). They get joined by team
// key (park factors, Vegas implied runs, weekly game counts), so they MUST be normalized to one
// canonical convention or ~8 teams silently fall back to neutral park / no-Vegas / average games.
// Canonical = the park-table convention; `ATH` is the post-relocation Athletics key.
const TEAM_ALIAS: Record<string, string> = {
  AZ: "ARI",
  CHW: "CWS",
  KCR: "KC",
  SDP: "SD",
  SFG: "SF",
  TBR: "TB",
  WSN: "WSH",
  OAK: "ATH",
};

export const canonicalTeam = (abbreviation: string): string =>
  TEAM_ALIAS[abbreviation] ?? abbreviation;

const NumberFromUnknown = Schema.Union([Schema.Finite, Schema.FiniteFromString]);
const OptionalNumberFromUnknown = Schema.optional(NumberFromUnknown);
const StringFromUnknown = Schema.Union([Schema.String, Schema.Finite]).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => String(value)),
    encode: SchemaGetter.transform((value) => value),
  }),
);

const FanGraphsBatterRow = Schema.Struct({
  playerid: StringFromUnknown,
  xMLBAMID: OptionalNumberFromUnknown,
  PlayerName: StringFromUnknown,
  Team: StringFromUnknown,
  PA: NumberFromUnknown,
  R: NumberFromUnknown,
  H: NumberFromUnknown,
  HR: NumberFromUnknown,
  RBI: NumberFromUnknown,
  SB: NumberFromUnknown,
  TB: OptionalNumberFromUnknown,
  "1B": OptionalNumberFromUnknown,
  "2B": OptionalNumberFromUnknown,
  "3B": OptionalNumberFromUnknown,
  OBP: NumberFromUnknown,
  AB: OptionalNumberFromUnknown,
  BB: OptionalNumberFromUnknown,
  HBP: OptionalNumberFromUnknown,
  SF: OptionalNumberFromUnknown,
});

const FanGraphsPitcherRow = Schema.Struct({
  playerid: StringFromUnknown,
  xMLBAMID: OptionalNumberFromUnknown,
  PlayerName: StringFromUnknown,
  Team: StringFromUnknown,
  IP: NumberFromUnknown,
  GS: NumberFromUnknown,
  SO: NumberFromUnknown,
  ERA: NumberFromUnknown,
  WHIP: NumberFromUnknown,
  QS: OptionalNumberFromUnknown,
  SV: OptionalNumberFromUnknown,
  HLD: OptionalNumberFromUnknown,
  G: OptionalNumberFromUnknown,
});

const MlbSchedulePayload = Schema.Struct({
  dates: Schema.Array(
    Schema.Struct({
      games: Schema.Array(
        Schema.Struct({
          gamePk: NumberFromUnknown,
          gameDate: Schema.optional(Schema.String),
          teams: Schema.Struct({
            away: Schema.Struct({
              team: Schema.Struct({ abbreviation: Schema.String }),
              probablePitcher: Schema.optional(
                Schema.Struct({ id: NumberFromUnknown, fullName: Schema.String }),
              ),
            }),
            home: Schema.Struct({
              team: Schema.Struct({ abbreviation: Schema.String }),
              probablePitcher: Schema.optional(
                Schema.Struct({ id: NumberFromUnknown, fullName: Schema.String }),
              ),
            }),
          }),
        }),
      ),
    }),
  ),
});

const OddsOutcome = Schema.Struct({
  name: Schema.String,
  price: OptionalNumberFromUnknown,
  point: OptionalNumberFromUnknown,
});

const OddsPayload = Schema.Array(
  Schema.Struct({
    home_team: Schema.String,
    away_team: Schema.String,
    bookmakers: Schema.Array(
      Schema.Struct({
        markets: Schema.Array(
          Schema.Struct({
            key: Schema.String,
            outcomes: Schema.Array(OddsOutcome),
          }),
        ),
      }),
    ),
  }),
);

const MlbBoxscorePayload = Schema.Struct({
  teams: Schema.Struct({
    away: Schema.Struct({
      team: Schema.Struct({ abbreviation: Schema.String }),
      battingOrder: Schema.optional(Schema.Array(NumberFromUnknown)),
    }),
    home: Schema.Struct({
      team: Schema.Struct({ abbreviation: Schema.String }),
      battingOrder: Schema.optional(Schema.Array(NumberFromUnknown)),
    }),
  }),
});

const savantBatterSelections =
  "pa,xwoba,barrel_batted_rate,hard_hit_percent,avg_hit_speed,k_percent,sprint_speed";
// `pa` ≈ batters faced (TBF) for pitchers; `p_total_pitches` is the pitch count used to stabilize whiff%.
const savantPitcherSelections =
  "pa,p_total_pitches,xwoba,barrel_batted_rate,whiff_percent,k_percent";

export class ProjectionDataError extends Data.TaggedError("ProjectionDataError")<{
  readonly message: string;
  readonly source: string;
  readonly status?: number;
}> {}

const mapHttpError = (source: string, cause: unknown) =>
  new ProjectionDataError({
    message: String(cause),
    source,
    status: HttpClientError.isHttpClientError(cause) ? cause.response?.status : undefined,
  });

const mapCacheError = (source: string, cause: unknown) =>
  cause instanceof ProjectionDataError
    ? cause
    : new ProjectionDataError({ source, message: String(cause) });

const retryPolicy = {
  schedule: Schedule.exponential("100 millis").pipe(
    Schedule.jittered,
    Schedule.both(Schedule.during("2 seconds")),
  ),
  times: 3,
};

const americanToProbability = (odds: number) =>
  odds < 0 ? Math.abs(odds) / (Math.abs(odds) + 100) : 100 / (odds + 100);

const impliedRuns = (gameTotal: number, teamOdds: number, opponentOdds: number) => {
  const teamProbability = americanToProbability(teamOdds);
  const opponentProbability = americanToProbability(opponentOdds);
  return gameTotal * (teamProbability / (teamProbability + opponentProbability));
};

const average = (values: ReadonlyArray<number>) =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;

const fgPlayerKey = (fangraphsId: string) => `fg:${fangraphsId}`;
const mlbPlayerKey = (mlbId: number) => `mlb:${mlbId}`;

const currentSeason = () => new Date().getUTCFullYear();

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

const parseCsv = (text: string) => {
  const parseLine = (line: string) => {
    const values: Array<string> = [];
    let current = "";
    let inQuotes = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      const next = line[index + 1];
      if (char === '"' && inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    values.push(current.trim());
    return values;
  };
  const lines = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0] == null ? [] : parseLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseLine(line);
    const row: Record<string, string> = {};
    for (const [index, header] of headers.entries()) {
      row[header] = (values[index] ?? "").trim();
    }
    return row;
  });
};

const numberFromCsv = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const compactStatcastContext = (context: StatcastPlayerContext) =>
  Object.values(context).some((value) => value != null) ? context : undefined;

// --- F6: park factors — 3-year regressed + handedness HR splits (docs §3.5) ---
//
// Sources: Baseball Savant Statcast park factors (handedness via the batSide filter),
// RotoWire 2024 park factors, and the FanGraphs park-factor methodology. Gathered 2026-06.
//
// Convention: all values are 1.0-CENTERED multipliers (>1 boosts, <1 suppresses), NOT 100-based.
//
// 3-year regression: single-year park factors swing ±8-12 points from sampling noise alone, so
// we regress the deviation from neutral toward 1.0. FanGraphs' guidance: a 3-yr factor is ~20%
// regressed ⇒ regressed = 1 + (raw - 1) * 0.8 (5-yr would use 0.9, 1-yr 0.6). Every value below
// has the 0.8 factor already applied to its raw deviation.
//
// Handedness HR splits (hrFactorLHB / hrFactorRHB, also 1.0-centered + regressed) are set only for
// parks with documented, large L/R asymmetry (COL, CIN, NYY, BOS, SF). All other parks omit the
// split, so the overall `hrFactor` applies to both sides. `runsFactor` has no split (pitchers and
// the run environment face a mix of handedness).
//
// These are research-informed PRIORS: refresh each preseason (park factors shift year to year)
// and fit via the F8 backtest. They are NOT final values.
export const parkFactorsByTeam: Record<string, ParkFactorContext> = {
  ARI: new ParkFactorContext({ runsFactor: 1.008, hrFactor: 0.992 }),
  ATL: new ParkFactorContext({ runsFactor: 1.016, hrFactor: 1.04 }),
  BAL: new ParkFactorContext({ runsFactor: 0.968, hrFactor: 0.936 }),
  // Fenway: runs ~107, HR ~102 overall; Green Monster suppresses LHB HR (97), RHB neutral+ (104).
  BOS: new ParkFactorContext({
    runsFactor: 1.056,
    hrFactor: 1.016,
    hrFactorLHB: 0.976,
    hrFactorRHB: 1.032,
  }),
  CHC: new ParkFactorContext({ runsFactor: 1.008, hrFactor: 1.016 }),
  CWS: new ParkFactorContext({ runsFactor: 0.992, hrFactor: 1.064 }),
  // GABP: runs ~106, HR ~118 overall; LHB porch (122) > RHB (114).
  CIN: new ParkFactorContext({
    runsFactor: 1.048,
    hrFactor: 1.144,
    hrFactorLHB: 1.176,
    hrFactorRHB: 1.112,
  }),
  CLE: new ParkFactorContext({ runsFactor: 0.984, hrFactor: 0.952 }),
  // Coors: runs ~117 (altitude); HR ~112 overall but skewed RHB (113) over LHB (101).
  COL: new ParkFactorContext({
    runsFactor: 1.136,
    hrFactor: 1.096,
    hrFactorLHB: 1.008,
    hrFactorRHB: 1.104,
  }),
  DET: new ParkFactorContext({ runsFactor: 0.976, hrFactor: 0.92 }),
  HOU: new ParkFactorContext({ runsFactor: 1.008, hrFactor: 1.032 }),
  KC: new ParkFactorContext({ runsFactor: 1.016, hrFactor: 0.904 }),
  LAA: new ParkFactorContext({ runsFactor: 0.992, hrFactor: 1 }),
  LAD: new ParkFactorContext({ runsFactor: 1, hrFactor: 1.024 }),
  MIA: new ParkFactorContext({ runsFactor: 0.968, hrFactor: 0.92 }),
  MIL: new ParkFactorContext({ runsFactor: 1.008, hrFactor: 1.056 }),
  MIN: new ParkFactorContext({ runsFactor: 0.992, hrFactor: 1.008 }),
  NYM: new ParkFactorContext({ runsFactor: 0.976, hrFactor: 0.944 }),
  // Yankee Stadium: runs ~neutral; HR ~108 overall, short RF porch favors LHB (115) over RHB (104).
  NYY: new ParkFactorContext({
    runsFactor: 0.996,
    hrFactor: 1.064,
    hrFactorLHB: 1.12,
    hrFactorRHB: 1.032,
  }),
  // Athletics play at Sutter Health Park (Sacramento) for 2025+ — a Triple-A park that has played
  // hitter-friendly (heat, smaller dimensions), the opposite of the old Oakland Coliseum. PROVISIONAL
  // single-year 2025 prior (no 3-yr history yet), lightly regressed; refresh from Savant + fit via F8.
  ATH: new ParkFactorContext({ runsFactor: 1.04, hrFactor: 1.064 }),
  PHI: new ParkFactorContext({ runsFactor: 1.016, hrFactor: 1.064 }),
  PIT: new ParkFactorContext({ runsFactor: 0.984, hrFactor: 0.92 }),
  SD: new ParkFactorContext({ runsFactor: 0.976, hrFactor: 0.928 }),
  SEA: new ParkFactorContext({ runsFactor: 0.968, hrFactor: 0.952 }),
  // Oracle Park: runs ~97, HR ~91 overall; suppresses both sides (LHB 91, RHB 93).
  SF: new ParkFactorContext({
    runsFactor: 0.976,
    hrFactor: 0.928,
    hrFactorLHB: 0.928,
    hrFactorRHB: 0.944,
  }),
  STL: new ParkFactorContext({ runsFactor: 0.992, hrFactor: 0.936 }),
  TB: new ParkFactorContext({ runsFactor: 0.984, hrFactor: 0.976 }),
  TEX: new ParkFactorContext({ runsFactor: 1.016, hrFactor: 1.032 }),
  TOR: new ParkFactorContext({ runsFactor: 1.008, hrFactor: 1.04 }),
  WSH: new ParkFactorContext({ runsFactor: 1, hrFactor: 1.008 }),
};

type OddsEvent = Schema.Schema.Type<typeof OddsPayload>[number];

const decodeFanGraphsRows = <A>(schema: Schema.Decoder<A>, payload: unknown): ReadonlyArray<A> => {
  if (!Array.isArray(payload)) {
    return [];
  }

  const decode = Schema.decodeUnknownOption(schema);
  return payload.flatMap((row) =>
    Option.match(decode(row), {
      onNone: () => [],
      onSome: (decoded) => [decoded],
    }),
  );
};

export class ProjectionData extends Context.Service<
  ProjectionData,
  {
    readonly batterProjections: Effect.Effect<
      ReadonlyArray<BatterProjectionSource>,
      ProjectionDataError
    >;
    readonly pitcherProjections: Effect.Effect<
      ReadonlyArray<PitcherProjectionSource>,
      ProjectionDataError
    >;
    readonly weeklyContext: (
      startDate: string,
      endDate: string,
    ) => Effect.Effect<WeeklyContext, ProjectionDataError>;
  }
>()("fantasy-gm/ProjectionData") {
  static readonly layerLive = Layer.effect(
    ProjectionData,
    Effect.gen(function* () {
      const httpClient = (yield* HttpClient.HttpClient).pipe(
        HttpClient.filterStatusOk,
        HttpClient.retryTransient(retryPolicy),
      );
      const oddsApiKey = yield* Config.redacted("ODDS_API_KEY");
      const maxConfirmedLineupBoxscoresConfig = yield* Config.number(
        "MAX_CONFIRMED_LINEUP_BOXSCORES",
      ).pipe(Config.withDefault(100));
      const maxConfirmedLineupBoxscores = Math.max(
        0,
        Math.floor(maxConfirmedLineupBoxscoresConfig),
      );

      const fetchFanGraphs = <A>(
        system: ProjectionSystem,
        stats: "bat" | "pit",
        schema: Schema.Decoder<A>,
      ) =>
        httpClient
          .get(FANGRAPHS_URL, {
            urlParams: {
              type: system,
              stats,
              pos: "all",
              team: "0",
              players: "0",
              lg: "all",
            },
          })
          .pipe(
            Effect.flatMap((response) => response.json),
            Effect.map((payload) => decodeFanGraphsRows(schema, payload)),
            Effect.mapError((cause) => mapHttpError(`fangraphs:${system}:${stats}`, cause)),
            Effect.withSpan("ProjectionData.fetchFanGraphs", { attributes: { system, stats } }),
          ) as Effect.Effect<ReadonlyArray<A>, ProjectionDataError>;

      const batterProjections = yield* Effect.forEach(
        projectionSystems,
        (system) =>
          fetchFanGraphs(system, "bat", FanGraphsBatterRow).pipe(
            Effect.map((rows) =>
              rows.map(
                (row) =>
                  new BatterProjectionSource({
                    source: system,
                    playerKey: fgPlayerKey(row.playerid),
                    mlbId: row.xMLBAMID,
                    name: row.PlayerName,
                    team: canonicalTeam(row.Team),
                    pa: row.PA,
                    r: row.R,
                    h: row.H,
                    hr: row.HR,
                    rbi: row.RBI,
                    sb: row.SB,
                    tb:
                      row.TB ??
                      (row["1B"] ?? 0) + 2 * (row["2B"] ?? 0) + 3 * (row["3B"] ?? 0) + 4 * row.HR,
                    obp: row.OBP,
                    ab: row.AB,
                    bb: row.BB,
                    hbp: row.HBP,
                    sf: row.SF,
                  }),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((sources) => sources.flat()),
        Effect.cachedWithTTL("20 hours"),
      );

      const pitcherProjections = yield* Effect.forEach(
        projectionSystems,
        (system) =>
          fetchFanGraphs(system, "pit", FanGraphsPitcherRow).pipe(
            Effect.map((rows) =>
              rows.map(
                (row) =>
                  new PitcherProjectionSource({
                    source: system,
                    playerKey: fgPlayerKey(row.playerid),
                    mlbId: row.xMLBAMID,
                    name: row.PlayerName,
                    team: canonicalTeam(row.Team),
                    ip: row.IP,
                    gs: row.GS,
                    k: row.SO,
                    era: row.ERA,
                    whip: row.WHIP,
                    qs: row.QS ?? 0,
                    svh: (row.SV ?? 0) + (row.HLD ?? 0),
                    appearances: row.G,
                  }),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((sources) => sources.flat()),
        Effect.cachedWithTTL("20 hours"),
      );

      const fetchSchedule = (startDate: string, endDate: string) =>
        httpClient
          .get(`${MLB_STATS_URL}/schedule`, {
            urlParams: {
              sportId: "1",
              startDate,
              endDate,
              hydrate: "probablePitcher(note),team",
            },
          })
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(MlbSchedulePayload)),
            Effect.mapError((cause) => mapHttpError("mlb:schedule", cause)),
            Effect.withSpan("ProjectionData.fetchSchedule", {
              attributes: { startDate, endDate },
            }),
          );

      const fetchBoxscore = (gamePk: number) =>
        httpClient.get(`${MLB_STATS_URL}/game/${gamePk}/boxscore`).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(MlbBoxscorePayload)),
          Effect.mapError((cause) => mapHttpError("mlb:boxscore", cause)),
          Effect.withSpan("ProjectionData.fetchBoxscore", {
            attributes: { gamePk },
          }),
        );

      const oddsCache = yield* Cache.make<string, ReadonlyArray<OddsEvent>, ProjectionDataError>({
        capacity: 8,
        timeToLive: "20 hours",
        lookup: () =>
          httpClient
            .pipe(
              HttpClient.mapRequest(
                flow(
                  HttpClientRequest.prependUrl(ODDS_API_URL),
                  HttpClientRequest.acceptJson,
                  HttpClientRequest.setUrlParams({
                    apiKey: Redacted.value(oddsApiKey),
                    regions: "us",
                    markets: "h2h,totals",
                    oddsFormat: "american",
                  }),
                ),
              ),
            )
            .get("")
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(OddsPayload)),
              Effect.mapError((cause) => mapHttpError("odds:mlb", cause)),
              Effect.withSpan("ProjectionData.fetchOdds"),
            ),
      });

      // Odds is a refinement (implied-run context), not a hard input. A failure here — most
      // commonly the-odds-api returning 401 OUT_OF_USAGE_CREDITS once the monthly free quota is
      // spent — must NOT take down weeklyContext (and with it refresh-context/precompute and the
      // whole daily briefing). Degrade to no odds and warn, mirroring fetchStatcastContext /
      // fetchConfirmedLineups. Odds resume automatically once the quota resets or the key is bumped.
      const fetchOdds = (cacheKey: string) =>
        Cache.get(oddsCache, cacheKey).pipe(
          Effect.catch((error) =>
            Effect.logWarning("odds fetch failed; continuing without implied-run context", {
              error: String(error),
            }).pipe(Effect.as<ReadonlyArray<OddsEvent>>([])),
          ),
        );

      const fetchSavantCustom = (
        type: "batter" | "pitcher",
        selections: string,
        sort: string,
        sortDir: "asc" | "desc",
      ) =>
        httpClient
          .get(SAVANT_CUSTOM_LEADERBOARD_URL, {
            urlParams: {
              year: String(currentSeason()),
              type,
              filter: "",
              min: "25",
              selections,
              chart: "false",
              x: "xwoba",
              y: "xwoba",
              r: "no",
              chartType: "beeswarm",
              sort,
              sortDir,
              csv: "true",
            },
          })
          .pipe(
            Effect.flatMap((response) => response.text),
            Effect.map(parseCsv),
            Effect.mapError((cause) => mapHttpError(`savant:${type}`, cause)),
            Effect.withSpan("ProjectionData.fetchSavantCustom", {
              attributes: { type },
            }),
          );

      const statcastCache = yield* Cache.make<
        string,
        Readonly<Record<string, StatcastPlayerContext>>,
        ProjectionDataError
      >({
        capacity: 2,
        timeToLive: "12 hours",
        lookup: () =>
          Effect.all(
            [
              fetchSavantCustom("batter", savantBatterSelections, "xwoba", "desc"),
              fetchSavantCustom("pitcher", savantPitcherSelections, "xwoba", "asc"),
            ],
            { concurrency: 2 },
          ).pipe(
            Effect.map(([batters, pitchers]) => {
              const contexts: Record<string, StatcastPlayerContext> = {};
              for (const row of batters) {
                const playerId = numberFromCsv(row.player_id);
                if (playerId == null) continue;
                const context = compactStatcastContext(
                  new StatcastPlayerContext({
                    pa: numberFromCsv(row.pa),
                    xwoba: numberFromCsv(row.xwoba),
                    barrelPct: numberFromCsv(row.barrel_batted_rate),
                    hardHitPct: numberFromCsv(row.hard_hit_percent),
                    kPct: numberFromCsv(row.k_percent),
                    sprintSpeed: numberFromCsv(row.sprint_speed),
                  }),
                );
                if (context != null) contexts[mlbPlayerKey(playerId)] = context;
              }
              for (const row of pitchers) {
                const playerId = numberFromCsv(row.player_id);
                if (playerId == null) continue;
                const context = compactStatcastContext(
                  new StatcastPlayerContext({
                    pa: numberFromCsv(row.pa),
                    pitches: numberFromCsv(row.p_total_pitches),
                    xwoba: numberFromCsv(row.xwoba),
                    barrelPct: numberFromCsv(row.barrel_batted_rate),
                    whiffPct: numberFromCsv(row.whiff_percent),
                    kPct: numberFromCsv(row.k_percent),
                  }),
                );
                if (context != null) contexts[mlbPlayerKey(playerId)] = context;
              }
              return contexts;
            }),
          ),
      });

      const fetchStatcastContext = () =>
        Cache.get(statcastCache, "current").pipe(Effect.orElseSucceed(() => ({})));

      const fetchConfirmedLineups = (gamePks: ReadonlyArray<number>) =>
        Effect.forEach(
          gamePks,
          (gamePk) =>
            fetchBoxscore(gamePk).pipe(
              Effect.map((boxscore) => [boxscore] as const),
              Effect.orElseSucceed(() => [] as const),
            ),
          { concurrency: 4 },
        ).pipe(Effect.map((results) => results.flat()));

      const weeklyContext = Effect.fn("ProjectionData.weeklyContext")(function* (
        startDate: string,
        endDate: string,
      ) {
        const nowMs = Date.now();
        const [schedule, odds, statcastByPlayerKey] = yield* Effect.all(
          [
            fetchSchedule(startDate, endDate),
            fetchOdds(`${startDate}:${endDate}`),
            fetchStatcastContext(),
          ],
          { concurrency: 3 },
        );

        const teamGames = new Map<string, number>();
        const teamRemainingGames = new Map<string, number>();
        const dailyWindows = new Map<
          string,
          { games: number; remainingGames: number; firstGameMs?: number; lastGameMs?: number }
        >();
        const probableStartsByPlayerKey: Record<string, number> = {};
        const probablePitcherStarts: Array<ProbablePitcherStart> = [];
        const gamePks: Array<number> = [];
        for (const date of schedule.dates) {
          for (const game of date.games) {
            gamePks.push(game.gamePk);
            const away = game.teams.away;
            const home = game.teams.home;
            const awayTeam = canonicalTeam(away.team.abbreviation);
            const homeTeam = canonicalTeam(home.team.abbreviation);
            const gameStartMs = game.gameDate == null ? undefined : Date.parse(game.gameDate);
            const finiteGameStartMs =
              gameStartMs != null && Number.isFinite(gameStartMs) ? gameStartMs : undefined;
            const isRemaining = finiteGameStartMs == null || finiteGameStartMs > nowMs;
            const gameDateKey =
              finiteGameStartMs == null ? undefined : easternDateKey(new Date(finiteGameStartMs));
            if (gameDateKey != null && finiteGameStartMs != null) {
              const window = dailyWindows.get(gameDateKey) ?? { games: 0, remainingGames: 0 };
              window.games += 1;
              if (isRemaining) window.remainingGames += 1;
              window.firstGameMs =
                window.firstGameMs == null
                  ? finiteGameStartMs
                  : Math.min(window.firstGameMs, finiteGameStartMs);
              window.lastGameMs =
                window.lastGameMs == null
                  ? finiteGameStartMs
                  : Math.max(window.lastGameMs, finiteGameStartMs);
              dailyWindows.set(gameDateKey, window);
            }
            teamGames.set(awayTeam, (teamGames.get(awayTeam) ?? 0) + 1);
            teamGames.set(homeTeam, (teamGames.get(homeTeam) ?? 0) + 1);
            if (isRemaining) {
              teamRemainingGames.set(awayTeam, (teamRemainingGames.get(awayTeam) ?? 0) + 1);
              teamRemainingGames.set(homeTeam, (teamRemainingGames.get(homeTeam) ?? 0) + 1);
            }
            if (isRemaining && away.probablePitcher != null) {
              const playerKey = `mlb:${away.probablePitcher.id}`;
              probableStartsByPlayerKey[playerKey] =
                (probableStartsByPlayerKey[playerKey] ?? 0) + 1;
              probablePitcherStarts.push(
                new ProbablePitcherStart({
                  playerKey,
                  playerName: away.probablePitcher.fullName,
                  team: awayTeam,
                  opponentTeam: homeTeam,
                  date: gameDateKey ?? startDate,
                  gameTime:
                    finiteGameStartMs == null
                      ? undefined
                      : new Date(finiteGameStartMs).toISOString(),
                  homeAway: "away",
                }),
              );
            }
            if (isRemaining && home.probablePitcher != null) {
              const playerKey = `mlb:${home.probablePitcher.id}`;
              probableStartsByPlayerKey[playerKey] =
                (probableStartsByPlayerKey[playerKey] ?? 0) + 1;
              probablePitcherStarts.push(
                new ProbablePitcherStart({
                  playerKey,
                  playerName: home.probablePitcher.fullName,
                  team: homeTeam,
                  opponentTeam: awayTeam,
                  date: gameDateKey ?? startDate,
                  gameTime:
                    finiteGameStartMs == null
                      ? undefined
                      : new Date(finiteGameStartMs).toISOString(),
                  homeAway: "home",
                }),
              );
            }
          }
        }

        const boxscores = yield* fetchConfirmedLineups(
          gamePks.slice(0, maxConfirmedLineupBoxscores),
        );
        const confirmedLineupsByTeam: Record<string, number> = {};
        const battingOrdersByPlayerKey: Record<string, BattingOrderContext> = {};
        for (const boxscore of boxscores) {
          for (const side of [boxscore.teams.away, boxscore.teams.home]) {
            const battingOrder = side.battingOrder ?? [];
            if (battingOrder.length === 0) continue;
            const team = canonicalTeam(side.team.abbreviation);
            confirmedLineupsByTeam[team] = (confirmedLineupsByTeam[team] ?? 0) + 1;
            for (const [index, mlbId] of battingOrder.entries()) {
              const playerKey = mlbPlayerKey(mlbId);
              const existing = battingOrdersByPlayerKey[playerKey];
              battingOrdersByPlayerKey[playerKey] = new BattingOrderContext({
                confirmedStarts: (existing?.confirmedStarts ?? 0) + 1,
                battingOrderSum: (existing?.battingOrderSum ?? 0) + index + 1,
              });
            }
          }
        }

        const impliedRunsByTeam: Record<string, number> = {};
        for (const event of odds) {
          const homeAbbr = TEAM_NAME_TO_ABBR[event.home_team];
          const awayAbbr = TEAM_NAME_TO_ABBR[event.away_team];
          const moneylineHome: Array<number> = [];
          const moneylineAway: Array<number> = [];
          const totals: Array<number> = [];

          for (const bookmaker of event.bookmakers) {
            for (const market of bookmaker.markets) {
              if (market.key === "h2h") {
                const homeOutcome = market.outcomes.find(
                  (outcome) => outcome.name === event.home_team,
                );
                const awayOutcome = market.outcomes.find(
                  (outcome) => outcome.name === event.away_team,
                );
                if (homeOutcome?.price != null && awayOutcome?.price != null) {
                  moneylineHome.push(homeOutcome.price);
                  moneylineAway.push(awayOutcome.price);
                }
              }
              if (market.key === "totals") {
                const over = market.outcomes.find((outcome) => outcome.name === "Over");
                if (over?.point != null) totals.push(over.point);
              }
            }
          }

          const homeOdds = average(moneylineHome);
          const awayOdds = average(moneylineAway);
          const total = average(totals);
          if (
            homeAbbr == null ||
            awayAbbr == null ||
            homeOdds == null ||
            awayOdds == null ||
            total == null
          ) {
            continue;
          }
          impliedRunsByTeam[homeAbbr] = impliedRuns(total, homeOdds, awayOdds);
          impliedRunsByTeam[awayAbbr] = impliedRuns(total, awayOdds, homeOdds);
        }

        return new WeeklyContext({
          schedules: [...teamGames.entries()].map(
            ([team, games]) =>
              new WeeklySchedule({
                team,
                gamesThisWeek: games,
                gamesRemaining: teamRemainingGames.get(team) ?? 0,
              }),
          ),
          dailyGameWindows: [...dailyWindows.entries()]
            .map(
              ([date, window]) =>
                new DailyGameWindow({
                  date,
                  games: window.games,
                  remainingGames: window.remainingGames,
                  firstGameTime:
                    window.firstGameMs == null
                      ? undefined
                      : new Date(window.firstGameMs).toISOString(),
                  lastGameTime:
                    window.lastGameMs == null
                      ? undefined
                      : new Date(window.lastGameMs).toISOString(),
                }),
            )
            .sort((a, b) => a.date.localeCompare(b.date)),
          probableStartsByPlayerKey,
          probablePitcherStarts: probablePitcherStarts.sort(
            (a, b) =>
              a.date.localeCompare(b.date) ||
              (a.gameTime ?? "").localeCompare(b.gameTime ?? "") ||
              a.playerName.localeCompare(b.playerName),
          ),
          impliedRunsByTeam,
          statcastByPlayerKey,
          parkFactorsByTeam,
          confirmedLineupsByTeam,
          battingOrdersByPlayerKey,
        });
      });

      return ProjectionData.of({
        batterProjections,
        pitcherProjections,
        weeklyContext,
      });
    }),
  );

  static readonly layerCached = Layer.effect(
    ProjectionData,
    Effect.gen(function* () {
      const source = yield* ProjectionData;
      const cache = yield* ApiCache;
      const season = currentSeason();
      const maxConfirmedLineupBoxscores = yield* Config.number(
        "MAX_CONFIRMED_LINEUP_BOXSCORES",
      ).pipe(Config.withDefault(100));
      const boxscoreCap = Math.max(0, Math.floor(maxConfirmedLineupBoxscores));
      const projectionsTtlMs = 20 * 60 * 60 * 1000;
      const contextTtlMs = 90 * 60 * 1000;
      const batterSchema = Schema.Array(BatterProjectionSource);
      const pitcherSchema = Schema.Array(PitcherProjectionSource);
      const contextSchema = WeeklyContext;

      return ProjectionData.of({
        batterProjections: cache
          .getOrRefreshTyped(
            `projection-data:batter:${season}:v1`,
            batterSchema,
            projectionsTtlMs,
            source.batterProjections,
          )
          .pipe(Effect.mapError((error) => mapCacheError("cache:batter-projections", error))),
        pitcherProjections: cache
          .getOrRefreshTyped(
            `projection-data:pitcher:${season}:v1`,
            pitcherSchema,
            projectionsTtlMs,
            source.pitcherProjections,
          )
          .pipe(Effect.mapError((error) => mapCacheError("cache:pitcher-projections", error))),
        weeklyContext: (startDate, endDate) =>
          cache
            .getOrRefreshTyped(
              `projection-data:weekly-context:${startDate}:${endDate}:boxscores:${boxscoreCap}:v3`,
              contextSchema,
              contextTtlMs,
              source.weeklyContext(startDate, endDate),
            )
            .pipe(Effect.mapError((error) => mapCacheError("cache:weekly-context", error))),
      });
    }),
  );
}
