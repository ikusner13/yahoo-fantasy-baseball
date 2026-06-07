import { describe, expect, it } from "vite-plus/test";

import { parseStandingsCategoryTotals } from "../../src/services/StandingsHistory";
import type {
  YahooLeagueSettingsPayload,
  YahooStandingsPayload,
} from "../../src/services/YahooClient";

const settings = {
  fantasy_content: {
    league: [
      {},
      {
        settings: [
          {
            stat_categories: {
              stats: [
                {
                  stat: {
                    stat_id: "60",
                    name: "Hits / At Bats",
                    display_name: "H/AB",
                    is_only_display_stat: "1",
                  },
                },
                { stat: { stat_id: "7", name: "Runs", display_name: "R" } },
                { stat: { stat_id: "12", name: "Home Runs", display_name: "HR" } },
                { stat: { stat_id: "4", name: "On-base Percentage", display_name: "OBP" } },
              ],
            },
          },
        ],
      },
    ],
  },
} as unknown as YahooLeagueSettingsPayload;

const standings = {
  fantasy_content: {
    league: [
      {},
      {
        standings: [
          {
            teams: {
              "0": {
                team: [
                  [{ team_key: "mlb.l.62744.t.1" }, { name: "Professor Chaos" }],
                  {
                    team_stats: {
                      stats: [
                        { stat: { stat_id: "60", value: "" } },
                        { stat: { stat_id: "7", value: "332" } },
                        { stat: { stat_id: "12", value: "97" } },
                        { stat: { stat_id: "4", value: ".340" } },
                      ],
                    },
                  },
                  { team_standings: { rank: "1" } },
                ],
              },
              "1": {
                team: [
                  [{ team_key: "mlb.l.62744.t.2" }, { name: "Second Team" }],
                  {
                    team_stats: {
                      stats: [
                        { stat: { stat_id: "7", value: "312" } },
                        { stat: { stat_id: "12", value: "82" } },
                        { stat: { stat_id: "4", value: ".329" } },
                      ],
                    },
                  },
                  { team_standings: { rank: 2 } },
                ],
              },
              count: 2,
            },
          },
        ],
      },
    ],
  },
} as unknown as YahooStandingsPayload;

describe("StandingsHistory", () => {
  it("parses cumulative category totals from Yahoo standings team_stats", () => {
    const totals = parseStandingsCategoryTotals(settings, standings);

    expect(totals).toHaveLength(2);
    expect(totals[0]).toMatchObject({
      teamKey: "mlb.l.62744.t.1",
      rank: 1,
      categories: {
        R: 332,
        HR: 97,
        OBP: 0.34,
      },
    });
    expect(totals[0]?.categories).not.toHaveProperty("H/AB");
  });
});
