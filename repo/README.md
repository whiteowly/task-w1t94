# Facility Commerce & Operations API

Docker-first, single-node Fastify backend for the Facility Commerce & Operations API Suite.

## Current state

- ✅ Node.js + TypeScript + Fastify runtime
- ✅ Drizzle + better-sqlite3 + SQLite migration path
- ✅ `./init_db.sh` as the only DB initialization path
- ✅ Structured logging with correlation IDs and redaction
- ✅ Normalized error envelope
- ✅ Health/live and readiness endpoints
- ✅ Auth/session primitives with opaque bearer tokens and server-side token hashing
- ✅ Role/permission matrix foundation
- ✅ Catalog management slice (admin create/update/activate/deactivate + authenticated read)
- ✅ Product search/discovery slice (FTS + combined filters + sort + pagination + optional suggestions)
- ✅ Courses/classes/enrollment/waitlist/publish/version-history/attendance slice
- ✅ Commerce core slice: promotions/vouchers, pricing quotes, draft/finalize/cancel orders, offline payments
- ✅ Charging sessions slice: start/end/exception/compensate lifecycle + deterministic kWh handling
- ✅ Reconciliation/reporting/auditor slice: strict lifecycle transitions, KPI reports, persisted CSV exports, auditor read surfaces
- ✅ Initial schema/migration groundwork including:
  - FTS5 table + sync triggers
  - attribute/fitment facet tables
  - FTS vocabulary table for did-you-mean suggestions
  - audit log table with append-only DB triggers
  - order/reconciliation/export/job foundation tables
- ✅ Scheduler foundation for daily exports + draft order expiration
- ✅ Docker runtime and Dockerized broad test wrapper

Primary P4 operational and audit-delivery slices are implemented.

## Runtime

Primary runtime command:

```bash
docker compose up --build
```

Notes:
- Only the runtime `api` service starts by default. The `test` service is profile-gated and does not auto-start.
- For readiness-aware startup on slower machines, use `docker compose up --build --wait`.
- Host port is randomly assigned to avoid collisions (`127.0.0.1::3000`).
- Get assigned port with:

```bash
docker compose port api 3000
```

## Database initialization

Use only:

```bash
./init_db.sh
```

The script creates local directories and runs Drizzle migrations.

## Testing

Broad Dockerized wrapper:

```bash
./run_tests.sh
```

Manual equivalent (explicit test profile):

```bash
docker compose --profile test run --rm test
```

Local targeted iteration:

```bash
npm run lint
npm run test
npm run benchmark:search -- --products=50000 --warmup=12 --samples=60 --clear-cache-per-sample=true --target-median-ms=200
```

### Search performance proof (50k products)

Benchmark command used in hardening pass:

```bash
FACILITY_TIMEZONE=UTC APP_ENCRYPTION_KEY_B64=AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE= DATABASE_URL=/tmp/facility-bench-50k-hardening-v3.db EXPORT_DIR=/tmp/facility-bench-exports npm run benchmark:search -- --products=50000 --warmup=12 --samples=60 --clear-cache-per-sample=true --target-median-ms=200
```

Latest local result:

```json
{"benchmarkId":"21686e19-0c28-4aef-8912-0720106ecad0","products":50000,"targetMedianMs":200,"uncachedMedianMs":2.18,"uncachedP95Ms":2.6,"cachedMedianMs":0.07,"sampleCount":60,"warmupCount":12,"clearCachePerSample":true,"targetMet":true}
```

## Configuration (no env files)

No `.env` files are used or committed.

Runtime config is process-environment only. Key values:

- `DATABASE_URL` (default: `./data/app.db`)
- `EXPORT_DIR` (default: `./data/exports`)
- `FACILITY_TIMEZONE` (required, IANA timezone)
- `APP_ENCRYPTION_KEY_B64` (required; base64-decoded length must be 32 bytes)
- `SCHEDULER_ENABLED` (`true|false`, default `true`)

`docker compose` generates an ephemeral encryption key if one is not provided.

## Main repository contents

- `src/app` - Fastify bootstrap + route registration
- `src/platform` - shared infrastructure (config, db, auth primitives, jobs, logging, errors)
- `src/modules` - domain modules (catalog/training/commerce/charging/reconciliation/audit/export/reporting)
- `drizzle/migrations` - SQL migrations
- `init_db.sh` - DB initialization wrapper
- `run_tests.sh` - broad Dockerized test wrapper

## Implemented endpoints (core foundation)

- `GET /health/live`
- `GET /health/ready`
- `POST /v1/auth/login`
- `POST /v1/auth/logout`
- `GET /v1/auth/me`
- `GET /v1/auth/permissions`
- `POST /v1/auth/bootstrap-admin` (only allowed when no users exist)
- `DELETE /v1/auth/sessions/:id`

## Implemented endpoints (catalog/search slice)

- `POST /v1/catalog/products` (admin-only)
- `PATCH /v1/catalog/products/:id` (admin-only)
- `POST /v1/catalog/products/:id/activate` (admin-only)
- `POST /v1/catalog/products/:id/deactivate` (admin-only)
- `GET /v1/catalog/products/:id` (authenticated staff)
- `GET /v1/catalog/products` (authenticated staff)
- `POST /v1/search/products` (authenticated staff)

