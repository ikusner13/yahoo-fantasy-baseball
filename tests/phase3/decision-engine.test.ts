import { describe, expect, it } from "vite-plus/test";

import {
  bankedFromMatchup,
  categoryWeight,
  computeSgpDenominators,
  MAX_SIMULATED_ADD_CANDIDATES,
  optimizeLineup,
  prepareSimJob,
  PRODUCTION_SIMULATION_COUNT,
  rankAddCandidates,
  reduceSimJob,
  simulateMatchup,
  simulateUnit,
} from "../../src/services/DecisionEngine";
import {
  LeagueStatePlayer,
  LeagueStateSnapshot,
  RosterSlotCount,
} from "../../src/services/LeagueState";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";

const batter = (overrides: Partial<ConstructorParameters<typeof WeeklyBatterLine>[0]> = {}) =>
  new WeeklyBatterLine({
    kind: "batter",
    playerKey: "mlb.p.batter",
    name: "Batter",
    team: "NYY",
    pa: 25,
    r: 4,
    h: 6,
    hr: 1,
    rbi: 4,
    sb: 1,
    tb: 10,
    obpNumerator: 8,
    obpDenominator: 24,
    obp: 8 / 24,
    ...overrides,
  });

const pitcher = (overrides: Partial<ConstructorParameters<typeof WeeklyPitcherLine>[0]> = {}) =>
  new WeeklyPitcherLine({
    kind: "pitcher",
    playerKey: "mlb.p.pitcher",
    name: "Pitcher",
    team: "SEA",
    ip: 6,
    out: 18,
    k: 7,
    er: 2,
    baserunners: 7,
    era: 3,
    whip: 7 / 6,
    qs: 0.7,
    svh: 0,
    ...overrides,
  });

const snapshot = (overrides: Partial<ConstructorParameters<typeof LeagueStateSnapshot>[0]> = {}) =>
  new LeagueStateSnapshot({
    leagueId: "62744",
    teamId: "12",
    scoringFormat: "cumulative-category-h2h",
    scoringCategories: [
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
    ],
    weeklyAddLimit: 6,
    addsUsed: 0,
    roster: [
      new LeagueStatePlayer({
        playerKey: "mine",
        name: "Mine",
        team: "NYY",
        eligiblePositions: ["Util"],
        selectedPosition: "Util",
      }),
    ],
    rosterSlots: [new RosterSlotCount({ position: "Util", count: 1 })],
    emptySlots: [],
    ilUsed: 0,
    ilSlots: 0,
    matchup: {
      week: 10,
      weekStart: "2026-06-01",
      weekEnd: "2026-06-07",
      opponentTeamKey: "mlb.l.62744.t.2",
      opponentTeamName: "Opponent",
      categories: [],
    },
    ...overrides,
  });

