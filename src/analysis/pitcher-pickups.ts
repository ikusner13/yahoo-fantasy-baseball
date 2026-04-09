import type { Player, PitcherStats, ScheduledGame } from "../types";
import type { DetailedCategoryState } from "./matchup";
import { scoreStreamingPitcher, estimateStreamingImpact, type CategoryImpact } from "./streaming";
import { getTeamSchedule } from "../data/mlb";
import {
  getParkFactor,
  getPitcherHand,
  getBatchTeamBattingStats,
  type TeamBattingStats,
} from "../data/matchup-data";
import { getRotationProjection } from "./two-start";

// --- Interfaces ---

export interface PitcherStartContext {
  date: string;
  opponent: string;
  isHome: boolean;
  parkFactor: number;
  /** Composite opponent quality — higher = tougher lineup */
  opponentStrength: number;
  score: number;
  confidence: "confirmed" | "probable" | "projected";
}

export interface PitcherPickupAnalysis {
  player: Player;
  projection?: PitcherStats;
  starts: PitcherStartContext[];
  totalScore: number;
  avgScorePerStart: number;
  isTwoStart: boolean;
  /** True when pitcher has zero starts before matchup ends */
  noStartsInWindow: boolean;
  matchupImpact?: {
    netCategoriesHelped: number;
    netCategoriesHurt: number;
  };
  reasoning: string;
}

// --- Constants ---

/** Discount applied to projected (non-confirmed) starts */
const CONFIDENCE_MULTIPLIER: Record<string, number> = {
  confirmed: 1.0,
  probable: 0.85,
  projected: 0.65,
};

/** Flat bonus for multi-start pitchers (counting stat volume upside in H2H) */
const MULTI_START_BONUS = 1.5;

const LEAGUE_AVG_K_PCT = 0.22;
const LEAGUE_AVG_WOBA = 0.32;

/** How much opponent K% above/below average adjusts the score */
const K_PCT_WEIGHT = 4.0;

/** How much platoon advantage (pitcher hand vs team weakness) adjusts the score */
const PLATOON_WEIGHT = 2.5;

// --- Pure scoring functions (testable) ---

/**
 * Score a single pitcher start with full context:
 * base streaming score + opponent K tendency + platoon advantage + confidence discount.
 */
export function scoreStart(
  pitcher: { projection?: PitcherStats; team: string },
  game: ScheduledGame,
  context: {
    opponentWoba?: number;
    opponentKPct?: number;
    wobaVsHand?: number;
    parkFactor?: number;
    confidence: "confirmed" | "probable" | "projected";
  },
): number {
  const opponentWoba = context.opponentWoba ?? LEAGUE_AVG_WOBA;
  const parkFactor = context.parkFactor ?? 1.0;

  // Base: existing streaming pitcher score
  const base = scoreStreamingPitcher(pitcher, game, opponentWoba, parkFactor);

  // Opponent K% bonus: strikeout-prone teams boost K upside
  const kPctBonus =
    context.opponentKPct != null ? (context.opponentKPct - LEAGUE_AVG_K_PCT) * K_PCT_WEIGHT : 0;

  // Platoon advantage: pitcher's hand vs opponent's weakness
  const platoonBonus =
    context.wobaVsHand != null ? (LEAGUE_AVG_WOBA - context.wobaVsHand) * PLATOON_WEIGHT : 0;

  const raw = base + kPctBonus + platoonBonus;

  // Discount by confidence level
  const discount = CONFIDENCE_MULTIPLIER[context.confidence] ?? 0.65;
  return raw * discount;
}

/**
 * Aggregate per-start scores into a total pickup score.
 * Multi-start pitchers get a volume bonus on top of the sum.
 */
export function aggregatePickupScore(startScores: number[]): {
  totalScore: number;
  avgScore: number;
  isTwoStart: boolean;
} {
  if (startScores.length === 0) {
    return { totalScore: 0, avgScore: 0, isTwoStart: false };
  }

  const sum = startScores.reduce((a, b) => a + b, 0);
  const isTwoStart = startScores.length >= 2;
  const bonus = isTwoStart ? MULTI_START_BONUS : 0;

  return {
    totalScore: sum + bonus,
    avgScore: sum / startScores.length,
    isTwoStart,
  };
}

/**
 * Compute aggregate matchup impact across all starts.
 */
export function computePickupMatchupImpact(
  projection: PitcherStats,
  categoryStates: DetailedCategoryState[],
  numStarts: number,
): { netCategoriesHelped: number; netCategoriesHurt: number; impacts: CategoryImpact[] } {
  // estimateStreamingImpact works for a single start — apply once
  // (impact compounds linearly for counting stats, rate stat impact is per-start)
  const { impacts, netCategoriesHelped, netCategoriesHurt } = estimateStreamingImpact(
    projection,
    categoryStates,
  );

  // For multi-start: counting stat help is amplified
  if (numStarts >= 2) {
    for (const impact of impacts) {
      if (
        impact.direction === "helps" &&
        impact.magnitude === "medium" &&
        ["K", "OUT", "QS"].includes(impact.category)
      ) {
        impact.magnitude = "high";
      }
    }
  }

  return { netCategoriesHelped, netCategoriesHurt, impacts };
}

