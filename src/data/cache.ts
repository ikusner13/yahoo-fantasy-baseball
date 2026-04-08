import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { apiCache } from "../db/schema";
import { logCacheResult } from "../observability/log";

export async function getCachedData<T>(
  env: Env,
  cacheKey: string,
  maxAgeHours?: number,
): Promise<T | null> {
  const row = await env.db.select().from(apiCache).where(eq(apiCache.cacheKey, cacheKey)).get();

  if (!row) {
    logCacheResult(cacheKey, false);
    return null;
  }

  if (maxAgeHours != null) {
    const updatedAt = new Date(row.updatedAt).getTime();
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    if (updatedAt < cutoff) {
      logCacheResult(cacheKey, false);
      return null;
    }
  }

  try {
    logCacheResult(cacheKey, true);
    return JSON.parse(row.data) as T;
  } catch {
    return null;
  }
}

export async function setCachedData(env: Env, cacheKey: string, data: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  await env.db.insert(apiCache).values({ cacheKey, data, updatedAt }).onConflictDoUpdate({
    target: apiCache.cacheKey,
    set: { data, updatedAt },
  });
}
