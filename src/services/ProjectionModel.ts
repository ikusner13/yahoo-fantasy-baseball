import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const AVG_GAMES_PER_WEEK = 6.2;
const AVG_PA_PER_STARTED_GAME = 4.2;
const DEFAULT_ROS_TEAM_GAMES = 162;
const LEAGUE_AVG_IMPLIED_RUNS = 4.5;
const MIN_OPENER_IP = 1;

export class ProjectionModelError extends Data.TaggedError("ProjectionModelError")<{
  readonly message: string;
  readonly playerKey?: string;
}> {}

export class ProjectionSourceWeight extends Schema.Class<ProjectionSourceWeight>(
  "ProjectionSourceWeight",
)({
  source: Schema.String,
  weight: Schema.Finite,
}) {}

export class WeeklySchedule extends Schema.Class<WeeklySchedule>("WeeklySchedule")({
  team: Schema.String,
  gamesThisWeek: Schema.Finite,
  gamesRemaining: Schema.Finite,
}) {}

export class DailyGameWindow extends Schema.Class<DailyGameWindow>("DailyGameWindow")({
  date: Schema.String,
  games: Schema.Finite,
  remainingGames: Schema.Finite,
  firstGameTime: Schema.optional(Schema.String),
  lastGameTime: Schema.optional(Schema.String),
}) {}

export class ProbablePitcherStart extends Schema.Class<ProbablePitcherStart>(
  "ProbablePitcherStart",
)({
  playerKey: Schema.String,
  playerName: Schema.String,
  team: Schema.String,
  opponentTeam: Schema.String,
  date: Schema.String,
  gameTime: Schema.optional(Schema.String),
  homeAway: Schema.Union([Schema.Literal("home"), Schema.Literal("away")]),
}) {}

export class StatcastPlayerContext extends Schema.Class<StatcastPlayerContext>(
  "StatcastPlayerContext",
)({
  xwoba: Schema.optional(Schema.Finite),
  barrelPct: Schema.optional(Schema.Finite),
  hardHitPct: Schema.optional(Schema.Finite),
  whiffPct: Schema.optional(Schema.Finite),
  kPct: Schema.optional(Schema.Finite),
  sprintSpeed: Schema.optional(Schema.Finite),
}) {}

export class ParkFactorContext extends Schema.Class<ParkFactorContext>("ParkFactorContext")({
  runsFactor: Schema.Finite,
  hrFactor: Schema.Finite,
}) {}

export class BattingOrderContext extends Schema.Class<BattingOrderContext>("BattingOrderContext")({
  confirmedStarts: Schema.Finite,
  battingOrderSum: Schema.Finite,
}) {}

export class WeeklyContext extends Schema.Class<WeeklyContext>("WeeklyContext")({
  schedules: Schema.Array(WeeklySchedule),
  dailyGameWindows: Schema.optional(Schema.Array(DailyGameWindow)),
  probableStartsByPlayerKey: Schema.Record(Schema.String, Schema.Finite),
  probablePitcherStarts: Schema.optional(Schema.Array(ProbablePitcherStart)),
  impliedRunsByTeam: Schema.Record(Schema.String, Schema.Finite),
  statcastByPlayerKey: Schema.optional(Schema.Record(Schema.String, StatcastPlayerContext)),
  parkFactorsByTeam: Schema.optional(Schema.Record(Schema.String, ParkFactorContext)),
  confirmedLineupsByTeam: Schema.optional(Schema.Record(Schema.String, Schema.Finite)),
  battingOrdersByPlayerKey: Schema.optional(Schema.Record(Schema.String, BattingOrderContext)),
}) {}

