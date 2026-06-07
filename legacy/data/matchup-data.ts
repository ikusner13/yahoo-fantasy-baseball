const BASE = "https://statsapi.mlb.com/api/v1";

// --- Concurrency helper ---

async function fetchWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// --- BvP (Batter vs Pitcher) ---

export interface BvPStats {
  batterId: number;
  pitcherId: number;
  pa: number;
  ab: number;
  h: number;
  hr: number;
  bb: number;
  k: number;
  obp: number;
  slg: number;
  tb: number;
}

export async function getBatterVsPitcher(
  batterId: number,
  pitcherId: number,
): Promise<BvPStats | null> {
  const url = `${BASE}/people/${batterId}/stats?stats=vsPlayer&opposingPlayerId=${pitcherId}&group=hitting`;
  const res = await fetch(url);
  if (!res.ok) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const stat = json.stats?.[0]?.splits?.[0]?.stat;
  if (!stat || !stat.plateAppearances) return null;

  return {
    batterId,
    pitcherId,
    pa: stat.plateAppearances ?? 0,
    ab: stat.atBats ?? 0,
    h: stat.hits ?? 0,
    hr: stat.homeRuns ?? 0,
    bb: stat.baseOnBalls ?? 0,
    k: stat.strikeOuts ?? 0,
    obp: parseFloat(stat.obp) || 0,
    slg: parseFloat(stat.slg) || 0,
    tb: stat.totalBases ?? 0,
  };
}

export async function getBatchBvP(
  batters: Array<{ mlbId: number }>,
  pitcherId: number,
): Promise<Map<number, BvPStats>> {
  const results = new Map<number, BvPStats>();
  const valid = batters.filter((b) => b.mlbId);

  const tasks = valid.map((b) => () => getBatterVsPitcher(b.mlbId, pitcherId));

  const settled = await fetchWithConcurrency(tasks, 5);

  for (let i = 0; i < valid.length; i++) {
    const stat = settled[i];
    if (stat) results.set(valid[i].mlbId, stat);
  }

  return results;
}

// --- Platoon splits ---

export interface PlatoonSplit {
  mlbId: number;
  vsLeft: { pa: number; obp: number; slg: number; kPct: number };
  vsRight: { pa: number; obp: number; slg: number; kPct: number };
  advantage: "L" | "R" | "neutral";
  advantageSize: number;
}

function parseSplitSide(stat: Record<string, unknown>): {
  pa: number;
  obp: number;
  slg: number;
  kPct: number;
} {
  const pa = (stat.plateAppearances as number) || 0;
  const k = (stat.strikeOuts as number) || 0;
  return {
    pa,
    obp: parseFloat(stat.obp as string) || 0,
    slg: parseFloat(stat.slg as string) || 0,
    kPct: pa > 0 ? k / pa : 0,
  };
}

export async function getPlatoonSplits(mlbId: number): Promise<PlatoonSplit | null> {
  const url = `${BASE}/people/${mlbId}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr`;
  const res = await fetch(url);
  if (!res.ok) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json: any = await res.json();
  const splits = json.stats?.[0]?.splits ?? [];

  let vsLeft: PlatoonSplit["vsLeft"] | undefined;
  let vsRight: PlatoonSplit["vsRight"] | undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const split of splits as any[]) {
    const code = split.split?.code ?? split.split?.description ?? "";
    if (code === "vl" || code === "vs LHP") {
      vsLeft = parseSplitSide(split.stat);
    } else if (code === "vr" || code === "vs RHP") {
      vsRight = parseSplitSide(split.stat);
    }
  }

  if (!vsLeft || !vsRight) return null;

  const opsVsL = vsLeft.obp + vsLeft.slg;
  const opsVsR = vsRight.obp + vsRight.slg;
  const diff = opsVsL - opsVsR;

  let advantage: "L" | "R" | "neutral";
  if (Math.abs(diff) < 0.03) {
    advantage = "neutral";
  } else {
    advantage = diff > 0 ? "L" : "R";
  }

  return {
    mlbId,
    vsLeft,
    vsRight,
    advantage,
    advantageSize: Math.abs(diff),
  };
}

// --- Pitcher hand ---

