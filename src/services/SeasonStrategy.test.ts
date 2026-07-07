import { expect, test } from "vite-plus/test";

import { type Category, CATEGORIES, type PlayerValue } from "./TradeEval.ts";
import {
  type AvailablePlayer,
  buildSeasonScoreboard,
  buildWaiverTargets,
  type TeamCategoryTotals,
} from "./SeasonStrategy.ts";

// Real 12-team standings totals for this league (t.12 = me, rank 12 / dead last).
const TOTALS: ReadonlyArray<TeamCategoryTotals> = [
  {
    teamKey: "469.l.62744.t.6",
    rank: 1,
    categories: {
      R: 505,
      H: 877,
      HR: 121,
      RBI: 447,
      SB: 73,
      TB: 1450,
      OBP: 0.335,
      OUT: 3152,
      K: 1046,
      ERA: 3.91,
      WHIP: 1.22,
      QS: 69,
      "SV+H": 41,
    },
  },
  {
    teamKey: "469.l.62744.t.7",
    rank: 2,
    categories: {
      R: 517,
      H: 867,
      HR: 136,
      RBI: 508,
      SB: 54,
      TB: 1481,
      OBP: 0.336,
      OUT: 2768,
      K: 879,
      ERA: 4.21,
      WHIP: 1.25,
      QS: 61,
      "SV+H": 20,
    },
  },
  {
    teamKey: "469.l.62744.t.5",
    rank: 3,
    categories: {
      R: 478,
      H: 878,
      HR: 150,
      RBI: 477,
      SB: 125,
      TB: 1528,
      OBP: 0.337,
      OUT: 2808,
      K: 923,
      ERA: 3.84,
      WHIP: 1.21,
      QS: 74,
      "SV+H": 39,
    },
  },
  {
    teamKey: "469.l.62744.t.11",
    rank: 4,
    categories: {
      R: 511,
      H: 846,
      HR: 145,
      RBI: 483,
      SB: 75,
      TB: 1468,
      OBP: 0.334,
      OUT: 2455,
      K: 777,
      ERA: 4.25,
      WHIP: 1.28,
      QS: 57,
      "SV+H": 18,
    },
  },
  {
    teamKey: "469.l.62744.t.2",
    rank: 5,
    categories: {
      R: 499,
      H: 836,
      HR: 122,
      RBI: 439,
      SB: 69,
      TB: 1357,
      OBP: 0.34,
      OUT: 2373,
      K: 862,
      ERA: 3.72,
      WHIP: 1.23,
      QS: 38,
      "SV+H": 67,
    },
  },
  {
    teamKey: "469.l.62744.t.9",
    rank: 6,
    categories: {
      R: 458,
      H: 880,
      HR: 130,
      RBI: 440,
      SB: 80,
      TB: 1435,
      OBP: 0.326,
      OUT: 2594,
      K: 884,
      ERA: 3.75,
      WHIP: 1.25,
      QS: 61,
      "SV+H": 71,
    },
  },
  {
    teamKey: "469.l.62744.t.1",
    rank: 7,
    categories: {
      R: 473,
      H: 770,
      HR: 164,
      RBI: 465,
      SB: 74,
      TB: 1437,
      OBP: 0.329,
      OUT: 2100,
      K: 788,
      ERA: 3.65,
      WHIP: 1.14,
      QS: 47,
      "SV+H": 49,
    },
  },
  {
    teamKey: "469.l.62744.t.8",
    rank: 8,
    categories: {
      R: 510,
      H: 821,
      HR: 129,
      RBI: 425,
      SB: 74,
      TB: 1394,
      OBP: 0.331,
      OUT: 2297,
      K: 781,
      ERA: 4.27,
      WHIP: 1.3,
      QS: 34,
      "SV+H": 86,
    },
  },
  {
    teamKey: "469.l.62744.t.10",
    rank: 9,
    categories: {
      R: 468,
      H: 814,
      HR: 127,
      RBI: 444,
      SB: 60,
      TB: 1390,
      OBP: 0.333,
      OUT: 2130,
      K: 683,
      ERA: 4.23,
      WHIP: 1.34,
      QS: 49,
      "SV+H": 45,
    },
  },
  {
    teamKey: "469.l.62744.t.4",
    rank: 10,
    categories: {
      R: 445,
      H: 812,
      HR: 140,
      RBI: 444,
      SB: 48,
      TB: 1400,
      OBP: 0.319,
      OUT: 2142,
      K: 700,
      ERA: 4.1,
      WHIP: 1.29,
      QS: 40,
      "SV+H": 47,
    },
  },
  {
    teamKey: "469.l.62744.t.3",
    rank: 11,
    categories: {
      R: 484,
      H: 857,
      HR: 104,
      RBI: 419,
      SB: 74,
      TB: 1349,
      OBP: 0.342,
      OUT: 2237,
      K: 736,
      ERA: 4.19,
      WHIP: 1.19,
      QS: 52,
      "SV+H": 42,
    },
  },
  {
    teamKey: "469.l.62744.t.12",
    rank: 12,
    categories: {
      R: 393,
      H: 779,
      HR: 121,
      RBI: 394,
      SB: 47,
      TB: 1331,
      OBP: 0.333,
      OUT: 1287,
      K: 438,
      ERA: 4.38,
      WHIP: 1.25,
      QS: 25,
      "SV+H": 46,
    },
  },
];

