// Pure (no Effect, no I/O) season-strategic layer for the daily brief:
//   1. buildSeasonScoreboard — my roster's rank + gap-to-median per scoring cat, with an
//      attack/hold/punt posture. Ultra mode punts the fewest cats (team is in last).
//   2. buildWaiverTargets — best-available players ranked WITHIN my attack categories, surfaced
//      independently of the TransactionPlanner "manager bar" (so the brief never goes silent).
//
// Reuses the SGP valuation vocabulary from TradeEval.ts (import, don't duplicate). ERA/WHIP are the
// only lower-is-better categories.
import { type Category, CATEGORIES, lookupValue, type PlayerValue } from "./TradeEval.ts";

// Higher-is-better orientation per category. ERA/WHIP are lower-is-better (a smaller value ranks
// better); every other scoring cat, including OUT, is higher-is-better.
export const LOWER_IS_BETTER: ReadonlySet<Category> = new Set<Category>(["ERA", "WHIP"]);

// Ratio cats are coin-flips you don't cheaply stream to fix over a season, so they're held (never
// force-attacked, never punted) regardless of rank.
const RATIO_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["OBP", "ERA", "WHIP"]);

// Volume cats add directly with more starts/innings, so ultra mode always attacks them.
const VOLUME_CATEGORIES: ReadonlySet<Category> = new Set<Category>(["OUT", "K", "QS"]);

export type TeamCategoryTotals = {
  readonly teamKey: string;
  readonly rank: number;
  readonly categories: Readonly<Record<string, number>>;
};

export type Posture = "attack" | "hold" | "punt";

export type CategoryStanding = {
  readonly category: Category;
  readonly myValue: number;
  readonly myRank: number; // 1 = best in league
  readonly teamCount: number;
  readonly medianValue: number;
  readonly bestValue: number;
  readonly nextCatchableGap: number; // oriented so + = ahead of the team one rank above me
  readonly gapToMedian: number; // oriented so + = better than the league median
  readonly posture: Posture;
};

export type SeasonScoreboard = {
  readonly standings: ReadonlyArray<CategoryStanding>; // all scoring cats, worst rank first
  readonly deadLast: ReadonlyArray<Category>;
  readonly attack: ReadonlyArray<Category>;
  readonly punt: ReadonlyArray<Category>;
  readonly headline: string;
};

const orient = (category: Category, value: number) =>
  LOWER_IS_BETTER.has(category) ? -value : value;

const median = (values: ReadonlyArray<number>) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
};

// Typical spacing between consecutive ranks in a category (median of adjacent oriented-value gaps).
// Falls back to the full-range-per-team spread when the median gap is degenerate (e.g. many ties).
const rankSpacing = (orientedDesc: ReadonlyArray<number>) => {
  if (orientedDesc.length < 2) return 1;
  const gaps: Array<number> = [];
  for (let i = 1; i < orientedDesc.length; i += 1) {
    gaps.push(orientedDesc[i - 1]! - orientedDesc[i]!);
  }
  const medianGap = median(gaps);
  if (medianGap > 0) return medianGap;
  const range = orientedDesc[0]! - orientedDesc[orientedDesc.length - 1]!;
  const fallback = range / (orientedDesc.length - 1);
  return fallback > 0 ? fallback : 1;
};

// Match a snapshot team key (`mlb.l.<id>.t.<id>`) against a standings key (`469.l.<id>.t.<id>`):
// the game-code prefix differs, so compare from the shared `.l.` segment onward.
const leagueSuffix = (teamKey: string) => {
  const index = teamKey.indexOf(".l.");
  return index < 0 ? teamKey : teamKey.slice(index);
};

const sameTeam = (a: string, b: string) => a === b || leagueSuffix(a) === leagueSuffix(b);

const emptyScoreboard = (headline: string): SeasonScoreboard => ({
  standings: [],
  deadLast: [],
  attack: [],
  punt: [],
  headline,
});

