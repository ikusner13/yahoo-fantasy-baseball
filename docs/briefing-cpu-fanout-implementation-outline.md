# Implementation outline: briefing CPU fix via self-fetch fan-out

Status: **design locked, not yet implemented.** This is the executable plan for the
rearchitecture investigated in `docs/engine-followups-briefing-cpu.md` (read that first
for root-cause evidence). This doc is self-contained: an implementer should not need to
re-derive the architecture.

## Goal & locked decisions

- **Problem:** the morning briefing's Monte Carlo sim does ~1.6s synchronous CPU in a
  single Worker invocation and gets `exceededCpu`-killed ~19% of runs (Workers Free,
  empirical ceiling ~2s, nominal 10ms). See the root-cause doc.
- **User requirement (relaxed):** the strict 10am ET slot is **no longer required**.
  The hard requirement is **at least one successful briefing send per day** so the
  manager can set their lineup. **Pickup/add recommendations are considered part of
  setting the lineup** — the full `DecisionReport` (baseline + add candidates) must be
  delivered, not a lineup-only subset.
- **Chosen architecture:** **Full self-fetch fan-out.** Spend the abundant request
  budget (100k/day) to buy per-invocation CPU. Break the sim into many cheap
  invocations, persist partials to D1, assemble + deliver from cache.
- **Sim granularity:** **per-unit fan-out + Common Random Numbers (CRN).** One
  self-`fetch` invocation per "sim unit" (baseline + each candidate = 7 units). CRN
  (decoupled RNG streams) makes each candidate's Δ low-variance so iteration count can
  later drop. Iteration-level chunking is kept as a **config knob** (`simChunksPerUnit`,
  default 1) for the case where the 10ms nominal limit ever gets enforced.

## Free-tier constraints (verified — see root-cause doc)

- 1 cron trigger max (`FREE_TIER_MODE.maxCronTriggers: 1`). Current cron:
  `0 12-23 * * *` → `scheduler-tick` (`src/infra/crons.ts`), 12 hourly ticks 12:00–23:00
  UTC (8am–7pm ET).
- 100k requests/day; **50 external subrequests / invocation** (`fetch()` counts; D1/KV
  binding calls do NOT count).
- ~2s empirical CPU ceiling per invocation, 10ms un-guaranteed floor.

## Current architecture (as-is)

Flow for a send:

```
cron 0 12-23 → registerCron → dispatchRoutine("scheduler-tick")   (src/routines/dispatch.ts:30)
  → Scheduler.tick → selectDueTask → runTask("send-briefing")     (src/services/Scheduler.ts:423,348)
    → ManagerBriefing.currentBriefing                              (src/services/ManagerBriefing.ts:1045)
      → TransactionPlanner.currentPlan                             (src/services/TransactionPlanner.ts:908)
        → rankAddCandidates(set, snapshot, categoryTotals)         (src/services/DecisionEngine.ts:818)  ← CPU HOG
        → planTransactions(report, set, snapshot)                  (src/services/TransactionPlanner.ts:626)
      → DailyLineupAdvisor.forDate (no sim)
      → buildManagerBriefing(plan, lineup, writeStatus)            (src/services/ManagerBriefing.ts:799)
    → cache.put(LAST_MANAGER_BRIEFING_CACHE_KEY, briefing)         (Scheduler.ts:350)
    → deliverManagerBriefing(briefing, telegram, discord)          (src/routines/delivery.ts)
```

Where the CPU goes (`DecisionEngine.ts`):

- `PRODUCTION_SIMULATION_COUNT = 5000` (line 26); `MAX_SIMULATED_ADD_CANDIDATES = 6` (line 27).
- `simulateMatchup` (line 392) called **7×** in `rankAddCandidates`: 1 baseline (line 826)
  - up to 6 candidates (line 845). Each: 5000 iters × `sampleTeam` for both rosters.
- Baseline alone ≈ 230ms (safe). The 6 candidate sims add ~1.4s (the cliff).

Storage primitives available:

