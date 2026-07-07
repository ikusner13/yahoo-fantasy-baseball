// Pure (no Effect, no I/O) rest-of-season trade valuation + counter-swap search.
//
// Valuation reimplements the season-SGP formula from DecisionEngine.ts's `categorySgpValue` /
// `seasonSgp` (module-private there), adapted for a single blended rest-of-season projection
// line (no weekly proration) with a flat weight of 1.0 per category (matchup-agnostic — this is
// a standing trade-value tool, not a scout of this week's opponent). See
// src/services/DecisionEngine.ts:746-769 for the source formula this mirrors.
import type { BlendedBatterProjection, BlendedPitcherProjection } from "./ProjectionModel.ts";

export const CATEGORIES = [
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
] as const;

export type Category = (typeof CATEGORIES)[number];

// Mirrors DecisionEngine.ts's SGP_DENOMINATORS fallback table (module-private there).
export const DEFAULT_SGP_DENOMINATORS: Record<Category, number> = {
  R: 35,
  H: 45,
  HR: 12,
  RBI: 35,
  SB: 10,
  TB: 75,
  OBP: 0.01,
  OUT: 120,
  K: 55,
  ERA: 0.12,
  WHIP: 0.035,
  QS: 6,
  "SV+H": 10,
};

// Mirrors DecisionEngine.ts:34-38.
const LEAGUE_AVG_OBP = 0.32;
const TEAM_SEASON_OBP_DENOMINATOR = 6500;
const LEAGUE_AVG_ERA = 4.1;
const LEAGUE_AVG_WHIP = 1.28;
const TEAM_SEASON_IP = 1400;

export type PlayerValue = {
  readonly name: string;
  readonly team: string;
  readonly total: number;
  readonly perCategory: Record<Category, number>;
};

const emptyPerCategory = (): Record<Category, number> =>
  Object.fromEntries(CATEGORIES.map((category) => [category, 0])) as Record<Category, number>;

const sumPerCategory = (perCategory: Record<Category, number>) =>
  CATEGORIES.reduce((sum, category) => sum + perCategory[category], 0);

export const valueBatter = (
  blended: BlendedBatterProjection,
  denominators: Record<Category, number>,
  scoringCategories: ReadonlySet<Category>,
): PlayerValue => {
  const perCategory = emptyPerCategory();
  if (scoringCategories.has("R")) perCategory.R = blended.r / denominators.R;
  if (scoringCategories.has("H")) perCategory.H = blended.h / denominators.H;
  if (scoringCategories.has("HR")) perCategory.HR = blended.hr / denominators.HR;
  if (scoringCategories.has("RBI")) perCategory.RBI = blended.rbi / denominators.RBI;
  if (scoringCategories.has("SB")) perCategory.SB = blended.sb / denominators.SB;
  if (scoringCategories.has("TB")) perCategory.TB = blended.tb / denominators.TB;
  if (scoringCategories.has("OBP")) {
    // DecisionEngine.ts:755-758 — impact scales the OBP gap by this player's own share of a
    // full team-season OBP denominator (ab+bb+hbp+sf), not by TEAM_SEASON_OBP_DENOMINATOR itself.
    const obpDenominator = blended.ab + blended.bb + blended.hbp + blended.sf;
    const impact = ((blended.obp - LEAGUE_AVG_OBP) * obpDenominator) / TEAM_SEASON_OBP_DENOMINATOR;
    perCategory.OBP = impact / denominators.OBP;
  }
  return {
    name: blended.name,
    team: blended.team,
    total: sumPerCategory(perCategory),
    perCategory,
  };
};

export const valuePitcher = (
  blended: BlendedPitcherProjection,
  denominators: Record<Category, number>,
  scoringCategories: ReadonlySet<Category>,
): PlayerValue => {
  const perCategory = emptyPerCategory();
  if (scoringCategories.has("OUT")) perCategory.OUT = (blended.ip * 3) / denominators.OUT;
  if (scoringCategories.has("K")) perCategory.K = blended.k / denominators.K;
  if (scoringCategories.has("QS")) perCategory.QS = blended.qs / denominators.QS;
  if (scoringCategories.has("SV+H")) perCategory["SV+H"] = blended.svh / denominators["SV+H"];
  if (scoringCategories.has("ERA")) {
    // DecisionEngine.ts:760-763
    const impact = ((LEAGUE_AVG_ERA - blended.era) * blended.ip) / TEAM_SEASON_IP;
    perCategory.ERA = impact / denominators.ERA;
  }
  if (scoringCategories.has("WHIP")) {
    // DecisionEngine.ts:764-767
    const impact = ((LEAGUE_AVG_WHIP - blended.whip) * blended.ip) / TEAM_SEASON_IP;
    perCategory.WHIP = impact / denominators.WHIP;
  }
  return {
    name: blended.name,
    team: blended.team,
    total: sumPerCategory(perCategory),
    perCategory,
  };
};

// Mirrors WeeklyProjections.ts:43-48 exactly, so trade-eval name matching agrees with the rest
// of the identity-matching pipeline.
const normalizeName = (name: string) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();

