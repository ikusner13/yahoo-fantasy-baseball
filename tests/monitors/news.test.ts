import { describe, it, expect } from "vite-plus/test";
import {
  classifyTransaction,
  isCloserRelated,
  assessImpact,
  formatAlertForTelegram,
  inferFallbackNewsSignal,
  type NewsAlert,
} from "../../src/monitors/news";

// ---------------------------------------------------------------------------
// classifyTransaction
// ---------------------------------------------------------------------------

describe("classifyTransaction", () => {
  it("trade typeCode -> trade", () => {
    expect(classifyTransaction("Trade", "traded to the Yankees")).toBe("trade");
  });

  it("trade in description -> trade", () => {
    expect(classifyTransaction("Transaction", "Player traded to NYM")).toBe("trade");
  });

  // Injury description checked before generic "Status Change" callup match
  it("status change with injury description -> injury", () => {
    expect(classifyTransaction("Status Change", "placed on injured list")).toBe("injury");
  });

  it("injured typeCode -> injury", () => {
    expect(classifyTransaction("Injured List", "placed on 15-day IL")).toBe("injury");
  });

  it("disabled typeCode -> injury", () => {
    expect(classifyTransaction("Disabled List", "placed on 60-day disabled list")).toBe("injury");
  });

  it("call-up typeCode -> callup", () => {
    expect(classifyTransaction("Call-Up", "called up from AAA")).toBe("callup");
  });

  it("recalled typeCode -> callup", () => {
    expect(classifyTransaction("Recalled", "recalled from AAA")).toBe("callup");
  });

  it("called up in description -> callup", () => {
    expect(classifyTransaction("Roster Move", "called up from Triple-A")).toBe("callup");
  });

  it("promoted in description -> callup", () => {
    expect(classifyTransaction("Roster Move", "promoted to active roster")).toBe("callup");
  });

  it("selected to in description -> callup", () => {
    expect(classifyTransaction("Roster Move", "selected to the 26-man roster")).toBe("callup");
  });

  it("optioned typeCode -> callup", () => {
    expect(classifyTransaction("Optioned", "optioned to AAA")).toBe("callup");
  });

  it("optioned in description -> callup", () => {
    expect(classifyTransaction("Roster Move", "optioned to Triple-A")).toBe("callup");
  });

  it("unrelated transaction -> null", () => {
    expect(classifyTransaction("Signing", "signed a minor league deal")).toBeNull();
  });

  it("empty strings -> null", () => {
    expect(classifyTransaction("", "")).toBeNull();
  });

  // Priority: trade check happens before injury/callup
  it("trade takes priority when both trade and injury keywords present", () => {
    expect(classifyTransaction("Trade", "traded while on injured list")).toBe("trade");
  });
});

// ---------------------------------------------------------------------------
// isCloserRelated
// ---------------------------------------------------------------------------

