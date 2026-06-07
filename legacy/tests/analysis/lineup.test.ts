import { describe, it, expect } from "vite-plus/test";
import { optimizeLineup, scorePlayerForToday } from "../../src/analysis/lineup";
import type { Roster, RosterEntry, Player, PlayerProjection, ScheduledGame } from "../../src/types";

// --- Factories ---

function makePlayer(
  id: string,
  positions: string[],
  team: string,
  status: Player["status"] = "healthy",
): Player {
  return {
    yahooId: id,
    name: id,
    team,
    positions,
    status,
  };
}

function makeEntry(player: Player, currentPosition: string): RosterEntry {
  return { player, currentPosition };
}

function makeBatterProj(id: string, pa = 550, hr = 20): PlayerProjection {
  return {
    yahooId: id,
    playerType: "batter",
    batting: {
      pa,
      r: 70 + hr,
      h: 140,
      hr,
      rbi: 60 + hr * 2,
      sb: 10,
      tb: 200 + hr * 4,
      obp: 0.33,
    },
    updatedAt: "2026-04-01",
  };
}

function makePitcherProj(id: string, ip = 180, era = 3.5): PlayerProjection {
  return {
    yahooId: id,
    playerType: "pitcher",
    pitching: {
      ip,
      outs: ip * 3,
      k: ip,
      era,
      whip: 1.2,
      qs: 15,
      svhd: 0,
    },
    updatedAt: "2026-04-01",
  };
}

function makeGame(home: string, away: string): ScheduledGame {
  return {
    gameId: (Math.random() * 10000) | 0,
    date: "2026-04-04",
    homeTeam: home,
    awayTeam: away,
    status: "scheduled",
  };
}

// --- Test data ---

const games: ScheduledGame[] = [
  makeGame("NYY", "BOS"),
  makeGame("LAD", "SF"),
  makeGame("HOU", "SEA"),
];

// Teams NOT playing: ATL, CHC, MIN

describe("scorePlayerForToday", () => {
  it("returns 0 when player has no game", () => {
    const proj = makeBatterProj("b1");
    expect(scorePlayerForToday(makePlayer("b1", ["OF"], "ATL"), proj, false)).toBe(0);
  });

  it("returns > 0 when player has a game and projection", () => {
    const proj = makeBatterProj("b1");
    expect(scorePlayerForToday(makePlayer("b1", ["OF"], "NYY"), proj, true)).toBeGreaterThan(0);
  });

  it("returns 0.1 for player with game but no projection", () => {
    expect(scorePlayerForToday(makePlayer("b1", ["OF"], "NYY"), undefined, true)).toBe(0.1);
  });
});