describe("DecisionEngine Phase 3", () => {
  it("uses a research-backed production Monte Carlo floor", () => {
    expect(PRODUCTION_SIMULATION_COUNT).toBeGreaterThanOrEqual(5000);
  });

  describe("F7 continuous category weight", () => {
    it("peaks at a coin-flip and stays continuous across the old 0.34/0.36 bucket boundary", () => {
      // Peak at 0.5; symmetric; no cliff at the old coin-flip cutoff.
      expect(categoryWeight(0.5)).toBeCloseTo(1.75, 5);
      expect(categoryWeight(0.4)).toBeCloseTo(categoryWeight(0.6), 5);
      // The old buckets jumped 1.0 → 1.75 (Δ0.75) here; the smooth curve barely moves.
      expect(Math.abs(categoryWeight(0.36) - categoryWeight(0.34))).toBeLessThan(0.05);
    });

    it("decays monotonically toward a non-zero soft-punt floor at the extremes", () => {
      for (const p of [0.5, 0.6, 0.7, 0.85, 0.95, 0.99]) {
        expect(categoryWeight(p)).toBeGreaterThan(0.2);
      }
      // Strictly decreasing as the category gets more locked.
      expect(categoryWeight(0.6)).toBeLessThan(categoryWeight(0.5));
      expect(categoryWeight(0.85)).toBeLessThan(categoryWeight(0.6));
      expect(categoryWeight(0.99)).toBeLessThan(categoryWeight(0.85));
      // Soft-punt: a near-locked/near-lost category keeps a small but non-zero weight.
      expect(categoryWeight(0.999)).toBeGreaterThan(0.2);
      expect(categoryWeight(0.999)).toBeLessThan(0.4);
      expect(categoryWeight(0.001)).toBeCloseTo(categoryWeight(0.999), 5);
    });
  });

  it("keeps add-candidate simulation breadth within Worker CPU limits", () => {
    expect(MAX_SIMULATED_ADD_CANDIDATES).toBe(20);
  });

  it("reconstructs exact ERA components from Yahoo ERA plus OUT", () => {
    const banked = bankedFromMatchup(
      [
        { category: "ERA", myValue: "4.50", opponentValue: "0.00" },
        { category: "OUT", myValue: "27", opponentValue: "0" },
      ],
      "mine",
      0,
    );

    expect(banked.era.er).toBeCloseTo(4.5, 10);
    expect(banked.era.outs).toBe(27);
  });

  it("computes SGP denominators as standings-history slopes", () => {
    const denominators = computeSgpDenominators([
      { teamKey: "1", rank: 1, categories: { HR: 240 } },
      { teamKey: "2", rank: 2, categories: { HR: 225 } },
      { teamKey: "3", rank: 3, categories: { HR: 210 } },
      { teamKey: "4", rank: 4, categories: { HR: 195 } },
    ]);

    expect(denominators.HR).toBe(15);
  });

  it("marks season SGP as fallback when standings history cannot calibrate denominators", () => {
    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [batter({ playerKey: "my-batter", hr: 1 })],
        opponentRoster: [batter({ playerKey: "opp-batter", hr: 2 })],
        freeAgents: [batter({ playerKey: "power-bat", name: "Power Bat", hr: 4 })],
      }),
    );

    expect(report.sgpDenominatorSource).toBe("fallback");
  });

  it("marks season SGP as standings-history calibrated when Yahoo history has usable slopes", () => {
    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [batter({ playerKey: "my-batter", hr: 1 })],
        opponentRoster: [batter({ playerKey: "opp-batter", hr: 2 })],
        freeAgents: [batter({ playerKey: "power-bat", name: "Power Bat", hr: 4 })],
      }),
      undefined,
      [
        { teamKey: "1", rank: 1, categories: { HR: 240 } },
        { teamKey: "2", rank: 2, categories: { HR: 225 } },
      ],
    );

    expect(report.sgpDenominatorSource).toBe("standings-history");
  });

  it("simulates category probabilities against the real opponent projection set", () => {
    const result = simulateMatchup(
      [batter({ playerKey: "mine", hr: 8 })],
      [batter({ playerKey: "opp", hr: 1 })],
      1000,
      1,
    );

    const hr = result.categories.find((category) => category.category === "HR");
    expect(hr?.winProbability).toBeGreaterThan(0.95);
    expect(hr?.tag).toBe("lock");
  });

  it("scores this league as cumulative category points instead of a binary weekly result", () => {
    const result = simulateMatchup([], [], 100, 1);

    expect(result.categories).toHaveLength(13);
    expect(result.categories.every((category) => category.tieProbability === 1)).toBe(true);
    expect(result.expectedCategoryPoints).toBe(6.5);
  });

  it("uses OBP numerator and denominator instead of hits or plate appearances", () => {
    const result = simulateMatchup(
      [
        batter({
          playerKey: "low-hits-good-obp",
          h: 2,
          obpNumerator: 14,
          obpDenominator: 28,
        }),
      ],
      [
        batter({
          playerKey: "high-hits-bad-obp",
          h: 10,
          obpNumerator: 8,
          obpDenominator: 32,
        }),
      ],
      1000,
      2,
    );

    const obp = result.categories.find((category) => category.category === "OBP");
    const hits = result.categories.find((category) => category.category === "H");
    expect(obp?.winProbability).toBeGreaterThan(0.85);
    expect(hits?.winProbability).toBeLessThan(0.1);
  });

  it("seeds the sim with a banked SB lead and downweights the locked category", () => {
    const stored = prepareSimJob(
      new WeeklyProjectionSet({
        myRoster: [batter({ playerKey: "mine", sb: 0.1, selectedPosition: "Util" })],
        opponentRoster: [batter({ playerKey: "opp", sb: 0.1, selectedPosition: "Util" })],
        freeAgents: [],
      }),
      snapshot({
        scoringCategories: ["SB"],
        matchup: {
          week: 10,
          weekStart: "2026-06-01",
          weekEnd: "2026-06-07",
          opponentTeamKey: "mlb.l.62744.t.2",
          opponentTeamName: "Opponent",
          categories: [{ category: "SB", myValue: "10", opponentValue: "0" }],
        },
      }),
      [],
      "2026-06-06T12:00:00.000Z",
    );
    const report = reduceSimJob(stored, []);
    const sb = report.baseline.categories.find((category) => category.category === "SB");

    expect(sb?.winProbability).toBeGreaterThan(0.95);
    expect(report.scout.categoryWeights["SB"]).toBeLessThan(0.35);
  });

  it("keeps zero-banked specs identical to the unseeded simulation path", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({ playerKey: "mine", selectedPosition: "Util" }),
        pitcher({ playerKey: "my-pitcher", selectedPosition: "P" }),
      ],
      opponentRoster: [
        batter({ playerKey: "opp", selectedPosition: "Util" }),
        pitcher({ playerKey: "opp-pitcher", selectedPosition: "P" }),
      ],
      freeAgents: [],
    });
    const categories = [
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
    ];
    const zeroCategories = categories.map((category) => ({
      category,
      myValue: "0",
      opponentValue: "0",
    }));

    const unseeded = prepareSimJob(set, undefined, []);
    const seeded = prepareSimJob(
      set,
      snapshot({
        scoringCategories: categories,
        roster: [
          new LeagueStatePlayer({
            playerKey: "mine",
            name: "Mine",
            team: "NYY",
            eligiblePositions: ["Util"],
            selectedPosition: "Util",
          }),
          new LeagueStatePlayer({
            playerKey: "my-pitcher",
            name: "Pitcher",
            team: "SEA",
            eligiblePositions: ["P"],
            selectedPosition: "P",
          }),
        ],
        matchup: {
          week: 10,
          weekStart: "2026-06-01",
          weekEnd: "2026-06-07",
          opponentTeamKey: "mlb.l.62744.t.2",
          opponentTeamName: "Opponent",
          categories: zeroCategories,
        },
      }),
      [],
      "2026-06-01T00:00:00.000Z",
    );

    expect(JSON.parse(JSON.stringify(seeded.stored.baseline))).toEqual(
      JSON.parse(JSON.stringify(unseeded.stored.baseline)),
    );
    expect(JSON.parse(JSON.stringify(simulateUnit(seeded, 0)))).toEqual(
      JSON.parse(JSON.stringify(seeded.stored.baseline)),
    );
  });

  it("filters the opponent roster through activeWeeklyLines using selected positions", () => {
    const stored = prepareSimJob(
      new WeeklyProjectionSet({
        myRoster: [batter({ playerKey: "mine", selectedPosition: "Util" })],
        opponentRoster: [
          batter({ playerKey: "opp-active", r: 1, selectedPosition: "Util" }),
          batter({ playerKey: "opp-bench", r: 100, selectedPosition: "BN" }),
        ],
        freeAgents: [],
      }),
      snapshot(),
    );

    expect(stored.stored.spec.opponentRoster.map((line) => line.playerKey)).toEqual(["opp-active"]);
  });

  it("draws opponent samples from a stream independent of myRoster size (CRN invariant)", () => {
    // Decoupled mine/opp RNG: the opponent stream is seeded only from `seed`, so its draws are
    // identical for the baseline roster and any candidate-augmented roster. To observe this through
    // simulateMatchup's aggregate output we isolate the opponent: `mine` contributes a DETERMINISTIC
    // SB total (volatility 0 → 0 sampled draws), so the SB win/margin distribution is decided purely
    // by the opponent's sampled SB. Appending a candidate pitcher must therefore leave SB's win
    // probability and margin σ byte-identical. Under the OLD single shared stream, the candidate's
    // extra draws shifted the opponent's stream offset and these values drifted (e.g. 0.5062 vs
    // 0.5050, σ 2.213 vs 2.250).
    const mine = batter({ playerKey: "mine", sb: 5, volatility: 0 });
    const opponentRoster = [batter({ playerKey: "opp", sb: 5 })];
    const candidatePitcher = pitcher({ playerKey: "candidate", k: 12, out: 30 });

    const baseline = simulateMatchup([mine], opponentRoster, 5000, 62744);
    const augmented = simulateMatchup([mine, candidatePitcher], opponentRoster, 5000, 62744);

    const baselineSb = baseline.categories.find((c) => c.category === "SB");
    const augmentedSb = augmented.categories.find((c) => c.category === "SB");
    expect(augmentedSb?.winProbability).toBe(baselineSb?.winProbability);
    expect(augmentedSb?.marginMean).toBe(baselineSb?.marginMean);
    expect(augmentedSb?.marginStdDev).toBe(baselineSb?.marginStdDev);
  });

  it("ranks add candidates by marginal weekly category EV plus season SGP", () => {
    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [
          batter({ playerKey: "my-batter", hr: 1, r: 3, rbi: 3 }),
          pitcher({ playerKey: "my-pitcher", k: 4, out: 15 }),
        ],
        opponentRoster: [
          batter({ playerKey: "opp-batter", hr: 4, r: 4, rbi: 4 }),
          pitcher({ playerKey: "opp-pitcher", k: 9, out: 18 }),
        ],
        freeAgents: [
          batter({
            playerKey: "power-bat",
            name: "Power Bat",
            hr: 12,
            r: 5,
            rbi: 6,
            tb: 12,
          }),
          pitcher({
            playerKey: "ratio-arm",
            name: "Ratio Arm",
            k: 2,
            out: 6,
            er: 0.5,
            baserunners: 3,
            ip: 4,
          }),
        ],
      }),
    );

    expect(report.baseline.expectedCategoryPoints).toBeGreaterThan(0);
    expect(
      report.scout.coinFlips.length + report.scout.locks.length + report.scout.lostCauses.length,
    ).toBeGreaterThan(0);
    expect(report.recommendations[0]).toMatchObject({
      playerKey: "power-bat",
      type: "add",
    });
    expect(report.recommendations[0]?.weeklyDelta).toBeGreaterThan(0);
    expect(report.recommendations[0]?.affectedCategories.length).toBeGreaterThan(0);
  });

  it("ranks a coin-flip helper above a lock-padding add (Δ win-prob objective)", () => {
    // Synthetic matchup: HR/TB are locks, H/RBI/SB/OBP are coin-flips, R + all pitching are
    // lost causes. A pure-SB bat helps a coin-flip category; a pure-power bat only pads the
    // already-won HR/TB locks. Under the Δ(expected-category-wins) objective the coin-flip helper
    // must outrank the lock padder, and the lock padder's weeklyDelta should be ≈0 (saturated).
    const myRoster = [batter({ playerKey: "me", hr: 12, sb: 5, r: 2, h: 6, rbi: 4, tb: 20 })];
    const opponentRoster = [batter({ playerKey: "opp", hr: 1, sb: 5, r: 14, h: 6, rbi: 4, tb: 8 })];
    const baseline = simulateMatchup(myRoster, opponentRoster, 5000, 62744);
    const tagFor = (category: string) =>
      baseline.categories.find((entry) => entry.category === category)?.tag;
    expect(tagFor("HR")).toBe("lock");
    expect(tagFor("SB")).toBe("coin-flip");
    expect(tagFor("R")).toBe("lost-cause");

    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster,
        opponentRoster,
        freeAgents: [
          batter({
            playerKey: "lock-padder",
            name: "Lock Padder",
            hr: 10,
            r: 0,
            h: 0,
            rbi: 0,
            sb: 0,
            tb: 18,
          }),
          batter({
            playerKey: "coin-flip-helper",
            name: "Coin Flip Helper",
            hr: 0,
            r: 0,
            h: 0,
            rbi: 0,
            sb: 8,
            tb: 0,
          }),
        ],
      }),
    );

    const lockPadder = report.recommendations.find((entry) => entry.playerKey === "lock-padder");
    const coinFlipHelper = report.recommendations.find(
      (entry) => entry.playerKey === "coin-flip-helper",
    );
    expect(lockPadder).toBeDefined();
    expect(coinFlipHelper).toBeDefined();

    // Coin-flip helper outranks the lock padder.
    expect(report.recommendations[0]?.playerKey).toBe("coin-flip-helper");
    expect(coinFlipHelper!.weeklyDelta).toBeGreaterThan(lockPadder!.weeklyDelta);

    // Lock-padding move barely moves the objective; coin-flip move clearly does.
    expect(Math.abs(lockPadder!.weeklyDelta)).toBeLessThan(0.1);
    expect(coinFlipHelper!.weeklyDelta).toBeGreaterThan(0.1);
  });

  it("selects simulated candidates by baseline-weighted weekly flip score", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [batter({ playerKey: "mine", hr: 12, sb: 5, r: 1, h: 1, rbi: 1, tb: 25 })],
      opponentRoster: [batter({ playerKey: "opp", hr: 1, sb: 5, r: 20, h: 20, rbi: 20, tb: 5 })],
      freeAgents: [
        batter({ playerKey: "all-rounder", name: "All Rounder", r: 3, h: 3, rbi: 3, sb: 1 }),
        batter({
          playerKey: "sb-specialist",
          name: "SB Specialist",
          r: 0,
          h: 0,
          hr: 0,
          rbi: 0,
          sb: 8,
          tb: 0,
          obpNumerator: 0,
          obpDenominator: 0,
          obp: 0,
        }),
      ],
    });

    const stored = prepareSimJob(set, undefined, []);
    expect(stored.stored.spec.candidates.map((candidate) => candidate.line.playerKey)).toEqual([
      "sb-specialist",
      "all-rounder",
    ]);
  });

  it("keeps candidate ordering deterministic under shuffled input", () => {
    const candidates = [
      batter({ playerKey: "c", name: "C", sb: 5 }),
      batter({ playerKey: "a", name: "A", sb: 5 }),
      batter({ playerKey: "b", name: "B", sb: 5 }),
    ];
    const build = (freeAgents: ReadonlyArray<WeeklyBatterLine>) =>
      prepareSimJob(
        new WeeklyProjectionSet({
          myRoster: [batter({ playerKey: "mine", sb: 3 })],
          opponentRoster: [batter({ playerKey: "opp", sb: 3 })],
          freeAgents,
        }),
        undefined,
        [],
      ).stored.spec.candidates.map((candidate) => candidate.line.playerKey);

    expect(build(candidates)).toEqual(build([...candidates].reverse()));
    expect(build(candidates)).toEqual(["a", "b", "c"]);
  });

  it("unions the top season-SGP safety candidates into the 20-player sim funnel", () => {
    const speedCandidates = Array.from({ length: 25 }, (_, index) =>
      batter({
        playerKey: `speed-${String(index).padStart(2, "0")}`,
        name: `Speed ${index}`,
        hr: 0,
        r: 0,
        h: 0,
        rbi: 0,
        sb: 25 - index,
        tb: 0,
        obpNumerator: 0,
        obpDenominator: 0,
        obp: 0,
      }),
    );
    const stored = prepareSimJob(
      new WeeklyProjectionSet({
        myRoster: [batter({ playerKey: "mine", hr: 12, sb: 5, tb: 25 })],
        opponentRoster: [batter({ playerKey: "opp", hr: 1, sb: 5, tb: 5 })],
        freeAgents: [
          ...speedCandidates,
          batter({ playerKey: "season-stud", name: "Season Stud", hr: 100, tb: 300, sb: 0 }),
        ],
      }),
      undefined,
      [],
    );
    const selected = stored.stored.spec.candidates.map((candidate) => candidate.line.playerKey);

    expect(selected).toHaveLength(MAX_SIMULATED_ADD_CANDIDATES);
    expect(selected).toContain("season-stud");
  });

  it("prefers the ceiling candidate for a losing category and the floor candidate for a winning one (F2)", () => {
    // Two free agents with IDENTICAL mean lines but different `volatility`. Only `volatility`
    // differs, so any ranking gap is purely the variance-aware effect: F1's Δ(win-prob) re-sim
    // sees a higher-σ candidate raise team σ, which helps an underdog category and hurts a
    // favorite category (P(win) = Φ(μ/σ)).
    const floorVol = 0.3;
    const ceilingVol = 2.5;
    const candidate = (overrides: Partial<ConstructorParameters<typeof WeeklyBatterLine>[0]>) =>
      batter({
        // single-category contribution: SB only, everything else zero so σ moves visibly
        r: 0,
        h: 0,
        hr: 0,
        rbi: 0,
        tb: 0,
        obpNumerator: 0,
        obpDenominator: 0,
        obp: 0,
        ...overrides,
      });

    // Losing category: my SB mean (3) < opponent SB mean (8) → underdog, baseline win-prob < 0.5.
    const losing = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [candidate({ playerKey: "me", sb: 3 })],
        opponentRoster: [candidate({ playerKey: "opp", sb: 8 })],
        freeAgents: [
          candidate({ playerKey: "floor", name: "Floor", sb: 4, volatility: floorVol }),
          candidate({ playerKey: "ceiling", name: "Ceiling", sb: 4, volatility: ceilingVol }),
        ],
      }),
    );
    const losingBaselineSb = losing.baseline.categories.find((c) => c.category === "SB");
    const losingFloor = losing.recommendations.find((r) => r.playerKey === "floor")!;
    const losingCeiling = losing.recommendations.find((r) => r.playerKey === "ceiling")!;
    expect(losingBaselineSb!.winProbability).toBeLessThan(0.5);
    expect(losingCeiling.weeklyDelta).toBeGreaterThan(losingFloor.weeklyDelta);
    expect(losing.recommendations[0]?.playerKey).toBe("ceiling");

    // Winning category: my SB mean (8) > opponent SB mean (3) → favorite, baseline win-prob > 0.5.
    const winning = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [candidate({ playerKey: "me", sb: 8 })],
        opponentRoster: [candidate({ playerKey: "opp", sb: 3 })],
        freeAgents: [
          candidate({ playerKey: "floor", name: "Floor", sb: 4, volatility: floorVol }),
          candidate({ playerKey: "ceiling", name: "Ceiling", sb: 4, volatility: ceilingVol }),
        ],
      }),
    );
    const winningBaselineSb = winning.baseline.categories.find((c) => c.category === "SB");
    const winningFloor = winning.recommendations.find((r) => r.playerKey === "floor")!;
    const winningCeiling = winning.recommendations.find((r) => r.playerKey === "ceiling")!;
    expect(winningBaselineSb!.winProbability).toBeGreaterThan(0.5);
    expect(winningFloor.weeklyDelta).toBeGreaterThan(winningCeiling.weeklyDelta);
    expect(winning.recommendations[0]?.playerKey).toBe("floor");
  });

  it("does not attribute pitching category impact to hitter adds", () => {
    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [batter({ playerKey: "my-batter", hr: 1 })],
        opponentRoster: [
          batter({ playerKey: "opp-batter", hr: 3 }),
          pitcher({ playerKey: "opp-pitcher" }),
        ],
        freeAgents: [batter({ playerKey: "hitter-add", name: "Hitter Add", hr: 4, rbi: 8 })],
      }),
    );

    const affected = new Set(
      report.recommendations[0]?.affectedCategories.map((delta) => delta.category) ?? [],
    );

    for (const category of ["OUT", "K", "ERA", "WHIP", "QS", "SV+H"]) {
      expect(affected.has(category)).toBe(false);
    }
  });

  it("does not attribute batting category impact to pitcher adds", () => {
    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [pitcher({ playerKey: "my-pitcher", k: 3, out: 12 })],
        opponentRoster: [
          batter({ playerKey: "opp-batter", hr: 3 }),
          pitcher({ playerKey: "opp-pitcher" }),
        ],
        freeAgents: [pitcher({ playerKey: "pitcher-add", name: "Pitcher Add", k: 12, out: 30 })],
      }),
    );

    const affected = new Set(
      report.recommendations[0]?.affectedCategories.map((delta) => delta.category) ?? [],
    );

    for (const category of ["R", "H", "HR", "RBI", "SB", "TB", "OBP"]) {
      expect(affected.has(category)).toBe(false);
    }
  });

  it("uses Yahoo scoring categories instead of exposing unsupported category constants", () => {
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: ["R", "RBI", "OBP"],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "my-batter",
          name: "My Batter",
          team: "NYY",
          eligiblePositions: ["Util"],
          selectedPosition: "Util",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "Util", count: 1 })],
      emptySlots: [],
      ilUsed: 0,
      ilSlots: 0,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });
    const report = rankAddCandidates(
      new WeeklyProjectionSet({
        myRoster: [batter({ playerKey: "my-batter", r: 1, rbi: 1, sb: 0 })],
        opponentRoster: [batter({ playerKey: "opp-batter", r: 3, rbi: 3, sb: 0 })],
        freeAgents: [
          batter({
            playerKey: "speed-only",
            name: "Speed Only",
            r: 1,
            rbi: 1,
            sb: 8,
            obpNumerator: 6,
            obpDenominator: 24,
            obp: 6 / 24,
          }),
        ],
      }),
      snapshot,
    );

    expect(report.baseline.categories.map((category) => category.category)).toEqual([
      "R",
      "RBI",
      "OBP",
    ]);
    expect(
      report.recommendations[0]?.affectedCategories.map((category) => category.category) ?? [],
    ).not.toContain("SB");
  });

  it("uses active roster slots, not bench pitchers, for matchup category EV", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        pitcher({ playerKey: "active-low-ip", name: "Active Low IP", ip: 2, out: 6, k: 2 }),
        pitcher({
          playerKey: "bench-volume",
          name: "Bench Volume",
          ip: 18,
          out: 54,
          k: 20,
        }),
      ],
      opponentRoster: [pitcher({ playerKey: "opp", ip: 10, out: 30, k: 10 })],
      freeAgents: [pitcher({ playerKey: "starter", name: "Starter", ip: 8, out: 24, k: 9 })],
    });
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: [
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
      ],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "active-low-ip",
          name: "Active Low IP",
          team: "SEA",
          eligiblePositions: ["P"],
          selectedPosition: "P",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-volume",
          name: "Bench Volume",
          team: "SEA",
          eligiblePositions: ["P"],
          selectedPosition: "BN",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "P", count: 1 })],
      emptySlots: [],
      ilUsed: 0,
      ilSlots: 0,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });

    const report = rankAddCandidates(set, snapshot);

    const baselineOut = report.baseline.categories.find((category) => category.category === "OUT");
    const starter = report.recommendations.find((entry) => entry.playerKey === "starter");
    expect(baselineOut?.winProbability).toBeLessThan(0.1);
    expect(starter?.affectedCategories.map((delta) => delta.category)).toContain("OUT");
  });

  it("optimizes lineup with primary category weights from opponent scout", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({
          playerKey: "low-power-active",
          name: "Low Power Active",
          hr: 0.2,
          r: 7,
          rbi: 2,
        }),
        batter({
          playerKey: "power-bench",
          name: "Power Bench",
          hr: 5,
          r: 3,
          rbi: 6,
          tb: 20,
        }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 5, r: 4, rbi: 5 })],
      freeAgents: [],
    });
    const baseline = simulateMatchup(set.myRoster.slice(0, 1), set.opponentRoster, 1000, 7);
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: [
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
      ],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "low-power-active",
          name: "Low Power Active",
          team: "NYY",
          eligiblePositions: ["Util"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "power-bench",
          name: "Power Bench",
          team: "LAD",
          eligiblePositions: ["Util"],
          selectedPosition: "BN",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "Util", count: 1 })],
      emptySlots: [],
      ilUsed: 0,
      ilSlots: 0,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });

    const [move] = optimizeLineup(set, baseline, snapshot).recommendations;

    expect(move).toMatchObject({
      type: "lineup",
      startPlayerKey: "power-bench",
      sitPlayerKey: "low-power-active",
    });
    expect(move?.affectedCategories.map((delta) => delta.category)).toContain("HR");
  });

  it("exposes the full optimal lineup assignment with bench sits", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({ playerKey: "low-power-active", name: "Low Power Active", hr: 0.2, r: 7, rbi: 2 }),
        batter({ playerKey: "power-bench", name: "Power Bench", hr: 5, r: 3, rbi: 6, tb: 20 }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 5, r: 4, rbi: 5 })],
      freeAgents: [],
    });
    const baseline = simulateMatchup(set.myRoster.slice(0, 1), set.opponentRoster, 1000, 7);
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: ["R", "HR", "RBI", "TB"],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "low-power-active",
          name: "Low Power Active",
          team: "NYY",
          eligiblePositions: ["Util"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "power-bench",
          name: "Power Bench",
          team: "LAD",
          eligiblePositions: ["Util"],
          selectedPosition: "BN",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "Util", count: 1 })],
      emptySlots: [],
      ilUsed: 0,
      ilSlots: 0,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });

    const { optimalLineup, optimalBench } = optimizeLineup(set, baseline, snapshot);

    expect(optimalLineup).toHaveLength(1);
    expect(optimalLineup[0]).toMatchObject({
      slot: "Util",
      kind: "batter",
      playerKey: "power-bench",
      isCurrentStarter: false,
    });
    expect(optimalBench.map((player) => player.playerKey)).toEqual(["low-power-active"]);
  });

  it("does not recommend multiple bench players over the same active starter", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({ playerKey: "active-one", name: "Active One", pa: 10, r: 1, hr: 0, rbi: 1 }),
        batter({ playerKey: "active-two", name: "Active Two", pa: 9, r: 1, hr: 0, rbi: 1 }),
        batter({ playerKey: "bench-one", name: "Bench One", pa: 28, r: 5, hr: 2, rbi: 6 }),
        batter({ playerKey: "bench-two", name: "Bench Two", pa: 26, r: 4, hr: 2, rbi: 5 }),
        batter({ playerKey: "bench-three", name: "Bench Three", pa: 24, r: 4, hr: 1, rbi: 4 }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 3 })],
      freeAgents: [],
    });
    const baseline = simulateMatchup(set.myRoster, set.opponentRoster, 1000, 7);
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: [
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
      ],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "active-one",
          name: "Active One",
          team: "NYY",
          eligiblePositions: ["Util"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "active-two",
          name: "Active Two",
          team: "NYY",
          eligiblePositions: ["Util"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-one",
          name: "Bench One",
          team: "LAD",
          eligiblePositions: ["Util"],
          selectedPosition: "BN",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-two",
          name: "Bench Two",
          team: "LAD",
          eligiblePositions: ["Util"],
          selectedPosition: "BN",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-three",
          name: "Bench Three",
          team: "LAD",
          eligiblePositions: ["Util"],
          selectedPosition: "BN",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "Util", count: 2 })],
      emptySlots: [],
      ilUsed: 0,
      ilSlots: 0,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });

    const moves = optimizeLineup(set, baseline, snapshot).recommendations;

    expect(moves).toHaveLength(2);
    expect(new Set(moves.map((move) => move.sitPlayerKey)).size).toBe(moves.length);
  });

  it("only recommends start/sit swaps the bench player can legally fill", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({ playerKey: "active-catcher", name: "Active Catcher", pa: 4, r: 0, hr: 0 }),
        batter({ playerKey: "active-util", name: "Active Util", pa: 5, r: 0, hr: 0 }),
        batter({ playerKey: "bench-outfield", name: "Bench Outfield", pa: 30, r: 6, hr: 3 }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 3 })],
      freeAgents: [],
    });
    const baseline = simulateMatchup(set.myRoster, set.opponentRoster, 1000, 7);
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: [
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
      ],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "active-catcher",
          name: "Active Catcher",
          team: "NYY",
          eligiblePositions: ["C"],
          selectedPosition: "C",
        }),
        new LeagueStatePlayer({
          playerKey: "active-util",
          name: "Active Util",
          team: "NYY",
          eligiblePositions: ["1B"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-outfield",
          name: "Bench Outfield",
          team: "LAD",
          eligiblePositions: ["OF"],
          selectedPosition: "BN",
        }),
      ],
      rosterSlots: [
        new RosterSlotCount({ position: "C", count: 1 }),
        new RosterSlotCount({ position: "Util", count: 1 }),
      ],
      emptySlots: [],
      ilUsed: 0,
      ilSlots: 0,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });

    const moves = optimizeLineup(set, baseline, snapshot).recommendations;

    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({
      startPlayerKey: "bench-outfield",
      sitPlayerKey: "active-util",
    });
  });

  it("recommends bench bats when a legal improvement requires reassigning active positions", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({ playerKey: "active-second", name: "Active Second", pa: 12, r: 1, hr: 0 }),
        batter({ playerKey: "active-third", name: "Active Third", pa: 8, r: 0, hr: 0 }),
        batter({ playerKey: "active-short", name: "Active Short", pa: 22, r: 3, hr: 1 }),
        batter({ playerKey: "active-util", name: "Active Util", pa: 18, r: 2, hr: 1 }),
        batter({ playerKey: "bench-short", name: "Bench Short", pa: 30, r: 6, hr: 2 }),
        batter({ playerKey: "bench-third", name: "Bench Third", pa: 26, r: 5, hr: 2 }),
        batter({ playerKey: "il-bat", name: "IL Bat", pa: 34, r: 8, hr: 4 }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 3 })],
      freeAgents: [],
    });
    const baseline = simulateMatchup(set.myRoster, set.opponentRoster, 1000, 7);
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: [
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
      ],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "active-second",
          name: "Active Second",
          team: "NYY",
          eligiblePositions: ["2B"],
          selectedPosition: "2B",
        }),
        new LeagueStatePlayer({
          playerKey: "active-third",
          name: "Active Third",
          team: "NYY",
          eligiblePositions: ["3B"],
          selectedPosition: "3B",
        }),
        new LeagueStatePlayer({
          playerKey: "active-short",
          name: "Active Short",
          team: "NYY",
          eligiblePositions: ["SS", "Util"],
          selectedPosition: "SS",
        }),
        new LeagueStatePlayer({
          playerKey: "active-util",
          name: "Active Util",
          team: "NYY",
          eligiblePositions: ["1B", "Util"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-short",
          name: "Bench Short",
          team: "LAD",
          eligiblePositions: ["SS", "Util"],
          selectedPosition: "BN",
        }),
        new LeagueStatePlayer({
          playerKey: "bench-third",
          name: "Bench Third",
          team: "LAD",
          eligiblePositions: ["3B", "Util"],
          selectedPosition: "BN",
        }),
        new LeagueStatePlayer({
          playerKey: "il-bat",
          name: "IL Bat",
          team: "LAD",
          eligiblePositions: ["OF", "Util", "IL"],
          selectedPosition: "IL",
          status: "IL10",
        }),
      ],
      rosterSlots: [
        new RosterSlotCount({ position: "2B", count: 1 }),
        new RosterSlotCount({ position: "3B", count: 1 }),
        new RosterSlotCount({ position: "SS", count: 1 }),
        new RosterSlotCount({ position: "Util", count: 1 }),
      ],
      emptySlots: [],
      ilUsed: 1,
      ilSlots: 1,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });

    const moves = optimizeLineup(set, baseline, snapshot).recommendations;

    expect(moves.map((move) => [move.startPlayerKey, move.sitPlayerKey])).toEqual(
      expect.arrayContaining([
        ["bench-short", "active-util"],
        ["bench-third", "active-third"],
      ]),
    );
    expect(moves).toHaveLength(2);
  });

  it("does not recommend starting players parked in IL slots", () => {
    const set = new WeeklyProjectionSet({
      myRoster: [
        batter({ playerKey: "active-util", name: "Active Util", pa: 5, r: 0, hr: 0 }),
        batter({ playerKey: "il-bat", name: "IL Bat", pa: 30, r: 6, hr: 3 }),
      ],
      opponentRoster: [batter({ playerKey: "opp", hr: 3 })],
      freeAgents: [],
    });
    const baseline = simulateMatchup(set.myRoster, set.opponentRoster, 1000, 7);
    const snapshot = new LeagueStateSnapshot({
      leagueId: "62744",
      teamId: "12",
      scoringFormat: "cumulative-category-h2h",
      scoringCategories: [
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
      ],
      weeklyAddLimit: 6,
      addsUsed: 0,
      roster: [
        new LeagueStatePlayer({
          playerKey: "active-util",
          name: "Active Util",
          team: "NYY",
          eligiblePositions: ["1B"],
          selectedPosition: "Util",
        }),
        new LeagueStatePlayer({
          playerKey: "il-bat",
          name: "IL Bat",
          team: "LAD",
          eligiblePositions: ["OF", "Util"],
          selectedPosition: "IL",
        }),
      ],
      rosterSlots: [new RosterSlotCount({ position: "Util", count: 1 })],
      emptySlots: [],
      ilUsed: 1,
      ilSlots: 1,
      matchup: {
        week: 11,
        weekStart: "2026-06-01",
        weekEnd: "2026-06-07",
        opponentTeamKey: "mlb.l.62744.t.3",
        opponentTeamName: "Opponent",
        categories: [],
      },
    });

    const moves = optimizeLineup(set, baseline, snapshot).recommendations;

    expect(moves).toHaveLength(0);
  });
});
