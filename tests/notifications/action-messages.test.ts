import { describe, expect, it } from "vitest";
import { formatPickupNotification } from "../../src/notifications/action-messages";
import type { Env } from "../../src/types";

function buildEnv(): Env {
  return {
    db: {} as Env["db"],
    KV: {} as KVNamespace,
    YAHOO_CLIENT_ID: "x",
    YAHOO_CLIENT_SECRET: "x",
    TELEGRAM_BOT_TOKEN: "x",
    YAHOO_LEAGUE_ID: "62744",
    YAHOO_TEAM_ID: "12",
    TELEGRAM_CHAT_ID: "x",
  };
}

describe("formatPickupNotification", () => {
  it("renders matchup EV deltas without mislabeled z-scores", () => {
    const text = formatPickupNotification(
      buildEnv(),
      [
        {
          addName: "Closer X",
          dropName: "Bench Bat",
          netValue: 4.2,
          winProbabilityDelta: 0.041,
          expectedCategoryWinsDelta: 0.24,
          priority: "critical",
          reasoning: "Win odds 54% → 58%. Helps SVHD.",
          method: "waiver",
        },
      ],
      6,
    );

    expect(text).toContain("+4.1pp win odds");
    expect(text).toContain("+0.24 cats");
    expect(text).not.toContain("z |");
    expect(text).toContain("Manual execution required in Yahoo");
    expect(text).toContain("Review transactions in Yahoo");
  });
});
