import { describe, expect, it } from "vite-plus/test";

import {
  BatterProjectionSource,
  BattingOrderContext,
  blendBatterProjections,
  BlendedPitcherProjection,
  buildWeeklyProjectionSet,
  ParkFactorContext,
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
});
