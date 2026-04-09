import type {
  Roster,
  RosterEntry,
  Player,
  LineupMove,
  Matchup,
  PlayerProjection,
  PitcherStats,
  Category,
  ScheduledGame,
} from "../types";
import { ROSTER_SLOTS, BATTING_POSITIONS, BATTING_CATEGORIES, PITCHING_CATEGORIES } from "../types";
import { getRateStats, getPitcherRateStats } from "./valuations";
import { adjustScoreForRecency, type RecentPerformance } from "./recent-performance";
import type { BvPStats, ParkFactor, PlatoonSplit } from "../data/matchup-data";

// --- Local types ---

type CategoryWeights = Record<Category, number>;

// --- Marginal rate impact ---

export type RateStatState = "won" | "swing" | "lost";

export interface MarginalRateImpact {
  eraImpact: number; // change to team ERA if this pitcher starts (negative = improves)
  whipImpact: number; // change to team WHIP
  netRateValue: number; // combined value considering matchup state
}

export interface TeamRateContext {
  teamCurrentER: number; // accumulated earned runs this week
  teamCurrentIP: number; // accumulated innings pitched this week
  teamCurrentWhipNum: number; // accumulated (H + BB) this week
  eraState: RateStatState;
  whipState: RateStatState;
}

/**
 * Compute the marginal impact of starting a pitcher on team rate stats.
 * Returns the change to team ERA/WHIP and a net value score that accounts
 * for matchup state (won/swing/lost).
 */
export function computeMarginalRateImpact(
  pitcherProjection: PitcherStats,
  teamCurrentER: number,
  teamCurrentIP: number,
  teamCurrentWhipNum: number,
  matchupState: { eraState: RateStatState; whipState: RateStatState },
): MarginalRateImpact {
  const projIP = pitcherProjection.ip;
  // Derive projected earned runs and WHIP numerator from pitcher's rate stats
  const projER = (pitcherProjection.era * projIP) / 9;
  const projWhipNum = pitcherProjection.whip * projIP;

  // Current team rates (handle 0 IP — treat as undefined baseline)
  const currentERA = teamCurrentIP > 0 ? (9 * teamCurrentER) / teamCurrentIP : 0;
  const currentWHIP = teamCurrentIP > 0 ? teamCurrentWhipNum / teamCurrentIP : 0;

  // New team rates after adding this pitcher's projected outing
  const newIP = teamCurrentIP + projIP;
  const newERA = newIP > 0 ? (9 * (teamCurrentER + projER)) / newIP : 0;
  const newWHIP = newIP > 0 ? (teamCurrentWhipNum + projWhipNum) / newIP : 0;

  const eraImpact = newERA - currentERA;
  const whipImpact = newWHIP - currentWHIP;

  // Net value: weight each impact by matchup state
  // "won" → heavily penalize increases (protect the lead), reward decreases mildly
  // "swing" → full cost/benefit
  // "lost" → zero cost (already conceded)
  const eraValue = applyStateWeight(eraImpact, matchupState.eraState);
  const whipValue = applyStateWeight(whipImpact, matchupState.whipState);

  // Both ERA and WHIP are inverse stats — negative impact is good.
  // Negate so positive netRateValue = beneficial to start.
  const netRateValue = -(eraValue + whipValue) || 0; // normalize -0

  return { eraImpact, whipImpact, netRateValue };
}

/**
 * Apply matchup-state weighting to a rate stat impact.
 * Positive impact = stat gets worse; negative = improves.
 */
function applyStateWeight(impact: number, state: RateStatState): number {
  switch (state) {
    case "won":
      // Protect lead: heavily penalize worsening (3x), mild reward for improving
      return impact > 0 ? impact * 3.0 : impact * 0.5;
    case "swing":
      return impact;
    case "lost":
      // Already conceded — no cost or benefit
      return 0;
  }
}

// --- Scoring context ---

