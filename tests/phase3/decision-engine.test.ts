import { describe, expect, it } from "vite-plus/test";

import {
  computeSgpDenominators,
  optimizeLineup,
  rankAddCandidates,
  simulateMatchup,
} from "../../src/services/DecisionEngine";
import {
  LeagueStatePlayer,
  LeagueStateSnapshot,
  RosterSlotCount,
} from "../../src/services/LeagueState";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";

const batter = (overrides: Partial<ConstructorParameters<typeof WeeklyBatterLine>[0]> = {}) =>
  new WeeklyBatterLine({
    kind: "batter",
    playerKey: "mlb.p.batter",
    name: "Batter",
    team: "NYY",
    pa: 25,
    r: 4,
    h: 6,
    hr: 1,
    rbi: 4,
    sb: 1,
    tb: 10,
    obpNumerator: 8,
    obpDenominator: 24,
    obp: 8 / 24,
    ...overrides,
  });

const pitcher = (overrides: Partial<ConstructorParameters<typeof WeeklyPitcherLine>[0]> = {}) =>
  new WeeklyPitcherLine({
    kind: "pitcher",
    playerKey: "mlb.p.pitcher",
    name: "Pitcher",
    team: "SEA",
    ip: 6,
    out: 18,
    k: 7,
    er: 2,
    baserunners: 7,
    era: 3,
    whip: 7 / 6,
    qs: 0.7,
    svh: 0,
    ...overrides,
  });

describe("DecisionEngine Phase 3", () => {
  it("computes SGP denominators as standings-history slopes", () => {
    const denominators = computeSgpDenominators([
      { teamKey: "1", rank: 1, categories: { HR: 240 } },
      { teamKey: "2", rank: 2, categories: { HR: 225 } },
      { teamKey: "3", rank: 3, categories: { HR: 210 } },
      { teamKey: "4", rank: 4, categories: { HR: 195 } },
    ]);

    expect(denominators.HR).toBe(15);
  });

  it("simulates category probabilities against the real opponent projection set", () => {
    const result = simulateMatchup(
      [batter({ playerKey: "mine", hr: 8 })],
      [batter({ playerKey: "opp", hr: 1 })],
      1000,
      1,
    );

    const hr = result.categories.find((category) => category.category === "HR");
    expect(hr?.winProbability).toBeGreaterThan(0.95);
    expect(hr?.tag).toBe("lock");
  });

  it("uses OBP numerator and denominator instead of hits or plate appearances", () => {
    const result = simulateMatchup(
      [
        batter({
          playerKey: "low-hits-good-obp",
          h: 2,
          obpNumerator: 14,
          obpDenominator: 28,
        }),
      ],
      [
        batter({
          playerKey: "high-hits-bad-obp",
          h: 10,
          obpNumerator: 8,
          obpDenominator: 32,
        }),
      ],
      1000,
      2,
    );

    const obp = result.categories.find((category) => category.category === "OBP");
    const hits = result.categories.find((category) => category.category === "H");
    expect(obp?.winProbability).toBeGreaterThan(0.85);
    expect(hits?.winProbability).toBeLessThan(0.1);
  });

  it("ranks add candidates by marginal weekly category EV plus season SGP", () => {
    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [
          batter({ playerKey: "my-batter", hr: 1, r: 3, rbi: 3 }),
          pitcher({ playerKey: "my-pitcher", k: 4, out: 15 }),
        ],
        opponentRoster: [
          batter({ playerKey: "opp-batter", hr: 4, r: 4, rbi: 4 }),
          pitcher({ playerKey: "opp-pitcher", k: 9, out: 18 }),
        ],
        freeAgents: [
          batter({
            playerKey: "power-bat",
            name: "Power Bat",
            hr: 12,
            r: 5,
            rbi: 6,
            tb: 12,
          }),
          pitcher({
            playerKey: "ratio-arm",
            name: "Ratio Arm",
            k: 2,
            out: 6,
            er: 0.5,
            baserunners: 3,
            ip: 4,
          }),
        ],
      }),
    );

    expect(report.baseline.expectedCategoryPoints).toBeGreaterThan(0);
    expect(
      report.scout.coinFlips.length + report.scout.locks.length + report.scout.lostCauses.length,
    ).toBeGreaterThan(0);
    expect(report.recommendations[0]).toMatchObject({
      playerKey: "power-bat",
      type: "add",
    });
    expect(report.recommendations[0]?.weeklyDelta).toBeGreaterThan(0);
    expect(report.recommendations[0]?.affectedCategories.length).toBeGreaterThan(0);
  });

  it("uses active roster slots, not bench pitchers, for matchup category EV", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        pitcher({ playerKey: "active-low-ip", name: "Active Low IP", ip: 2, out: 6, k: 2 }),
        pitcher({
          playerKey: "bench-volume",
          name: "Bench Volume",
          ip: 18,
          out: 54,
          k: 20,
        }),
      ],
      opponentRoster: [pitcher({ playerKey: "opp", ip: 10, out: 30, k: 10 })],
      freeAgents: [pitcher({ playerKey: "starter", name: "Starter", ip: 8, out: 24, k: 9 })],
    });
    const snapshot = new LeagueStateSnapshot({
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
      roster: [
        new LeagueStatePlayer({
          playerKey: "active-low-ip",
          name: "Active Low IP",
          team: "SEA",
          eligiblePositions: ["P"],
          selectedPosition: "P",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-volume",
          name: "Bench Volume",
          team: "SEA",
          eligiblePositions: ["P"],
          selectedPosition: "BN",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "P", count: 1 })],
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

    const report = rankAddCandidates(set, snapshot);

    const baselineOut = report.baseline.categories.find((category) => category.category === "OUT");
    const starter = report.recommendations.find((entry) => entry.playerKey === "starter");
    expect(baselineOut?.winProbability).toBeLessThan(0.1);
    expect(starter?.affectedCategories.map((delta) => delta.category)).toContain("OUT");
  });

  it("optimizes lineup with primary category weights from opponent scout", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "low-power-active",
          name: "Low Power Active",
          hr: 0.2,
          r: 7,
          rbi: 2,
        }),
        batter({
          playerKey: "power-bench",
          name: "Power Bench",
          hr: 5,
          r: 3,
          rbi: 6,
          tb: 20,
        }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 5, r: 4, rbi: 5 })],
      freeAgents: [],
    });
    const baseline = simulateMatchup(set.myRoster.slice(0, 1), set.opponentRoster, 1000, 7);
    const snapshot = new LeagueStateSnapshot({
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
      roster: [
        new LeagueStatePlayer({
          playerKey: "low-power-active",
          name: "Low Power Active",
          team: "NYY",
          eligiblePositions: ["Util"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "power-bench",
          name: "Power Bench",
          team: "LAD",
          eligiblePositions: ["Util"],
          selectedPosition: "BN",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "Util", count: 1 })],
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

    const [move] = optimizeLineup(set, baseline, snapshot);

    expect(move).toMatchObject({
      type: "lineup",
      startPlayerKey: "power-bench",
      sitPlayerKey: "low-power-active",
    });
    expect(move?.affectedCategories.map((delta) => delta.category)).toContain("HR");
  });
});
