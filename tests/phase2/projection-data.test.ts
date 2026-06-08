import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/unstable/http";
import { describe, expect, it } from "@effect/vitest";

import { ProjectionData } from "../../src/services/ProjectionData";

const batterRow = {
  playerid: "sa3022683",
  xMLBAMID: "111",
  PlayerName: "Ada Batter",
  Team: "NYY",
  PA: "100",
  R: "20",
  H: "30",
  HR: "10",
  RBI: "25",
  SB: "5",
  TB: "70",
  OBP: "0.400",
  AB: "80",
  BB: "15",
  HBP: "2",
  SF: "3",
};

const pitcherRow = {
  playerid: "456",
  xMLBAMID: "456",
  PlayerName: "Grace Starter",
  Team: "SEA",
  IP: "120",
  GS: "20",
  SO: "140",
  ERA: "3.00",
  WHIP: "1.10",
  QS: "12",
  SV: "0",
  HLD: "3",
  G: "22",
};

const schedulePayload = {
  dates: [
    {
      games: [
        {
          gamePk: 1,
          gameDate: "2099-06-06T23:05:00Z",
          teams: {
            away: {
              team: { abbreviation: "NYY" },
              probablePitcher: { id: 456, fullName: "Grace Starter" },
            },
            home: {
              team: { abbreviation: "SEA" },
              probablePitcher: { id: 789, fullName: "Home Starter" },
            },
          },
        },
      ],
    },
    {
      games: [
        {
          gamePk: 2,
          gameDate: "2000-06-06T23:05:00Z",
          teams: {
            away: { team: { abbreviation: "NYY" } },
            home: { team: { abbreviation: "BOS" } },
          },
        },
      ],
    },
  ],
};

const boxscorePayload = (gamePk: string) =>
  gamePk === "1"
    ? {
        teams: {
          away: { team: { abbreviation: "NYY" }, battingOrder: [111, 222, 333] },
          home: { team: { abbreviation: "SEA" }, battingOrder: [456, 789] },
        },
      }
    : {
        teams: {
          away: { team: { abbreviation: "NYY" } },
          home: { team: { abbreviation: "BOS" } },
        },
      };

const oddsPayload = [
  {
    home_team: "New York Yankees",
    away_team: "Boston Red Sox",
    bookmakers: [
      {
        markets: [
          {
            key: "h2h",
            outcomes: [
              { name: "New York Yankees", price: -150 },
              { name: "Boston Red Sox", price: 130 },
            ],
          },
          {
            key: "totals",
            outcomes: [
              { name: "Over", point: 8.5 },
              { name: "Under", point: 8.5 },
            ],
          },
        ],
      },
    ],
  },
];

const batterSavantCsv = [
  '"last_name, first_name",player_id,year,xwoba,barrel_batted_rate,hard_hit_percent,avg_hit_speed,k_percent,sprint_speed',
  '"Batter, Ada",111,2026,0.385,14.2,48.5,91.1,19.0,28.8',
].join("\n");

const pitcherSavantCsv = [
  '"last_name, first_name",player_id,year,xwoba,barrel_batted_rate,whiff_percent,k_percent',
  '"Starter, Grace",456,2026,0.275,6.2,31.5,28.0',
].join("\n");

const makeLayer = (seenUrls: Array<string>) => {
  const httpClient = HttpClient.make((request) => {
    const params = UrlParams.toRecord(request.urlParams);
    seenUrls.push(`${request.url}?${new URLSearchParams(params as Record<string, string>)}`);
    const url = new URL(request.url);
    const body =
      url.hostname === "www.fangraphs.com"
        ? params["stats"] === "bat"
          ? JSON.stringify([batterRow])
          : JSON.stringify([pitcherRow])
        : url.hostname === "statsapi.mlb.com"
          ? url.pathname.includes("/boxscore")
            ? JSON.stringify(boxscorePayload(url.pathname.split("/")[4] ?? ""))
            : JSON.stringify(schedulePayload)
          : url.hostname === "baseballsavant.mlb.com"
            ? params["type"] === "batter"
              ? batterSavantCsv
              : pitcherSavantCsv
            : JSON.stringify(oddsPayload);

    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: 200,
          headers: {
            "content-type":
              url.hostname === "baseballsavant.mlb.com" ? "text/csv" : "application/json",
          },
        }),
      ),
    );
  });

  return ProjectionData.layerLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        ConfigProvider.layer(ConfigProvider.fromUnknown({ ODDS_API_KEY: "test-odds-key" })),
      ),
    ),
  );
};

