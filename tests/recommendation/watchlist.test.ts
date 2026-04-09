import { describe, expect, it } from "vitest";
import { matchAlertToFreeAgent, normalizePlayerName } from "../../src/recommendation/watchlist";

describe("watchlist helpers", () => {
  it("normalizes punctuation and suffixes in player names", () => {
    expect(normalizePlayerName("Ronald Acuna Jr.")).toBe("ronald acuna");
    expect(normalizePlayerName("O'Neil-Cruz")).toBe("o neil cruz");
  });

  it("matches alerts to free agents by normalized name and team", () => {
    const player = matchAlertToFreeAgent(
      { playerName: "Ronald Acuna Jr.", team: "ATL" },
      [
        {
          yahooId: "1",
          name: "Ronald Acuna",
          team: "ATL",
          positions: ["OF"],
        },
      ],
    );

    expect(player?.yahooId).toBe("1");
  });
});
