# Rearchitecture: daily briefing compute moves to GitHub Actions

Status: DRAFT spec (2026-07-04). Direction chosen by owner after the July outage diagnosis.
Companion stopgaps (tick reliability) ship first on the Worker; this doc is the target state.

## Why

The Workers-Free ~2s CPU ceiling forced the briefing into a 4-stage D1-gated state machine
(spec → sim-chunk fan-out on a second worker → reduce → send) advanced one stage per hourly
cron tick. Prod evidence (2026-07-04 diagnosis): that pipeline has **never completed
organically** — every end-to-end success was manually driven, and the surrounding failure
handling (`Effect.orDie`, priority-retry starvation, no alerting) turned single upstream
failures into silent multi-day outages.

GitHub Actions gives the daily job minutes of CPU for free. That deletes the fan-out state
machine, the SimChunkWorker, the one-stage-per-tick dispatcher, and the spec/partial/reduce
D1 protocol — and removes the constraint that kept the sim small (5000 iters × 6 candidates).

## Topology

- **GitHub Actions (new)** — owns all compute and delivery for the daily briefing:
  fetch data → project → simulate (full-fat) → plan → format → send Telegram → record
  retrospective. Runs as a Node CLI entry reusing the existing Effect services.
- **Cloudflare Worker (kept, shrunk)** — custody of rotating Yahoo OAuth tokens (KV),
  the `/telegram` webhook, admin/preview endpoints, and two small new endpoints for the
  GHA job (below). The hourly scheduler cron, precompute pipeline, and SimChunkWorker are
  DELETED once GHA is stable.
- **D1 (kept)** — system of record for `retrospectives`, `player_crosswalk`, standings
  history. The `api_cache` scheduler-state keys become vestigial (job is single-process;
  in-memory caching suffices within a run).

### Worker endpoints the GHA job uses (both behind `ADMIN_TRIGGER_TOKEN`)

```ts
// 1. Yahoo access: worker keeps the rotating refresh token in KV and vends access tokens.
GET /admin/yahoo/access-token
  → { accessToken: string; expiresAt: string }   // runs existing YahooOAuth.refresh

// 2. D1 writes the job needs (retrospectives, crosswalk upserts, standings snapshot):
POST /admin/record { kind: "retrospective" | "crosswalk" | "standings", payload: ... }
  → { ok: true }
```

Rationale: GHA holds only three secrets (`ADMIN_TRIGGER_TOKEN`, `TELEGRAM_BOT_TOKEN`/CHAT_ID,
plus public API keys like ODDS_API_KEY). No Cloudflare API token in GitHub; the Worker stays
the sole holder of Yahoo credentials, and refresh-token rotation (Yahoo rotates on refresh —
`YahooOAuth.ts:63`) keeps its existing KV read-modify-write path with no cross-platform race.

### The daily job (`.github/workflows/briefing.yml` + `scripts/daily-briefing.ts`)

```yaml
on:
  schedule:
    - cron: "45 12 * * *" # ~8:45am ET; GH cron jitter means "sometime 8:45–9:30"
    - cron: "30 14 * * *" # retry slot — job exits early if today already sent
  workflow_dispatch: # manual kick, replaces /admin/run/task chains
```

Flow (single process, plain Effect program, no scheduler state machine):

1. `sentToday` guard — ask the Worker (or D1 read via `/admin/record` sibling GET) whether
   today's briefing already went out; exit 0 if so. This makes the second cron a free retry.
2. Fetch: Yahoo (roster/opponent/FA/matchup **including live category totals**), FanGraphs,
   StatsAPI schedule+probables+lineups, Statcast, odds (ONE fetch/day ≈ 30/mo — also ends
   the monthly odds-quota exhaustion).
3. Compute: projections → Monte Carlo → plan → briefing. No chunking, no D1 partials —
   `rankAddCandidates` runs inline. CPU budget is effectively unlimited; see "Engine
   upgrades" for what that buys.
4. Deliver: Telegram direct. Discord optional later (prod creds absent today).
5. Record: retrospective/calibration row + crosswalk upserts via `POST /admin/record`.
6. `if: failure()` step — send Telegram "⚠️ briefing job failed: <run URL>". GH also emails.
   Silence is impossible: success message, failure message, or the second-slot retry.

## Engine upgrades unlocked (phase 2, same migration — from the 2026-07-04 audits)

The move is the excuse to fix the wrong-answer defects; they land in the CLI job, not the
Worker pipeline:

1. **Seed the sim with banked mid-week totals** (audit D1 — the top defect): add each side's
   accumulated category components (incl. ratio numerators/denominators) as constant offsets
   before the win/tie comparison. Data is already fetched (`snapshot.matchup.categories`).
2. **Filter the opponent roster to a legal active lineup** before proration (audit D3).
3. **Widen the candidate funnel** (audit D2): FA pool 50 → 200+ with position/sort variants;
   simulate 20+ candidates instead of 6, selected by cheap per-category flip heuristics
   against coin-flip categories, not season SGP. (Was CPU-bound; no longer.)
4. **Feed `volatility`** from cross-system projection dispersion (audit D5) and **close the
   calibration loop**: apply the swept volatility once enough weeks close out (harness is
   sound; it's just disconnected — Brier currently ~0.27 over 2 weeks, worse than coin-flip,
   with an overconfident-batting signature that inflated σ would directly correct).
5. Lower-priority modeling: Poisson/neg-binom counting stats (tie mass), season term vs.
   replacement level, batter handedness → park L/R splits, game-park vs home-park.

## Deletion list (after GHA runs green ~1 week)

- `src/sim-chunk-worker.ts` + SimChunkWorker deploy + `SIM_CHUNK_WORKER` binding
- `runPrecompute`, SimJob spec/partial/reduce protocol (`SimJob.ts`, `sim:job:*` keys)
- Scheduler cron + `selectDueTask` task machine (Worker keeps NO cron, or one light
  cron for the dead-man check only)
- The stopgap dead-man/tick-error alerting migrates naturally into the GHA failure step

## Open questions (owner input welcome, defaults chosen)

- Second daily "afternoon update" run? Default NO for v1 — one guaranteed morning briefing.
- Retire `apply-lineup` task? It exists but Yahoo grants no write access (memory: app is
  read-only advisor) — default: drop it in the migration.
- Repo is private? GHA cron requires the repo to have recent activity (60-day disable rule
  for schedules on inactive repos) — the failure-alert + weekly retrospective commits keep
  it active; note it in runbook.
