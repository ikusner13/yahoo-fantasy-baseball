import { describe, expect, it } from "vite-plus/test";

import { parkFactorsByTeam } from "../../src/services/ProjectionData";
import {
  BatterProjectionSource,
  BattingOrderContext,
  blendBatterProjections,
  BlendedPitcherProjection,
  buildWeeklyProjectionSet,
  ParkFactorContext,
  parkHrFactor,
  PitcherProjectionSource,
  ProjectionPool,
  ProjectionSourceWeight,
  prorateBatterProjection,
  proratePitcherProjection,
  StatcastPlayerContext,
  WeeklyContext,
  WeeklySchedule,
} from "../../src/services/ProjectionModel";

const makeBatter = (overrides: {
  readonly playerKey?: string;
  readonly name?: string;
  readonly team?: string;
  readonly status?: string;
}) =>
  new BatterProjectionSource({
    source: "rthebatx",
    playerKey: overrides.playerKey ?? "mlb.p.batter",
    mlbId: 111,
    name: overrides.name ?? "Ada Batter",
    team: overrides.team ?? "NYY",
    pa: 100,
    r: 20,
    h: 30,
    hr: 10,
    rbi: 25,
    sb: 5,
    tb: 70,
    obp: 0.4,
    ab: 80,
    bb: 15,
    hbp: 2,
    sf: 3,
    status: overrides.status,
  });

const batterRows = [
  makeBatter({}),
  new BatterProjectionSource({
    source: "steamerr",
    playerKey: "mlb.p.batter",
    name: "Ada Batter",
    team: "NYY",
    pa: 80,
    r: 10,
    h: 20,
    hr: 4,
    rbi: 15,
    sb: 1,
    tb: 40,
    obp: 0.32,
    ab: 68,
    bb: 9,
    hbp: 1,
    sf: 2,
  }),
];

