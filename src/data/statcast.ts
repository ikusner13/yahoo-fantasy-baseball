import type { Env, StatcastBatter, StatcastPitcher } from "../types";
import { getCachedData, setCachedData } from "./cache";

const SAVANT_LEADERBOARD = "https://baseballsavant.mlb.com/leaderboard/custom";

function currentYear(): number {
  return new Date().getFullYear();
}

/** Parse CSV text into rows. Statcast CSV is all numeric — no quoted fields. */
function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^\uFEFF/, "").trim();
  const lines = clean.split("\n").filter((l) => l.trim());
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = (values[i] ?? "").trim();
    }
    return row;
  });
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function num(val: string | undefined): number {
  const n = parseFloat(val ?? "");
  return Number.isNaN(n) ? 0 : n;
}

export async function getBatterStatcast(
  mlbIds: number[],
  season: number = currentYear(),
  env?: Env,
): Promise<StatcastBatter[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `statcast_batters_${today}`;

  if (env) {
    const cached = await getCachedData<StatcastBatter[]>(env, cacheKey, 12);
    if (cached) {
      const idSet = new Set(mlbIds);
      return idSet.size > 0 ? cached.filter((r) => idSet.has(r.mlbId)) : cached;
    }
  }

  const url =
    `${SAVANT_LEADERBOARD}?year=${season}&type=batter&filter=&min=25` +
    `&selections=xwoba,barrel_batted_rate,hard_hit_percent,avg_hit_speed,k_percent,sprint_speed` +
    `&chart=false&x=xwoba&y=xwoba&r=no&chartType=beeswarm&sort=xwoba&sortDir=desc&csv=true`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Savant batter fetch failed: ${res.status}`);

  const rows = parseCsv(await res.text());

  const all: StatcastBatter[] = rows.map((r) => ({
    mlbId: Number(r.player_id),
    xwoba: num(r.xwoba),
    barrelPct: num(r.barrel_batted_rate),
    hardHitPct: num(r.hard_hit_percent),
    exitVelo: num(r.avg_hit_speed),
    kPct: r.k_percent ? num(r.k_percent) : undefined,
    sprintSpeed: r.sprint_speed ? num(r.sprint_speed) : undefined,
  }));

  if (env) {
    try {
      await setCachedData(env, cacheKey, JSON.stringify(all));
    } catch {
      // non-fatal
    }
  }

  const idSet = new Set(mlbIds);
  return idSet.size > 0 ? all.filter((r) => idSet.has(r.mlbId)) : all;
}

export async function getPitcherStatcast(
  mlbIds: number[],
  season: number = currentYear(),
  env?: Env,
): Promise<StatcastPitcher[]> {
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = `statcast_pitchers_${today}`;

  if (env) {
    const cached = await getCachedData<StatcastPitcher[]>(env, cacheKey, 12);
    if (cached) {
      const idSet = new Set(mlbIds);
      return idSet.size > 0 ? cached.filter((r) => idSet.has(r.mlbId)) : cached;
    }
  }

  const url =
    `${SAVANT_LEADERBOARD}?year=${season}&type=pitcher&filter=&min=25` +
    `&selections=xwoba,barrel_batted_rate,whiff_percent,k_percent` +
    `&chart=false&x=xwoba&y=xwoba&r=no&chartType=beeswarm&sort=xwoba&sortDir=asc&csv=true`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Savant pitcher fetch failed: ${res.status}`);

  const rows = parseCsv(await res.text());

  const all: StatcastPitcher[] = rows.map((r) => ({
    mlbId: Number(r.player_id),
    xwoba: num(r.xwoba),
    whiffPct: num(r.whiff_percent),
    barrelPctAgainst: num(r.barrel_batted_rate),
    kPct: num(r.k_percent),
  }));

  if (env) {
    try {
      await setCachedData(env, cacheKey, JSON.stringify(all));
    } catch {
      // non-fatal
    }
  }

  const idSet = new Set(mlbIds);
  return idSet.size > 0 ? all.filter((r) => idSet.has(r.mlbId)) : all;
}