Search route highlights:
- SQLite FTS keyword search over product name/description
- Combined category + attributes + fitment filters
- Sort options (`relevance`, `name_*`, `sku_*`, `updated_at_*`)
- Pagination metadata, applied filters metadata, sort metadata
- Optional did-you-mean suggestions from local catalog terms
- In-process 5-minute LRU cache with mutation-triggered invalidation

## Implemented endpoints (training operations slice)

- `POST /v1/courses` (operations manager)
- `PATCH /v1/courses/:id` (operations manager)
- `GET /v1/courses/:id` (authenticated staff)
- `GET /v1/courses` (authenticated staff)
- `POST /v1/classes` (operations manager)
- `PATCH /v1/classes/:id` (operations manager)
- `POST /v1/classes/:id/publish` (operations manager)
- `POST /v1/classes/:id/unpublish` (operations manager)
- `GET /v1/classes/:id` (authenticated staff)
- `GET /v1/classes` (authenticated staff)
- `GET /v1/classes/:id/versions` (authenticated staff)
- `POST /v1/classes/:id/enrollments` (operations manager)
- `DELETE /v1/classes/:id/enrollments/:customerId` (operations manager)
- `GET /v1/classes/:id/enrollments` (operations manager)
- `POST /v1/classes/:id/attendance` (assigned proctor or assigned instructor)
- `GET /v1/classes/:id/attendance` (operations manager, assigned proctor, or assigned instructor)

## Implemented endpoints (commerce core slice)

- `POST /v1/promotions` (admin-only)
- `PATCH /v1/promotions/:id` (admin-only)
- `GET /v1/promotions/:id` (admin-only)
- `GET /v1/promotions` (admin-only)
- `POST /v1/vouchers` (admin-only)
- `PATCH /v1/vouchers/:id` (admin-only)
- `GET /v1/vouchers/:id` (admin-only)
- `GET /v1/vouchers` (admin-only)
- `POST /v1/orders/quote` (sales associate)
- `POST /v1/orders` (sales associate, requires `Idempotency-Key`)
- `GET /v1/orders/:id` (sales associate; owner-only object access)
- `POST /v1/orders/:id/finalize` (sales associate; owner-only object access; requires `Idempotency-Key`)
- `POST /v1/orders/:id/cancel` (sales associate; owner-only object access)
- `POST /v1/orders/:id/payments` (sales associate; owner-only object access)

Commerce highlights:
- Promotion validity windows are canonical local-time fields plus derived UTC helper epochs
- Voucher redemption lock blocks reuse after redemption
- Pricing engine evaluates eligible offers and picks highest valid savings with exclusive/stackable handling
- Money math is integer-based minor units (deterministic)
- Payment reference text is encrypted at rest
- Draft orders expire via the existing scheduled draft-expiration job path

## Implemented endpoints (charging sessions slice)

- `POST /v1/charging/sessions/start` (charging operators: admin, operations manager, sales associate)
- `POST /v1/charging/sessions/:id/end` (charging operators)
- `POST /v1/charging/sessions/:id/exception` (charging operators)
- `POST /v1/charging/sessions/:id/compensate` (charging operators)
- `GET /v1/charging/sessions/:id` (authenticated staff)
- `GET /v1/charging/sessions` (authenticated staff)

Charging highlights:
- explicit lifecycle states (`started`, `ended`, `exception`, `compensated`) with legal transition checks
- end timestamp chronology is enforced (`endedAt` cannot be before `startedAt`)
- deterministic kWh storage in thousandths (`meteredKwhThousandths`) with formatted decimal exposure (`meteredKwh`)
- material state transitions are audit-logged

## Implemented endpoints (reconciliation/reporting/auditor slice)

- `POST /v1/reconciliation/records` (administrator)
- `GET /v1/reconciliation/records` (administrator or auditor)
- `GET /v1/reconciliation/records/:id` (administrator or auditor)
- `POST /v1/reconciliation/records/:id/transitions` (administrator)
- `GET /v1/audit/logs` (auditor)
- `GET /v1/audit/logs/:id` (auditor)
- `POST /v1/reports/kpis/analytics` (auditor)
- `POST /v1/reports/kpis/reconciliation` (auditor)
- `GET /v1/exports` (auditor)
- `GET /v1/exports/:id` (auditor)
- `GET /v1/exports/:id/download` (auditor)

Reconciliation/reporting highlights:
- strict reconciliation lifecycle only allows `pending -> reviewed -> exported -> archived`; skips/backtracks are rejected with `409 CONFLICT`
- each reconciliation transition is timestamped and attributed (`transitionedAt`, `transitionedByUserId`)
- KPI report endpoints return computed datasets plus real persisted export references (`export_jobs` rows)
- exports are local filesystem CSV files only (offline), with persisted metadata + checksum + row count
- scheduled daily analytics/reconciliation exports use the shared scheduler foundation and persist real export references