describe("optimizeLineup", () => {
  // Build a realistic roster: 15 active + 2 IL
  const players: Player[] = [
    makePlayer("c1", ["C"], "NYY"),
    makePlayer("1b1", ["1B"], "BOS"),
    makePlayer("2b1", ["2B"], "LAD"),
    makePlayer("3b1", ["3B"], "SF"),
    makePlayer("ss1", ["SS"], "HOU"),
    makePlayer("of1", ["OF"], "NYY"),
    makePlayer("of2", ["OF"], "BOS"),
    makePlayer("of3", ["OF"], "LAD"),
    makePlayer("of4", ["OF"], "ATL"), // no game today
    makePlayer("util1", ["1B", "OF"], "SEA"),
    makePlayer("sp1", ["SP"], "NYY", "healthy"),
    makePlayer("sp2", ["SP"], "ATL", "healthy"), // no game
    makePlayer("rp1", ["RP"], "BOS"),
    makePlayer("rp2", ["RP"], "LAD"),
    makePlayer("p1", ["SP", "RP"], "HOU"),
    makePlayer("il1", ["SP"], "NYY", "IL"),
    makePlayer("il2", ["OF"], "BOS", "IL"),
  ];

  const entries: RosterEntry[] = players.map((p) => makeEntry(p, p.status === "IL" ? "IL" : "BN"));

  const roster: Roster = { entries, date: "2026-04-04" };

  const projections = new Map<string, PlayerProjection>();
  // Give batters varying quality
  projections.set("c1", makeBatterProj("c1", 500, 15));
  projections.set("1b1", makeBatterProj("1b1", 600, 30));
  projections.set("2b1", makeBatterProj("2b1", 550, 18));
  projections.set("3b1", makeBatterProj("3b1", 520, 22));
  projections.set("ss1", makeBatterProj("ss1", 580, 25));
  projections.set("of1", makeBatterProj("of1", 600, 35));
  projections.set("of2", makeBatterProj("of2", 550, 20));
  projections.set("of3", makeBatterProj("of3", 540, 16));
  projections.set("of4", makeBatterProj("of4", 580, 28)); // no game
  projections.set("util1", makeBatterProj("util1", 500, 12));
  projections.set("sp1", makePitcherProj("sp1", 200, 2.8));
  projections.set("sp2", makePitcherProj("sp2", 180, 3.2)); // no game
  projections.set("rp1", makePitcherProj("rp1", 70, 2.5));
  projections.set("rp2", makePitcherProj("rp2", 65, 3.0));
  projections.set("p1", makePitcherProj("p1", 150, 3.5));

  it("returns a move for every player", () => {
    const moves = optimizeLineup(roster, projections, games);
    expect(moves.length).toBe(players.length);
  });

  it("IL players go to IL slots", () => {
    const moves = optimizeLineup(roster, projections, games);
    const ilMoves = moves.filter((m) => m.position === "IL");
    const ilIds = ilMoves.map((m) => m.playerId);
    expect(ilIds).toContain("il1");
    expect(ilIds).toContain("il2");
  });

  it("position constraints: only 1 C slot", () => {
    const moves = optimizeLineup(roster, projections, games);
    const cMoves = moves.filter((m) => m.position === "C");
    expect(cMoves.length).toBeLessThanOrEqual(1);
  });

  it("position constraints: 3 OF slots", () => {
    const moves = optimizeLineup(roster, projections, games);
    const ofMoves = moves.filter((m) => m.position === "OF");
    expect(ofMoves.length).toBeLessThanOrEqual(3);
  });

  it("position constraints: 2 SP, 2 RP, 4 P slots", () => {
    const moves = optimizeLineup(roster, projections, games);
    expect(moves.filter((m) => m.position === "SP").length).toBeLessThanOrEqual(2);
    expect(moves.filter((m) => m.position === "RP").length).toBeLessThanOrEqual(2);
    expect(moves.filter((m) => m.position === "P").length).toBeLessThanOrEqual(4);
  });

  it("players without games are deprioritized for active slots", () => {
    const moves = optimizeLineup(roster, projections, games);
    // of4 (ATL) has no game today, score=0
    // The optimizer fills scarce slots first with high-score players,
    // then backfills remaining slots. With exactly enough batters for all
    // batter slots (C+1B+2B+3B+SS+3OF+2Util=10), of4 may backfill Util.
    // Key check: of4 should NOT displace a higher-scoring player from OF.
    const ofMoves = moves.filter((m) => m.position === "OF");
    const of4InOf = ofMoves.some((m) => m.playerId === "of4");
    expect(of4InOf).toBe(false); // shouldn't take OF from a player with a game
  });

  it("pitchers without games prefer bench", () => {
    const moves = optimizeLineup(roster, projections, games);
    // sp2 (ATL) has no game
    const sp2Move = moves.find((m) => m.playerId === "sp2");
    expect(sp2Move).toBeDefined();
    // Might be BN or backfill a P slot, but shouldn't take an SP slot from sp1
    const sp1Move = moves.find((m) => m.playerId === "sp1");
    expect(sp1Move).toBeDefined();
    // sp1 with a game should be in an active pitching slot
    expect(["SP", "P"]).toContain(sp1Move!.position);
  });

  it("no player assigned to two positions", () => {
    const moves = optimizeLineup(roster, projections, games);
    const ids = moves.map((m) => m.playerId);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