export const buildSeasonScoreboard = (
  myTeamKey: string,
  totals: ReadonlyArray<TeamCategoryTotals>,
  scoringCategories: ReadonlySet<Category>,
  aggression: "normal" | "ultra",
): SeasonScoreboard => {
  const mine = totals.find((team) => sameTeam(team.teamKey, myTeamKey));
  if (mine == null) return emptyScoreboard("Season standings unavailable.");

  const categories = CATEGORIES.filter((category) => scoringCategories.has(category));
  const standings: Array<CategoryStanding> = [];

  for (const category of categories) {
    const myValue = mine.categories[category];
    if (myValue == null) continue;
    const raw = totals.flatMap((team) => {
      const value = team.categories[category];
      return value == null ? [] : [value];
    });
    if (raw.length === 0) continue;

    const teamCount = raw.length;
    const orientedMine = orient(category, myValue);
    const orientedDesc = raw.map((value) => orient(category, value)).sort((a, b) => b - a);
    const strictlyAbove = orientedDesc.filter((value) => value > orientedMine).length;
    const myRank = strictlyAbove + 1;
    const spacing = rankSpacing(orientedDesc);

    const aboveValues = orientedDesc.filter((value) => value > orientedMine);
    const aboveOriented = aboveValues.length > 0 ? Math.min(...aboveValues) : undefined;
    const nextCatchableGap = aboveOriented == null ? 0 : orientedMine - aboveOriented;

    const medianRaw = median(raw);
    const gapToMedian = orientedMine - orient(category, medianRaw);
    const bestOriented = orientedDesc[0]!;
    const bestValue = LOWER_IS_BETTER.has(category) ? -bestOriented : bestOriented;

    const isDeadLast = myRank === teamCount;
    const catchable = aboveOriented != null && Math.abs(nextCatchableGap) <= spacing;
    const structuralNext = aboveOriented != null && Math.abs(nextCatchableGap) >= 1.5 * spacing;
    const structuralMedian = Math.abs(gapToMedian) >= 1.5 * spacing && gapToMedian < 0;

    let posture: Posture;
    if (RATIO_CATEGORIES.has(category)) {
      posture = "hold";
    } else if (aggression === "ultra") {
      if (VOLUME_CATEGORIES.has(category)) posture = "attack";
      else if (myRank === 1) posture = "hold";
      else if (catchable) posture = "attack";
      else if (isDeadLast && structuralNext) posture = "punt";
      else posture = "hold";
    } else {
      if (isDeadLast && structuralMedian) posture = "punt";
      else if (!isDeadLast && catchable) posture = "attack";
      else posture = "hold";
    }

    standings.push({
      category,
      myValue,
      myRank,
      teamCount,
      medianValue: medianRaw,
      bestValue,
      nextCatchableGap,
      gapToMedian,
      posture,
    });
  }

  // Worst rank first; break ties by the biggest deficit (most negative gapToMedian) so the volume
  // holes headline the section.
  const sorted = [...standings].sort(
    (a, b) => b.myRank - a.myRank || a.gapToMedian - b.gapToMedian,
  );
  const deadLast = categories.filter((category) =>
    standings.some((s) => s.category === category && s.myRank === s.teamCount),
  );
  const attack = categories.filter((category) =>
    standings.some((s) => s.category === category && s.posture === "attack"),
  );
  const punt = categories.filter((category) =>
    standings.some((s) => s.category === category && s.posture === "punt"),
  );

  return {
    standings: sorted,
    deadLast,
    attack,
    punt,
    headline: buildHeadline(attack, punt),
  };
};

const buildHeadline = (attack: ReadonlyArray<Category>, punt: ReadonlyArray<Category>): string => {
  const volumeAttack = attack.filter((category) => VOLUME_CATEGORIES.has(category));
  const puntText = punt.length > 0 ? punt.join("/") : "nothing";
  if (volumeAttack.length > 0) {
    return `Last in ${volumeAttack.join("/")} — you throw far fewer innings than the league. Pile up starts. Punt only ${puntText}.`;
  }
  if (attack.length > 0) {
    return `Attack ${attack.slice(0, 3).join("/")} where a spot is catchable. Punt only ${puntText}.`;
  }
  return `No clear attack lane; hold ratios and protect what you have. Punt only ${puntText}.`;
};