const MY_TEAM_KEY = "469.l.62744.t.12";
const SCORING = new Set<Category>(CATEGORIES);

test("scoreboard marks the rank-12 cats dead last, holds OBP/WHIP, and attacks volume cats", () => {
  const scoreboard = buildSeasonScoreboard(MY_TEAM_KEY, TOTALS, SCORING, "ultra");

  // Factual rank-12 (dead last) set for t.12.
  expect(new Set(scoreboard.deadLast)).toEqual(
    new Set<Category>(["R", "RBI", "SB", "TB", "OUT", "K", "QS", "ERA"]),
  );

  const postureOf = (category: Category) =>
    scoreboard.standings.find((s) => s.category === category)?.posture;
  // Ratio cats are held, not chased.
  expect(postureOf("OBP")).toBe("hold");
  expect(postureOf("WHIP")).toBe("hold");
  // Volume cats are always attacked in ultra mode (more starts add directly).
  for (const category of ["OUT", "K", "QS"] as const) {
    expect(postureOf(category)).toBe("attack");
    expect(scoreboard.attack).toContain(category);
  }

  // Every scoring cat appears exactly once, worst rank first.
  expect(scoreboard.standings).toHaveLength(CATEGORIES.length);
  expect(scoreboard.standings[0]?.myRank).toBe(12);
  expect(scoreboard.headline).toContain("OUT");
});

test("SB is punt in normal but stays attack in ultra (next spot is one steal away)", () => {
  const normal = buildSeasonScoreboard(MY_TEAM_KEY, TOTALS, SCORING, "normal");
  const ultra = buildSeasonScoreboard(MY_TEAM_KEY, TOTALS, SCORING, "ultra");

  const sbNormal = normal.standings.find((s) => s.category === "SB");
  const sbUltra = ultra.standings.find((s) => s.category === "SB");

  // Normal punts the far-from-median dead-last cat.
  expect(sbNormal?.posture).toBe("punt");
  expect(normal.punt).toContain("SB");

  // Ultra never punts SB — the team one rank up is only 1 SB ahead (48 vs 47), so it's "catchable".
  expect(sbUltra?.posture).toBe("attack");
  expect(ultra.punt).not.toContain("SB");
});

// ---- Waiver targets ----

const norm = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();

const value = (name: string, per: Partial<Record<Category, number>>): PlayerValue => {
  const perCategory = Object.fromEntries(CATEGORIES.map((c) => [c, per[c] ?? 0])) as Record<
    Category,
    number
  >;
  const total = CATEGORIES.reduce((sum, c) => sum + perCategory[c], 0);
  return { name, team: "TM", total, perCategory };
};

