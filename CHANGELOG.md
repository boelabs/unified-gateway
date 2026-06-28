# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Open-source project scaffolding: MIT `LICENSE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  `SECURITY.md`, GitHub issue/PR templates, and a CI workflow (lint, typecheck, unit + integration
  tests, dependency audit).
- Production `Dockerfile` (multi-stage, non-root, with a container healthcheck) and `.dockerignore`.
- Structured JSON application logger (`src/logging/log.ts`) replacing scattered `console.*` calls.
- Configurable image identity/branding via `IMAGE_BRANDING_PRODUCT` and `IMAGE_BRANDING_OWNER`
  environment variables (previously hardcoded).
- `Setup`, `Deployment` (per-platform: Coolify, Portainer, Dokploy, Docker on Linux), and
  `Known errors` documentation pages.
- Contributor guide for creating provider catalogs and models (the four files to touch, including the
  `validate-catalog` list), in the model-catalog docs and `CONTRIBUTING.md`.

### Changed

- `response_states` GC and the `request_logs` default-partition drain now run automatically as in-app
  jobs (controlled by `RESPONSE_STATE_GC_INTERVAL_MS` and the partition job), replacing the manual
  `gc:response-states` and `db:drain-default` scripts. Partition maintenance takes a Postgres advisory
  lock so only one replica runs it per cycle. The drain also fixes a case where rows stuck in `DEFAULT`
  blocked creation of that day's partition.
- Repository-wide import sorter (`scripts/sort-imports.ts`) folded into `bun run format` and applied
  across the monorepo.
- Migrated the gateway runtime from Node to **Bun** (dev/start/migrate scripts, the production
  `Dockerfile`, and CI; unit tests run under `bun test`).
- Adopted **drizzle-kit** + Drizzle's migrator for database migrations: the schema in
  `src/db/schema.ts` is the source of truth (`db:generate` emits migrations, `db:migrate` applies
  them). The partitioned `request_logs` table and the `router_settings` seed — which drizzle-kit
  cannot express — are hand-tuned in the baseline migration.
- Renamed the project to **Unified Gateway** (`@boelabs/unified-gateway`): environment variables
  (`UNIFIED_GATEWAY_*`), the response-cache headers (`x-unified-cache`), the OpenTelemetry metric
  prefix, and the virtual-key prefix (`unified-`).
- Translated the codebase (comments, internal messages, documentation) to English for open-source
  contribution.
- Documented credential and master-key rotation procedures.

### Fixed

- Audio transcription multipart now sends a clean, deterministic filename to the upstream provider on
  Bun (it previously leaked the local temporary file path).
- Integration tests now run each file in its own `bun test` process (`scripts/run-integration.ts`) with
  a generous per-test timeout. Under shared-process `bun test` they had silently skipped 15 of 25 (one
  file's teardown closed the shared Postgres/Redis connections for the rest), so CI reported green while
  exercising less than half the suite.
- Translated the last Spanish comments to English (`db/repos/requestLogs.ts`, a repos integration test).

### Removed

- `db:verify` development script (the integration tests cover the same CRUD/encryption round-trip).
- `gc:response-states` and `db:drain-default` scripts — their work now runs automatically in-app.
