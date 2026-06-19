import { describe, expect, it } from "vite-plus/test";

import {
  AddRecommendation,
  CategoryDelta,
  CategoryProbability,
  DecisionReport,
  MatchupSimulation,
  OpponentScout,
  rankAddCandidates,
  simulateMatchup,
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
  WeeklySchedule,
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
  it("blocks transactions when the weekly add limit is exhausted", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "active-bat", pa: 12, hr: 0 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 2, r: 4, rbi: 4 })],
      freeAgents: [
        batter({
          playerKey: "power-add",
          name: "Power Add",
          pa: 32,
          r: 7,
          h: 9,
          hr: 3,
          rbi: 8,
          tb: 20,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        addsUsed: 6,
        emptySlots: [new RosterSlotCount({ position: "Util", count: 1 })],
      }),
      { asOf: saturday },
    );

    expect(plan.addsRemaining).toBe(0);
    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]).toMatchObject({
      addPlayerName: "Power Add",
      reason:
        "weekly add limit is exhausted; no transaction can be made until the next matchup period",
    });
  });

  it("does not treat an ineligible batter as a fit for a scarce open active slot", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "active-bat", pa: 12, hr: 0 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 2, r: 4, rbi: 4 })],
      freeAgents: [
        batter({
          playerKey: "of-only",
          name: "OF Only",
          eligiblePositions: ["OF"],
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
      snapshot({ emptySlots: [new RosterSlotCount({ position: "C", count: 1 })] }),
      { asOf: monday },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]?.reason).not.toContain("open active slot");
  });

  it("rejects open active slot filler when the player has no credible category value", () => {
    const weakCatcher = batter({
      playerKey: "weak-c",
      name: "Weak Catcher",
      eligiblePositions: ["C"],
      pa: 8,
      r: 1,
      h: 1,
      hr: 0,
      rbi: 1,
      sb: 0,
      tb: 2,
      obpNumerator: 2,
      obpDenominator: 8,
      obp: 0.25,
    });
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "active-bat", pa: 12, hr: 0 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 2 })],
      freeAgents: [weakCatcher],
    });
    const report = new DecisionReport({
      baseline: new MatchupSimulation({
        expectedCategoryPoints: 6,
        categories: [
          new CategoryProbability({
            category: "RBI",
            winProbability: 0.5,
            tieProbability: 0,
            expectedPoints: 0.5,
            tag: "coin-flip",
          }),
        ],
      }),
      scout: new OpponentScout({
        locks: [],
        coinFlips: ["RBI"],
        lostCauses: [],
        categoryWeights: { RBI: 1.75 },
      }),
      recommendations: [
        new AddRecommendation({
          type: "add",
          playerKey: "weak-c",
          playerName: "Weak Catcher",
          score: 3,
          weeklyDelta: 0.4,
          seasonSgpDelta: 0.2,
          affectedCategories: [],
        }),
      ],
      optimalLineup: [],
      optimalBench: [],
      lineupRecommendations: [],
    });

    const plan = planTransactions(
      report,
      set,
      snapshot({ emptySlots: [new RosterSlotCount({ position: "C", count: 1 })] }),
      { asOf: monday },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]).toMatchObject({
      addPlayerName: "Weak Catcher",
      reason:
        "open active slot alone is not enough; add needs credible category value before using a move",
    });
  });

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
    expect(plan.steps[0]?.rationale).toContain("open active slot creates immediate lineup value");
    expect(plan.steps[0]?.rationale).not.toContain("empty-slot-urgency");
    expect(plan.steps[0]?.dropPlayerKey).toBeUndefined();
    expect(plan.todayGameWindow).toMatchObject({ games: 12, remainingGames: 12 });
  });

  it("does not spend an add on same-day active-slot volume after the player's team has no games left", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "active-bat", pa: 12, hr: 0 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 2, r: 4, rbi: 4 })],
      schedules: [
        new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 0 }),
        new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 1 }),
      ],
      freeAgents: [
        batter({
          playerKey: "locked-volume-bat",
          name: "Locked Volume Bat",
          team: "SEA",
          eligiblePositions: ["Util"],
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
      { asOf: saturday },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]).toMatchObject({
      addPlayerName: "Locked Volume Bat",
      reason: "player's team has no remaining games, so the add has no unlocked lineup volume",
    });
  });

  it("carries roster pitcher expected starts into the transaction plan", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        pitcher({
          playerKey: "starter",
          name: "Scheduled Starter",
          ip: 6.2,
          out: 18.6,
          k: 7.4,
          expectedStarts: 1,
        }),
      ],
      opponentRoster: [],
      freeAgents: [],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        roster: [
          new LeagueStatePlayer({
            playerKey: "starter",
            name: "Scheduled Starter",
            team: "SEA",
            eligiblePositions: ["SP"],
            selectedPosition: "SP",
            status: "healthy",
          }),
        ],
      }),
      { asOf: monday },
    );

    expect(plan.pitcherStarts?.[0]).toMatchObject({
      playerName: "Scheduled Starter",
      selectedPosition: "SP",
      expectedStarts: 1,
      projectedIp: 6.2,
      projectedK: 7.4,
    });
  });

  it("does not label a low-speed hitter as an SB decision even when SB is close", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [],
      opponentRoster: [],
      freeAgents: [
        batter({
          playerKey: "corner-bat",
          name: "Corner Bat",
          r: 5,
          h: 7,
          rbi: 6,
          sb: 0.2,
          tb: 12,
        }),
      ],
    });
    const report = new DecisionReport({
      baseline: new MatchupSimulation({
        expectedCategoryPoints: 6,
        categories: [
          new CategoryProbability({
            category: "ERA",
            winProbability: 0.48,
            tieProbability: 0,
            expectedPoints: 0.48,
            tag: "coin-flip",
          }),
          new CategoryProbability({
            category: "RBI",
            winProbability: 0.49,
            tieProbability: 0,
            expectedPoints: 0.49,
            tag: "coin-flip",
          }),
          new CategoryProbability({
            category: "R",
            winProbability: 0.51,
            tieProbability: 0,
            expectedPoints: 0.51,
            tag: "lean",
          }),
          new CategoryProbability({
            category: "SB",
            winProbability: 0.5,
            tieProbability: 0,
            expectedPoints: 0.5,
            tag: "coin-flip",
          }),
        ],
      }),
      scout: new OpponentScout({
        locks: [],
        coinFlips: ["SB", "RBI", "R"],
        lostCauses: [],
        categoryWeights: { R: 1, H: 1, RBI: 1, SB: 1, TB: 1, ERA: 1 },
      }),
      recommendations: [
        new AddRecommendation({
          type: "add",
          playerKey: "corner-bat",
          playerName: "Corner Bat",
          score: 2,
          weeklyDelta: 1.4,
          seasonSgpDelta: 0.2,
          affectedCategories: [
            new CategoryDelta({ category: "H", weeklyDelta: 0.5, seasonSgpDelta: 0.1 }),
            new CategoryDelta({ category: "TB", weeklyDelta: 0.4, seasonSgpDelta: 0.1 }),
            new CategoryDelta({ category: "RBI", weeklyDelta: 0.3, seasonSgpDelta: 0.1 }),
            new CategoryDelta({ category: "R", weeklyDelta: 0.2, seasonSgpDelta: 0.1 }),
            new CategoryDelta({ category: "SB", weeklyDelta: 0.01, seasonSgpDelta: 0.02 }),
          ],
        }),
      ],
      optimalLineup: [],
      optimalBench: [],
      lineupRecommendations: [],
    });

    const plan = planTransactions(
      report,
      set,
      snapshot({ emptySlots: [new RosterSlotCount({ position: "Util", count: 1 })] }),
      { asOf: saturday },
    );

    expect(plan.steps[0]?.affectedCategories).toEqual(["RBI", "R"]);
    expect(plan.steps[0]?.rationale).toContain("focus RBI, R");
    expect(plan.steps[0]?.affectedCategories).not.toContain("SB");
  });

  it("uses open bench roster capacity before considering add/drop moves", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "active-bat", pa: 20, hr: 1 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 3, rbi: 5 })],
      freeAgents: [
        batter({
          playerKey: "bench-add",
          name: "Bench Add",
          pa: 28,
          r: 5,
          h: 7,
          hr: 2,
          rbi: 6,
          tb: 14,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        emptySlots: [new RosterSlotCount({ position: "BN", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "active-bat",
            name: "Active Bat",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "OF",
          }),
        ],
      }),
      { asOf: monday },
    );

    expect(plan.steps[0]).toMatchObject({
      type: "free-agent-add",
      addPlayerKey: "bench-add",
    });
    expect(plan.steps[0]?.guardrails).toContain("open-roster-capacity");
    expect(plan.steps[0]?.rationale).toContain(
      "open bench capacity avoids dropping long-term value",
    );
    expect(plan.steps[0]?.rationale).not.toContain("open-roster-capacity");
    expect(plan.steps[0]?.dropPlayerKey).toBeUndefined();
  });

  it("does not spend an add on open bench capacity without credible category value", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "active-bat", pa: 20, hr: 1 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 3, rbi: 5 })],
      freeAgents: [
        batter({
          playerKey: "thin-depth",
          name: "Thin Depth",
          pa: 6,
          r: 1,
          h: 1,
          hr: 0,
          rbi: 1,
          sb: 0,
          tb: 2,
          obpNumerator: 2,
          obpDenominator: 6,
          obp: 2 / 6,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        emptySlots: [new RosterSlotCount({ position: "BN", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "active-bat",
            name: "Active Bat",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "OF",
          }),
        ],
      }),
      { asOf: monday },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]).toMatchObject({
      addPlayerName: "Thin Depth",
      reason:
        "open bench slot alone is not enough; add needs credible category value before using a move",
    });
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
        waiverPriority: 8,
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
    expect(plan.steps.some((step) => step.timing === "reserve-late-week")).toBe(true);
    expect(
      plan.rejectedTransactions.some((move) => move.reason.includes("no urgency guardrail")),
    ).toBe(true);
  });

  it("preserves top waiver priority for weak short-term claims", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [],
      opponentRoster: [batter({ playerKey: "opp", hr: 2, rbi: 4 })],
      freeAgents: [batter({ playerKey: "thin-claim", name: "Thin Claim", r: 3, h: 4, rbi: 2 })],
    });
    const report = new DecisionReport({
      baseline: new MatchupSimulation({
        expectedCategoryPoints: 6,
        categories: [
          new CategoryProbability({
            category: "RBI",
            winProbability: 0.5,
            tieProbability: 0,
            expectedPoints: 0.5,
            tag: "coin-flip",
          }),
        ],
      }),
      scout: new OpponentScout({
        locks: [],
        coinFlips: ["RBI"],
        lostCauses: [],
        categoryWeights: { R: 1, H: 1, RBI: 1 },
      }),
      recommendations: [
        new AddRecommendation({
          type: "add",
          playerKey: "thin-claim",
          playerName: "Thin Claim",
          score: 1,
          weeklyDelta: 0.7,
          seasonSgpDelta: 0.3,
          affectedCategories: [
            new CategoryDelta({ category: "RBI", weeklyDelta: 0.4, seasonSgpDelta: 0.2 }),
          ],
        }),
      ],
      optimalLineup: [],
      optimalBench: [],
      lineupRecommendations: [],
    });

    const plan = planTransactions(
      report,
      set,
      snapshot({
        waiverPriority: 1,
        emptySlots: [new RosterSlotCount({ position: "Util", count: 1 })],
      }),
      {
        asOf: saturday,
        availabilityByPlayerKey: { "thin-claim": "waiver" },
      },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]).toMatchObject({
      addPlayerName: "Thin Claim",
      reason:
        "waiver priority 1 is too valuable for a short-term streamer below the claim threshold",
    });
  });

  it("spends top waiver priority on a durable high-value claim", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [],
      opponentRoster: [batter({ playerKey: "opp", hr: 2, rbi: 4 })],
      freeAgents: [batter({ playerKey: "breakout", name: "Breakout Bat", hr: 8, rbi: 10 })],
    });
    const report = new DecisionReport({
      baseline: new MatchupSimulation({
        expectedCategoryPoints: 6,
        categories: [
          new CategoryProbability({
            category: "RBI",
            winProbability: 0.5,
            tieProbability: 0,
            expectedPoints: 0.5,
            tag: "coin-flip",
          }),
        ],
      }),
      scout: new OpponentScout({
        locks: [],
        coinFlips: ["RBI"],
        lostCauses: [],
        categoryWeights: { HR: 1, RBI: 1, TB: 1 },
      }),
      recommendations: [
        new AddRecommendation({
          type: "add",
          playerKey: "breakout",
          playerName: "Breakout Bat",
          score: 4,
          weeklyDelta: 2.4,
          seasonSgpDelta: 1.2,
          affectedCategories: [
            new CategoryDelta({ category: "RBI", weeklyDelta: 1.2, seasonSgpDelta: 0.5 }),
            new CategoryDelta({ category: "HR", weeklyDelta: 0.8, seasonSgpDelta: 0.4 }),
          ],
        }),
      ],
      optimalLineup: [],
      optimalBench: [],
      lineupRecommendations: [],
    });

    const plan = planTransactions(
      report,
      set,
      snapshot({
        waiverPriority: 1,
        emptySlots: [new RosterSlotCount({ position: "Util", count: 1 })],
      }),
      {
        asOf: saturday,
        availabilityByPlayerKey: { breakout: "waiver" },
      },
    );

    expect(plan.steps[0]).toMatchObject({
      type: "waiver-claim",
      addPlayerName: "Breakout Bat",
    });
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

  it("explains category-neutral add/drop rejections without candidate wording", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "bench-bat",
          name: "Bench Bat",
          pa: 20,
          r: 4,
          h: 6,
          hr: 1,
          rbi: 4,
          sb: 1,
          tb: 10,
        }),
      ],
      opponentRoster: [],
      freeAgents: [
        batter({
          playerKey: "volume-twin",
          name: "Volume Twin",
          pa: 80,
          r: 4,
          h: 6,
          hr: 1,
          rbi: 4,
          sb: 1,
          tb: 10,
        }),
      ],
    });
    const report = new DecisionReport({
      baseline: new MatchupSimulation({
        expectedCategoryPoints: 6,
        categories: [
          new CategoryProbability({
            category: "H",
            winProbability: 0.5,
            tieProbability: 0,
            expectedPoints: 0.5,
            tag: "coin-flip",
          }),
        ],
      }),
      scout: new OpponentScout({
        locks: [],
        coinFlips: ["H"],
        lostCauses: [],
        categoryWeights: { R: 1, H: 1, HR: 1, RBI: 1, SB: 1, TB: 1 },
      }),
      recommendations: [
        new AddRecommendation({
          type: "add",
          playerKey: "volume-twin",
          playerName: "Volume Twin",
          score: 4,
          weeklyDelta: 1,
          seasonSgpDelta: 0.1,
          affectedCategories: [
            new CategoryDelta({ category: "H", weeklyDelta: 0.1, seasonSgpDelta: 0.1 }),
          ],
        }),
      ],
      optimalLineup: [],
      optimalBench: [],
      lineupRecommendations: [],
    });

    const plan = planTransactions(
      report,
      set,
      snapshot({
        roster: [
          new LeagueStatePlayer({
            playerKey: "bench-bat",
            name: "Bench Bat",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
          new LeagueStatePlayer({
            playerKey: "injured",
            name: "Injured Starter",
            team: "ATL",
            eligiblePositions: ["SP"],
            selectedPosition: "BN",
            status: "IL",
          }),
        ],
      }),
      { asOf: monday },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]?.reason).toBe(
      "add player did not improve any category enough over the drop",
    );
    expect(plan.rejectedTransactions[0]?.reason).not.toContain("candidate");
  });

  it("ranks add/drop moves by actual replacement edge instead of add-only score", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "near-good-drop",
          name: "Near Good Drop",
          pa: 20,
          r: 4,
          h: 6,
          hr: 1,
          rbi: 4,
          tb: 10,
        }),
        batter({
          playerKey: "weak-drop",
          name: "Weak Drop",
          pa: 8,
          r: 1,
          h: 2,
          hr: 0,
          rbi: 1,
          tb: 2,
        }),
      ],
      opponentRoster: [],
      freeAgents: [
        batter({
          playerKey: "small-upgrade",
          name: "Small Upgrade",
          pa: 24,
          r: 5,
          h: 7,
          hr: 1.2,
          rbi: 5,
          tb: 12,
        }),
        batter({
          playerKey: "large-upgrade",
          name: "Large Upgrade",
          pa: 30,
          r: 7,
          h: 9,
          hr: 3,
          rbi: 8,
          tb: 20,
        }),
      ],
    });
    const report = new DecisionReport({
      baseline: new MatchupSimulation({
        expectedCategoryPoints: 6,
        categories: [
          new CategoryProbability({
            category: "HR",
            winProbability: 0.5,
            tieProbability: 0,
            expectedPoints: 0.5,
            tag: "coin-flip",
          }),
        ],
      }),
      scout: new OpponentScout({
        locks: [],
        coinFlips: ["HR"],
        lostCauses: [],
        categoryWeights: { R: 1, H: 1, HR: 1, RBI: 1, TB: 1 },
      }),
      recommendations: [
        new AddRecommendation({
          type: "add",
          playerKey: "small-upgrade",
          playerName: "Small Upgrade",
          score: 10,
          weeklyDelta: 4,
          seasonSgpDelta: 2,
          affectedCategories: [
            new CategoryDelta({ category: "HR", weeklyDelta: 0.5, seasonSgpDelta: 0.2 }),
          ],
        }),
        new AddRecommendation({
          type: "add",
          playerKey: "large-upgrade",
          playerName: "Large Upgrade",
          score: 5,
          weeklyDelta: 3,
          seasonSgpDelta: 2,
          affectedCategories: [
            new CategoryDelta({ category: "HR", weeklyDelta: 1.5, seasonSgpDelta: 0.8 }),
          ],
        }),
      ],
      optimalLineup: [],
      optimalBench: [],
      lineupRecommendations: [],
    });

    const plan = planTransactions(
      report,
      set,
      snapshot({
        addsUsed: 5,
        roster: [
          new LeagueStatePlayer({
            playerKey: "near-good-drop",
            name: "Near Good Drop",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
          new LeagueStatePlayer({
            playerKey: "weak-drop",
            name: "Weak Drop",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
        ],
      }),
      { asOf: saturday },
    );

    expect(plan.steps[0]).toMatchObject({
      type: "add-drop",
      addPlayerName: "Large Upgrade",
      dropPlayerName: "Weak Drop",
    });
  });

  it("explains weak add/drop rejections as roster-value protection", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "bench-drop",
          name: "Bench Drop",
          pa: 20,
          r: 4,
          h: 6,
          hr: 1,
          rbi: 4,
          tb: 10,
        }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 4 })],
      freeAgents: [
        batter({
          playerKey: "thin-upgrade",
          name: "Thin Upgrade",
          pa: 21,
          r: 4.1,
          h: 6.1,
          hr: 1.05,
          rbi: 4.1,
          tb: 10.2,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        roster: [
          new LeagueStatePlayer({
            playerKey: "bench-drop",
            name: "Bench Drop",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
          new LeagueStatePlayer({
            playerKey: "injured-stash",
            name: "Injured Stash",
            team: "ATL",
            eligiblePositions: ["SP"],
            selectedPosition: "BN",
            status: "IL",
          }),
        ],
      }),
      { asOf: saturday },
    );

    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]).toMatchObject({
      addPlayerName: "Thin Upgrade",
      dropPlayerName: "Bench Drop",
    });
    expect(plan.rejectedTransactions[0]?.reason).toContain("protecting roster value");
  });

  it("does not use NA stashes as add/drop drop candidates", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "na-stash",
          name: "NA Stash",
          pa: 1,
          r: 0,
          h: 0,
          hr: 0,
          rbi: 0,
          tb: 0,
        }),
        batter({
          playerKey: "bench-drop",
          name: "Bench Drop",
          pa: 8,
          r: 1,
          h: 2,
          hr: 0,
          rbi: 1,
          tb: 2,
        }),
      ],
      opponentRoster: [],
      freeAgents: [
        batter({
          playerKey: "power-add",
          name: "Power Add",
          pa: 30,
          r: 7,
          h: 9,
          hr: 3,
          rbi: 8,
          tb: 20,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        addsUsed: 5,
        roster: [
          new LeagueStatePlayer({
            playerKey: "na-stash",
            name: "NA Stash",
            team: "NYY",
            eligiblePositions: ["SS"],
            selectedPosition: "NA",
            status: "NA",
          }),
          new LeagueStatePlayer({
            playerKey: "bench-drop",
            name: "Bench Drop",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
        ],
      }),
      { asOf: saturday },
    );

    expect(plan.steps[0]).toMatchObject({
      type: "add-drop",
      addPlayerName: "Power Add",
      dropPlayerName: "Bench Drop",
    });
    expect(plan.steps[0]?.dropPlayerName).not.toBe("NA Stash");
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
          expectedStarts: 2,
        }),
      ],
    });

    const baseline = simulateMatchup(set.myRoster, set.opponentRoster, 1000, 7);
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
    expect(plan.steps.some((step) => step.guardrails.includes("remaining-start"))).toBe(true);
  });

  it("rejects SP stream adds with no remaining expected start", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [pitcher({ playerKey: "active-arm", name: "Active Arm", ip: 24, out: 72, k: 20 })],
      opponentRoster: [pitcher({ playerKey: "opp-arm", ip: 24, out: 72, k: 20 })],
      freeAgents: [
        pitcher({
          playerKey: "no-start-arm",
          name: "No Start Arm",
          ip: 6,
          out: 18,
          k: 7,
          qs: 0.7,
          eligiblePositions: ["SP"],
          expectedStarts: 0,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        addsUsed: 0,
        emptySlots: [new RosterSlotCount({ position: "SP", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "active-arm",
            name: "Active Arm",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "P",
          }),
        ],
      }),
      { asOf: saturday },
    );

    expect(plan.projectedWeeklyIp).toBeGreaterThan(20);
    expect(plan.steps).toHaveLength(0);
    expect(plan.rejectedTransactions[0]).toMatchObject({
      addPlayerName: "No Start Arm",
      reason: "SP stream has no remaining expected start in the current matchup window",
    });
  });

  it("does not classify missing-eligibility relievers as no-start SP streams", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [pitcher({ playerKey: "active-arm", name: "Active Arm", ip: 24, out: 72, k: 20 })],
      opponentRoster: [pitcher({ playerKey: "opp-arm", ip: 24, out: 72, k: 20 })],
      freeAgents: [
        pitcher({
          playerKey: "relief-arm",
          name: "Relief Arm",
          ip: 4,
          out: 12,
          k: 5,
          qs: 0,
          svh: 0.4,
          eligiblePositions: ["P"],
          expectedStarts: 0,
        }),
      ],
    });

    const plan = planTransactions(
      makeReport(set),
      set,
      snapshot({
        addsUsed: 0,
        emptySlots: [new RosterSlotCount({ position: "P", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "active-arm",
            name: "Active Arm",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "P",
          }),
        ],
      }),
      { asOf: saturday },
    );

    expect(
      plan.rejectedTransactions.some((move) => move.reason.includes("no remaining expected start")),
    ).toBe(false);
  });

  it("rejects risky pitcher streams when ERA or WHIP are coin-flip categories", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [pitcher({ playerKey: "active-arm", name: "Active Arm", ip: 24, out: 72, k: 20 })],
      opponentRoster: [pitcher({ playerKey: "opp-arm", ip: 24, out: 72, k: 20 })],
      freeAgents: [
        pitcher({
          playerKey: "risky-k-arm",
          name: "Risky K Arm",
          ip: 6,
          out: 18,
          k: 8,
          era: 4.4,
          whip: 1.32,
          qs: 0.5,
        }),
      ],
    });
    const report = new DecisionReport({
      baseline: new MatchupSimulation({
        expectedCategoryPoints: 6,
        categories: [
          new CategoryProbability({
            category: "ERA",
            winProbability: 0.5,
            tieProbability: 0,
            expectedPoints: 0.5,
            tag: "coin-flip",
          }),
          new CategoryProbability({
            category: "K",
            winProbability: 0.52,
            tieProbability: 0,
            expectedPoints: 0.52,
            tag: "lean",
          }),
        ],
      }),
      scout: new OpponentScout({
        locks: [],
        coinFlips: ["ERA", "K"],
        lostCauses: [],
        categoryWeights: { ERA: 1, WHIP: 1, K: 1, OUT: 1, QS: 1, "SV+H": 1 },
      }),
      recommendations: [
        new AddRecommendation({
          type: "add",
          playerKey: "risky-k-arm",
          playerName: "Risky K Arm",
          score: 2,
          weeklyDelta: 1.5,
          seasonSgpDelta: 0.2,
          affectedCategories: [
            new CategoryDelta({ category: "K", weeklyDelta: 0.8, seasonSgpDelta: 0.2 }),
            new CategoryDelta({ category: "OUT", weeklyDelta: 0.3, seasonSgpDelta: 0.1 }),
          ],
        }),
      ],
      optimalLineup: [],
      optimalBench: [],
      lineupRecommendations: [],
    });

    const plan = planTransactions(
      report,
      set,
      snapshot({
        addsUsed: 0,
        emptySlots: [new RosterSlotCount({ position: "P", count: 1 })],
        roster: [
          new LeagueStatePlayer({
            playerKey: "active-arm",
            name: "Active Arm",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "P",
          }),
        ],
      }),
      { asOf: saturday },
    );

    expect(plan.projectedWeeklyIp).toBeGreaterThan(20);
    expect(plan.steps).toHaveLength(0);
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
          expectedStarts: 1,
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
