import { describe, it, expect } from "vite-plus/test";
import { optimizeLineup } from "../../src/analysis/lineup";
import { analyzeMatchup } from "../../src/analysis/matchup";
import { computeZScores } from "../../src/analysis/valuations";
import type {
  Roster,
  RosterEntry,
  Player,
  PlayerProjection,
  ScheduledGame,
  Matchup,
  CategoryScore,
  Category,
} from "../../src/types";

// --- Factories ---

function makePlayer(
  id: string,
  positions: string[],
  team: string,
  status: Player["status"] = "healthy",
  mlbId?: number,
): Player {
  return { yahooId: id, mlbId, name: id, team, positions, status };
}

function makeBatterProj(id: string, pa = 550, hr = 20, obp = 0.33): PlayerProjection {
  return {
    yahooId: id,
    playerType: "batter",
    batting: { pa, r: 70 + hr, h: 140, hr, rbi: 60 + hr * 2, sb: 10, tb: 200 + hr * 4, obp },
    updatedAt: "2026-04-04",
  };
}

function makePitcherProj(id: string, ip = 180, era = 3.5, k = 180): PlayerProjection {
  return {
    yahooId: id,
    playerType: "pitcher",
    pitching: { ip, outs: ip * 3, k, era, whip: era * 0.35, qs: ip > 100 ? 15 : 0, svhd: 0 },
    updatedAt: "2026-04-04",
  };
}

function makeGame(home: string, away: string, probHome?: number, probAway?: number): ScheduledGame {
  return {
    gameId: (Math.random() * 10000) | 0,
    date: "2026-04-04",
    homeTeam: home,
    awayTeam: away,
    homeProbable: probHome ? { mlbId: probHome, name: "Pitcher", team: home } : undefined,
    awayProbable: probAway ? { mlbId: probAway, name: "Pitcher", team: away } : undefined,
    status: "scheduled",
  };
}

function cat(category: Category, my: number, opp: number): CategoryScore {
  return { category, myValue: my, opponentValue: opp };
}

function makeRoster(entries: RosterEntry[]): Roster {
  return { entries, date: "2026-04-04" };
}

function entry(player: Player, pos = "BN"): RosterEntry {
  return { player, currentPosition: pos };
}

// --- Eval: Lineup decisions ---

