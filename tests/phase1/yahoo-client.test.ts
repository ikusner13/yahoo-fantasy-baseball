import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { beforeEach, describe, expect, it } from "@effect/vitest";

import { LeagueState } from "../../src/services/LeagueState";
import {
  buildRosterPositionsXml,
  buildTransactionXml,
  makeYahooClient,
  YahooClient,
} from "../../src/services/YahooClient";
import type { YahooOAuth } from "../../src/services/YahooOAuth";

const settingsFixture = {
  fantasy_content: {
    league: [
      { league_key: "mlb.l.62744", league_id: "62744", name: "Test League" },
      {
        settings: [
          {
            max_weekly_adds: 6,
            roster_positions: [
              { position: "C", count: 1 },
              { position: "1B", count: 1 },
              { position: "BN", count: 3 },
              { position: "IL", count: 4 },
            ],
            stat_categories: {
              stats: [
                { stat: { stat_id: "7", name: "Runs", display_name: "R" } },
                { stat: { stat_id: "12", name: "Home Runs", display_name: "HR" } },
                {
                  stat: {
                    stat_id: "60",
                    name: "Innings Pitched",
                    display_name: "IP",
                    is_only_display_stat: "1",
                  },
                },
              ],
            },
          },
          { season_type: "full", min_innings_pitched: "20" },
        ],
      },
    ],
  },
};

const teamFixture = {
  fantasy_content: {
    team: [
      [
        { team_key: "mlb.l.62744.t.12" },
        { team_id: "12" },
        { name: "My Team" },
        { number_of_moves: "4" },
        { waiver_priority: "2" },
        { faab_balance: "81" },
      ],
    ],
  },
};

const rosterFixture = {
  fantasy_content: {
    team: [
      { team_key: "mlb.l.62744.t.12", team_id: "12", name: "My Team" },
      {
        roster: {
          "0": {
            players: {
              "0": {
                player: [
                  [
                    { player_key: "mlb.p.1" },
                    { player_id: "1" },
                    { name: { full: "Ada Batter" } },
                    { editorial_team_abbr: "NYY" },
                    { eligible_positions: [{ position: "C" }, { position: "1B" }] },
                  ],
                  {
                    selected_position: [
                      { coverage_type: "date" },
                      { date: "2026-06-06" },
                      { position: "C" },
                    ],
                  },
                ],
              },
              count: 1,
            },
          },
          coverage_type: "date",
          date: "2026-06-06",
          is_prescoring: 0,
          is_editable: 1,
        },
      },
    ],
  },
};