const buildIndex = (players: ReadonlyArray<PlayerValue>) =>
  new Map(players.map((p) => [norm(p.name), p]));

test("buildWaiverTargets filters IL*/NA, ranks pitchers as innings sources, and flags fragility", () => {
  const valueIndex = buildIndex([
    value("Patrick Corbin", { OUT: 2.4, K: 1.8, QS: 1.2, ERA: -0.3, WHIP: -0.2 }),
    value("Miles Mikolas", { OUT: 2.1, K: 1.5, QS: 1.4, ERA: -0.1, WHIP: -0.1 }),
    value("Drew Pomeranz", { OUT: 1.2, K: 1.1, QS: 0.4, "SV+H": 0.9 }),
    value("Justin Verlander", { OUT: 5, K: 4, QS: 3 }), // filtered by IL60
    value("Yu Darvish", { OUT: 4.5, K: 3.5, QS: 2.5 }), // filtered by NA
    value("Emilio Pagan", { "SV+H": 3.2, K: 0.3 }), // role-dependent (concentrated in SV+H)
  ]);

  const available: ReadonlyArray<AvailablePlayer> = [
    { name: "Patrick Corbin", team: "ARI", eligiblePositions: ["SP"] },
    { name: "Miles Mikolas", team: "STL", eligiblePositions: ["SP"] },
    { name: "Drew Pomeranz", team: "WSH", eligiblePositions: ["RP", "SP"] },
    { name: "Justin Verlander", team: "HOU", eligiblePositions: ["SP"], status: "IL60" },
    { name: "Yu Darvish", team: "SD", eligiblePositions: ["SP"], status: "NA" },
    { name: "Emilio Pagan", team: "CIN", eligiblePositions: ["RP"] },
    { name: "Ghost Player", team: "FA", eligiblePositions: ["OF"] }, // absent from valueIndex
  ];

  const targets = buildWaiverTargets(
    available,
    valueIndex,
    new Set<Category>(["OUT", "K", "QS", "SV+H"]),
    { aggression: "ultra" },
  );

  const names = targets.map((t) => t.name);
  // IL/NA filtered, no-projection player skipped.
  expect(names).not.toContain("Justin Verlander");
  expect(names).not.toContain("Yu Darvish");
  expect(names).not.toContain("Ghost Player");
  // Innings sources surface and lead (volume/pitching first).
  expect(names.slice(0, 3)).toEqual(
    expect.arrayContaining(["Patrick Corbin", "Miles Mikolas", "Drew Pomeranz"]),
  );
  expect(names[0]).toBe("Patrick Corbin");

  const corbin = targets.find((t) => t.name === "Patrick Corbin")!;
  expect(corbin.isPitcher).toBe(true);
  expect(corbin.note).toContain("innings/QS source");
  expect(corbin.forCategories).toEqual(expect.arrayContaining(["OUT", "K", "QS"]));

  // Pagán is a concentrated SV+H source → fragility note.
  const pagan = targets.find((t) => t.name === "Emilio Pagan")!;
  expect(pagan.concentration).toBeGreaterThanOrEqual(0.6);
  expect(pagan.note).toContain("role-dependent");
});

test("a player surfacing for multiple cats is deduped with forCategories unioned", () => {
  const valueIndex = buildIndex([
    value("Drew Pomeranz", { OUT: 1.2, K: 1.1, QS: 0.4, "SV+H": 0.9 }),
  ]);
  const available: ReadonlyArray<AvailablePlayer> = [
    { name: "Drew Pomeranz", team: "WSH", eligiblePositions: ["RP", "SP"] },
  ];

  const targets = buildWaiverTargets(
    available,
    valueIndex,
    new Set<Category>(["OUT", "K", "QS", "SV+H"]),
    { aggression: "ultra" },
  );

  // Appears once even though he qualifies for both the volume group and SV+H.
  expect(targets).toHaveLength(1);
  expect(targets[0]?.forCategories).toEqual(expect.arrayContaining(["OUT", "K", "QS", "SV+H"]));
});
