import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";

import { LeagueState, type LeagueStatePlayer } from "./LeagueState.ts";
import { PlayerIdentity, PlayerIdentityRow } from "./PlayerIdentity.ts";
import { ProjectionData } from "./ProjectionData.ts";
import {
  BatterProjectionSource,
  buildWeeklyProjectionSet,
  PitcherProjectionSource,
  ProbablePitcherStart,
  ProjectionPool,
  WeeklyContext,
  WeeklyProjectionSet,
} from "./ProjectionModel.ts";
import { YahooClient, type YahooPlayersPayload, type YahooRosterPayload } from "./YahooClient.ts";

const DEFAULT_FREE_AGENT_COUNT = 200;

export class WeeklyProjectionsError extends Data.TaggedError("WeeklyProjectionsError")<{
  readonly message: string;
}> {}

type YahooProjectionPlayer = {
  readonly playerKey: string;
  readonly name: string;
  readonly team: string;
  readonly positions?: ReadonlyArray<string>;
  readonly selectedPosition?: string;
  readonly status?: string;
};

export const isUnavailableFreeAgentStatus = (status: string | undefined) =>
  status != null && (status.startsWith("IL") || ["NA", "O", "SUSP"].includes(status));

const normalizeName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();

const identityKey = (player: { readonly name: string; readonly team: string }) =>
  `${normalizeName(player.name)}:${player.team.toUpperCase()}`;

const rosterPlayers = (payload: YahooRosterPayload): ReadonlyArray<YahooProjectionPlayer> =>
  payload.fantasy_content.team[1].roster["0"].players.map((entry) => {
    const [player, selectedPosition] = entry.player;
    return {
      playerKey: player.playerKey,
      name: player.name,
      team: player.team,
      positions: player.eligiblePositions,
      selectedPosition: selectedPosition?.position,
      status: player.status,
    };
  });

const availablePlayers = (payload: YahooPlayersPayload): ReadonlyArray<YahooProjectionPlayer> =>
  payload.fantasy_content.league[1].players
    .map((entry) => {
      const [player] = entry.player;
      return {
        playerKey: player.playerKey,
        name: player.name,
        team: player.team,
        positions: player.eligiblePositions,
        status: player.status,
      };
    })
    .filter((player) => !isUnavailableFreeAgentStatus(player.status));

const snapshotPlayers = (
  players: ReadonlyArray<LeagueStatePlayer>,
): ReadonlyArray<YahooProjectionPlayer> =>
  players.map((player) => ({
    playerKey: player.playerKey,
    name: player.name,
    team: player.team,
    positions: player.eligiblePositions,
    selectedPosition: player.selectedPosition,
    status: player.status,
  }));

const canonicalizeBatters = (
  rows: ReadonlyArray<BatterProjectionSource>,
  playersByIdentity: ReadonlyMap<string, YahooProjectionPlayer>,
  playersByFangraphsKey: ReadonlyMap<string, YahooProjectionPlayer>,
) => {
  const identityRows: Array<PlayerIdentityRow> = [];
  const canonicalRows = rows.flatMap((row) => {
    const fangraphsKey = row.playerKey.replace("fg:", "");
    const fangraphsId = Number(fangraphsKey);
    const player =
      playersByFangraphsKey.get(fangraphsKey) ?? playersByIdentity.get(identityKey(row));
    if (player == null) return [];
    identityRows.push(
      new PlayerIdentityRow({
        yahooId: player.playerKey,
        mlbId: row.mlbId,
        fangraphsId: Number.isFinite(fangraphsId) ? fangraphsId : undefined,
        fangraphsKey,
        name: player.name,
        positions: player.positions?.join(","),
        team: player.team,
      }),
    );
    return [
      new BatterProjectionSource({
        source: row.source,
        playerKey: player.playerKey,
        mlbId: row.mlbId,
        name: player.name,
        team: player.team,
        pa: row.pa,
        r: row.r,
        h: row.h,
        hr: row.hr,
        rbi: row.rbi,
        sb: row.sb,
        tb: row.tb,
        obp: row.obp,
        ab: row.ab,
        bb: row.bb,
        hbp: row.hbp,
        sf: row.sf,
        status: player.status,
        // F6 handedness HR park split. Undefined today (no upstream batSide source); a neutral
        // default ⇒ overall park factor. Wiring MLB Stats /people/{id} batSide is a follow-up.
        bats: row.bats,
        eligiblePositions: player.positions == null ? undefined : [...player.positions],
        selectedPosition: player.selectedPosition,
      }),
    ];
  });
  return { canonicalRows, identityRows };
};

const canonicalizePitchers = (
  rows: ReadonlyArray<PitcherProjectionSource>,
  playersByIdentity: ReadonlyMap<string, YahooProjectionPlayer>,
  playersByFangraphsKey: ReadonlyMap<string, YahooProjectionPlayer>,
) => {
  const identityRows: Array<PlayerIdentityRow> = [];
  const canonicalRows = rows.flatMap((row) => {
    const fangraphsKey = row.playerKey.replace("fg:", "");
    const fangraphsId = Number(fangraphsKey);
    const player =
      playersByFangraphsKey.get(fangraphsKey) ?? playersByIdentity.get(identityKey(row));
    if (player == null) return [];
    identityRows.push(
      new PlayerIdentityRow({
        yahooId: player.playerKey,
        mlbId: row.mlbId,
        fangraphsId: Number.isFinite(fangraphsId) ? fangraphsId : undefined,
        fangraphsKey,
        name: player.name,
        positions: player.positions?.join(","),
        team: player.team,
      }),
    );
    return [
      new PitcherProjectionSource({
        source: row.source,
        playerKey: player.playerKey,
        mlbId: row.mlbId,
        name: player.name,
        team: player.team,
        ip: row.ip,
        gs: row.gs,
        k: row.k,
        era: row.era,
        whip: row.whip,
        qs: row.qs,
        svh: row.svh,
        appearances: row.appearances,
        status: player.status,
        eligiblePositions: player.positions == null ? undefined : [...player.positions],
        selectedPosition: player.selectedPosition,
      }),
    ];
  });
  return { canonicalRows, identityRows };
};

