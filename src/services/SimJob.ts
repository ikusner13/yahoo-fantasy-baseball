// Briefing CPU fan-out (see docs/briefing-cpu-fanout-implementation-outline.md).
//
// Phase 0 scaffolding: the serializable payloads persisted to D1 (via ApiCache) that let the
// Monte Carlo sim be split across many cheap Worker invocations, plus the dated D1 key helpers.
// No behavior change yet — these types/keys are wired up by later phases.

import * as Schema from "effect/Schema";

import { WeeklyBatterLine, WeeklyPitcherLine } from "./ProjectionModel.ts";

const WeeklyLineSchema = Schema.Union([WeeklyBatterLine, WeeklyPitcherLine]);

// Per-category raw Monte Carlo counters for a single sim unit. These sum exactly across chunks and
// across the (decoupled-stream) seed scheme, so reduce can add partials before deriving win probs.
export class UnitPartialCounter extends Schema.Class<UnitPartialCounter>("UnitPartialCounter")({
  category: Schema.String,
  wins: Schema.Finite,
  ties: Schema.Finite,
  marginSum: Schema.Finite,
  marginSqSum: Schema.Finite,
}) {}

// One sim unit's accumulated counters. `iters` is the total iterations these counters cover (the
// sum of the chunk iteration counts when chunked), used as the denominator in reduce.
export class UnitPartial extends Schema.Class<UnitPartial>("UnitPartial")({
  iters: Schema.Finite,
  categories: Schema.Array(UnitPartialCounter),
}) {}

// A candidate add to fan out: the projected line plus its pre-computed season SGP delta (which
// depends on the baseline scout weights, so it is resolved during spec construction — approach (A)).
export class SimJobCandidate extends Schema.Class<SimJobCandidate>("SimJobCandidate")({
  line: WeeklyLineSchema,
  seasonSgpDelta: Schema.Finite,
}) {}

// The pure sim job description: everything a sim-chunk invocation needs to run one unit, plus
// everything reduce needs to rebuild the DecisionReport. Holds no Monte Carlo output itself.
export class SimJobSpec extends Schema.Class<SimJobSpec>("SimJobSpec")({
  scoringCategories: Schema.Array(Schema.String),
  scoringRoster: Schema.Array(WeeklyLineSchema),
  opponentRoster: Schema.Array(WeeklyLineSchema),
  candidates: Schema.Array(SimJobCandidate),
  denominators: Schema.Record(Schema.String, Schema.Finite),
  baseSeed: Schema.Finite,
}) {}

// What stage 1 persists under the `spec` key: the job spec, the baseline unit's partial (approach
// (A) runs the baseline sim inline during spec construction), the total unit count to fan out over,
// and the context timestamp the spec was built from (for staleness invalidation).
export class StoredSimJobSpec extends Schema.Class<StoredSimJobSpec>("StoredSimJobSpec")({
  spec: SimJobSpec,
  baseline: UnitPartial,
  unitCount: Schema.Finite,
  contextAt: Schema.optional(Schema.String),
}) {}

// 36h so a job's keys self-expire (ApiCache treats stale reads as absent), surviving a full
// day-cycle plus cross-tick retries without a separate cleanup job.
export const SIM_JOB_MAX_AGE_MS = 36 * 60 * 60 * 1_000;

const SIM_JOB_KEY_VERSION = "v1";

// dated → self-expiring; reuse easternDateKey for the {date} segment.
export const simSpecKey = (date: string) => `sim:job:${date}:spec:${SIM_JOB_KEY_VERSION}`;

export const simPartialKey = (date: string, unit: number, chunk = 0) =>
  `sim:job:${date}:partial:${unit}:${chunk}:${SIM_JOB_KEY_VERSION}`;

export const simReducedKey = (date: string) => `sim:job:${date}:reduced:${SIM_JOB_KEY_VERSION}`;
