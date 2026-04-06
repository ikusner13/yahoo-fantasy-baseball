import { describe, it, expect } from "vite-plus/test";
import {
  formatMatchupForLLM,
  formatWaiverForLLM,
  formatTradeForLLM,
  formatInjuryForLLM,
  formatLineupForLLM,
  type MatchupBriefing,
  type WaiverBriefing,
  type TradeBriefing,
  type InjuryBriefing,
  type LineupBriefing,
} from "../../src/ai/briefing";

// ---------------------------------------------------------------------------
// formatMatchupForLLM
// ---------------------------------------------------------------------------

describe("formatMatchupForLLM", () => {
  const fullBriefing: MatchupBriefing = {
    summary: "Week 2 vs Professor Chaos, losing 4-8-1, 1 day left",
    categories: "R: 25-26 (swing) | H: 44-47 (losing) | HR: 10-7 (winning)",
    worthless: "OUT, K, QS already lost - production here is worthless",
    streaming: "Sit pitchers to protect WHIP (0.06 margin)",
    ipStatus: "35.2 IP (above 20 min - safe to sit)",
    volatility: "High-variance pitching roster",
    opponentScouting: "Opponent strong in K/QS, weak in SB/SV+H",
    gameCountEdge: "NYY has 7 games this week",
    streaks: "Hot: Schwarber (.410 xwOBA). Cold: Clement (.240)",
    twoStartPitchers: "Pivetta: 2 starts (vs BOS Tue, vs NYY Sun)",
    standings: "#4 (6-4-3), need wins for playoffs",
    addBudget: "3 adds remaining this week",
  };

  it("full briefing contains all section labels", () => {
    const result = formatMatchupForLLM(fullBriefing);
    expect(result).toContain(fullBriefing.summary);
    expect(result).toContain(fullBriefing.categories);
    expect(result).toContain("WORTHLESS PRODUCTION:");
    expect(result).toContain("STREAMING:");
    expect(result).toContain("IP STATUS:");
    expect(result).toContain("VOLATILITY:");
    expect(result).toContain("OPPONENT:");
    expect(result).toContain("GAME COUNT:");
    expect(result).toContain("STREAKS:");
    expect(result).toContain("TWO-START SP:");
    expect(result).toContain("STANDINGS:");
    expect(result).toContain("ADD BUDGET:");
  });

  it("full briefing includes actual content", () => {
    const result = formatMatchupForLLM(fullBriefing);
    expect(result).toContain("Sit pitchers to protect WHIP");
    expect(result).toContain("Schwarber (.410 xwOBA)");
    expect(result).toContain("Pivetta: 2 starts");
    expect(result).toContain("#4 (6-4-3)");
  });

  it("minimal briefing (required fields only) has no undefined/null", () => {
    const minimal: MatchupBriefing = {
      summary: "Week 1 vs Opponent",
      categories: "R: 10-8",
      worthless: "",
      streaming: "",
      ipStatus: "",
    };
    const result = formatMatchupForLLM(minimal);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
    expect(result).toContain("Week 1 vs Opponent");
    expect(result).toContain("R: 10-8");
  });

  it("omits optional sections when not set", () => {
    const minimal: MatchupBriefing = {
      summary: "Week 1",
      categories: "cats",
      worthless: "",
      streaming: "",
      ipStatus: "",
    };
    const result = formatMatchupForLLM(minimal);
    expect(result).not.toContain("WORTHLESS PRODUCTION:");
    expect(result).not.toContain("STREAMING:");
    expect(result).not.toContain("IP STATUS:");
    expect(result).not.toContain("VOLATILITY:");
    expect(result).not.toContain("OPPONENT:");
    expect(result).not.toContain("GAME COUNT:");
    expect(result).not.toContain("STREAKS:");
    expect(result).not.toContain("TWO-START SP:");
    expect(result).not.toContain("STANDINGS:");
    expect(result).not.toContain("ADD BUDGET:");
  });

  it("WORTHLESS PRODUCTION appears when worthless field is set", () => {
    const b: MatchupBriefing = {
      summary: "s",
      categories: "c",
      worthless: "K already lost",
      streaming: "",
      ipStatus: "",
    };
    const result = formatMatchupForLLM(b);
    expect(result).toContain("WORTHLESS PRODUCTION: K already lost");
  });

  it("STREAMING section includes quality floor info", () => {
    const b: MatchupBriefing = {
      summary: "s",
      categories: "c",
      worthless: "",
      streaming: "Engine recommends: sit pitchers. Quality floor: 4.00 ERA",
      ipStatus: "",
    };
    const result = formatMatchupForLLM(b);
    expect(result).toContain("STREAMING: Engine recommends: sit pitchers. Quality floor: 4.00 ERA");
  });
});

