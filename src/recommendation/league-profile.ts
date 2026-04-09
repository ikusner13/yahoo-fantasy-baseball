import leagueOverrides from "../../config/league.json";
import type { Category, Position } from "../types";

export type LeaguePlatform = "yahoo";
export type LineupLock = "daily_individual_game_time" | "weekly";
export type WaiverType = "continual_rolling_list" | "rolling_list" | "faab" | "free_agents";
export type WaiverMode = "standard" | "continuous" | "none";
export type PlayoffTiebreaker = "higher_seed_wins" | "best_record" | "custom";

export interface LeagueCategories {
  batting: Category[];
  pitching: Category[];
}

export interface LeaguePitchingSettings {
  minimumInningsPerWeek: number;
}

export interface LeagueTransactionSettings {
  addsPerWeek: number;
  waiverTimeDays: number;
  waiverType: WaiverType;
  waiverMode: WaiverMode;
  allowDirectToIl: boolean;
}

export interface LeaguePlayoffSettings {
  teams: number;
  weeks: number[];
  tiebreaker: PlayoffTiebreaker;
}

export interface LeagueProfile {
  platform: LeaguePlatform;
  lineupLock: LineupLock;
  categories: LeagueCategories;
  rosterSlots: Partial<Record<Position, number>>;
  teams: number;
  pitching: LeaguePitchingSettings;
  transactions: LeagueTransactionSettings;
  playoffs: LeaguePlayoffSettings;
}

export interface LeagueSummary {
  platform: LeaguePlatform;
  teamCount: number;
  lineupLock: LineupLock;
  scoring: string;
  roster: string;
  inningsMinimum: number;
  weeklyAdds: number;
  waiver: string;
  playoffs: string;
}

const DEFAULT_LEAGUE_PROFILE: LeagueProfile = {
  platform: "yahoo",
  lineupLock: "daily_individual_game_time",
  categories: {
    batting: ["R", "H", "HR", "RBI", "SB", "TB", "OBP"],
    pitching: ["OUT", "K", "ERA", "WHIP", "QS", "SVHD"],
  },
  rosterSlots: {
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
  },
  teams: 12,
  pitching: {
    minimumInningsPerWeek: 20,
  },
  transactions: {
    addsPerWeek: 6,
    waiverTimeDays: 2,
    waiverType: "continual_rolling_list",
    waiverMode: "standard",
    allowDirectToIl: true,
  },
  playoffs: {
    teams: 6,
    weeks: [24, 25, 26],
    tiebreaker: "higher_seed_wins",
  },
};

const parsed = leagueOverrides as Partial<LeagueProfile>;

function mergeProfile(): LeagueProfile {
  return {
    ...DEFAULT_LEAGUE_PROFILE,
    ...parsed,
    categories: {
      ...DEFAULT_LEAGUE_PROFILE.categories,
      ...parsed.categories,
    },
    rosterSlots: {
      ...DEFAULT_LEAGUE_PROFILE.rosterSlots,
      ...parsed.rosterSlots,
    },
    pitching: {
      ...DEFAULT_LEAGUE_PROFILE.pitching,
      ...parsed.pitching,
    },
    transactions: {
      ...DEFAULT_LEAGUE_PROFILE.transactions,
      ...parsed.transactions,
    },
    playoffs: {
      ...DEFAULT_LEAGUE_PROFILE.playoffs,
      ...parsed.playoffs,
    },
  };
}

export function loadLeagueProfile(): LeagueProfile {
  return mergeProfile();
}

export function isDailyLineupLock(profile: LeagueProfile = loadLeagueProfile()): boolean {
  return profile.lineupLock === "daily_individual_game_time";
}

export function getWeeklyAddLimit(profile: LeagueProfile = loadLeagueProfile()): number {
  return profile.transactions.addsPerWeek;
}

export function getMinimumInnings(profile: LeagueProfile = loadLeagueProfile()): number {
  return profile.pitching.minimumInningsPerWeek;
}

export function getRosterSlots(profile: LeagueProfile = loadLeagueProfile()): Partial<Record<Position, number>> {
  return { ...profile.rosterSlots };
}

export function isSupportedCategory(
  category: Category,
  profile: LeagueProfile = loadLeagueProfile(),
): boolean {
  return profile.categories.batting.includes(category) || profile.categories.pitching.includes(category);
}