const remapProbableStarts = (
  context: WeeklyContext,
  pitchers: ReadonlyArray<PitcherProjectionSource>,
) => {
  const probableStartsByPlayerKey = { ...context.probableStartsByPlayerKey };
  const probablePitcherStarts = [...(context.probablePitcherStarts ?? [])];
  for (const pitcher of pitchers) {
    if (pitcher.mlbId == null) continue;
    const mlbKey = `mlb:${pitcher.mlbId}`;
    const starts = context.probableStartsByPlayerKey[mlbKey];
    if (starts != null) probableStartsByPlayerKey[pitcher.playerKey] = starts;
    for (const start of context.probablePitcherStarts?.filter(
      (entry) => entry.playerKey === mlbKey,
    ) ?? []) {
      probablePitcherStarts.push(
        new ProbablePitcherStart({
          playerKey: pitcher.playerKey,
          playerName: pitcher.name,
          team: start.team,
          opponentTeam: start.opponentTeam,
          date: start.date,
          gameTime: start.gameTime,
          homeAway: start.homeAway,
        }),
      );
    }
  }
  return new WeeklyContext({
    schedules: context.schedules,
    dailyGameWindows: context.dailyGameWindows,
    probableStartsByPlayerKey,
    probablePitcherStarts,
    impliedRunsByTeam: context.impliedRunsByTeam,
    statcastByPlayerKey: context.statcastByPlayerKey,
    parkFactorsByTeam: context.parkFactorsByTeam,
    confirmedLineupsByTeam: context.confirmedLineupsByTeam,
    battingOrdersByPlayerKey: context.battingOrdersByPlayerKey,
  });
};

const mapError = (error: unknown) => {
  const tagged = error as { readonly _tag?: string; readonly message?: string };
  return new WeeklyProjectionsError({
    message: `${tagged._tag ?? "ConfigError"}: ${tagged.message ?? String(error)}`,
  });
};

export class WeeklyProjections extends Context.Service<
  WeeklyProjections,
  {
    readonly currentMatchup: Effect.Effect<WeeklyProjectionSet, WeeklyProjectionsError, never>;
  }
>()("fantasy-gm/WeeklyProjections") {
  static readonly layerLive = Layer.effect(
    WeeklyProjections,
    Effect.gen(function* () {
      const leagueState = yield* LeagueState;
      const yahoo = yield* YahooClient;
      const projectionData = yield* ProjectionData;
      const playerIdentity = yield* PlayerIdentity;

      // Worker isolates can live for days; TTL avoids memoizing transient upstream failures forever.
      const currentMatchup = yield* Effect.cachedWithTTL(
        Effect.gen(function* () {
          const freeAgentCount = yield* Config.number("FREE_AGENT_COUNT").pipe(
            Config.withDefault(DEFAULT_FREE_AGENT_COUNT),
          );
          const snapshot = yield* leagueState.snapshot;
          const [opponentRosterPayload, freeAgentPayload, batters, pitchers, context] =
            yield* Effect.all(
              [
                yahoo.getRosterForTeam(snapshot.matchup.opponentTeamKey),
                yahoo.getAvailablePlayers(freeAgentCount),
                projectionData.batterProjections,
                projectionData.pitcherProjections,
                projectionData.weeklyContext(snapshot.matchup.weekStart, snapshot.matchup.weekEnd),
              ],
              { concurrency: 3 },
            );

          const myRoster = snapshotPlayers(snapshot.roster);
          const opponentRoster = rosterPlayers(opponentRosterPayload);
          const freeAgents = availablePlayers(freeAgentPayload);
          const allPlayers = [...myRoster, ...opponentRoster, ...freeAgents];
          const playersByIdentity = new Map(
            allPlayers.map((player) => [identityKey(player), player]),
          );
          const savedIdentities = yield* playerIdentity.findByYahooIds(
            allPlayers.map((player) => player.playerKey),
          );
          const playersByFangraphsKey = new Map(
            allPlayers.flatMap((player) => {
              const saved = savedIdentities.get(player.playerKey);
              const fangraphsKey = saved?.fangraphsKey ?? saved?.fangraphsId?.toString();
              return fangraphsKey == null ? [] : [[fangraphsKey, player] as const];
            }),
          );
          const canonicalBatters = canonicalizeBatters(
            batters,
            playersByIdentity,
            playersByFangraphsKey,
          );
          const canonicalPitchers = canonicalizePitchers(
            pitchers,
            playersByIdentity,
            playersByFangraphsKey,
          );
          const canonicalContext = remapProbableStarts(context, canonicalPitchers.canonicalRows);

          yield* playerIdentity.upsertMany([
            ...canonicalBatters.identityRows,
            ...canonicalPitchers.identityRows,
          ]);

          return buildWeeklyProjectionSet(
            new ProjectionPool({
              myRoster: myRoster.map((player) => player.playerKey),
              opponentRoster: opponentRoster.map((player) => player.playerKey),
              freeAgents: freeAgents.map((player) => player.playerKey),
              batters: canonicalBatters.canonicalRows,
              pitchers: canonicalPitchers.canonicalRows,
            }),
            canonicalContext,
          );
        }).pipe(Effect.mapError(mapError)),
        "45 minutes",
      );

      return WeeklyProjections.of({ currentMatchup });
    }),
  );
}
