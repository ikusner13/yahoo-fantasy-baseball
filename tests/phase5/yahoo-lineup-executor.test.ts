import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import {
  DailyLineupAdvisor,
  DailyLineupIlMove,
  DailyLineupPlayer,
  DailyLineupReplacementMove,
  DailyLineupReport,
} from "../../src/services/DailyLineupAdvisor";
import {
  YahooClient,
  type YahooRosterPayload,
  type YahooRosterPositionMove,
} from "../../src/services/YahooClient";
import {
  buildYahooLineupExecutionMoves,
  YahooLineupExecutor,
} from "../../src/services/YahooLineupExecutor";

const rosterPayload = {
  fantasy_content: {
    team: [
      {},
      {
        roster: {
          "0": {
            players: [
              {
                player: [
                  {
                    playerKey: "mlb.p.1",
                    playerId: "1",
                    name: "Active Catcher",
                    team: "NYY",
                    eligiblePositions: ["C"],
                  },
                  { position: "C" },
                ],
              },
              {
                player: [
                  {
                    playerKey: "mlb.p.2",
                    playerId: "2",
                    name: "Bench Pitcher",
                    team: "SEA",
                    eligiblePositions: ["SP", "P"],
                  },
                  { position: "BN" },
                ],
              },
            ],
          },
          coverage_type: "date",
          date: "2026-06-07",
          is_prescoring: 1,
          is_editable: 1,
        },
      },
    ],
  },
} as unknown as YahooRosterPayload;

describe("YahooLineupExecutor Phase 5", () => {
  it("builds safe internal Yahoo position moves from the daily lineup report", () => {
    const moves = buildYahooLineupExecutionMoves(
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "injured",
            playerId: "1",
            name: "Injured Starter",
            team: "NYM",
            eligiblePositions: ["SP", "IL"],
            selectedPosition: "P",
            status: "IL15",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [
          new DailyLineupIlMove({
            playerKey: "injured",
            playerName: "Injured Starter",
            from: "P",
            to: "IL",
            status: "IL15",
          }),
        ],
        blockedIlMoves: 0,
        replacementOptions: [
          new DailyLineupReplacementMove({
            outPlayerKey: "injured",
            outPlayerName: "Injured Starter",
            outPlayerStatus: "IL15",
            slot: "P",
            replacementPlayerKey: "bench-pitcher",
            replacementPlayerName: "Bench Pitcher",
            currentPosition: "BN",
          }),
        ],
        fillableOpenSlots: [
          {
            slot: "P",
            playerKey: "bench-pitcher",
            playerName: "Bench Pitcher",
            currentPosition: "BN",
          },
        ],
        guardrails: [],
      }),
    );

    expect(moves.map((move) => `${move.playerName}:${move.from}->${move.to}`)).toEqual([
      "Injured Starter:P->IL",
      "Bench Pitcher:BN->P",
    ]);
  });

  it("verifies write access with a no-op roster position write", async () => {
    const writes: Array<ReadonlyArray<YahooRosterPositionMove>> = [];
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* YahooLineupExecutor;
        return yield* executor.verifyWriteAccessForDate("2026-06-07");
      }).pipe(
        Effect.provide(
          YahooLineupExecutor.layerLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(
                  YahooClient,
                  YahooClient.of({
                    config: { leagueId: "62744", teamId: "12" },
                    getLeagueSettings: Effect.die("unused"),
                    getTeamMetadata: Effect.die("unused"),
                    getRoster: Effect.succeed(rosterPayload),
                    getRosterForDate: () => Effect.succeed(rosterPayload),
                    getRosterForTeam: () => Effect.die("unused"),
                    getAvailablePlayers: () => Effect.die("unused"),
                    getLeagueTransactions: () => Effect.die("unused"),
                    getCurrentMatchup: Effect.die("unused"),
                    getLeagueStandings: Effect.die("unused"),
                    putRosterPositions: (_date, moves) =>
                      Effect.sync(() => {
                        writes.push(moves);
                      }),
                  }),
                ),
                Layer.succeed(
                  DailyLineupAdvisor,
                  DailyLineupAdvisor.of({
                    forDate: () => Effect.die("unused"),
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    );

    expect(report).toMatchObject({
      date: "2026-06-07",
      attempted: true,
      verified: true,
      playersWritten: 2,
    });
    expect(writes).toEqual([
      [
        { playerKey: "mlb.p.1", position: "C" },
        { playerKey: "mlb.p.2", position: "BN" },
      ],
    ]);
  });
});