export interface ScoringContext {
  matchupWeights?: CategoryWeights;
  zScore?: number;
  bvp?: BvPStats;
  platoon?: PlatoonSplit;
  parkFactor?: ParkFactor;
  streak?: RecentPerformance;
  opposingPitcherHand?: "L" | "R";
  vegasMultiplier?: number;
  /** Pitcher-only: team rate stat context for marginal impact scoring */
  teamRateContext?: TeamRateContext;
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
      // Swing category — close race, prioritize heavily
      weights[cs.category] = 2.0;
    } else if (cs.myValue < cs.opponentValue && ratio > 0.25) {
      // Lost cause — conceded, don't waste roster spots chasing
      weights[cs.category] = 0;
    }
    // else keep 1.0 (safe lead or modest gap)
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

  // Use z-score as base when available — properly ranks players by quality
  // Z-scores can be negative (below-average), so shift to positive range for multiplier math
  let baseScore: number;

  if (context?.zScore != null) {
    // Shift z-score so the worst starter is still positive (multipliers are multiplicative)
    // Typical z-scores range from -3 to +5; shifting by 4 puts them in [1, 9] range
    baseScore = context.zScore + 4;
  } else {
    // Fallback: sum per-PA rates (less accurate, but works without valuations)
    const weights = context?.matchupWeights ?? defaultWeights();
    baseScore = 0;

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
        if (cat === "ERA" || cat === "WHIP") {
          baseScore -= val * w;
        } else {
          baseScore += val * w;
        }
      }
    }
  }

  // --- Contextual multipliers ---
  const bvpMult = computeBvpMultiplier(context?.bvp);
  const platoonMult = computePlatoonMultiplier(context?.platoon, context?.opposingPitcherHand);
  const parkMult = computeParkMultiplier(context?.parkFactor, isBatter);
  const vegasMult = computeVegasMultiplierForPlayer(context?.vegasMultiplier, isBatter);
  let adjusted = baseScore * bvpMult * platoonMult * parkMult * vegasMult;

  // --- Marginal rate impact for pitchers ---
  // Additive: shifts score based on how this pitcher affects team ERA/WHIP given matchup state
  if (!isBatter && projection.pitching && context?.teamRateContext) {
    const rc = context.teamRateContext;
    const impact = computeMarginalRateImpact(
      projection.pitching,
      rc.teamCurrentER,
      rc.teamCurrentIP,
      rc.teamCurrentWhipNum,
      { eraState: rc.eraState, whipState: rc.whipState },
    );
    adjusted += impact.netRateValue;
  }

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

function expandSlots(slotOrder: readonly string[]): string[] {
  return slotOrder.flatMap((slot) => Array.from({ length: ROSTER_SLOTS[slot] ?? 0 }, () => slot));
}

function assignOptimalSlots(
  scoredPlayers: Array<{ entry: RosterEntry; score: number }>,
  slots: string[],
  games: ScheduledGame[],
): { moves: LineupMove[]; assignedIds: Set<string> } {
  if (slots.length === 0 || scoredPlayers.length === 0) {
    return { moves: [], assignedIds: new Set() };
  }

  const memo = new Map<string, { total: number; picks: Array<number | null> }>();

  function slotBonus(slot: string, player: Player): number {
    if (slot === "SP" && isProbableStarter(player, games)) return 0.05;
    return 0;
  }

  function solve(slotIndex: number, usedMask: number): { total: number; picks: Array<number | null> } {
    if (slotIndex >= slots.length) return { total: 0, picks: [] };
    const key = `${slotIndex}:${usedMask}`;
    const cached = memo.get(key);
    if (cached) return cached;

    let best: { total: number; picks: Array<number | null> } = { total: -Infinity, picks: [] };
    const slot = slots[slotIndex]!;
    let foundCandidate = false;

    for (let candidateIndex = 0; candidateIndex < scoredPlayers.length; candidateIndex++) {
      const bit = 1 << candidateIndex;
      if ((usedMask & bit) !== 0) continue;

      const candidate = scoredPlayers[candidateIndex]!;
      if (!isEligible(candidate.entry.player, slot)) continue;
      foundCandidate = true;

      const next = solve(slotIndex + 1, usedMask | bit);
      const total = candidate.score + slotBonus(slot, candidate.entry.player) + next.total;
      if (total > best.total) {
        best = { total, picks: [candidateIndex, ...next.picks] };
      }
    }

    if (!foundCandidate) {
      const next = solve(slotIndex + 1, usedMask);
      best = { total: next.total, picks: [null, ...next.picks] };
    }

    memo.set(key, best);
    return best;
  }

  const solved = solve(0, 0);
  const moves: LineupMove[] = [];
  const assignedIds = new Set<string>();

  for (let slotIndex = 0; slotIndex < solved.picks.length; slotIndex++) {
    const candidateIndex = solved.picks[slotIndex];
    if (candidateIndex == null) continue;
    const candidate = scoredPlayers[candidateIndex];
    if (!candidate) continue;
    moves.push({ playerId: candidate.entry.player.yahooId, position: slots[slotIndex]! });
    assignedIds.add(candidate.entry.player.yahooId);
  }

  return { moves, assignedIds };
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

  // Sort by score descending before exact assignment to keep tie-breaking stable.
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

  const batterAssignment = assignOptimalSlots(batters, expandSlots(BATTING_SLOT_ORDER), games);
  for (const move of batterAssignment.moves) {
    moves.push(move);
    assigned.add(move.playerId);
  }

  const pitcherAssignment = assignOptimalSlots(pitchers, expandSlots(PITCHING_SLOT_ORDER), games);
  for (const move of pitcherAssignment.moves) {
    moves.push(move);
    assigned.add(move.playerId);
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
