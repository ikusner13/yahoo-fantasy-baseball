import { afterEach, describe, expect, it, vi } from "vitest";
import { getRotationProjection, getTwoStartPitchers } from "../../src/analysis/two-start";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("two-start analysis", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("limits rotation projection to the requested Mon-Sun window", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("hydrate=probablePitcher")) {
        return jsonResponse({
          dates: [
            {
              date: "2026-04-12",
              games: [
                {
                  teams: {
                    home: {
                      team: { abbreviation: "SEA" },
                      probablePitcher: { id: 1, fullName: "George Kirby" },
                    },
                    away: { team: { abbreviation: "HOU" } },
                  },
                },
              ],
            },
          ],
        });
      }

      expect(url).toContain("startDate=2026-04-13");
      expect(url).toContain("endDate=2026-04-19");

      return jsonResponse({
        dates: [
          { date: "2026-04-13", games: [{}] },
          { date: "2026-04-15", games: [{}] },
          { date: "2026-04-18", games: [{}] },
        ],
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const projection = await getRotationProjection("SEA", "2026-04-13", 7);

    expect(projection.map((slot) => slot.date)).toEqual(["2026-04-13", "2026-04-15", "2026-04-18"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never emits more than two starts for a probable two-start pitcher", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (
        url.includes("startDate=2026-04-13") &&
        url.includes("endDate=2026-04-19") &&
        url.includes("hydrate=probablePitcher")
      ) {
        return jsonResponse({
          dates: [
            {
              date: "2026-04-13",
              games: [
                {
                  teams: {
                    home: {
                      team: { abbreviation: "SEA" },
                      probablePitcher: { id: 1, fullName: "George Kirby" },
                    },
                    away: { team: { abbreviation: "HOU" } },
                  },
                },
              ],
            },
          ],
        });
      }

      if (url.includes("startDate=2026-04-03") && url.includes("endDate=2026-04-13")) {
        return jsonResponse({
          dates: [
            {
              date: "2026-04-08",
              games: [
                {
                  teams: {
                    home: {
                      team: { abbreviation: "SEA" },
                      probablePitcher: { id: 1, fullName: "George Kirby" },
                    },
                    away: { team: { abbreviation: "TEX" } },
                  },
                },
              ],
            },
          ],
        });
      }

      expect(url).toContain("teamId=136");
      return jsonResponse({
        dates: [
          { date: "2026-04-13", games: [{}] },
          { date: "2026-04-14", games: [{}] },
          { date: "2026-04-15", games: [{}] },
          { date: "2026-04-16", games: [{}] },
          { date: "2026-04-17", games: [{}] },
        ],
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const pitchers = await getTwoStartPitchers("2026-04-13", "2026-04-19");
    const kirby = pitchers.find((pitcher) => pitcher.mlbId === 1);

    expect(kirby).toBeDefined();
    expect(kirby?.starts).toEqual([
      { date: "2026-04-13", opponent: "HOU" },
      { date: "2026-04-14", opponent: "TBD" },
    ]);
  });
});
