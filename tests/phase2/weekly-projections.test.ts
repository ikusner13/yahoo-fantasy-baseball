import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "@effect/vitest";

import {
  LeagueState,
  LeagueStatePlayer,
  LeagueStateSnapshot,
} from "../../src/services/LeagueState";
import { makePlayerIdentityTest, PlayerIdentityRow } from "../../src/services/PlayerIdentity";
import { ProjectionData } from "../../src/services/ProjectionData";
import {
  BatterProjectionSource,
  PitcherProjectionSource,
  WeeklyContext,
  WeeklySchedule,
} from "../../src/services/ProjectionModel";
import { WeeklyProjections } from "../../src/services/WeeklyProjections";
import {
  YahooClient,
  type YahooPlayersPayload,
  type YahooRosterPayload,
} from "../../src/services/YahooClient";

const yahooPlayer = (playerKey: string, name: string, team: string) => ({
  player: [
    {
      playerKey,
      playerId: playerKey.replace("mlb.p.", ""),
      name,
      team,
      eligiblePositions: ["Util"],
    },
  ],
});

const rosterPayload = (players: ReadonlyArray<ReturnType<typeof yahooPlayer>>) =>
  ({
    fantasy_content: {
      team: [
        {},
        {
          roster: {
            "0": {
              players,
            },
            coverage_type: "date",
            date: "2026-06-06",
            is_prescoring: 0,
            is_editable: 1,
          },
        },
      ],
    },
  }) as unknown as YahooRosterPayload;

const freeAgentPayload = (players: ReadonlyArray<ReturnType<typeof yahooPlayer>>) =>
  ({
    fantasy_content: {
      league: [
        {},
        {
          players,
        },
      ],
    },
  }) as unknown as YahooPlayersPayload;

const snapshot = new LeagueStateSnapshot({
  leagueId: "62744",
  teamId: "12",
  scoringFormat: "cumulative-category-h2h",
  scoringCategories: ["R", "HR", "OBP", "OUT", "K", "ERA", "WHIP", "QS", "SV+H"],
  weeklyAddLimit: 6,
  addsUsed: 0,
  roster: [
    new LeagueStatePlayer({
      playerKey: "mlb.p.1",
      name: "Ada Batter",
      team: "NYY",
      eligiblePositions: ["Util"],
      selectedPosition: "Util",
    }),
  ],
  rosterSlots: [],
  emptySlots: [],
  ilUsed: 0,
  ilSlots: 0,
  matchup: {
    week: 11,
    weekStart: "2026-06-01",
    weekEnd: "2026-06-07",
    opponentTeamKey: "mlb.l.62744.t.3",
    opponentTeamName: "Opponent",
    categories: [],
  },
});

const identityStore = new Map<string, PlayerIdentityRow>();
let freeAgentName = "Free Agent";