// ---------------------------------------------------------------------------
// formatWaiverForLLM
// ---------------------------------------------------------------------------

describe("formatWaiverForLLM", () => {
  const fullBriefing: WaiverBriefing = {
    matchupContext: "SB and SVHD are swing categories this week",
    addBudget: "3 adds remaining",
    recommendations: "1. Player A (z: 1.8)\n2. Player B (z: 1.2)",
    rosterNeeds: "Need RP for SVHD, speed for SB",
    standings: "#4 (6-4-3)",
  };

  it("full briefing contains all sections", () => {
    const result = formatWaiverForLLM(fullBriefing);
    expect(result).toContain("MATCHUP CONTEXT:");
    expect(result).toContain("ADD BUDGET:");
    expect(result).toContain("ROSTER NEEDS:");
    expect(result).toContain("RECOMMENDATIONS:");
    expect(result).toContain("STANDINGS:");
  });

  it("full briefing includes actual content", () => {
    const result = formatWaiverForLLM(fullBriefing);
    expect(result).toContain("SB and SVHD are swing categories");
    expect(result).toContain("3 adds remaining");
    expect(result).toContain("Player A (z: 1.8)");
    expect(result).toContain("Need RP for SVHD");
  });

  it("minimal briefing (no standings) has no undefined/null", () => {
    const minimal: WaiverBriefing = {
      matchupContext: "no swing cats",
      addBudget: "7",
      recommendations: "none",
      rosterNeeds: "none",
    };
    const result = formatWaiverForLLM(minimal);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
    expect(result).not.toContain("STANDINGS:");
  });
});

// ---------------------------------------------------------------------------
// formatTradeForLLM
// ---------------------------------------------------------------------------

describe("formatTradeForLLM", () => {
  const fullBriefing: TradeBriefing = {
    roster: "C: Adley, 1B: Vlad, SS: Witt",
    needs: "SB, SVHD",
    surplus: "HR, RBI (3 elite power bats)",
    targetInfo: "Team 5 has 4 closers, weak HR",
    standings: "#4",
    streaks: "Sell-high: Vlad (.450 BABIP). Buy-low: Acuna (.180)",
  };

  it("full briefing contains all sections", () => {
    const result = formatTradeForLLM(fullBriefing);
    expect(result).toContain("MY ROSTER:");
    expect(result).toContain("CATEGORY NEEDS:");
    expect(result).toContain("SURPLUS:");
    expect(result).toContain("TARGET:");
    expect(result).toContain("STANDINGS:");
    expect(result).toContain("STREAKS:");
  });

  it("full briefing includes actual content", () => {
    const result = formatTradeForLLM(fullBriefing);
    expect(result).toContain("C: Adley, 1B: Vlad");
    expect(result).toContain("SB, SVHD");
    expect(result).toContain("3 elite power bats");
    expect(result).toContain("Team 5 has 4 closers");
    expect(result).toContain("Sell-high: Vlad");
  });

  it("minimal briefing has no undefined/null", () => {
    const minimal: TradeBriefing = {
      roster: "roster",
      needs: "needs",
      surplus: "surplus",
      targetInfo: "target",
    };
    const result = formatTradeForLLM(minimal);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
    expect(result).not.toContain("STANDINGS:");
    expect(result).not.toContain("STREAKS:");
  });
});