export async function getPitcherHand(mlbId: number): Promise<"L" | "R" | null> {
  try {
    const url = `${BASE}/people/${mlbId}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const json: any = await res.json();
    const code = json.people?.[0]?.pitchHand?.code;
    if (code === "L" || code === "R") return code;
    return null;
  } catch {
    return null;
  }
}

// --- Batch platoon splits ---

export async function getBatchPlatoonSplits(mlbIds: number[]): Promise<Map<number, PlatoonSplit>> {
  const results = new Map<number, PlatoonSplit>();
  if (mlbIds.length === 0) return results;

  const tasks = mlbIds.map((id) => () => getPlatoonSplits(id));
  const settled = await fetchWithConcurrency(tasks, 5);

  for (let i = 0; i < mlbIds.length; i++) {
    const split = settled[i];
    if (split) results.set(mlbIds[i], split);
  }

  return results;
}

// --- Park factors ---

export interface ParkFactor {
  team: string;
  parkName: string;
  runsFactor: number;
  hrFactor: number;
}

export const PARK_FACTORS: Record<string, ParkFactor> = {
  ARI: { team: "ARI", parkName: "Chase Field", runsFactor: 1.05, hrFactor: 1.1 },
  ATL: { team: "ATL", parkName: "Truist Park", runsFactor: 1.0, hrFactor: 1.05 },
  BAL: { team: "BAL", parkName: "Camden Yards", runsFactor: 1.05, hrFactor: 1.1 },
  BOS: { team: "BOS", parkName: "Fenway Park", runsFactor: 1.05, hrFactor: 0.95 },
  CHC: { team: "CHC", parkName: "Wrigley Field", runsFactor: 1.05, hrFactor: 1.1 },
  CWS: { team: "CWS", parkName: "Guaranteed Rate Field", runsFactor: 1.05, hrFactor: 1.1 },
  CIN: { team: "CIN", parkName: "Great American Ball Park", runsFactor: 1.1, hrFactor: 1.15 },
  CLE: { team: "CLE", parkName: "Progressive Field", runsFactor: 0.95, hrFactor: 0.95 },
  COL: { team: "COL", parkName: "Coors Field", runsFactor: 1.3, hrFactor: 1.35 },
  DET: { team: "DET", parkName: "Comerica Park", runsFactor: 0.95, hrFactor: 0.9 },
  HOU: { team: "HOU", parkName: "Minute Maid Park", runsFactor: 1.0, hrFactor: 1.05 },
  KC: { team: "KC", parkName: "Kauffman Stadium", runsFactor: 1.0, hrFactor: 0.95 },
  LAA: { team: "LAA", parkName: "Angel Stadium", runsFactor: 0.95, hrFactor: 1.0 },
  LAD: { team: "LAD", parkName: "Dodger Stadium", runsFactor: 0.95, hrFactor: 0.95 },
  MIA: { team: "MIA", parkName: "LoanDepot Park", runsFactor: 0.9, hrFactor: 0.85 },
  MIL: { team: "MIL", parkName: "American Family Field", runsFactor: 1.05, hrFactor: 1.1 },
  MIN: { team: "MIN", parkName: "Target Field", runsFactor: 1.0, hrFactor: 1.0 },
  NYM: { team: "NYM", parkName: "Citi Field", runsFactor: 0.95, hrFactor: 0.9 },
  NYY: { team: "NYY", parkName: "Yankee Stadium", runsFactor: 1.05, hrFactor: 1.2 },
  OAK: { team: "OAK", parkName: "Oakland Coliseum", runsFactor: 0.9, hrFactor: 0.85 },
  PHI: { team: "PHI", parkName: "Citizens Bank Park", runsFactor: 1.05, hrFactor: 1.1 },
  PIT: { team: "PIT", parkName: "PNC Park", runsFactor: 0.95, hrFactor: 0.9 },
  SD: { team: "SD", parkName: "Petco Park", runsFactor: 0.9, hrFactor: 0.9 },
  SF: { team: "SF", parkName: "Oracle Park", runsFactor: 0.85, hrFactor: 0.8 },
  SEA: { team: "SEA", parkName: "T-Mobile Park", runsFactor: 0.9, hrFactor: 0.9 },
  STL: { team: "STL", parkName: "Busch Stadium", runsFactor: 0.95, hrFactor: 0.95 },
  TB: { team: "TB", parkName: "Tropicana Field", runsFactor: 0.95, hrFactor: 0.9 },
  TEX: { team: "TEX", parkName: "Globe Life Field", runsFactor: 0.95, hrFactor: 1.0 },
  TOR: { team: "TOR", parkName: "Rogers Centre", runsFactor: 1.05, hrFactor: 1.1 },
  WSH: { team: "WSH", parkName: "Nationals Park", runsFactor: 1.0, hrFactor: 1.0 },
};

// --- Team batting stats ---

export interface TeamBattingStats {
  team: string;
  kPct: number; // team strikeout rate (K / PA)
  bbPct: number; // walk rate
  obp: number;
  ops: number;
  /** wOBA approximation derived from OBP + component weighting */
  woba: number;
  wobaVsL: number; // team wOBA vs left-handed pitchers
  wobaVsR: number; // team wOBA vs right-handed pitchers
}

const TEAM_IDS_INTERNAL: Record<string, number> = {
  ARI: 109,
  ATL: 144,
  BAL: 110,
  BOS: 111,
  CHC: 112,
  CWS: 145,
  CIN: 113,
  CLE: 114,
  COL: 115,
  DET: 116,
  HOU: 117,
  KC: 118,
  LAA: 108,
  LAD: 119,
  MIA: 146,
  MIL: 158,
  MIN: 142,
  NYM: 121,
  NYY: 147,
  OAK: 133,
  PHI: 143,
  PIT: 134,
  SD: 135,
  SF: 137,
  SEA: 136,
  STL: 138,
  TB: 139,
  TEX: 140,
  TOR: 141,
  WSH: 120,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseTeamHittingStat(stat: any): {
  kPct: number;
  bbPct: number;
  obp: number;
  ops: number;
} {
  const pa = (stat.plateAppearances as number) || 0;
  const k = (stat.strikeOuts as number) || 0;
  const bb = (stat.baseOnBalls as number) || 0;
  return {
    kPct: pa > 0 ? k / pa : 0.22,
    bbPct: pa > 0 ? bb / pa : 0.08,
    obp: parseFloat(stat.obp) || 0.32,
    ops: parseFloat(stat.ops) || 0.72,
  };
}

/** Approximate wOBA from OBP (correlation ~0.95, good enough for relative ranking) */
function obpToWoba(obp: number): number {
  // wOBA ≈ OBP * 0.92 + 0.015 (empirical linear fit)
  return obp * 0.92 + 0.015;
}

/**
 * Fetch team-level batting stats including K% and vs-hand splits.
 * Returns null if the API call fails.
 */
export async function getTeamBattingStats(teamAbbr: string): Promise<TeamBattingStats | null> {
  const teamId = TEAM_IDS_INTERNAL[teamAbbr.toUpperCase()];
  if (!teamId) return null;

  const season = new Date().getFullYear();

  try {
    // Fetch season stats + vs-hand splits in parallel
    const [seasonRes, splitsRes] = await Promise.all([
      fetch(`${BASE}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`),
      fetch(
        `${BASE}/teams/${teamId}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${season}`,
      ),
    ]);

    // Parse season stats
    let kPct = 0.22;
    let bbPct = 0.08;
    let obp = 0.32;
    let ops = 0.72;

    if (seasonRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await seasonRes.json();
      const stat = json.stats?.[0]?.splits?.[0]?.stat;
      if (stat) {
        const parsed = parseTeamHittingStat(stat);
        kPct = parsed.kPct;
        bbPct = parsed.bbPct;
        obp = parsed.obp;
        ops = parsed.ops;
      }
    }

    const woba = obpToWoba(obp);

    // Parse vs-hand splits
    let wobaVsL = woba;
    let wobaVsR = woba;

    if (splitsRes.ok) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const splitsJson: any = await splitsRes.json();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const split of (splitsJson.stats?.[0]?.splits ?? []) as any[]) {
        const code = split.split?.code ?? split.split?.description ?? "";
        const splitStat = split.stat;
        if (!splitStat) continue;
        const splitObp = parseFloat(splitStat.obp) || obp;
        if (code === "vl" || code === "vs LHP") {
          wobaVsL = obpToWoba(splitObp);
        } else if (code === "vr" || code === "vs RHP") {
          wobaVsR = obpToWoba(splitObp);
        }
      }
    }

    return { team: teamAbbr, kPct, bbPct, obp, ops, woba, wobaVsL, wobaVsR };
  } catch {
    return null;
  }
}

/**
 * Batch fetch team batting stats for multiple teams.
 * Returns a map of team abbreviation → stats.
 */
export async function getBatchTeamBattingStats(
  teams: string[],
): Promise<Map<string, TeamBattingStats>> {
  const results = new Map<string, TeamBattingStats>();
  if (teams.length === 0) return results;

  const tasks = teams.map((t) => () => getTeamBattingStats(t));
  const settled = await fetchWithConcurrency(tasks, 5);

  for (let i = 0; i < teams.length; i++) {
    const stat = settled[i];
    if (stat) results.set(teams[i], stat);
  }

  return results;
}

export function getParkFactor(homeTeam: string): ParkFactor {
  const factor = PARK_FACTORS[homeTeam.toUpperCase()];
  if (factor) return factor;
  // Neutral fallback for unknown teams
  return { team: homeTeam, parkName: "Unknown", runsFactor: 1.0, hrFactor: 1.0 };
}
