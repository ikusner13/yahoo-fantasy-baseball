import { describe, expect, it } from "vite-plus/test";

import {
  renderManagerBriefingForDiscord,
  splitDiscordMessage,
} from "../../src/services/DiscordNotifier";
import { ManagerBriefingReport, ManualAction } from "../../src/services/ManagerBriefing";

describe("DiscordNotifier", () => {
  it("renders exhausted add budget without add/stream instructions", () => {
    const message = renderManagerBriefingForDiscord(
      new ManagerBriefingReport({
        summary: "No transaction available: weekly add limit is exhausted.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 0,
        reservedAdds: 0,
        projectedWeeklyIp: 24.2,
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

  it("renders manager briefings into Discord-safe advisory text", () => {
    const message = renderManagerBriefingForDiscord(
      new ManagerBriefingReport({
        summary: "Make the power add; closest categories are HR, RBI.",
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
        managerTakeaways: ["Use roster capacity before considering drops."],
        categoryPlan: ["Protect: HR 7-6.", "Possible flips: RBI 21-21."],
        addTriggers: ["Hitter stream: only if HR/TB/RBI/H can move."],
        lineupAlerts: ["Replace Out Bat at OF with Bench Bat from BN."],
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

    expect(message).toContain("**Make the power add");
    expect(message).toContain("As of: 2026-06-06T18:00:00.000Z");
    expect(message).toContain("Today MLB games: 4/15 not started");
    expect(message).toContain("last Sat, 10:10 PM EDT");
    expect(message).toContain("Adds remaining: 4");
    expect(message).toContain("**Manager decision**");
    expect(message).toContain("Add Power Bat into the open active slot");
    expect(message).toContain("W HR: 7-6");
    expect(message).toContain("T RBI: 21-21");
    expect(message).toContain("**Manager read**");
    expect(message).toContain("Use roster capacity before considering drops");
    expect(message).toContain("**Category plan**");
    expect(message).toContain("**What would trigger an add**");
    expect(message).toContain("**Lineup alerts**");
    expect(message).toContain("Replace Out Bat at OF with Bench Bat from BN");
    expect(message).toContain("Risky Arm");
    expect(message).toContain("1. [ACT] Add Power Bat");
    expect(message).toContain("Why: Add Power Bat");
    expect(message).toContain("Do not execute add/drop");
    expect(message).not.toContain("candidate");
  });

  it("splits long Discord messages on newline boundaries", () => {
    const chunks = splitDiscordMessage(["first", "second", "third"].join("\n"), 13);

    expect(chunks).toEqual(["first\nsecond", "third"]);
  });

  it("normalizes stale cached warning copy at render time", () => {
    const message = renderManagerBriefingForDiscord(
      new ManagerBriefingReport({
        summary: "Cached briefing should render with current language.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 4,
        reservedAdds: 0,
        projectedWeeklyIp: 24.2,
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

  it("renumbers displayed held actions from one", () => {
    const message = renderManagerBriefingForDiscord(
      new ManagerBriefingReport({
        summary: "One add-only decision is available.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 4,
        reservedAdds: 0,
        projectedWeeklyIp: 24.2,
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
            priority: 4,
            action: "Add Bench Bat into the open roster spot",
            confidence: "review",
            categories: ["SB"],
            rationale: "Open roster capacity.",
            checks: [],
            stopIf: [],
            yahooSteps: [],
          }),
        ],
        warnings: [],
      }),
    );

    expect(message).toContain("**Blocked decision**");
    expect(message).toContain(
      "Decision blocked: Add Bench Bat into the open roster spot; execute only after the listed gate clears.",
    );
    expect(message).toContain("1. [BLOCKED] Add Bench Bat");
    expect(message).not.toContain("4. [BLOCKED] Add Bench Bat");
    expect(message).not.toContain("Review / alternatives");
  });
});
