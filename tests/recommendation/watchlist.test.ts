import { describe, expect, it } from "vitest";
import {
  buildWatchlistRecommendations,
  matchAlertToFreeAgent,
  normalizePlayerName,
} from "../../src/recommendation/watchlist";
import type { NewsAlert } from "../../src/monitors/news";

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

  it("upgrades matched closer alerts with pickup deltas to must-add", () => {
    const alert: NewsAlert = {
      type: "closer_change",
      playerName: "Robert Suarez",
      team: "SD",
      headline: "Robert Suarez is expected to handle the ninth inning",
      fantasyImpact: "Potential saves/holds impact",
      actionable: true,
      timestamp: "2026-04-09T12:00:00Z",
    };

    const recommendations = buildWatchlistRecommendations(
      [alert],
      [
        {
          yahooId: "suarez",
          name: "Robert Suarez",
          team: "SD",
          positions: ["RP"],
        },
      ],
      [
        {
          add: {
            yahooId: "suarez",
            name: "Robert Suarez",
            team: "SD",
            positions: ["RP"],
          },
          drop: {
            yahooId: "drop-1",
            name: "Bench Bat",
            team: "NYY",
            positions: ["OF"],
          },
          netValue: 1.2,
          reasoning: "Win odds 52% → 54%",
          winProbabilityDelta: 0.02,
          expectedCategoryWinsDelta: 0.24,
        },
      ],
    );

    expect(recommendations[0]?.tier).toBe("must_add_now");
    expect(recommendations[0]?.summary).toContain("Must add Robert Suarez now");
  });

  it("uses structured high-impact add signals to promote a watch alert", () => {
    const alert: NewsAlert = {
      type: "callup",
      playerName: "Jordan Beck",
      team: "COL",
      headline: "Jordan Beck recalled and expected to play regularly",
      fantasyImpact: "New MLB player — evaluate for roster add",
      actionable: true,
      timestamp: "2026-04-11T12:00:00Z",
      structured: {
        impactLevel: "high",
        roleChange: "playing_time_up",
        expectedAbsence: "none",
        actionBias: "add",
        playingTimeDelta: "up",
        targetCategories: ["R", "HR"],
        confidence: 0.86,
        summary: "Playing time spike expected",
      },
    };

    const recommendations = buildWatchlistRecommendations(
      [alert],
      [
        {
          yahooId: "beck",
          name: "Jordan Beck",
          team: "COL",
          positions: ["OF"],
        },
      ],
      [],
    );

    expect(recommendations[0]?.tier).toBe("strong_watch");
    expect(recommendations[0]?.summary).toContain("Playing time spike expected");
  });
});
