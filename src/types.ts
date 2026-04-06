import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "./db/schema";

// --- App config ---

export interface Env {
  db: DrizzleD1Database<typeof schema>;
  KV: KVNamespace;
  YAHOO_CLIENT_ID: string;
  YAHOO_CLIENT_SECRET: string;
  TELEGRAM_BOT_TOKEN: string;
  YAHOO_LEAGUE_ID: string;
  YAHOO_TEAM_ID: string;
  TELEGRAM_CHAT_ID: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ODDS_API_KEY?: string;
}

// --- Roster positions ---

export const BATTING_POSITIONS = ["C", "1B", "2B", "3B", "SS", "OF", "Util"] as const;

export const PITCHING_POSITIONS = ["SP", "RP", "P"] as const;

export const ALL_POSITIONS = [...BATTING_POSITIONS, ...PITCHING_POSITIONS, "BN", "IL"] as const;

export type Position = (typeof ALL_POSITIONS)[number];

// Roster slot layout: position -> count
export const ROSTER_SLOTS: Record<string, number> = {
  C: 1,
  "1B": 1,
  "2B": 1,
  "3B": 1,
  SS: 1,
  OF: 3,
  Util: 2,
  SP: 2,
  RP: 2,
  P: 4,
  BN: 5,
  IL: 4,
};

// --- Category definitions ---

export const BATTING_CATEGORIES = ["R", "H", "HR", "RBI", "SB", "TB", "OBP"] as const;

export const PITCHING_CATEGORIES = [
  "OUT", // outs = IP * 3
  "K",
  "ERA",
  "WHIP",
  "QS",
  "SVHD",
] as const;

// Categories where lower is better
export const INVERSE_CATEGORIES = ["ERA", "WHIP"] as const;

export type BattingCategory = (typeof BATTING_CATEGORIES)[number];
export type PitchingCategory = (typeof PITCHING_CATEGORIES)[number];
export type Category = BattingCategory | PitchingCategory;

// --- Player ---

export interface Player {
  yahooId: string;
  mlbId?: number;
  fangraphsId?: number;
  name: string;
  team: string;
  positions: string[]; // eligible positions
  status?: "healthy" | "IL" | "DTD" | "OUT" | "NA";
  ownership?: number; // % owned in Yahoo
}

export interface BatterStats {
  pa: number;
  r: number;
  h: number;
  hr: number;
  rbi: number;
  sb: number;
  tb: number;
  obp: number;
}

export interface PitcherStats {
  ip: number;
  outs: number; // ip * 3
  k: number;
  era: number;
  whip: number;
  qs: number;
  svhd: number;
}

export interface PlayerProjection {
  yahooId: string;
  playerType: "batter" | "pitcher";
  batting?: BatterStats;
  pitching?: PitcherStats;
  updatedAt: string;
}

// --- Statcast metrics ---

export interface StatcastBatter {
  mlbId: number;
  xwoba: number;
  barrelPct: number;
  hardHitPct: number;
  exitVelo: number;
  kPct?: number;
  sprintSpeed?: number;
}

export interface StatcastPitcher {
  mlbId: number;
  xwoba: number; // xwOBA against
  whiffPct: number;
  barrelPctAgainst: number;
  kPct: number;
}

// --- Roster ---

export interface RosterEntry {
  player: Player;
  currentPosition: string; // where they're slotted today
}

export interface Roster {
  entries: RosterEntry[];
  date: string;
}

// --- Matchup ---

export interface CategoryScore {
  category: Category;
  myValue: number;
  opponentValue: number;
}

export interface Matchup {
  week: number;
  weekStart: string; // ISO date "YYYY-MM-DD"
  weekEnd: string; // ISO date "YYYY-MM-DD"
  opponentTeamKey: string;
  opponentTeamName: string;
  categories: CategoryScore[];
}

// --- MLB schedule ---

export interface ProbablePitcher {
  mlbId: number;
  name: string;
  team: string;
}

export interface ScheduledGame {
  gameId: number;
  date: string;
  gameTime?: string; // ISO datetime of first pitch (e.g., "2026-04-05T17:10:00Z")
  homeTeam: string;
  awayTeam: string;
  homeProbable?: ProbablePitcher;
  awayProbable?: ProbablePitcher;
  status: "scheduled" | "in_progress" | "final";
}

// --- Decisions ---

export type DecisionType = "lineup" | "waiver" | "stream" | "trade" | "il";

export interface Decision {
  type: DecisionType;
  action: Record<string, unknown>;
  reasoning?: string;
  result: "success" | "failed" | "pending_approval" | "notified";
}

// --- Yahoo API tokens ---

export interface YahooTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix timestamp
}

// --- Lineup move ---

export interface LineupMove {
  playerId: string;
  position: string;
}

// --- Trade ---

export interface TradeProposal {
  targetTeamKey: string;
  playersToSend: string[]; // yahoo player IDs
  playersToReceive: string[]; // yahoo player IDs
  message?: string;
}

// --- Valuation ---

export interface PlayerValuation {
  yahooId: string;
  name: string;
  totalZScore: number;
  categoryZScores: Partial<Record<Category, number>>;
  positionAdjustment: number;
}
