import { describe, expect, it } from "vite-plus/test";

import {
  buildDailyLineupReport,
  DailyLineupPlayer,
  DailyLineupSlotCount,
} from "../../src/services/DailyLineupAdvisor";

const player = (overrides: Partial<ConstructorParameters<typeof DailyLineupPlayer>[0]> = {}) =>
  new DailyLineupPlayer({
    playerKey: "player",
    playerId: "1",
    name: "Player",
    team: "NYY",
    eligiblePositions: ["Util"],
    selectedPosition: "BN",
    ...overrides,
  });

describe("DailyLineupAdvisor", () => {
  it("prioritizes moving hard-unavailable active players to open IL capacity", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "injured-catcher",
          playerId: "10",
          name: "Injured Catcher",
          eligiblePositions: ["C", "Util", "IL"],
          selectedPosition: "C",
          status: "IL10",
        }),
        player({
          playerKey: "bench-catcher",
          playerId: "11",
          name: "Bench Catcher",
          eligiblePositions: ["C", "Util"],
          selectedPosition: "BN",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "C", count: 1 }),
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "IL", count: 1 }),
      ],
    );

    expect(report.activeUnavailable.map((entry) => entry.name)).toEqual(["Injured Catcher"]);
    expect(report.ilUsed).toBe(0);
    expect(report.ilSlots).toBe(1);
    expect(report.openIlSlots).toBe(1);
    expect(report.activeToIlMoves).toHaveLength(1);
    expect(report.activeToIlMoves[0]).toMatchObject({
      playerName: "Injured Catcher",
      from: "C",
      to: "IL",
    });
    expect(report.replacementOptions[0]).toMatchObject({
      outPlayerName: "Injured Catcher",
      replacementPlayerName: "Bench Catcher",
      slot: "C",
    });
    expect(report.guardrails.join(" ")).toContain("Do not drop");
  });

  it("respects IL capacity and does not use unavailable bench players as replacements", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "active-one",
          playerId: "20",
          name: "Active One",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "SP",
          status: "IL15",
        }),
        player({
          playerKey: "active-two",
          playerId: "21",
          name: "Active Two",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "P",
          status: "IL60",
        }),
        player({
          playerKey: "bench-hurt",
          playerId: "22",
          name: "Bench Hurt",
          eligiblePositions: ["SP", "P"],
          selectedPosition: "BN",
          status: "IL60",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "SP", count: 1 }),
        new DailyLineupSlotCount({ position: "P", count: 1 }),
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "IL", count: 1 }),
      ],
    );

    expect(report.activeUnavailable).toHaveLength(2);
    expect(report.activeToIlMoves).toHaveLength(1);
    expect(report.blockedIlMoves).toBe(1);
    expect(report.replacementOptions).toHaveLength(0);
  });

  it("unblocks IL capacity by moving healthy IL players directly into matching active slots", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "active-one",
          playerId: "30",
          name: "Active One",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "SP",
          status: "IL15",
        }),
        player({
          playerKey: "active-two",
          playerId: "31",
          name: "Active Two",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "P",
          status: "IL60",
        }),
        player({
          playerKey: "healthy-il",
          playerId: "32",
          name: "Healthy IL",
          eligiblePositions: ["SP", "P"],
          selectedPosition: "IL",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "SP", count: 1 }),
        new DailyLineupSlotCount({ position: "P", count: 1 }),
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "IL", count: 1 }),
      ],
    );

    expect(report.ilActivationMoves).toHaveLength(1);
    expect(report.ilActivationMoves[0]).toMatchObject({
      playerName: "Healthy IL",
      from: "IL",
      to: "SP",
    });
    expect(report.activeToIlMoves).toHaveLength(1);
    expect(report.blockedIlMoves).toBe(1);
  });

  it("combines open IL slots with freed IL slots before marking active injuries blocked", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "active-one",
          playerId: "40",
          name: "Active One",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "SP",
          status: "IL15",
        }),
        player({
          playerKey: "active-two",
          playerId: "41",
          name: "Active Two",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "P",
          status: "IL60",
        }),
        player({
          playerKey: "healthy-il",
          playerId: "42",
          name: "Healthy IL",
          eligiblePositions: ["C", "Util"],
          selectedPosition: "IL",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "SP", count: 1 }),
        new DailyLineupSlotCount({ position: "P", count: 1 }),
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "IL", count: 2 }),
      ],
    );

    expect(report.ilActivationMoves).toHaveLength(1);
    expect(report.activeToIlMoves).toHaveLength(2);
    expect(report.blockedIlMoves).toBe(0);
  });

  it("uses open bench capacity to free IL when healthy IL players cannot fill injured active slots", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "active-one",
          playerId: "50",
          name: "Active One",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "SP",
          status: "IL15",
        }),
        player({
          playerKey: "healthy-il",
          playerId: "51",
          name: "Healthy IL",
          eligiblePositions: ["C", "Util"],
          selectedPosition: "IL",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "SP", count: 1 }),
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "IL", count: 1 }),
      ],
    );

    expect(report.ilActivationMoves).toHaveLength(1);
    expect(report.ilActivationMoves[0]).toMatchObject({
      playerName: "Healthy IL",
      from: "IL",
      to: "BN",
    });
    expect(report.activeToIlMoves).toHaveLength(1);
  });

  it("does not suggest a bench replacement when IL is full and the active player cannot move", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "active-one",
          playerId: "60",
          name: "Active One",
          eligiblePositions: ["C", "Util", "IL"],
          selectedPosition: "C",
          status: "IL10",
        }),
        player({
          playerKey: "bench-catcher",
          playerId: "61",
          name: "Bench Catcher",
          eligiblePositions: ["C", "Util"],
          selectedPosition: "BN",
        }),
        player({
          playerKey: "il-one",
          playerId: "62",
          name: "IL One",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "IL",
          status: "IL60",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "C", count: 1 }),
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "IL", count: 1 }),
      ],
    );

    expect(report.ilUsed).toBe(1);
    expect(report.ilSlots).toBe(1);
    expect(report.openIlSlots).toBe(0);
    expect(report.activeToIlMoves).toHaveLength(0);
    expect(report.replacementOptions).toHaveLength(0);
    expect(report.blockedIlMoves).toBe(1);
  });

  it("reports current IL occupancy split by batter and pitcher", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "il-batter",
          playerId: "70",
          name: "IL Batter",
          eligiblePositions: ["C", "Util", "IL"],
          selectedPosition: "IL",
          status: "IL10",
        }),
        player({
          playerKey: "il-pitcher-one",
          playerId: "71",
          name: "IL Pitcher One",
          eligiblePositions: ["SP", "P", "IL"],
          selectedPosition: "IL",
          status: "IL60",
        }),
        player({
          playerKey: "il-pitcher-two",
          playerId: "72",
          name: "IL Pitcher Two",
          eligiblePositions: ["RP", "P", "IL"],
          selectedPosition: "IL",
          status: "IL15",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "IL", count: 4 }),
      ],
    );

    expect(report.ilUsed).toBe(3);
    expect(report.ilSlots).toBe(4);
    expect(report.openIlSlots).toBe(1);
    expect(report.ilBatterUsed).toBe(1);
    expect(report.ilPitcherUsed).toBe(2);
    expect(report.guardrails.join(" ")).toContain("1 batter(s), 2 pitcher(s)");
  });

  it("treats NA as a reserve slot, not an active lineup problem", () => {
    const report = buildDailyLineupReport(
      "2026-06-07",
      [
        player({
          playerKey: "na-stash",
          playerId: "80",
          name: "NA Stash",
          eligiblePositions: ["SS", "Util"],
          selectedPosition: "NA",
          status: "NA",
        }),
        player({
          playerKey: "bench-shortstop",
          playerId: "81",
          name: "Bench Shortstop",
          eligiblePositions: ["SS", "Util"],
          selectedPosition: "BN",
        }),
      ],
      [
        new DailyLineupSlotCount({ position: "SS", count: 1 }),
        new DailyLineupSlotCount({ position: "BN", count: 1 }),
        new DailyLineupSlotCount({ position: "NA", count: 1 }),
      ],
    );

    expect(report.activeUnavailable).toHaveLength(0);
    expect(report.activeStatusRisks).toHaveLength(0);
    expect(report.fillableOpenSlots.map((move) => move.playerName)).toEqual(["Bench Shortstop"]);
    expect(report.fillableOpenSlots.map((move) => move.playerName)).not.toContain("NA Stash");
  });
});
