import { describe, expect, it } from "vite-plus/test";

import { renderManagerBriefingForTelegram } from "../../src/services/TelegramNotifier";
import { ManagerBriefingReport, ManualAction } from "../../src/services/ManagerBriefing";

describe("TelegramNotifier", () => {
  it("renders manager briefings as plain Telegram text", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Review the top candidate action; closest categories are SB, OBP.",
        generatedAt: "2026-06-06T18:00:00.000Z",
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
        categoryPlan: ["Protect: OBP .331-.328.", "Possible flips: SB 2-3."],
        addTriggers: ["Late-week snipe: use adds when a category is within one small event."],
        rejectedTransactions: [
          {
            addPlayerName: "Bench Bat",
            dropPlayerName: "Useful Bat",
            score: 0.4,
            affectedCategories: ["SB"],
            reason: "replacement edge below threshold",
          },
        ],
        doNow: [
          new ManualAction({
            priority: 1,
            action: "Add Speed Bat into the open active slot",
            confidence: "review",
            categories: ["SB", "R"],
            rationale: "Add Speed Bat: targets SB and R without requiring a drop.",
            checks: [],
            stopIf: [],
            yahooSteps: [],
          }),
        ],
        holdForLater: [],
        warnings: ["This is a manual-action briefing, not an auto-execution instruction."],
      }),
    );

    expect(message).toContain("Review the top candidate action");
    expect(message).toContain("As of: 2026-06-06T18:00:00.000Z");
    expect(message).toContain("Today MLB games: 15/15 not started");
    expect(message).toContain("first Sat, 1:05 PM EDT");
    expect(message).toContain("Current categories");
    expect(message).toContain("L SB: 2-3");
    expect(message).toContain("W OBP: .331-.328");
    expect(message).toContain("Category plan");
    expect(message).toContain("What would trigger an add");
    expect(message).toContain("Rejected moves");
    expect(message).toContain("1. [REVIEW] Add Speed Bat");
    expect(message).toContain("Why: Add Speed Bat");
    expect(message).not.toContain("**");
  });
});