export const buildValueIndex = (
  blendedBatters: ReadonlyArray<BlendedBatterProjection>,
  blendedPitchers: ReadonlyArray<BlendedPitcherProjection>,
  denominators: Record<Category, number>,
  scoringCategories: ReadonlySet<Category>,
): Map<string, PlayerValue> => {
  const index = new Map<string, PlayerValue>();
  for (const pitcher of blendedPitchers) {
    index.set(normalizeName(pitcher.name), valuePitcher(pitcher, denominators, scoringCategories));
  }
  // Two-way players (e.g. Ohtani) appear in both pools keyed by the same normalized name —
  // batters win, since the common case is a position player who never shows up in the pitcher
  // pool at all, and this keeps the dedupe rule simple and deterministic.
  for (const batter of blendedBatters) {
    index.set(normalizeName(batter.name), valueBatter(batter, denominators, scoringCategories));
  }
  return index;
};

export const lookupValue = (
  index: ReadonlyMap<string, PlayerValue>,
  playerName: string,
): PlayerValue | undefined => index.get(normalizeName(playerName));

export type CounterOption = {
  readonly send: ReadonlyArray<PlayerValue>;
  readonly receive: ReadonlyArray<PlayerValue>;
  readonly myNet: number;
  readonly theirNet: number;
  readonly perCategoryDelta: Record<Category, number>;
};

export type FindCountersInput = {
  readonly myPlayers: ReadonlyArray<PlayerValue>;
  readonly theirPlayers: ReadonlyArray<PlayerValue>;
  readonly outgoing: ReadonlyArray<PlayerValue>;
  readonly fairnessBand?: number;
};

const DEFAULT_FAIRNESS_BAND = 1.5;
// Bounds the combinatorics (spec: "cap at 2 players per side") so a large roster doesn't blow up
// the swap search — keep only the most valuable candidates on each side before pairing them up.
const MAX_CANDIDATE_POOL = 20;

const topByAbsTotal = (players: ReadonlyArray<PlayerValue>, limit: number) =>
  [...players].sort((a, b) => Math.abs(b.total) - Math.abs(a.total)).slice(0, limit);

// All singles and pairs from `players` (no 3+ combos — matches the "cap at 2 players per side"
// bound from the spec).
const combinationsUpToTwo = (
  players: ReadonlyArray<PlayerValue>,
): ReadonlyArray<ReadonlyArray<PlayerValue>> => {
  const combos: Array<ReadonlyArray<PlayerValue>> = [];
  for (let i = 0; i < players.length; i += 1) {
    const first = players[i];
    if (first == null) continue;
    combos.push([first]);
    for (let j = i + 1; j < players.length; j += 1) {
      const second = players[j];
      if (second == null) continue;
      combos.push([first, second]);
    }
  }
  return combos;
};

const sumTotal = (players: ReadonlyArray<PlayerValue>) =>
  players.reduce((sum, player) => sum + player.total, 0);

const perCategoryDeltaOf = (
  send: ReadonlyArray<PlayerValue>,
  receive: ReadonlyArray<PlayerValue>,
): Record<Category, number> => {
  const delta = emptyPerCategory();
  for (const category of CATEGORIES) {
    const sent = send.reduce((sum, player) => sum + player.perCategory[category], 0);
    const received = receive.reduce((sum, player) => sum + player.perCategory[category], 0);
    delta[category] = received - sent;
  }
  return delta;
};

// Enumerates candidate swaps around the proposed `outgoing` package: the exact outgoing set
// against every 1-2 player combo from their roster, plus (when outgoing is a single player)
// outgoing-plus-one-more-of-mine against the same receive combos (a bounded 2-for-N variant).
// A candidate is kept as a plausible counter when it is fair-to-favorable for me (myNet >= 0)
// without being so lopsided the other side would obviously refuse it (theirNet >= -fairnessBand,
// i.e. myNet <= fairnessBand since this valuation is zero-sum: theirNet = -myNet).
export const findCounters = ({
  myPlayers,
  theirPlayers,
  outgoing,
  fairnessBand = DEFAULT_FAIRNESS_BAND,
}: FindCountersInput): ReadonlyArray<CounterOption> => {
  const myPool = topByAbsTotal(myPlayers, MAX_CANDIDATE_POOL);
  const theirPool = topByAbsTotal(theirPlayers, MAX_CANDIDATE_POOL);

  const sendSets: Array<ReadonlyArray<PlayerValue>> = [];
  if (outgoing.length > 0) {
    sendSets.push(outgoing);
    if (outgoing.length === 1) {
      const outgoingName = outgoing[0]?.name;
      for (const candidate of myPool) {
        if (candidate.name === outgoingName) continue;
        sendSets.push([...outgoing, candidate]);
      }
    }
  } else {
    sendSets.push(...combinationsUpToTwo(myPool));
  }

  const receiveSets = combinationsUpToTwo(theirPool);

  const candidates: Array<CounterOption> = [];
  for (const send of sendSets) {
    const sendTotal = sumTotal(send);
    for (const receive of receiveSets) {
      const myNet = sumTotal(receive) - sendTotal;
      const theirNet = -myNet;
      if (myNet >= 0 && theirNet >= -fairnessBand) {
        candidates.push({
          send,
          receive,
          myNet,
          theirNet,
          perCategoryDelta: perCategoryDeltaOf(send, receive),
        });
      }
    }
  }

  return candidates
    .sort((a, b) => b.myNet - a.myNet || Math.abs(a.theirNet) - Math.abs(b.theirNet))
    .slice(0, 8);
};