/**
 * Build human-readable reasoning for a pitcher pickup recommendation.
 */
export function buildPickupReasoning(analysis: Omit<PitcherPickupAnalysis, "reasoning">): string {
  const parts: string[] = [];

  if (analysis.noStartsInWindow) {
    return `${analysis.player.name} — no confirmed starts before matchup ends. Season-long value only.`;
  }

  const startDescs = analysis.starts.map((s) => {
    const conf = s.confidence === "confirmed" ? "" : ` (${s.confidence})`;
    return `${s.opponent} ${s.date.slice(5)}${conf}`;
  });

  parts.push(
    `${analysis.starts.length} start${analysis.starts.length > 1 ? "s" : ""}: ${startDescs.join(", ")}`,
  );

  if (analysis.isTwoStart) {
    parts.push("2-start week — counting stat volume");
  }

  // Highlight best matchup
  const best = [...analysis.starts].sort((a, b) => b.score - a.score)[0];
  if (best && best.opponentStrength < LEAGUE_AVG_WOBA) {
    parts.push(`best matchup vs ${best.opponent} (weak offense)`);
  }

  if (analysis.matchupImpact) {
    const { netCategoriesHelped, netCategoriesHurt } = analysis.matchupImpact;
    if (netCategoriesHelped > netCategoriesHurt) {
      parts.push(`helps ${netCategoriesHelped} cats`);
    }
  }

  return parts.join(". ") + ".";
}

// --- Schedule resolution ---

interface ResolvedStart {
  game: ScheduledGame;
  opponent: string;
  isHome: boolean;
  confidence: "confirmed" | "probable" | "projected";
}

/**
 * Find a pitcher's starts within a set of games.
 * Checks probable pitcher assignments first, falls back to rotation projection.
 */
export async function findPitcherStarts(
  pitcher: { mlbId?: number; name: string; team: string },
  games: ScheduledGame[],
  windowStart: string,
): Promise<ResolvedStart[]> {
  const starts: ResolvedStart[] = [];
  if (!pitcher.mlbId) return starts;

  // Filter to games involving this pitcher's team
  const teamGames = games.filter((g) => g.homeTeam === pitcher.team || g.awayTeam === pitcher.team);

  // Check confirmed probable pitchers from MLB API
  for (const game of teamGames) {
    const isHome = game.homeTeam === pitcher.team;
    const probable = isHome ? game.homeProbable : game.awayProbable;

    if (probable?.mlbId === pitcher.mlbId) {
      starts.push({
        game,
        opponent: isHome ? game.awayTeam : game.homeTeam,
        isHome,
        confidence: "confirmed",
      });
    }
  }

  if (starts.length > 0) return starts;

  // No confirmed starts — try rotation projection
  const daysAhead =
    teamGames.length > 0
      ? Math.ceil(
          (new Date(teamGames[teamGames.length - 1]!.date + "T12:00:00Z").getTime() -
            new Date(windowStart + "T12:00:00Z").getTime()) /
            86400000,
        ) + 1
      : 7;

  try {
    const projection = await getRotationProjection(pitcher.team, windowStart, daysAhead);

    for (const slot of projection) {
      if (slot.projectedStarter?.mlbId !== pitcher.mlbId) continue;

      const game = teamGames.find((g) => g.date === slot.date);
      if (!game) continue;

      const isHome = game.homeTeam === pitcher.team;
      starts.push({
        game,
        opponent: isHome ? game.awayTeam : game.homeTeam,
        isHome,
        confidence: "projected",
      });
    }
  } catch {
    // Rotation projection failed — no starts found
  }

  return starts;
}

// --- Full pipeline ---

export interface PitcherPickupOptions {
  /** Override opponent wOBA per team (e.g. from Vegas implied runs) */
  opponentWobas?: Map<string, number>;
  /** Override park factors per home team */
  parkFactors?: Map<string, number>;
  /** Matchup category states for matchup-aware scoring */
  categoryStates?: DetailedCategoryState[];
  /** Pre-fetched pitcher hand data */
  pitcherHands?: Map<number, "L" | "R">;
  /** Pre-fetched team batting stats */
  teamBattingStats?: Map<string, TeamBattingStats>;
  /** Pre-fetched schedule for teams (team abbr → games) */
  teamSchedules?: Map<string, ScheduledGame[]>;
}

/**
 * Rank starting pitcher free agents by schedule-aware pickup value.
 *
 * For each candidate:
 *  1. Resolve remaining starts in the matchup window (confirmed + projected)
 *  2. Score each start against opponent quality, park, platoon, confidence
 *  3. Aggregate into total pickup score with volume bonus
 *  4. Flag pitchers with no starts (still returned, sorted last)
 *
 * Returns sorted desc by totalScore.
 */
