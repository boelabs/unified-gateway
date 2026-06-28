# Unified Gateway

Unified Gateway is a backend-only, provider-agnostic AI gateway. It exposes stable OpenAI-shaped public
endpoints while routing requests to provider-specific upstream APIs through adapters.

Unified Gateway is developed by Boelabs as shared infrastructure for the products and services we run or
plan to run.

It is built for teams that want one public model catalog, one auth/rate-limit/logging layer, and one
predictable contract across OpenAI, Anthropic, Google, Azure, OpenAI-compatible providers, and custom
models.

## Highlights

- Exact OpenAI-compatible public contracts for Chat Completions, Responses, Images, Embeddings, Audio Transcriptions, and Models.
- Anthropic-compatible `/v1/messages` rendering over the same canonical core.
- Provider adapters for OpenAI, OpenAI-compatible APIs, Google AI Studio, Anthropic, Azure OpenAI, Azure Foundry, DeepSeek, MiniMax, Moonshot, and ZAI.
- Public model aliases, weighted pools, cooldowns, retries, dedicated fallbacks, and per-operation transports.
- Master key plus virtual keys with model scopes, RPM/TPM limits, budgets, and rate-limit headers.
- Opt-in response cache, request logs, cost accounting, OpenTelemetry metrics/traces, daily Postgres partitions, and graceful shutdown.
- Admin API and OpenAPI spec for operating deployments, keys, router settings, logs, usage, and fallbacks.
- Runtime extensions stored in Postgres and managed through the Admin API for request/response/stream/image hooks without forking the gateway.

## Status

Unified Gateway is pre-1.0. The main contracts are covered by unit and integration tests, but breaking
changes are still possible while the adapter surface and admin API settle.

## Monorepo layout

