# AGENTS.md

Guidance for AI coding agents working in this repository. Humans should start with
[README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md); this file is the quick, agent-focused
reference.

## What this is

Unified Gateway — a backend-only, provider-agnostic AI gateway. Public endpoints are OpenAI-shaped
(`/v1/chat/completions`, `/v1/responses`, `/v1/images/*`, `/v1/embeddings`, `/v1/audio/transcriptions`,
`/v1/models`) plus an Anthropic-compatible `/v1/messages`. Every request is translated through one
canonical core and routed to provider adapters.

Monorepo — Turborepo on Bun workspaces:

- `apps/gateway` — the service. **Runs on Bun.** Package `@boelabs/unified-gateway`.
- `apps/docs` — documentation site (Next.js + Fumadocs, MDX). Served on Node (`next start`).
- `packages/tsconfig` — shared strict TypeScript config (`@boelabs/tsconfig`).

## Commands (run from the repo root)

| Task | Command |
|---|---|
| Install | `bun install` |
| Run everything (dev) | `bun run dev` |
| Lint + format check (the gate) | `bun run check` |
| Auto-fix formatting + sort imports | `bun run format` |
| Typecheck | `bun run typecheck` |
| Unit tests | `bun run test` |

Gateway-only scripts run with `bun run --filter @boelabs/unified-gateway <script>`: `dev`, `start`,
`db:generate`, `db:migrate`, `test:integration`, `catalog:validate`.

**Before you finish a change**, run `bun run check`, `bun run typecheck`, and `bun run test`. If you
touched the database, router, rate limiting, or admin endpoints, also run `test:integration` (needs a
real Postgres + Redis).

## Conventions

- **Language: English only** — code, comments, identifiers, commit messages, and docs. No exceptions.
- **Runtime is Bun**, not Node. Use `node:*` imports and `process`/`Buffer` freely (Bun implements
  them), but the app is never executed with the `node` binary.
- **Formatting/lint:** Biome is the single source of truth (tabs, double quotes). Don't hand-format;
  run `bun run format`. `organizeImports` is intentionally **off** — import order is owned by
  `scripts/sort-imports.ts` (folded into `bun run format`), which sorts by length, descending.
- **Types are strict** (`packages/tsconfig/base.json`: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, …). Do not weaken the config; fix the types.
- **Commits:** clear, imperative mood. Conventional Commit prefixes are welcome but not required.

## Architecture — keep the layering intact

```
contracts/  → public request/response shapes (OpenAI, Anthropic)
core/       → provider-agnostic canonical hub (the "unified" format)
adapters/   → upstream provider protocols
endpoints/  → HTTP handlers
```

Adapters translate **to/from** the canonical format and must **never leak provider-specific fields
into `core`**. The canonical vocabulary is fixed — see the
[glossary](apps/docs/content/docs/glossary.mdx).

## Database & migrations (Drizzle)

`apps/gateway/src/db/schema.ts` is the source of truth. Change it, then:

```bash
bun run --filter @boelabs/unified-gateway db:generate   # drizzle-kit, emits a migration
bun run --filter @boelabs/unified-gateway db:migrate    # Drizzle migrator, applies pending
```

Gotchas:

- `request_logs` is range-partitioned and `router_settings` carries a seed row — drizzle-kit can't
  express either, so both are **hand-tuned in the baseline `migrations/0000_init.sql`**. The drizzle
  snapshot intentionally treats `request_logs` as a plain table.
- `pgEnum`s must be **`export const`** or drizzle-kit won't emit their `CREATE TYPE`.
- `src/db/migrations/**` is excluded from Biome (drizzle owns its formatting).
- Migrations are forward-only — **never edit an applied migration**; add a new one.

## Adding a provider or model

A new provider touches **four** files: the adapter `index.ts`, its `catalog.json`,
`PROVIDER_REGISTRATIONS` in `src/adapters/index.ts`, and the list in `scripts/validate-catalog.ts`
(forgetting the last means CI never validates the new catalog). Full step-by-step:
[model catalog → Adding catalog entries](apps/docs/content/docs/model-catalog.mdx#adding-catalog-entries).

### Catalog sync

`apps/gateway/src/catalog/sync/` (CLI: `scripts/catalog-sync.ts`, `bun run catalog:sync[:verify]`) is a
**local, report-only** tool — it never writes to any `catalog.json`, and it deliberately has no CI
workflow or automation. It cross-references Vercel AI Gateway and OpenRouter (plus models.dev for
enrichment) and writes `apps/gateway/.source/catalog-sync/REPORT.md` + `report.json` (gitignored) with:
drafted entries for new models (ready to review and paste), stale pricing/context/limit essentials on
existing entries, models no longer listed upstream (deprecation candidates), and numeric conflicts
between sources. A human applies whatever they agree with by hand; `operations` details and everything
beyond the essentials are always human work. `--mode verify` exits non-zero if the report is non-empty
(a local drift check).

Reasoning specs are a special case: no source can express *how* a model controls reasoning
(`ReasoningSpec.kind`/`levels`/`budgets`), so drafts built from models.dev's `reasoning_options` carry
`needsHumanReview: [...]` on the entry. `scripts/validate-catalog.ts` **fails the build** while any entry
has a non-empty `needsHumanReview` — verify the draft against the provider's actual docs and clear the
marker before merging. Hand-edited catalog entries never carry this marker, so manual catalog work is
unaffected.

## Things that will bite you

- **Bun's TLS rejects self-signed Postgres/Redis certificates** (e.g. databases exposed by a raw
  Coolify/Dokploy port). Connect over a private network without TLS, or use a managed provider with a
  public-CA certificate. See [Known errors](apps/docs/content/docs/known-errors.mdx).
- **Background jobs run in-process**, not via cron: `request_logs` partition maintenance (drains the
  default partition, creates/drops daily partitions; guarded by a Postgres advisory lock so only one
  replica runs it per cycle) and `response_states` GC.
- **Integration tests** (`*.integration.test.ts` under `apps/gateway/tests/integration`) need a real
  Postgres + Redis. They are run **one process per file** via `scripts/run-integration.ts` because they
  assume per-file isolation; a single shared `bun test` process leaks connections between files. They
  skip cleanly when the infra is unavailable.
- **Tests must not hit the network.** `tests/support/noRealFetch.ts` blocks real `fetch`; stub
  upstreams with `withStubbedFetch()`. Unit tests are colocated as `*.test.ts` and run with `bun test`.
