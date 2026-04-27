import { WorkersLogger, withLogTags } from "workers-tagged-logger";

const logger = new WorkersLogger();

// ---------------------------------------------------------------------------
// Context setup — call at cron/request entry points
// ---------------------------------------------------------------------------

/** Wrap a function with run-scoped log context (routine name + unique runId). */
export function withRunContext<R>(routine: string, fn: () => R): R {
  return withLogTags({ source: "fantasy-gm", tags: { routine, runId: crypto.randomUUID() } }, fn);
}

// ---------------------------------------------------------------------------
// Domain-specific log helpers
// ---------------------------------------------------------------------------

export function logCronStart(routine: string): void {
  logger.info({ event: "cron_start", routine });
}

export function logCronEnd(routine: string, durationMs: number): void {
  logger.info({ event: "cron_end", routine, durationMs });
}

export function logTelegram(
  contentPreview: string,
  chunks: number,
  success: boolean,
  durationMs: number,
): void {
  const level = success ? "info" : "error";
  logger[level]({ event: "telegram_send", contentPreview, chunks, success, durationMs });
}

export function logLLM(
  model: string,
  touchpoint: string | undefined,
  durationMs: number,
  success: boolean,
  usedFallback: boolean,
): void {
  const level = success ? "info" : "error";
  logger[level]({ event: "llm_call", model, touchpoint, durationMs, success, usedFallback });
}

export function logApiCall(
  label: string,
  durationMs: number,
  statusCode: number,
  cacheHit?: boolean,
): void {
  logger.info({ event: "api_call", label, durationMs, statusCode, cacheHit });
}

export function logRoutineStep(
  step: string,
  durationMs: number,
  metadata?: Record<string, unknown>,
): void {
  logger.info({ event: "routine_step", step, durationMs, ...metadata });
}

export function logCacheResult(cacheKey: string, hit: boolean): void {
  logger.info({ event: hit ? "cache_hit" : "cache_miss", cacheKey });
}

export function logDecisionEvent(
  type: string,
  action: Record<string, unknown>,
  result: string,
): void {
  logger.info({ event: "decision", type, action, result });
}

export function logError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.error({ event: "error", context, message });
}
