import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { STAT_ID_TO_CATEGORY, YahooClient } from "../../src/yahoo/client";
import type { Category } from "../../src/types";

// Mock auth module at top level (vitest hoists vi.mock calls)
vi.mock("../../src/yahoo/auth", () => ({
  getValidToken: vi.fn().mockResolvedValue("mock-access-token"),
}));

// ---------------------------------------------------------------------------
// Test 1: STAT_ID_TO_CATEGORY mapping — the most critical data path
// ---------------------------------------------------------------------------

describe("STAT_ID_TO_CATEGORY", () => {
  const EXPECTED: Record<string, Category> = {
    "7": "R",
    "8": "H",
    "12": "HR",
    "13": "RBI",
    "16": "SB",
    "23": "TB",
    "4": "OBP",
    "33": "OUT",
    "42": "K",
    "26": "ERA",
    "27": "WHIP",
    "83": "QS",
    "89": "SVHD",
  };

  it("maps all 13 scoring categories", () => {
    expect(Object.keys(STAT_ID_TO_CATEGORY)).toHaveLength(13);
  });

  it("maps every stat_id to the correct category", () => {
    for (const [statId, category] of Object.entries(EXPECTED)) {
      expect(STAT_ID_TO_CATEGORY[statId], `stat_id ${statId}`).toBe(category);
    }
  });

  it("contains no extra stat_ids beyond scoring categories", () => {
    for (const statId of Object.keys(STAT_ID_TO_CATEGORY)) {
      expect(EXPECTED).toHaveProperty(statId);
    }
  });

  it("covers all batting categories", () => {
    const battingCats: Category[] = ["R", "H", "HR", "RBI", "SB", "TB", "OBP"];
    const mapped = Object.values(STAT_ID_TO_CATEGORY);
    for (const cat of battingCats) {
      expect(mapped, `missing batting category ${cat}`).toContain(cat);
    }
  });

  it("covers all pitching categories", () => {
    const pitchingCats: Category[] = ["OUT", "K", "ERA", "WHIP", "QS", "SVHD"];
    const mapped = Object.values(STAT_ID_TO_CATEGORY);
    for (const cat of pitchingCats) {
      expect(mapped, `missing pitching category ${cat}`).toContain(cat);
    }
  });

  it("has no duplicate category values", () => {
    const values = Object.values(STAT_ID_TO_CATEGORY);
    expect(new Set(values).size).toBe(values.length);
  });
});

// ---------------------------------------------------------------------------
// Test 2: getMatchup() end-to-end parsing via mocked fetch
// ---------------------------------------------------------------------------