export function getLeagueSummary(profile: LeagueProfile = loadLeagueProfile()): LeagueSummary {
  return {
    platform: profile.platform,
    teamCount: profile.teams,
    lineupLock: profile.lineupLock,
    scoring: `Hitting: ${profile.categories.batting.join(", ")} | Pitching: ${profile.categories.pitching.join(", ")}`,
    roster: Object.entries(profile.rosterSlots)
      .filter(([, count]) => typeof count === "number" && count > 0)
      .map(([slot, count]) => `${slot} x${count}`)
      .join(", "),
    inningsMinimum: profile.pitching.minimumInningsPerWeek,
    weeklyAdds: profile.transactions.addsPerWeek,
    waiver: `${profile.transactions.waiverType} / ${profile.transactions.waiverMode} / ${profile.transactions.waiverTimeDays} days / IL direct ${profile.transactions.allowDirectToIl ? "yes" : "no"}`,
    playoffs: `${profile.playoffs.teams} teams, weeks ${profile.playoffs.weeks.join(", ")}, tiebreaker ${profile.playoffs.tiebreaker}`,
  };
}

export function formatLeagueSummary(profile: LeagueProfile = loadLeagueProfile()): string {
  const summary = getLeagueSummary(profile);
  return [
    `${summary.platform.toUpperCase()} ${summary.teamCount}-team league`,
    `Lineup: ${summary.lineupLock}`,
    `Scoring: ${summary.scoring}`,
    `Roster: ${summary.roster}`,
    `Minimum IP: ${summary.inningsMinimum}`,
    `Adds: ${summary.weeklyAdds}/week`,
    `Waivers: ${summary.waiver}`,
    `Playoffs: ${summary.playoffs}`,
  ].join("\n");
}

export function validateLeagueProfile(profile: LeagueProfile): string[] {
  const errors: string[] = [];
  const expected = DEFAULT_LEAGUE_PROFILE;

  if (profile.platform !== expected.platform) errors.push("platform must be yahoo");
  if (profile.lineupLock !== expected.lineupLock) errors.push("lineup lock must be daily_individual_game_time");
  if (profile.teams !== expected.teams) errors.push(`team count must be ${expected.teams}`);
  if (profile.pitching.minimumInningsPerWeek !== expected.pitching.minimumInningsPerWeek) {
    errors.push(`minimum innings must be ${expected.pitching.minimumInningsPerWeek}`);
  }
  if (profile.transactions.addsPerWeek !== expected.transactions.addsPerWeek) {
    errors.push(`adds per week must be ${expected.transactions.addsPerWeek}`);
  }
  if (profile.transactions.waiverTimeDays !== expected.transactions.waiverTimeDays) {
    errors.push(`waiver time must be ${expected.transactions.waiverTimeDays} days`);
  }
  if (profile.transactions.waiverType !== expected.transactions.waiverType) {
    errors.push(`waiver type must be ${expected.transactions.waiverType}`);
  }
  if (profile.transactions.waiverMode !== expected.transactions.waiverMode) {
    errors.push(`waiver mode must be ${expected.transactions.waiverMode}`);
  }
  if (profile.transactions.allowDirectToIl !== expected.transactions.allowDirectToIl) {
    errors.push("direct-to-IL setting must be enabled");
  }
  if (profile.playoffs.teams !== expected.playoffs.teams) {
    errors.push(`playoff team count must be ${expected.playoffs.teams}`);
  }
  const weeks = [...profile.playoffs.weeks].join(",");
  const expectedWeeks = [...expected.playoffs.weeks].join(",");
  if (weeks !== expectedWeeks) errors.push(`playoff weeks must be ${expectedWeeks}`);
  if (profile.playoffs.tiebreaker !== expected.playoffs.tiebreaker) {
    errors.push(`playoff tiebreaker must be ${expected.playoffs.tiebreaker}`);
  }

  const batting = profile.categories.batting.join(",");
  const expectedBatting = expected.categories.batting.join(",");
  if (batting !== expectedBatting) errors.push("batting categories do not match the configured league");

  const pitching = profile.categories.pitching.join(",");
  const expectedPitching = expected.categories.pitching.join(",");
  if (pitching !== expectedPitching) errors.push("pitching categories do not match the configured league");

  const rosterEntries = Object.entries(profile.rosterSlots).sort(([a], [b]) => a.localeCompare(b));
  const expectedRosterEntries = Object.entries(expected.rosterSlots).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(rosterEntries) !== JSON.stringify(expectedRosterEntries)) {
    errors.push("roster slots do not match the configured league");
  }

  return errors;
}

export function assertLeagueProfile(profile: LeagueProfile = loadLeagueProfile()): LeagueProfile {
  const errors = validateLeagueProfile(profile);
  if (errors.length > 0) {
    throw new Error(`Invalid league profile: ${errors.join("; ")}`);
  }
  return profile;
}

export const userLeagueProfile = loadLeagueProfile();