describe("ProjectionData", () => {
  it.effect("fetches and decodes all FanGraphs ROS projection systems", () => {
    const seenUrls: Array<string> = [];
    return Effect.gen(function* () {
      const projectionData = yield* ProjectionData;

      const [batters, pitchers] = yield* Effect.all([
        projectionData.batterProjections,
        projectionData.pitcherProjections,
      ]);

      expect(batters).toHaveLength(4);
      expect(batters[0]).toMatchObject({
        source: "rthebatx",
        playerKey: "fg:sa3022683",
        mlbId: 111,
        name: "Ada Batter",
        pa: 100,
        obp: 0.4,
      });
      expect(pitchers).toHaveLength(4);
      expect(pitchers[0]).toMatchObject({
        source: "rthebatx",
        playerKey: "fg:456",
        mlbId: 456,
        k: 140,
        svh: 3,
      });
      expect(
        seenUrls.filter((url) => url.startsWith("https://www.fangraphs.com/api/projections")),
      ).toHaveLength(8);
    }).pipe(Effect.provide(makeLayer(seenUrls)));
  });

  it.effect("builds weekly schedule, probable-start, and Vegas context", () => {
    const seenUrls: Array<string> = [];
    return Effect.gen(function* () {
      const projectionData = yield* ProjectionData;

      const context = yield* projectionData.weeklyContext("2026-06-01", "2026-06-07");

      expect(context.schedules).toContainEqual({
        team: "NYY",
        gamesThisWeek: 2,
        gamesRemaining: 1,
      });
      expect(context.schedules).toContainEqual({
        team: "SEA",
        gamesThisWeek: 1,
        gamesRemaining: 1,
      });
      expect(context.dailyGameWindows).toContainEqual({
        date: "2099-06-06",
        games: 1,
        remainingGames: 1,
        firstGameTime: "2099-06-06T23:05:00.000Z",
        lastGameTime: "2099-06-06T23:05:00.000Z",
      });
      expect(context.dailyGameWindows).toContainEqual({
        date: "2000-06-06",
        games: 1,
        remainingGames: 0,
        firstGameTime: "2000-06-06T23:05:00.000Z",
        lastGameTime: "2000-06-06T23:05:00.000Z",
      });
      expect(context.probableStartsByPlayerKey).toMatchObject({
        "mlb:456": 1,
        "mlb:789": 1,
      });
      expect(context.probablePitcherStarts).toEqual([
        {
          playerKey: "mlb:456",
          playerName: "Grace Starter",
          team: "NYY",
          opponentTeam: "SEA",
          date: "2099-06-06",
          gameTime: "2099-06-06T23:05:00.000Z",
          homeAway: "away",
        },
        {
          playerKey: "mlb:789",
          playerName: "Home Starter",
          team: "SEA",
          opponentTeam: "NYY",
          date: "2099-06-06",
          gameTime: "2099-06-06T23:05:00.000Z",
          homeAway: "home",
        },
      ]);
      expect(context.confirmedLineupsByTeam).toMatchObject({
        NYY: 1,
        SEA: 1,
      });
      expect(context.battingOrdersByPlayerKey?.["mlb:111"]).toMatchObject({
        confirmedStarts: 1,
        battingOrderSum: 1,
      });
      expect(context.impliedRunsByTeam.NYY).toBeGreaterThan(context.impliedRunsByTeam.BOS ?? 0);
      expect(context.statcastByPlayerKey?.["mlb:111"]).toMatchObject({
        xwoba: 0.385,
        barrelPct: 14.2,
        sprintSpeed: 28.8,
      });
      expect(context.statcastByPlayerKey?.["mlb:456"]).toMatchObject({
        xwoba: 0.275,
        whiffPct: 31.5,
      });
      expect(context.parkFactorsByTeam?.NYY?.hrFactor).toBeGreaterThan(1);
      expect(
        seenUrls.some(
          (url) =>
            url.startsWith("https://api.the-odds-api.com") && url.includes("apiKey=test-odds-key"),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(makeLayer(seenUrls)));
  });

  it.effect("caches Odds responses for the same scoring period", () => {
    const seenUrls: Array<string> = [];
    return Effect.gen(function* () {
      const projectionData = yield* ProjectionData;

      yield* projectionData.weeklyContext("2026-06-01", "2026-06-07");
      yield* projectionData.weeklyContext("2026-06-01", "2026-06-07");

      expect(seenUrls.filter((url) => url.startsWith("https://api.the-odds-api.com"))).toHaveLength(
        1,
      );
      expect(
        seenUrls.filter((url) => url.startsWith("https://baseballsavant.mlb.com")),
      ).toHaveLength(2);
      expect(
        seenUrls.filter((url) => url.startsWith("https://statsapi.mlb.com/api/v1/schedule")),
      ).toHaveLength(2);
      expect(seenUrls.filter((url) => url.includes("statsapi.mlb.com/api/v1/game/"))).toHaveLength(
        4,
      );
    }).pipe(Effect.provide(makeLayer(seenUrls)));
  });
});
