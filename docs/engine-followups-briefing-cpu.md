# Follow-up: morning briefing misses its slot (Worker CPU limit)

Status: **implemented; pending live verification.** Implementation is COMPLETE on
branch `fix/briefing-cpu-fanout` (Phases 0–5). The chosen rearchitecture spreads the
briefing compute across many cheap invocations (100k req/day budget) instead of
shrinking the sim in a single invocation.

Shipped architecture (see `docs/briefing-cpu-fanout-implementation-outline.md` for the
full design):

- **Per-unit self-fetch fan-out.** The heavy Monte Carlo runs as N separate
  `GET /internal/sim-chunk` sub-invocations (one per candidate unit, baseline sim lives
  in the spec stage). Each sub-invocation gets its OWN CPU budget; the dispatcher tick
  only does one baseline sim + I/O awaits + reduce/assembly.
- **D1 partials, gated stages.** Stage 1 builds+persists the `SimJobSpec`; stage 2 fans
  out and each chunk persists its `UnitPartial`; stage 3 sums partials → `DecisionReport`
  → prepared `ManagerBriefingReport` at `simReducedKey(date)`. `send-briefing` is now a
  read-only delivery of that prepared artifact.
- **Cross-tick retry = daily-delivery guarantee.** Every stage gates on D1 state, so a
  died dispatcher/chunk is resumed on the next of the 12 daily ticks; delivery succeeds
  across ticks until `sentToday`.
- **CRN / decoupled RNG streams.** `simulateMatchup` now draws `mine` and `opponent`
  from independent streams (seed + per-unit stride + chunk), giving Common Random Numbers
  across candidates (low-variance Δ) and exact chunk-sum equivalence. This **changes sim
  outputs** vs. the old single-`62744`-stream design.

Local verification is DONE and green (`vp check` + `vp test`, including the new
`tests/briefing-cpu/full-cycle.test.ts` end-to-end cycle + guarantee test). TWO gates
require live infra and remain **OPEN** (cannot be run from this environment — no live
Yahoo OAuth, no prod D1, no deploy):

- [ ] **F8 win-prob calibration re-run** — the RNG/CRN change shifts `simulateMatchup`
      predictions, so the recorded-outcome backtest (`src/services/CalibrationHarness.ts`,
      Brier/log-loss over closed-out weeks) MUST be re-run on prod data and accepted as
      the new baseline. Run: `GET /admin/calibration?token=<ADMIN_TRIGGER_TOKEN>` (add
      `&sweep=volatility` for the coefficient sweep) against the prod worker. The local
      `nr gm:calibration` only validates SGP denominators (deterministic standings input,
      RNG-independent) — it does NOT cover the win-prob backtest.
- [ ] **Prod CPU confirmation** — observe per-invocation `cpuTimeMs` stays low for the
      new `precompute` (cron) and `/internal/sim-chunk` (fetch) invocations in CF Workers
      Observability for worker `fantasygm-fantasygmworker-prod-cbbdqptg2afhvv5l` (filter
      `$metadata.service`=worker, `$metadata.origin`=`cron`/`fetch`; inspect
      `$workers.outcome`/`$workers.cpuTimeMs`). Drive a real day-cycle via repeated
      `POST /admin/run/scheduler-tick` and confirm spec → partials → reduced → delivered
      with no `exceededCpu`.

Original investigation (root-cause evidence) follows.

## Symptom

The 10am ET "morning briefing" did not send on 2026-06-20 (and misses
intermittently). It is delivered by the `send-briefing` scheduler task, which the
hourly cron `0 12-23 * * *` (`src/infra/crons.ts`) selects once it's due
(`dailyMorningBriefingHourEastern: 10` → 14:00 UTC, `src/infra/free-tier.ts`).

## Root cause

The 14:00 UTC cron invocation **exceeded the Worker CPU limit and was killed
before delivery**. Generating the briefing (`ManagerBriefing.currentBriefing`,
`src/services/ManagerBriefing.ts:1045`) does ~1.6s of synchronous CPU, which sits
right at the invocation's effective ceiling and tips over ~1-in-5 runs.

This is chronic, not a one-off: over a ~44h window, **19 of ~100 invocations ended
`exceededCpu`** (Cloudflare Workers Observability, prod worker
`fantasygm-fantasygmworker-prod-cbbdqptg2afhvv5l`).

### Evidence (CF Workers Observability, 2026-06-20)

Cron invocation outcomes that morning (each `0 12-23 * * *` firing):

| Tick (UTC) | ET       | outcome       | note                                              |
| ---------- | -------- | ------------- | ------------------------------------------------- |
| 12:00      | 8am      | `exceededCpu` | reached "scheduler tick completed", died after    |
| 13:00      | 9am      | `exceededCpu` | killed ~instantly (cold-start CPU)                |
| **14:00**  | **10am** | `exceededCpu` | **briefing slot — killed at ~2.6s wall, no send** |
| 15:00      | 11am     | `ok`          | ran a lighter task; did NOT regenerate+send       |

Manual `/admin/preview/briefing?live=1` retries at 15:00–15:04 also returned
`503 exceededCpu` (and `500` on the non-live preview), so the manual kick failed too.

CPU distribution of **successful** invocations (last ~44h):

| metric                           | CPU (ms) |
| -------------------------------- | -------- |
| min                              | 4        |
| p50                              | 53       |
| p90                              | 1597     |
| max (ok)                         | 1633     |
| kills (`exceededCpu`) cluster at | ~2010    |