- **D1** via `ApiCache` (`src/services/ApiCache.ts`): `get(key, schema, maxAgeMs)`,
  `put(key, value)`, `getOrRefresh*`. Backed by `apiCache` table (key→JSON, `updatedAt`).
  **Strongly consistent read-after-write** (unlike KV) — use D1 for partials.
- KV (`LeagueStateCache`) — used for OAuth; eventually consistent, **do not** use for
  fan-out partials.
- R2 (`ProjectionArtifacts`) — available, not needed here.

Self-fetch is possible: `publicOriginFor(request, url)` exists (worker.ts:81) and the
prod URL is hardcoded as a fallback. Admin routes are guarded by `ADMIN_TRIGGER_TOKEN`.

## Target architecture (to-be)

Four cheap stages coordinated through D1. Each stays well under the CPU ceiling.

```
STAGE 1  precompute:spec   (tiny CPU)  — build job spec, persist
STAGE 2  sim-chunk         (the work)  — N self-fetch invocations, one per (unit[,chunk]); each persists its partial
STAGE 3  precompute:reduce (tiny CPU)  — sum partials → DecisionReport → TransactionPlan → ManagerBriefingReport, persist as "prepared briefing"
STAGE 4  send-briefing     (tiny CPU)  — read prepared briefing, deliver
```

### Determinism & CRN (the load-bearing correctness change)

Today `simulateMatchup` draws `mine` then `opponent` from **one shared RNG stream**
(`DecisionEngine.ts:399,410-412`). Candidate calls pass `[...scoringRoster, candidate]`,
which consumes a data-dependent number of draws (and `sampleNormal` skips 2 draws when a
stat ≤ 0, line 261), shifting the opponent's stream offset every call — so opponent
samples differ across the 7 calls and **cannot be split or reused**.

**Fix:** give `mine` and `opponent` independent streams:

```ts
// in simulateMatchup, replace the single createRandom(seed):
const randomMine = createRandom(seed);
const randomOpp = createRandom((seed ^ 0x9e3779b9) >>> 0); // distinct, deterministic
...
const mine = sampleTeam(myRoster, randomMine);
const opponent = sampleTeam(opponentRoster, randomOpp);
```

Consequences (all desirable):

- **CRN across candidates:** opponent stream is now identical for baseline and every
  candidate (same lines → same draws). `mine`'s shared roster players also consume
  identical draws across calls; only the appended candidate consumes extra draws at the
  end. So `Δ = after − baseline` isolates the candidate's marginal contribution →
  large variance reduction → fewer iterations needed for stable rankings.
- **Chunk independence:** with decoupled streams, chunk `k` of unit `u` can be seeded
  `seed = BASE_SEED + u*STRIDE + k` and the per-chunk counters sum exactly to a single
  run over the union of distinct-seed iterations.
- **This changes outputs** vs. the current single-stream seed `62744`. It is a
  deliberate, documented change → **requires an F8 calibration re-run before shipping**
  (see Validation).

### Refactor `rankAddCandidates` into separable phases

Split the monolith (`DecisionEngine.ts:818`) into three pure exports so the heavy middle
phase is fan-out-able. Keep `rankAddCandidates` as a thin wrapper that calls all three
in-process (so existing callers/tests/`/debug/phase3` keep working).

```ts
// 1. CHEAP: no Monte Carlo. Resolves work-list + everything needed by reduce.
export const prepareSimJob = (set, snapshot, standingsHistory) => SimJobSpec;
//   SimJobSpec = {
//     scoringCategories, scoringRoster (WeeklyLine[]), opponentRoster (WeeklyLine[]),
//     candidates: { line: WeeklyLine, seasonSgpDelta: number }[]  // top MAX_SIMULATED_ADD_CANDIDATES by seasonSgp
//     denominators, baseSeed
//   }
//   (denominators via computeSgpDenominators; candidates via the existing sort/slice at lines 836-842,
//    BUT note weights currently come from the baseline scout — see "weights ordering" below.)

// 2. HEAVY (fan-out target): run ONE unit. unitIndex 0 = baseline, 1..N = candidate i-1.
export const simulateUnit = (spec, unitIndex, chunkIndex = 0, chunkCount = 1) => UnitPartial;
//   UnitPartial = per-category raw counters { wins, ties, marginSum, marginSqSum } + iters
//   roster = unitIndex === 0 ? spec.scoringRoster : [...spec.scoringRoster, spec.candidates[unitIndex-1].line]
//   seed   = spec.baseSeed + unitIndex*STRIDE + chunkIndex
//   iters  = chunkIndex/chunkCount slice of PRODUCTION_SIMULATION_COUNT

// 3. CHEAP: sum partials → DecisionReport (the existing post-sim logic from lines 833-893).
export const reduceSimJob = (spec, unitPartials) => DecisionReport;
```