This repository is a [Turborepo](https://turborepo.com) managed with [Bun](https://bun.sh) workspaces.

```
.
├── apps/
│   ├── gateway/        # the Unified Gateway service (runs on Bun; see apps/gateway)
│   └── docs/           # documentation site (Next.js, Fumadocs, MDX)
├── packages/
│   └── tsconfig/       # shared TypeScript configuration (@boelabs/tsconfig)
├── turbo.json          # task pipeline
└── package.json        # workspace root (bun workspaces + turbo)
```

Dependencies, tasks, and the gateway runtime are all **Bun** (with Turbo orchestrating the workspace);
Bun runs TypeScript directly, so there is no build step. One caveat: Bun's TLS may not accept
self-signed Postgres/Redis certificates — connect to those over a private network without TLS, or via a
managed provider with a public-CA certificate (see [Known errors](apps/docs/content/docs/known-errors.mdx)).

```bash
bun install          # install every workspace
bun run dev          # run all dev tasks via turbo (gateway + docs)
bun run typecheck    # typecheck every package
bun run test         # unit tests across packages
bun run check        # Biome format + lint (whole repo)
```

To work on a single package, use `--filter`, e.g. `bun run --filter @boelabs/unified-gateway dev`.

## Documentation

Docs are authored in MDX under [`apps/docs/content/docs`](apps/docs/content/docs) and rendered as a Fumadocs site
(`bun run --filter @boelabs/docs dev`).

- [Overview](apps/docs/content/docs/index.mdx) — what Unified Gateway is and a documentation map
- [Quickstart](apps/docs/content/docs/quickstart.mdx) — clone to first response, end to end
- [Setup](apps/docs/content/docs/setup.mdx) — requirements, environment, secrets, and database choices
- [Deployment](apps/docs/content/docs/deployment.mdx) — Docker Compose and per-platform guides (Coolify, Portainer, Dokploy, Linux)
- [Concepts](apps/docs/content/docs/concepts.mdx) — the mental model and request flow
- [Creating deployments](apps/docs/content/docs/creating-deployments.mdx) — provider setup and custom model examples
- [Virtual keys](apps/docs/content/docs/virtual-keys.mdx) — client keys, scopes, budgets, and limits
- [Fallbacks](apps/docs/content/docs/fallbacks.mdx) — fallback semantics and lifecycle
- [Caching](apps/docs/content/docs/caching.mdx) — the opt-in response cache and its headers
- [Model catalog](apps/docs/content/docs/model-catalog.mdx) — catalog schema and capability profiles
- [Runtime extensions](apps/docs/content/docs/extensions.mdx) — uploading extensions, hooks, and versioning
- [Operations](apps/docs/content/docs/operations.mdx) — production runbook
- [API reference](apps/docs/content/docs/api.mdx) — OpenAPI, authentication, and import notes
- [Errors](apps/docs/content/docs/errors.mdx) — error shape, status codes, and troubleshooting
- [Known errors](apps/docs/content/docs/known-errors.mdx) — exact symptoms and fixes (self-signed TLS on Bun)
- [Testing](apps/docs/content/docs/testing.mdx) — test strategy and commands

## Requirements

- Bun 1.3+ (gateway runtime, package manager, and task runner)
- Postgres 18+
- Redis 8+

Local dependencies — for development, start just Postgres and Redis and run the gateway on the host:

```bash
bun install
docker compose -f docker-compose.yml -f compose.local.yaml up -d postgres redis
```

To run the **whole stack** in containers instead (gateway + docs + dependencies), see
[Full stack with Docker Compose](#full-stack-with-docker-compose).

## Environment

Create `.env` and set at least:

```bash
PORT=4000
NODE_ENV=development
MASTER_KEY=replace-with-a-long-secret
CREDENTIALS_ENCRYPTION_KEY=64_hex_chars_32_bytes
DATABASE_URL=postgres://gateway:gateway@localhost:5432/unifiedgateway
REDIS_URL=redis://localhost:6379
```

The gateway ships production-ready defaults, so you only set what you actually want to turn on:

```bash
# Export OpenTelemetry (off by default; set both to start exporting)
OTEL_ENABLED=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

Runtime extensions need no configuration to enable — they are uploaded and configured at runtime
through the Admin API (see the extensions guide).

Everything else has a sensible default — override only if you need to. The most common ones, shown
with their defaults:

```bash
MAX_STRING_LENGTH_PROMPT_IN_DB=8000          # prompt/response truncation in request_logs
SHUTDOWN_TIMEOUT_MS=10000                     # drain budget on SIGTERM/SIGINT
UNIFIED_GATEWAY_EXTENSION_MAX_FAILURES=3          # consecutive hook failures before an instance is disabled
REQUEST_LOG_PARTITION_CREATE_DAYS=7          # future daily partitions kept ahead
REQUEST_LOG_PARTITION_RETENTION_DAYS=30      # daily partitions retained before drop
REQUEST_LOG_PARTITION_JOB_INTERVAL_MS=3600000
OTEL_METRIC_EXPORT_INTERVAL_MS=60000
OTEL_LOG_PAYLOADS=true                        # full payloads on OTEL span events
```

`OTEL_LOG_PAYLOADS=true` emits full request/response/error payloads to OTEL span events. DB logs are still truncated by `MAX_STRING_LENGTH_PROMPT_IN_DB`.

## Run

The gateway lives in `apps/gateway`; create its `.env` there (see `apps/gateway/.env.example`). Run
its scripts with Bun's `--filter`, or from inside the package directory.

```bash
bun run --filter @boelabs/unified-gateway db:migrate
bun run --filter @boelabs/unified-gateway dev
```

Health probes:

```bash
curl http://localhost:4000/health/live    # liveness (no dependencies)
curl http://localhost:4000/health/ready   # readiness (Postgres + Redis + extensions)
```

Production runs the container image (`apps/gateway/Dockerfile`, built from the repo root):

```bash
docker build -f apps/gateway/Dockerfile -t unified-gateway .
```

The documentation site has its own image (`apps/docs/Dockerfile`, also built from the repo root;
`next build` served with the standard `next start` server on Node):

```bash
docker build -f apps/docs/Dockerfile -t unified-docs .
```

### Full stack with Docker Compose

`docker-compose.yml` is the production/PaaS base: it brings up Postgres, Redis, a one-off migration
job, the gateway (`:4000` internally), and the docs site (`:3000` internally) without publishing host
ports. Coolify, Dokploy, and similar platforms should deploy that file directly and expose only the
gateway and, optionally, docs through their proxy.

For local development or a single host where the reverse proxy connects through loopback, explicitly
merge `compose.local.yaml`. It publishes all four ports on `127.0.0.1` and provides known
development-only secrets so local startup remains turnkey. The production base leaves both secrets
empty and the gateway refuses to start until they are configured. Set real values in
Portainer/Coolify/Dokploy or export them on a direct Docker host:

```bash
MASTER_KEY=$(openssl rand -base64 48) \
CREDENTIALS_ENCRYPTION_KEY=$(openssl rand -hex 32) \
docker compose -f docker-compose.yml -f compose.local.yaml up -d
```

The deployment base keeps the widely auto-detected `docker-compose.yml` name; see
[Compose files and naming](apps/docs/content/docs/deployment.mdx#compose-files-and-naming) for the
`.yml`/`.yaml` rationale and platform behavior.

`DATABASE_URL` and `REDIS_URL` default to the internal `postgres` / `redis` services and only need
overriding if you point at managed instances. For local development, start only the dependencies
(`docker compose -f docker-compose.yml -f compose.local.yaml up -d postgres redis`) and run the
gateway with `bun run dev` as above.

## Scripts

Root scripts fan out across the workspace via Turbo; gateway-specific scripts run with
`bun run --filter @boelabs/unified-gateway <script>`.

| Script | Where | Description |
|---|---|---|
| `bun run dev` | root | All dev servers via Turbo (gateway + docs). |
| `bun run typecheck` | root | TypeScript check across packages. |
| `bun run test` | root | Unit tests across packages. |
| `bun run check` | root | Biome format + lint (whole repo). |
| `… --filter @boelabs/unified-gateway start` | gateway | Production server (Node). |
| `… --filter @boelabs/unified-gateway test:integration` | gateway | Integration tests (requires Postgres + Redis). |
| `… --filter @boelabs/unified-gateway db:generate` | gateway | Generates a Drizzle migration from `src/db/schema.ts`. |
| `… --filter @boelabs/unified-gateway db:migrate` | gateway | Applies pending Drizzle migrations. |
| `… --filter @boelabs/docs dev` | docs | Run the documentation site locally. |

Migrations are generated from `src/db/schema.ts` with drizzle-kit (`db:generate`) and applied with
Drizzle's migrator. The partitioned `request_logs` table and the `router_settings` seed — which
drizzle-kit cannot express — are hand-tuned in the baseline migration.

## Inference API

All `/v1/*` endpoints accept `Authorization: Bearer <master-or-virtual-key>` or `x-api-key`.

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations` (JSON; JSON response or SSE)
- `POST /v1/images/edits` (multipart; JSON response or SSE)
- `POST /v1/embeddings` (JSON; OpenAI-compatible response)
- `POST /v1/audio/transcriptions` (multipart; JSON, plain-text, or SSE per `response_format`)
- `GET /v1/models`
- `GET /v1/models/:model`

Every response includes `x-request-id`. Virtual-key requests also include `x-ratelimit-*` headers when RPM/TPM/budget limits exist.
Opt-in response caching uses `x-unified-cache: true` and optional `x-unified-cache-ttl: <seconds>`.

Image payloads are always returned as `b64_json`. `response_format` may be omitted (or set to
`b64_json`); URL image responses are not part of the public contract.
All returned PNG, JPEG and WebP files are re-encoded to remove upstream metadata. Product/owner
metadata can be added with an operator-managed runtime extension.
For Gemini 3.1 Flash Image, image `quality` maps to native thinking: `auto`/omitted and `low`
use `thinkingLevel: minimal`, while `high` uses `thinkingLevel: high`. Other Gemini image models
currently expose only `quality: auto`.

## Runtime Extensions

Extensions let operators attach trusted ESM modules without modifying the source tree or rebuilding
the official image. Code and configuration live in Postgres and are managed entirely through the Admin
API — no files, volumes, or manifests. Upload a module with the master key and every replica hot-reloads
it automatically:

```bash
curl -X POST "$GATEWAY/admin/extensions/artifacts" \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg code "$(cat chat-defaults.mjs)" '{ key: "chatdefaults", code: $code }')"
```

See [the extensions guide](apps/docs/content/docs/extensions.mdx) and
[`apps/gateway/examples/extensions`](apps/gateway/examples/extensions) for the Admin API, the
extension SDK, versioning, failure behavior, and four worked examples (a prompt-injection firewall, a
PII vault, a provenance watermark, and a tiered image watermark).

Embeddings use the OpenAI-compatible public shape (`input`, `encoding_format`, `dimensions`) and
route through provider-native adapters. OpenAI/OpenAI-compatible deployments use `/embeddings`;
Google AI Studio deployments use `:embedContent` or `:batchEmbedContents`. Google embedding models
currently accept text inputs and float vectors only through this gateway.

## Admin API

Admin endpoints require the master key.

- `GET /admin/operations` — available operations and transports per adapter
- `GET /admin/provider-presets`
- `POST /admin/deployments/resolve`
- `GET|POST /admin/deployments`; `GET|PATCH|DELETE /admin/deployments/:id`
- `GET /admin/keys?limit=50&offset=0&enabled=true&publicModel=claude&q=frontend`
- `POST /admin/keys`
- `PATCH /admin/keys/:id`
- `DELETE /admin/keys/:id`
- `DELETE /admin/cache?callType=chat&namespace=<virtual-key-id>`
- `GET /admin/router-settings`
- `PUT /admin/router-settings`
- `GET /admin/fallbacks`
- `PUT /admin/fallbacks`
- `DELETE /admin/fallbacks/:primaryModel/:reason`
- `GET /admin/extensions` — read-only status of loaded definitions and configured instances

Management success responses use `{ "data": ... }`; paginated lists use `{ "data": [...], "pagination": ... }`.

Fallback chains are keyed by Public Model and failure `reason`; retries are counted per deployment,
not per pool. Full semantics, validation and lifecycle rules:
[the fallbacks guide](apps/docs/content/docs/fallbacks.mdx).

## Provider Setup

> Full step-by-step guide with copy-paste examples for every model type (text, image,
> embeddings, transcription — catalog and custom):
> [the deployments guide](apps/docs/content/docs/creating-deployments.mdx).

A deployment is created in a single call with its API key inline. `publicModel` is the public model name
clients request; `provider` resolves the adapter, required credential keys and default transports.

**Catalog entry — one binary rule:**
- **Known model**: capabilities come from the built-in catalog; `catalogEntry` must be omitted.
- **Custom model**: `catalogEntry` is required and validated 1:1 against the catalog entry shape.

The transport per operation is **inferred** from the adapter; `transportOverrides` is a rare per-operation
override. `pricing` is an optional top-level field for cost accounting.

Known model deployment:

```json
POST /admin/deployments

{
  "publicModel": "gpt-image",
  "provider": "openai",
  "upstreamModel": "gpt-image-2",
  "credentials": { "apiKey": "sk-..." }
}
```

Custom model deployment:

```json
POST /admin/deployments

{
  "publicModel": "mi-img",
  "adapterKey": "openaicompatible",
  "upstreamModel": "some-unknown-model",
  "credentials": { "apiKey": "...", "baseUrl": "https://..." },
  "catalogEntry": {
    "operations": {
      "text.generate": {
        "capabilities": { "tools": true, "vision": false, "reasoning": false, "structuredOutputs": true }
      },
      "image.generate": { "maxN": 1, "outputFormats": ["png"], "responseFormats": ["b64_json"], "sizes": { "1024x1024": {} } }
    }
  }
}
```

Azure v1 uses two independent providers and catalogs. The Azure deployment name must match the
catalog model ID. `baseUrl` can be the resource endpoint or the full `/openai/v1` base; legacy
`/deployments/...` URLs and `api-version` query parameters are rejected:

```json
{
  "publicModel": "azure-gpt",
  "provider": "azureopenai",
  "upstreamModel": "gpt-5.4",
  "credentials": {
    "apiKey": "...",
    "baseUrl": "https://my-resource.openai.azure.com"
  }
}
```

Use `azurefoundry` for models sold directly by Azure such as `DeepSeek-V3.1` or `grok-4.3`;
their upstream transport is Chat Completions, while Unified Gateway still renders all public text contracts.

Use `POST /admin/deployments/resolve` with the same body to inspect the effective capabilities,
operations and transports without saving. Multiple deployments with the same `publicModel` form a
load-balanced pool. Credentials are encrypted and are never returned by the admin API.

`extra_body` is provider-specific. It is an object in generations and a serialized JSON object
in edits multipart. Nested siblings are allowed, but managed fields and unsafe object keys are rejected.

The public endpoints expose their native shapes and the gateway translates them through a single canonical format:

- `/v1/chat/completions`: `response_format`
- `/v1/responses`: `text.format`
- `/v1/messages`: `output_config.format`
- `/v1/images/*`: `ImagesResponse` / `image_generation.*` / `image_edit.*`
- `/v1/embeddings`: OpenAI-compatible list of embedding vectors, with compact vector-safe logging

Known OpenAI, Gemini, and Anthropic models declare `structuredOutputs` in the built-in catalog. `json_object` remains available as legacy JSON mode and does not imply JSON Schema adherence.

## Operations

- `request_logs` is partitioned by day. The runtime creates future daily partitions and drops old ones according to retention env vars.
- Image uploads are streamed to temporary disk, validated, and removed after success, failure, timeout, or cancellation. `IMAGES_MAX_MULTIPART_BYTES` controls the aggregate limit.
- Shutdown handles `SIGTERM`/`SIGINT`, stops accepting traffic, drains HTTP, then closes Redis/Postgres and flushes OTEL.
- `spend_cents` is updated in Postgres on every billed virtual-key request; Redis remains the hot-path counter for enforcement.
- `bun audit --production` is expected to be clean for the production dependency tree.

## API Reference

- OpenAPI: `apps/gateway/openapi.yaml`

See [the API guide](apps/docs/content/docs/api.mdx) for import instructions.

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for the development setup,
conventions, and the checks CI runs. All code, comments, and documentation are written in English.

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md). Please do not open public issues for
security problems.

## License

Released under the [MIT License](LICENSE).