export async function rankPitcherPickups(
  candidates: Array<{ player: Player; projection?: PitcherStats }>,
  today: string,
  matchupEnd: string,
  options: PitcherPickupOptions = {},
): Promise<PitcherPickupAnalysis[]> {
  // Collect unique teams we need schedules for
  const teamsNeeded = new Set(candidates.map((c) => c.player.team));
  const teamSchedules = options.teamSchedules ?? new Map<string, ScheduledGame[]>();

  // Fetch missing schedules in parallel
  const missingTeams = [...teamsNeeded].filter((t) => !teamSchedules.has(t));
  if (missingTeams.length > 0) {
    const schedResults = await Promise.all(
      missingTeams.map((t) =>
        getTeamSchedule(t, today, matchupEnd).catch(() => [] as ScheduledGame[]),
      ),
    );
    for (let i = 0; i < missingTeams.length; i++) {
      teamSchedules.set(missingTeams[i], schedResults[i]);
    }
  }

  // Collect unique opponents for batting stats
  const allOpponents = new Set<string>();
  for (const games of teamSchedules.values()) {
    for (const g of games) {
      allOpponents.add(g.homeTeam);
      allOpponents.add(g.awayTeam);
    }
  }

  // Fetch team batting stats for opponents (if not provided)
  const teamBatting = options.teamBattingStats ?? new Map<string, TeamBattingStats>();
  const missingBatting = [...allOpponents].filter((t) => !teamBatting.has(t));
  if (missingBatting.length > 0) {
    const batchStats = await getBatchTeamBattingStats(missingBatting);
    for (const [team, stats] of batchStats) {
      teamBatting.set(team, stats);
    }
  }

  // Fetch pitcher hands for platoon analysis (if not provided)
  const pitcherHands = options.pitcherHands ?? new Map<number, "L" | "R">();
  const missingHands = candidates
    .filter((c) => c.player.mlbId && !pitcherHands.has(c.player.mlbId))
    .map((c) => c.player.mlbId!);

  if (missingHands.length > 0) {
    const handResults = await Promise.all(
      missingHands.map((id) => getPitcherHand(id).catch(() => null)),
    );
    for (let i = 0; i < missingHands.length; i++) {
      const hand = handResults[i];
      if (hand) pitcherHands.set(missingHands[i], hand);
    }
  }

  // Score each candidate
  const analyses: PitcherPickupAnalysis[] = [];

  for (const candidate of candidates) {
    const teamGames = teamSchedules.get(candidate.player.team) ?? [];

    // Resolve this pitcher's starts
    const resolvedStarts = await findPitcherStarts(candidate.player, teamGames, today);

    const pitcherHand = candidate.player.mlbId
      ? pitcherHands.get(candidate.player.mlbId)
      : undefined;

    // Score each start
    const startContexts: PitcherStartContext[] = [];
    const startScores: number[] = [];

    for (const rs of resolvedStarts) {
      const homeTeam = rs.isHome ? candidate.player.team : rs.opponent;
      const parkFactor = options.parkFactors?.get(homeTeam) ?? getParkFactor(homeTeam).runsFactor;

      const oppStats = teamBatting.get(rs.opponent);
      const opponentWoba =
        options.opponentWobas?.get(rs.opponent) ?? oppStats?.woba ?? LEAGUE_AVG_WOBA;
      const opponentKPct = oppStats?.kPct;

      // Platoon: use opponent's wOBA against this pitcher's hand
      const wobaVsHand =
        pitcherHand && oppStats
          ? pitcherHand === "L"
            ? oppStats.wobaVsL
            : oppStats.wobaVsR
          : undefined;

      const score = scoreStart(
        { projection: candidate.projection, team: candidate.player.team },
        rs.game,
        {
          opponentWoba,
          opponentKPct,
          wobaVsHand,
          parkFactor,
          confidence: rs.confidence,
        },
      );

      startScores.push(score);
      startContexts.push({
        date: rs.game.date,
        opponent: rs.opponent,
        isHome: rs.isHome,
        parkFactor,
        opponentStrength: opponentWoba,
        score,
        confidence: rs.confidence,
      });
    }

    const { totalScore, avgScore, isTwoStart } = aggregatePickupScore(startScores);
    const noStartsInWindow = resolvedStarts.length === 0;

    // Matchup impact analysis
    let matchupImpact: PitcherPickupAnalysis["matchupImpact"];
    if (candidate.projection && options.categoryStates && !noStartsInWindow) {
      const impact = computePickupMatchupImpact(
        candidate.projection,
        options.categoryStates,
        resolvedStarts.length,
      );
      matchupImpact = {
        netCategoriesHelped: impact.netCategoriesHelped,
        netCategoriesHurt: impact.netCategoriesHurt,
      };
    }

    const partial = {
      player: candidate.player,
      projection: candidate.projection,
      starts: startContexts,
      totalScore,
      avgScorePerStart: avgScore,
      isTwoStart,
      noStartsInWindow,
      matchupImpact,
    };

    analyses.push({
      ...partial,
      reasoning: buildPickupReasoning(partial),
    });
  }

  // Sort: pitchers with starts first (by totalScore desc), then no-start pitchers last
  analyses.sort((a, b) => {
    if (a.noStartsInWindow !== b.noStartsInWindow) {
      return a.noStartsInWindow ? 1 : -1;
    }
    return b.totalScore - a.totalScore;
  });

  return analyses;
}
