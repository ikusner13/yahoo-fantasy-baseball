import { describe, it, expect } from "vitest";
import { fetchBatterProjections, fetchPitcherProjections } from "../../src/data/projections";
import { getWeekSchedule } from "../../src/analysis/game-count";
import { estimateMatchupWinProbability } from "../../src/recommendation/probability-engine";
import type { Matchup, PlayerProjection, Roster, RosterEntry } from "../../src/types";

const describeReal = process.env.RUN_REAL_DATA === "1" ? describe : describe.skip;

function buildRosterEntry(
  yahooId: string,
  name: string,
  team: string,
  positions: string[],
): RosterEntry {
  return {
    player: {
      yahooId,
      name,
      team,
      positions,
      status: "healthy",
    },
    currentPosition: positions[0] ?? "BN",
  };
}

describeReal("recommendation probability engine with real public data", () => {
  it("produces sane matchup win probabilities from live FanGraphs projections and real MLB schedule", async () => {
    const [batters, pitchers] = await Promise.all([
      fetchBatterProjections(),
      fetchPitcherProjections(),
    ]);

    const selectedBatters = batters
      .filter((b) => b.pa > 400 && b.team)
      .slice(0, 10);
    const selectedPitchers = pitchers
      .filter((p) => p.ip > 120 && p.team)
      .slice(0, 8);

    expect(selectedBatters.length).toBeGreaterThanOrEqual(10);
    expect(selectedPitchers.length).toBeGreaterThanOrEqual(8);

    const rosterEntries: RosterEntry[] = [
      ...selectedBatters.map((b, idx) =>
        buildRosterEntry(`real-bat-${idx}`, b.name, b.team, ["OF"]),
      ),
      ...selectedPitchers.map((p, idx) =>
        buildRosterEntry(`real-pit-${idx}`, p.name, p.team, ["SP"]),
      ),
    ];

    const projectionMap = new Map<string, PlayerProjection>();

    for (const [idx, batter] of selectedBatters.entries()) {
      projectionMap.set(`real-bat-${idx}`, {
        yahooId: `real-bat-${idx}`,
        playerType: "batter",
        batting: {
          pa: batter.pa,
          r: batter.r,
          h: batter.h,
          hr: batter.hr,
          rbi: batter.rbi,
          sb: batter.sb,
          tb: batter.tb,
          obp: batter.obp,
        },
        updatedAt: new Date().toISOString(),
      });
    }

    for (const [idx, pitcher] of selectedPitchers.entries()) {
      projectionMap.set(`real-pit-${idx}`, {
        yahooId: `real-pit-${idx}`,
        playerType: "pitcher",
        pitching: {
          ip: pitcher.ip,
          outs: Math.round(pitcher.ip * 3),
          k: pitcher.k,
          era: pitcher.era,
          whip: pitcher.whip,
          qs: pitcher.qs,
          svhd: pitcher.svhd,
        },
        updatedAt: new Date().toISOString(),
      });
    }

    const roster: Roster = {
      entries: rosterEntries,
      date: "2026-04-06",
    };

    const matchup: Matchup = {
      week: 2,
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      opponentTeamKey: "opp",
      opponentTeamName: "Public Data Opponent",
      categories: [
        { category: "R", myValue: 24, opponentValue: 23 },
        { category: "H", myValue: 41, opponentValue: 40 },
        { category: "HR", myValue: 8, opponentValue: 8 },
        { category: "RBI", myValue: 26, opponentValue: 27 },
        { category: "SB", myValue: 5, opponentValue: 5 },
        { category: "TB", myValue: 71, opponentValue: 69 },
        { category: "OBP", myValue: 0.318, opponentValue: 0.319 },
        { category: "OUT", myValue: 96, opponentValue: 94 },
        { category: "K", myValue: 49, opponentValue: 47 },
        { category: "ERA", myValue: 3.61, opponentValue: 3.66 },
        { category: "WHIP", myValue: 1.18, opponentValue: 1.19 },
        { category: "QS", myValue: 3, opponentValue: 3 },
        { category: "SVHD", myValue: 3, opponentValue: 3 },
      ],
    };

    const weekSchedule = await getWeekSchedule(matchup.weekStart, matchup.weekEnd);
    const result = estimateMatchupWinProbability(matchup, roster, projectionMap, weekSchedule, {
      asOf: new Date("2026-04-06T12:00:00Z"),
      simulations: 500,
      seed: 42,
    });

    expect(result.daysRemaining).toBe(7);
    expect(result.winProbability).toBeGreaterThanOrEqual(0);
    expect(result.winProbability).toBeLessThanOrEqual(1);
    expect(result.expectedCategoryWins).toBeGreaterThanOrEqual(0);
    expect(result.expectedCategoryWins).toBeLessThanOrEqual(13);
    expect(result.categoryWinProbabilities).toHaveLength(13);
  });
});
