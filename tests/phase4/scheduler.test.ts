import { describe, expect, it } from "vite-plus/test";

import {
  ManagerDeliveryChannelResult,
  ManagerDeliveryReport,
} from "../../src/services/ManagerDelivery";
import {
  isBriefingDue,
  isPregameBriefingDue,
  selectDueTask,
  shouldCountTaskRun,
  shouldEvaluateBriefingDue,
  shouldAttemptAutomaticLineupWrite,
  shouldMarkSendBriefingComplete,
} from "../../src/services/Scheduler";
import { ManagerWriteStatus } from "../../src/services/ManagerWriteStatus";

const canRunAll = {
  "refresh-projections": true,
  "refresh-context": true,
  "apply-lineup": true,
  "send-briefing": true,
};

describe("Scheduler", () => {
  it("prioritizes safe lineup application before an eligible briefing", () => {
    const now = new Date("2026-06-07T17:00:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T16:30:00.000Z"),
        },
        canRunAll,
        true,
      ),
    ).toBe("apply-lineup");
  });

  it("sends the briefing after a same-day lineup application attempt", () => {
    const now = new Date("2026-06-07T17:00:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T16:30:00.000Z"),
          applyLineupAt: Date.parse("2026-06-07T16:55:00.000Z"),
        },
        canRunAll,
        true,
      ),
    ).toBe("send-briefing");
  });

  it("still refreshes projections before sending a briefing", () => {
    const now = new Date("2026-06-07T17:00:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-06T04:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T15:00:00.000Z"),
          applyLineupAt: Date.parse("2026-06-07T16:55:00.000Z"),
        },
        canRunAll,
        true,
      ),
    ).toBe("refresh-projections");
  });

  it("refreshes stale context before lineup application and briefing send", () => {
    const now = new Date("2026-06-07T17:00:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T15:45:00.000Z"),
        },
        canRunAll,
        true,
      ),
    ).toBe("refresh-context");
  });

  it("does not resend after a same-day successful briefing", () => {
    const now = new Date("2026-06-07T18:00:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T17:00:00.000Z"),
          applyLineupAt: Date.parse("2026-06-07T17:20:00.000Z"),
          sendAt: Date.parse("2026-06-07T17:29:07.788Z"),
        },
        canRunAll,
        true,
      ),
    ).toBe("idle");
  });

  it("sends one stale briefing refresh after context updates later", () => {
    const now = new Date("2026-06-07T21:30:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T20:45:00.000Z"),
          applyLineupAt: Date.parse("2026-06-07T16:55:00.000Z"),
          sendAt: Date.parse("2026-06-07T18:00:00.000Z"),
        },
        canRunAll,
        true,
      ),
    ).toBe("send-briefing");
  });

  it("does not refresh the briefing too soon after a same-day send", () => {
    const now = new Date("2026-06-07T18:45:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T18:30:00.000Z"),
          applyLineupAt: Date.parse("2026-06-07T16:55:00.000Z"),
          sendAt: Date.parse("2026-06-07T18:00:00.000Z"),
        },
        canRunAll,
        true,
      ),
    ).toBe("idle");
  });

  it("does not refresh the briefing after the daily send cap is reached", () => {
    const now = new Date("2026-06-07T21:30:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T20:45:00.000Z"),
          applyLineupAt: Date.parse("2026-06-07T16:55:00.000Z"),
          sendAt: Date.parse("2026-06-07T18:00:00.000Z"),
        },
        { ...canRunAll, "send-briefing": false },
        true,
      ),
    ).toBe("idle");
  });

  it("does not use the morning briefing window for same-day refresh sends", () => {
    const now = new Date("2026-06-07T16:30:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T16:00:00.000Z"),
          applyLineupAt: Date.parse("2026-06-07T14:05:00.000Z"),
          sendAt: Date.parse("2026-06-07T14:00:00.000Z"),
        },
        canRunAll,
        true,
        false,
      ),
    ).toBe("idle");
  });

  it("sends a morning-only briefing instead of delaying it for lineup application", () => {
    const now = new Date("2026-06-07T14:00:00.000Z");

    expect(
      selectDueTask(
        now,
        {
          projectionAt: Date.parse("2026-06-07T12:00:00.000Z"),
          contextAt: Date.parse("2026-06-07T13:30:00.000Z"),
        },
        canRunAll,
        true,
        false,
        false,
      ),
    ).toBe("send-briefing");
  });

  it("does not count forced manual task runs against automatic scheduler caps", () => {
    expect(shouldCountTaskRun()).toBe(true);
    expect(shouldCountTaskRun({ force: false })).toBe(true);
    expect(shouldCountTaskRun({ force: true })).toBe(false);
  });

  it("evaluates briefing due whenever the automatic send budget is available", () => {
    expect(shouldEvaluateBriefingDue(true)).toBe(true);
    expect(shouldEvaluateBriefingDue(false)).toBe(false);
  });

  it("marks the briefing due at the hourly tick before first pitch", () => {
    expect(
      isPregameBriefingDue(new Date("2026-06-09T21:00:00.000Z"), {
        firstGameTime: "2026-06-09T22:35:00.000Z",
        sendHourUtc: 22,
      }),
    ).toBe(true);
  });

  it("does not mark the briefing due more than two hours before first pitch", () => {
    expect(
      isPregameBriefingDue(new Date("2026-06-09T20:34:59.000Z"), {
        firstGameTime: "2026-06-09T22:35:00.000Z",
        sendHourUtc: 22,
      }),
    ).toBe(false);
  });

  it("marks the morning briefing due at 10am eastern", () => {
    expect(
      isBriefingDue(new Date("2026-06-09T13:59:59.000Z"), {
        sendHourUtc: 22,
        morningHourEastern: 10,
      }),
    ).toBe(false);
    expect(
      isBriefingDue(new Date("2026-06-09T14:00:00.000Z"), {
        sendHourUtc: 22,
        morningHourEastern: 10,
      }),
    ).toBe(true);
  });

  it("falls back to the configured send hour when game schedule is unavailable", () => {
    expect(
      isBriefingDue(new Date("2026-06-09T21:59:59.000Z"), {
        sendHourUtc: 22,
        morningHourEastern: 23,
      }),
    ).toBe(false);
    expect(
      isBriefingDue(new Date("2026-06-09T22:00:00.000Z"), {
        sendHourUtc: 22,
        morningHourEastern: 23,
      }),
    ).toBe(true);
  });

  it("blocks automatic lineup writes after Yahoo write auth is known unauthorized", () => {
    expect(shouldAttemptAutomaticLineupWrite(undefined)).toBe(true);
    expect(
      shouldAttemptAutomaticLineupWrite(
        new ManagerWriteStatus({
          checkedAt: "2026-06-07T20:39:47.767Z",
          capability: "unauthorized",
          action: "apply-lineup",
          ok: false,
          date: "2026-06-07",
          error: "Yahoo rejected lineup write.",
        }),
      ),
    ).toBe(false);
    expect(
      shouldAttemptAutomaticLineupWrite(
        new ManagerWriteStatus({
          checkedAt: "2026-06-07T20:39:47.767Z",
          capability: "authorized",
          action: "apply-lineup",
          ok: true,
          date: "2026-06-07",
        }),
      ),
    ).toBe(true);
  });

  it("marks send-briefing complete only after Telegram succeeds", () => {
    const delivered = new ManagerDeliveryReport({
      generatedAt: "2026-06-07T17:29:00.000Z",
      deliveredAt: "2026-06-07T17:29:07.000Z",
      channels: [
        new ManagerDeliveryChannelResult({
          channel: "telegram",
          ok: true,
          completedAt: "2026-06-07T17:29:06.000Z",
        }),
        new ManagerDeliveryChannelResult({
          channel: "discord",
          ok: false,
          completedAt: "2026-06-07T17:29:07.000Z",
          error: "unauthorized",
        }),
      ],
    });
    const discordOnly = new ManagerDeliveryReport({
      generatedAt: "2026-06-07T17:29:00.000Z",
      deliveredAt: "2026-06-07T17:29:07.000Z",
      channels: [
        new ManagerDeliveryChannelResult({
          channel: "telegram",
          ok: false,
          completedAt: "2026-06-07T17:29:06.000Z",
          error: "timeout",
        }),
        new ManagerDeliveryChannelResult({
          channel: "discord",
          ok: true,
          completedAt: "2026-06-07T17:29:07.000Z",
        }),
      ],
    });
    const failed = new ManagerDeliveryReport({
      generatedAt: "2026-06-07T17:29:00.000Z",
      deliveredAt: "2026-06-07T17:29:07.000Z",
      channels: [
        new ManagerDeliveryChannelResult({
          channel: "telegram",
          ok: false,
          completedAt: "2026-06-07T17:29:06.000Z",
          error: "timeout",
        }),
        new ManagerDeliveryChannelResult({
          channel: "discord",
          ok: false,
          completedAt: "2026-06-07T17:29:07.000Z",
          error: "unauthorized",
        }),
      ],
    });

    expect(shouldMarkSendBriefingComplete(delivered)).toBe(true);
    expect(shouldMarkSendBriefingComplete(discordOnly)).toBe(false);
    expect(shouldMarkSendBriefingComplete(failed)).toBe(false);
  });
});
