import { describe, expect, it } from "vite-plus/test";

import { isUnavailableFreeAgentStatus } from "../../src/services/WeeklyProjections";

describe("WeeklyProjections", () => {
  it("excludes hard-unavailable Yahoo free agents before projection ranking", () => {
    expect(isUnavailableFreeAgentStatus("SUSP")).toBe(true);
    expect(isUnavailableFreeAgentStatus("IL15")).toBe(true);
    expect(isUnavailableFreeAgentStatus("IL60")).toBe(true);
    expect(isUnavailableFreeAgentStatus("NA")).toBe(true);
    expect(isUnavailableFreeAgentStatus("O")).toBe(true);

    expect(isUnavailableFreeAgentStatus(undefined)).toBe(false);
    expect(isUnavailableFreeAgentStatus("DTD")).toBe(false);
  });
});