## Plan / limits facts (verified via Cloudflare API)

- Account is **Workers Free** — subscriptions list shows only "Cloudflare Free
  Plan" ($0) and "Teams Free Base"; **no Workers Paid subscription**.
- Worker `usage_model: "standard"`, **no custom `limits` block** set.
- Docs nominal Free CPU limit is **10 ms/invocation**, but enforcement is clearly
  soft here: `ok` invocations routinely run to ~1.6s and only get killed ~2s.
  Treat **~2s as today's empirical ceiling and 10 ms as the un-guaranteed floor**
  that could be enforced at any time. Design for the 10 ms case to be safe.
- Free request budget is generous: **100k requests/day**
  (`FREE_TIER_MODE.workerRequestsPerDayBudget`), **50 external subrequests /
  invocation** (`maxExternalSubrequestsPerInvocation`). This is the lever — trade
  the abundant request budget for the scarce per-invocation CPU.

## Where the CPU goes

Almost entirely **Monte Carlo simulation** in `src/services/DecisionEngine.ts`,
driven by `rankAddCandidates` (line 818):

- `PRODUCTION_SIMULATION_COUNT = 5000` (line 26).
- `simulateMatchup` (line 392) is called **7× per briefing**: 1 baseline
  (line 826) + up to `MAX_SIMULATED_ADD_CANDIDATES = 6` candidates (lines 843–851).
- Each call = 5000 iters × `sampleTeam` for both rosters × ~7–8 `sampleNormal`
  (Box–Muller: `Math.log`/`Math.cos`) per player → ~7M `sampleNormal` calls total.
- Everything else (lineup build `DailyLineupAdvisor.ts`, `planTransactions`,
  `buildManagerBriefing`) is negligible by comparison.

### Why the "obvious" dedup does NOT work (important)

Tempting idea: the opponent roster is constant and all 7 calls use seed `62744`,
so cache the opponent's 5000 samples once. **This breaks bit-for-bit**, because
`simulateMatchup` draws mine and opponent from **one shared RNG stream**, mine
first (`DecisionEngine.ts:410-412`):

```ts
const mine = sampleTeam(myRoster, random); // consumes a data-dependent # of draws
const opponent = sampleTeam(opponentRoster, random); // starts wherever mine left off
```

Candidate calls pass `[...scoringRoster, candidate]` as `myRoster`, so `mine`
consumes a different number of draws (and `sampleNormal` skips its 2 draws when a
stat ≤ 0, line 261) — shifting the opponent's stream offset every call. So the
opponent samples are genuinely different across the 7 calls; they cannot be reused
without changing output. Any real CPU win therefore changes the numbers and needs
a calibration re-run.

## Rearchitecture direction (chosen)

Spend requests to save per-invocation CPU. Break the briefing into many small,
cheap invocations that each stay well under the CPU limit, persist partial results
to KV/D1, and have the 10am `send-briefing` just **assemble + deliver cached
pieces** (near-zero CPU).

Sketch:

1. **Fan out the simulation.** Run `baseline` and each of the ≤6 candidate
   `simulateMatchup` calls as **separate invocations** (self-`fetch` to an internal
   route, or one extra cron minute each). 7 invocations × ~1 cheap sim each instead
   of 1 invocation × 7 sims. With 100k req/day, the request cost is trivial.
   - Even better: chunk a single `simulateMatchup`'s 5000 iters across N
     invocations (e.g. 5×1000), accumulating `wins/marginSum/...` into KV. This
     makes each invocation's CPU ~constant regardless of the 10 ms vs 2s ceiling.
2. **Precompute on earlier ticks, deliver on the 10am tick.** The scheduler
   already separates `refresh-projections` / `refresh-context` / `send-briefing`
   (`src/services/Scheduler.ts`). Add a "precompute-rankings" task that lands the
   finished `rankAddCandidates` output in KV before 10am; `send-briefing` then only
   formats + sends.
3. **Cache the heavy plan artifact.** `LAST_MANAGER_BRIEFING_CACHE_KEY` already
   exists; extend so the expensive `TransactionPlan` is computed once/day and the
   morning send reads it.

Open questions / watch-outs:

- Determinism across split invocations: to keep results reproducible, seed each
  chunk deterministically (e.g. derive per-chunk seed from `62744 + chunkIndex`)
  and document that this is a deliberate change from the single-stream design.
- Consider decoupling mine/opponent RNG streams as part of this (enables Common
  Random Numbers across candidates = lower-variance Δ at the same sample count).
- KV write/read budget and eventual consistency between chunks.

## Validation

Any change to the sim **must** be checked against the F8 calibration/backtest
harness (`src/services/CalibrationHarness.ts`, `src/routines/calibration.ts`)
before shipping — confirm category win-prob calibration and candidate rankings
hold. The admin tick bypasses F8 (per project notes), useful for manual repro.

## Quick repro / observability

- Worker: `fantasygm-fantasygmworker-prod-cbbdqptg2afhvv5l` (account
  `a04fb4216a0dc5f09245d49326aee310`).
- CF Workers Observability MCP: filter `$metadata.service` = worker name,
  `$metadata.origin` = `cron`; inspect `$workers.outcome` / `$workers.cpuTimeMs`.
- Manual generation endpoint: `GET /admin/preview/briefing?token=…&live=1`.
