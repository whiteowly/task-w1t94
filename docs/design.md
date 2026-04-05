# Facility Commerce & Operations API Suite Design

## System overview

This project is a single-node, Docker-runnable Fastify API on Node.js using TypeScript, Drizzle ORM, and local SQLite storage. It serves a multi-service training and retail facility with role-scoped operational workflows for catalog management, promotions, course scheduling, attendance, charging, checkout, reconciliation, exports, and audit review.

## Primary architecture

- **Runtime:** one Fastify process, one local SQLite database, one in-process scheduler
- **Persistence:** Drizzle + `better-sqlite3`
- **Execution model:** Docker-first via `docker compose up --build`
- **Database setup:** `./init_db.sh` is the only standard DB initialization path
- **Broad verification:** `./run_tests.sh`

## Module map

- `app`: bootstrap, plugin wiring, route registration, shutdown
- `platform/db`: Drizzle client, SQLite PRAGMAs, migration helpers, transaction helpers
- `platform/auth`: password verification, opaque session issuance, session-hash persistence
- `platform/rbac`: role/permission matrix and guards
- `platform/crypto`: AES-GCM encryption/decryption for sensitive fields
- `platform/logging`: structured logs, correlation ID propagation, redaction
- `platform/jobs`: daily exports, draft-order expiration, cleanup jobs
- `platform/errors` / `platform/validation`: shared error and schema boundaries
- `modules/auth`
- `modules/catalog`
- `modules/search`
- `modules/promotions`
- `modules/vouchers`
- `modules/pricing`
- `modules/courses`
- `modules/classes`
- `modules/attendance`
- `modules/charging`
- `modules/orders`
- `modules/payments`
- `modules/reconciliation`
- `modules/reports`
- `modules/exports`
- `modules/audit`

Routes stay thin. Services own business rules. Repositories own Drizzle/SQL access. All sensitive mutations emit audit events.

## Role boundaries

- **Administrators:** catalogs, promotions, pricing-policy configuration
- **Operations Managers:** schedules, instructor assignment, capacity, waitlists, publish/unpublish
- **Proctors and Instructors:** attendance and violations
- **Sales Associates:** order creation, voucher application, checkout, payments
- **Auditors:** immutable audit-log access and reconciliation/export read access

## Persistence and search design

### Core tables

- `users`, `sessions`
- `products`, `products_fts`, `product_attribute_facets`, `product_fitment_facets`
- `promotions`, `promotion_redemptions`, `vouchers`
- `courses`, `class_instances`, `class_instance_versions`, `enrollments`, `attendance`
- `charging_sessions`
- `orders`, `order_lines`, `order_idempotency_keys`, `payments`
- `reconciliation_records`, `reconciliation_transitions`
- `audit_logs`
- `export_jobs`

### SQLite/Drizzle specifics

- Use Drizzle migrations as the authoritative schema history
- Use SQLite WAL mode and foreign keys on startup
- Keep money in integer minor units and metered kWh as thousandths integer for deterministic arithmetic
- Use `better-sqlite3` with short indexed transactions to avoid event-loop stalls

### Search strategy

- Canonical product data remains on `products`
- SQLite **FTS5** virtual table indexes product name/description
- Filterable JSON content is mirrored into indexed facet tables for category/attribute/fitment query speed
- Query flow:
  1. FTS candidate narrowing
  2. facet/category filtering
  3. sorting and pagination
  4. response metadata assembly
- In-process LRU cache with **5-minute TTL** on normalized search requests
- Local spell correction from catalog term dictionary using bounded edit-distance matching
- Verified local benchmark proof: median uncached search latency under **200 ms** on a seeded **50,000-product** dataset using the repo benchmark command documented in `README.md`

## Canonical state and lifecycle models

- **Session:** issued -> active -> revoked|expired
- **Voucher:** available -> redeemed|expired
- **Class publish state:** unpublished <-> published
- **Enrollment:** requested -> enrolled|waitlisted -> canceled, with waitlisted -> enrolled promotion on seat release
- **Attendance:** present|absent|violation
- **Charging session:** started -> ended OR started -> exception -> compensated
- **Order:** draft -> finalized|canceled; finalized -> refunded; unpaid drafts auto-cancel after 30 minutes
- **Reconciliation:** pending -> reviewed -> exported -> archived (strictly linear)
- **Export job:** pending -> running -> completed|failed

## Cross-cutting contracts

### Authentication and sessions

- local username/password login only
- salted password hashes on users
- opaque bearer session tokens
- only token hashes persist server-side
- failed-login counter increments on failure and resets on success

### Promotions and pricing

- canonical promotion validity window is stored in **local facility time**
- derived UTC helper columns may exist for evaluation/indexing, but local-time fields remain authoritative
- applicability selectors can target SKUs, product categories, course categories, class instances, charging billing, membership tiers, and order spend thresholds
- pricing engine computes eligible promotions/vouchers, respects exclusive vs stackable rules, and selects the best valid savings outcome

### Idempotency

- order idempotency keys are **globally unique for 24 hours**
- enforcement uses transactional active-key checks and expiry pruning

### Audit and logging

- append-only audit logs with actor, action, before/after hashes, correlation ID, and chained hashes
- DB-level protections should block audit-log updates/deletes
- structured logs include correlation IDs and redact sensitive data

### Encryption

- AES-GCM for payment references and personal notes
- runtime-provided symmetric key only
- no committed `.env` files or secret placeholders in repo

### Scheduled jobs

- daily analytics CSV export
- daily reconciliation CSV export
- periodic unpaid draft-order expiration sweep
- startup catch-up for missed runs

## Runtime and documentation contract

- primary runtime command: `docker compose up --build`
- primary broad test command: `./run_tests.sh`
- required DB setup path: `./init_db.sh`
- repo-local docs to be maintained during implementation:
  - `README.md`
  - `docs/api-spec.md`
  - `docs/security-boundaries.md`
  - `docs/reviewer-guide.md`
  - `docs/test-coverage.md`

## Implemented capability map

- **Authentication:** local username/password login, session issuance, session revocation, role/permission queries, bootstrap-admin path
- **Catalog/search:** admin product management, FTS search, combined filters, sorting, pagination, did-you-mean suggestions, LRU cache, cache invalidation on catalog mutation
- **Training operations:** course/class management, capacity/waitlist handling, publish/unpublish, version history, roster-bound attendance and violations
- **Commerce:** promotions, vouchers, pricing quotes, draft/finalize/cancel orders, offline payments, idempotency enforcement, voucher reuse blocking, draft-expiry job integration
- **Charging:** started/ended/exception/compensated lifecycle with deterministic kWh thousandths handling
- **Reconciliation/reporting/audit:** strict reconciliation transitions, auditor read access, KPI datasets, persisted CSV export references, local export downloads, append-only audit review surfaces

## Current hardening status

- broad owner runtime gate passed (`docker compose up --build -d --wait` + readiness check)
- broad owner test gate passed (`./run_tests.sh`)
- audit append-only behavior has direct DB-level proof in tests
- sensitive-log redaction has direct logger-path proof in tests
- remaining hardening gaps are limited to finer-grained role-matrix depth, broader object-level auth coverage, wider encryption persistence checks, and deeper scheduler/export end-to-end coverage
