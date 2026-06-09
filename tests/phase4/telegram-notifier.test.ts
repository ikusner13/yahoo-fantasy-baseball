import { describe, expect, it } from "vite-plus/test";

import { renderManagerBriefingForTelegram } from "../../src/services/TelegramNotifier";
import { ManagerBriefingReport, ManualAction } from "../../src/services/ManagerBriefing";

describe("TelegramNotifier", () => {
  it("renders exhausted add budget without add/stream instructions", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "No transaction available: weekly add limit is exhausted.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 0,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        closestCategories: ["SB"],
        categorySituations: [],
        managerTakeaways: [
          "Add budget: weekly add limit is exhausted, so no add/drop, claim, or streamer can be made until the next matchup period.",
        ],
        categoryPlan: [],
        addTriggers: [
          "No add triggers are active because the weekly Yahoo add limit is exhausted.",
        ],
        lineupAlerts: [],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [],
        warnings: [],
      }),
    );

    expect(message).toContain("No transaction available: weekly Yahoo add limit is exhausted.");
    expect(message).toContain("No add triggers are active");
    expect(message).not.toContain("Hitter stream");
    expect(message).not.toContain("SP stream");
    expect(message).not.toContain("Late-week snipe");
  });

  it("renders urgent lineup briefings as a scannable Telegram digest", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Lineup fix first; next add targets SB and OBP.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        bestAction: "Fix lineup only: 1 internal move(s), then regenerate.",
        decisionConfidence: "high",
        bestActionSteps: [
          "Move Injured Catcher from C to IL (IL10).",
          "Save roster changes.",
          "Regenerate the manager plan before applying any transaction.",
        ],
        decisionEvidence: [
          "summary: Lineup fix first; next add targets SB and OBP.",
          "adds: 2 left, 0 reserved",
        ],
        decisionBlockers: [
          "Transactions are paused until the listed lineup/IL moves are saved and the manager plan is regenerated.",
        ],
        addsRemaining: 2,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        closestCategories: ["SB", "OBP"],
        todayGameWindow: {
          date: "2026-06-06",
          games: 15,
          remainingGames: 15,
          firstGameTime: "2026-06-06T17:05:00.000Z",
          lastGameTime: "2026-06-07T02:10:00.000Z",
        },
        categorySituations: [
          { category: "SB", myValue: "2", opponentValue: "3", status: "losing" },
          { category: "OBP", myValue: ".331", opponentValue: ".328", status: "winning" },
        ],
        managerTakeaways: [
          "Lineup first: 1 active player is unavailable, so transaction adds come after the roster is legal.",
        ],
        categoryPlan: ["Protect: OBP .331-.328.", "Possible flips: SB 2-3."],
        addTriggers: [
          "Transactions are paused until the listed lineup/IL moves are saved and the manager plan is regenerated.",
        ],
        lineupAlerts: [
          "Injured Catcher is active at C with status IL10.",
          "Move Injured Catcher from C to IL (IL10).",
        ],
        rejectedTransactions: [],
        doNow: [
          new ManualAction({
            priority: 1,
            action: "Add Speed Bat into the open active slot",
            confidence: "review",
            categories: ["SB", "R"],
            rationale: "Add Speed Bat: targets SB and R without requiring a drop.",
            checks: [],
            stopIf: [],
            yahooSteps: [
              "Open Yahoo Fantasy Baseball.",
              "Search for Speed Bat.",
              "Use Add for the free-agent move selected by the manager.",
              "Save the selected move, then regenerate the manager plan.",
            ],
          }),
        ],
        holdForLater: [],
        warnings: [
          "Manager decision generated from Yahoo roster, status, lock data, matchup context, and category guardrails.",
        ],
      }),
    );

    expect(message).toContain("⚾ Fantasy GM");
    expect(message).toContain("Lineup fix first; next add targets SB and OBP.");
    expect(message).toContain("🕒 Generated: Jun 6, 2:00 PM EDT");
    expect(message).toContain("🗓️ Games: 15/15 unlocked");
    expect(message).toContain("first Jun 6, 1:05 PM EDT");
    expect(message).toContain("➕ Adds: 2 left (0 reserved)");
    expect(message).toContain("🎯 Closest: SB, OBP");
    expect(message).toContain("✅ Best Current Action");
    expect(message).toContain("Confidence: HIGH");
    expect(message).toContain("Fix lineup only: 1 internal move(s), then regenerate");
    expect(message).toContain("🧾 Do This");
    expect(message).toContain("• Move Injured Catcher from C to IL");
    expect(message).toContain("🔎 Why");
    expect(message).toContain("adds: 2 left, 0 reserved");
    expect(message.indexOf("🎯 Next Add After Lineup Fix")).toBeLessThan(message.indexOf("🔎 Why"));
    expect(message).toContain("🧠 Manager Read");
    expect(message).toContain("Lineup first");
    expect(message).toContain("🧭 Add Triggers");
    expect(message).toContain("Transactions are paused until the listed lineup/IL moves");
    expect(message).not.toContain("Late-week snipe");
    expect(message).toContain("🚨 Lineup");
    expect(message).toContain("Problems");
    expect(message).toContain("Injured Catcher is active at C");
    expect(message).toContain("Moves");
    expect(message).toContain("Move Injured Catcher from C to IL");
    expect(message).toContain("📲 Yahoo Steps");
    expect(message).toContain("1. Open Yahoo My Team for the briefing date.");
    expect(message).toContain("2. Apply the moves listed from the current Yahoo roster state.");
    expect(message).toContain("3. Move Injured Catcher from C to IL");
    expect(message).toContain("4. Save roster changes, then re-run the lineup check.");
    expect(message).not.toContain("⛔ Skipped");
    expect(message).toContain("🎯 Next Add After Lineup Fix");
    expect(message).toContain("1. [AFTER LINEUP FIX] Add Speed Bat into the open active slot");
    expect(message).not.toContain("1. [BLOCKED] Add Speed Bat into the open active slot");
    expect(message).not.toContain("[REVIEW]");
    expect(message).toContain("Why: Add Speed Bat");
    expect(message).toContain("Yahoo:");
    expect(message).toContain("Search for Speed Bat.");
    expect(message).toContain("Use Add for the free-agent move selected by the manager.");
    expect(message).toContain("🛑 Guardrails");
    expect(message).not.toContain("Confirm");
    expect(message).not.toContain("confirm");
    expect(message).not.toContain("Verify");
    expect(message).not.toContain("Check:");
    expect(message).not.toContain("Stop if:");
    expect(message).not.toContain("📊 Scoreboard");
    expect(message).not.toContain("**");
  });

  it("keeps the scoreboard when there is no urgent lineup fix", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "No urgent lineup change; closest categories are SB, OBP.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 2,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        closestCategories: ["SB", "OBP"],
        categorySituations: [
          { category: "SB", myValue: "2", opponentValue: "3", status: "losing" },
          { category: "OBP", myValue: ".331", opponentValue: ".328", status: "winning" },
        ],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        writeAlerts: ["Yahoo writes are not authorized yet; complete read/write Yahoo auth."],
        pitcherStarts: ["Scheduled Starter (SP): 1.0 expected start(s), 6.2 IP, 7.4 K."],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [],
        warnings: [],
      }),
    );

    expect(message).toContain("📊 Scoreboard");
    expect(message).toContain("Trail SB: 2-3");
    expect(message).toContain("Lead OBP: .331-.328");
    expect(message).toContain("🔐 Yahoo Writes");
    expect(message).toContain("Yahoo writes are not authorized yet");
    expect(message).toContain("🗓️ Pitcher Starts");
    expect(message).toContain("Scheduled Starter (SP): 1.0 expected start(s), 6.2 IP, 7.4 K.");
  });

  it("normalizes stale cached warning copy at render time", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Cached briefing should render with current language.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 2,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        closestCategories: [],
        categorySituations: [],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [],
        warnings: [
          "This is a manual manager decision generated from Yahoo roster, status, and lock data.",
        ],
      }),
    );

    expect(message).toContain(
      "Manager decision generated from Yahoo roster, status, lock data, matchup context, and category guardrails.",
    );
    expect(message).not.toContain("manual manager decision");
  });

  it("labels the best non-urgent action as a hold decision", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "One add clears the model but not the timing guardrail.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 2,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        closestCategories: ["SB"],
        categorySituations: [],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [
          new ManualAction({
            priority: 1,
            action: "Add Speed Bat into the open roster spot",
            confidence: "review",
            categories: ["SB"],
            rationale: "Targets the closest category.",
            checks: [],
            stopIf: [],
            yahooSteps: [],
          }),
        ],
        warnings: [],
      }),
    );

    expect(message).toContain("🧱 Blocked Decision");
    expect(message).toContain(
      "Decision blocked: Add Speed Bat into the open roster spot; execute only after the listed gate clears.",
    );
    expect(message).toContain("1. [BLOCKED] Add Speed Bat");
    expect(message).toContain("Focus: SB");
    expect(message).not.toContain("🎯 Next Add");
    expect(message).not.toContain("🔎 Review");
    expect(message).not.toContain("Add Candidates");
  });

  it("explains no-category adds as roster-fit decisions instead of depth", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Use the open roster spot without forcing a category claim.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 2,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        closestCategories: ["OUT", "ERA"],
        categorySituations: [],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [
          new ManualAction({
            priority: 1,
            action: "Add Catcher Bat into the open roster spot",
            confidence: "review",
            categories: [],
            rationale:
              "Add Catcher Bat: 0.23 weekly category EV, 0.02 season SGP; focus open roster spot without dropping long-term value.",
            checks: [],
            stopIf: [],
            yahooSteps: [],
          }),
        ],
        warnings: [],
      }),
    );

    expect(message).toContain("Focus: open roster spot, no drop");
    expect(message).toContain("focus open roster spot without dropping long-term value");
    expect(message).not.toContain("Categories: depth");
    expect(message).not.toContain("targeting depth");
  });

  it("keeps projection-only start recommendations out of Yahoo save steps", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Fix one active slot; projection starts are suppressed separately.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 2,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        closestCategories: ["SB"],
        categorySituations: [],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [
          "Injured Catcher is active at C with status IL10.",
          "Move Injured Catcher from C to IL (IL10).",
        ],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [],
        warnings: [],
      }),
    );

    expect(message).toContain("3. Move Injured Catcher from C to IL");
    expect(message).not.toContain("Consider starting");
    expect(message).not.toContain("Start Bench Bat over Cold Starter");
  });
});