**weights ordering gotcha:** currently `weights` come from `scoutOpponent(baseline)` AFTER
the baseline sim (lines 833-834), and candidate `seasonSgpDelta` uses those weights
(line 839). So candidate _selection_ (the top-6 sort) depends on the baseline result.
Resolution: `prepareSimJob` cannot know weights without the baseline sim. Two options —
pick (A):

- **(A) Two-phase spec:** spec stage runs the **baseline sim only** (1 sim ≈ 230ms, safe)
  to get weights + candidate selection, persists spec (incl. baseline partial). Fan-out
  then covers only the **candidate** units. This keeps candidate selection identical to
  today. Reduce sums baseline (from spec) + candidate partials.
- (B) Select candidates by an unweighted seasonSgp proxy (changes selection → more
  calibration drift). Avoid unless (A)'s baseline-in-spec is a problem.
  → **Use (A).** It also means the heavy fan-out is **6 units**, not 7.

### New D1 keys (via `ApiCache`, dated so they self-expire by `maxAgeMs`)

Use an Eastern date key (reuse the `easternDateKey` helper already duplicated across
files). Define new `Schema.Class` types for each payload.

| Key pattern                                | Payload                                               | maxAge |
| ------------------------------------------ | ----------------------------------------------------- | ------ |
| `sim:job:{date}:spec:v1`                   | `SimJobSpec` + baseline `UnitPartial` + `unitCount`   | 36h    |
| `sim:job:{date}:partial:{unit}:{chunk}:v1` | `UnitPartial`                                         | 36h    |
| `sim:job:{date}:reduced:v1`                | prepared `ManagerBriefingReport` + `generatedForDate` | 36h    |

`LAST_MANAGER_BRIEFING_CACHE_KEY` stays the delivery source; stage 4 copies the prepared
briefing into it (or stage 3 writes both).

### Internal sim-chunk route

Add to `worker.ts` fetch handler, guarded by `ADMIN_TRIGGER_TOKEN` (same pattern as
existing `/admin/*` routes). Use a dedicated path so it's clearly internal:

```
GET /internal/sim-chunk?token=…&date=YYYY-MM-DD&unit=<n>&chunk=<n>
  → load spec from D1 → simulateUnit(spec, unit, chunk, chunkCount)
  → ApiCache.put(partialKey, partial) → 200 {ok:true, unit, chunk}
```

This handler must be **pure-CPU-cheap**: it reads the spec (1 D1 read), runs one unit's
sim (tens–hundreds of ms), writes one partial. It must NOT rebuild the projection set or
hit Yahoo — all inputs come from the persisted spec. Provide only the layers it needs
(ApiCache + a pure sim layer), not the full Yahoo/projection stack.

### Scheduler changes (`Scheduler.ts`)

Add a `precompute` task type and a dispatcher path. The scheduler keeps a single cron;
it gates stages by checking D1 state, so it is crash-safe and self-healing across ticks.

New `SchedulerTask` member(s): `"precompute"` (does spec + fan-out + reduce). Keep
`send-briefing` but make it read the prepared briefing instead of computing it.

Dispatcher logic per tick (in `runTask("precompute")` or a new method):

1. If no `spec` for today (or projections/context changed) → run **stage 1** (build spec
   incl. baseline sim), persist. Cheap.
