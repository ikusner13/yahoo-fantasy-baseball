import { describe, expect, it } from "vite-plus/test";

import {
  rankAddCandidates,
  simulateMatchup,
  type DecisionReport,
} from "../../src/services/DecisionEngine";
import {
  LeagueStatePlayer,
  LeagueStateSnapshot,
  RosterSlotCount,
} from "../../src/services/LeagueState";
import {
  DailyGameWindow,
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";
import { planTransactions } from "../../src/services/TransactionPlanner";

const monday = new Date("2026-06-01T16:00:00.000Z");
const saturday = new Date("2026-06-06T16:00:00.000Z");

const batter = (overrides: Partial<ConstructorParameters<typeof WeeklyBatterLine>[0]> = {}) =>
  new WeeklyBatterLine({
    kind: "batter",
    playerKey: "batter",
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
    playerKey: "pitcher",
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

const snapshot = (overrides: Partial<ConstructorParameters<typeof LeagueStateSnapshot>[0]> = {}) =>
  new LeagueStateSnapshot({
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
    addsUsed: 1,
    roster: [
      new LeagueStatePlayer({
        playerKey: "injured",
        name: "Injured Starter",
        team: "ATL",
        eligiblePositions: ["SP"],
        selectedPosition: "BN",
        status: "IL",
      }),
    ],
    rosterSlots: [
      new RosterSlotCount({ position: "Util", count: 1 }),
      new RosterSlotCount({ position: "P", count: 1 }),
      new RosterSlotCount({ position: "IL", count: 4 }),
    ],
    emptySlots: [],
    ilUsed: 0,
    ilSlots: 4,
    matchup: {
      week: 11,
      weekStart: "2026-06-01",
      weekEnd: "2026-06-07",
      opponentTeamKey: "mlb.l.62744.t.3",
      opponentTeamName: "Opponent",
      categories: [],
    },
    ...overrides,
  });

const makeReport = (set: WeeklyProjectionSet): DecisionReport => rankAddCandidates(set);

describe("TransactionPlanner Phase 4", () => {
  it("surfaces free-agent adds for empty active slots before add/drop moves", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "active-bat", pa: 12, hr: 0 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 2, r: 4, rbi: 4 })],
      dailyGameWindows: [
        new DailyGameWindow({
          date: "2026-06-01",
          games: 12,
          remainingGames: 12,
          firstGameTime: "2026-06-01T17:05:00.000Z",
          lastGameTime: "2026-06-02T02:10:00.000Z",
        }),
      ],
      freeAgents: [
        batter({
          playerKey: "volume-bat",
          name: "Volume Bat",
          pa: 32,
          r: 6,
          h: 8,
          hr: 2,
          rbi: 7,
          tb: 16,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({ emptySlots: [new RosterSlotCount({ position: "Util", count: 1 })] }),
      { asOf: monday },
    );

    expect(plan.steps[0]).toMatchObject({
      type: "free-agent-add",
      addPlayerKey: "volume-bat",
    });
    expect(plan.steps[0]?.guardrails).toContain("empty-slot-urgency");
    expect(plan.steps[0]?.dropPlayerKey).toBeUndefined();
    expect(plan.todayGameWindow).toMatchObject({ games: 12, remainingGames: 12 });
  });

  it("separates waiver claims from priority-free adds and reserves early-week adds", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "weak-bat",
          pa: 8,
          r: 0,
          h: 1,
          hr: 0,
          rbi: 0,
          sb: 0,
          tb: 1,
          obpNumerator: 1,
          obpDenominator: 8,
          obp: 1 / 8,
        }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 7, rbi: 8 })],
      freeAgents: [
        batter({ playerKey: "breakout", name: "Breakout Bat", hr: 8, rbi: 10, tb: 30 }),
        batter({ playerKey: "streamer", name: "Streamer Bat", r: 5, h: 9, sb: 2 }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        addsUsed: 3,
        roster: [
          new LeagueStatePlayer({
            playerKey: "weak-bat",
            name: "Weak Bat",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
        ],
      }),
      {
        asOf: monday,
        availabilityByPlayerKey: { breakout: "waiver" },
      },
    );

    expect(plan.addsRemaining).toBe(3);
    expect(plan.reservedAdds).toBe(2);
    expect(plan.steps.some((step) => step.type === "waiver-claim")).toBe(true);
    expect(plan.steps.some((step) => step.type === "add-drop")).toBe(true);
    expect(plan.steps.some((step) => step.timing === "reserve-late-week")).toBe(true);
  });

  it("uses the sixth add on Saturday/Sunday for the tightest categories", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "mine",
          pa: 5,
          r: 0,
          h: 1,
          hr: 0,
          rbi: 0,
          sb: 0,
          tb: 1,
          obpNumerator: 1,
          obpDenominator: 5,
          obp: 1 / 5,
        }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 3, rbi: 5 })],
      freeAgents: [batter({ playerKey: "weekend-bat", name: "Weekend Bat", hr: 3, rbi: 5 })],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        addsUsed: 5,
        roster: [
          new LeagueStatePlayer({
            playerKey: "mine",
            name: "Mine",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
        ],
      }),
      {
        asOf: saturday,
      },
    );

    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.timing).toBe("sat-sun-priority");
    expect(plan.steps[0]?.guardrails).toContain("sixth-add-weekend");
    expect(plan.closestCategories.length).toBeGreaterThan(0);
  });

  it("suppresses add/drop recommendations when the add is not a real upgrade over the drop", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "neto",
          name: "Zach Neto",
          team: "LAA",
          pa: 24,
          r: 4,
          h: 6,
          hr: 1,
          rbi: 4,
          sb: 1,
          tb: 10,
          obpNumerator: 8,
          obpDenominator: 24,
          obp: 8 / 24,
        }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 3, rbi: 6, tb: 18 })],
      freeAgents: [
        batter({
          playerKey: "gary",
          name: "Gary Sanchez",
          team: "BAL",
          pa: 12,
          r: 1,
          h: 2,
          hr: 1,
          rbi: 3,
          sb: 0,
          tb: 5,
          obpNumerator: 3,
          obpDenominator: 12,
          obp: 3 / 12,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        roster: [
          new LeagueStatePlayer({
            playerKey: "neto",
            name: "Zach Neto",
            team: "LAA",
            eligiblePositions: ["SS"],
            selectedPosition: "BN",
          }),
          new LeagueStatePlayer({
            playerKey: "shortstop-cover",
            name: "Shortstop Cover",
            team: "NYY",
            eligiblePositions: ["SS"],
            selectedPosition: "SS",
          }),
        ],
      }),
      { asOf: monday },
    );

    expect(plan.steps).toHaveLength(0);
  });

  it("tags SV+H relievers and enforces the 20-IP floor first", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [pitcher({ playerKey: "low-ip", ip: 6, out: 18, k: 5 })],
      opponentRoster: [pitcher({ playerKey: "opp-arm", ip: 20, out: 60, k: 22 })],
      freeAgents: [
        pitcher({
          playerKey: "holds-arm",
          name: "Holds Arm",
          ip: 4,
          out: 12,
          k: 5,
          er: 1,
          baserunners: 4,
          qs: 0,
          svh: 2,
        }),
        pitcher({
          playerKey: "two-start",
          name: "Two Start Arm",
          ip: 12,
          out: 36,
          k: 13,
          er: 4,
          baserunners: 12,
          qs: 1.8,
          svh: 0,
        }),
      ],
    });

    const baseline = simulateMatchup(set.myRoster, set.opponentRoster);
    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        addsUsed: 0,
        emptySlots: [new RosterSlotCount({ position: "P", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "low-ip",
            name: "Low IP",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "BN",
          }),
        ],
      }),
      {
        asOf: monday,
      },
    );

    expect(baseline.categories.find((category) => category.category === "OUT")?.tag).not.toBe(
      "lock",
    );
    expect(plan.projectedWeeklyIp).toBeLessThan(20);
    expect(plan.steps[0]?.guardrails).toContain("ip-floor");
    expect(plan.steps.some((step) => step.guardrails.includes("svh-program"))).toBe(true);
    expect(plan.steps.some((step) => step.guardrails.includes("two-start-planning"))).toBe(true);
  });

  it("computes the IP floor from active pitchers instead of the full roster", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        pitcher({ playerKey: "active-arm", name: "Active Arm", ip: 5, out: 15, k: 5 }),
        pitcher({ playerKey: "bench-arm", name: "Bench Arm", ip: 45, out: 135, k: 50 }),
      ],
      opponentRoster: [pitcher({ playerKey: "opp", ip: 20, out: 60, k: 20 })],
      freeAgents: [
        pitcher({
          playerKey: "floor-arm",
          name: "Floor Arm",
          ip: 8,
          out: 24,
          k: 8,
          qs: 1,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        emptySlots: [new RosterSlotCount({ position: "P", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "active-arm",
            name: "Active Arm",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "P",
          }),
          new LeagueStatePlayer({
            playerKey: "bench-arm",
            name: "Bench Arm",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "BN",
          }),
        ],
      }),
      { asOf: monday },
    );

    expect(plan.projectedWeeklyIp).toBe(5);
    expect(plan.steps[0]?.guardrails).toContain("ip-floor");

    const withBankedOuts = planTransactions(
      makeReport(set),
      set,
      snapshot({
        emptySlots: [new RosterSlotCount({ position: "P", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "active-arm",
            name: "Active Arm",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "P",
          }),
          new LeagueStatePlayer({
            playerKey: "bench-arm",
            name: "Bench Arm",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "BN",
          }),
        ],
        matchup: {
          ...snapshot().matchup,
          categories: [{ category: "OUT", myValue: "60", opponentValue: "75" }],
        },
      }),
      { asOf: monday },
    );

    expect(withBankedOuts.projectedWeeklyIp).toBe(25);
    expect(withBankedOuts.steps[0]?.guardrails).not.toContain("ip-floor");
  });
});
