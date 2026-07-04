import { describe, expect, it } from "vite-plus/test";

import { parseFlags, sentToday } from "../../scripts/daily-briefing";

describe("daily briefing CLI flags", () => {
  it("parses dry-run, force, and env-file flags", () => {
    expect(parseFlags(["--dry-run", "--force", "--env-file", ".env.test"])).toEqual({
      dryRun: true,
      force: true,
      envFile: ".env.test",
    });
    expect(parseFlags(["--env-file=.env.prod"])).toMatchObject({
      envFile: ".env.prod",
    });
  });
});

describe("sentToday guard", () => {
  const now = new Date("2026-07-04T14:00:00.000Z");

  it("treats same Eastern date as already sent", () => {
    expect(sentToday("2026-07-04T12:30:00.000Z", now)).toBe(true);
  });

  it("does not treat yesterday Eastern as sent today", () => {
    expect(sentToday("2026-07-04T03:30:00.000Z", now)).toBe(false);
  });
});
