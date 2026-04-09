import { describe, expect, it } from "vitest";
import {
  assertLeagueProfile,
  formatLeagueSummary,
  getLeagueSummary,
  getMinimumInnings,
  getRosterSlots,
  getWeeklyAddLimit,
  isDailyLineupLock,
  isSupportedCategory,
  loadLeagueProfile,
  validateLeagueProfile,
} from "../../src/recommendation/league-profile";

describe("league-profile", () => {
  it("loads the configured Yahoo league profile", () => {
    const profile = loadLeagueProfile();

    expect(profile.platform).toBe("yahoo");
    expect(profile.lineupLock).toBe("daily_individual_game_time");
    expect(profile.teams).toBe(12);
    expect(profile.pitching.minimumInningsPerWeek).toBe(20);
    expect(profile.transactions.addsPerWeek).toBe(6);
    expect(profile.transactions.waiverTimeDays).toBe(2);
    expect(profile.transactions.waiverType).toBe("continual_rolling_list");
    expect(profile.transactions.waiverMode).toBe("standard");
    expect(profile.transactions.allowDirectToIl).toBe(true);
    expect(profile.playoffs.teams).toBe(6);
    expect(profile.playoffs.weeks).toEqual([24, 25, 26]);
    expect(profile.playoffs.tiebreaker).toBe("higher_seed_wins");
  });

  it("exposes the configured roster shape and summary helpers", () => {
    const profile = loadLeagueProfile();
    const summary = getLeagueSummary(profile);

    expect(isDailyLineupLock(profile)).toBe(true);
    expect(getWeeklyAddLimit(profile)).toBe(6);
    expect(getMinimumInnings(profile)).toBe(20);
    expect(getRosterSlots(profile)).toMatchObject({
      C: 1,
      OF: 3,
      Util: 2,
      SP: 2,
      RP: 2,
      P: 4,
      BN: 5,
      IL: 4,
    });

    expect(summary.teamCount).toBe(12);
    expect(summary.scoring).toContain("R, H, HR, RBI, SB, TB, OBP");
    expect(summary.scoring).toContain("OUT, K, ERA, WHIP, QS, SVHD");
    expect(summary.roster).toContain("OF x3");
    expect(summary.roster).toContain("IL x4");
    expect(formatLeagueSummary(profile)).toContain("YAHOO 12-team league");
  });

  it("recognizes supported categories and rejects unsupported ones", () => {
    const profile = loadLeagueProfile();

    expect(isSupportedCategory("HR", profile)).toBe(true);
    expect(isSupportedCategory("ERA", profile)).toBe(true);
    expect(isSupportedCategory("AVG" as never, profile)).toBe(false);
  });

  it("validates the configured profile without errors", () => {
    const profile = loadLeagueProfile();

    expect(validateLeagueProfile(profile)).toEqual([]);
    expect(() => assertLeagueProfile(profile)).not.toThrow();
  });
});