describe("ProjectionModel Phase 2 math", () => {
  it("blends ROS batter projections with per-source weights", () => {
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 0.75 }),
      new ProjectionSourceWeight({ source: "steamerr", weight: 0.25 }),
    ]);

    expect(projection?.pa).toBe(95);
    expect(projection?.hr).toBe(8.5);
    expect(projection?.obp).toBeCloseTo(0.38);
    expect(projection?.ab).toBe(77);
  });

  it("prorates batter counting stats by remaining games and Vegas implied runs", () => {
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 1 }),
    ]);
    const line = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 7, gamesRemaining: 7 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: { NYY: 5.4 },
      }),
    );

    const expectedPa = 7 * 4.2 * (5.4 / 4.5);
    const expectedScale = expectedPa / 100;
    expect(line.pa).toBeCloseTo(expectedPa);
    expect(line.hr).toBeCloseTo(10 * expectedScale);
    expect(line.obpNumerator).toBeCloseTo((30 + 15 + 2) * expectedScale);
    expect(line.obpDenominator).toBeCloseTo((80 + 15 + 2 + 3) * expectedScale);
    expect(line.obp).toBeCloseTo(0.47);
  });

  it("applies Statcast and park context to weekly hitter category expectations", () => {
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 1 }),
    ]);
    const baseline = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
      }),
    );
    const boosted = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
        statcastByPlayerKey: {
          "mlb:111": new StatcastPlayerContext({
            // Large pa ⇒ near-full reliability, the closest analogue to the old always-on bumps.
            pa: 100000,
            xwoba: 0.38,
            barrelPct: 15,
            hardHitPct: 49,
            sprintSpeed: 29,
          }),
        },
        parkFactorsByTeam: {
          NYY: new ParkFactorContext({ runsFactor: 1.03, hrFactor: 1.12 }),
        },
      }),
    );

    expect(boosted.hr).toBeGreaterThan(baseline.hr);
    expect(boosted.tb).toBeGreaterThan(baseline.tb);
    expect(boosted.r).toBeGreaterThan(baseline.r);
    expect(boosted.sb).toBeGreaterThan(baseline.sb);
  });

  it("uses confirmed batting order to adjust weekly plate appearances", () => {
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 1 }),
    ]);
    const baseline = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
      }),
    );
    const leadoff = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
        confirmedLineupsByTeam: { NYY: 1 },
        battingOrdersByPlayerKey: {
          "mlb:111": new BattingOrderContext({ confirmedStarts: 1, battingOrderSum: 1 }),
        },
      }),
    );
    const ninth = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
        confirmedLineupsByTeam: { NYY: 1 },
        battingOrdersByPlayerKey: {
          "mlb:111": new BattingOrderContext({ confirmedStarts: 1, battingOrderSum: 9 }),
        },
      }),
    );

    expect(leadoff.pa).toBeGreaterThan(baseline.pa);
    expect(ninth.pa).toBeLessThan(baseline.pa);
  });

  it("prorates starting pitchers by probable starts and accumulates rate components", () => {
    const line = proratePitcherProjection(
      new BlendedPitcherProjection({
        kind: "pitcher",
        playerKey: "mlb.p.pitcher",
        name: "Grace Starter",
        team: "SEA",
        ip: 120,
        gs: 20,
        k: 140,
        era: 3,
        whip: 1.1,
        qs: 12,
        svh: 0,
        appearances: 20,
      }),
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: { "mlb.p.pitcher": 2 },
        impliedRunsByTeam: {},
      }),
    );

    expect(line.ip).toBe(12);
    expect(line.out).toBe(36);
    expect(line.k).toBe(14);
    expect(line.er).toBe(4);
    expect(line.baserunners).toBeCloseTo(13.2);
    expect(line.era).toBe(3);
    expect(line.whip).toBe(1.1);
    expect(line.qs).toBeCloseTo(1.2);
    expect(line.expectedStarts).toBe(2);
  });

  it("applies Statcast skill context to pitcher strikeouts and ratios", () => {
    const projection = new BlendedPitcherProjection({
      kind: "pitcher",
      playerKey: "mlb.p.pitcher",
      mlbId: 456,
      name: "Grace Starter",
      team: "SEA",
      ip: 120,
      gs: 20,
      k: 140,
      era: 3,
      whip: 1.1,
      qs: 12,
      svh: 0,
      appearances: 20,
    });
    const baseContext = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: { "mlb.p.pitcher": 2 },
      impliedRunsByTeam: {},
    });
    const skilledContext = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: { "mlb.p.pitcher": 2 },
      impliedRunsByTeam: {},
      statcastByPlayerKey: {
        "mlb:456": new StatcastPlayerContext({
          // Large pa/pitches ⇒ near-full reliability (old always-on behavior analogue).
          pa: 100000,
          pitches: 100000,
          xwoba: 0.27,
          barrelPct: 5,
          whiffPct: 32,
          kPct: 29,
        }),
      },
    });

    const baseline = proratePitcherProjection(projection, baseContext);
    const skilled = proratePitcherProjection(projection, skilledContext);

    expect(skilled.k).toBeGreaterThan(baseline.k);
    expect(skilled.era).toBeLessThan(baseline.era);
    expect(skilled.whip).toBeLessThan(baseline.whip);
  });

  // --- F3: stabilization shrinkage boundary cases ---

  const batterStatcastContext = (statcast: StatcastPlayerContext) =>
    new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: {},
      impliedRunsByTeam: {},
      statcastByPlayerKey: { "mlb:111": statcast },
    });

  const pitcherStatcastWeekly = (statcast: StatcastPlayerContext) =>
    new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: { "mlb.p.pitcher": 2 },
      impliedRunsByTeam: {},
      statcastByPlayerKey: { "mlb:456": statcast },
    });

  const makePitcherProjection = (status?: string) =>
    new BlendedPitcherProjection({
      kind: "pitcher",
      playerKey: "mlb.p.pitcher",
      mlbId: 456,
      name: "Grace Starter",
      team: "SEA",
      ip: 120,
      gs: 20,
      k: 140,
      era: 3,
      whip: 1.1,
      qs: 12,
      svh: 0,
      appearances: 20,
      status,
    });

  it("F3: zero / absent sample size leaves the projection unchanged (multiplier 1.0)", () => {
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 1 }),
    ]);
    const baseline = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
      }),
    );
    // Strong rates but pa = 0 ⇒ reliability 0 ⇒ exactly neutral.
    const zeroN = prorateBatterProjection(
      projection!,
      batterStatcastContext(
        new StatcastPlayerContext({
          pa: 0,
          xwoba: 0.42,
          barrelPct: 18,
          hardHitPct: 52,
          sprintSpeed: 30,
        }),
      ),
    );
    expect(zeroN.hr).toBe(baseline.hr);
    expect(zeroN.tb).toBe(baseline.tb);
    expect(zeroN.r).toBe(baseline.r);
    expect(zeroN.sb).toBe(baseline.sb);

    // Absent pa behaves identically to pa = 0.
    const absentN = prorateBatterProjection(
      projection!,
      batterStatcastContext(new StatcastPlayerContext({ xwoba: 0.42, barrelPct: 18 })),
    );
    expect(absentN.hr).toBe(baseline.hr);
    expect(absentN.tb).toBe(baseline.tb);

    // Pitcher: zero pa/pitches ⇒ unchanged.
    const projection2 = makePitcherProjection();
    const pBaseline = proratePitcherProjection(
      projection2,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: { "mlb.p.pitcher": 2 },
        impliedRunsByTeam: {},
      }),
    );
    const pZeroN = proratePitcherProjection(
      projection2,
      pitcherStatcastWeekly(
        new StatcastPlayerContext({ pa: 0, pitches: 0, xwoba: 0.25, whiffPct: 36, kPct: 32 }),
      ),
    );
    expect(pZeroN.k).toBe(pBaseline.k);
    expect(pZeroN.era).toBe(pBaseline.era);
    expect(pZeroN.whip).toBe(pBaseline.whip);
  });

  it("F3: n = M yields exactly half the full-reliability adjustment (single metric)", () => {
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 1 }),
    ]);
    // Single active metric: xwOBA only. M_BATTER_XWOBA = 85.
    const atM = prorateBatterProjection(
      projection!,
      batterStatcastContext(new StatcastPlayerContext({ pa: 85, xwoba: 0.4 })),
    );
    const full = prorateBatterProjection(
      projection!,
      batterStatcastContext(new StatcastPlayerContext({ pa: 1e9, xwoba: 0.4 })),
    );
    const baseline = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
      }),
    );
    // hr scales by the (xwOBA-driven) power multiplier; deviation from baseline is the adjustment.
    // At pa = 1e9 reliability ≈ 1.0; at pa = M it is exactly 0.5, so devAtM = devFull · 0.5.
    const devAtM = atM.hr - baseline.hr;
    const devFull = full.hr - baseline.hr;
    expect(devFull).toBeGreaterThan(0);
    expect(devAtM).toBeCloseTo(devFull * 0.5, 6);

    // Pitcher: single metric kPct only, M_PITCHER_K = 70.
    const projection2 = makePitcherProjection();
    const pBaseline = proratePitcherProjection(
      projection2,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: { "mlb.p.pitcher": 2 },
        impliedRunsByTeam: {},
      }),
    );
    const pAtM = proratePitcherProjection(
      projection2,
      pitcherStatcastWeekly(new StatcastPlayerContext({ pa: 70, kPct: 30 })),
    );
    const pFull = proratePitcherProjection(
      projection2,
      pitcherStatcastWeekly(new StatcastPlayerContext({ pa: 1e9, kPct: 30 })),
    );
    const pDevAtM = pAtM.k - pBaseline.k;
    const pDevFull = pFull.k - pBaseline.k;
    expect(pDevFull).toBeGreaterThan(0);
    expect(pDevAtM).toBeCloseTo(pDevFull * 0.5, 6);
  });

  it("F3: larger sample size produces a larger adjustment in the same direction", () => {
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 1 }),
    ]);
    const baseline = prorateBatterProjection(
      projection!,
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
      }),
    );
    const small = prorateBatterProjection(
      projection!,
      batterStatcastContext(new StatcastPlayerContext({ pa: 30, xwoba: 0.4 })),
    );
    const large = prorateBatterProjection(
      projection!,
      batterStatcastContext(new StatcastPlayerContext({ pa: 300, xwoba: 0.4 })),
    );
    expect(small.hr).toBeGreaterThan(baseline.hr);
    expect(large.hr).toBeGreaterThan(small.hr);
  });

  // --- F4: playing-time / injury volume discount ---

  // Blend a single-source batter line carrying a Yahoo status (no class-instance spread).
  const makeBlendedBatter = (status?: string) =>
    blendBatterProjections(
      [makeBatter({ status })],
      [new ProjectionSourceWeight({ source: "rthebatx", weight: 1 })],
    )[0]!;

  const makeBlendedReliever = (status?: string) =>
    new BlendedPitcherProjection({
      kind: "pitcher",
      playerKey: "mlb.p.reliever",
      name: "Leverage Reliever",
      team: "BOS",
      ip: 65,
      gs: 0,
      k: 78,
      era: 3,
      whip: 1.1,
      qs: 0,
      svh: 24,
      appearances: 65,
      status,
    });

  it("F4: batter status discounts weekly volume (counting) but not obp", () => {
    const ctx = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: {},
      impliedRunsByTeam: {},
    });

    const healthyLine = prorateBatterProjection(makeBlendedBatter(), ctx);
    const dtdLine = prorateBatterProjection(makeBlendedBatter("DTD"), ctx);
    const ilLine = prorateBatterProjection(makeBlendedBatter("IL10"), ctx);

    // DTD = 0.90× volume on every counting stat.
    expect(dtdLine.pa / healthyLine.pa).toBeCloseTo(0.9, 6);
    expect(dtdLine.r / healthyLine.r).toBeCloseTo(0.9, 6);
    expect(dtdLine.h / healthyLine.h).toBeCloseTo(0.9, 6);
    expect(dtdLine.hr / healthyLine.hr).toBeCloseTo(0.9, 6);
    expect(dtdLine.rbi / healthyLine.rbi).toBeCloseTo(0.9, 6);
    expect(dtdLine.sb / healthyLine.sb).toBeCloseTo(0.9, 6);
    expect(dtdLine.tb / healthyLine.tb).toBeCloseTo(0.9, 6);
    // obp (a rate) is invariant under the volume discount.
    expect(dtdLine.obp).toBeCloseTo(healthyLine.obp, 10);

    // IL10 ⇒ near-zero (× 0.05).
    expect(ilLine.pa / healthyLine.pa).toBeCloseTo(0.05, 6);
    expect(ilLine.hr / healthyLine.hr).toBeCloseTo(0.05, 6);
    expect(ilLine.obp).toBeCloseTo(healthyLine.obp, 10);
  });

  it("F4: pitcher status discounts ip/k/qs/svh/out but not era/whip", () => {
    const ctx = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: { "mlb.p.pitcher": 2 },
      impliedRunsByTeam: {},
    });

    const healthyLine = proratePitcherProjection(makePitcherProjection(), ctx);
    const ilLine = proratePitcherProjection(makePitcherProjection("IL15"), ctx);

    const f = 0.05;
    expect(ilLine.ip / healthyLine.ip).toBeCloseTo(f, 6);
    expect(ilLine.out / healthyLine.out).toBeCloseTo(f, 6);
    expect(ilLine.k / healthyLine.k).toBeCloseTo(f, 6);
    expect(ilLine.qs / healthyLine.qs).toBeCloseTo(f, 6);
    expect(ilLine.er / healthyLine.er).toBeCloseTo(f, 6);
    expect(ilLine.baserunners / healthyLine.baserunners).toBeCloseTo(f, 6);
    // era/whip are ratios with numerator and ip both scaled ⇒ invariant.
    expect(ilLine.era).toBeCloseTo(healthyLine.era, 10);
    expect(ilLine.whip).toBeCloseTo(healthyLine.whip, 10);

    // Reliever svh path (scales by reliefScale) also drops.
    const relieverCtx = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "BOS", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: {},
      impliedRunsByTeam: {},
    });
    const healthyRel = proratePitcherProjection(makeBlendedReliever(), relieverCtx);
    const dtdRel = proratePitcherProjection(makeBlendedReliever("DTD"), relieverCtx);
    expect(dtdRel.svh / healthyRel.svh).toBeCloseTo(0.9, 6);
    expect(dtdRel.ip / healthyRel.ip).toBeCloseTo(0.9, 6);
    expect(dtdRel.era).toBeCloseTo(healthyRel.era, 10);
    expect(dtdRel.whip).toBeCloseTo(healthyRel.whip, 10);
  });

  it("F4: healthy / absent status is exactly neutral (no-op)", () => {
    const ctx = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: {},
      impliedRunsByTeam: {},
    });
    const noStatus = prorateBatterProjection(makeBlendedBatter(), ctx);
    const emptyStatus = prorateBatterProjection(makeBlendedBatter(""), ctx);
    const unknownStatus = prorateBatterProjection(makeBlendedBatter("PROBABLE"), ctx);
    expect(emptyStatus.pa).toBe(noStatus.pa);
    expect(emptyStatus.hr).toBe(noStatus.hr);
    expect(unknownStatus.pa).toBe(noStatus.pa);
    expect(unknownStatus.hr).toBe(noStatus.hr);
  });

  it("F4: aggregate weekly PA with a flagged player is strictly below all-healthy", () => {
    const ctx = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: {},
      impliedRunsByTeam: {},
    });
    const sumPa = (status?: string) =>
      blendBatterProjections(
        [
          makeBatter({ playerKey: "mlb.p.a", name: "A" }),
          makeBatter({ playerKey: "mlb.p.b", name: "B", status }),
        ],
        [new ProjectionSourceWeight({ source: "rthebatx", weight: 1 })],
      )
        .map((p) => prorateBatterProjection(p, ctx).pa)
        .reduce((a, b) => a + b, 0);

    expect(sumPa("DTD")).toBeLessThan(sumPa());
    expect(sumPa("IL60")).toBeLessThan(sumPa("DTD"));
  });

  it("prorates reliever ROS innings by expected weekly appearances", () => {
    const line = proratePitcherProjection(
      new BlendedPitcherProjection({
        kind: "pitcher",
        playerKey: "mlb.p.reliever",
        name: "Leverage Reliever",
        team: "BOS",
        ip: 65,
        gs: 0,
        k: 78,
        era: 3,
        whip: 1.1,
        qs: 0,
        svh: 24,
        appearances: 65,
      }),
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "BOS", gamesThisWeek: 6, gamesRemaining: 6 })],
        probableStartsByPlayerKey: {},
        impliedRunsByTeam: {},
      }),
    );

    expect(line.ip).toBeCloseTo((65 / 162) * 6);
    expect(line.out).toBeCloseTo((65 / 162) * 6 * 3);
    expect(line.svh).toBeCloseTo((24 / 162) * 6);
  });

  it("uses per-appearance workload when a reliever is listed for a probable start", () => {
    const line = proratePitcherProjection(
      new BlendedPitcherProjection({
        kind: "pitcher",
        playerKey: "mlb.p.opener",
        name: "Listed Opener",
        team: "MIA",
        ip: 65,
        gs: 0,
        k: 78,
        era: 3,
        whip: 1.1,
        qs: 0,
        svh: 12,
        appearances: 65,
      }),
      new WeeklyContext({
        schedules: [new WeeklySchedule({ team: "MIA", gamesThisWeek: 6, gamesRemaining: 1 })],
        probableStartsByPlayerKey: { "mlb.p.opener": 1 },
        impliedRunsByTeam: {},
      }),
    );

    expect(line.expectedStarts).toBe(1);
    expect(line.ip).toBe(1);
    expect(line.out).toBe(3);
    expect(line.k).toBeCloseTo(1.2);
  });

  it("builds weekly expected lines for our roster, opponent roster, and free agents", () => {
    const set = buildWeeklyProjectionSet(
      new ProjectionPool({
        myRoster: ["mlb.p.my-batter"],
        opponentRoster: ["mlb.p.opp-pitcher"],
        freeAgents: ["mlb.p.free-agent"],
        batters: [
          makeBatter({ playerKey: "mlb.p.my-batter", name: "My Batter" }),
          makeBatter({ playerKey: "mlb.p.free-agent", name: "Free Agent", team: "LAD" }),
        ],
        pitchers: [
          new PitcherProjectionSource({
            source: "ratcdc",
            playerKey: "mlb.p.opp-pitcher",
            name: "Opponent Pitcher",
            team: "SEA",
            ip: 120,
            gs: 20,
            k: 140,
            era: 3,
            whip: 1.1,
            qs: 12,
            svh: 0,
            appearances: 20,
          }),
        ],
      }),
      new WeeklyContext({
        schedules: [
          new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 }),
          new WeeklySchedule({ team: "LAD", gamesThisWeek: 7, gamesRemaining: 7 }),
          new WeeklySchedule({ team: "SEA", gamesThisWeek: 6, gamesRemaining: 6 }),
        ],
        probableStartsByPlayerKey: { "mlb.p.opp-pitcher": 1 },
        impliedRunsByTeam: { LAD: 5.2 },
      }),
    );

    expect(set.myRoster).toHaveLength(1);
    expect(set.myRoster[0]).toMatchObject({ playerKey: "mlb.p.my-batter", kind: "batter" });
    expect(set.opponentRoster).toHaveLength(1);
    expect(set.opponentRoster[0]).toMatchObject({
      playerKey: "mlb.p.opp-pitcher",
      kind: "pitcher",
    });
    expect(set.freeAgents).toHaveLength(1);
    expect(set.freeAgents[0]).toMatchObject({ playerKey: "mlb.p.free-agent", kind: "batter" });
  });

  // --- F5: per-(source, category) blend weights ---

  it("F5: weights blend differently per category (per-category overrides)", () => {
    // Source A: high HR, low SB. Source B: low HR, high SB. Same player.
    const sourceA = new BatterProjectionSource({
      source: "rthebatx",
      playerKey: "mlb.p.cat",
      name: "Cat Test",
      team: "NYY",
      pa: 100,
      r: 20,
      h: 30,
      hr: 40,
      rbi: 25,
      sb: 2,
      tb: 80,
      obp: 0.4,
      ab: 80,
      bb: 15,
      hbp: 2,
      sf: 3,
    });
    const sourceB = new BatterProjectionSource({
      source: "steamerr",
      playerKey: "mlb.p.cat",
      name: "Cat Test",
      team: "NYY",
      pa: 100,
      r: 20,
      h: 30,
      hr: 0,
      rbi: 25,
      sb: 40,
      tb: 40,
      obp: 0.32,
      ab: 80,
      bb: 15,
      hbp: 2,
      sf: 3,
    });

    // Equal base weights, but HR leans hard to A and SB leans hard to B.
    const [projection] = blendBatterProjections(
      [sourceA, sourceB],
      [
        new ProjectionSourceWeight({ source: "rthebatx", weight: 0.5 }),
        new ProjectionSourceWeight({ source: "steamerr", weight: 0.5 }),
        new ProjectionSourceWeight({ source: "rthebatx", weight: 0.9, category: "hr" }),
        new ProjectionSourceWeight({ source: "steamerr", weight: 0.1, category: "hr" }),
        new ProjectionSourceWeight({ source: "rthebatx", weight: 0.1, category: "sb" }),
        new ProjectionSourceWeight({ source: "steamerr", weight: 0.9, category: "sb" }),
      ],
    );

    // HR: (40·0.9 + 0·0.1)/(0.9+0.1) = 36 ⇒ pulled toward A's 40.
    expect(projection?.hr).toBeCloseTo(36, 6);
    // SB: (2·0.1 + 40·0.9)/(0.1+0.9) = 36.2 ⇒ pulled toward B's 40.
    expect(projection?.sb).toBeCloseTo(36.2, 6);
    // A category without an override uses the equal base weights ⇒ simple mean.
    expect(projection?.r).toBeCloseTo(20, 6);
    expect(projection?.tb).toBeCloseTo((80 + 40) / 2, 6);
  });

  it("F5: source-base-only weights reproduce the old flat-weight behavior", () => {
    // Same fixture & weights as the original flat-weight test; assert identical math.
    const [projection] = blendBatterProjections(batterRows, [
      new ProjectionSourceWeight({ source: "rthebatx", weight: 0.75 }),
      new ProjectionSourceWeight({ source: "steamerr", weight: 0.25 }),
    ]);

    expect(projection?.pa).toBe(95); // 100·0.75 + 80·0.25
    expect(projection?.hr).toBe(8.5); // 10·0.75 + 4·0.25
    expect(projection?.obp).toBeCloseTo(0.38); // 0.40·0.75 + 0.32·0.25
    expect(projection?.ab).toBe(77); // 80·0.75 + 68·0.25
  });

  // --- F6: handedness HR park splits ---

  const makeBlendedHandedBatter = (bats?: string) =>
    blendBatterProjections(
      [
        new BatterProjectionSource({
          source: "rthebatx",
          playerKey: "mlb.p.handed",
          mlbId: 222,
          name: "Handed Batter",
          team: "NYY",
          pa: 100,
          r: 20,
          h: 30,
          hr: 10,
          rbi: 25,
          sb: 5,
          tb: 70,
          obp: 0.4,
          ab: 80,
          bb: 15,
          hbp: 2,
          sf: 3,
          bats,
        }),
      ],
      [new ProjectionSourceWeight({ source: "rthebatx", weight: 1 })],
    )[0]!;

  // Park with a handedness split (LHB > RHB) and neutral Statcast so the park factor is the only
  // variable acting on hr/tb.
  const splitParkContext = (hrFactorLHB: number, hrFactorRHB: number, hrFactor: number) =>
    new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: {},
      impliedRunsByTeam: {},
      parkFactorsByTeam: {
        NYY: new ParkFactorContext({ runsFactor: 1, hrFactor, hrFactorLHB, hrFactorRHB }),
      },
    });

  it("F6: handedness HR split boosts the favored side and falls back to overall for switch", () => {
    const ctx = splitParkContext(1.15, 1.04, 1.08);
    const left = prorateBatterProjection(makeBlendedHandedBatter("L"), ctx);
    const right = prorateBatterProjection(makeBlendedHandedBatter("R"), ctx);
    const switchHit = prorateBatterProjection(makeBlendedHandedBatter("S"), ctx);
    const unknown = prorateBatterProjection(makeBlendedHandedBatter(), ctx);

    // LHB park factor (1.15) > RHB (1.04) ⇒ left's HR/TB exceed right's.
    expect(left.hr).toBeGreaterThan(right.hr);
    expect(left.tb).toBeGreaterThan(right.tb);

    // Switch and unknown both use the overall hrFactor (1.08), between the two sides.
    expect(switchHit.hr).toBe(unknown.hr);
    expect(switchHit.hr).toBeGreaterThan(right.hr);
    expect(switchHit.hr).toBeLessThan(left.hr);

    // Magnitudes track the factors exactly (neutral Statcast ⇒ hr scales by the park factor).
    expect(left.hr / switchHit.hr).toBeCloseTo(1.15 / 1.08, 6);
    expect(right.hr / switchHit.hr).toBeCloseTo(1.04 / 1.08, 6);
  });

  it("F6: park with no split applies the overall hrFactor to every handedness", () => {
    const ctx = new WeeklyContext({
      schedules: [new WeeklySchedule({ team: "NYY", gamesThisWeek: 6, gamesRemaining: 6 })],
      probableStartsByPlayerKey: {},
      impliedRunsByTeam: {},
      parkFactorsByTeam: { NYY: new ParkFactorContext({ runsFactor: 1, hrFactor: 1.1 }) },
    });
    const left = prorateBatterProjection(makeBlendedHandedBatter("L"), ctx);
    const right = prorateBatterProjection(makeBlendedHandedBatter("R"), ctx);
    const unknown = prorateBatterProjection(makeBlendedHandedBatter(), ctx);

    expect(left.hr).toBe(right.hr);
    expect(left.hr).toBe(unknown.hr);
    expect(left.tb).toBe(right.tb);
  });

  it("F6: parkHrFactor resolves L→LHB, R→RHB, S/undefined→overall, undefined park→1", () => {
    const park = new ParkFactorContext({
      runsFactor: 1,
      hrFactor: 1.08,
      hrFactorLHB: 1.15,
      hrFactorRHB: 1.04,
    });
    expect(parkHrFactor(park, "L")).toBe(1.15);
    expect(parkHrFactor(park, "R")).toBe(1.04);
    expect(parkHrFactor(park, "S")).toBe(1.08);
    expect(parkHrFactor(park, undefined)).toBe(1.08);

    // Park with no split ⇒ overall for every side.
    const noSplit = new ParkFactorContext({ runsFactor: 1, hrFactor: 0.9 });
    expect(parkHrFactor(noSplit, "L")).toBe(0.9);
    expect(parkHrFactor(noSplit, "R")).toBe(0.9);

    // Undefined park ⇒ neutral 1.
    expect(parkHrFactor(undefined, "L")).toBe(1);
    expect(parkHrFactor(undefined, undefined)).toBe(1);
  });

  it("F6: bats is absent today ⇒ behaves as a plain regressed-table upgrade (overall factor)", () => {
    // No upstream provides bats, so a real blended line carries bats=undefined ⇒ overall hrFactor.
    const ctx = splitParkContext(1.15, 1.04, 1.08);
    const defaultBatter = prorateBatterProjection(makeBlendedHandedBatter(), ctx);
    const switchHit = prorateBatterProjection(makeBlendedHandedBatter("S"), ctx);
    expect(defaultBatter.hr).toBe(switchHit.hr);
  });

  it("F6: regressed park table reflects expected direction within a sane band", () => {
    const coors = parkFactorsByTeam.COL!;
    const oracle = parkFactorsByTeam.SF!;
    // Coors boosts HR, Oracle suppresses HR.
    expect(coors.hrFactor).toBeGreaterThan(1);
    expect(oracle.hrFactor).toBeLessThan(1);
    // Coors runs is the highest run environment.
    expect(coors.runsFactor).toBeGreaterThan(1.1);
    // Handedness splits are present and directionally correct.
    expect(parkFactorsByTeam.NYY!.hrFactorLHB!).toBeGreaterThan(
      parkFactorsByTeam.NYY!.hrFactorRHB!,
    );
    expect(parkFactorsByTeam.COL!.hrFactorRHB!).toBeGreaterThan(
      parkFactorsByTeam.COL!.hrFactorLHB!,
    );
    // Every park HR factor sits within a sane regressed band after 3-yr regression.
    for (const park of Object.values(parkFactorsByTeam)) {
      expect(park.hrFactor).toBeGreaterThanOrEqual(0.8);
      expect(park.hrFactor).toBeLessThanOrEqual(1.2);
      expect(park.runsFactor).toBeGreaterThanOrEqual(0.8);
      expect(park.runsFactor).toBeLessThanOrEqual(1.2);
    }
  });

  it("F5: renormalization holds when a player is missing from one source", () => {
    // Player present in rthebatx only; steamerr weight has nothing to apply to.
    const [projection] = blendBatterProjections(
      [makeBatter({ playerKey: "mlb.p.solo" })],
      [
        new ProjectionSourceWeight({ source: "rthebatx", weight: 0.25 }),
        new ProjectionSourceWeight({ source: "steamerr", weight: 0.75 }),
        new ProjectionSourceWeight({ source: "rthebatx", weight: 0.9, category: "hr" }),
      ],
    );

    // Only the rthebatx row survives ⇒ totalWeight renormalizes to that single source's value.
    expect(projection?.pa).toBe(100);
    expect(projection?.hr).toBe(10);
    expect(projection?.obp).toBeCloseTo(0.4, 6);
  });
});
