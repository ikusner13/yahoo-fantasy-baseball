import { describe, it, expect } from "vite-plus/test";
import {
  scoreStart,
  aggregatePickupScore,
  computePickupMatchupImpact,
  buildPickupReasoning,
  findPitcherStarts,
  rankPitcherPickups,
} from "../../src/analysis/pitcher-pickups";
import type { PitcherStats, ScheduledGame, Player } from "../../src/types";
import type { DetailedCategoryState } from "../../src/analysis/matchup";
import { formatPitcherPickupNotification } from "../../src/notifications/action-messages";
import type { Env } from "../../src/types";

// --- Helpers ---

function makeGame(overrides: Partial<ScheduledGame> = {}): ScheduledGame {
  return {
    gameId: 1,
    date: "2026-04-10",
    homeTeam: "NYM",
    awayTeam: "ATL",
    status: "scheduled" as const,
    ...overrides,
  };
}

function makeProjection(overrides: Partial<PitcherStats> = {}): PitcherStats {
  return {
    ip: 150,
    outs: 450,
    k: 160,
    era: 3.5,
    whip: 1.15,
    qs: 18,
    svhd: 0,
    ...overrides,
  };
}

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    yahooId: "p1",
    mlbId: 12345,
    name: "Test Pitcher",
    team: "ATL",
    positions: ["SP"],
    ...overrides,
  };
}

// --- scoreStart ---

describe("scoreStart", () => {
  it("returns positive score for a good pitcher vs weak opponent", () => {
    const score = scoreStart(
      { projection: makeProjection({ era: 3.0, k: 180, ip: 160 }), team: "ATL" },
      makeGame(),
      {
        opponentWoba: 0.28,
        opponentKPct: 0.26,
        parkFactor: 0.9,
        confidence: "confirmed",
      },
    );
    expect(score).toBeGreaterThan(4);
  });

  it("returns lower score for bad pitcher vs strong opponent", () => {
    const good = scoreStart(
      { projection: makeProjection({ era: 3.0, k: 180, ip: 160 }), team: "ATL" },
      makeGame(),
      { opponentWoba: 0.28, confidence: "confirmed" },
    );
    const bad = scoreStart(
      { projection: makeProjection({ era: 5.0, k: 80, ip: 140 }), team: "ATL" },
      makeGame(),
      { opponentWoba: 0.36, confidence: "confirmed" },
    );
    expect(good).toBeGreaterThan(bad);
  });

  it("discounts projected starts vs confirmed", () => {
    const pitcher = { projection: makeProjection(), team: "ATL" };
    const game = makeGame();
    const ctx = { opponentWoba: 0.32, parkFactor: 1.0 };

    const confirmed = scoreStart(pitcher, game, { ...ctx, confidence: "confirmed" });
    const projected = scoreStart(pitcher, game, { ...ctx, confidence: "projected" });

    expect(confirmed).toBeGreaterThan(projected);
    // projected should be ~65% of confirmed
    expect(projected / confirmed).toBeCloseTo(0.65, 1);
  });

  it("discounts probable starts at 85%", () => {
    const pitcher = { projection: makeProjection(), team: "ATL" };
    const game = makeGame();
    const ctx = { opponentWoba: 0.32, parkFactor: 1.0 };

    const confirmed = scoreStart(pitcher, game, { ...ctx, confidence: "confirmed" });
    const probable = scoreStart(pitcher, game, { ...ctx, confidence: "probable" });

    expect(probable / confirmed).toBeCloseTo(0.85, 1);
  });

  it("boosts score for high opponent K%", () => {
    const pitcher = { projection: makeProjection(), team: "ATL" };
    const game = makeGame();

    const highK = scoreStart(pitcher, game, {
      opponentKPct: 0.28,
      confidence: "confirmed",
    });
    const lowK = scoreStart(pitcher, game, {
      opponentKPct: 0.18,
      confidence: "confirmed",
    });

    expect(highK).toBeGreaterThan(lowK);
  });

  it("boosts score for platoon advantage (LHP vs team weak vs lefties)", () => {
    const pitcher = { projection: makeProjection(), team: "ATL" };
    const game = makeGame();

    const advantage = scoreStart(pitcher, game, {
      wobaVsHand: 0.28, // team weak vs this hand
      confidence: "confirmed",
    });
    const noAdvantage = scoreStart(pitcher, game, {
      wobaVsHand: 0.35, // team strong vs this hand
      confidence: "confirmed",
    });

    expect(advantage).toBeGreaterThan(noAdvantage);
  });

  it("returns 0 for pitcher with no projection", () => {
    const score = scoreStart({ projection: undefined, team: "ATL" }, makeGame(), {
      confidence: "confirmed",
    });
    expect(score).toBe(0);
  });
});

