import type { Env } from "../types";
import { getCachedData, setCachedData } from "./cache";
import { projections } from "../db/schema";

// --- Local raw projection types ---

export interface RawBatterProjection {
  fangraphsId: number;
  name: string;
  team: string;
  pa: number;
  r: number;
  h: number;
  hr: number;
  rbi: number;
  sb: number;
  tb: number;
  obp: number;
}

export interface RawPitcherProjection {
  fangraphsId: number;
  name: string;
  team: string;
  ip: number;
  k: number;
  era: number;
  whip: number;
  qs: number;
  svhd: number;
}

// --- FanGraphs API URLs ---

const BATTER_URL =
  "https://www.fangraphs.com/api/projections?type=steamerr&stats=bat&pos=all&team=0&players=0&lg=all";
const PITCHER_URL =
  "https://www.fangraphs.com/api/projections?type=steamerr&stats=pit&pos=all&team=0&players=0&lg=all";

// --- Fetch projections ---

export async function fetchBatterProjections(
  _season?: number,
  env?: Env,
): Promise<RawBatterProjection[]> {
  if (env) {
    const cached = await getCachedData<RawBatterProjection[]>(env, "fangraphs_batters", 12);
    if (cached) return cached;
  }

  const res = await fetch(BATTER_URL);
  if (!res.ok) throw new Error(`FanGraphs batter projections failed: ${res.status}`);

  const rows = (await res.json()) as any[];

  const result = rows.map((r) => ({
    fangraphsId: Number(r.playerid),
    name: String(r.PlayerName ?? ""),
    team: String(r.Team ?? ""),
    pa: Number(r.PA ?? 0),
    r: Number(r.R ?? 0),
    h: Number(r.H ?? 0),
    hr: Number(r.HR ?? 0),
    rbi: Number(r.RBI ?? 0),
    sb: Number(r.SB ?? 0),
    tb: Number(r.TB ?? 0),
    obp: Number(r.OBP ?? 0),
  }));

  if (env) {
    await setCachedData(env, "fangraphs_batters", JSON.stringify(result));
  }

  return result;
}

export async function fetchPitcherProjections(
  _season?: number,
  env?: Env,
): Promise<RawPitcherProjection[]> {
  if (env) {
    const cached = await getCachedData<RawPitcherProjection[]>(env, "fangraphs_pitchers", 12);
    if (cached) return cached;
  }

  const res = await fetch(PITCHER_URL);
  if (!res.ok) throw new Error(`FanGraphs pitcher projections failed: ${res.status}`);

  const rows = (await res.json()) as any[];

  const result = rows.map((r) => ({
    fangraphsId: Number(r.playerid),
    name: String(r.PlayerName ?? ""),
    team: String(r.Team ?? ""),
    ip: Number(r.IP ?? 0),
    k: Number(r.SO ?? 0),
    era: Number(r.ERA ?? 0),
    whip: Number(r.WHIP ?? 0),
    qs: Number(r.QS ?? 0),
    svhd: Number(r.SV ?? 0) + Number(r.HLD ?? 0),
  }));

  if (env) {
    await setCachedData(env, "fangraphs_pitchers", JSON.stringify(result));
  }

  return result;
}

// --- Store projections to DB ---

export async function storeProjections(
  env: Env,
  batters: RawBatterProjection[],
  pitchers: RawPitcherProjection[],
): Promise<void> {
  const now = new Date().toISOString();
  const season = new Date().getFullYear();

  const batterStmts = batters.map((b) =>
    env.db
      .insert(projections)
      .values({
        yahooId: `fg:${b.fangraphsId}`,
        season,
        playerType: "batter",
        pa: b.pa,
        r: b.r,
        h: b.h,
        hr: b.hr,
        rbi: b.rbi,
        sb: b.sb,
        tb: b.tb,
        obp: b.obp,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projections.yahooId, projections.season],
        set: {
          pa: b.pa,
          r: b.r,
          h: b.h,
          hr: b.hr,
          rbi: b.rbi,
          sb: b.sb,
          tb: b.tb,
          obp: b.obp,
          updatedAt: now,
        },
      }),
  );

  const pitcherStmts = pitchers.map((p) =>
    env.db
      .insert(projections)
      .values({
        yahooId: `fg:${p.fangraphsId}`,
        season,
        playerType: "pitcher",
        ip: p.ip,
        k: p.k,
        era: p.era,
        whip: p.whip,
        qs: p.qs,
        svhd: p.svhd,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [projections.yahooId, projections.season],
        set: {
          ip: p.ip,
          k: p.k,
          era: p.era,
          whip: p.whip,
          qs: p.qs,
          svhd: p.svhd,
          updatedAt: now,
        },
      }),
  );

  // D1 batch limit is 1000 — split if needed
  const allStmts = [...batterStmts, ...pitcherStmts];
  const BATCH_SIZE = 999;
  for (let i = 0; i < allStmts.length; i += BATCH_SIZE) {
    const chunk = allStmts.slice(i, i + BATCH_SIZE);
    await env.db.batch(chunk as [any, ...any[]]);
  }
}