export class BatterProjectionSource extends Schema.Class<BatterProjectionSource>(
  "BatterProjectionSource",
)({
  source: Schema.String,
  playerKey: Schema.String,
  mlbId: Schema.optional(Schema.Finite),
  name: Schema.String,
  team: Schema.String,
  pa: Schema.Finite,
  r: Schema.Finite,
  h: Schema.Finite,
  hr: Schema.Finite,
  rbi: Schema.Finite,
  sb: Schema.Finite,
  tb: Schema.Finite,
  obp: Schema.Finite,
  ab: Schema.optional(Schema.Finite),
  bb: Schema.optional(Schema.Finite),
  hbp: Schema.optional(Schema.Finite),
  sf: Schema.optional(Schema.Finite),
  eligiblePositions: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class PitcherProjectionSource extends Schema.Class<PitcherProjectionSource>(
  "PitcherProjectionSource",
)({
  source: Schema.String,
  playerKey: Schema.String,
  mlbId: Schema.optional(Schema.Finite),
  name: Schema.String,
  team: Schema.String,
  ip: Schema.Finite,
  gs: Schema.Finite,
  k: Schema.Finite,
  era: Schema.Finite,
  whip: Schema.Finite,
  qs: Schema.Finite,
  svh: Schema.Finite,
  appearances: Schema.optional(Schema.Finite),
  eligiblePositions: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class BlendedBatterProjection extends Schema.Class<BlendedBatterProjection>(
  "BlendedBatterProjection",
)({
  kind: Schema.Literal("batter"),
  playerKey: Schema.String,
  mlbId: Schema.optional(Schema.Finite),
  name: Schema.String,
  team: Schema.String,
  pa: Schema.Finite,
  r: Schema.Finite,
  h: Schema.Finite,
  hr: Schema.Finite,
  rbi: Schema.Finite,
  sb: Schema.Finite,
  tb: Schema.Finite,
  obp: Schema.Finite,
  ab: Schema.Finite,
  bb: Schema.Finite,
  hbp: Schema.Finite,
  sf: Schema.Finite,
  eligiblePositions: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class BlendedPitcherProjection extends Schema.Class<BlendedPitcherProjection>(
  "BlendedPitcherProjection",
)({
  kind: Schema.Literal("pitcher"),
  playerKey: Schema.String,
  mlbId: Schema.optional(Schema.Finite),
  name: Schema.String,
  team: Schema.String,
  ip: Schema.Finite,
  gs: Schema.Finite,
  k: Schema.Finite,
  era: Schema.Finite,
  whip: Schema.Finite,
  qs: Schema.Finite,
  svh: Schema.Finite,
  appearances: Schema.Finite,
  eligiblePositions: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class WeeklyBatterLine extends Schema.Class<WeeklyBatterLine>("WeeklyBatterLine")({
  kind: Schema.Literal("batter"),
  playerKey: Schema.String,
  name: Schema.String,
  team: Schema.String,
  pa: Schema.Finite,
  r: Schema.Finite,
  h: Schema.Finite,
  hr: Schema.Finite,
  rbi: Schema.Finite,
  sb: Schema.Finite,
  tb: Schema.Finite,
  obpNumerator: Schema.Finite,
  obpDenominator: Schema.Finite,
  obp: Schema.Finite,
  eligiblePositions: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class WeeklyPitcherLine extends Schema.Class<WeeklyPitcherLine>("WeeklyPitcherLine")({
  kind: Schema.Literal("pitcher"),
  playerKey: Schema.String,
  name: Schema.String,
  team: Schema.String,
  ip: Schema.Finite,
  out: Schema.Finite,
  k: Schema.Finite,
  er: Schema.Finite,
  baserunners: Schema.Finite,
  era: Schema.Finite,
  whip: Schema.Finite,
  qs: Schema.Finite,
  svh: Schema.Finite,
  expectedStarts: Schema.optional(Schema.Finite),
  eligiblePositions: Schema.optional(Schema.Array(Schema.String)),
}) {}

export class ProjectionPool extends Schema.Class<ProjectionPool>("ProjectionPool")({
  myRoster: Schema.Array(Schema.String),
  opponentRoster: Schema.Array(Schema.String),
  freeAgents: Schema.Array(Schema.String),
  batters: Schema.Array(BatterProjectionSource),
  pitchers: Schema.Array(PitcherProjectionSource),
}) {}

export class WeeklyProjectionSet extends Schema.Class<WeeklyProjectionSet>("WeeklyProjectionSet")({
  myRoster: Schema.Array(Schema.Union([WeeklyBatterLine, WeeklyPitcherLine])),
  opponentRoster: Schema.Array(Schema.Union([WeeklyBatterLine, WeeklyPitcherLine])),
  freeAgents: Schema.Array(Schema.Union([WeeklyBatterLine, WeeklyPitcherLine])),
  schedules: Schema.optional(Schema.Array(WeeklySchedule)),
  dailyGameWindows: Schema.optional(Schema.Array(DailyGameWindow)),
  probablePitcherStarts: Schema.optional(Schema.Array(ProbablePitcherStart)),
}) {}

type WeightedRows<A extends { source: string }> = ReadonlyArray<A>;
type Line = WeeklyBatterLine | WeeklyPitcherLine;

const defaultBatterWeights = [
  new ProjectionSourceWeight({ source: "rthebatx", weight: 0.4 }),
  new ProjectionSourceWeight({ source: "steamerr", weight: 0.25 }),
  new ProjectionSourceWeight({ source: "ratcdc", weight: 0.25 }),
  new ProjectionSourceWeight({ source: "zipsdc", weight: 0.1 }),
] as const;

const defaultPitcherWeights = [
  new ProjectionSourceWeight({ source: "ratcdc", weight: 0.4 }),
  new ProjectionSourceWeight({ source: "steamerr", weight: 0.25 }),
  new ProjectionSourceWeight({ source: "zipsdc", weight: 0.2 }),
  new ProjectionSourceWeight({ source: "rthebatx", weight: 0.15 }),
] as const;

const indexWeights = (weights: ReadonlyArray<ProjectionSourceWeight>) =>
  new Map(weights.map((weight) => [weight.source, weight.weight]));

const weightedMean = <A extends { source: string }>(
  rows: WeightedRows<A>,
  weights: Map<string, number>,
  select: (row: A) => number,
) => {
  let total = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const weight = weights.get(row.source) ?? 0;
    if (weight <= 0) continue;
    total += select(row) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? total / totalWeight : 0;
};

const groupByPlayer = <A extends { playerKey: string }>(rows: ReadonlyArray<A>) => {
  const grouped = new Map<string, Array<A>>();
  for (const row of rows) {
    const group = grouped.get(row.playerKey) ?? [];
    group.push(row);
    grouped.set(row.playerKey, group);
  }
  return grouped;
};

const safeDivide = (numerator: number, denominator: number) =>
  denominator > 0 ? numerator / denominator : 0;

const inferObpComponents = (row: BatterProjectionSource) => {
  const hbp = row.hbp ?? 0;
  const sf = row.sf ?? Math.max(0, row.pa * 0.006);
  const bb =
    row.bb ?? Math.max(0, (row.obp * (row.pa + sf) - row.h - hbp) / Math.max(0.001, 1 - row.obp));
  const ab = row.ab ?? Math.max(0, row.pa - bb - hbp - sf);
  return { ab, bb, hbp, sf };
};

const vegasMultiplier = (impliedRuns: number | undefined) => {
  if (impliedRuns == null) return 1;
  return Math.max(0.75, Math.min(1.3, impliedRuns / LEAGUE_AVG_IMPLIED_RUNS));
};

const boundedMultiplier = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const batterStatcastMultiplier = (
  skill: StatcastPlayerContext | undefined,
  stat: "contact" | "power" | "speed",
) => {
  if (skill == null) return 1;
  let multiplier = 1;
  if (skill.xwoba != null) {
    if (skill.xwoba >= 0.36) multiplier += 0.05;
    if (skill.xwoba <= 0.29) multiplier -= 0.05;
  }
  if (stat === "power") {
    if (skill.barrelPct != null && skill.barrelPct >= 12) multiplier += 0.08;
    if (skill.barrelPct != null && skill.barrelPct <= 5) multiplier -= 0.05;
    if (skill.hardHitPct != null && skill.hardHitPct >= 45) multiplier += 0.04;
  }
  if (stat === "speed" && skill.sprintSpeed != null) {
    if (skill.sprintSpeed >= 28.5) multiplier += 0.06;
    if (skill.sprintSpeed <= 26) multiplier -= 0.04;
  }
  return boundedMultiplier(multiplier, 0.85, 1.15);
};

const pitcherStatcastContext = (skill: StatcastPlayerContext | undefined) => {
  if (skill == null) return { runPrevention: 1, strikeouts: 1 };
  let runPrevention = 1;
  let strikeouts = 1;
  if (skill.xwoba != null) {
    if (skill.xwoba <= 0.285) runPrevention -= 0.06;
    if (skill.xwoba >= 0.34) runPrevention += 0.08;
  }
  if (skill.barrelPct != null && skill.barrelPct >= 10) runPrevention += 0.04;
  if (skill.whiffPct != null && skill.whiffPct >= 28) strikeouts += 0.06;
  if (skill.kPct != null && skill.kPct >= 26) strikeouts += 0.05;
  if (skill.kPct != null && skill.kPct <= 18) strikeouts -= 0.06;
  return {
    runPrevention: boundedMultiplier(runPrevention, 0.86, 1.16),
    strikeouts: boundedMultiplier(strikeouts, 0.88, 1.14),
  };
};

const contextKey = (projection: { readonly playerKey: string; readonly mlbId?: number }) =>
  projection.mlbId == null ? projection.playerKey : `mlb:${projection.mlbId}`;

const battingOrderPa = (order: number) => {
  if (order <= 0) return AVG_PA_PER_STARTED_GAME;
  return boundedMultiplier(4.9 - (order - 1) * 0.18, 3.4, 4.9);
};

const expectedBatterPa = (projection: BlendedBatterProjection, context: WeeklyContext) => {
  const games = remainingGames(projection.team, context);
  const confirmedLineups = Math.min(context.confirmedLineupsByTeam?.[projection.team] ?? 0, games);
  const orderContext = context.battingOrdersByPlayerKey?.[contextKey(projection)];
  if (confirmedLineups <= 0 || orderContext == null) return games * AVG_PA_PER_STARTED_GAME;
  const confirmedStarts = Math.min(orderContext.confirmedStarts, confirmedLineups);
  const averageOrder =
    confirmedStarts > 0 ? orderContext.battingOrderSum / confirmedStarts : Number.POSITIVE_INFINITY;
  const confirmedPa = confirmedStarts * battingOrderPa(averageOrder);
  const unknownGames = Math.max(0, games - confirmedLineups);
  return confirmedPa + unknownGames * AVG_PA_PER_STARTED_GAME;
};

const remainingGames = (team: string, context: WeeklyContext) => {
  const schedule = context.schedules.find((entry) => entry.team === team);
  return schedule?.gamesRemaining ?? schedule?.gamesThisWeek ?? AVG_GAMES_PER_WEEK;
};

export const blendBatterProjections = (
  rows: ReadonlyArray<BatterProjectionSource>,
  weights: ReadonlyArray<ProjectionSourceWeight> = defaultBatterWeights,
) => {
  const weightIndex = indexWeights(weights);
  return [...groupByPlayer(rows).values()].map((group) => {
    const first = group[0] as BatterProjectionSource;
    const componentRows = group.map((row) => {
      const components = inferObpComponents(row);
      return {
        source: row.source,
        ...components,
      };
    });
    return new BlendedBatterProjection({
      kind: "batter",
      playerKey: first.playerKey,
      mlbId: first.mlbId,
      name: first.name,
      team: first.team,
      pa: weightedMean(group, weightIndex, (row) => row.pa),
      r: weightedMean(group, weightIndex, (row) => row.r),
      h: weightedMean(group, weightIndex, (row) => row.h),
      hr: weightedMean(group, weightIndex, (row) => row.hr),
      rbi: weightedMean(group, weightIndex, (row) => row.rbi),
      sb: weightedMean(group, weightIndex, (row) => row.sb),
      tb: weightedMean(group, weightIndex, (row) => row.tb),
      obp: weightedMean(group, weightIndex, (row) => row.obp),
      ab: weightedMean(componentRows, weightIndex, (row) => row.ab),
      bb: weightedMean(componentRows, weightIndex, (row) => row.bb),
      hbp: weightedMean(componentRows, weightIndex, (row) => row.hbp),
      sf: weightedMean(componentRows, weightIndex, (row) => row.sf),
      eligiblePositions: first.eligiblePositions == null ? undefined : [...first.eligiblePositions],
    });
  });
};

export const blendPitcherProjections = (
  rows: ReadonlyArray<PitcherProjectionSource>,
  weights: ReadonlyArray<ProjectionSourceWeight> = defaultPitcherWeights,
) => {
  const weightIndex = indexWeights(weights);
  return [...groupByPlayer(rows).values()].map((group) => {
    const first = group[0] as PitcherProjectionSource;
    return new BlendedPitcherProjection({
      kind: "pitcher",
      playerKey: first.playerKey,
      mlbId: first.mlbId,
      name: first.name,
      team: first.team,
      ip: weightedMean(group, weightIndex, (row) => row.ip),
      gs: weightedMean(group, weightIndex, (row) => row.gs),
      k: weightedMean(group, weightIndex, (row) => row.k),
      era: weightedMean(group, weightIndex, (row) => row.era),
      whip: weightedMean(group, weightIndex, (row) => row.whip),
      qs: weightedMean(group, weightIndex, (row) => row.qs),
      svh: weightedMean(group, weightIndex, (row) => row.svh),
      appearances: weightedMean(group, weightIndex, (row) => row.appearances ?? row.gs),
      eligiblePositions: first.eligiblePositions == null ? undefined : [...first.eligiblePositions],
    });
  });
};

export const prorateBatterProjection = (
  projection: BlendedBatterProjection,
  context: WeeklyContext,
) => {
  const pa =
    expectedBatterPa(projection, context) *
    vegasMultiplier(context.impliedRunsByTeam[projection.team]);
  const scale = safeDivide(pa, projection.pa);
  const statcast = context.statcastByPlayerKey?.[contextKey(projection)];
  const park = context.parkFactorsByTeam?.[projection.team];
  const contactMultiplier = batterStatcastMultiplier(statcast, "contact");
  const powerMultiplier = batterStatcastMultiplier(statcast, "power") * (park?.hrFactor ?? 1);
  const speedMultiplier = batterStatcastMultiplier(statcast, "speed");
  const runEnvironmentMultiplier = park?.runsFactor ?? 1;
  const obpNumerator = (projection.h + projection.bb + projection.hbp) * scale;
  const obpDenominator = (projection.ab + projection.bb + projection.hbp + projection.sf) * scale;

  return new WeeklyBatterLine({
    kind: "batter",
    playerKey: projection.playerKey,
    name: projection.name,
    team: projection.team,
    pa,
    r: projection.r * scale * contactMultiplier * runEnvironmentMultiplier,
    h: projection.h * scale * contactMultiplier,
    hr: projection.hr * scale * powerMultiplier,
    rbi: projection.rbi * scale * contactMultiplier * runEnvironmentMultiplier,
    sb: projection.sb * scale * speedMultiplier,
    tb: projection.tb * scale * powerMultiplier,
    obpNumerator: obpNumerator * contactMultiplier,
    obpDenominator,
    obp: safeDivide(obpNumerator * contactMultiplier, obpDenominator),
    eligiblePositions:
      projection.eligiblePositions == null ? undefined : [...projection.eligiblePositions],
  });
};

export const proratePitcherProjection = (
  projection: BlendedPitcherProjection,
  context: WeeklyContext,
) => {
  const starts = context.probableStartsByPlayerKey[projection.playerKey] ?? 0;
  const startScale = safeDivide(starts, projection.gs);
  const reliefAppearances =
    safeDivide(projection.appearances, DEFAULT_ROS_TEAM_GAMES) *
    remainingGames(projection.team, context);
  const reliefScale = safeDivide(reliefAppearances, projection.appearances);
  const scale = projection.gs > 0 ? startScale : reliefScale;
  const openerIp =
    starts > 0 && projection.gs <= 0
      ? Math.max(MIN_OPENER_IP, safeDivide(projection.ip, projection.appearances)) * starts
      : 0;
  const ip = Math.max(projection.ip * scale, openerIp);
  const statcast = context.statcastByPlayerKey?.[contextKey(projection)];
  const park = context.parkFactorsByTeam?.[projection.team];
  const skill = pitcherStatcastContext(statcast);
  const runFactor = skill.runPrevention * (park?.runsFactor ?? 1);
  const er = (projection.era * ip * runFactor) / 9;
  const baserunners = projection.whip * ip * runFactor;

  return new WeeklyPitcherLine({
    kind: "pitcher",
    playerKey: projection.playerKey,
    name: projection.name,
    team: projection.team,
    ip,
    out: ip * 3,
    k:
      projection.gs <= 0 && starts > 0
        ? safeDivide(projection.k, projection.ip) * ip * skill.strikeouts
        : projection.k * scale * skill.strikeouts,
    er,
    baserunners,
    era: ip > 0 ? (er * 9) / ip : 0,
    whip: safeDivide(baserunners, ip),
    qs: projection.qs * scale,
    svh: projection.svh * reliefScale,
    expectedStarts: starts,
    eligiblePositions:
      projection.eligiblePositions == null ? undefined : [...projection.eligiblePositions],
  });
};

export const buildWeeklyProjectionSet = (pool: ProjectionPool, context: WeeklyContext) => {
  const linesByPlayer = new Map<string, Line>();
  for (const projection of blendBatterProjections(pool.batters)) {
    linesByPlayer.set(projection.playerKey, prorateBatterProjection(projection, context));
  }
  for (const projection of blendPitcherProjections(pool.pitchers)) {
    linesByPlayer.set(projection.playerKey, proratePitcherProjection(projection, context));
  }

  const collect = (playerKeys: ReadonlyArray<string>) =>
    playerKeys
      .map((playerKey) => linesByPlayer.get(playerKey))
      .filter((line): line is Line => line != null);

  return new WeeklyProjectionSet({
    myRoster: collect(pool.myRoster),
    opponentRoster: collect(pool.opponentRoster),
    freeAgents: collect(pool.freeAgents),
    schedules: context.schedules,
    dailyGameWindows: context.dailyGameWindows,
    probablePitcherStarts: context.probablePitcherStarts,
  });
};

export class ProjectionModel extends Context.Service<
  ProjectionModel,
  {
    readonly weeklyLines: (
      pool: ProjectionPool,
      context: WeeklyContext,
    ) => Effect.Effect<WeeklyProjectionSet, ProjectionModelError>;
  }
>()("fantasy-gm/ProjectionModel") {
  static readonly layerLive = Layer.succeed(
    ProjectionModel,
    ProjectionModel.of({
      weeklyLines: (pool, context) => Effect.succeed(buildWeeklyProjectionSet(pool, context)),
    }),
  );
}
