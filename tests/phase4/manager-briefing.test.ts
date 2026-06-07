import { describe, expect, it } from "vite-plus/test";

import {
  LeagueStatePlayer,
  LeagueStateSnapshot,
  RosterSlotCount,
} from "../../src/services/LeagueState";
import { buildManagerBriefing } from "../../src/services/ManagerBriefing";
import { WeeklyBatterLine, WeeklyProjectionSet } from "../../src/services/ProjectionModel";
import {
  TransactionPlan,
  TransactionStep,
  planTransactions,
} from "../../src/services/TransactionPlanner";
import { rankAddCandidates } from "../../src/services/DecisionEngine";

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
    addsUsed: 0,
    roster: [],
    rosterSlots: [new RosterSlotCount({ position: "C", count: 1 })],
    emptySlots: [],
    ilUsed: 0,
    ilSlots: 0,
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

describe("ManagerBriefing Phase 4", () => {
  it("keeps review add/drop moves out of the do-now section", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR", "H", "TB", "ERA", "OBP"],
        categorySituations: [
          { category: "HR", myValue: "4", opponentValue: "5", status: "losing" },
          { category: "ERA", myValue: "3.65", opponentValue: "6.27", status: "winning" },
        ],
        rejectedTransactions: [
          {
            addPlayerName: "Power Bat",
            dropPlayerName: "Useful Bat",
            score: 1.2,
            affectedCategories: ["HR", "TB"],
            reason: "replacement edge below threshold",
          },
        ],
        steps: [
          new TransactionStep({
            type: "add-drop",
            timing: "now",
            addPlayerKey: "add",
            addPlayerName: "Power Bat",
            dropPlayerKey: "drop",
            dropPlayerName: "Useful Bat",
            score: 1.4,
            affectedCategories: ["HR", "TB"],
            guardrails: [],
            rationale: "Add/drop Power Bat: replacement edge clears the guardrail for HR and TB.",
          }),
        ],
      }),
    );

    expect(briefing.doNow).toHaveLength(0);
    expect(briefing.holdForLater[0]?.action).toContain("Review add/drop");
    expect(briefing.summary).toContain("No act-now move clears the bar");
    expect(briefing.categoryPlan.join(" ")).toContain("Protect");
    expect(briefing.addTriggers.join(" ")).toContain("Late-week snipe");
  });

  it("uses current category margins for possible-flip buckets", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR", "TB", "OBP"],
        categorySituations: [
          { category: "HR", myValue: "2", opponentValue: "6", status: "losing" },
          { category: "TB", myValue: "57", opponentValue: "92", status: "losing" },
          { category: "SB", myValue: "3", opponentValue: "5", status: "losing" },
          { category: "ERA", myValue: "3.65", opponentValue: "6.27", status: "winning" },
        ],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.categoryPlan.join(" ")).toContain("Possible flips: SB 3-5");
    expect(briefing.categoryPlan.join(" ")).toContain("Low-probability chases: HR 2-6, TB 57-92");
  });

  it("turns waiver recommendations into review actions with stop conditions", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "drop", name: "Drop Bat", pa: 10 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 6, rbi: 8 })],
      freeAgents: [batter({ playerKey: "claim", name: "Claim Bat", hr: 8, rbi: 10, tb: 30 })],
    });
    const plan = planTransactions(
      rankAddCandidates(set),
      set,
      snapshot({
        roster: [
          new LeagueStatePlayer({
            playerKey: "drop",
            name: "Drop Bat",
            team: "NYY",
            eligiblePositions: ["OF"],
            selectedPosition: "BN",
          }),
        ],
      }),
      {
        asOf: new Date("2026-06-01T16:00:00.000Z"),
        availabilityByPlayerKey: { claim: "waiver" },
      },
    );

    const briefing = buildManagerBriefing(plan);

    expect(briefing.doNow).toHaveLength(0);
    expect(briefing.holdForLater[0]?.confidence).toBe("review");
    expect(briefing.holdForLater[0]?.checks.join(" ")).toContain("waiver priority");
    expect(briefing.holdForLater[0]?.stopIf.join(" ")).toContain("waiver priority");
    expect(briefing.summary).toContain("No act-now move clears the bar");
  });

  it("does not propose dropping the only scarce-position player", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "only-catcher", name: "Only Catcher", pa: 1 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 5 })],
      freeAgents: [batter({ playerKey: "power", name: "Power Bat", hr: 9, tb: 30 })],
    });
    const plan = planTransactions(
      rankAddCandidates(set),
      set,
      snapshot({
        roster: [
          new LeagueStatePlayer({
            playerKey: "only-catcher",
            name: "Only Catcher",
            team: "NYY",
            eligiblePositions: ["C"],
            selectedPosition: "BN",
          }),
        ],
      }),
      {
        asOf: new Date("2026-06-01T16:00:00.000Z"),
      },
    );

    const briefing = buildManagerBriefing(plan);

    expect(plan.steps).toHaveLength(0);
    expect(briefing.summary).toContain("No transaction clears");
    expect(briefing.summary).toContain("replacement/drop threshold");
    expect(briefing.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(briefing.warnings.join(" ")).not.toContain("Treat listed add/drop actions");
  });
});
