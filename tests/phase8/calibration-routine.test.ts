import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import {
  CategoryPrediction,
  WeeklyRetrospective,
  isClosedOut,
  makeCalibrationHarnessTest,
} from "../../src/services/CalibrationHarness";
import { LeagueState, type LeagueStateSnapshot } from "../../src/services/LeagueState";
import { YahooClient } from "../../src/services/YahooClient";
import { closeOutPreviousWeek } from "../../src/routines/calibration";

// R → stat_id 7, ERA → stat_id 26 (ERA is lower-is-better).
const settingsPayload = {
  fantasy_content: {
    league: [
      {},
      {
        settings: [
          {
            stat_categories: {
              stats: [
                { stat: { stat_id: "7", name: "Runs", display_name: "R" } },
                { stat: { stat_id: "26", name: "Earned Run Average", display_name: "ERA" } },
              ],
            },
          },
        ],
      },
    ],
  },
};

const matchupPayload = (week: number) => ({
  fantasy_content: {
    team: [
      {},
      {
        matchups: {
          "0": {
            matchup: {
              week,
              week_start: "2026-06-01",
              week_end: "2026-06-07",
              "0": {
                teams: {
                  "0": {
                    team: [
                      {},
                      {
                        team_stats: {
                          stats: [
                            { stat: { stat_id: "7", value: "30" } }, // my R
                            { stat: { stat_id: "26", value: "3.50" } }, // my ERA
                          ],
                        },
                      },
                    ],
                  },
                  "1": {
                    team: [
                      {},
                      {
                        team_stats: {
                          stats: [
                            { stat: { stat_id: "7", value: "25" } }, // opp R
                            { stat: { stat_id: "26", value: "4.10" } }, // opp ERA
                          ],
                        },
                      },
                    ],
                  },
                  count: 2,
                },
              },
            },
          },
          count: 1,
        },
      },
    ],
  },
});

const snapshot = {
  matchup: { week: 6 },
  scoringCategories: ["R", "ERA"],
} as unknown as LeagueStateSnapshot;

const leagueStateLayer = Layer.succeed(
  LeagueState,
  LeagueState.of({ snapshot: Effect.succeed(snapshot) }),
);

const yahooLayer = Layer.succeed(
  YahooClient,
  YahooClient.of({
    config: { leagueId: "62744", teamId: "12" },
    getLeagueSettings: Effect.succeed(settingsPayload) as never,
    getTeamMetadata: Effect.die("unused"),
    getRoster: Effect.die("unused"),
    getRosterForDate: () => Effect.die("unused"),
    getRosterForTeam: () => Effect.die("unused"),
    getAvailablePlayers: () => Effect.die("unused"),
    getLeagueTransactions: () => Effect.die("unused"),
    getCurrentMatchup: Effect.die("unused"),
    getMatchupForWeek: (week) => Effect.succeed(matchupPayload(week)) as never,
    getLeagueStandings: Effect.die("unused"),
    putRosterPositions: () => Effect.die("unused"),
  }),
);

describe("closeOutPreviousWeek (F8)", () => {
  it("derives outcomes from the prior week's Yahoo matchup and closes it out", () =>
    Effect.gen(function* () {
      const store = new Map<number, WeeklyRetrospective>([
        [
          5,
          new WeeklyRetrospective({
            week: 5,
            recordedAt: "2026-06-01T00:00:00.000Z",
            predictions: [
              new CategoryPrediction({ category: "R", winProbability: 0.6, tieProbability: 0 }),
              new CategoryPrediction({ category: "ERA", winProbability: 0.4, tieProbability: 0 }),
            ],
          }),
        ],
      ]);

      const closedWeek = yield* closeOutPreviousWeek.pipe(
        Effect.provide(
          Layer.mergeAll(leagueStateLayer, yahooLayer, makeCalibrationHarnessTest(store)),
        ),
      );

      expect(closedWeek).toBe(5);
      const closed = store.get(5)!;
      expect(isClosedOut(closed)).toBe(true);
      const byCategory = new Map(closed.outcomes!.map((o) => [o.category, o.outcome]));
      expect(byCategory.get("R")).toBe("win"); // 30 > 25
      expect(byCategory.get("ERA")).toBe("win"); // 3.50 < 4.10, lower wins
    }).pipe(Effect.runPromise));

  it("is a no-op when the prior week is already closed out", () =>
    Effect.gen(function* () {
      const store = new Map<number, WeeklyRetrospective>(); // nothing recorded for week 5
      const result = yield* closeOutPreviousWeek.pipe(
        Effect.provide(
          Layer.mergeAll(leagueStateLayer, yahooLayer, makeCalibrationHarnessTest(store)),
        ),
      );
      expect(result).toBeUndefined();
    }).pipe(Effect.runPromise));
});
