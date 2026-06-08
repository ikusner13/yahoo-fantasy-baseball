import { describe, expect, it } from "vite-plus/test";

import { evaluateManagerHealth, managerHealthDefaults } from "../../src/services/ManagerHealth";
import { ManagerBriefingReport } from "../../src/services/ManagerBriefing";
import { SchedulerStatus, SchedulerTaskStatus } from "../../src/services/Scheduler";

const schedulerStatus = (completedAt?: string) =>
  new SchedulerStatus({
    date: "2026-06-07",
    tasks: [
      new SchedulerTaskStatus({
        task: "send-briefing",
        completedAt,
        runCountToday: completedAt == null ? 0 : 1,
        canRunToday: true,
      }),
    ],
  });

const briefing = (generatedAt: string) =>
  new ManagerBriefingReport({
    summary: "Manager summary.",
    generatedAt,
    addsRemaining: 6,
    reservedAdds: 0,
    projectedWeeklyIp: 30,
    closestCategories: ["SB"],
    categorySituations: [],
    managerTakeaways: [],
    categoryPlan: [],
    addTriggers: [],
    lineupAlerts: [],
    rejectedTransactions: [],
    doNow: [],
    holdForLater: [],
    warnings: [],
  });

describe("ManagerHealth", () => {
  it("passes when the cached briefing is fresh and send-briefing ran today", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      undefined,
      {
        ...managerHealthDefaults,
        requireSentToday: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(true);
    expect(health.failures).toEqual([]);
    expect(health.briefingAgeMinutes).toBe(30);
  });

  it("fails when the briefing is stale", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T12:00:00.000Z"),
      briefing("2026-06-07T12:00:00.000Z"),
      undefined,
      {
        maxBriefingAgeMinutes: 60,
        requireSentToday: false,
        requireDelivery: false,
        now: new Date("2026-06-07T14:00:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures.join(" ")).toContain("cached briefing is 120m old");
  });

  it("fails when a same-day send is required but missing", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-06T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      undefined,
      {
        ...managerHealthDefaults,
        requireSentToday: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures.join(" ")).toContain("not 2026-06-07");
  });

  it("fails when the cached briefing is missing", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      undefined,
      undefined,
      {
        ...managerHealthDefaults,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures).toContain("cached briefing is missing");
  });

  it("fails when delivery is required but missing", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      undefined,
      {
        ...managerHealthDefaults,
        requireDelivery: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures).toContain("delivery report is missing");
  });

  it("fails when a same-day successful delivery is required but latest delivery is from yesterday", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      {
        generatedAt: "2026-06-07T18:00:00.000Z",
        deliveredAt: "2026-06-06T23:55:00.000Z",
        channels: [
          {
            channel: "telegram",
            ok: true,
            completedAt: "2026-06-06T23:55:00.000Z",
          },
        ],
      },
      {
        ...managerHealthDefaults,
        requireDeliveredToday: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures).toContain("latest delivery completed on 2026-06-06, not 2026-06-07");
    expect(health.failures).toContain("latest delivery has no successful channel on 2026-06-07");
  });

  it("passes same-day delivery health when at least one channel succeeded today", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      {
        generatedAt: "2026-06-07T18:00:00.000Z",
        deliveredAt: "2026-06-07T18:00:05.000Z",
        channels: [
          {
            channel: "telegram",
            ok: true,
            completedAt: "2026-06-07T18:00:05.000Z",
          },
        ],
      },
      {
        ...managerHealthDefaults,
        requireDeliveredToday: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(true);
    expect(health.deliverySucceeded).toBe(true);
  });

  it("fails when the latest delivery had no successful channel", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      {
        generatedAt: "2026-06-07T18:00:00.000Z",
        deliveredAt: "2026-06-07T18:00:05.000Z",
        channels: [
          {
            channel: "telegram",
            ok: false,
            completedAt: "2026-06-07T18:00:05.000Z",
            error: "timeout",
          },
        ],
      },
      {
        ...managerHealthDefaults,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures).toContain("latest delivery report has no successful channel");
    expect(health.deliverySucceeded).toBe(false);
  });

  it("fails strict manager health when Yahoo write status is missing", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      undefined,
      undefined,
      {
        ...managerHealthDefaults,
        requireYahooWrites: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures).toContain(
      "Yahoo write status is missing; safe lineup auto-apply has not been checked",
    );
  });

  it("fails strict manager health when Yahoo writes are unauthorized", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      undefined,
      {
        checkedAt: "2026-06-07T18:05:00.000Z",
        capability: "unauthorized",
        action: "apply-lineup",
        ok: false,
        date: "2026-06-07",
      },
      {
        ...managerHealthDefaults,
        requireYahooWrites: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(false);
    expect(health.failures).toContain(
      "Yahoo writes are unauthorized; safe lineup auto-apply is not authorized",
    );
  });

  it("passes strict manager health after authorized write verification", () => {
    const health = evaluateManagerHealth(
      schedulerStatus("2026-06-07T18:00:00.000Z"),
      briefing("2026-06-07T18:00:00.000Z"),
      undefined,
      {
        checkedAt: "2026-06-07T18:05:00.000Z",
        capability: "authorized",
        action: "post-auth-apply-lineup",
        ok: true,
        date: "2026-06-07",
      },
      {
        ...managerHealthDefaults,
        requireYahooWrites: true,
        now: new Date("2026-06-07T18:30:00.000Z"),
      },
    );

    expect(health.ok).toBe(true);
  });
});
