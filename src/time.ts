import type { Env } from "./types";

function normalizeDateOnly(input: string): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(input) ? `${input}T12:00:00Z` : null;
}

export function getEnvNow(env?: Pick<Env, "_nowIso">): Date {
  const raw = env?._nowIso?.trim();
  if (!raw) return new Date();

  const normalized = normalizeDateOnly(raw) ?? raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function getTodayIso(env?: Pick<Env, "_nowIso">): string {
  return getEnvNow(env).toISOString().slice(0, 10);
}

export function setEnvNowOverride(env: Env, raw: string | undefined): void {
  if (!raw) return;
  const normalized = normalizeDateOnly(raw) ?? raw;
  if (!Number.isNaN(new Date(normalized).getTime())) {
    env._nowIso = normalized;
  }
}
