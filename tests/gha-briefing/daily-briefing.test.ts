import { NodeServices } from "@effect/platform-node";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseFlags, runDailyBriefing, sentToday } from "../../scripts/daily-briefing";
import { makeApiCacheTest } from "../../src/services/ApiCache";
import { CalibrationHarness, CalibrationReport } from "../../src/services/CalibrationHarness";
import { StoredSimJob } from "../../src/services/DecisionEngine";
import { DiscordNotifier } from "../../src/services/DiscordNotifier";
import {
  LeagueState,
  LeagueStatePlayer,
  LeagueStateSnapshot,
} from "../../src/services/LeagueState";
import {
  LAST_MANAGER_DELIVERY_CACHE_KEY,
  ManagerDeliveryReport,
} from "../../src/services/ManagerDelivery";
import {
  LAST_MANAGER_BRIEFING_CACHE_KEY,
  ManagerBriefing,
  ManagerBriefingReport,
} from "../../src/services/ManagerBriefing";
import {
  WeeklyBatterLine,
  WeeklyPitcherLine,
  WeeklyProjectionSet,
} from "../../src/services/ProjectionModel";
import { StandingsHistory } from "../../src/services/StandingsHistory";
import { TelegramNotifier } from "../../src/services/TelegramNotifier";
import { WeeklyProjections } from "../../src/services/WeeklyProjections";
import { YahooClient } from "../../src/services/YahooClient";
import {
  simPartialKey,
  simReducedGenKey,
  simReducedKey,
  SimReducedGen,
  simSpecKey,
  specGeneration,
  UnitPartial,
} from "../../src/services/SimJob";
import {
  taskRunCountKey,
  taskStateKey,
  TaskRunCount,
  TaskState,
} from "../../src/services/Scheduler";

const DATE = "2026-07-04";

const batter = (o: Partial<ConstructorParameters<typeof WeeklyBatterLine>[0]> = {}) =>
  new WeeklyBatterLine({
    kind: "batter",
    playerKey: "b",
    name: "B",
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
    ...o,
  });

const stubBriefing = () =>
  new ManagerBriefingReport({
    summary: "cli full-cycle",
    generatedAt: new Date().toISOString(),
    addsRemaining: 4,
    reservedAdds: 1,
    projectedWeeklyIp: 21,
    closestCategories: ["HR"],
    categorySituations: [],
    managerTakeaways: [],
    categoryPlan: [],
    addTriggers: [],
    lineupAlerts: [],
    optimalLineup: [],
    optimalBench: [],
    rejectedTransactions: [],
    doNow: [],
    holdForLater: [],
    waiverTargets: [],
    warnings: [],
  });

type Store = Map<string, { data: string; updatedAt: string }>;

const inertYahooClient = YahooClient.of({
  config: { leagueId: "62744", teamId: "12" },
  getLeagueSettings: Effect.die("unused"),
  getTeamMetadata: Effect.die("unused"),
  getRoster: Effect.die("unused"),
  getRosterForDate: () => Effect.die("unused"),
  getRosterForTeam: () => Effect.die("unused"),
  getAvailablePlayers: () => Effect.die("unused"),
  getLeagueTransactions: () => Effect.die("unused"),
  getCurrentMatchup: Effect.die("unused"),
  getMatchupForWeek: () => Effect.die("unused"),
  getLeagueStandings: Effect.die("unused"),
  putRosterPositions: () => Effect.die("unused"),
});

