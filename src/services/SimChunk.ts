import * as Effect from "effect/Effect";

import { ApiCache, ApiCacheError } from "./ApiCache.ts";
import { simulateUnit, StoredSimJob } from "./DecisionEngine.ts";
import {
  SIM_JOB_MAX_AGE_MS,
  simPartialKey,
  simSpecKey,
  specGeneration,
  type UnitPartial,
} from "./SimJob.ts";

// The core of the /internal/sim-chunk handler, shared by BOTH the main worker (manual ops) and the
// separate SimChunkWorker (the cross-worker fan-out target). Factored out (taking ApiCache via the
// Effect context, not a concrete D1) so it runs against the live D1 in either worker AND against an
// in-memory ApiCache test layer without the full Yahoo/projection stack. Living in its own module
// keeps worker.ts and sim-chunk-worker.ts free of a circular import.
export type SimChunkResult =
  | { readonly ok: true; readonly unit: number; readonly chunk: number }
  | { readonly ok: false; readonly reason: "bad-params"; readonly message: string }
  | { readonly ok: false; readonly reason: "spec-missing" };

// Pure-CPU-cheap: 1 D1 read of the spec → simulateUnit (one unit) → 1 D1 write of the partial.
// It must NOT rebuild the projection set or hit Yahoo — every input comes from the persisted spec,
// and simulateUnit is a pure function. The only service it requires is ApiCache.
export const runSimChunk = (params: {
  readonly date: string;
  readonly unit: number;
  readonly chunk: number;
  readonly chunkCount: number;
}): Effect.Effect<SimChunkResult, ApiCacheError, ApiCache> =>
  Effect.gen(function* () {
    const { date, unit, chunk, chunkCount } = params;
    if (!Number.isInteger(unit) || unit < 0) {
      return { ok: false, reason: "bad-params", message: "unit must be a non-negative integer" };
    }
    if (!Number.isInteger(chunk) || chunk < 0) {
      return { ok: false, reason: "bad-params", message: "chunk must be a non-negative integer" };
    }
    if (!Number.isInteger(chunkCount) || chunkCount < 1) {
      return {
        ok: false,
        reason: "bad-params",
        message: "chunkCount must be a positive integer",
      };
    }
    const cache = yield* ApiCache;
    const stored = yield* cache.get(simSpecKey(date), StoredSimJob, SIM_JOB_MAX_AGE_MS);
    if (stored == null) {
      return { ok: false, reason: "spec-missing" };
    }
    const partial: UnitPartial = simulateUnit(stored, unit, chunk, chunkCount);
    // Key the partial by the spec's generation so a rebuilt (newer-context) spec's partials never
    // collide with the old spec's — the dispatcher reads the same generation off the same spec.
    const gen = specGeneration(stored.stored.contextAt);
    yield* cache.put(simPartialKey(date, unit, chunk, gen), partial);
    return { ok: true, unit, chunk };
  });
