import { describe, it, expect } from "vitest";
import {
  classifyAddPriority,
  shouldSpendAdd,
  canSpendAdd,
  computeAllocation,
} from "../../src/analysis/add-budget";
import type { AddBudgetState, MatchupNeeds } from "../../src/analysis/add-budget";
import type { PickupRecommendation } from "../../src/analysis/waivers";
import type { Player } from "../../src/types";

// --- Helpers ---

function makePlayer(name = "Test Player"): Player {
  return {
    yahooId: "123",
    name,
    team: "NYY",
    positions: ["SP"],
  };
}

function makeRec(netValue: number): PickupRecommendation {
  return {
    add: makePlayer("Add Target"),
    drop: makePlayer("Drop Candidate"),
    netValue,
    reasoning: "test",
  };
}

function makeBudget(overrides: Partial<AddBudgetState> = {}): AddBudgetState {
  return {
    weekStart: "2026-03-30",
    addsUsed: 0,
    addsRemaining: 6,
    reserveForReactions: 2,
    streamingAddsUsed: 0,
    waiverAddsUsed: 0,
    emergencyAddsUsed: 0,
    ...overrides,
  };
}

/** Create a Date for a specific day of week. 0=Sun, 1=Mon, ... */
function dateForDay(day: number): Date {
  // 2026-04-06 is a Monday
  const monday = new Date("2026-04-06T12:00:00Z");
  const offset = day === 0 ? 6 : day - 1; // Mon=0 offset, Tue=1, ..., Sun=6
  const d = new Date(monday);
  d.setDate(d.getDate() + offset);
  return d;
}

// --- classifyAddPriority ---

describe("classifyAddPriority", () => {
  it("isCloserChange=true -> critical", () => {
    expect(classifyAddPriority(makeRec(0.5), { isCloserChange: true })).toBe("critical");
  });

  it("isInjuryReplacement=true -> critical", () => {
    expect(classifyAddPriority(makeRec(0.5), { isInjuryReplacement: true })).toBe("critical");
  });

  it("netValue=2.5 -> high", () => {
    expect(classifyAddPriority(makeRec(2.5), {})).toBe("high");
  });

  it("netValue=1.5 -> medium", () => {
    expect(classifyAddPriority(makeRec(1.5), {})).toBe("medium");
  });

  it("netValue=0.5 -> low", () => {
    expect(classifyAddPriority(makeRec(0.5), {})).toBe("low");
  });
});

// --- shouldSpendAdd (backward compat) ---

describe("shouldSpendAdd", () => {
  it("critical -> always true regardless of budget", () => {
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 0 }), "critical")).toBe(true);
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 6 }), "critical")).toBe(true);
  });

  it("high + addsRemaining=1 -> true", () => {
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 1 }), "high")).toBe(true);
  });

  it("high + addsRemaining=0 -> false", () => {
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 0 }), "high")).toBe(false);
  });

  it("medium + addsRemaining=3, reserveForReactions=2 -> true (3 > 2)", () => {
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 3, reserveForReactions: 2 }), "medium")).toBe(
      true,
    );
  });

  it("medium + addsRemaining=2, reserveForReactions=2 -> false (2 not > 2)", () => {
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 2, reserveForReactions: 2 }), "medium")).toBe(
      false,
    );
  });

  it("low + addsRemaining=4, reserveForReactions=2 -> true (4 > 3)", () => {
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 4, reserveForReactions: 2 }), "low")).toBe(
      true,
    );
  });

  it("low + addsRemaining=3, reserveForReactions=2 -> false (3 not > 3)", () => {
    expect(shouldSpendAdd(makeBudget({ addsRemaining: 3, reserveForReactions: 2 }), "low")).toBe(
      false,
    );
  });
});

// --- computeAllocation ---

