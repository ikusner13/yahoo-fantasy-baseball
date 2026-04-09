import { describe, it, expect } from "vite-plus/test";
import {
  evaluatePickup,
  findBestPickups,
  findDroppablePlayer,
  shouldUseWaiverPriority,
} from "../../src/analysis/waivers";
import type { PlayerValuation, RosterEntry, Category } from "../../src/types";
import type { MatchupAnalysis } from "../../src/analysis/matchup";

// --- Helpers ---

function valuation(
  yahooId: string,
  totalZScore: number,
  categoryZScores: Partial<Record<Category, number>> = {},
): PlayerValuation {
  return {
    yahooId,
    name: yahooId,
    totalZScore,
    categoryZScores,
    positionAdjustment: 1.0,
  };
}

function rosterEntry(
  yahooId: string,
  position: string = "Util",
  opts?: { positions?: string[]; team?: string },
): RosterEntry {
  return {
    player: {
      yahooId,
      name: yahooId,
      team: opts?.team ?? "",
      positions: opts?.positions ?? [],
    },
    currentPosition: position,
  };
}

function makeMatchup(
  swingCategories: Category[],
  safeCategories: Category[] = [],
  lostCategories: Category[] = [],
): MatchupAnalysis {
  return {
    projectedWins: safeCategories.length,
    projectedLosses: lostCategories.length,
    swingCategories,
    safeCategories,
    lostCategories,
    strategy: {
      protectRatios: false,
      chaseStrikeouts: false,
      prioritizePower: false,
      prioritizeSpeed: false,
      streamPitchers: false,
      benchMessage: "",
    },
  };
}

