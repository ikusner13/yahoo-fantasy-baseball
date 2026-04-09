import { describe, expect, it } from "vitest";
import { getEnvNow, getTodayIso, setEnvNowOverride } from "../src/time";
import type { Env } from "../src/types";

function buildEnv(): Env {
  return {
    db: {} as Env["db"],
    KV: {} as KVNamespace,
    YAHOO_CLIENT_ID: "x",
    YAHOO_CLIENT_SECRET: "x",
    TELEGRAM_BOT_TOKEN: "x",
    YAHOO_LEAGUE_ID: "x",
    YAHOO_TEAM_ID: "x",
    TELEGRAM_CHAT_ID: "x",
  };
}

describe("time helpers", () => {
  it("normalizes a date-only override to a stable same-day timestamp", () => {
    const env = buildEnv();
    setEnvNowOverride(env, "2026-04-10");

    expect(env._nowIso).toBe("2026-04-10T12:00:00Z");
    expect(getTodayIso(env)).toBe("2026-04-10");
  });

  it("accepts a full ISO datetime override", () => {
    const env = buildEnv();
    setEnvNowOverride(env, "2026-04-10T15:30:00Z");

    expect(getEnvNow(env).toISOString()).toBe("2026-04-10T15:30:00.000Z");
    expect(getTodayIso(env)).toBe("2026-04-10");
  });

  it("ignores invalid override values", () => {
    const env = buildEnv();
    setEnvNowOverride(env, "not-a-date");

    expect(env._nowIso).toBeUndefined();
  });
});