const matchupFixture = {
  fantasy_content: {
    team: [
      { team_key: "mlb.l.62744.t.12", team_id: "12", name: "My Team" },
      {
        matchups: {
          "0": {
            matchup: {
              week: 11,
              week_start: "2026-06-01",
              week_end: "2026-06-07",
              status: "midevent",
              "0": {
                teams: {
                  "0": {
                    team: [
                      [{ team_key: "mlb.l.62744.t.12" }, { team_id: "12" }, { name: "My Team" }],
                      {
                        team_stats: {
                          coverage_type: "week",
                          week: "11",
                          stats: [
                            { stat: { stat_id: "7", value: "31" } },
                            { stat: { stat_id: "12", value: "8" } },
                          ],
                        },
                      },
                    ],
                  },
                  "1": {
                    team: [
                      [{ team_key: "mlb.l.62744.t.3" }, { team_id: "3" }, { name: "Opponent" }],
                      {
                        team_stats: {
                          coverage_type: "week",
                          week: "11",
                          stats: [
                            { stat: { stat_id: "7", value: "29" } },
                            { stat: { stat_id: "12", value: "9" } },
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
};

const transactionsFixture = {
  fantasy_content: {
    league: [
      {},
      {
        transactions: {
          "0": {
            transaction: {
              transaction_key: "469.l.62744.tr.1",
              type: "add/drop",
              status: "successful",
              timestamp: `${Date.parse("2026-06-03T12:00:00.000Z") / 1000}`,
              players: {
                "0": {
                  player: [
                    { player_key: "mlb.p.10" },
                    {
                      transaction_data: {
                        type: "add",
                        destination_team_key: "469.l.62744.t.12",
                      },
                    },
                  ],
                },
              },
            },
          },
          "1": {
            transaction: {
              transaction_key: "mlb.l.62744.tr.2",
              type: "add",
              status: "successful",
              timestamp: `${Date.parse("2026-05-30T12:00:00.000Z") / 1000}`,
              players: {
                "0": {
                  player: [
                    { player_key: "mlb.p.11" },
                    {
                      transaction_data: {
                        type: "add",
                        destination_team_key: "mlb.l.62744.t.12",
                      },
                    },
                  ],
                },
              },
            },
          },
          count: 2,
        },
      },
    ],
  },
};

const oauth: typeof YahooOAuth.Service = {
  authorizationUrl: () => "https://example.test/auth",
  authorizationUrlWithState: () => "https://example.test/auth?state=state",
  exchangeAuthorizationCode: () => Effect.die("unused"),
  refresh: () => Effect.die("unused"),
  getAccessToken: Effect.succeed("access-token"),
};

const seenUrls: Array<string> = [];
let lastWrite:
  | {
      readonly method: string;
      readonly url: string;
      readonly body: string;
      readonly authorization: string | undefined;
      readonly contentType: string | undefined;
      readonly urlParams: ReadonlyArray<readonly [string, string]>;
    }
  | undefined;

const httpClient = HttpClient.make((request) => {
  seenUrls.push(request.url);
  if (request.method === "PUT") {
    return Effect.gen(function* () {
      const webRequest = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie);
      lastWrite = {
        method: request.method,
        url: request.url,
        body: yield* Effect.promise(() => webRequest.text()),
        authorization: request.headers["authorization"],
        contentType: request.headers["content-type"],
        urlParams: [...request.urlParams],
      };
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
  }
  const url = new URL(request.url);
  const body = url.pathname.endsWith("/settings")
    ? settingsFixture
    : url.pathname.endsWith("/metadata")
      ? teamFixture
      : url.pathname.includes("/roster/players")
        ? rosterFixture
        : url.pathname.includes("/transactions")
          ? transactionsFixture
          : matchupFixture;

  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

const httpClientWithoutNumberOfMoves = HttpClient.make((request) => {
  const url = new URL(request.url);
  const body = url.pathname.endsWith("/metadata")
    ? {
        fantasy_content: {
          team: [
            [
              { team_key: "mlb.l.62744.t.12" },
              { team_id: "12" },
              { name: "My Team" },
              { waiver_priority: "2" },
              { faab_balance: "81" },
            ],
          ],
        },
      }
    : url.pathname.endsWith("/settings")
      ? settingsFixture
      : url.pathname.includes("/roster/players")
        ? rosterFixture
        : url.pathname.includes("/transactions")
          ? transactionsFixture
          : matchupFixture;

  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

describe("YahooClient", () => {
  beforeEach(() => {
    seenUrls.length = 0;
    lastWrite = undefined;
  });

  it("builds escaped Yahoo roster position XML", () => {
    const xml = buildRosterPositionsXml("2026-06-07", [
      { playerKey: "mlb.p.1&bad", position: "IL" },
    ]);

    expect(xml).toContain("<date>2026-06-07</date>");
    expect(xml).toContain("<player_key>mlb.p.1&amp;bad</player_key>");
    expect(xml).toContain("<position>IL</position>");
  });

  it("builds escaped Yahoo add transaction XML", () => {
    const xml = buildTransactionXml("mlb.l.62744.t.12", {
      type: "add",
      playerKey: "mlb.p.1&bad",
    });

    expect(xml).toContain("<type>add</type>");
    expect(xml).toContain("<player_key>mlb.p.1&amp;bad</player_key>");
    expect(xml).toContain("<destination_team_key>mlb.l.62744.t.12</destination_team_key>");
    expect(xml).not.toContain("<source_team_key>");
  });

  it("builds Yahoo add/drop transaction XML with FAAB", () => {
    const xml = buildTransactionXml("mlb.l.62744.t.12", {
      type: "add/drop",
      addPlayerKey: "mlb.p.10",
      dropPlayerKey: "mlb.p.11",
      faabBid: 3,
    });

    expect(xml).toContain("<type>add/drop</type>");
    expect(xml).toContain("<faab_bid>3</faab_bid>");
    expect(xml).toContain("<player_key>mlb.p.10</player_key>");
    expect(xml).toContain("<type>add</type>");
    expect(xml).toContain("<destination_team_key>mlb.l.62744.t.12</destination_team_key>");
    expect(xml).toContain("<player_key>mlb.p.11</player_key>");
    expect(xml).toContain("<type>drop</type>");
    expect(xml).toContain("<source_team_key>mlb.l.62744.t.12</source_team_key>");
  });

  it("builds Yahoo waiver transaction XML without inventing a drop", () => {
    const xml = buildTransactionXml("mlb.l.62744.t.12", {
      type: "waiver",
      addPlayerKey: "mlb.p.20",
    });

    expect(xml).toContain("<type>waiver</type>");
    expect(xml).toContain("<player_key>mlb.p.20</player_key>");
    expect(xml).toContain("<destination_team_key>mlb.l.62744.t.12</destination_team_key>");
    expect(xml).not.toContain("<source_team_key>");
    expect(xml).not.toContain("<faab_bid>");
  });

  it.effect("schema-decodes the Yahoo tuple and numeric-key collection shapes", () =>
    Effect.gen(function* () {
      const client = makeYahooClient({ leagueId: "62744", teamId: "12" }, oauth, httpClient);

      const [settings, roster, matchup] = yield* Effect.all([
        client.getLeagueSettings,
        client.getRoster,
        client.getCurrentMatchup,
      ]);

      expect(settings.fantasy_content.league[1].settings[0]?.max_weekly_adds).toBe(6);
      expect(roster.fantasy_content.team[1].roster["0"].players).toHaveLength(1);
      expect(matchup.fantasy_content.team[1].matchups["0"].matchup.week).toBe(11);
    }),
  );

  it.effect("can request a roster for a specific daily lineup date", () =>
    Effect.gen(function* () {
      const client = makeYahooClient({ leagueId: "62744", teamId: "12" }, oauth, httpClient);

      yield* client.getRosterForDate("2026-06-07");

      expect(seenUrls.some((url) => url.includes("/roster/players;date=2026-06-07"))).toBe(true);
    }),
  );

  it.effect("can PUT daily roster position moves to Yahoo", () =>
    Effect.gen(function* () {
      const client = makeYahooClient({ leagueId: "62744", teamId: "12" }, oauth, httpClient);

      yield* client.putRosterPositions("2026-06-07", [
        { playerKey: "mlb.p.1", position: "IL" },
        { playerKey: "mlb.p.2", position: "P" },
      ]);

      expect(lastWrite).toMatchObject({
        method: "PUT",
        authorization: "Bearer access-token",
        contentType: "application/xml",
      });
      expect(lastWrite?.url).toContain("/team/mlb.l.62744.t.12/roster/players");
      expect(lastWrite?.urlParams).toContainEqual(["format", "json"]);
      expect(lastWrite?.body).toContain("<player_key>mlb.p.1</player_key>");
      expect(lastWrite?.body).toContain("<position>IL</position>");
      expect(lastWrite?.body).toContain("<player_key>mlb.p.2</player_key>");
      expect(lastWrite?.body).toContain("<position>P</position>");
    }),
  );
});

describe("LeagueState.layerLive", () => {
  it.effect("projects decoded Yahoo responses into a Phase 1 league snapshot", () =>
    Effect.gen(function* () {
      const leagueState = yield* LeagueState;
      const snapshot = yield* leagueState.snapshot;

      expect(snapshot.scoringCategories).toEqual(["R", "HR"]);
      expect(snapshot.weeklyAddLimit).toBe(6);
      expect(snapshot.addsUsed).toBe(1);
      expect(snapshot.waiverPriority).toBe(2);
      expect(snapshot.faabBalance).toBe(81);
      expect(snapshot.roster[0]).toMatchObject({
        playerKey: "mlb.p.1",
        name: "Ada Batter",
        selectedPosition: "C",
      });
      expect(snapshot.emptySlots).toContainEqual({ position: "1B", count: 1 });
      expect(snapshot.matchup).toMatchObject({
        week: 11,
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
      });
      expect(snapshot.matchup.categories).toEqual([
        { category: "R", myValue: "31", opponentValue: "29" },
        { category: "HR", myValue: "8", opponentValue: "9" },
      ]);
    }).pipe(
      Effect.provide(
        Layer.provide(
          LeagueState.layerLive,
          Layer.succeed(
            YahooClient,
            YahooClient.of(makeYahooClient({ leagueId: "62744", teamId: "12" }, oauth, httpClient)),
          ),
        ),
      ),
    ),
  );

  it.effect("uses weekly transaction inference when Yahoo omits number_of_moves", () =>
    Effect.gen(function* () {
      const leagueState = yield* LeagueState;
      const snapshot = yield* leagueState.snapshot;

      expect(snapshot.addsUsed).toBe(1);
      expect(snapshot.waiverPriority).toBe(2);
    }).pipe(
      Effect.provide(
        Layer.provide(
          LeagueState.layerLive,
          Layer.succeed(
            YahooClient,
            YahooClient.of(
              makeYahooClient(
                { leagueId: "62744", teamId: "12" },
                oauth,
                httpClientWithoutNumberOfMoves,
              ),
            ),
          ),
        ),
      ),
    ),
  );
});