2. Compute pending units = `{1..unitCount}` minus units whose partial exists in D1.
   If any pending → `Promise.all(pending.map(u => fetch(self + /internal/sim-chunk?...)))`.
   Each self-fetch is a subrequest (≤50); each persists its own partial. The dispatcher
   only awaits I/O + does no heavy CPU. (For `simChunksPerUnit>1`, fan out unit×chunk;
   keep `units×chunks ≤ ~40`.)
3. If all partials present and no `reduced` artifact yet → run **stage 3** (reduce →
   prepared briefing), persist. Cheap (summing counters + existing post-sim logic +
   `planTransactions` + `buildManagerBriefing`).

`send-briefing` (`Scheduler.ts:348-362`) becomes: read `reduced`/prepared briefing from
D1; if present, deliver + cache + mark complete; if absent, do NOT compute inline — return
not-ready so a later tick retries (this is the guarantee mechanism).

**Cross-tick retry = the daily guarantee.** `selectDueTask` (Scheduler.ts:143) should:

- run `precompute` early and on any tick where the prepared briefing for today is missing
  (so a died dispatcher/chunk is retried on the next tick);
- run `send-briefing` whenever prepared-but-not-sent-today;
- keep retrying both across the 12 ticks until `sentToday`. Each tick is an independent
  CPU budget, so daily delivery probability → ~100%.

Update `DAILY_TASK_LIMITS` (`free-tier.ts`) for the new task and bump `send-briefing`
headroom so retries aren't blocked by the per-day cap. (Today: send-briefing 2,
refresh-context 12.)

### `selectDueTask` ordering (revised)

Rough priority within a tick (adapt the existing function, keep it pure + unit-tested):

1. `refresh-projections` if stale (unchanged).
2. `refresh-context` if briefing window near and context stale (unchanged).
3. `precompute` if today's prepared briefing is missing AND inputs are ready.
4. `apply-lineup` (unchanged; gated on write auth — note repo has no Yahoo write access).
5. `send-briefing` if prepared-and-not-sent-today.
6. else idle.

## Subrequest budget math

With approach (A): 6 candidate units. `simChunksPerUnit=1` → 6 self-fetches per dispatcher
tick (≤50 cap, huge headroom). If chunking is enabled, keep `6 × chunks ≤ ~40`. Daily
request cost is trivial vs. 100k budget even with cross-tick retries.

## Validation (must pass before shipping)

The RNG/CRN change alters sim outputs → **mandatory F8 re-run**:

- `src/services/CalibrationHarness.ts`, `src/routines/calibration.ts`. Confirm category
  win-prob calibration and candidate ranking stability hold vs. baseline.
- Admin calibration endpoint: `GET /admin/calibration?token=…[&sweep=volatility]`
  (worker.ts:337). The admin tick bypasses F8 (per project notes) — useful for manual
  repro.
- Add/extend unit tests:
  - `simulateUnit` chunk-sum equivalence: summing chunk partials == single full-iter run
    for the same unit/seed (decoupled-stream invariant).
  - `reduceSimJob(spec, units)` == current `rankAddCandidates` output **given the same
    RNG scheme** (refactor-equivalence; assert on a fixture set).
  - CRN property: opponent samples identical across baseline and candidate units.
- Manual end-to-end: `POST /admin/run/scheduler-tick` repeatedly (or the new precompute
  task route) → verify spec → partials → reduced → delivered; observe each invocation's
  `cpuTimeMs` stays low in CF Workers Observability
  (`fantasygm-fantasygmworker-prod-cbbdqptg2afhvv5l`, `$metadata.origin=cron`/`fetch`).

## Phased implementation plan

Each phase ends with `vp check` + `vp test` green. Work on a feature branch.

- **Phase 0 — branch + scaffolding.** New branch. Add new `Schema.Class` payload types
  (`SimJobSpec`, `UnitPartial`) and the D1 key helpers. No behavior change.
- **Phase 1 — RNG decouple + CRN** (`DecisionEngine.ts`). Two streams in
  `simulateMatchup`. Add unit tests for the CRN invariant. Run F8; record the new
  calibration as the accepted baseline. _This phase alone reduces variance and is
  independently valuable._
