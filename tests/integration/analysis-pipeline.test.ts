import { describe, it, expect } from "vite-plus/test";
import { fetchBatterProjections, fetchPitcherProjections } from "../../src/data/projections";
import { computeZScores, applyPositionalScarcity } from "../../src/analysis/valuations";
import { optimizeLineup, scorePlayerForToday } from "../../src/analysis/lineup";
import { analyzeMatchup } from "../../src/analysis/matchup";
import { rankStreamingOptions } from "../../src/analysis/streaming";
import type {
  PlayerProjection,
  Roster,
  RosterEntry,
  Player,
  Matchup,
  ScheduledGame,
} from "../../src/types";

// Build a realistic projection map from FanGraphs data
async function getRealProjections() {
  const [batters, pitchers] = await Promise.all([
    fetchBatterProjections(),
    fetchPitcherProjections(),
  ]);

  const projections: PlayerProjection[] = [];

  for (const b of batters.filter((b) => b.pa > 200)) {
    projections.push({
      yahooId: `fg:${b.fangraphsId}`,
      playerType: "batter",
      batting: {
        pa: b.pa,
        r: b.r,
        h: b.h,
        hr: b.hr,
        rbi: b.rbi,
        sb: b.sb,
        tb: b.tb,
        obp: b.obp,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  for (const p of pitchers.filter((p) => p.ip > 50)) {
    projections.push({
      yahooId: `fg:${p.fangraphsId}`,
      playerType: "pitcher",
      pitching: {
        ip: p.ip,
        outs: Math.round(p.ip * 3),
        k: p.k,
        era: p.era,
        whip: p.whip,
        qs: p.qs,
        svhd: p.svhd,
      },
      updatedAt: new Date().toISOString(),
    });
  }

  return { projections, rawBatters: batters, rawPitchers: pitchers };
}

describe("Valuations with real projections", () => {
  it("computes z-scores for 100+ real players", async () => {
    const { projections } = await getRealProjections();

    const valuations = computeZScores(projections);

    expect(valuations.length).toBeGreaterThan(100);

    // Top player should have positive z-score
    expect(valuations[0].totalZScore).toBeGreaterThan(0);

    // Bottom player should have negative z-score
    expect(valuations[valuations.length - 1].totalZScore).toBeLessThan(0);

    // Distribution should be roughly centered (mean ~0)
    const avgZ = valuations.reduce((s, v) => s + v.totalZScore, 0) / valuations.length;
    expect(Math.abs(avgZ)).toBeLessThan(1.0);
  });

  it("positional scarcity adjusts catchers up and OF down", async () => {
    const { projections } = await getRealProjections();

    const valuations = computeZScores(projections);

    // Only assign positions to batters (pitchers use pitcher scarcity table)
    const posMap: Record<string, string[]> = {};
    const batterVals = valuations.filter((v) => {
      const proj = projections.find((p) => p.yahooId === v.yahooId);
      return proj?.playerType === "batter";
    });

    for (let i = 0; i < Math.min(5, batterVals.length); i++) {
      posMap[batterVals[i].yahooId] = ["C"];
    }
    for (let i = 5; i < Math.min(35, batterVals.length); i++) {
      posMap[batterVals[i].yahooId] = ["OF"];
    }

    const adjusted = applyPositionalScarcity(valuations, projections, posMap);

    const catchers = adjusted.filter((v) => posMap[v.yahooId]?.[0] === "C");
    const outfielders = adjusted.filter((v) => posMap[v.yahooId]?.[0] === "OF");

    expect(catchers.length).toBeGreaterThan(0);
    expect(outfielders.length).toBeGreaterThan(0);
    expect(catchers[0].positionAdjustment).toBe(1.3);
    expect(outfielders[0].positionAdjustment).toBe(0.95);
  });
});

describe("Lineup optimizer with real projections", () => {
  it("produces valid lineup for a realistic roster", async () => {
    const { projections } = await getRealProjections();

    // Build a fake roster using real projection IDs
    const batterProj = projections.filter((p) => p.playerType === "batter");
    const pitcherProj = projections.filter((p) => p.playerType === "pitcher");

    const makePlayer = (proj: PlayerProjection, positions: string[]): Player => ({
      yahooId: proj.yahooId,
      name: proj.yahooId,
      team: "NYY",
      positions,
      status: "healthy",
    });

    const entries: RosterEntry[] = [
      // Batters: C, 1B, 2B, 3B, SS, 3x OF, 2x Util = 10
      { player: makePlayer(batterProj[0], ["C"]), currentPosition: "C" },
      { player: makePlayer(batterProj[1], ["1B"]), currentPosition: "1B" },
      { player: makePlayer(batterProj[2], ["2B"]), currentPosition: "2B" },
      { player: makePlayer(batterProj[3], ["3B"]), currentPosition: "3B" },
      { player: makePlayer(batterProj[4], ["SS"]), currentPosition: "SS" },
      { player: makePlayer(batterProj[5], ["OF"]), currentPosition: "OF" },
      { player: makePlayer(batterProj[6], ["OF"]), currentPosition: "OF" },
      { player: makePlayer(batterProj[7], ["OF"]), currentPosition: "OF" },
      { player: makePlayer(batterProj[8], ["1B", "OF"]), currentPosition: "Util" },
      { player: makePlayer(batterProj[9], ["2B", "SS"]), currentPosition: "Util" },
      // Pitchers: 2x SP, 2x RP, 4x P = 8
      { player: makePlayer(pitcherProj[0], ["SP"]), currentPosition: "SP" },
      { player: makePlayer(pitcherProj[1], ["SP"]), currentPosition: "SP" },
      { player: makePlayer(pitcherProj[2], ["RP"]), currentPosition: "RP" },
      { player: makePlayer(pitcherProj[3], ["RP"]), currentPosition: "RP" },
      { player: makePlayer(pitcherProj[4], ["SP"]), currentPosition: "P" },
      { player: makePlayer(pitcherProj[5], ["SP"]), currentPosition: "P" },
      { player: makePlayer(pitcherProj[6], ["RP"]), currentPosition: "P" },
      { player: makePlayer(pitcherProj[7], ["SP"]), currentPosition: "P" },
      // Bench: 5 players
      { player: makePlayer(batterProj[10], ["OF", "1B"]), currentPosition: "BN" },
      { player: makePlayer(batterProj[11], ["SS", "2B"]), currentPosition: "BN" },
      { player: makePlayer(batterProj[12], ["C", "1B"]), currentPosition: "BN" },
      { player: makePlayer(pitcherProj[8], ["SP"]), currentPosition: "BN" },
      { player: makePlayer(pitcherProj[9], ["RP"]), currentPosition: "BN" },
      // IL: 1 player
      {
        player: {
          ...makePlayer(batterProj[13], ["OF"]),
          status: "IL",
        },
        currentPosition: "IL",
      },
    ];

    const roster: Roster = {
      entries,
      date: new Date().toISOString().slice(0, 10),
    };

    // All players are on NYY, so create a game for NYY
    const games: ScheduledGame[] = [
      {
        gameId: 1,
        date: roster.date,
        homeTeam: "NYY",
        awayTeam: "BOS",
        status: "scheduled",
      },
    ];

    const projMap = new Map(projections.map((p) => [p.yahooId, p]));
    const moves = optimizeLineup(roster, projMap, games);

    // Should produce a move for every roster entry
    expect(moves.length).toBe(entries.length);

    // Count position assignments
    const posCounts: Record<string, number> = {};
    for (const m of moves) {
      posCounts[m.position] = (posCounts[m.position] ?? 0) + 1;
    }

    // Verify position limits
    expect(posCounts["C"]).toBe(1);
    expect(posCounts["OF"]).toBe(3);
    expect(posCounts["Util"]).toBe(2);
    expect(posCounts["SP"]).toBe(2);
    expect(posCounts["RP"]).toBe(2);
    expect(posCounts["P"]).toBe(4);
    expect(posCounts["IL"]).toBe(1);

    // No duplicate player assignments
    const playerIds = moves.map((m) => m.playerId);
    expect(new Set(playerIds).size).toBe(playerIds.length);
  });

  it("benches players without games", async () => {
    const { projections } = await getRealProjections();
    const batterProj = projections.filter((p) => p.playerType === "batter");

    const player: Player = {
      yahooId: batterProj[0].yahooId,
      name: "Test Player",
      team: "NYY",
      positions: ["1B"],
      status: "healthy",
    };

    // No game today
    const score = scorePlayerForToday(player, batterProj[0], false);
    expect(score).toBe(0);

    // Has game today
    const scoreWithGame = scorePlayerForToday(player, batterProj[0], true);
    expect(scoreWithGame).toBeGreaterThan(0);
  });
});

describe("Matchup analysis with realistic data", () => {
  it("correctly identifies a winning matchup", () => {
    const matchup: Matchup = {
      week: 1,
      weekStart: "2026-03-30",
      weekEnd: "2026-04-05",
      opponentTeamKey: "mlb.l.12345.t.5",
      opponentTeamName: "Team Opponent",
      categories: [
        { category: "R", myValue: 45, opponentValue: 30 },
        { category: "H", myValue: 60, opponentValue: 42 },
        { category: "HR", myValue: 12, opponentValue: 8 },
        { category: "RBI", myValue: 40, opponentValue: 28 },
        { category: "SB", myValue: 5, opponentValue: 12 },
        { category: "TB", myValue: 110, opponentValue: 80 },
        { category: "OBP", myValue: 0.28, opponentValue: 0.25 },
        { category: "OUT", myValue: 120, opponentValue: 100 },
        { category: "K", myValue: 55, opponentValue: 48 },
        { category: "ERA", myValue: 3.2, opponentValue: 4.1 },
        { category: "WHIP", myValue: 1.15, opponentValue: 1.35 },
        { category: "QS", myValue: 4, opponentValue: 2 },
        { category: "SVHD", myValue: 5, opponentValue: 3 },
      ],
    };

    const analysis = analyzeMatchup(matchup);

    // Should be winning most categories
    expect(analysis.projectedWins).toBeGreaterThanOrEqual(8);
    expect(analysis.lostCategories).toContain("SB");
    expect(analysis.safeCategories.length).toBeGreaterThan(analysis.lostCategories.length);
    // Should recommend protecting ratios (ahead in ERA + WHIP)
    expect(analysis.strategy.protectRatios).toBe(true);
  });

  it("identifies swing categories in a tight matchup", () => {
    const matchup: Matchup = {
      week: 2,
      weekStart: "2026-04-06",
      weekEnd: "2026-04-12",
      opponentTeamKey: "mlb.l.12345.t.3",
      opponentTeamName: "Team Rival",
      categories: [
        { category: "R", myValue: 35, opponentValue: 33 },
        { category: "H", myValue: 50, opponentValue: 48 },
        { category: "HR", myValue: 10, opponentValue: 9 },
        { category: "RBI", myValue: 32, opponentValue: 30 },
        { category: "SB", myValue: 7, opponentValue: 7 },
        { category: "TB", myValue: 90, opponentValue: 85 },
        { category: "OBP", myValue: 0.265, opponentValue: 0.26 },
        { category: "OUT", myValue: 105, opponentValue: 102 },
        { category: "K", myValue: 50, opponentValue: 50 },
        { category: "ERA", myValue: 3.5, opponentValue: 3.6 },
        { category: "WHIP", myValue: 1.22, opponentValue: 1.25 },
        { category: "QS", myValue: 3, opponentValue: 3 },
        { category: "SVHD", myValue: 4, opponentValue: 4 },
      ],
    };

    const analysis = analyzeMatchup(matchup);

    // Most categories should be swing
    expect(analysis.swingCategories.length).toBeGreaterThan(5);
    expect(analysis.strategy.benchMessage.length).toBeGreaterThan(0);
  });
});

describe("Streaming pitcher scoring with real data", () => {
  it("ranks pitchers by matchup quality", async () => {
    const { projections } = await getRealProjections();
    const pitcherProj = projections.filter((p) => p.playerType === "pitcher" && p.pitching);

    const pitchers = pitcherProj.slice(0, 10).map((p) => ({
      player: {
        yahooId: p.yahooId,
        name: p.yahooId,
        team: "NYY",
        positions: ["SP"] as string[],
      },
      projection: p.pitching!,
    }));

    const games: ScheduledGame[] = [
      {
        gameId: 1,
        date: "2026-04-04",
        homeTeam: "NYY",
        awayTeam: "BOS",
        status: "scheduled",
      },
    ];

    const ranked = rankStreamingOptions(pitchers, games);

    expect(ranked.length).toBe(pitchers.length);
    // Sorted descending by score
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
    // Top pitcher should have positive score
    expect(ranked[0].score).toBeGreaterThan(0);
    expect(ranked[0].opponent).toBe("BOS");
  });
});