const testLayer = (store: Store) => {
  const posted: Array<string> = [];
  const calibrationRecords: Array<unknown> = [];
  let standingsReads = 0;
  const layer = Layer.mergeAll(
    makeApiCacheTest(store),
    Layer.succeed(
      WeeklyProjections,
      WeeklyProjections.of({ currentMatchup: Effect.succeed(fixtureSet()) }),
    ),
    Layer.succeed(LeagueState, LeagueState.of({ snapshot: Effect.succeed(snapshot()) })),
    Layer.succeed(
      StandingsHistory,
      StandingsHistory.of({
        categoryTotals: Effect.sync(() => {
          standingsReads += 1;
          return [];
        }),
      }),
    ),
    Layer.succeed(
      ManagerBriefing,
      ManagerBriefing.of({
        currentBriefing: Effect.succeed(stubBriefing()),
        briefingFromReport: () => Effect.succeed(stubBriefing()),
      }),
    ),
    Layer.succeed(
      TelegramNotifier,
      TelegramNotifier.of({
        postMessage: () => Effect.void,
        postManagerBriefing: () =>
          Effect.sync(() => {
            posted.push("telegram");
          }),
      }),
    ),
    Layer.succeed(
      DiscordNotifier,
      DiscordNotifier.of({
        postManagerBriefing: () =>
          Effect.sync(() => {
            posted.push("discord");
          }),
      }),
    ),
    Layer.succeed(
      CalibrationHarness,
      CalibrationHarness.of({
        record: (retro) =>
          Effect.sync(() => {
            calibrationRecords.push(retro);
          }),
        closeOut: () => Effect.die("unused"),
        load: () => Effect.succeed([]),
        report: () =>
          Effect.succeed(
            new CalibrationReport({
              weeks: 0,
              predictions: 0,
              brier: null,
              logLoss: null,
              byCategory: [],
              reliability: [],
            }),
          ),
        sweep: () => Effect.die("unused"),
      }),
    ),
    Layer.succeed(YahooClient, inertYahooClient),
  );
  return { layer, posted, calibrationRecords, standingsReads: () => standingsReads };
};

const runCli = (store: Store, options: { readonly dryRun?: boolean; readonly force?: boolean }) => {
  const { layer, posted, calibrationRecords, standingsReads } = testLayer(store);
  return Effect.runPromise(
    runDailyBriefing({
      dryRun: options.dryRun ?? false,
      force: options.force ?? false,
      envFile: ".env.test",
    }).pipe(Effect.provide(layer), Effect.provide(NodeServices.layer)),
  ).then((result) => ({ result, posted, calibrationRecords, standingsReads }));
};

const decodeStored = <A>(store: Store, key: string, schema: Schema.Decoder<A>): A => {
  const row = store.get(key);
  expect(row).toBeDefined();
  return Schema.decodeUnknownSync(schema)(JSON.parse(row!.data)) as A;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-04T14:00:00.000Z"));
  process.env["USE_STANDINGS_HISTORY"] = "false";
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env["USE_STANDINGS_HISTORY"];
});

const pitcher = (o: Partial<ConstructorParameters<typeof WeeklyPitcherLine>[0]> = {}) =>
  new WeeklyPitcherLine({
    kind: "pitcher",
    playerKey: "p",
    name: "P",
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
    ...o,
  });

const fixtureSet = () =>
  new WeeklyProjectionSet({
    myRoster: [
      batter({ playerKey: "my-batter", name: "My Batter", hr: 1, r: 3, rbi: 3 }),
      pitcher({ playerKey: "my-pitcher", name: "My Pitcher", k: 4, out: 15 }),
    ],
    opponentRoster: [
      batter({ playerKey: "opp-batter", name: "Opp Batter", hr: 4, r: 4, rbi: 4 }),
      pitcher({ playerKey: "opp-pitcher", name: "Opp Pitcher", k: 9, out: 18 }),
    ],
    freeAgents: [
      batter({ playerKey: "power-bat", name: "Power Bat", hr: 12, r: 5, rbi: 6, tb: 12 }),
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
  });

const snapshot = () =>
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
        playerKey: "my-batter",
        name: "My Batter",
        team: "NYY",
        eligiblePositions: ["Util"],
        selectedPosition: "Util",
      }),
      new LeagueStatePlayer({
        playerKey: "my-pitcher",
        name: "My Pitcher",
        team: "SEA",
        eligiblePositions: ["P"],
        selectedPosition: "P",
      }),
    ],
    rosterSlots: [],
    emptySlots: [],
    ilUsed: 0,
    ilSlots: 0,
    matchup: {
      week: 1,
      weekStart: "2026-06-29",
      weekEnd: "2026-07-05",
      opponentTeamKey: "mlb.l.62744.t.1",
      opponentTeamName: "Opponent",
      categories: [],
    },
  });