// ---------------------------------------------------------------------------------------------
// Waiver targets by need
// ---------------------------------------------------------------------------------------------

export type AvailablePlayer = {
  readonly name: string;
  readonly team: string;
  readonly eligiblePositions: ReadonlyArray<string>;
  readonly status?: string; // Yahoo status; "IL*", "NA", "DTD", undefined
};

export type WaiverTarget = {
  readonly name: string;
  readonly team: string;
  readonly positions: ReadonlyArray<string>;
  readonly forCategories: ReadonlyArray<Category>;
  readonly perCategory: Partial<Record<Category, number>>;
  readonly isPitcher: boolean;
  readonly concentration: number; // share of |total| from the single largest category
  readonly note: string;
};

const PITCHER_POSITIONS = new Set(["SP", "RP", "P"]);

const isPitcherPositions = (positions: ReadonlyArray<string>) =>
  positions.some((position) => PITCHER_POSITIONS.has(position)) &&
  !positions.some((position) => !PITCHER_POSITIONS.has(position) && position !== "Util");

// A player is not startable this week if their Yahoo status begins with "IL" or is exactly "NA".
const isUnstartable = (status: string | undefined) =>
  status != null && (status.startsWith("IL") || status === "NA");

const concentrationOf = (value: PlayerValue): { share: number; topCategory: Category } => {
  let top: Category = CATEGORIES[0];
  let topAbs = 0;
  let sumAbs = 0;
  for (const category of CATEGORIES) {
    const abs = Math.abs(value.perCategory[category]);
    sumAbs += abs;
    if (abs > topAbs) {
      topAbs = abs;
      top = category;
    }
  }
  return { share: sumAbs === 0 ? 0 : topAbs / sumAbs, topCategory: top };
};

type Working = {
  readonly available: AvailablePlayer;
  readonly value: PlayerValue;
  readonly isPitcher: boolean;
  readonly concentration: number;
  readonly topCategory: Category;
  readonly ratioDrag: number; // ERA+WHIP per-cat contribution: + helps ratios, - hurts them
  readonly forCategories: Set<Category>;
  readonly sources: Array<string>;
  volumeScore: number;
  bestScore: number;
};