- **Phase 2 — refactor into `prepareSimJob` / `simulateUnit` / `reduceSimJob`**, with
  `rankAddCandidates` as a thin wrapper. Prove refactor-equivalence by test. Use
  approach (A): baseline sim lives in the spec stage.
- **Phase 3 — D1 persistence + internal route.** `/internal/sim-chunk`, dated keys,
  cheap layer wiring. Manually exercise via the route.
- **Phase 4 — scheduler fan-out + reduce + cross-tick retry.** New `precompute` task,
  dispatcher self-fetch, `send-briefing` reads prepared briefing, `selectDueTask` +
  `DAILY_TASK_LIMITS` updates. Unit-test `selectDueTask` transitions.
- **Phase 5 — end-to-end verify on prod-like.** Drive a full day-cycle; confirm CPU per
  invocation and guaranteed daily delivery. Update `docs/engine-followups-briefing-cpu.md`
  status to "fixed".

## Open questions / watch-outs

- **Spec staleness:** if `refresh-context`/`refresh-projections` update inputs after a
  spec is built, the spec (and partials) for today are stale. Decide invalidation: either
  version the spec by a hash of inputs, or rebuild spec (and discard partials) when
  context refreshed after spec time. Simplest: include `contextAt` in the spec and
  rebuild if a newer context exists.
- **Self-fetch origin in cron context:** cron invocations have no inbound request, so
  `publicOriginFor` can't derive a host — use the hardcoded prod workers.dev URL
  (worker.ts:88) as the fan-out base (config it via an env var for non-prod).
- **Reduce CPU sanity:** confirm `optimalAssignments` backtracking (DecisionEngine.ts:602)
  and `planTransactions` stay negligible (root-cause doc says yes); verify in Phase 4.
- **D1 write volume:** ~6 partials + spec + reduced per day, plus retries. Trivial, but
  add a cleanup or rely on dated keys + `maxAge` filtering (reads already treat stale as
  absent).
- **Keep `currentBriefing` live path** for `/admin/preview/briefing?live=1` and
  `/debug/*` — they call the in-process path; leave the thin wrapper intact so they work
  (they may still exceed CPU, but they're manual/admin-only).
- **Determinism doc:** record in code comments that seed scheme changed from single
  `62744` stream to per-unit `BASE_SEED + unit*STRIDE + chunk` with decoupled mine/opp
  streams, and that this is calibrated against F8 as of the change date.

## Key file references (line numbers as of this writing)

- `src/services/DecisionEngine.ts` — `createRandom` 252, `sampleNormal` 260, `sampleTeam`
  274, `simulateMatchup` 392, `scoutOpponent` 467, `rankAddCandidates` 818, constants 26-27.
- `src/services/TransactionPlanner.ts` — `planTransactions` 626, `currentPlan` 908
  (calls `rankAddCandidates` 914).
- `src/services/ManagerBriefing.ts` — `buildManagerBriefing` 799, `currentBriefing` 1045,
  `LAST_MANAGER_BRIEFING_CACHE_KEY` 151, `ManagerBriefingReport` 57.
- `src/services/Scheduler.ts` — `selectDueTask` 143, `runTask` 304 (send-briefing branch
  348), `tick` 423, `DAILY_TASK_LIMITS` 40, task keys 37-38.
- `src/services/ApiCache.ts` — `get`/`put` interface 19-37, D1 impl 45-87.
- `src/infra/crons.ts` — single cron. `src/infra/free-tier.ts` — limits.
- `src/routines/dispatch.ts` — `dispatchRoutine` 19 (scheduler-tick 30).
- `src/worker.ts` — admin routes + `publicOriginFor` 81, prod URL fallback 88, layer
  wiring 247+, fetch handler 325+.
- `src/services/ProjectionModel.ts` — `WeeklyProjectionSet`/`WeeklyBatterLine`/
  `WeeklyPitcherLine` schemas (serializable to D1) 224-281.

```

```