// ---------------------------------------------------------------------------
// formatInjuryForLLM
// ---------------------------------------------------------------------------

describe("formatInjuryForLLM", () => {
  const fullBriefing: InjuryBriefing = {
    player: "Mike Trout (LAA) - OF",
    injury: "Knee strain, expected 4-6 weeks",
    rosterContext: "OF depth: Judge, Soto, Acuna. Util open.",
    ilSlots: "2/4 IL slots used",
    matchupImpact: "Losing Trout hurts HR which is a swing category",
    replacementOptions: "FA: Taylor Ward (.310 xwOBA), Lane Thomas",
  };

  it("full briefing contains all sections", () => {
    const result = formatInjuryForLLM(fullBriefing);
    expect(result).toContain("PLAYER:");
    expect(result).toContain("INJURY:");
    expect(result).toContain("ROSTER:");
    expect(result).toContain("IL SLOTS:");
    expect(result).toContain("MATCHUP IMPACT:");
    expect(result).toContain("REPLACEMENTS:");
  });

  it("full briefing includes actual content", () => {
    const result = formatInjuryForLLM(fullBriefing);
    expect(result).toContain("Mike Trout");
    expect(result).toContain("4-6 weeks");
    expect(result).toContain("Judge, Soto, Acuna");
    expect(result).toContain("2/4 IL slots used");
    expect(result).toContain("Taylor Ward");
  });

  it("minimal briefing has no undefined/null", () => {
    const minimal: InjuryBriefing = {
      player: "Player X",
      injury: "DTD",
      rosterContext: "context",
      ilSlots: "0/4",
    };
    const result = formatInjuryForLLM(minimal);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
    expect(result).not.toContain("MATCHUP IMPACT:");
    expect(result).not.toContain("REPLACEMENTS:");
  });
});

// ---------------------------------------------------------------------------
// formatLineupForLLM
// ---------------------------------------------------------------------------

describe("formatLineupForLLM", () => {
  const fullBriefing: LineupBriefing = {
    starters: "C: Adley, 1B: Vlad, OF: Judge/Soto/Acuna",
    benched: "BN: Devers (no game), BN: McMahon",
    games: "NYY: @BOS (7:05pm), LAD: vs SF (10:10pm)",
    strategy: "Start all bats, sit Devers (off day)",
    swingCategories: "SB (4-4, swing), HR (10-7, winning)",
  };

  it("full briefing contains all sections", () => {
    const result = formatLineupForLLM(fullBriefing);
    expect(result).toContain("STARTERS:");
    expect(result).toContain("BENCHED:");
    expect(result).toContain("GAMES:");
    expect(result).toContain("STRATEGY:");
    expect(result).toContain("SWING CATEGORIES:");
  });

  it("full briefing includes actual content", () => {
    const result = formatLineupForLLM(fullBriefing);
    expect(result).toContain("C: Adley");
    expect(result).toContain("Devers (no game)");
    expect(result).toContain("NYY: @BOS");
    expect(result).toContain("Start all bats");
    expect(result).toContain("SB (4-4, swing)");
  });

  it("minimal briefing has no undefined/null", () => {
    const minimal: LineupBriefing = {
      starters: "starters list",
      benched: "bench list",
      games: "game list",
    };
    const result = formatLineupForLLM(minimal);
    expect(result).not.toContain("undefined");
    expect(result).not.toContain("null");
    expect(result).not.toContain("STRATEGY:");
    expect(result).not.toContain("SWING CATEGORIES:");
  });

  it("output is newline-separated", () => {
    const result = formatLineupForLLM(fullBriefing);
    const lines = result.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(5);
  });
});