export const buildWaiverTargets = (
  available: ReadonlyArray<AvailablePlayer>,
  valueIndex: ReadonlyMap<string, PlayerValue>,
  attackCategories: ReadonlySet<Category>,
  opts: { readonly aggression: "normal" | "ultra"; readonly perCategoryLimit?: number },
): ReadonlyArray<WaiverTarget> => {
  const volumeLimit = opts.perCategoryLimit ?? 3;
  const categoryLimit = opts.perCategoryLimit ?? 2;

  // Resolve each startable available player to its projected value; skip anyone Yahoo marks
  // unstartable (IL*/NA) or who has no projection.
  const pool = new Map<string, Working>();
  for (const player of available) {
    if (isUnstartable(player.status)) continue;
    const value = lookupValue(valueIndex, player.name);
    if (value == null) continue;
    const { share, topCategory } = concentrationOf(value);
    pool.set(player.name, {
      available: player,
      value,
      isPitcher: isPitcherPositions(player.eligiblePositions),
      concentration: share,
      topCategory,
      ratioDrag: value.perCategory.ERA + value.perCategory.WHIP,
      forCategories: new Set<Category>(),
      sources: [],
      volumeScore: 0,
      bestScore: 0,
    });
  }

  const entries = [...pool.values()];
  const selected = new Set<Working>();

  const volumeCats = ([...VOLUME_CATEGORIES] as ReadonlyArray<Category>).filter((category) =>
    attackCategories.has(category),
  );
  if (volumeCats.length > 0) {
    const ranked = entries
      // Only starters supply bulk innings/QS — a pure reliever with a token OUT/K value is not an
      // "innings source" and shouldn't be labeled one; relievers surface via the SV+H cat below.
      .filter((entry) => entry.available.eligiblePositions.includes("SP"))
      .map((entry) => {
        const volume = volumeCats.reduce(
          (sum, category) => sum + entry.value.perCategory[category],
          0,
        );
        // Penalize (never reward) ratio damage so a clean-ratio arm outranks a ratio-killer of
        // equal volume — the Corbin/Mikolas trap: big innings that torch ERA/WHIP.
        return { entry, volume, rankScore: volume + Math.min(0, entry.ratioDrag) };
      })
      .filter((row) => row.volume > 0)
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, volumeLimit);
    for (const { entry, rankScore } of ranked) {
      for (const category of volumeCats) entry.forCategories.add(category);
      entry.volumeScore = rankScore;
      entry.bestScore = Math.max(entry.bestScore, rankScore);
      if (!entry.sources.includes("innings/QS source")) entry.sources.push("innings/QS source");
      selected.add(entry);
    }
  }

  const nonVolumeCats = ([...attackCategories] as ReadonlyArray<Category>).filter(
    (category) => !VOLUME_CATEGORIES.has(category),
  );
  for (const category of nonVolumeCats) {
    const ranked = entries
      .map((entry) => ({ entry, score: entry.value.perCategory[category] }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, categoryLimit);
    for (const { entry, score } of ranked) {
      entry.forCategories.add(category);
      entry.bestScore = Math.max(entry.bestScore, score);
      const source = `${category} source`;
      if (!entry.sources.includes(source)) entry.sources.push(source);
      selected.add(entry);
    }
  }

  const targets = [...selected].map((entry) => finalizeTarget(entry));

  // Volume/pitching sources first (the biggest deficit), then everyone else by their best per-cat
  // value. Cap at 8.
  return targets
    .sort((a, b) => {
      const aVolume = a.volumeScore > 0 ? 1 : 0;
      const bVolume = b.volumeScore > 0 ? 1 : 0;
      if (aVolume !== bVolume) return bVolume - aVolume;
      if (aVolume === 1) return b.volumeScore - a.volumeScore;
      return b.bestScore - a.bestScore;
    })
    .slice(0, 8)
    .map(({ volumeScore: _volumeScore, bestScore: _bestScore, ...target }) => target);
};

type FinalizedTarget = WaiverTarget & { readonly volumeScore: number; readonly bestScore: number };

const finalizeTarget = (entry: Working): FinalizedTarget => {
  const forCategories = CATEGORIES.filter((category) => entry.forCategories.has(category));
  const perCategory: Partial<Record<Category, number>> = {};
  for (const category of forCategories) {
    perCategory[category] = Number(entry.value.perCategory[category].toFixed(3));
  }
  const notes = [...entry.sources];
  // Ratio-killer / ratio-helper flag: the Corbin/Mikolas warning the manual analysis surfaced —
  // an arm can lead in innings yet quietly torch ERA/WHIP, so never recommend one silently.
  if (entry.isPitcher && entry.ratioDrag <= -0.75) {
    notes.push(`ratio risk: hurts ERA/WHIP (${entry.ratioDrag.toFixed(1)})`);
  } else if (entry.isPitcher && entry.ratioDrag >= 0.5) {
    notes.push("helps ERA/WHIP");
  }
  if (entry.concentration >= 0.6) {
    notes.push(
      `role-dependent: ${Math.round(entry.concentration * 100)}% from ${entry.topCategory}`,
    );
  }
  if (entry.available.status === "DTD") notes.push("verify health");
  return {
    name: entry.available.name,
    team: entry.available.team,
    positions: entry.available.eligiblePositions,
    forCategories,
    perCategory,
    isPitcher: entry.isPitcher,
    concentration: Number(entry.concentration.toFixed(3)),
    note: notes.join(" · "),
    volumeScore: entry.volumeScore,
    bestScore: entry.bestScore,
  };
};
