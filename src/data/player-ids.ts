import { eq, like } from "drizzle-orm";
import type { Env, Player } from "../types";
import { playerIds } from "../db/schema";

export interface PlayerIdRow {
  yahooId: string;
  mlbId: number | null;
  fangraphsId: number | null;
  name: string;
  positions: string | null;
  team: string | null;
}

function toRow(row: typeof playerIds.$inferSelect | undefined): PlayerIdRow | null {
  if (!row) return null;
  return {
    yahooId: row.yahooId,
    mlbId: row.mlbId,
    fangraphsId: row.fangraphsId,
    name: row.name,
    positions: row.positions,
    team: row.team,
  };
}

export async function lookupByYahooId(env: Env, yahooId: string): Promise<PlayerIdRow | null> {
  const row = await env.db.select().from(playerIds).where(eq(playerIds.yahooId, yahooId)).get();
  return toRow(row);
}

export async function lookupByMlbId(env: Env, mlbId: number): Promise<PlayerIdRow | null> {
  const row = await env.db.select().from(playerIds).where(eq(playerIds.mlbId, mlbId)).get();
  return toRow(row);
}

export async function lookupByFangraphsId(
  env: Env,
  fangraphsId: number,
): Promise<PlayerIdRow | null> {
  const row = await env.db
    .select()
    .from(playerIds)
    .where(eq(playerIds.fangraphsId, fangraphsId))
    .get();
  return toRow(row);
}

export async function getYahooIdForMlb(env: Env, mlbId: number): Promise<string | null> {
  const row = await env.db
    .select({ yahooId: playerIds.yahooId })
    .from(playerIds)
    .where(eq(playerIds.mlbId, mlbId))
    .get();
  return row?.yahooId ?? null;
}

export async function getYahooIdForFangraphs(
  env: Env,
  fangraphsId: number,
): Promise<string | null> {
  const row = await env.db
    .select({ yahooId: playerIds.yahooId })
    .from(playerIds)
    .where(eq(playerIds.fangraphsId, fangraphsId))
    .get();
  return row?.yahooId ?? null;
}

export async function upsertPlayerIds(env: Env, rows: PlayerIdRow[]): Promise<void> {
  if (rows.length === 0) return;
  await env.db.batch(
    rows.map((r) =>
      env.db
        .insert(playerIds)
        .values({
          yahooId: r.yahooId,
          mlbId: r.mlbId,
          fangraphsId: r.fangraphsId,
          name: r.name,
          positions: r.positions,
          team: r.team,
        })
        .onConflictDoUpdate({
          target: playerIds.yahooId,
          set: {
            mlbId: r.mlbId,
            fangraphsId: r.fangraphsId,
            name: r.name,
            positions: r.positions,
            team: r.team,
          },
        }),
    ) as [any, ...any[]],
  );
}

export async function seedFromYahooRoster(env: Env, players: Player[]): Promise<void> {
  if (players.length === 0) return;
  await env.db.batch(
    players.map((p) =>
      env.db
        .insert(playerIds)
        .values({
          yahooId: p.yahooId,
          mlbId: null,
          fangraphsId: null,
          name: p.name,
          positions: p.positions.join(","),
          team: p.team,
        })
        .onConflictDoUpdate({
          target: playerIds.yahooId,
          set: {
            name: p.name,
            positions: p.positions.join(","),
            team: p.team,
          },
        }),
    ) as [any, ...any[]],
  );
}

export async function matchByName(
  env: Env,
  name: string,
  team?: string,
): Promise<PlayerIdRow | null> {
  // Exact match
  const exact = await env.db.select().from(playerIds).where(eq(playerIds.name, name)).get();
  if (exact) return toRow(exact);

  // Last-name + team match
  const parts = name.split(" ");
  const lastName = parts[parts.length - 1];

  if (team) {
    const byLastAndTeam = await env.db
      .select()
      .from(playerIds)
      .where(like(playerIds.name, `%${lastName}`))
      .get();
    if (byLastAndTeam && byLastAndTeam.team === team) return toRow(byLastAndTeam);
  }

  // Last name only (may be ambiguous)
  const byLast = await env.db
    .select()
    .from(playerIds)
    .where(like(playerIds.name, `%${lastName}`))
    .get();
  return toRow(byLast);
}