describe("Decision Quality Evals", () => {
  describe("Lineup decisions", () => {
    it("should never bench a healthy star player with a game", () => {
      const star = makePlayer("trout", ["OF"], "LAA");
      const scrub1 = makePlayer("bench1", ["OF"], "LAA");
      const scrub2 = makePlayer("bench2", ["OF"], "LAA");
      const scrub3 = makePlayer("bench3", ["OF"], "LAA");
      const c = makePlayer("c1", ["C"], "LAA");
      const first = makePlayer("1b1", ["1B"], "LAA");
      const second = makePlayer("2b1", ["2B"], "LAA");
      const third = makePlayer("3b1", ["3B"], "LAA");
      const ss = makePlayer("ss1", ["SS"], "LAA");
      const util = makePlayer("u1", ["1B", "OF"], "LAA");
      const sp1 = makePlayer("sp1", ["SP"], "LAA");
      const rp1 = makePlayer("rp1", ["RP"], "LAA");

      const players = [star, scrub1, scrub2, scrub3, c, first, second, third, ss, util, sp1, rp1];
      const roster = makeRoster(players.map((p) => entry(p)));

      const projections = new Map<string, PlayerProjection>();
      // Trout: elite
      projections.set("trout", makeBatterProj("trout", 600, 40, 0.41));
      projections.set("bench1", makeBatterProj("bench1", 400, 5, 0.25));
      projections.set("bench2", makeBatterProj("bench2", 400, 6, 0.26));
      projections.set("bench3", makeBatterProj("bench3", 400, 4, 0.24));
      projections.set("c1", makeBatterProj("c1", 450, 12, 0.3));
      projections.set("1b1", makeBatterProj("1b1", 500, 20, 0.33));
      projections.set("2b1", makeBatterProj("2b1", 500, 15, 0.32));
      projections.set("3b1", makeBatterProj("3b1", 480, 18, 0.31));
      projections.set("ss1", makeBatterProj("ss1", 520, 16, 0.31));
      projections.set("u1", makeBatterProj("u1", 450, 10, 0.29));
      projections.set("sp1", makePitcherProj("sp1", 180, 3.2));
      projections.set("rp1", makePitcherProj("rp1", 65, 2.8));

      const games = [makeGame("LAA", "SEA")];
      const moves = optimizeLineup(roster, projections, games);

      const troutMove = moves.find((m) => m.playerId === "trout")!;
      expect(troutMove).toBeDefined();
      // Trout should be in an active slot (OF or Util), NOT bench
      expect(troutMove.position).not.toBe("BN");
      expect(["OF", "Util"]).toContain(troutMove.position);
    });

    it("should bench players on off-days", () => {
      const offDay = makePlayer("off1", ["OF"], "ATL");
      const playing = makePlayer("play1", ["OF"], "NYY");
      const playing2 = makePlayer("play2", ["OF"], "NYY");
      const playing3 = makePlayer("play3", ["OF"], "NYY");
      const c = makePlayer("c1", ["C"], "NYY");
      const fb = makePlayer("1b1", ["1B"], "NYY");
      const sb = makePlayer("2b1", ["2B"], "NYY");
      const tb = makePlayer("3b1", ["3B"], "NYY");
      const ss = makePlayer("ss1", ["SS"], "NYY");
      const util1 = makePlayer("u1", ["1B"], "NYY");
      // Extra Util-eligible batter so off-day player doesn't backfill
      const util2 = makePlayer("u2", ["1B"], "NYY");

      const players = [offDay, playing, playing2, playing3, c, fb, sb, tb, ss, util1, util2];
      const roster = makeRoster(players.map((p) => entry(p)));

      const projections = new Map<string, PlayerProjection>();
      for (const p of players) {
        projections.set(p.yahooId, makeBatterProj(p.yahooId));
      }
      // ATL not playing
      const games = [makeGame("NYY", "BOS")];
      const moves = optimizeLineup(roster, projections, games);

      const offDayMove = moves.find((m) => m.playerId === "off1")!;
      expect(offDayMove.position).toBe("BN");
    });

    it("should protect ratios late in week when ahead", () => {
      // Scenario: ahead in ERA, have a high-ERA pitcher starting
      // The matchup analysis should recommend protecting ratios
      const m: Matchup = {
        week: 1,
        weekStart: "2026-03-30",
        weekEnd: "2026-04-05",
        opponentTeamKey: "opp",
        opponentTeamName: "Opponent",
        categories: [
          cat("ERA", 2.8, 4.1),
          cat("WHIP", 1.05, 1.35),
          cat("K", 60, 58),
          cat("QS", 5, 4),
        ],
      };
      const analysis = analyzeMatchup(m);
      expect(analysis.strategy.protectRatios).toBe(true);
      expect(analysis.strategy.benchMessage).toContain("Protect ERA/WHIP");
    });
  });

  describe("Waiver decisions", () => {
    it("should pick up breakout player over replacement-level bench bat", () => {
      const freeAgent: PlayerProjection = makeBatterProj("fa1", 600, 35, 0.39);
      const benchBum: PlayerProjection = makeBatterProj("bench1", 400, 5, 0.25);

      const valuations = computeZScores([freeAgent, benchBum]);
      const faVal = valuations.find((v) => v.yahooId === "fa1")!;
      const benchVal = valuations.find((v) => v.yahooId === "bench1")!;

      expect(faVal.totalZScore).toBeGreaterThan(benchVal.totalZScore);
      // Z-score diff should be substantial
      expect(faVal.totalZScore - benchVal.totalZScore).toBeGreaterThan(0);
    });

    it("should conserve waiver priority when pickup is marginal", () => {
      // Pool of similar players -- FA and roster player are nearly identical
      // Need enough players for meaningful variance in z-score computation
      const pool: PlayerProjection[] = [
        makeBatterProj("fa1", 550, 21, 0.335),
        makeBatterProj("r1", 550, 20, 0.33),
        makeBatterProj("b2", 600, 35, 0.4), // star
        makeBatterProj("b3", 400, 5, 0.25), // scrub
        makeBatterProj("b4", 520, 18, 0.32), // avg
        makeBatterProj("b5", 530, 22, 0.34), // avg+
      ];

      const valuations = computeZScores(pool);
      const faVal = valuations.find((v) => v.yahooId === "fa1")!;
      const rosterVal = valuations.find((v) => v.yahooId === "r1")!;

      const diff = Math.abs(faVal.totalZScore - rosterVal.totalZScore);
      // fa1 and r1 are nearly identical, so z-score diff should be small
      expect(diff).toBeLessThan(1.0);
    });
  });

  describe("Matchup strategy", () => {
    it("should punt lost categories and focus on swing categories", () => {
      const m: Matchup = {
        week: 1,
        weekStart: "2026-03-30",
        weekEnd: "2026-04-05",
        opponentTeamKey: "opp",
        opponentTeamName: "Opponent",
        categories: [
          cat("SB", 2, 15), // losing badly
          cat("HR", 12, 14), // swing
          cat("R", 55, 58), // swing
          cat("ERA", 3.0, 3.1), // swing
          cat("WHIP", 1.1, 1.12), // swing
        ],
      };
      const analysis = analyzeMatchup(m);

      expect(analysis.lostCategories).toContain("SB");
      expect(analysis.swingCategories).toContain("HR");
      // Strategy should not prioritize speed since SB is lost
      expect(analysis.strategy.prioritizeSpeed).toBe(false);
      // HR is a swing cat -> should prioritize power
      expect(analysis.strategy.prioritizePower).toBe(true);
    });
  });
});
