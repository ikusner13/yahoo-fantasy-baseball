import { describe, it, expect } from "vite-plus/test";
import { buildPlayerIdMap, normalizeName } from "../../src/data/player-match";

// --- Real player data from roster ---

const rosterPlayers = [
  { yahooId: "469.p.11349", name: "Francisco Alvarez", team: "NYM" },
  { yahooId: "469.p.10465", name: "Yandy Díaz", team: "TB" },
  { yahooId: "469.p.12730", name: "Ceddanne Rafaela", team: "BOS" },
  { yahooId: "469.p.9861", name: "Kyle Schwarber", team: "PHI" },
  { yahooId: "469.p.12046", name: "Garrett Crochet", team: "BOS" },
  { yahooId: "469.p.9882", name: "Aaron Nola", team: "PHI" },
];

const projections = [
  { fangraphsId: 19470, name: "Francisco Alvarez", team: "NYM" },
  { fangraphsId: 15500, name: "Yandy Diaz", team: "TB" }, // no accent
  { fangraphsId: 27509, name: "Ceddanne Rafaela", team: "BOS" },
  { fangraphsId: 13624, name: "Kyle Schwarber", team: "PHI" },
  { fangraphsId: 23463, name: "Garrett Crochet", team: "BOS" },
  { fangraphsId: 14563, name: "Aaron Nola", team: "PHI" },
];

describe("normalizeName", () => {
  it("strips accents", () => {
    expect(normalizeName("Yandy Díaz")).toBe("yandy diaz");
  });

  it("removes periods", () => {
    expect(normalizeName("J.D. Martinez")).toBe("jd martinez");
  });

  it("removes Jr suffix", () => {
    expect(normalizeName("Fernando Tatis Jr")).toBe("fernando tatis");
  });

  it("removes III suffix", () => {
    expect(normalizeName("Ken Griffey III")).toBe("ken griffey");
  });

  it("lowercases", () => {
    expect(normalizeName("MIKE TROUT")).toBe("mike trout");
  });
});

describe("buildPlayerIdMap", () => {
  it("matches all exact name+team pairs", () => {
    const { idMap, matches } = buildPlayerIdMap(rosterPlayers, projections);

    // All 6 should match
    expect(idMap.size).toBe(6);

    // Check specific mappings
    expect(idMap.get(19470)).toBe("469.p.11349"); // Alvarez
    expect(idMap.get(27509)).toBe("469.p.12730"); // Rafaela
    expect(idMap.get(13624)).toBe("469.p.9861"); // Schwarber
    expect(idMap.get(23463)).toBe("469.p.12046"); // Crochet
    expect(idMap.get(14563)).toBe("469.p.9882"); // Nola

    // Exact matches should have "exact" confidence
    const exactMatches = matches.filter((m) => m.confidence === "exact");
    expect(exactMatches.length).toBeGreaterThanOrEqual(5);
  });

  it("handles accent normalization (Díaz → Diaz)", () => {
    const { idMap } = buildPlayerIdMap(rosterPlayers, projections);
    expect(idMap.get(15500)).toBe("469.p.10465"); // Yandy Díaz
  });

  it("returns empty map when no matches", () => {
    const noOverlap = [{ fangraphsId: 99999, name: "Nobody Real", team: "LAD" }];
    const { idMap } = buildPlayerIdMap(rosterPlayers, noOverlap);
    expect(idMap.size).toBe(0);
  });

  it("handles player not in projections", () => {
    const partialProj = [projections[0]!]; // only Alvarez
    const { idMap } = buildPlayerIdMap(rosterPlayers, partialProj);
    expect(idMap.size).toBe(1);
    expect(idMap.get(19470)).toBe("469.p.11349");
  });

  it("handles team abbreviation normalization (TBR → TB)", () => {
    const fgWithTBR = [{ fangraphsId: 15500, name: "Yandy Diaz", team: "TBR" }];
    const { idMap } = buildPlayerIdMap(rosterPlayers, fgWithTBR);
    expect(idMap.get(15500)).toBe("469.p.10465");
  });

  it("resolves name collision by team", () => {
    const roster = [
      { yahooId: "469.p.100", name: "John Smith", team: "NYY" },
      { yahooId: "469.p.200", name: "John Smith", team: "LAD" },
    ];
    const proj = [
      { fangraphsId: 1, name: "John Smith", team: "LAD" },
      { fangraphsId: 2, name: "John Smith", team: "NYY" },
    ];
    const { idMap } = buildPlayerIdMap(roster, proj);
    expect(idMap.get(1)).toBe("469.p.200"); // LAD
    expect(idMap.get(2)).toBe("469.p.100"); // NYY
  });

  it("matches by name only when FG team is FA (free agent)", () => {
    const faProjection = [{ fangraphsId: 19470, name: "Francisco Alvarez", team: "- - -" }];
    const { idMap, matches } = buildPlayerIdMap(rosterPlayers, faProjection);
    expect(idMap.get(19470)).toBe("469.p.11349");
    expect(matches[0]?.confidence).toBe("name-only");
  });

  it("fuzzy matches by last name + team (J.D. vs JD)", () => {
    const roster = [{ yahooId: "469.p.300", name: "J.D. Martinez", team: "NYM" }];
    const proj = [{ fangraphsId: 5000, name: "JD Martinez", team: "NYM" }];
    const { idMap, matches } = buildPlayerIdMap(roster, proj);
    expect(idMap.get(5000)).toBe("469.p.300");
    // Should be exact since normalization handles periods
    expect(matches[0]?.confidence).toBe("exact");
  });

  it("fuzzy last name match when first name differs slightly", () => {
    // e.g. "Willy Adames" (Yahoo) vs "William Adames" (FanGraphs)
    const roster = [{ yahooId: "469.p.400", name: "Willy Adames", team: "SF" }];
    const proj = [{ fangraphsId: 6000, name: "William Adames", team: "SF" }];
    const { idMap, matches } = buildPlayerIdMap(roster, proj);
    // Should fuzzy match on last name + team
    expect(idMap.get(6000)).toBe("469.p.400");
    expect(matches[0]?.confidence).toBe("fuzzy");
  });

  it("does not fuzzy match when multiple players share last name + team", () => {
    const roster = [
      { yahooId: "469.p.500", name: "Joe Martinez", team: "SF" },
      { yahooId: "469.p.501", name: "Pedro Martinez", team: "SF" },
    ];
    const proj = [{ fangraphsId: 7000, name: "P. Martinez", team: "SF" }];
    const { idMap } = buildPlayerIdMap(roster, proj);
    // Ambiguous — should NOT match
    expect(idMap.has(7000)).toBe(false);
  });

  it("handles CHW → CWS normalization", () => {
    const roster = [{ yahooId: "469.p.600", name: "Luis Robert", team: "CWS" }];
    const proj = [{ fangraphsId: 8000, name: "Luis Robert", team: "CHW" }];
    const { idMap } = buildPlayerIdMap(roster, proj);
    expect(idMap.get(8000)).toBe("469.p.600");
  });
});