describe("computeAllocation", () => {
  it("early week (Mon) reserves emergency adds", () => {
    const budget = makeBudget();
    const alloc = computeAllocation(budget, undefined, dateForDay(1));
    expect(alloc.emergency).toBe(3);
    expect(alloc.streaming).toBe(2);
    expect(alloc.waivers).toBe(1);
    expect(alloc.total).toBe(6);
  });

  it("mid week (Wed) balanced allocation", () => {
    const budget = makeBudget();
    const alloc = computeAllocation(budget, undefined, dateForDay(3));
    expect(alloc.streaming).toBe(2);
    expect(alloc.waivers).toBe(2);
    expect(alloc.emergency).toBe(2);
    expect(alloc.total).toBe(6);
  });

  it("end of week (Fri) spends freely, no emergency reserve", () => {
    const budget = makeBudget();
    const alloc = computeAllocation(budget, undefined, dateForDay(5));
    expect(alloc.streaming).toBe(3);
    expect(alloc.waivers).toBe(3);
    expect(alloc.emergency).toBe(0);
    expect(alloc.total).toBe(6);
  });

  it("scales down when adds already used", () => {
    const budget = makeBudget({ streamingAddsUsed: 2, waiverAddsUsed: 2 });
    const alloc = computeAllocation(budget, undefined, dateForDay(1));
    // remaining = 2, raw total = 6, must scale
    expect(alloc.total).toBeLessThanOrEqual(2);
  });

  it("pitching swing cats boost streaming allocation", () => {
    const budget = makeBudget();
    const needs: MatchupNeeds = { swingCategories: ["K", "QS"] };
    const alloc = computeAllocation(budget, needs, dateForDay(3));
    // Wed base: s=2, w=2, e=2 -> pitching boost: s=3, w=1, e=2
    expect(alloc.streaming).toBe(3);
    expect(alloc.waivers).toBe(1);
  });

  it("batting swing cats boost waiver allocation", () => {
    const budget = makeBudget();
    const needs: MatchupNeeds = { swingCategories: ["HR", "RBI"] };
    const alloc = computeAllocation(budget, needs, dateForDay(3));
    // Wed base: s=2, w=2, e=2 -> batting boost: s=1, w=3, e=2
    expect(alloc.waivers).toBe(3);
    expect(alloc.streaming).toBe(1);
  });

  it("promotes unused emergency budget on Thursday+", () => {
    const budget = makeBudget({ emergencyAddsUsed: 0 });
    const alloc = computeAllocation(budget, undefined, dateForDay(4));
    // Thu base: s=2, w=2, e=2. Promote 2 unused emergency: s gets 1, w gets 1
    expect(alloc.emergency).toBe(0);
    expect(alloc.streaming).toBe(3);
    expect(alloc.waivers).toBe(3);
    expect(alloc.total).toBe(6);
  });
});

// --- canSpendAdd ---

describe("canSpendAdd", () => {
  it("critical always allowed even with zero budget", () => {
    const budget = makeBudget({
      streamingAddsUsed: 3,
      waiverAddsUsed: 2,
      emergencyAddsUsed: 1,
    });
    expect(canSpendAdd(budget, "streaming", "critical", undefined, dateForDay(1))).toBe(true);
  });

  it("early-week streaming blocked when streaming bucket exhausted", () => {
    // Mon: streaming alloc = 2, already used 2
    const budget = makeBudget({ streamingAddsUsed: 2 });
    expect(canSpendAdd(budget, "streaming", "high", undefined, dateForDay(1))).toBe(false);
  });

  it("early-week waiver allowed within allocation", () => {
    // Mon: waiver alloc = 1, used 0 -> 1 remaining, "high" needs > 0
    const budget = makeBudget();
    expect(canSpendAdd(budget, "waiver", "high", undefined, dateForDay(1))).toBe(true);
  });

  it("end-of-week streaming has room to spend freely", () => {
    // Fri: streaming alloc = 3, used 0
    const budget = makeBudget();
    expect(canSpendAdd(budget, "streaming", "high", undefined, dateForDay(5))).toBe(true);
    expect(canSpendAdd(budget, "streaming", "medium", undefined, dateForDay(5))).toBe(true);
  });

  it("returns false when total adds exhausted (non-critical)", () => {
    const budget = makeBudget({
      streamingAddsUsed: 2,
      waiverAddsUsed: 2,
      emergencyAddsUsed: 2,
    });
    expect(canSpendAdd(budget, "streaming", "high", undefined, dateForDay(3))).toBe(false);
    expect(canSpendAdd(budget, "waiver", "high", undefined, dateForDay(3))).toBe(false);
  });

  it("medium priority requires >1 in bucket", () => {
    // Mon: streaming = 2, used 1 -> 1 remaining, medium needs > 1 -> false
    const budget = makeBudget({ streamingAddsUsed: 1 });
    expect(canSpendAdd(budget, "streaming", "medium", undefined, dateForDay(1))).toBe(false);
  });

  it("low priority requires >2 in bucket", () => {
    // Fri: streaming = 3, used 0 -> 3 remaining, low needs > 2 -> true
    const budget = makeBudget();
    expect(canSpendAdd(budget, "streaming", "low", undefined, dateForDay(5))).toBe(true);
    // used 1 -> 2 remaining, low needs > 2 -> false
    const budget2 = makeBudget({ streamingAddsUsed: 1 });
    expect(canSpendAdd(budget2, "streaming", "low", undefined, dateForDay(5))).toBe(false);
  });
});