describe("daily briefing CLI flags", () => {
  it("parses dry-run, force, and env-file flags", () => {
    expect(parseFlags(["--dry-run", "--force", "--env-file", ".env.test"])).toEqual({
      dryRun: true,
      force: true,
      envFile: ".env.test",
    });
    expect(parseFlags(["--env-file=.env.prod"])).toMatchObject({
      envFile: ".env.prod",
    });
  });
});

describe("sentToday guard", () => {
  const now = new Date("2026-07-04T14:00:00.000Z");

  it("treats same Eastern date as already sent", () => {
    expect(sentToday("2026-07-04T12:30:00.000Z", now)).toBe(true);
  });

  it("does not treat yesterday Eastern as sent today", () => {
    expect(sentToday("2026-07-04T03:30:00.000Z", now)).toBe(false);
  });
});

describe("daily briefing full-cycle", () => {
  it("persists the same sim artifacts, delivery record, last-success, and run-count as the worker path", async () => {
    const store: Store = new Map();

    const { result, posted, calibrationRecords, standingsReads } = await runCli(store, {});

    expect(result.status).toBe("sent");
    expect(posted).toEqual(["telegram", "discord"]);
    expect(calibrationRecords).toHaveLength(1);
    expect(standingsReads()).toBe(0);

    const stored = decodeStored(store, simSpecKey(DATE), StoredSimJob);
    expect(stored.stored.spec.scoringRoster.map((line) => line.playerKey)).toEqual([
      "my-batter",
      "my-pitcher",
    ]);
    expect(stored.stored.unitCount).toBe(stored.stored.spec.candidates.length);
    expect(stored.stored.unitCount).toBeGreaterThan(0);

    const gen = specGeneration(stored.stored.contextAt);
    for (let unit = 1; unit <= stored.stored.unitCount; unit += 1) {
      const partial = decodeStored(store, simPartialKey(DATE, unit, 0, gen), UnitPartial);
      expect(partial.iters).toBeGreaterThan(0);
      expect(partial.categories.length).toBeGreaterThan(0);
    }

    expect(decodeStored(store, simReducedKey(DATE), ManagerBriefingReport).summary).toBe(
      "cli full-cycle",
    );
    expect(decodeStored(store, simReducedGenKey(DATE), SimReducedGen).gen).toBe(gen);

    const delivery = decodeStored(store, LAST_MANAGER_DELIVERY_CACHE_KEY, ManagerDeliveryReport);
    expect(delivery.channels.map((channel) => [channel.channel, channel.ok])).toEqual([
      ["telegram", true],
      ["discord", true],
    ]);
    expect(
      decodeStored(store, LAST_MANAGER_BRIEFING_CACHE_KEY, ManagerBriefingReport).summary,
    ).toBe("cli full-cycle");
    expect(decodeStored(store, taskStateKey("send-briefing"), TaskState).completedAt).toContain(
      DATE,
    );
    expect(decodeStored(store, taskRunCountKey("send-briefing", DATE), TaskRunCount)).toMatchObject(
      {
        date: DATE,
        count: 1,
      },
    );
  });

  it("dry-run computes the briefing but writes no briefing artifacts, delivery state, scheduler state, or calibration rows", async () => {
    const store: Store = new Map([
      [
        "projection-cache:allowed",
        { data: JSON.stringify({ ok: true }), updatedAt: new Date().toISOString() },
      ],
    ]);

    const { result, posted, calibrationRecords } = await runCli(store, { dryRun: true });

    expect(result.status).toBe("dry-run");
    expect(posted).toEqual([]);
    expect(calibrationRecords).toEqual([]);
    expect(store.has("projection-cache:allowed")).toBe(true);
    expect(store.has(simSpecKey(DATE))).toBe(false);
    expect([...store.keys()].some((key) => key.startsWith(`sim:job:${DATE}:partial:`))).toBe(false);
    expect(store.has(simReducedKey(DATE))).toBe(false);
    expect(store.has(simReducedGenKey(DATE))).toBe(false);
    expect(store.has(LAST_MANAGER_DELIVERY_CACHE_KEY)).toBe(false);
    expect(store.has(LAST_MANAGER_BRIEFING_CACHE_KEY)).toBe(false);
    expect(store.has(taskStateKey("send-briefing"))).toBe(false);
    expect(store.has(taskRunCountKey("send-briefing", DATE))).toBe(false);
  });
});
