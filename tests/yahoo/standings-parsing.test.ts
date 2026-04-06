import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { YahooClient } from "../../src/yahoo/client";

vi.mock("../../src/yahoo/auth", () => ({
  getValidToken: vi.fn().mockResolvedValue("mock-access-token"),
}));

// ---------------------------------------------------------------------------
// Standings fixture — 12 teams, based on real Yahoo API shape
// ---------------------------------------------------------------------------

function makeTeam(
  idx: number,
  teamKey: string,
  name: string,
  rank: number,
  wins: number,
  losses: number,
  ties: number,
  pct: string,
) {
  return {
    team: [
      [{ team_key: teamKey }, {}, { name }],
      {},
      {
        team_standings: {
          rank,
          outcome_totals: {
            wins,
            losses,
            ties,
            percentage: pct,
          },
        },
      },
    ],
  };
}

const STANDINGS_FIXTURE = {
  fantasy_content: {
    league: [
      { league_key: "469.l.62744" },
      {
        standings: [
          {
            teams: {
              count: 12,
              "0": makeTeam(0, "469.l.62744.t.1", "Team Alpha", 1, 9, 2, 2, ".769"),
              "1": makeTeam(1, "469.l.62744.t.2", "Team Bravo", 2, 8, 3, 2, ".692"),
              "2": makeTeam(2, "469.l.62744.t.3", "Team Charlie", 3, 7, 4, 2, ".615"),
              "3": makeTeam(3, "469.l.62744.t.12", "Ian's Smashers", 4, 6, 4, 3, ".577"),
              "4": makeTeam(4, "469.l.62744.t.5", "Professor Chaos", 5, 6, 5, 2, ".538"),
              "5": makeTeam(5, "469.l.62744.t.6", "Team Foxtrot", 6, 5, 5, 3, ".500"),
              "6": makeTeam(6, "469.l.62744.t.7", "Team Golf", 7, 5, 6, 2, ".462"),
              "7": makeTeam(7, "469.l.62744.t.8", "Team Hotel", 8, 4, 6, 3, ".423"),
              "8": makeTeam(8, "469.l.62744.t.9", "Team India", 9, 4, 7, 2, ".385"),
              "9": makeTeam(9, "469.l.62744.t.10", "Team Juliet", 10, 3, 8, 2, ".308"),
              "10": makeTeam(10, "469.l.62744.t.11", "Team Kilo", 11, 2, 9, 2, ".231"),
              "11": makeTeam(11, "469.l.62744.t.4", "Team Lima", 12, 1, 10, 2, ".154"),
            },
          },
        ],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Team rosters fixture (2 teams for brevity)
// ---------------------------------------------------------------------------

const ROSTERS_FIXTURE = {
  fantasy_content: {
    league: [
      { league_key: "469.l.62744" },
      {
        teams: {
          count: 2,
          "0": {
            team: [
              [{ team_key: "469.l.62744.t.12" }, {}, { name: "Ian's Smashers" }],
              {
                roster: {
                  "0": {
                    players: {
                      count: 2,
                      "0": {
                        player: [
                          [
                            { player_key: "469.p.12345" },
                            { name: { full: "Aaron Judge" } },
                            { editorial_team_abbr: "NYY" },
                            {
                              eligible_positions: [{ position: "OF" }, { position: "Util" }],
                            },
                          ],
                        ],
                      },
                      "1": {
                        player: [
                          [
                            { player_key: "469.p.67890" },
                            { name: { full: "Shohei Ohtani" } },
                            { editorial_team_abbr: "LAD" },
                            {
                              eligible_positions: [{ position: "Util" }],
                            },
                          ],
                        ],
                      },
                    },
                  },
                },
              },
            ],
          },
          "1": {
            team: [
              [{ team_key: "469.l.62744.t.5" }, {}, { name: "Professor Chaos" }],
              {
                roster: {
                  "0": {
                    players: {
                      count: 1,
                      "0": {
                        player: [
                          [
                            { player_key: "469.p.11111" },
                            { name: { full: "Mookie Betts" } },
                            { editorial_team_abbr: "LAD" },
                            {
                              eligible_positions: [{ position: "SS" }, { position: "OF" }],
                            },
                          ],
                        ],
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new YahooClient({
    YAHOO_CLIENT_ID: "id",
    YAHOO_CLIENT_SECRET: "secret",
    YAHOO_LEAGUE_ID: "62744",
    YAHOO_TEAM_ID: "12",
    TELEGRAM_BOT_TOKEN: "",
    TELEGRAM_CHAT_ID: "",
    DATA_DIR: "/tmp",
    db: null as any,
  });
}

function mockFetch(fixture: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(fixture),
    text: () => Promise.resolve(""),
  });
}

// ---------------------------------------------------------------------------
// Tests: getStandings()
// ---------------------------------------------------------------------------

describe("getStandings() parsing", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses all 12 teams", async () => {
    mockFetch(STANDINGS_FIXTURE);
    const standings = await makeClient().getStandings();
    expect(standings).toHaveLength(12);
  });

  it("parses our team (#4, 6-4-3) correctly", async () => {
    mockFetch(STANDINGS_FIXTURE);
    const standings = await makeClient().getStandings();
    const ours = standings.find((s) => s.teamKey === "469.l.62744.t.12");
    expect(ours).toBeDefined();
    expect(ours!.teamName).toBe("Ian's Smashers");
    expect(ours!.rank).toBe(4);
    expect(ours!.wins).toBe(6);
    expect(ours!.losses).toBe(4);
    expect(ours!.ties).toBe(3);
  });

  it("parses percentage as number not string", async () => {
    mockFetch(STANDINGS_FIXTURE);
    const standings = await makeClient().getStandings();
    for (const entry of standings) {
      expect(typeof entry.percentage).toBe("number");
      expect(entry.percentage).toBeGreaterThan(0);
      expect(entry.percentage).toBeLessThanOrEqual(1);
    }
  });

  it("parses first-place team correctly", async () => {
    mockFetch(STANDINGS_FIXTURE);
    const standings = await makeClient().getStandings();
    const first = standings.find((s) => s.rank === 1);
    expect(first).toBeDefined();
    expect(first!.teamName).toBe("Team Alpha");
    expect(first!.wins).toBe(9);
    expect(first!.percentage).toBeCloseTo(0.769);
  });

  it("returns empty array for missing standings data", async () => {
    mockFetch({ fantasy_content: { league: [{}] } });
    const standings = await makeClient().getStandings();
    expect(standings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: getTeamRosters()
// ---------------------------------------------------------------------------

describe("getTeamRosters() parsing", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("parses all teams", async () => {
    mockFetch(ROSTERS_FIXTURE);
    const rosters = await makeClient().getTeamRosters();
    expect(rosters).toHaveLength(2);
  });

  it("parses team metadata", async () => {
    mockFetch(ROSTERS_FIXTURE);
    const rosters = await makeClient().getTeamRosters();
    const ours = rosters.find((r) => r.teamKey === "469.l.62744.t.12");
    expect(ours).toBeDefined();
    expect(ours!.teamName).toBe("Ian's Smashers");
  });

  it("parses players via parsePlayer()", async () => {
    mockFetch(ROSTERS_FIXTURE);
    const rosters = await makeClient().getTeamRosters();
    const ours = rosters.find((r) => r.teamKey === "469.l.62744.t.12")!;
    expect(ours.players).toHaveLength(2);

    const judge = ours.players.find((p) => p.name === "Aaron Judge");
    expect(judge).toBeDefined();
    expect(judge!.yahooId).toBe("469.p.12345");
    expect(judge!.team).toBe("NYY");
    expect(judge!.positions).toContain("OF");
  });

  it("parses opponent roster players", async () => {
    mockFetch(ROSTERS_FIXTURE);
    const rosters = await makeClient().getTeamRosters();
    const opp = rosters.find((r) => r.teamKey === "469.l.62744.t.5")!;
    expect(opp.players).toHaveLength(1);
    expect(opp.players[0]!.name).toBe("Mookie Betts");
  });

  it("returns empty array for missing teams data", async () => {
    mockFetch({ fantasy_content: { league: [{}] } });
    const rosters = await makeClient().getTeamRosters();
    expect(rosters).toEqual([]);
  });
});
