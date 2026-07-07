import { describe, expect, it } from "vite-plus/test";

import { renderManagerBriefingForTelegram } from "../../src/services/TelegramNotifier";
import { ManagerBriefingReport, ManualAction } from "../../src/services/ManagerBriefing";

describe("TelegramNotifier", () => {
  it("collapses an exhausted-add-budget HOLD day to a tight summary", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "No transaction available: weekly add limit is exhausted.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        bestAction: "No transaction: weekly add limit is exhausted.",
        decisionConfidence: "hold",
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
        optimalLineup: [],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    // HOLD collapse: only title + reason + closest + compact header. The verbose
    // add-trigger / manager-read / decision sections are echoes and are suppressed.
    expect(message).toContain("⚾ Fantasy GM — HOLD");
    expect(message).toContain("No transaction: weekly add limit is exhausted.");
    expect(message).toContain("Closest: SB");
    expect(message).toContain("➕ 0 adds left");
    expect(message).not.toContain("🧭 Add Triggers");
    expect(message).not.toContain("No add triggers are active");
    expect(message).not.toContain("🧠 Manager Read");
    expect(message).not.toContain("Hitter stream");
    expect(message).not.toContain("SP stream");
    expect(message).not.toContain("Late-week snipe");
    expect(message.split("\n").length).toBeLessThan(10);
  });

  it("renders the full optimal lineup as a slot-by-slot block", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Lineup is set.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: [],
        categorySituations: [],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        optimalLineup: [
          {
            slot: "SP",
            kind: "pitcher",
            playerKey: "ace",
            playerName: "Ace Pitcher",
            score: 5,
            isCurrentStarter: true,
          },
          {
            slot: "C",
            kind: "batter",
            playerKey: "catcher",
            playerName: "Sánchez",
            score: 2,
            isCurrentStarter: true,
          },
          {
            slot: "Util",
            kind: "batter",
            playerKey: "power-bench",
            playerName: "Power Bench",
            score: 4,
            isCurrentStarter: false,
          },
        ],
        optimalBench: [
          { kind: "batter", playerKey: "low-power", playerName: "Low Power", score: 1 },
        ],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    expect(message).toContain("🟢 Lineup");
    expect(message).toContain("C  Sánchez");
    expect(message).toContain("Util  Power Bench");
    expect(message).toContain("SP  Ace Pitcher");
    expect(message).toContain("Bench: Low Power");
    const cIndex = message.indexOf("C  Sánchez");
    const spIndex = message.indexOf("SP  Ace Pitcher");
    expect(cIndex).toBeLessThan(spIndex);
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
        optimalLineup: [],
        optimalBench: [],
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
        waiverTargets: [],
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
    // "🔎 Why" / "🧱 Blockers" sections are removed: decisionEvidence is a pure echo of
    // the header (summary/adds/IP/closest) + Manager Read, and decisionBlockers echoes
    // the Add Triggers / Yahoo Writes / Guardrails sections.
    expect(message).not.toContain("🔎 Why");
    expect(message).not.toContain("🧱 Blockers");
    expect(message).not.toContain("adds: 2 left, 0 reserved");
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

  it("collapses a do-nothing HOLD day but keeps the real write-auth and next-start alerts", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "No urgent lineup change; closest categories are SB, OBP.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        bestAction: "No transaction clears the manager bar right now.",
        decisionConfidence: "hold",
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
        optimalLineup: [],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    // The scoreboard is echo noise on a do-nothing day, so it is suppressed; the
    // genuinely-actionable write-auth and next-start lines are still surfaced.
    expect(message).toContain("⚾ Fantasy GM — HOLD");
    expect(message).not.toContain("📊 Scoreboard");
    expect(message).not.toContain("Trail SB: 2-3");
    expect(message).toContain("Closest: SB, OBP");
    expect(message).toContain("Yahoo writes are not authorized yet");
    expect(message).toContain("🗓️ Next: Scheduled Starter (SP): 1.0 expected start(s)");
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
        optimalLineup: [],
        optimalBench: [],
        doNow: [
          new ManualAction({
            priority: 1,
            action: "Add Speed Bat into the open active slot",
            confidence: "act",
            categories: ["SB"],
            rationale: "Add Speed Bat: targets SB.",
            checks: [],
            stopIf: [],
            yahooSteps: [],
          }),
        ],
        holdForLater: [],
        waiverTargets: [],
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

  it("collapses a blocked (review-only) decision into the HOLD summary", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "One add clears the model but not the timing guardrail.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        bestAction: "Blocked: Add Speed Bat into the open roster spot",
        decisionConfidence: "low",
        closestCategories: ["SB"],
        addsRemaining: 2,
        reservedAdds: 0,
        projectedWeeklyIp: 21,
        categorySituations: [],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        rejectedTransactions: [],
        optimalLineup: [],
        optimalBench: [],
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
        waiverTargets: [],
        warnings: [],
      }),
    );

    // A review/blocked add does not clear the bar, so it is a HOLD day: collapse the
    // verbose blocked-decision block down to the one-line bestAction summary.
    expect(message).toContain("⚾ Fantasy GM — HOLD");
    expect(message).toContain("Blocked: Add Speed Bat into the open roster spot");
    expect(message).not.toContain("🧱 Blocked Decision");
    expect(message).not.toContain("[BLOCKED]");
    expect(message).not.toContain("Focus:");
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
        optimalLineup: [],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    expect(message).toContain("3. Move Injured Catcher from C to IL");
    expect(message).not.toContain("Consider starting");
    expect(message).not.toContain("Start Bench Bat over Cold Starter");
  });

  it("renders the best available add when nothing clears the bar", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "No transaction clears the current safety bar.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["HR"],
        categorySituations: [],
        bestAvailableAdd: {
          playerName: "Carrasco",
          score: -0.05,
          categories: [],
          reason: "below add bar, would not improve a category",
          clearsBar: false,
        },
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        rejectedTransactions: [],
        optimalLineup: [],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    expect(message).toContain(
      "Best available: Carrasco (-0.05) — below add bar, would not improve a category.",
    );
  });

  it("omits the best available line when the add clears the bar", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Act-now move found.",
        generatedAt: "2026-06-06T18:00:00.000Z",
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["RBI"],
        categorySituations: [],
        bestAvailableAdd: {
          playerName: "Useful Add",
          score: 2.2,
          categories: ["RBI"],
          reason: "clears the add bar",
          clearsBar: true,
        },
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        rejectedTransactions: [],
        optimalLineup: [],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    expect(message).not.toContain("Best available:");
  });

  it("renders the approved compact HOLD layout with no echoed sections", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "No act-now move clears the bar from the current Yahoo setup.",
        generatedAt: "2026-06-19T13:38:00.000Z",
        bestAction: "No move clears the bar today.",
        decisionConfidence: "hold",
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 28,
        closestCategories: ["WHIP", "OBP", "ERA", "HR", "RBI"],
        todayGameWindow: {
          date: "2026-06-19",
          games: 14,
          remainingGames: 14,
          firstGameTime: "2026-06-19T18:20:00.000Z",
        },
        categorySituations: [
          { category: "WHIP", myValue: "1.20", opponentValue: "1.18", status: "losing" },
        ],
        managerTakeaways: [
          "Lineup first: no hard-unavailable active player is blocking decisions.",
        ],
        categoryPlan: ["Protect: HR 10-9."],
        addTriggers: [
          "Hitter stream: only if HR/TB/RBI/H can move without dropping a protected player.",
        ],
        lineupAlerts: ["Brent Rooker (IL10) stuck active at OF — no IL/BN slot open yet."],
        writeAlerts: ["Yahoo write auth missing — dry-run only."],
        pitcherStarts: ["Emmet Sheehan SP, ~1 start vs BAL (6/21)"],
        rejectedTransactions: [
          {
            addPlayerName: "Bench Arm",
            score: -0.1,
            affectedCategories: [],
            reason: "below add bar",
          },
        ],
        optimalLineup: [],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: ["The 20-IP floor appears covered; do not add risky pitchers just for volume."],
      }),
    );

    expect(message).toContain("⚾ Fantasy GM — HOLD");
    expect(message).toContain("No move clears the bar today.");
    expect(message).toContain("Closest: WHIP, OBP, ERA, HR, RBI");
    expect(message).toContain("🕒 Jun 19,");
    expect(message).toContain("14/14 games");
    expect(message).toContain("(first Jun 19, 2:20 PM EDT)");
    expect(message).toContain("➕ 6 adds left · ⚾ 28.0 IP");
    expect(message).toContain("🚨 Brent Rooker (IL10) stuck active at OF");
    expect(message).toContain("🔐 Yahoo write auth missing — dry-run only.");
    expect(message).toContain("🗓️ Next: Emmet Sheehan SP, ~1 start vs BAL (6/21)");

    // No echo sections at all on a HOLD day.
    expect(message).not.toContain("🔎 Why");
    expect(message).not.toContain("🧱 Blockers");
    expect(message).not.toContain("🧭 Add Triggers");
    expect(message).not.toContain("🛑 Guardrails");
    expect(message).not.toContain("🧠 Manager Read");
    expect(message).not.toContain("📊 Scoreboard");
    expect(message).not.toContain("✅ Best Current Action");
    expect(message.split("\n").length).toBeLessThan(14);
  });

  it("renders the full optimal lineup with promotions on an action day", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Set the optimal lineup; a bench bat is a promotion.",
        generatedAt: "2026-06-19T13:38:00.000Z",
        bestAction: "Set optimal lineup before lock.",
        decisionConfidence: "high",
        addsRemaining: 3,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["HR"],
        categorySituations: [],
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        optimalLineup: [
          {
            slot: "C",
            kind: "batter",
            playerKey: "c1",
            playerName: "Starter Catcher",
            score: 2,
            isCurrentStarter: true,
          },
          {
            slot: "Util",
            kind: "batter",
            playerKey: "promo",
            playerName: "Promote Me",
            score: 4,
            isCurrentStarter: false,
          },
        ],
        optimalBench: [{ kind: "batter", playerKey: "bn1", playerName: "Cold Bat", score: 1 }],
        rejectedTransactions: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    expect(message).toContain("⚾ Fantasy GM");
    expect(message).not.toContain("— HOLD");
    expect(message).toContain("🟢 Lineup");
    expect(message).toContain("C  Starter Catcher");
    expect(message).toContain("Util  Promote Me ⬆️");
    expect(message).toContain("Bench: Cold Bat");
  });

  it("does not repeat the best-available add in the skipped section", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Nothing clears the bar.",
        generatedAt: "2026-06-19T13:38:00.000Z",
        bestAction: "No transaction clears the manager bar right now.",
        decisionConfidence: "hold",
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["HR"],
        categorySituations: [],
        bestAvailableAdd: {
          playerName: "Carrasco",
          score: -0.05,
          categories: [],
          reason: "below add bar",
          clearsBar: false,
        },
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: ["Hot Bat (IL10) stuck active at OF — no IL/BN slot open yet."],
        writeAlerts: ["Yahoo write auth missing — dry-run only."],
        rejectedTransactions: [
          {
            addPlayerName: "Carrasco",
            score: -0.05,
            affectedCategories: [],
            reason: "below add bar",
          },
        ],
        optimalLineup: [],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    // HOLD shows the best-available line once; the skipped section is suppressed on HOLD
    // anyway, but Carrasco/below add bar must never appear twice.
    expect(occurrences(message, "Carrasco")).toBe(1);
    expect(occurrences(message, "Yahoo write auth missing — dry-run only.")).toBe(1);
    expect(occurrences(message, "WHIP")).toBeLessThanOrEqual(0);
    expect(occurrences(message, "Closest: HR")).toBe(1);
  });

  it("de-dups the best-available add against skipped on an action day", () => {
    const message = renderManagerBriefingForTelegram(
      new ManagerBriefingReport({
        summary: "Set the optimal lineup.",
        generatedAt: "2026-06-19T13:38:00.000Z",
        bestAction: "Set optimal lineup before lock.",
        decisionConfidence: "high",
        addsRemaining: 6,
        reservedAdds: 0,
        projectedWeeklyIp: 24,
        closestCategories: ["HR"],
        categorySituations: [],
        bestAvailableAdd: {
          playerName: "Carrasco",
          score: -0.05,
          categories: [],
          reason: "below add bar",
          clearsBar: false,
        },
        managerTakeaways: [],
        categoryPlan: [],
        addTriggers: [],
        lineupAlerts: [],
        rejectedTransactions: [
          {
            addPlayerName: "Carrasco",
            score: -0.05,
            affectedCategories: [],
            reason: "below add bar",
          },
          { addPlayerName: "Other Guy", score: -0.2, affectedCategories: [], reason: "worse fit" },
        ],
        optimalLineup: [
          {
            slot: "Util",
            kind: "batter",
            playerKey: "promo",
            playerName: "Promote Me",
            score: 4,
            isCurrentStarter: false,
          },
        ],
        optimalBench: [],
        doNow: [],
        holdForLater: [],
        waiverTargets: [],
        warnings: [],
      }),
    );

    const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

    // Carrasco is the best-available line; it must not be repeated under ⛔ Skipped.
    expect(message).toContain("Best available: Carrasco");
    expect(occurrences(message, "Carrasco")).toBe(1);
    expect(message).toContain("⛔ Skipped");
    expect(message).toContain("Other Guy: worse fit");
  });
});