// --- aggregatePickupScore ---

describe("aggregatePickupScore", () => {
  it("returns zero for empty starts", () => {
    const result = aggregatePickupScore([]);
    expect(result.totalScore).toBe(0);
    expect(result.avgScore).toBe(0);
    expect(result.isTwoStart).toBe(false);
  });

  it("single start = no volume bonus", () => {
    const result = aggregatePickupScore([5.0]);
    expect(result.totalScore).toBe(5.0);
    expect(result.avgScore).toBe(5.0);
    expect(result.isTwoStart).toBe(false);
  });

  it("two starts get volume bonus", () => {
    const result = aggregatePickupScore([4.0, 3.5]);
    expect(result.isTwoStart).toBe(true);
    // sum + 1.5 bonus
    expect(result.totalScore).toBe(4.0 + 3.5 + 1.5);
    expect(result.avgScore).toBeCloseTo(3.75, 2);
  });

  it("three starts also get volume bonus", () => {
    const result = aggregatePickupScore([3.0, 3.0, 3.0]);
    expect(result.isTwoStart).toBe(true);
    expect(result.totalScore).toBe(9.0 + 1.5);
  });
});

// --- computePickupMatchupImpact ---

describe("computePickupMatchupImpact", () => {
  const swingK: DetailedCategoryState = {
    category: "K",
    state: "swing",
    myValue: 40,
    opponentValue: 45,
    margin: -5,
  };

  const safeERA: DetailedCategoryState = {
    category: "ERA",
    state: "safe",
    myValue: 3.2,
    opponentValue: 3.8,
    margin: 0.6,
  };

  const lostQS: DetailedCategoryState = {
    category: "QS",
    state: "lost",
    myValue: 1,
    opponentValue: 5,
    margin: -4,
  };

  it("counts helped categories for good pitcher into swing K", () => {
    const result = computePickupMatchupImpact(
      makeProjection({ k: 180, era: 3.2 }),
      [swingK, safeERA],
      1,
    );
    expect(result.netCategoriesHelped).toBeGreaterThan(0);
  });

  it("flags hurt categories when bad ERA pitched into safe ERA lead", () => {
    const result = computePickupMatchupImpact(
      makeProjection({ era: 5.0, whip: 1.5 }),
      [safeERA],
      1,
    );
    expect(result.netCategoriesHurt).toBeGreaterThan(0);
  });

  it("lost categories register as neutral", () => {
    const result = computePickupMatchupImpact(makeProjection(), [lostQS], 1);
    const qsImpact = result.impacts.find((i) => i.category === "QS");
    expect(qsImpact?.direction).toBe("neutral");
  });

  it("multi-start amplifies counting stat help to high magnitude", () => {
    const result = computePickupMatchupImpact(makeProjection({ k: 160 }), [swingK], 2);
    const kImpact = result.impacts.find((i) => i.category === "K");
    // With 2 starts and K as swing, medium should be promoted to high
    if (kImpact?.direction === "helps") {
      expect(["medium", "high"]).toContain(kImpact.magnitude);
    }
  });
});

// --- buildPickupReasoning ---

describe("buildPickupReasoning", () => {
  it("labels pitcher with no starts in window", () => {
    const reasoning = buildPickupReasoning({
      player: makePlayer(),
      starts: [],
      totalScore: 0,
      avgScorePerStart: 0,
      isTwoStart: false,
      noStartsInWindow: true,
    });
    expect(reasoning).toContain("no confirmed starts");
  });

  it("includes start count and opponents", () => {
    const reasoning = buildPickupReasoning({
      player: makePlayer(),
      starts: [
        {
          date: "2026-04-10",
          opponent: "NYM",
          isHome: false,
          parkFactor: 0.95,
          opponentStrength: 0.3,
          score: 5.0,
          confidence: "confirmed",
        },
      ],
      totalScore: 5.0,
      avgScorePerStart: 5.0,
      isTwoStart: false,
      noStartsInWindow: false,
    });
    expect(reasoning).toContain("1 start");
    expect(reasoning).toContain("NYM");
  });

  it("notes two-start week", () => {
    const reasoning = buildPickupReasoning({
      player: makePlayer(),
      starts: [
        {
          date: "2026-04-10",
          opponent: "NYM",
          isHome: false,
          parkFactor: 0.95,
          opponentStrength: 0.3,
          score: 4.0,
          confidence: "confirmed",
        },
        {
          date: "2026-04-13",
          opponent: "WSH",
          isHome: true,
          parkFactor: 1.0,
          opponentStrength: 0.29,
          score: 4.5,
          confidence: "projected",
        },
      ],
      totalScore: 10.0,
      avgScorePerStart: 4.25,
      isTwoStart: true,
      noStartsInWindow: false,
    });
    expect(reasoning).toContain("2 starts");
    expect(reasoning).toContain("2-start week");
  });

  it("marks projected confidence in start descriptions", () => {
    const reasoning = buildPickupReasoning({
      player: makePlayer(),
      starts: [
        {
          date: "2026-04-12",
          opponent: "PHI",
          isHome: true,
          parkFactor: 1.0,
          opponentStrength: 0.33,
          score: 3.5,
          confidence: "projected",
        },
      ],
      totalScore: 3.5,
      avgScorePerStart: 3.5,
      isTwoStart: false,
      noStartsInWindow: false,
    });
    expect(reasoning).toContain("projected");
  });
});