describe("isCloserRelated", () => {
  it("'Named new closer' -> true", () => {
    expect(isCloserRelated("Named new closer")).toBe(true);
  });

  it("'save opportunity' -> true", () => {
    expect(isCloserRelated("Earned the save opportunity tonight")).toBe(true);
  });

  it("'ninth inning' -> true", () => {
    expect(isCloserRelated("Will pitch the ninth inning")).toBe(true);
  });

  it("'closing duties' -> true", () => {
    expect(isCloserRelated("Taking over closing duties")).toBe(true);
  });

  it("'3 saves this week' -> true", () => {
    expect(isCloserRelated("Recorded 3 saves this week")).toBe(true);
  });

  it("'hit a home run' -> false", () => {
    expect(isCloserRelated("hit a home run")).toBe(false);
  });

  it("'struck out 10' -> false", () => {
    expect(isCloserRelated("struck out 10 batters")).toBe(false);
  });

  it("empty string -> false", () => {
    expect(isCloserRelated("")).toBe(false);
  });

  it("case insensitive", () => {
    expect(isCloserRelated("NAMED NEW CLOSER")).toBe(true);
    expect(isCloserRelated("Closer Role")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assessImpact
// ---------------------------------------------------------------------------

describe("assessImpact", () => {
  it("closer_change -> saves/holds text", () => {
    const result = assessImpact("closer_change", "");
    expect(result).toContain("saves");
  });

  it("injury -> IL text", () => {
    const result = assessImpact("injury", "");
    expect(result).toContain("IL");
  });

  it("callup -> new MLB player text", () => {
    const result = assessImpact("callup", "");
    expect(result).toContain("roster");
  });

  it("trade -> role change text", () => {
    const result = assessImpact("trade", "");
    expect(result).toContain("Role");
  });

  it("lineup_change -> lineup text", () => {
    const result = assessImpact("lineup_change", "");
    expect(result).toContain("Lineup");
  });
});

// ---------------------------------------------------------------------------
// inferFallbackNewsSignal
// ---------------------------------------------------------------------------

describe("inferFallbackNewsSignal", () => {
  it("marks closer changes as high-impact adds for SVHD", () => {
    const alert: NewsAlert = {
      type: "closer_change",
      playerName: "Robert Suarez",
      team: "SD",
      headline: "Robert Suarez expected to handle save chances",
      fantasyImpact: "Potential saves/holds impact",
      actionable: true,
      timestamp: "2026-04-11T10:00:00Z",
    };

    const signal = inferFallbackNewsSignal(alert);
    expect(signal.impactLevel).toBe("high");
    expect(signal.actionBias).toBe("add");
    expect(signal.roleChange).toBe("closer_up");
    expect(signal.targetCategories).toContain("SVHD");
  });

  it("treats major IL news as long-absence risk", () => {
    const alert: NewsAlert = {
      type: "injury",
      playerName: "Shane Bieber",
      team: "CLE",
      headline: "Placed on 60-day IL following elbow surgery",
      fantasyImpact: "Check IL eligibility and replacement options",
      actionable: true,
      timestamp: "2026-04-11T10:00:00Z",
    };

    const signal = inferFallbackNewsSignal(alert);
    expect(signal.expectedAbsence).toBe("season_risk");
    expect(signal.actionBias).toBe("drop");
    expect(signal.playingTimeDelta).toBe("down");
  });
});

// ---------------------------------------------------------------------------
// formatAlertForTelegram
// ---------------------------------------------------------------------------

describe("formatAlertForTelegram", () => {
  const baseAlert: NewsAlert = {
    type: "injury",
    playerName: "Mike Trout",
    team: "LAA",
    headline: "Placed on 10-day IL with knee strain",
    fantasyImpact: "Check IL eligibility and replacement options",
    actionable: true,
    timestamp: "2026-04-05",
  };

  it("injury alert contains hospital emoji and INJURY tag", () => {
    const result = formatAlertForTelegram(baseAlert);
    expect(result).toContain("\u{1F3E5}");
    expect(result).toContain("INJURY");
    expect(result).toContain("Mike Trout");
    expect(result).toContain("(LAA)");
  });

  it("closer_change alert contains bell emoji and CLOSER CHANGE tag", () => {
    const alert: NewsAlert = {
      ...baseAlert,
      type: "closer_change",
      playerName: "Emmanuel Clase",
      team: "CLE",
      headline: "Named new closer after trade",
      fantasyImpact: "Potential saves/holds impact",
    };
    const result = formatAlertForTelegram(alert);
    expect(result).toContain("\u{1F514}");
    expect(result).toContain("CLOSER CHANGE");
    expect(result).toContain("Emmanuel Clase");
  });

  it("callup alert contains megaphone emoji and CALL-UP tag", () => {
    const alert: NewsAlert = { ...baseAlert, type: "callup" };
    const result = formatAlertForTelegram(alert);
    expect(result).toContain("\u{1F4E2}");
    expect(result).toContain("CALL-UP");
  });

  it("trade alert contains package emoji and TRADE tag", () => {
    const alert: NewsAlert = { ...baseAlert, type: "trade" };
    const result = formatAlertForTelegram(alert);
    expect(result).toContain("\u{1F4E6}");
    expect(result).toContain("TRADE");
  });

  it("lineup_change alert contains clipboard emoji and LINEUP tag", () => {
    const alert: NewsAlert = { ...baseAlert, type: "lineup_change" };
    const result = formatAlertForTelegram(alert);
    expect(result).toContain("\u{1F4CB}");
    expect(result).toContain("LINEUP");
  });

  it("includes headline in output", () => {
    const result = formatAlertForTelegram(baseAlert);
    expect(result).toContain("Placed on 10-day IL with knee strain");
  });

  it("includes fantasy impact in italics", () => {
    const result = formatAlertForTelegram(baseAlert);
    expect(result).toContain("<i>Check IL eligibility and replacement options</i>");
  });

  it("omits team parens when team is empty", () => {
    const alert: NewsAlert = { ...baseAlert, team: "" };
    const result = formatAlertForTelegram(alert);
    expect(result).not.toContain("()");
  });

  it("uses HTML bold for tag", () => {
    const result = formatAlertForTelegram(baseAlert);
    expect(result).toMatch(/<b>.*INJURY.*<\/b>/);
  });
});
