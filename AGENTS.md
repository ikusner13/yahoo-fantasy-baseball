# AGENTS.md

Autonomous Yahoo Fantasy Baseball GM. **Full rewrite in progress** on **Effect v4 + Alchemy v2** (Cloudflare). Read `docs/` before changing anything:

- `docs/league-model.md` — league rules + product objective (cumulative-category H2H).
- `docs/strategy.md` — how to win (cited research).
- `docs/current-state.md` — audit of the legacy app (what's wired vs dead).
- `docs/rewrite-plan.md` — phased greenfield plan.
- `docs/decision-engine.md` — the marginal-category-value engine spec.
- `docs/tech-stack.md` — Effect v4 + Alchemy decisions, patterns, and risks.

## `repos/` is vendored, read-only reference — do not edit

`repos/` holds library **source code**, vendored via `git subtree --squash`, so you can learn idiomatic usage from real code instead of human-facing docs ([the git trick](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive/)):

- `repos/effect` — **Effect v4** (`Effect-TS/effect-smol`, `4.0.0-beta.x`). Read for Effect/Layer/Schema/Stream patterns, the unstable AI/HTTP/SQL modules, `migration/`, `cookbooks/`, `ai-docs/`.
- `repos/alchemy` — **Alchemy v2** (`alchemy-run/alchemy-effect`). Read `examples/` and `packages/alchemy` for the Infrastructure-as-Effects model (Stacks, `.bind()`, `Cloudflare.providers()`).

Rules for `repos/`:

- **Reference only — never edit, never import from it in app code.** It's there to read.
- Our linter/formatter/typechecker are configured to ignore it (`.oxfmtrc.json` `ignorePatterns`; `vite.config.ts` `lint.ignorePatterns`; `tsconfig*.json` `exclude`). Don't undo that.
- Update with: `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect-smol.git main --squash` (and likewise `repos/alchemy` ← `https://github.com/alchemy-run/alchemy-effect.git main`).

## Tooling

Vite+ (`vp`). Use `vp check` (format + lint + typecheck) and `vp test`. Do **not** invoke oxlint/oxfmt/vitest/tsc directly or use pnpm/npm directly — go through `vp` (see project CLAUDE.md).
