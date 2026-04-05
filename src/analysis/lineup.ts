import type {
  Roster,
  RosterEntry,
  Player,
  LineupMove,
  Matchup,
  PlayerProjection,
  Category,
  ScheduledGame,
} from "../types";
import { ROSTER_SLOTS, BATTING_POSITIONS, BATTING_CATEGORIES, PITCHING_CATEGORIES } from "../types";
import { getRateStats, getPitcherRateStats } from "./valuations";
import { adjustScoreForRecency, type RecentPerformance } from "./recent-performance";
import type { BvPStats, ParkFactor, PlatoonSplit } from "../data/matchup-data";

// --- Local types ---

type CategoryWeights = Record<Category, number>;

// --- Scoring context ---

export interface ScoringContext {
  matchupWeights?: CategoryWeights;
  bvp?: BvPStats;
  platoon?: PlatoonSplit;
  parkFactor?: ParkFactor;
  streak?: RecentPerformance;
  opposingPitcherHand?: "L" | "R";
  vegasMultiplier?: number;
}

// League-average OBP used as baseline for BvP adjustment
const LEAGUE_AVG_OBP = 0.31;

// --- Category weight computation ---

export function getCategoryWeights(matchup?: Matchup): Record<string, number> {
  const allCats = [
    ...(BATTING_CATEGORIES as readonly string[]),
    ...(PITCHING_CATEGORIES as readonly string[]),
  ];
  const weights: Record<string, number> = {};
  for (const cat of allCats) weights[cat] = 1.0;

  if (!matchup || matchup.categories.length === 0) return weights;

  for (const cs of matchup.categories) {
    const total = Math.abs(cs.myValue) + Math.abs(cs.opponentValue) || 1;
    const diff = Math.abs(cs.myValue - cs.opponentValue);
    const ratio = diff / total;

    if (ratio < 0.1) {
      // Swing category -- close race
      weights[cs.category] = 1.5;
    } else if (cs.myValue < cs.opponentValue && ratio > 0.25) {
      // Lost cause -- way behind
      weights[cs.category] = 0.5;
    }
    // else keep 1.0
  }

  return weights;
}

// --- Player scoring for today ---

export function scorePlayerForToday(
  player: Player,
  projection: PlayerProjection | undefined,
  hasGameToday: boolean,
  context?: ScoringContext,
): number {
  if (!hasGameToday) return 0;
  if (!projection) return 0.1; // warm body > empty slot

  const isBatter = projection.playerType === "batter";
  const weights = context?.matchupWeights ?? defaultWeights();

  let baseScore = 0;

  if (isBatter && projection.batting) {
    const rates = getRateStats(projection.batting);
    for (const cat of BATTING_CATEGORIES as readonly string[]) {
      const w = weights[cat as Category] ?? 1.0;
      baseScore += (rates[cat] ?? 0) * w;
    }
  } else if (!isBatter && projection.pitching) {
    const rates = getPitcherRateStats(projection.pitching);
    for (const cat of PITCHING_CATEGORIES as readonly string[]) {
      const w = weights[cat as Category] ?? 1.0;
      const val = rates[cat] ?? 0;
      // For inverse categories lower is better, so subtract from score
      if (cat === "ERA" || cat === "WHIP") {
        baseScore -= val * w;
      } else {
        baseScore += val * w;
      }
    }
  }

  // --- Contextual multipliers ---
  const bvpMult = computeBvpMultiplier(context?.bvp);
  const platoonMult = computePlatoonMultiplier(context?.platoon, context?.opposingPitcherHand);
  const parkMult = computeParkMultiplier(context?.parkFactor, isBatter);
  const vegasMult = computeVegasMultiplierForPlayer(context?.vegasMultiplier, isBatter);
  const adjusted = baseScore * bvpMult * platoonMult * parkMult * vegasMult;

  // Streak adjustment (already built in recent-performance module)
  return adjustScoreForRecency(adjusted, context?.streak, 0.15);
}

