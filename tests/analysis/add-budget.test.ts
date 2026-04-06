import { describe, it, expect } from "vitest";
import { classifyAddPriority, shouldSpendAdd } from "../../src/analysis/add-budget";
import type { AddBudgetState } from "../../src/analysis/add-budget";
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
    ...overrides,
  };
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

// --- shouldSpendAdd ---

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