// Real Yahoo API response fixture (shape from actual API call)
const MATCHUP_FIXTURE = {
  fantasy_content: {
    team: [
      [{ team_key: "469.l.62744.t.12" }, {}, { name: "Ian's Smashers" }],
      {
        matchups: {
          "0": {
            matchup: {
              week: "2",
              week_start: "2026-03-30",
              week_end: "2026-04-05",
              status: "midevent",
              "0": {
                teams: {
                  "0": {
                    team: [
                      [{ team_key: "469.l.62744.t.12" }, {}, { name: "Ian's Smashers" }],
                      {
                        team_stats: {
                          stats: [
                            { stat: { stat_id: "7", value: "25" } },
                            { stat: { stat_id: "8", value: "44" } },
                            { stat: { stat_id: "12", value: "10" } },
                            { stat: { stat_id: "13", value: "21" } },
                            { stat: { stat_id: "16", value: "4" } },
                            { stat: { stat_id: "23", value: "84" } },
                            { stat: { stat_id: "4", value: ".352" } },
                            { stat: { stat_id: "50", value: "35.2" } }, // IP (display-only)
                            { stat: { stat_id: "33", value: "107" } },
                            { stat: { stat_id: "42", value: "33" } },
                            { stat: { stat_id: "26", value: "3.28" } },
                            { stat: { stat_id: "27", value: "0.98" } },
                            { stat: { stat_id: "83", value: "2" } },
                            { stat: { stat_id: "89", value: "4" } },
                          ],
                        },
                      },
                    ],
                  },
                  "1": {
                    team: [
                      [{ team_key: "469.l.62744.t.5" }, {}, { name: "Professor Chaos" }],
                      {
                        team_stats: {
                          stats: [
                            { stat: { stat_id: "7", value: "26" } },
                            { stat: { stat_id: "8", value: "47" } },
                            { stat: { stat_id: "12", value: "7" } },
                            { stat: { stat_id: "13", value: "22" } },
                            { stat: { stat_id: "16", value: "4" } },
                            { stat: { stat_id: "23", value: "79" } },
                            { stat: { stat_id: "4", value: ".359" } },
                            { stat: { stat_id: "50", value: "48.0" } },
                            { stat: { stat_id: "33", value: "144" } },
                            { stat: { stat_id: "42", value: "43" } },
                            { stat: { stat_id: "26", value: "2.81" } },
                            { stat: { stat_id: "27", value: "1.04" } },
                            { stat: { stat_id: "83", value: "4" } },
                            { stat: { stat_id: "89", value: "3" } },
                          ],
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
};

describe("getMatchup() parsing", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchForMatchup() {
    // Mock fetch to return our fixture (auth already mocked at module level)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MATCHUP_FIXTURE),
      text: () => Promise.resolve(""),
    });
  }

  it("extracts week metadata", async () => {
    mockFetchForMatchup();
    const client = new YahooClient({
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_LEAGUE_ID: "62744",
      YAHOO_TEAM_ID: "12",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      KV: null as any,
      db: null as any,
    });

    const matchup = await client.getMatchup();
    expect(matchup.week).toBe("2");
    expect(matchup.weekStart).toBe("2026-03-30");
    expect(matchup.weekEnd).toBe("2026-04-05");
  });

  it("extracts opponent info", async () => {
    mockFetchForMatchup();
    const client = new YahooClient({
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_LEAGUE_ID: "62744",
      YAHOO_TEAM_ID: "12",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      KV: null as any,
      db: null as any,
    });

    const matchup = await client.getMatchup();
    expect(matchup.opponentTeamKey).toBe("469.l.62744.t.5");
    expect(matchup.opponentTeamName).toBe("Professor Chaos");
  });

  it("parses exactly 13 scoring categories (skips display-only stat_id 50)", async () => {
    mockFetchForMatchup();
    const client = new YahooClient({
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_LEAGUE_ID: "62744",
      YAHOO_TEAM_ID: "12",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      KV: null as any,
      db: null as any,
    });

    const matchup = await client.getMatchup();
    expect(matchup.categories).toHaveLength(13);

    // stat_id 50 (IP) should NOT appear
    const catNames = matchup.categories.map((c) => c.category);
    expect(catNames).not.toContain("IP");
  });

  it("maps stat values to correct categories with correct numbers", async () => {
    mockFetchForMatchup();
    const client = new YahooClient({
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_LEAGUE_ID: "62744",
      YAHOO_TEAM_ID: "12",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      KV: null as any,
      db: null as any,
    });

    const matchup = await client.getMatchup();
    const byCategory = Object.fromEntries(matchup.categories.map((c) => [c.category, c]));

    // Batting
    expect(byCategory.R.myValue).toBe(25);
    expect(byCategory.R.opponentValue).toBe(26);
    expect(byCategory.H.myValue).toBe(44);
    expect(byCategory.H.opponentValue).toBe(47);
    expect(byCategory.HR.myValue).toBe(10);
    expect(byCategory.HR.opponentValue).toBe(7);
    expect(byCategory.RBI.myValue).toBe(21);
    expect(byCategory.RBI.opponentValue).toBe(22);
    expect(byCategory.SB.myValue).toBe(4);
    expect(byCategory.SB.opponentValue).toBe(4);
    expect(byCategory.TB.myValue).toBe(84);
    expect(byCategory.TB.opponentValue).toBe(79);
    expect(byCategory.OBP.myValue).toBeCloseTo(0.352);
    expect(byCategory.OBP.opponentValue).toBeCloseTo(0.359);

    // Pitching
    expect(byCategory.OUT.myValue).toBe(107);
    expect(byCategory.OUT.opponentValue).toBe(144);
    expect(byCategory.K.myValue).toBe(33);
    expect(byCategory.K.opponentValue).toBe(43);
    expect(byCategory.ERA.myValue).toBeCloseTo(3.28);
    expect(byCategory.ERA.opponentValue).toBeCloseTo(2.81);
    expect(byCategory.WHIP.myValue).toBeCloseTo(0.98);
    expect(byCategory.WHIP.opponentValue).toBeCloseTo(1.04);
    expect(byCategory.QS.myValue).toBe(2);
    expect(byCategory.QS.opponentValue).toBe(4);
    expect(byCategory.SVHD.myValue).toBe(4);
    expect(byCategory.SVHD.opponentValue).toBe(3);
  });

  it("sends auth header in fetch call", async () => {
    mockFetchForMatchup();
    const client = new YahooClient({
      YAHOO_CLIENT_ID: "id",
      YAHOO_CLIENT_SECRET: "secret",
      YAHOO_LEAGUE_ID: "62744",
      YAHOO_TEAM_ID: "12",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      KV: null as any,
      db: null as any,
    });

    await client.getMatchup();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/team/mlb.l.62744.t.12/matchups"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer mock-access-token",
        }),
      }),
    );
  });
});