const testLayer = WeeklyProjections.layerLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        LeagueState,
        LeagueState.of({
          snapshot: Effect.succeed(snapshot),
        }),
      ),
      Layer.succeed(
        YahooClient,
        YahooClient.of({
          config: { leagueId: "62744", teamId: "12" },
          getLeagueSettings: Effect.die("unused"),
          getTeamMetadata: Effect.die("unused"),
          getRoster: Effect.die("unused"),
          getRosterForDate: () => Effect.die("unused"),
          getCurrentMatchup: Effect.die("unused"),
          getMatchupForWeek: () => Effect.die("unused"),
          getLeagueStandings: Effect.die("unused"),
          getRosterForTeam: () =>
            Effect.succeed(rosterPayload([yahooPlayer("mlb.p.2", "Grace Starter", "SEA")])),
          getAvailablePlayers: () =>
            Effect.succeed(freeAgentPayload([yahooPlayer("mlb.p.3", freeAgentName, "LAD")])),
          getLeagueTransactions: () => Effect.die("unused"),
          putRosterPositions: () => Effect.die("unused"),
        }),
      ),
      Layer.succeed(
        ProjectionData,
        ProjectionData.of({
          batterProjections: Effect.succeed([
            new BatterProjectionSource({
              source: "rthebatx",
              playerKey: "fg:101",
              mlbId: 101,
              name: "Ada Batter",
              team: "NYY",
              pa: 100,
              r: 20,
              h: 30,
              hr: 10,
              rbi: 25,
              sb: 5,
              tb: 70,
              obp: 0.4,
              ab: 80,
              bb: 15,
              hbp: 2,
              sf: 3,
            }),
            new BatterProjectionSource({
              source: "rthebatx",
              playerKey: "fg:303",
              mlbId: 303,
              name: "Free Agent",
              team: "LAD",
              pa: 100,
              r: 15,
              h: 25,
              hr: 6,
              rbi: 18,
              sb: 3,
              tb: 50,
              obp: 0.36,
              ab: 82,
              bb: 13,
              hbp: 2,
              sf: 3,
            }),
          ]),
          pitcherProjections: Effect.succeed([
            new PitcherProjectionSource({
              source: "ratcdc",
              playerKey: "fg:202",
              mlbId: 202,
              name: "Grace Starter",
              team: "SEA",
              ip: 120,
              gs: 20,
              k: 140,
              era: 3,
              whip: 1.1,
              qs: 12,
              svh: 0,
              appearances: 20,
            }),
          ]),
          weeklyContext: () =>
            Effect.succeed(
              new WeeklyContext({
                schedules: [
                  new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 }),
                  new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 }),
                  new WeeklySchedule({ team: "LAD", gamesThisWeek: 7, gamesRemaining: 7 }),
                ],
                probableStartsByPlayerKey: { "mlb:202": 2 },
                impliedRunsByTeam: { LAD: 5.4 },
              }),
            ),
        }),
      ),
      makePlayerIdentityTest(identityStore),
    ),
  ),
);

describe("WeeklyProjections", () => {
  it.effect("builds Phase 2 weekly lines for our roster, opponent, and free agents", () =>
    Effect.gen(function* () {
      identityStore.clear();
      freeAgentName = "Free Agent";
      const weeklyProjections = yield* WeeklyProjections;

      const set = yield* weeklyProjections.currentMatchup;

      expect(set.myRoster).toHaveLength(1);
      expect(set.myRoster[0]).toMatchObject({ playerKey: "mlb.p.1", kind: "batter" });
      expect(set.opponentRoster).toHaveLength(1);
      expect(set.opponentRoster[0]).toMatchObject({
        playerKey: "mlb.p.2",
        kind: "pitcher",
        ip: 12,
        out: 36,
      });
      expect(set.freeAgents).toHaveLength(1);
      expect(set.freeAgents[0]).toMatchObject({ playerKey: "mlb.p.3", kind: "batter" });

      expect(identityStore.get("mlb.p.1")).toMatchObject({
        yahooId: "mlb.p.1",
        fangraphsId: 101,
        fangraphsKey: "101",
        mlbId: 101,
      });
      expect(identityStore.get("mlb.p.2")).toMatchObject({
        yahooId: "mlb.p.2",
        fangraphsId: 202,
        fangraphsKey: "202",
        mlbId: 202,
      });
      expect(identityStore.get("mlb.p.3")).toMatchObject({
        yahooId: "mlb.p.3",
        fangraphsId: 303,
        fangraphsKey: "303",
        mlbId: 303,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("prefers saved ids over name matching", () => {
    identityStore.clear();
    freeAgentName = "Renamed Free Agent";
    identityStore.set(
      "mlb.p.3",
      new PlayerIdentityRow({
        yahooId: "mlb.p.3",
        fangraphsId: 303,
        fangraphsKey: "303",
        mlbId: 303,
        name: "Renamed Free Agent",
        team: "LAD",
      }),
    );

    return Effect.gen(function* () {
      const weeklyProjections = yield* WeeklyProjections;

      const set = yield* weeklyProjections.currentMatchup;

      expect(set.freeAgents).toHaveLength(1);
      expect(set.freeAgents[0]).toMatchObject({ playerKey: "mlb.p.3", kind: "batter" });
    }).pipe(Effect.provide(testLayer));
  });
});
