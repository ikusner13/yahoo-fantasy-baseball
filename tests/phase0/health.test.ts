import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { HealthResponse, makeHealthResponse } from "../../src/http/health";

describe("Phase 0 health payload", () => {
  it("encodes the cumulative-category H2H baseline", () => {
    const response = makeHealthResponse(1);
    const decoded = Schema.decodeUnknownSync(HealthResponse)(response);

    expect(decoded.ok).toBe(true);
    expect(decoded.stack).toBe("effect-v4-alchemy-v2");
    expect(decoded.leagueId).toBe("62744");
    expect(decoded.teamId).toBe("12");
    expect(decoded.weeklyAddLimit).toBe(6);
    expect(decoded.cronCount).toBe(1);
    expect(decoded.freeTier).toMatchObject({
      mode: "cloudflare-workers-free",
      cronWithinLimit: true,
      maxCronTriggers: 1,
      workerRequestsPerDayBudget: 100_000,
      maxExternalSubrequestsPerInvocation: 50,
      dailyTaskLimits: {
        "refresh-projections": 2,
        "refresh-context": 12,
        "send-briefing": 1,
      },
      defaults: {
        maxConfirmedLineupBoxscores: 0,
        useStandingsHistory: false,
        dailyBriefingHourUtcFallback: 22,
      },
    });
    expect(decoded.scoringCategories).toEqual([
      "R",
      "H",
      "HR",
      "RBI",
      "SB",
      "TB",
      "OBP",
      "OUT",
      "K",
      "ERA",
      "WHIP",
      "QS",
      "SV+H",
    ]);
  });
});
