import { describe, it, expect } from "vitest";
import { loadLeagueSettings } from "../../src/config/league";

describe("loadLeagueSettings", () => {
  it("loads the configured Yahoo league settings", () => {
    const settings = loadLeagueSettings();

    expect(settings.platform).toBe("yahoo");
    expect(settings.lineupLock).toBe("daily_individual_game_time");
    expect(settings.teams).toBe(12);
    expect(settings.pitching.minimumInningsPerWeek).toBe(20);
    expect(settings.transactions.addsPerWeek).toBe(6);
    expect(settings.transactions.waiverType).toBe("continual_rolling_list");
    expect(settings.transactions.waiverTimeDays).toBe(2);
    expect(settings.transactions.allowDirectToIl).toBe(true);
    expect(settings.playoffs.teams).toBe(6);
    expect(settings.playoffs.weeks).toEqual([24, 25, 26]);
  });

  it("preserves the configured roster layout", () => {
    const settings = loadLeagueSettings();

    expect(settings.rosterSlots.C).toBe(1);
    expect(settings.rosterSlots.OF).toBe(3);
    expect(settings.rosterSlots.Util).toBe(2);
    expect(settings.rosterSlots.SP).toBe(2);
    expect(settings.rosterSlots.RP).toBe(2);
    expect(settings.rosterSlots.P).toBe(4);
    expect(settings.rosterSlots.BN).toBe(5);
    expect(settings.rosterSlots.IL).toBe(4);
  });

  it("preserves the configured category set", () => {
    const settings = loadLeagueSettings();

    expect(settings.categories.batting).toEqual(["R", "H", "HR", "RBI", "SB", "TB", "OBP"]);
    expect(settings.categories.pitching).toEqual(["OUT", "K", "ERA", "WHIP", "QS", "SVHD"]);
  });
});
