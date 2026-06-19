import { describe, expect, it } from "vite-plus/test";

import {
  DailyLineupIlActivationMove,
  DailyLineupIlMove,
  DailyLineupPlayer,
  DailyLineupReplacementMove,
  DailyLineupReport,
  DailyLineupSlotCount,
} from "../../src/services/DailyLineupAdvisor";
import {
  LeagueStatePlayer,
  LeagueStateSnapshot,
  RosterSlotCount,
} from "../../src/services/LeagueState";
import {
  buildManagerBriefing,
  buildYahooApplyPlan,
  buildYahooTransactionWrite,
} from "../../src/services/ManagerBriefing";
import { WeeklyBatterLine, WeeklyProjectionSet } from "../../src/services/ProjectionModel";
import {
  TransactionDailyGameWindow,
  TransactionPlan,
  TransactionLineupRecommendation,
  TransactionPitcherStart,
  TransactionStep,
  planTransactions,
} from "../../src/services/TransactionPlanner";
import { ManagerWriteStatus } from "../../src/services/ManagerWriteStatus";
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
  it("calls out exhausted add budget as a hard transaction stop", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 0,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["SB"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.summary).toBe(
      "No transaction available: weekly add limit is exhausted. Closest categories are SB.",
    );
    expect(briefing.managerTakeaways.join(" ")).toContain("weekly add limit is exhausted");
    expect(briefing.addTriggers).toEqual([
      "No add triggers are active because the weekly Yahoo add limit is exhausted.",
    ]);
  });

  it("propagates the full optimal lineup into the manager briefing report", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["HR"],
        categorySituations: [],
        optimalLineup: [
          {
            slot: "Util",
            kind: "batter",
            playerKey: "power-bench",
            playerName: "Power Bench",
            score: 4.2,
            isCurrentStarter: false,
          },
          {
            slot: "C",
            kind: "batter",
            playerKey: "catcher",
            playerName: "Sánchez",
            score: 2.1,
            isCurrentStarter: true,
          },
        ],
        optimalBench: [
          {
            kind: "batter",
            playerKey: "low-power-active",
            playerName: "Low Power Active",
            score: 1.1,
          },
        ],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.optimalLineup.map((slot) => [slot.slot, slot.playerName])).toEqual([
      ["Util", "Power Bench"],
      ["C", "Sánchez"],
    ]);
    expect(briefing.optimalBench.map((player) => player.playerName)).toEqual(["Low Power Active"]);
  });

  it("summarizes expected pitcher starts for the current roster", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["OUT", "K", "QS"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        pitcherStarts: [
          new TransactionPitcherStart({
            playerKey: "starter",
            playerName: "Scheduled Starter",
            selectedPosition: "SP",
            expectedStarts: 1,
            projectedIp: 6.2,
            projectedK: 7.4,
            starts: [
              {
                date: "2026-06-07",
                opponentTeam: "BOS",
                gameTime: "2026-06-07T17:05:00.000Z",
                homeAway: "home",
              },
            ],
          }),
        ],
        rejectedTransactions: [
          {
            addPlayerName: "Blocked Add",
            score: 0.4,
            affectedCategories: ["SB"],
            reason: "transaction evaluation is stale until lineup is fixed",
          },
        ],
        steps: [],
      }),
    );

    expect(briefing.pitcherStarts).toEqual([
      "Scheduled Starter (SP): 1.0 expected start(s), 6.2 IP, 7.4 K (2026-06-07 vs BOS).",
    ]);
  });

  it("surfaces unauthorized Yahoo write capability as a manager alert", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: [],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [
          {
            addPlayerName: "Blocked Add",
            score: 0.4,
            affectedCategories: ["SB"],
            reason: "transaction evaluation is stale until lineup is fixed",
          },
        ],
        steps: [],
      }),
      undefined,
      new ManagerWriteStatus({
        checkedAt: "2026-06-07T20:30:00.000Z",
        capability: "unauthorized",
        action: "apply-lineup",
        ok: false,
        date: "2026-06-07",
        error: "Yahoo rejected lineup write.",
      }),
    );

    expect(briefing.managerTakeaways[0]).toContain("Yahoo write auth is missing");
    expect(briefing.writeAlerts?.[0]).toContain("Yahoo writes are not authorized yet");
  });

  it("labels missing write status as a read-only preview instead of an unknown authorization state", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: [],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.writeAlerts?.[0]).toBe(
      "Write status not checked in this preview; the briefing is read-only and will not attempt Yahoo lineup writes.",
    );
    expect(briefing.writeAlerts?.[0]).not.toContain("unknown");
  });

  it("keeps review add/drop moves out of the do-now section", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR", "H", "TB", "ERA", "OBP"],
        todayGameWindow: new TransactionDailyGameWindow({
          date: "2026-06-07",
          games: 15,
          remainingGames: 15,
          firstGameTime: "2026-06-07T17:35:00.000Z",
          lastGameTime: "2026-06-08T00:30:00.000Z",
        }),
        categorySituations: [
          { category: "HR", myValue: "4", opponentValue: "5", status: "losing" },
          { category: "ERA", myValue: "3.65", opponentValue: "6.27", status: "winning" },
        ],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [
          new TransactionLineupRecommendation({
            startPlayerKey: "bench",
            startPlayerName: "Bench Bat",
            sitPlayerKey: "starter",
            sitPlayerName: "Cold Starter",
            scoreDelta: 1.3,
            affectedCategories: ["HR", "TB"],
          }),
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
    expect(briefing.holdForLater[0]?.action).toContain("Add Power Bat, drop Useful Bat");
    expect(briefing.summary).toContain("Lineup improvement found");
    expect(briefing.categoryPlan.join(" ")).toContain("Protect");
    expect(briefing.addTriggers.join(" ")).toContain("Late-week snipe");
    expect(briefing.lineupAlerts.join(" ")).toContain("Start Bench Bat over Cold Starter");
    expect(briefing.lineupAlerts.join(" ")).toContain("HR, TB");
  });

  it("suppresses projection-only start/sit suggestions once the slate is partially locked", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["SB"],
        todayGameWindow: new TransactionDailyGameWindow({
          date: "2026-06-07",
          games: 15,
          remainingGames: 6,
          firstGameTime: "2026-06-07T17:35:00.000Z",
          lastGameTime: "2026-06-08T00:30:00.000Z",
        }),
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [
          new TransactionLineupRecommendation({
            startPlayerKey: "bench",
            startPlayerName: "Bench Bat",
            sitPlayerKey: "starter",
            sitPlayerName: "Cold Starter",
            scoreDelta: 1.3,
            affectedCategories: ["SB"],
          }),
        ],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.lineupAlerts.join(" ")).not.toContain("Bench Bat");
    expect(briefing.summary).not.toContain("Lineup improvement found");
  });

  it("surfaces an unrelated start/sit move even when a different active player is unavailable", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR"],
        todayGameWindow: new TransactionDailyGameWindow({
          date: "2026-06-19",
          games: 15,
          remainingGames: 15,
        }),
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [
          new TransactionLineupRecommendation({
            startPlayerKey: "sanchez",
            startPlayerName: "Gary Sanchez",
            sitPlayerKey: "rutschman",
            sitPlayerName: "Adley Rutschman",
            scoreDelta: 0.89,
            affectedCategories: ["HR", "RBI", "TB"],
          }),
        ],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-19",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "rooker",
            playerId: "1",
            name: "Brent Rooker",
            team: "OAK",
            eligiblePositions: ["OF", "Util"],
            selectedPosition: "Util",
            status: "IL10",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.lineupAlerts.join(" ")).toContain("Start Gary Sanchez over Adley Rutschman");
    expect(briefing.summary).not.toContain("no complete internal lineup fix is available");
    expect(briefing.summary).toContain("internal lineup move(s) are available");
  });

  it("still suppresses a projection move that involves the unavailable active player", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR"],
        todayGameWindow: new TransactionDailyGameWindow({
          date: "2026-06-19",
          games: 15,
          remainingGames: 15,
        }),
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [
          new TransactionLineupRecommendation({
            startPlayerKey: "bench",
            startPlayerName: "Bench Bat",
            sitPlayerKey: "rooker",
            sitPlayerName: "Brent Rooker",
            scoreDelta: 1.1,
            affectedCategories: ["HR"],
          }),
        ],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-19",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "rooker",
            playerId: "1",
            name: "Brent Rooker",
            team: "OAK",
            eligiblePositions: ["OF", "Util"],
            selectedPosition: "Util",
            status: "IL10",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.lineupAlerts.join(" ")).not.toContain("Start Bench Bat over Brent Rooker");
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
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.categoryPlan.join(" ")).toContain("Possible flips: SB 3-5");
    expect(briefing.categoryPlan.join(" ")).toContain("Low-probability chases: HR 2-6, TB 57-92");
  });

  it("renders add-only bench capacity as an open roster spot", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [
          new TransactionStep({
            type: "free-agent-add",
            timing: "now",
            addPlayerKey: "add",
            addPlayerName: "Bench Add",
            score: 2.1,
            affectedCategories: ["HR"],
            guardrails: ["open-roster-capacity"],
            rationale: "Add Bench Add into open roster capacity.",
          }),
        ],
      }),
    );

    expect(briefing.doNow[0]?.action).toContain("open roster spot");
    expect(briefing.doNow[0]?.action).not.toContain("open active slot");
  });

  it("adds slate-lock context to manager takeaways", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["SB"],
        todayGameWindow: new TransactionDailyGameWindow({
          date: "2026-06-07",
          games: 15,
          remainingGames: 6,
          firstGameTime: "2026-06-07T17:35:00.000Z",
          lastGameTime: "2026-06-08T00:30:00.000Z",
        }),
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.managerTakeaways.join(" ")).toContain("Lock status");
    expect(briefing.managerTakeaways.join(" ")).toContain("9 of 15 MLB game(s) appear started");
    expect(briefing.managerTakeaways.join(" ")).toContain("the manager used that lock context");
  });

  it("shows IL occupancy by batter and pitcher in manager takeaways", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["SB"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        ilUsed: 3,
        ilSlots: 4,
        openIlSlots: 1,
        ilBatterUsed: 1,
        ilPitcherUsed: 2,
        activeUnavailable: [],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.managerTakeaways.join(" ")).toContain(
      "IL capacity: 3/4 used, 1 open (1 batter, 2 pitcher)",
    );
  });

  it("discloses degraded season-value confidence when SGP denominators use fallback estimates", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        sgpDenominatorSource: "fallback",
        closestCategories: ["HR"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.warnings.join(" ")).toContain("Season-value confidence is degraded");
    expect(briefing.warnings.join(" ")).toContain("fallback league estimates");
  });

  it("does not show degraded season-value confidence when SGP uses standings history", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        sgpDenominatorSource: "standings-history",
        closestCategories: ["HR"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.warnings.join(" ")).not.toContain("Season-value confidence is degraded");
  });

  it("renders direct IL activations and active IL moves as paired swaps", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["QS"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "injured-c",
            playerId: "1",
            name: "Injured Catcher",
            team: "NYM",
            eligiblePositions: ["C", "Util", "IL"],
            selectedPosition: "C",
            status: "IL10",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [
          new DailyLineupIlActivationMove({
            playerKey: "healthy-c",
            playerName: "Healthy Catcher",
            from: "IL",
            to: "C",
            reason: "Free an IL slot and replace Injured Catcher without dropping anyone.",
          }),
        ],
        activeToIlMoves: [
          new DailyLineupIlMove({
            playerKey: "injured-c",
            playerName: "Injured Catcher",
            from: "C",
            to: "IL",
            status: "IL10",
          }),
        ],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    const alerts = briefing.lineupAlerts.join(" ");
    expect(alerts).toContain("Swap Healthy Catcher into C and move Injured Catcher to IL");
    expect(alerts).not.toContain("Move Healthy Catcher from IL to C to free an IL slot");
    expect(alerts).not.toContain("Move Injured Catcher from C to IL");
  });

  it("renders active-to-IL plus bench replacement as one swap instead of duplicate moves", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["OBP"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "injured-c",
            playerId: "1",
            name: "Injured Catcher",
            team: "NYM",
            eligiblePositions: ["C", "Util", "IL"],
            selectedPosition: "C",
            status: "IL10",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [
          new DailyLineupIlMove({
            playerKey: "injured-c",
            playerName: "Injured Catcher",
            from: "C",
            to: "IL",
            status: "IL10",
          }),
        ],
        blockedIlMoves: 0,
        replacementOptions: [
          new DailyLineupReplacementMove({
            outPlayerKey: "injured-c",
            outPlayerName: "Injured Catcher",
            outPlayerStatus: "IL10",
            slot: "C",
            replacementPlayerKey: "bench-c",
            replacementPlayerName: "Bench Catcher",
            currentPosition: "BN",
          }),
        ],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    const alerts = briefing.lineupAlerts.join(" ");
    expect(briefing.summary).toContain("1 internal lineup move");
    expect(briefing.bestAction).toBe("Fix lineup only: 1 internal move(s), then regenerate.");
    expect(briefing.decisionConfidence).toBe("high");
    expect(briefing.bestActionSteps).toContain(
      "Swap Bench Catcher into C and move Injured Catcher to IL (IL10).",
    );
    expect(briefing.bestActionSteps).toContain(
      "Regenerate the manager plan before applying any transaction.",
    );
    expect(briefing.decisionEvidence?.join(" ")).toContain("adds: 6 left, 0 reserved");
    expect(briefing.decisionBlockers?.join(" ")).toContain("Transactions are paused");
    expect(alerts).toContain("Swap Bench Catcher into C and move Injured Catcher to IL");
    expect(alerts).not.toContain("Move Injured Catcher from C to IL");
    expect(alerts).not.toContain("Replace Injured Catcher at C with Bench Catcher");
  });

  it("does not reuse one bench player for both a swap and an open-slot fill", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["OUT"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "scherzer",
            playerId: "31",
            name: "Max Scherzer",
            team: "TOR",
            eligiblePositions: ["SP", "P", "IL"],
            selectedPosition: "P",
            status: "IL15",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [
          new DailyLineupIlMove({
            playerKey: "scherzer",
            playerName: "Max Scherzer",
            from: "P",
            to: "IL",
            status: "IL15",
          }),
        ],
        blockedIlMoves: 0,
        replacementOptions: [
          new DailyLineupReplacementMove({
            outPlayerKey: "scherzer",
            outPlayerName: "Max Scherzer",
            outPlayerStatus: "IL15",
            slot: "P",
            replacementPlayerKey: "rodon",
            replacementPlayerName: "Carlos Rodón",
            currentPosition: "BN",
          }),
        ],
        fillableOpenSlots: [
          {
            slot: "SP",
            playerName: "Carlos Rodón",
            playerKey: "rodon",
            currentPosition: "BN",
          },
        ],
        guardrails: [],
      }),
    );

    const alerts = briefing.lineupAlerts.join(" ");
    expect(briefing.summary).toContain("1 internal lineup move");
    expect(alerts).toContain("Swap Carlos Rodón into P and move Max Scherzer to IL");
    expect(alerts).not.toContain("Move Carlos Rodón from BN to SP");
    expect(alerts).toContain("SP remains open after using Carlos Rodón in the IL swap");
  });

  it("builds an apply plan that stops after lineup moves before transactions", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["OUT"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [
          new TransactionStep({
            type: "free-agent-add",
            timing: "now",
            addPlayerKey: "add",
            addPlayerName: "Useful Add",
            score: 2.2,
            affectedCategories: ["RBI"],
            guardrails: ["empty-slot-urgency"],
            rationale: "Add Useful Add.",
          }),
        ],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        ilUsed: 3,
        ilSlots: 4,
        openIlSlots: 1,
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "scherzer",
            playerId: "31",
            name: "Max Scherzer",
            team: "TOR",
            eligiblePositions: ["SP", "P", "IL"],
            selectedPosition: "P",
            status: "IL15",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [
          new DailyLineupIlMove({
            playerKey: "scherzer",
            playerName: "Max Scherzer",
            from: "P",
            to: "IL",
            status: "IL15",
          }),
        ],
        blockedIlMoves: 0,
        replacementOptions: [
          new DailyLineupReplacementMove({
            outPlayerKey: "scherzer",
            outPlayerName: "Max Scherzer",
            outPlayerStatus: "IL15",
            slot: "P",
            replacementPlayerKey: "rodon",
            replacementPlayerName: "Carlos Rodón",
            currentPosition: "BN",
          }),
        ],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    const plan = buildYahooApplyPlan(briefing);

    expect(plan.mode).toBe("manual");
    expect(plan.transaction).toBeUndefined();
    expect(plan.yahooTransaction).toBeUndefined();
    expect(plan.steps.map((step) => step.kind)).toEqual(["lineup", "save", "rerun"]);
    expect(plan.steps.map((step) => step.text).join(" ")).toContain("Carlos Rodón");
    expect(plan.steps.map((step) => step.text).join(" ")).not.toContain("Useful Add");
  });

  it("builds a transaction apply plan only when no lineup move is pending", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["RBI"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [
          new TransactionStep({
            type: "free-agent-add",
            timing: "now",
            addPlayerKey: "add",
            addPlayerName: "Useful Add",
            score: 2.2,
            affectedCategories: ["RBI"],
            guardrails: ["empty-slot-urgency"],
            rationale: "Add Useful Add.",
          }),
        ],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        ilUsed: 3,
        ilSlots: 4,
        openIlSlots: 1,
        activeUnavailable: [],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    const plan = buildYahooApplyPlan(briefing);

    expect(plan.transaction).toEqual({
      type: "free-agent-add",
      timing: "now",
      addPlayerKey: "add",
      addPlayerName: "Useful Add",
      score: 2.2,
      affectedCategories: ["RBI"],
      guardrails: ["empty-slot-urgency"],
      confidence: "act",
    });
    expect(plan.yahooTransaction).toEqual({ type: "add", playerKey: "add" });
    expect(plan.steps.map((step) => step.kind)).toEqual([
      "transaction",
      "transaction",
      "transaction",
    ]);
    expect(plan.steps.map((step) => step.text)).toEqual([
      "Search for Useful Add.",
      "Use Add for the free-agent move selected by the manager.",
      "Save the selected move, then regenerate the manager plan.",
    ]);
  });

  it("maps selected manager transactions to Yahoo write payloads", () => {
    expect(
      buildYahooTransactionWrite({
        type: "free-agent-add",
        timing: "now",
        addPlayerKey: "add",
        addPlayerName: "Useful Add",
        score: 2.2,
        affectedCategories: ["RBI"],
        guardrails: ["empty-slot-urgency"],
        confidence: "act",
      }),
    ).toEqual({ type: "add", playerKey: "add" });

    expect(
      buildYahooTransactionWrite({
        type: "add-drop",
        timing: "now",
        addPlayerKey: "add",
        addPlayerName: "Useful Add",
        dropPlayerKey: "drop",
        dropPlayerName: "Drop Candidate",
        score: 2.2,
        affectedCategories: ["RBI"],
        guardrails: ["ratio-protection"],
        confidence: "act",
      }),
    ).toEqual({
      type: "add/drop",
      addPlayerKey: "add",
      dropPlayerKey: "drop",
    });

    expect(
      buildYahooTransactionWrite({
        type: "waiver-claim",
        timing: "reserve-late-week",
        addPlayerKey: "claim",
        addPlayerName: "Claim Candidate",
        score: 3.1,
        affectedCategories: ["SV+H"],
        guardrails: ["reserve-adds"],
        confidence: "hold",
      }),
    ).toEqual({ type: "waiver", addPlayerKey: "claim" });
  });

  it("leads the summary with urgent unavailable active players before transaction posture", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["SB", "QS"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "injured-c",
            playerId: "1",
            name: "Injured Catcher",
            team: "NYM",
            eligiblePositions: ["C", "Util", "IL"],
            selectedPosition: "C",
            status: "IL10",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [
          new DailyLineupIlMove({
            playerKey: "injured-c",
            playerName: "Injured Catcher",
            from: "C",
            to: "IL",
            status: "IL10",
          }),
        ],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.summary).toContain("1 active player(s) are unavailable");
    expect(briefing.summary).toContain("internal lineup move");
    expect(briefing.summary).not.toContain("No transaction clears");
  });

  it("calls out open active pitcher slots even when no bench player can fill them", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["OUT", "K"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [new DailyLineupSlotCount({ position: "SP", count: 1 })],
        activeUnavailable: [],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.summary).toContain("Open active slot(s): SP");
    expect(briefing.summary).toContain("fill legal unlocked lineup volume");
    expect(briefing.managerTakeaways.join(" ")).toContain("Open active slot(s): SP");
    expect(briefing.managerTakeaways.join(" ")).toContain("prioritize legal unlocked fill-ins");
  });

  it("calls out bench scheduled starts when a pitcher slot is open", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["OUT", "K", "QS"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        pitcherStarts: [
          new TransactionPitcherStart({
            playerKey: "bench-starter",
            playerName: "Bench Starter",
            selectedPosition: "BN",
            expectedStarts: 1,
            projectedIp: 5.8,
            projectedK: 6.2,
            starts: [
              {
                date: "2026-06-07",
                opponentTeam: "BOS",
                gameTime: "2026-06-07T17:05:00.000Z",
                homeAway: "away",
              },
            ],
          }),
        ],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [new DailyLineupSlotCount({ position: "SP", count: 1 })],
        activeUnavailable: [],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.lineupAlerts.join(" ")).toContain(
      "Bench scheduled start: Bench Starter has 1.0 expected start(s); fill SP before lock.",
    );
  });

  it("keeps transactions out of do-now while the active lineup has unavailable players", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["SB"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [
          {
            addPlayerName: "Blocked Add",
            score: 0.4,
            affectedCategories: ["SB"],
            reason: "transaction evaluation is stale until lineup is fixed",
          },
        ],
        steps: [
          new TransactionStep({
            type: "free-agent-add",
            timing: "now",
            addPlayerKey: "add",
            addPlayerName: "Bench Add",
            score: 2.1,
            affectedCategories: ["SB"],
            guardrails: ["open-roster-capacity"],
            rationale: "Add Bench Add into open roster capacity.",
          }),
        ],
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "injured-c",
            playerId: "1",
            name: "Injured Catcher",
            team: "NYM",
            eligiblePositions: ["C", "Util", "IL"],
            selectedPosition: "C",
            status: "IL10",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 1,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.doNow).toHaveLength(0);
    expect(briefing.holdForLater[0]?.action).toContain("Add Bench Add");
    expect(briefing.holdForLater[0]?.confidence).toBe("review");
    expect(briefing.addTriggers).toEqual([
      "Transactions are paused until the listed lineup/IL moves are saved and the manager plan is regenerated.",
    ]);
    expect(briefing.rejectedTransactions).toEqual([]);
  });

  it("shows one open-roster add decision instead of an alternatives list", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["SB"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: ["One", "Two", "Three"].map(
          (name, index) =>
            new TransactionStep({
              type: "free-agent-add",
              timing: "now",
              addPlayerKey: `add-${index}`,
              addPlayerName: `Bench Add ${name}`,
              score: 2.1 - index * 0.1,
              affectedCategories: ["SB"],
              guardrails: ["open-roster-capacity"],
              rationale: `Add Bench Add ${name} into open roster capacity.`,
            }),
        ),
      }),
      new DailyLineupReport({
        date: "2026-06-07",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [new DailyLineupSlotCount({ position: "BN", count: 2 })],
        activeUnavailable: [],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    const actions = [...briefing.doNow, ...briefing.holdForLater].map((action) => action.action);
    expect(actions).toEqual(["Add Bench Add One into the open roster spot"]);
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
    expect(briefing.holdForLater[0]?.checks.join(" ")).toContain("Waiver priority");
    expect(briefing.holdForLater[0]?.stopIf.join(" ")).toContain("Waiver priority");
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

  it("marks the best available add as clearing the bar when a step exists", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["RBI"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [
          new TransactionStep({
            type: "free-agent-add",
            timing: "now",
            addPlayerKey: "add",
            addPlayerName: "Useful Add",
            score: 2.2,
            affectedCategories: ["RBI"],
            guardrails: ["empty-slot-urgency"],
            rationale: "Add Useful Add.",
          }),
        ],
      }),
    );

    expect(briefing.bestAvailableAdd?.clearsBar).toBe(true);
    expect(briefing.bestAvailableAdd?.playerName).toBe("Useful Add");
    expect(briefing.bestAvailableAdd?.score).toBe(2.2);
  });

  it("surfaces the top rejected candidate when nothing clears the bar", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [
          {
            addPlayerName: "Weak Bat",
            score: 0.05,
            affectedCategories: ["HR"],
            reason: "open bench slot alone is not enough",
          },
          {
            addPlayerName: "Power Bat",
            dropPlayerName: "Useful Bat",
            score: 0.4,
            affectedCategories: ["HR", "TB"],
            reason: "replacement edge below threshold",
          },
        ],
        steps: [],
      }),
    );

    expect(briefing.bestAvailableAdd?.clearsBar).toBe(false);
    expect(briefing.bestAvailableAdd?.playerName).toBe("Power Bat");
    expect(briefing.bestAvailableAdd?.dropPlayerName).toBe("Useful Bat");
    expect(briefing.bestAvailableAdd?.reason).toContain("replacement edge");
  });

  it("reports no upgrade available when no candidate cleared or was rejected", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
    );

    expect(briefing.bestAvailableAdd?.clearsBar).toBe(false);
    expect(briefing.bestAvailableAdd?.reason).toBe("no upgrade available in the FA pool");
  });

  it("headlines an injured active starter even when no legal fix exists (IL full, no replacement)", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["HR"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-19",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [
          new DailyLineupPlayer({
            playerKey: "rooker",
            playerId: "1",
            name: "Brent Rooker",
            team: "ATH",
            eligiblePositions: ["OF", "Util", "IL"],
            selectedPosition: "OF",
            status: "IL10",
          }),
        ],
        activeStatusRisks: [],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 1,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.bestAction).toContain("Bench injured starter(s) now");
    expect(briefing.decisionConfidence).toBe("high");
    expect(briefing.lineupAlerts.join(" ")).toContain(
      "Brent Rooker is active at OF with status IL10",
    );
    expect(briefing.bestActionSteps?.join(" ")).toContain("Brent Rooker is active at OF");
    expect(briefing.bestActionSteps?.join(" ")).toContain("Open an IL slot");
  });

  it("surfaces a day-to-day active starter that the old logic dropped entirely", () => {
    const briefing = buildManagerBriefing(
      new TransactionPlan({
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 32.1,
        closestCategories: ["OBP"],
        categorySituations: [],
        optimalLineup: [],
        optimalBench: [],
        lineupRecommendations: [],
        rejectedTransactions: [],
        steps: [],
      }),
      new DailyLineupReport({
        date: "2026-06-19",
        posture: "lineup-only; no drop recommendations",
        emptySlots: [],
        activeUnavailable: [],
        activeStatusRisks: [
          new DailyLineupPlayer({
            playerKey: "adley",
            playerId: "2",
            name: "Adley Rutschman",
            team: "BAL",
            eligiblePositions: ["C", "Util"],
            selectedPosition: "C",
            status: "DTD",
          }),
        ],
        ilActivationMoves: [],
        activeToIlMoves: [],
        blockedIlMoves: 0,
        replacementOptions: [],
        fillableOpenSlots: [],
        guardrails: [],
      }),
    );

    expect(briefing.summary).toContain("Injury risk in your active lineup");
    expect(briefing.summary).toContain("Adley Rutschman (DTD)");
    expect(briefing.lineupAlerts.join(" ")).toContain(
      "Adley Rutschman is active at C with status DTD",
    );
    expect(briefing.bestAction).toContain("Bench injured starter(s) now");
    expect(briefing.decisionConfidence).toBe("high");
  });
});
