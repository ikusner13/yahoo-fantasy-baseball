/**
 * Name+team matching bridge between FanGraphs projections and Yahoo roster players.
 * Resolves the key mismatch: FanGraphs uses fangraphsId, Yahoo uses yahooId.
 */

export type MatchConfidence = "exact" | "name-only" | "fuzzy";

export interface MatchResult {
  yahooId: string;
  fangraphsId: number;
  name: string;
  team: string;
  confidence: MatchConfidence;
}

// --- Team abbreviation normalization ---

const TEAM_ALIASES: Record<string, string> = {
  // FanGraphs → canonical
  TBR: "TB",
  TBA: "TB",
  CHW: "CWS",
  CHC: "CHC",
  KCR: "KC",
  SDP: "SD",
  SFG: "SF",
  WSN: "WSH",
  ARI: "ARI",
  // Yahoo → canonical (already canonical in most cases)
};

function normalizeTeam(team: string): string {
  const upper = team.trim().toUpperCase();
  return TEAM_ALIASES[upper] ?? upper;
}

// --- Name normalization ---

/**
 * Strip accents (Díaz → Diaz), periods (J.D. → JD),
 * suffixes (Jr/Sr/III/II/IV), then lowercase.
 */
export function normalizeName(name: string): string {
  return (
    name
      // Decompose accented chars, strip combining diacriticals
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Remove periods (J.D. → JD)
      .replace(/\./g, "")
      // Remove suffixes
      .replace(/\s+(jr|sr|ii|iii|iv|v)$/i, "")
      .trim()
      .toLowerCase()
  );
}

function extractLastName(normalized: string): string {
  const parts = normalized.split(/\s+/);
  return parts[parts.length - 1] ?? normalized;
}

// --- Free agent detection ---

function isFreeAgent(team: string): boolean {
  const t = team.trim();
  return t === "" || t === "- - -" || t === "---" || t === "FA";
}

// --- Core matching ---

export function buildPlayerIdMap(
  rosterPlayers: Array<{ yahooId: string; name: string; team: string }>,
  projections: Array<{ fangraphsId: number; name: string; team: string }>,
): { idMap: Map<number, string>; matches: MatchResult[] } {
  const idMap = new Map<number, string>(); // fangraphsId → yahooId
  const matches: MatchResult[] = [];
  const usedYahooIds = new Set<string>();

  // Index roster players by normalized name and by last name+team
  const rosterByName = new Map<string, Array<{ yahooId: string; name: string; team: string }>>();
  const rosterByLastTeam = new Map<
    string,
    Array<{ yahooId: string; name: string; team: string }>
  >();

  for (const rp of rosterPlayers) {
    const norm = normalizeName(rp.name);
    const existing = rosterByName.get(norm) ?? [];
    existing.push(rp);
    rosterByName.set(norm, existing);

    const last = extractLastName(norm);
    const normTeam = normalizeTeam(rp.team);
    const key = `${last}::${normTeam}`;
    const existingLT = rosterByLastTeam.get(key) ?? [];
    existingLT.push(rp);
    rosterByLastTeam.set(key, existingLT);
  }

  // Pass 1: Exact name + team
  for (const proj of projections) {
    const normName = normalizeName(proj.name);
    const normTeam = normalizeTeam(proj.team);
    const candidates = rosterByName.get(normName);
    if (!candidates) continue;

    const match = candidates.find(
      (c) => !usedYahooIds.has(c.yahooId) && normalizeTeam(c.team) === normTeam,
    );
    if (match) {
      idMap.set(proj.fangraphsId, match.yahooId);
      usedYahooIds.add(match.yahooId);
      matches.push({
        yahooId: match.yahooId,
        fangraphsId: proj.fangraphsId,
        name: proj.name,
        team: proj.team,
        confidence: "exact",
      });
    }
  }

  // Pass 2: Name-only (handles trades / FA projections)
  for (const proj of projections) {
    if (idMap.has(proj.fangraphsId)) continue;
    const normName = normalizeName(proj.name);
    const candidates = rosterByName.get(normName);
    if (!candidates) continue;

    const match = candidates.find((c) => !usedYahooIds.has(c.yahooId));
    if (match) {
      // Only allow name-only if the projection team is FA or different
      const projFA = isFreeAgent(proj.team);
      const teamsDiffer = normalizeTeam(proj.team) !== normalizeTeam(match.team);
      if (projFA || teamsDiffer) {
        idMap.set(proj.fangraphsId, match.yahooId);
        usedYahooIds.add(match.yahooId);
        matches.push({
          yahooId: match.yahooId,
          fangraphsId: proj.fangraphsId,
          name: proj.name,
          team: proj.team,
          confidence: "name-only",
        });
      }
    }
  }

  // Pass 3: Fuzzy last name + team (handles "J.D. Martinez" vs "JD Martinez")
  for (const proj of projections) {
    if (idMap.has(proj.fangraphsId)) continue;
    const normName = normalizeName(proj.name);
    const last = extractLastName(normName);
    const normTeam = normalizeTeam(proj.team);
    if (isFreeAgent(proj.team)) continue; // can't fuzzy match without team

    const key = `${last}::${normTeam}`;
    const candidates = rosterByLastTeam.get(key);
    if (!candidates) continue;

    // Only match if there's exactly one unused candidate (avoid ambiguity)
    const unused = candidates.filter((c) => !usedYahooIds.has(c.yahooId));
    if (unused.length === 1) {
      const match = unused[0]!;
      idMap.set(proj.fangraphsId, match.yahooId);
      usedYahooIds.add(match.yahooId);
      matches.push({
        yahooId: match.yahooId,
        fangraphsId: proj.fangraphsId,
        name: proj.name,
        team: proj.team,
        confidence: "fuzzy",
      });
    }
  }

  return { idMap, matches };
}
