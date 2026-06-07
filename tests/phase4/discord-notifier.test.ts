import { describe, expect, it } from "vite-plus/test";

import {
  renderManagerBriefingForDiscord,
  splitDiscordMessage,
} from "../../src/services/DiscordNotifier";
import { ManagerBriefingReport, ManualAction } from "../../src/services/ManagerBriefing";

describe("DiscordNotifier", () => {
  it("renders manager briefings into Discord-safe advisory text", () => {
    const message = renderManagerBriefingForDiscord(
      new ManagerBriefingReport({
        summary: "Review the top candidate action; closest categories are HR, RBI.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 4,
        reservedAdds: 2,
        projectedWeeklyIp: 24.2,
        closestCategories: ["HR", "RBI"],
        todayGameWindow: {
          date: "2026-06-06",
          games: 15,
          remainingGames: 4,
          firstGameTime: "2026-06-06T17:05:00.000Z",
          lastGameTime: "2026-06-07T02:10:00.000Z",
        },
        categorySituations: [
          { category: "HR", myValue: "7", opponentValue: "6", status: "winning" },
          { category: "RBI", myValue: "21", opponentValue: "21", status: "tied" },
        ],
        categoryPlan: ["Protect: HR 7-6.", "Possible flips: RBI 21-21."],
        addTriggers: ["Hitter stream: only if HR/TB/RBI/H can move."],
        rejectedTransactions: [
          {
            addPlayerName: "Risky Arm",
            score: 0.2,
            affectedCategories: ["K", "OUT"],
            reason: "K/OUT gain did not justify ERA/WHIP downside",
          },
        ],
        doNow: [
          new ManualAction({
            priority: 1,
            action: "Add Power Bat into the open active slot",
            confidence: "act",
            categories: ["HR", "RBI", "TB"],
            rationale: "Add Power Bat: clear category edge for HR, RBI, and TB.",
            checks: [],
            stopIf: [],
            yahooSteps: [],
          }),
        ],
        holdForLater: [],
        warnings: ["Do not execute add/drop actions until Yahoo availability is re-checked."],
      }),
    );

    expect(message).toContain("**Review the top candidate action");
    expect(message).toContain("As of: 2026-06-06T18:00:00.000Z");
    expect(message).toContain("Today MLB games: 4/15 not started");
    expect(message).toContain("last Sat, 10:10 PM EDT");
    expect(message).toContain("Adds remaining: 4");
    expect(message).toContain("W HR: 7-6");
    expect(message).toContain("T RBI: 21-21");
    expect(message).toContain("**Category plan**");
    expect(message).toContain("**What would trigger an add**");
    expect(message).toContain("Risky Arm");
    expect(message).toContain("1. [ACT] Add Power Bat");
    expect(message).toContain("Why: Add Power Bat");
    expect(message).toContain("Do not execute add/drop");
  });

  it("splits long Discord messages on newline boundaries", () => {
    const chunks = splitDiscordMessage(["first", "second", "third"].join("\n"), 13);

    expect(chunks).toEqual(["first\nsecond", "third"]);
  });
});
