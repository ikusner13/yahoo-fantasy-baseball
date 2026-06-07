# Tech Stack & Architecture Decisions

The full rewrite targets **Effect v4** (application) + **Alchemy v2** (infrastructure-as-code), on Cloudflare. This doc records the decision, what each tool is, the patterns we'll use, how current concerns map onto the new stack, and the risks/open questions. It governs [rewrite-plan.md](./rewrite-plan.md); the engine math is unchanged ([decision-engine.md](./decision-engine.md)).

> Decision date: 2026-06-06. This is a **full rewrite in a new codebase**, not an in-place refactor of [current-state.md](./current-state.md). The old app is kept only as **reference logic to port** (algorithms, endpoints, prompts).

---

## The choices

### Effect v4 — application runtime

[Effect](https://effect.website) is a TypeScript library for typed effects: composable async, **typed errors**, dependency injection via **`Layer`/services**, structured concurrency (fibers), retries/scheduling, and **`Schema`** for validation/codecs. **v4** (beta, Apr 2026) is a runtime rewrite — smaller bundles (a reported worker dropped 900kB→779kB gzipped), a unified package system (all `@effect/*` share one version, e.g. `effect@4.0.0-beta.x`), and 17 unstable modules (AI, HTTP, Schema, SQL, RPC, CLI, workflows, clustering). Core `Effect`/`Layer`/`Schema`/`Stream` model is stable across v3→v4; migration guides exist. ([Effect v4 beta](https://effect.website/blog/releases/effect/40-beta/), [InfoQ](https://www.infoq.com/news/2026/04/effect-v4-beta/))

**Why it fits this app:** our domain is full of fallible I/O (Yahoo/MLB/FG/Odds/Savant/LLM), retries, timeouts, concurrency limits, and multi-source data merges — exactly what Effect's typed errors, `Schedule` retries, and fiber concurrency handle cleanly. `Schema` replaces the fragile positional-index Yahoo JSON parsing ([current-state.md §3](./current-state.md)) with validated decoders. Services/`Layer` give us the testable seams the `gm.ts` monolith lacks.

### Alchemy v2 — infrastructure as Effects

[Alchemy](https://v2.alchemy.run/) is TypeScript-native IaC built **on Effect**: infrastructure and application logic are Effects **in one program** — no separate infra project, no `wrangler.toml` drift. Resources (`Cloudflare.Worker`, `D1Database`, `KVNamespace`, `R2Bucket`, `Queue`) are declared as Effects; **`.bind()` returns the typed client** and auto-wires env vars + platform bindings ("the binding _is_ the client"); `Cloudflare.providers()` supplies lifecycle Layers (compile-time enforced). **Stacks** group resources; **Stages** isolate `dev`/`prod`/`pr-42`; **state files live in the repo**. Deploy via `alchemy deploy [--stage prod]`. ([what-is-alchemy](https://v2.alchemy.run/what-is-alchemy/), [tutorial](https://v2.alchemy.run/tutorial/part-2/), [GitHub](https://github.com/alchemy-run/alchemy))

**Why it fits:** replaces hand-maintained `wrangler` config + manual bindings with a typed program; D1/KV/R2/Worker bindings become typed clients with no `env` lookup; ephemeral PR stages make testing against live resources cheap.

---

## Target shape (canonical patterns)

**One program — infra + worker + handlers:**

```typescript
// alchemy.run.ts — the stack
export default Alchemy.Stack(
  "FantasyGM",
  { providers: Cloudflare.providers() },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1Database("DB");
    const kv = yield* Cloudflare.KVNamespace("KV");
    const worker = yield* Worker; // declared in src/worker.ts
    return { url: worker.url };
  }),
);
```

```typescript
// src/worker.ts — handlers as Effects, bindings as typed clients
export default Cloudflare.Worker(
  "GM",
  { main: import.meta.filename },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1Database.bind(DB); // typed client
    return {
      fetch: Effect.gen(function* () {
        /* HttpServerRequest → HttpServerResponse */
      }),
      scheduled: Effect.gen(function* () {
        /* cron → dispatch routine */
      }), // ⚠ see risk
    };
  }),
);
```

**Layering the domain** (replaces the `gm.ts` monolith):

- `LeagueState` service — builds the Yahoo-truth snapshot; depends on `YahooClient`.
- `YahooClient` service — `fetch` + `Schema`-decoded reads, hand-built XML writes; typed errors (`YahooAuthError`, `YahooRateLimit`, `YahooParseError`).
- `DataServices` — `MlbApi`, `FanGraphs`, `OddsApi`, `Savant`, each a service with its own cache Layer.
- `Projections`, `DecisionEngine`, `ActionLayer` — pure-ish services consuming the above (see [decision-engine.md](./decision-engine.md)).
- `Llm` service — provider routing + fallback (candidate: `@effect/ai`).
- `Notify` service — Telegram out + webhook.

Each service is a `Layer`; routines are `Effect`s that compose services and are unit-testable by providing test Layers. Errors are typed and handled with `Effect.catchTag`; external calls wrapped in `Effect.timeout` + `Schedule` retry; fan-out (e.g. batch platoon/BvP fetches) via `Effect.forEach` with bounded concurrency (replaces the hand-rolled concurrency helper).

---

## Mapping: old → new

| Concern                     | Current ([current-state.md](./current-state.md)) | Rewrite target                                                                   |
| --------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- |
| HTTP server                 | Hono (`worker.tsx`)                              | `@effect/platform` `HttpApi`/`HttpServerResponse` (or thin Hono shim if simpler) |
| Infra / deploy              | `wrangler` + config                              | **Alchemy v2** stack (`alchemy.run.ts`)                                          |
| Bindings (D1/KV/R2)         | `env.*` lookups                                  | `Resource.bind()` typed clients                                                  |
| Yahoo JSON parsing          | positional index, `// TODO verify shape`         | **`Schema`** decoders with typed parse errors                                    |
| Errors / retries / timeouts | ad-hoc try/catch, manual                         | Effect typed errors + `Schedule` + `Effect.timeout`                              |
| Concurrency                 | hand-rolled `fetchWithConcurrency`               | `Effect.forEach({ concurrency })`                                                |
| DI / testability            | inline in `gm.ts` monolith                       | services + `Layer`; test Layers                                                  |
| DB access                   | drizzle-orm + D1                                 | drizzle over D1 binding **or** `@effect/sql` (decide — see opens)                |
| LLM                         | OpenRouter `fetch` + Anthropic fallback          | `Llm` service (candidate `@effect/ai`), same routing                             |
| State (budget/priority)     | KV (the bug)                                     | `LeagueState` from Yahoo; KV only as cache                                       |
| Scheduling                  | `wrangler` cron → `scheduled()`                  | Alchemy cron trigger → `scheduled` Effect ⚠                                      |
| Validation                  | implicit                                         | `Schema` everywhere at boundaries                                                |

---

## Risks & open questions

**Resolved during Phase 0 scaffold:**

- **Cron / scheduled triggers in Alchemy v2 are supported.** Vendored source confirms `Cloudflare.cron(expression).subscribe(...)` registers a runtime `scheduled` listener and attaches the cron expression to the Worker through `CronEventSourcePolicy`. Phase 0 uses this path rather than an external scheduler fallback.
- **Secrets management in Alchemy v2 is supported.** Vendored source confirms two usable patterns: Worker `env` values from `Config.redacted(...)`, and Cloudflare Secrets Store resources bound with `Cloudflare.Secret.bind(...)`. Phase 0 provisions explicit `Cloudflare.SecretsStore` secrets for Yahoo OAuth, Telegram, OpenRouter, Anthropic, and The Odds API credentials.
- **Drizzle 1.0 RC is the correct baseline.** Alchemy's current Drizzle integration expects `drizzle-orm` / `drizzle-kit` `>=1.0.0-rc.1`, and the scaffold pins both to `1.0.0-rc.3`. The RC's native Effect query driver is currently exposed for Postgres (`drizzle-orm/effect-postgres` / `pg-core/effect`); no `effect-d1` export exists in RC3, so the D1 path stays wrapped behind our `Db` service until a native Effect D1 driver lands or we move persistence off D1.

**Deployment prerequisite:**

- `alchemy deploy --stage dev` requires the secret values in the deploying shell or environment (`YAHOO_CLIENT_SECRET`, `YAHOO_REFRESH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `ODDS_API_KEY`). Do not commit them; use a local secret-loading workflow or CI secret store.

**Maturity risk (accepted, but watch):**

- **Effect v4 is beta**; several modules we'd use (AI, HTTP, SQL, Schema) are flagged **unstable** — expect API churn; pin exact versions and budget for migration. Mitigation: core `Effect`/`Layer`/`Schema` are stable; keep unstable-module surface area small and wrapped behind our own services.
- **Alchemy v2 is new** with a small ecosystem and few examples; local state files must be committed and not corrupted across stages.
- **Worker bundle/size limits** — Effect helps post-v4, but verify the bundle stays under Cloudflare's limit with our deps.

**Learning-curve / process:**

- Effect's model (Effect/Layer/Schema/fibers) is a real paradigm shift; the rewrite doubles as ramp-up. Keep services small and well-typed.

**Decisions to make (non-blocking, flag in plan):**

- **DB layer:** keep Drizzle RC over the D1 binding, wrapped in a `Db` service. Native Drizzle Effect support is available for Postgres in RC3, but not for D1.
- **HTTP:** `@effect/platform` HttpApi vs a minimal Hono shim for the handful of routes.
- **Repo layout:** new top-level project replacing `src/`, or a parallel `v2/` dir during port? (Lean: new project; old `src/` becomes `legacy/` reference until parity.)
- **Effect/async handler style:** prefer **Effect-style** handlers (typed errors, retries) over async-style, for consistency with the services.

---

## Reference index for builders

- Alchemy v2: [what-is-alchemy](https://v2.alchemy.run/what-is-alchemy/) · [tutorial](https://v2.alchemy.run/tutorial/part-2/) · [GitHub](https://github.com/alchemy-run/alchemy)
- Effect v4: [v4 beta notes](https://effect.website/blog/releases/effect/40-beta/) · [docs](https://effect.website) · v3→v4 migration guides (linked from the beta notes)