describe("waiver evaluation", () => {
  describe("evaluatePickup (no matchup)", () => {
    it("recommends pickup when FA z-score >> worst roster player", () => {
      const fa = valuation("fa1", 2.0);
      const roster = [rosterEntry("r1"), rosterEntry("r2")];
      const valMap = new Map<string, PlayerValuation>([
        ["r1", valuation("r1", 1.5)],
        ["r2", valuation("r2", -0.5)],
      ]);

      const rec = evaluatePickup(fa, roster, valMap);
      expect(rec).not.toBeNull();
      expect(rec!.drop.yahooId).toBe("r2");
      expect(rec!.netValue).toBeCloseTo(2.5);
    });

    it("returns null when FA is worse than all roster players", () => {
      const fa = valuation("fa1", -1.0);
      const roster = [rosterEntry("r1"), rosterEntry("r2")];
      const valMap = new Map<string, PlayerValuation>([
        ["r1", valuation("r1", 1.5)],
        ["r2", valuation("r2", 0.3)],
      ]);

      const rec = evaluatePickup(fa, roster, valMap);
      expect(rec).toBeNull();
    });

    it("skips IL players as drop candidates", () => {
      const fa = valuation("fa1", 2.0);
      const roster = [rosterEntry("r1", "Util"), rosterEntry("il1", "IL")];
      const valMap = new Map<string, PlayerValuation>([
        ["r1", valuation("r1", 1.0)],
        ["il1", valuation("il1", -5.0)],
      ]);

      const rec = evaluatePickup(fa, roster, valMap);
      expect(rec).not.toBeNull();
      // Should drop r1, not the IL player
      expect(rec!.drop.yahooId).toBe("r1");
    });
  });

  describe("evaluatePickup (matchup-aware)", () => {
    it("prioritizes swing category contribution over overall z-score", () => {
      // FA with modest overall z but great K z-score
      const faK = valuation("fa-k-specialist", 0.8, { K: 2.5, ERA: 0.2 });
      // FA with higher overall z but bad K z-score
      const faGeneric = valuation("fa-generic", 1.5, { K: 0.3, ERA: 1.0 });

      const roster = [rosterEntry("r1")];
      const worstVal = valuation("r1", -0.5, { K: -0.5, ERA: 0.0 });
      const valMap = new Map<string, PlayerValuation>([["r1", worstVal]]);

      // K is a swing category, ERA is lost
      const matchup = makeMatchup(["K"], [], ["ERA"]);

      const recK = evaluatePickup(faK, roster, valMap, matchup);
      const recGeneric = evaluatePickup(faGeneric, roster, valMap, matchup);

      // K specialist: swing(K) = (2.5 - (-0.5)) * 2.0 = 6.0, lost(ERA) = 0
      expect(recK).not.toBeNull();
      expect(recK!.netValue).toBeCloseTo(6.0);

      // Generic: swing(K) = (0.3 - (-0.5)) * 2.0 = 1.6, lost(ERA) = 0
      expect(recGeneric).not.toBeNull();
      expect(recGeneric!.netValue).toBeCloseTo(1.6);

      // K specialist should rank higher despite lower overall z-score
      expect(recK!.netValue).toBeGreaterThan(recGeneric!.netValue);
    });

    it("weights safe categories at 0.5x", () => {
      const fa = valuation("fa1", 1.0, { HR: 1.5, SB: 1.0 });
      const roster = [rosterEntry("r1")];
      const worstVal = valuation("r1", -0.5, { HR: 0.0, SB: 0.0 });
      const valMap = new Map<string, PlayerValuation>([["r1", worstVal]]);

      const matchup = makeMatchup(["HR"], ["SB"], []);

      const rec = evaluatePickup(fa, roster, valMap, matchup);
      expect(rec).not.toBeNull();
      // swing(HR) = 1.5 * 2.0 = 3.0, safe(SB) = 1.0 * 0.5 = 0.5
      expect(rec!.netValue).toBeCloseTo(3.5);
    });

    it("zeroes out lost category contributions", () => {
      // FA only contributes in a lost category
      const fa = valuation("fa1", 2.0, { RBI: 3.0 });
      const roster = [rosterEntry("r1")];
      const worstVal = valuation("r1", -0.5, { RBI: 0.0 });
      const valMap = new Map<string, PlayerValuation>([["r1", worstVal]]);

      // RBI is lost — should contribute 0
      const matchup = makeMatchup([], [], ["RBI"]);

      const rec = evaluatePickup(fa, roster, valMap, matchup);
      // net value = 0 (lost category only), below threshold
      expect(rec).toBeNull();
    });

    it("includes swing category names in reasoning", () => {
      const fa = valuation("fa1", 1.0, { K: 2.0, HR: 1.5 });
      const roster = [rosterEntry("r1")];
      const worstVal = valuation("r1", -0.5, { K: 0.0, HR: 0.0 });
      const valMap = new Map<string, PlayerValuation>([["r1", worstVal]]);

      const matchup = makeMatchup(["K", "HR"], [], []);
      const rec = evaluatePickup(fa, roster, valMap, matchup);

      expect(rec).not.toBeNull();
      expect(rec!.reasoning).toContain("Helps swing cats:");
      expect(rec!.reasoning).toContain("K");
    });
  });

  describe("findBestPickups", () => {
    it("returns pickups sorted by net value descending", () => {
      const fas = [valuation("fa1", 3.0), valuation("fa2", 2.0), valuation("fa3", 1.5)];
      const roster = [rosterEntry("r1")];
      const valMap = new Map<string, PlayerValuation>([["r1", valuation("r1", -0.5)]]);

      const recs = findBestPickups(fas, roster, valMap);
      expect(recs.length).toBe(3);
      expect(recs[0].add.yahooId).toBe("fa1");
      expect(recs[1].add.yahooId).toBe("fa2");
    });

    it("respects limit parameter", () => {
      const fas = [valuation("fa1", 3.0), valuation("fa2", 2.0), valuation("fa3", 1.5)];
      const roster = [rosterEntry("r1")];
      const valMap = new Map<string, PlayerValuation>([["r1", valuation("r1", -0.5)]]);

      const recs = findBestPickups(fas, roster, valMap, 1);
      expect(recs.length).toBe(1);
    });

    it("passes matchup through to scoring", () => {
      // fa-k has low overall z but high K z-score (swing cat)
      const faK = valuation("fa-k", 0.5, { K: 3.0 });
      // fa-generic has higher overall z but scores in lost category
      const faGeneric = valuation("fa-generic", 2.0, { RBI: 2.5 });

      const roster = [rosterEntry("r1")];
      const worstVal = valuation("r1", -0.5, { K: 0.0, RBI: 0.0 });
      const valMap = new Map<string, PlayerValuation>([["r1", worstVal]]);

      const matchup = makeMatchup(["K"], [], ["RBI"]);

      const recs = findBestPickups([faK, faGeneric], roster, valMap, 5, matchup);
      // K specialist should rank first since K is swing (2x) and RBI is lost (0x)
      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].add.yahooId).toBe("fa-k");
    });

    it("falls back to overall z-score when no matchup provided", () => {
      const faLowZ = valuation("fa-low", 1.5, { K: 3.0 });
      const faHighZ = valuation("fa-high", 3.0, { RBI: 2.5 });

      const roster = [rosterEntry("r1")];
      const valMap = new Map<string, PlayerValuation>([["r1", valuation("r1", -0.5)]]);

      const recs = findBestPickups([faLowZ, faHighZ], roster, valMap);
      // Without matchup, fa-high has higher overall z-score diff
      expect(recs[0].add.yahooId).toBe("fa-high");
    });
  });

  describe("shouldUseWaiverPriority", () => {
    it("uses matchup win-probability delta when available", () => {
      const shouldUse = shouldUseWaiverPriority(
        {
          add: { yahooId: "fa1", name: "fa1", team: "NYY", positions: ["OF"] },
          drop: { yahooId: "r1", name: "r1", team: "NYY", positions: ["OF"] },
          netValue: 0.2,
          reasoning: "small z upgrade but strong matchup swing",
          winProbabilityDelta: 0.03,
        },
        5,
      );

      expect(shouldUse).toBe(true);
    });
  });

  describe("findDroppablePlayer", () => {
    it("protects sole holder of scarce position (position scarcity)", () => {
      // Only one catcher on roster — should never be dropped
      // Need enough players so some fall below core threshold
      const roster = [
        rosterEntry("catcher", "C", { positions: ["C"] }),
        rosterEntry("stud", "Util", { positions: ["OF", "1B"] }),
        rosterEntry("ok", "Util", { positions: ["OF"] }),
        rosterEntry("bench-guy", "BN", { positions: ["OF"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["catcher", valuation("catcher", -1.0)], // worst z-score
        ["stud", valuation("stud", 2.0)],
        ["ok", valuation("ok", 0.5)],
        ["bench-guy", valuation("bench-guy", -0.5)],
      ]);
      // median of [-1.0, -0.5, 0.5, 2.0] = (-0.5+0.5)/2 = 0
      // catcher (-1.0) below median but sole C -> protected
      // bench-guy (-0.5) below median, not scarce -> droppable

      const drop = findDroppablePlayer(roster, valMap);
      expect(drop).not.toBeNull();
      // Should NOT drop the catcher even though they have the lowest z-score
      expect(drop!.player.yahooId).not.toBe("catcher");
      expect(drop!.player.yahooId).toBe("bench-guy");
    });

    it("allows dropping scarce-position player if another is eligible", () => {
      // Two SS-eligible players — safe to drop one
      const roster = [
        rosterEntry("ss1", "SS", { positions: ["SS"] }),
        rosterEntry("ss2", "BN", { positions: ["SS", "2B"] }),
        rosterEntry("of1", "OF", { positions: ["OF"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["ss1", valuation("ss1", -0.8)],
        ["ss2", valuation("ss2", 0.3)],
        ["of1", valuation("of1", 1.5)],
      ]);

      const drop = findDroppablePlayer(roster, valMap);
      expect(drop).not.toBeNull();
      expect(drop!.player.yahooId).toBe("ss1");
    });

    it("protects core players (top 50% by z-score)", () => {
      const roster = [
        rosterEntry("stud", "OF", { positions: ["OF"] }),
        rosterEntry("ok", "OF", { positions: ["OF"] }),
        rosterEntry("bad", "BN", { positions: ["OF"] }),
        rosterEntry("worst", "BN", { positions: ["OF"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["stud", valuation("stud", 3.0)],
        ["ok", valuation("ok", 1.0)],
        ["bad", valuation("bad", -0.5)],
        ["worst", valuation("worst", -1.5)],
      ]);
      // median of [-1.5, -0.5, 1.0, 3.0] = (-0.5 + 1.0) / 2 = 0.25
      // core = stud (3.0), ok (1.0) — both >= 0.25
      // droppable = bad (-0.5), worst (-1.5)

      const drop = findDroppablePlayer(roster, valMap);
      expect(drop).not.toBeNull();
      expect(drop!.player.yahooId).toBe("worst");
    });

    it("allows dropping core with elite override", () => {
      // 3 players, all above median -> all core without override
      const roster = [
        rosterEntry("stud", "OF", { positions: ["OF"] }),
        rosterEntry("good", "OF", { positions: ["OF"] }),
        rosterEntry("ok", "OF", { positions: ["OF"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["stud", valuation("stud", 3.0)],
        ["good", valuation("good", 2.0)],
        ["ok", valuation("ok", 2.0)],
      ]);
      // median (odd count=3) = middle value = 2.0
      // All >= 2.0 -> all core without override
      const dropNormal = findDroppablePlayer(roster, valMap);
      expect(dropNormal).toBeNull();

      // With elite override: ok and good both at 2.0, stud at 3.0
      const dropElite = findDroppablePlayer(roster, valMap, undefined, {
        eliteOverride: true,
      });
      expect(dropElite).not.toBeNull();
      // Should drop one of the 2.0 z-score players (lowest z tiebreaker among equal)
      expect(dropElite!.player.yahooId).not.toBe("stud");
    });

    it("prefers dropping players without a game today", () => {
      // 4 players: 2 studs (core) + 2 droppable candidates
      const roster = [
        rosterEntry("stud1", "OF", { positions: ["OF"], team: "NYY" }),
        rosterEntry("stud2", "OF", { positions: ["OF"], team: "NYY" }),
        rosterEntry("playing", "OF", { positions: ["OF"], team: "NYY" }),
        rosterEntry("offday", "OF", { positions: ["OF"], team: "LAD" }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["stud1", valuation("stud1", 3.0)],
        ["stud2", valuation("stud2", 2.0)],
        ["playing", valuation("playing", -0.5)],
        ["offday", valuation("offday", -0.3)],
      ]);
      // sorted: [-0.5, -0.3, 2.0, 3.0], median = (-0.3+2.0)/2 = 0.85
      // playing and offday both below median -> droppable
      const drop = findDroppablePlayer(roster, valMap, undefined, {
        teamsPlayingToday: new Set(["NYY"]),
      });
      expect(drop).not.toBeNull();
      // offday (LAD) not playing today -> preferred drop over playing (NYY)
      expect(drop!.player.yahooId).toBe("offday");
    });

    it("prefers dropping at positions with most depth", () => {
      const roster = [
        rosterEntry("of1", "OF", { positions: ["OF"] }),
        rosterEntry("of2", "OF", { positions: ["OF"] }),
        rosterEntry("of3", "OF", { positions: ["OF"] }),
        rosterEntry("sp1", "SP", { positions: ["SP"] }),
        rosterEntry("sp2", "SP", { positions: ["SP"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["of1", valuation("of1", -0.5)],
        ["of2", valuation("of2", -0.4)],
        ["of3", valuation("of3", -0.3)],
        ["sp1", valuation("sp1", -0.5)],
        ["sp2", valuation("sp2", -0.4)],
      ]);
      // OF depth=3 per OF player, SP depth=2 per SP player.
      // Prefer dropping OF (more depth) over SP at same z-score.
      const drop = findDroppablePlayer(roster, valMap);
      expect(drop).not.toBeNull();
      expect(drop!.player.positions).toContain("OF");
    });

    it("applies position filter", () => {
      // Add high-z players so sp1 falls below median
      const roster = [
        rosterEntry("stud1", "OF", { positions: ["OF"] }),
        rosterEntry("stud2", "OF", { positions: ["OF"] }),
        rosterEntry("sp1", "SP", { positions: ["SP"] }),
        rosterEntry("of1", "OF", { positions: ["OF"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["stud1", valuation("stud1", 3.0)],
        ["stud2", valuation("stud2", 2.0)],
        ["sp1", valuation("sp1", -0.5)],
        ["of1", valuation("of1", -1.0)], // lower z but wrong position
      ]);
      // sorted: [-1.0, -0.5, 2.0, 3.0], median = (-0.5+2.0)/2 = 0.75
      // sp1 (-0.5 < 0.75) droppable, of1 (-1.0 < 0.75) droppable
      // With position filter "SP", only sp1 considered
      const drop = findDroppablePlayer(roster, valMap, "SP");
      expect(drop).not.toBeNull();
      expect(drop!.player.yahooId).toBe("sp1");
    });
  });

  describe("evaluatePickup (drop protection)", () => {
    it("protects sole catcher from being dropped", () => {
      const fa = valuation("fa1", 1.5);
      const roster = [
        rosterEntry("catcher", "C", { positions: ["C"] }),
        rosterEntry("stud-of", "OF", { positions: ["OF"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["catcher", valuation("catcher", -1.0)],
        ["stud-of", valuation("stud-of", 2.0)],
      ]);

      // Catcher is sole C-eligible + worst z. Stud-OF is core.
      // Without elite override: catcher protected (sole C), stud-of protected (core).
      // With elite override: catcher still protected (sole C), stud-of available.
      // fa net vs stud-of = 1.5 - 2.0 = -0.5, below threshold -> null.
      const rec = evaluatePickup(fa, roster, valMap);
      expect(rec).toBeNull();
    });

    it("protects core players unless elite upgrade", () => {
      const roster = [
        rosterEntry("ok", "OF", { positions: ["OF"] }),
        rosterEntry("good", "OF", { positions: ["OF"] }),
        rosterEntry("great", "OF", { positions: ["OF"] }),
        rosterEntry("bench", "BN", { positions: ["OF"] }),
      ];
      const valMap = new Map<string, PlayerValuation>([
        ["ok", valuation("ok", 0.5)],
        ["good", valuation("good", 1.5)],
        ["great", valuation("great", 2.5)],
        ["bench", valuation("bench", -0.5)],
      ]);
      // median of [-0.5, 0.5, 1.5, 2.5] = (0.5 + 1.5)/2 = 1.0
      // droppable without override: bench (-0.5), ok (0.5) — both < 1.0

      // Marginal FA — should drop bench, not core
      const marginalFA = valuation("fa-marginal", 1.0);
      const rec1 = evaluatePickup(marginalFA, roster, valMap);
      expect(rec1).not.toBeNull();
      expect(rec1!.drop.yahooId).toBe("bench");

      // Elite FA — could drop a core player
      const eliteFA = valuation("fa-elite", 5.0);
      const rec2 = evaluatePickup(eliteFA, roster, valMap);
      expect(rec2).not.toBeNull();
      // bench is droppable in base pass, so it picks bench (highest net from base)
      expect(rec2!.drop.yahooId).toBe("bench");
      expect(rec2!.netValue).toBeCloseTo(5.5);
    });
  });

  describe("shouldUseWaiverPriority", () => {
    const makeRec = (netValue: number) => ({
      add: { yahooId: "a", name: "a", team: "", positions: [] as string[] },
      drop: { yahooId: "b", name: "b", team: "", positions: [] as string[] },
      netValue,
      reasoning: "",
    });

    it("high priority (1-3) uses aggressive threshold", () => {
      expect(shouldUseWaiverPriority(makeRec(0.6), 1)).toBe(true);
      expect(shouldUseWaiverPriority(makeRec(0.3), 2)).toBe(false);
    });

    it("mid priority (4-8) uses moderate threshold", () => {
      expect(shouldUseWaiverPriority(makeRec(1.6), 5)).toBe(true);
      expect(shouldUseWaiverPriority(makeRec(1.0), 6)).toBe(false);
    });

    it("low priority (9-12) uses conservative threshold", () => {
      expect(shouldUseWaiverPriority(makeRec(3.5), 10)).toBe(true);
      expect(shouldUseWaiverPriority(makeRec(2.0), 11)).toBe(false);
    });
  });
});