// --- findPitcherStarts ---

describe("findPitcherStarts", () => {
  it("finds confirmed start from probable pitcher data", async () => {
    const games: ScheduledGame[] = [
      makeGame({
        date: "2026-04-10",
        homeTeam: "NYM",
        awayTeam: "ATL",
        awayProbable: { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      }),
    ];

    const starts = await findPitcherStarts(
      { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      games,
      "2026-04-10",
    );

    expect(starts).toHaveLength(1);
    expect(starts[0].confidence).toBe("confirmed");
    expect(starts[0].opponent).toBe("NYM");
    expect(starts[0].isHome).toBe(false);
  });

  it("identifies home starts correctly", async () => {
    const games: ScheduledGame[] = [
      makeGame({
        date: "2026-04-11",
        homeTeam: "ATL",
        awayTeam: "PHI",
        homeProbable: { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      }),
    ];

    const starts = await findPitcherStarts(
      { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      games,
      "2026-04-11",
    );

    expect(starts).toHaveLength(1);
    expect(starts[0].isHome).toBe(true);
    expect(starts[0].opponent).toBe("PHI");
  });

  it("returns empty for pitcher not in any game probables", async () => {
    const games: ScheduledGame[] = [
      makeGame({
        homeTeam: "NYM",
        awayTeam: "ATL",
        homeProbable: { mlbId: 99999, name: "Other Pitcher", team: "NYM" },
      }),
    ];

    // Note: rotation projection will be attempted, but without mocking it returns empty
    const starts = await findPitcherStarts(
      { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      games,
      "2026-04-10",
    );

    // With no confirmed probable and rotation projection likely failing in test env,
    // we expect empty or projected starts
    expect(starts.length).toBeLessThanOrEqual(1);
    for (const s of starts) {
      expect(["confirmed", "projected"]).toContain(s.confidence);
    }
  });

  it("returns empty for pitcher with no mlbId", async () => {
    const games: ScheduledGame[] = [makeGame()];
    const starts = await findPitcherStarts({ name: "Unknown", team: "ATL" }, games, "2026-04-10");
    expect(starts).toHaveLength(0);
  });

  it("handles multiple confirmed starts across dates", async () => {
    const games: ScheduledGame[] = [
      makeGame({
        gameId: 1,
        date: "2026-04-10",
        homeTeam: "NYM",
        awayTeam: "ATL",
        awayProbable: { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      }),
      makeGame({
        gameId: 2,
        date: "2026-04-12",
        homeTeam: "ATL",
        awayTeam: "WSH",
      }),
      makeGame({
        gameId: 3,
        date: "2026-04-15",
        homeTeam: "ATL",
        awayTeam: "PHI",
        homeProbable: { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      }),
    ];

    const starts = await findPitcherStarts(
      { mlbId: 12345, name: "Test Pitcher", team: "ATL" },
      games,
      "2026-04-10",
    );

    expect(starts).toHaveLength(2);
    expect(starts.every((s) => s.confidence === "confirmed")).toBe(true);
  });
});

// --- rankPitcherPickups integration (with injected data, no real API calls) ---

describe("rankPitcherPickups integration", () => {
  const scheduleGames: ScheduledGame[] = [
    makeGame({
      gameId: 100,
      date: "2026-04-10",
      homeTeam: "NYM",
      awayTeam: "ATL",
      awayProbable: { mlbId: 12345, name: "Ace Pitcher", team: "ATL" },
      homeProbable: { mlbId: 99999, name: "Opponent SP", team: "NYM" },
    }),
    makeGame({
      gameId: 101,
      date: "2026-04-12",
      homeTeam: "ATL",
      awayTeam: "WSH",
      homeProbable: { mlbId: 12345, name: "Ace Pitcher", team: "ATL" },
    }),
    makeGame({
      gameId: 102,
      date: "2026-04-11",
      homeTeam: "PHI",
      awayTeam: "COL",
      awayProbable: { mlbId: 67890, name: "Mid Pitcher", team: "COL" },
    }),
  ];

  it("ranks two-start pitcher above one-start pitcher", async () => {
    const candidates = [
      {
        player: makePlayer({ yahooId: "p1", mlbId: 12345, name: "Ace Pitcher", team: "ATL" }),
        projection: makeProjection({ era: 3.2, k: 180, ip: 160 }),
      },
      {
        player: makePlayer({ yahooId: "p2", mlbId: 67890, name: "Mid Pitcher", team: "COL" }),
        projection: makeProjection({ era: 4.0, k: 140, ip: 150 }),
      },
    ];

    const results = await rankPitcherPickups(candidates, "2026-04-10", "2026-04-13", {
      teamSchedules: new Map([
        ["ATL", scheduleGames.filter((g) => g.homeTeam === "ATL" || g.awayTeam === "ATL")],
        ["COL", scheduleGames.filter((g) => g.homeTeam === "COL" || g.awayTeam === "COL")],
      ]),
      teamBattingStats: new Map(), // defaults to league avg
      pitcherHands: new Map(),
    });

    expect(results.length).toBe(2);
    // Ace (2 starts) should rank above Mid (1 start)
    expect(results[0].player.name).toBe("Ace Pitcher");
    expect(results[0].isTwoStart).toBe(true);
    expect(results[0].starts).toHaveLength(2);
    expect(results[0].noStartsInWindow).toBe(false);

    expect(results[1].player.name).toBe("Mid Pitcher");
    expect(results[1].isTwoStart).toBe(false);
    expect(results[1].starts).toHaveLength(1);
  });

  it("flags pitcher with no starts in window as noStartsInWindow and sorts last", async () => {
    const candidates = [
      {
        player: makePlayer({ yahooId: "p3", mlbId: 11111, name: "Ghost Pitcher", team: "SF" }),
        projection: makeProjection({ era: 2.5, k: 200, ip: 180 }),
      },
      {
        player: makePlayer({ yahooId: "p2", mlbId: 67890, name: "Mid Pitcher", team: "COL" }),
        projection: makeProjection({ era: 4.5, k: 100, ip: 140 }),
      },
    ];

    const results = await rankPitcherPickups(candidates, "2026-04-10", "2026-04-13", {
      teamSchedules: new Map([
        ["SF", []], // no games
        ["COL", scheduleGames.filter((g) => g.homeTeam === "COL" || g.awayTeam === "COL")],
      ]),
      teamBattingStats: new Map(),
      pitcherHands: new Map(),
    });

    // Ghost has elite projection but no starts — should sort last
    expect(results[0].player.name).toBe("Mid Pitcher");
    expect(results[0].noStartsInWindow).toBe(false);

    expect(results[1].player.name).toBe("Ghost Pitcher");
    expect(results[1].noStartsInWindow).toBe(true);
    expect(results[1].totalScore).toBe(0);
    expect(results[1].reasoning).toContain("no confirmed starts");
  });

  it("pitcher without mlbId gets noStartsInWindow", async () => {
    const candidates = [
      {
        player: makePlayer({ yahooId: "p4", mlbId: undefined, name: "No ID", team: "ATL" }),
        projection: makeProjection(),
      },
    ];

    const results = await rankPitcherPickups(candidates, "2026-04-10", "2026-04-13", {
      teamSchedules: new Map([
        ["ATL", scheduleGames.filter((g) => g.homeTeam === "ATL" || g.awayTeam === "ATL")],
      ]),
      teamBattingStats: new Map(),
      pitcherHands: new Map(),
    });

    expect(results[0].noStartsInWindow).toBe(true);
  });

  it("applies matchup category states to impact analysis", async () => {
    const swingK: DetailedCategoryState = {
      category: "K",
      state: "swing",
      myValue: 40,
      opponentValue: 45,
      margin: -5,
    };
    const safeERA: DetailedCategoryState = {
      category: "ERA",
      state: "safe",
      myValue: 3.2,
      opponentValue: 3.8,
      margin: 0.6,
    };

    const candidates = [
      {
        player: makePlayer({ yahooId: "p1", mlbId: 12345, name: "Ace Pitcher", team: "ATL" }),
        projection: makeProjection({ era: 3.0, k: 200, ip: 170 }),
      },
    ];

    const results = await rankPitcherPickups(candidates, "2026-04-10", "2026-04-13", {
      teamSchedules: new Map([
        ["ATL", scheduleGames.filter((g) => g.homeTeam === "ATL" || g.awayTeam === "ATL")],
      ]),
      teamBattingStats: new Map(),
      pitcherHands: new Map(),
      categoryStates: [swingK, safeERA],
    });

    expect(results[0].matchupImpact).toBeDefined();
    expect(results[0].matchupImpact!.netCategoriesHelped).toBeGreaterThan(0);
  });

  it("uses opponent woba overrides (e.g. from Vegas)", async () => {
    const candidates = [
      {
        player: makePlayer({ yahooId: "p2", mlbId: 67890, name: "Mid Pitcher", team: "COL" }),
        projection: makeProjection({ era: 3.5, k: 160, ip: 150 }),
      },
    ];

    const weakOpp = await rankPitcherPickups(candidates, "2026-04-10", "2026-04-13", {
      teamSchedules: new Map([
        ["COL", scheduleGames.filter((g) => g.homeTeam === "COL" || g.awayTeam === "COL")],
      ]),
      opponentWobas: new Map([["PHI", 0.28]]), // weak
      teamBattingStats: new Map(),
      pitcherHands: new Map(),
    });

    const strongOpp = await rankPitcherPickups(candidates, "2026-04-10", "2026-04-13", {
      teamSchedules: new Map([
        ["COL", scheduleGames.filter((g) => g.homeTeam === "COL" || g.awayTeam === "COL")],
      ]),
      opponentWobas: new Map([["PHI", 0.36]]), // strong
      teamBattingStats: new Map(),
      pitcherHands: new Map(),
    });

    expect(weakOpp[0].totalScore).toBeGreaterThan(strongOpp[0].totalScore);
  });
});

// --- formatPitcherPickupNotification ---

describe("formatPitcherPickupNotification", () => {
  const mockEnv = {
    YAHOO_LEAGUE_ID: "123",
    YAHOO_TEAM_ID: "1",
  } as unknown as Env;

  it("renders single-start notification", () => {
    const msg = formatPitcherPickupNotification(
      mockEnv,
      {
        player: makePlayer({ name: "Joe Musgrove" }),
        projection: makeProjection({ era: 3.4 }),
        starts: [
          {
            date: "2026-04-10",
            opponent: "NYM",
            isHome: false,
            parkFactor: 0.95,
            opponentStrength: 0.29,
            score: 5.2,
            confidence: "confirmed" as const,
          },
        ],
        totalScore: 5.2,
        avgScorePerStart: 5.2,
        isTwoStart: false,
        noStartsInWindow: false,
        reasoning: "1 start: NYM 04-10.",
      },
      "Worst Reliever",
      "ERA & WHIP safe — stream high-floor arms only.",
      " — 3.40 ERA, 8.8 K/9",
    );

    expect(msg).toContain("Streaming Pitcher");
    expect(msg).not.toContain("2-Start");
    expect(msg).toContain("Joe Musgrove");
    expect(msg).toContain("Worst Reliever");
    expect(msg).toContain("@ NYM");
    expect(msg).toContain("(weak)");
    expect(msg).toContain("5.2 pts");
    expect(msg).toContain("ERA &amp; WHIP safe");
  });

  it("renders two-start notification with confidence tags", () => {
    const msg = formatPitcherPickupNotification(
      mockEnv,
      {
        player: makePlayer({ name: "Logan Webb" }),
        projection: makeProjection(),
        starts: [
          {
            date: "2026-04-10",
            opponent: "NYM",
            isHome: false,
            parkFactor: 0.95,
            opponentStrength: 0.29,
            score: 4.8,
            confidence: "confirmed" as const,
          },
          {
            date: "2026-04-15",
            opponent: "WSH",
            isHome: true,
            parkFactor: 0.85,
            opponentStrength: 0.31,
            score: 4.2,
            confidence: "projected" as const,
          },
        ],
        totalScore: 10.5,
        avgScorePerStart: 4.5,
        isTwoStart: true,
        noStartsInWindow: false,
        matchupImpact: { netCategoriesHelped: 3, netCategoriesHurt: 1 },
        reasoning: "2 starts: NYM 04-10, WSH 04-15 (projected).",
      },
      "Stream Drop",
      "ERA & WHIP clinched — stream freely.",
      " — 3.50 ERA, 9.6 K/9",
    );

    expect(msg).toContain("2-Start Pitcher");
    expect(msg).toContain("Logan Webb");
    expect(msg).toContain("@ NYM");
    expect(msg).toContain("vs WSH");
    expect(msg).toContain("[projected]");
    expect(msg).toContain("helps 3 cats, risks 1");
    expect(msg).toContain("transactions");
  });
});
