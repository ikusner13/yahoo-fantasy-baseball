import { describe, it, expect } from "vite-plus/test";
import { getTodaysGames, getInjuries } from "../../src/data/mlb";
import { getBatterStatcast, getPitcherStatcast } from "../../src/data/statcast";
import { fetchBatterProjections, fetchPitcherProjections } from "../../src/data/projections";

// These tests hit real APIs — they verify our parsing logic against live data.
// They may be slower (~2-5s) and fail if APIs are down.

describe("MLB Stats API", () => {
  it("fetches today's games with valid structure", async () => {
    const games = await getTodaysGames();

    expect(Array.isArray(games)).toBe(true);
    // There should be games (MLB season runs Apr-Oct)
    // If off-season, this will be empty — that's OK
    if (games.length > 0) {
      const game = games[0];
      expect(game).toHaveProperty("gameId");
      expect(game).toHaveProperty("date");
      expect(game).toHaveProperty("homeTeam");
      expect(game).toHaveProperty("awayTeam");
      expect(game).toHaveProperty("status");
      expect(["scheduled", "in_progress", "final"]).toContain(game.status);
      expect(game.homeTeam.length).toBeGreaterThanOrEqual(2);
      expect(game.awayTeam.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("fetches games for a specific date", async () => {
    // Use a known date with games (opening day 2026 is April 2)
    const games = await getTodaysGames("2026-04-02");
    expect(Array.isArray(games)).toBe(true);
    expect(games.length).toBeGreaterThan(0);
  });

  it("fetches recent IL transactions", async () => {
    const injuries = await getInjuries();

    // Returns an array (may be empty early in season)
    expect(Array.isArray(injuries)).toBe(true);
    if (injuries.length > 0) {
      const injury = injuries[0];
      expect(injury).toHaveProperty("mlbId");
      expect(injury).toHaveProperty("name");
      expect(injury).toHaveProperty("team");
      expect(injury).toHaveProperty("status");
      expect(typeof injury.mlbId).toBe("number");
      expect(typeof injury.name).toBe("string");
    }
  });

  it("probable pitchers are parsed when available", async () => {
    const games = await getTodaysGames();
    const gamesWithProbables = games.filter((g) => g.homeProbable || g.awayProbable);

    if (gamesWithProbables.length > 0) {
      const game = gamesWithProbables[0];
      const probable = game.homeProbable ?? game.awayProbable;
      expect(probable).toBeDefined();
      expect(probable!.mlbId).toBeGreaterThan(0);
      expect(probable!.name.length).toBeGreaterThan(0);
      expect(probable!.team.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("Baseball Savant / Statcast", () => {
  it("fetches batter Statcast leaderboard", async () => {
    // Use 2025 season data (guaranteed to exist)
    const batters = await getBatterStatcast([], 2025);

    expect(Array.isArray(batters)).toBe(true);
    expect(batters.length).toBeGreaterThan(50);

    const batter = batters[0];
    expect(batter).toHaveProperty("mlbId");
    expect(batter).toHaveProperty("xwoba");
    expect(batter).toHaveProperty("barrelPct");
    expect(batter).toHaveProperty("hardHitPct");
    expect(batter).toHaveProperty("exitVelo");
    expect(typeof batter.mlbId).toBe("number");
    expect(batter.mlbId).toBeGreaterThan(0);
  });

  it("filters batters by MLB ID", async () => {
    // Aaron Judge = 592450, Shohei Ohtani = 660271
    const targetIds = [592450, 660271];
    const batters = await getBatterStatcast(targetIds, 2025);

    expect(batters.length).toBeLessThanOrEqual(targetIds.length);
    for (const b of batters) {
      expect(targetIds).toContain(b.mlbId);
    }
  });

  it("fetches pitcher Statcast leaderboard", async () => {
    const pitchers = await getPitcherStatcast([], 2025);

    expect(Array.isArray(pitchers)).toBe(true);
    expect(pitchers.length).toBeGreaterThan(50);

    const pitcher = pitchers[0];
    expect(pitcher).toHaveProperty("mlbId");
    expect(pitcher).toHaveProperty("xwoba");
    expect(pitcher).toHaveProperty("whiffPct");
    expect(pitcher).toHaveProperty("barrelPctAgainst");
    expect(pitcher).toHaveProperty("kPct");
  });

  it("statcast values are in reasonable ranges", async () => {
    const batters = await getBatterStatcast([], 2025);
    for (const b of batters.slice(0, 20)) {
      expect(b.xwoba).toBeGreaterThanOrEqual(0);
      expect(b.xwoba).toBeLessThanOrEqual(0.6);
      expect(b.barrelPct).toBeGreaterThanOrEqual(0);
      expect(b.barrelPct).toBeLessThanOrEqual(40);
      expect(b.hardHitPct).toBeGreaterThanOrEqual(0);
      expect(b.hardHitPct).toBeLessThanOrEqual(80);
    }
  });
});

describe("FanGraphs Projections", () => {
  it("fetches batter projections with required fields", async () => {
    const batters = await fetchBatterProjections();

    expect(Array.isArray(batters)).toBe(true);
    expect(batters.length).toBeGreaterThan(100);

    const b = batters[0];
    expect(b).toHaveProperty("fangraphsId");
    expect(b).toHaveProperty("name");
    expect(b).toHaveProperty("team");
    expect(b).toHaveProperty("pa");
    expect(b).toHaveProperty("r");
    expect(b).toHaveProperty("h");
    expect(b).toHaveProperty("hr");
    expect(b).toHaveProperty("rbi");
    expect(b).toHaveProperty("sb");
    expect(b).toHaveProperty("tb");
    expect(b).toHaveProperty("obp");
  });

  it("fetches pitcher projections with required fields", async () => {
    const pitchers = await fetchPitcherProjections();

    expect(Array.isArray(pitchers)).toBe(true);
    expect(pitchers.length).toBeGreaterThan(50);

    const p = pitchers[0];
    expect(p).toHaveProperty("fangraphsId");
    expect(p).toHaveProperty("name");
    expect(p).toHaveProperty("ip");
    expect(p).toHaveProperty("k");
    expect(p).toHaveProperty("era");
    expect(p).toHaveProperty("whip");
    expect(p).toHaveProperty("qs");
    expect(p).toHaveProperty("svhd");
  });

  it("projection values are in reasonable ranges", async () => {
    const batters = await fetchBatterProjections();
    const qualified = batters.filter((b) => b.pa > 200);

    expect(qualified.length).toBeGreaterThan(50);
    for (const b of qualified.slice(0, 20)) {
      expect(b.obp).toBeGreaterThan(0.15);
      expect(b.obp).toBeLessThan(0.5);
      expect(b.hr).toBeGreaterThanOrEqual(0);
      expect(b.hr).toBeLessThan(70);
    }

    const pitchers = await fetchPitcherProjections();
    const qualifiedP = pitchers.filter((p) => p.ip > 50);
    for (const p of qualifiedP.slice(0, 20)) {
      expect(p.era).toBeGreaterThan(0);
      expect(p.era).toBeLessThan(10);
      expect(p.whip).toBeGreaterThan(0.5);
      expect(p.whip).toBeLessThan(3.0);
    }
  });
});