function defaultWeights(): CategoryWeights {
  const w = {} as CategoryWeights;
  for (const cat of BATTING_CATEGORIES) w[cat] = 1.0;
  for (const cat of PITCHING_CATEGORIES) w[cat] = 1.0;
  return w;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * BvP adjustment: career stats vs today's opposing pitcher.
 * Gated at 10 PA minimum — below that sample is too noisy.
 * Max 20% swing clamped to [0.80, 1.20].
 */
function computeBvpMultiplier(bvp: BvPStats | undefined): number {
  if (!bvp || bvp.pa < 10) return 1.0;
  const raw = 1.0 + ((bvp.obp - LEAGUE_AVG_OBP) / LEAGUE_AVG_OBP) * 0.2;
  return clamp(raw, 0.8, 1.2);
}

/**
 * Platoon adjustment based on batter's L/R split advantage vs opposing pitcher hand.
 * Clamped to [0.90, 1.10].
 */
function computePlatoonMultiplier(
  platoon: PlatoonSplit | undefined,
  opposingHand: "L" | "R" | undefined,
): number {
  if (!platoon || !opposingHand || platoon.advantage === "neutral") return 1.0;
  // Batter has advantage when their advantage hand matches the opposing pitcher's hand
  // e.g. advantage === "R" means batter hits better vs RHP; if pitcher is R, boost
  const hasAdvantage = platoon.advantage === opposingHand;
  const raw = hasAdvantage ? 1.0 + platoon.advantageSize * 0.1 : 1.0 - platoon.advantageSize * 0.1;
  return clamp(raw, 0.9, 1.1);
}

/**
 * Park factor adjustment.
 * Batters: boosted in hitter-friendly parks (runsFactor > 1).
 * Pitchers: inverse — pitcher-friendly parks (runsFactor < 1) help.
 * Clamped to [0.85, 1.15].
 */
function computeParkMultiplier(parkFactor: ParkFactor | undefined, isBatter: boolean): number {
  if (!parkFactor) return 1.0;
  const raw = isBatter ? parkFactor.runsFactor : 1.0 / parkFactor.runsFactor;
  return clamp(raw, 0.85, 1.15);
}

/**
 * Vegas implied runs adjustment.
 * Batters: high implied runs = good (offense expected to produce).
 * Pitchers: INVERT — high implied runs for opponent = bad for your pitcher.
 * Batter pass-through clamped in computeVegasMultiplier; pitcher inverse clamped to [0.80, 1.25].
 */
function computeVegasMultiplierForPlayer(vegasMult: number | undefined, isBatter: boolean): number {
  if (vegasMult == null) return 1.0;
  if (isBatter) return vegasMult;
  // Pitcher: invert — high team total means bad for opposing pitcher
  const inverted = 1.0 / vegasMult;
  return clamp(inverted, 0.8, 1.25);
}

// --- Helpers ---

/** Check if a player's team has a game today */
function teamPlaysToday(team: string, games: ScheduledGame[]): boolean {
  return games.some((g) => (g.homeTeam === team || g.awayTeam === team) && g.status !== "final");
}

/** Is the player a probable starter today? */
function isProbableStarter(player: Player, games: ScheduledGame[]): boolean {
  if (!player.mlbId) return false;
  return games.some(
    (g) => g.homeProbable?.mlbId === player.mlbId || g.awayProbable?.mlbId === player.mlbId,
  );
}

/** Greedy slot assignment order: scarce positions first */
const BATTING_SLOT_ORDER = ["C", "SS", "2B", "3B", "1B", "OF", "Util"] as const;
const PITCHING_SLOT_ORDER = ["SP", "RP", "P"] as const;

function isEligible(player: Player, slot: string): boolean {
  // Util accepts any batter
  if (slot === "Util") {
    return player.positions.some((p) => (BATTING_POSITIONS as readonly string[]).includes(p));
  }
  // P accepts any pitcher
  if (slot === "P") {
    return player.positions.includes("SP") || player.positions.includes("RP");
  }
  return player.positions.includes(slot);
}

// --- Core optimizer ---

export function optimizeLineup(
  roster: Roster,
  projections: Map<string, PlayerProjection>,
  games: ScheduledGame[],
  matchup?: Matchup,
  streaks?: Map<number, RecentPerformance>,
  contextMap?: Map<string, ScoringContext>,
): LineupMove[] {
  const catWeights = getCategoryWeights(matchup) as CategoryWeights;

  // Score every player with full context (BvP, platoon, park, streak)
  const scored: Array<{ entry: RosterEntry; score: number }> = roster.entries.map((entry) => {
    const proj = projections.get(entry.player.yahooId);
    const hasGame = teamPlaysToday(entry.player.team, games);

    // Build per-player context: merge contextMap entry with category weights & streak
    const playerCtx: ScoringContext = {
      ...contextMap?.get(entry.player.yahooId),
      matchupWeights: catWeights,
    };
    // Inject streak from legacy streaks map if not already in context
    if (!playerCtx.streak && streaks && entry.player.mlbId) {
      playerCtx.streak = streaks.get(entry.player.mlbId);
    }

    const score = scorePlayerForToday(entry.player, proj, hasGame, playerCtx);
    return { entry, score };
  });

  // Separate IL players
  const ilPlayers = scored.filter(
    (s) => s.entry.player.status === "IL" || s.entry.player.status === "OUT",
  );
  const activePlayers = scored.filter(
    (s) => s.entry.player.status !== "IL" && s.entry.player.status !== "OUT",
  );

  // Split active into batters and pitchers
  const batters = activePlayers.filter((s) => {
    const proj = projections.get(s.entry.player.yahooId);
    return !proj || proj.playerType === "batter";
  });
  const pitchers = activePlayers.filter((s) => {
    const proj = projections.get(s.entry.player.yahooId);
    return proj?.playerType === "pitcher";
  });

  // Sort by score descending for greedy assignment
  batters.sort((a, b) => b.score - a.score);
  pitchers.sort((a, b) => {
    // Probable starters get priority for SP slots
    const aStarter = isProbableStarter(a.entry.player, games) ? 1 : 0;
    const bStarter = isProbableStarter(b.entry.player, games) ? 1 : 0;
    if (aStarter !== bStarter) return bStarter - aStarter;
    return b.score - a.score;
  });

  const moves: LineupMove[] = [];
  const assigned = new Set<string>(); // yahooIds already placed

  // Assign batters greedily by slot scarcity
  for (const slot of BATTING_SLOT_ORDER) {
    const count = ROSTER_SLOTS[slot] ?? 0;
    let filled = 0;
    for (const s of batters) {
      if (filled >= count) break;
      if (assigned.has(s.entry.player.yahooId)) continue;
      if (!isEligible(s.entry.player, slot)) continue;
      // Only start players with a game (score > 0) unless no choice
      if (s.score === 0 && filled < count) {
        // defer bench candidates, but fill if we must
        continue;
      }
      moves.push({ playerId: s.entry.player.yahooId, position: slot });
      assigned.add(s.entry.player.yahooId);
      filled++;
    }
    // Backfill with zero-score players if slots remain
    if (filled < count) {
      for (const s of batters) {
        if (filled >= count) break;
        if (assigned.has(s.entry.player.yahooId)) continue;
        if (!isEligible(s.entry.player, slot)) continue;
        moves.push({ playerId: s.entry.player.yahooId, position: slot });
        assigned.add(s.entry.player.yahooId);
        filled++;
      }
    }
  }

  // Assign pitchers greedily
  for (const slot of PITCHING_SLOT_ORDER) {
    const count = ROSTER_SLOTS[slot] ?? 0;
    let filled = 0;
    for (const s of pitchers) {
      if (filled >= count) break;
      if (assigned.has(s.entry.player.yahooId)) continue;
      if (!isEligible(s.entry.player, slot)) continue;
      if (s.score === 0) continue; // skip pitchers w/o game for active slots
      moves.push({ playerId: s.entry.player.yahooId, position: slot });
      assigned.add(s.entry.player.yahooId);
      filled++;
    }
    // Backfill
    if (filled < count) {
      for (const s of pitchers) {
        if (filled >= count) break;
        if (assigned.has(s.entry.player.yahooId)) continue;
        if (!isEligible(s.entry.player, slot)) continue;
        moves.push({ playerId: s.entry.player.yahooId, position: slot });
        assigned.add(s.entry.player.yahooId);
        filled++;
      }
    }
  }

  // IL slots
  const ilCount = ROSTER_SLOTS["IL"] ?? 0;
  let ilFilled = 0;
  for (const s of ilPlayers) {
    if (ilFilled >= ilCount) break;
    moves.push({ playerId: s.entry.player.yahooId, position: "IL" });
    assigned.add(s.entry.player.yahooId);
    ilFilled++;
  }

  // BN: everyone not yet assigned
  for (const s of [...batters, ...pitchers, ...ilPlayers]) {
    if (assigned.has(s.entry.player.yahooId)) continue;
    moves.push({ playerId: s.entry.player.yahooId, position: "BN" });
    assigned.add(s.entry.player.yahooId);
  }

  return moves;
}
