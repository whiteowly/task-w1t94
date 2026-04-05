# Facility Commerce & Operations API Spec

## API conventions

- Base path: `/v1`
- JSON request/response bodies
- Auth: opaque bearer session token
- Error envelope:

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable",
    "details": {},
    "correlationId": "uuid"
  }
}
```

- Common status expectations:
  - `400` malformed request
  - `401` unauthenticated / invalid or expired session
  - `403` authenticated but forbidden
  - `404` missing resource
  - `409` lifecycle, idempotency, capacity, or redemption conflict
  - `422` semantic validation failure

## Role capability map

- **Administrator**
  - manage products/catalog
  - manage promotions and vouchers
  - manage pricing policy inputs
- **Operations Manager**
  - manage courses and class instances
  - manage instructor assignment, capacity, waitlists, publish state
- **Proctor / Instructor**
  - record attendance and violations
- **Sales Associate**
  - create orders
  - apply vouchers at checkout
  - record offline payments
- **Auditor**
  - read immutable audit logs
  - access reconciliation and export records

## Route groups

### Authentication

- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`
- `GET /auth/permissions`
- `POST /auth/bootstrap-admin`
- `DELETE /auth/sessions/:id`

Behavior:
- login updates failed-login counter and last-login timestamp
- session endpoints return current user/role/permission context

### Catalog and search

- `POST /catalog/products`
- `PATCH /catalog/products/:productId`
- `GET /catalog/products/:productId`
- `POST /catalog/products/:productId/activate`
- `POST /catalog/products/:productId/deactivate`
- `GET /catalog/products`
- `POST /search/products`

Search contract:
- keyword full-text query
- combined filters: category, attributes, fitment dimensions, active state where relevant
- sorting: explicit allowlist
- response includes:
  - `items`
  - `appliedFilters`
  - `sort`
  - optional `suggestedTerms`

### Promotions and vouchers

- `POST /promotions`
- `PATCH /promotions/:promotionId`
- `GET /promotions/:promotionId`
- `POST /vouchers`
- `PATCH /vouchers/:voucherId`
- `GET /promotions`
- `GET /vouchers`
- `POST /orders/quote`

Behavior:
- supports spend-and-save, percentage, amount, bundles, member tiers, vouchers
- promotion priority, stackability, max redemptions, local-time windows, applicability selectors
- pricing quote returns best eligible savings result plus full breakdown

### Courses, classes, enrollment, attendance

- `POST /courses`
- `PATCH /courses/:courseId`
- `POST /classes`
- `PATCH /classes/:classId`
- `POST /classes/:classId/publish`
- `POST /classes/:classId/unpublish`
- `GET /classes/:classId/versions`
- `POST /classes/:classId/enrollments`
- `DELETE /classes/:classId/enrollments/:customerId`
- `GET /classes/:classId/enrollments`
- `POST /classes/:classId/attendance`
- `GET /classes/:classId/attendance`

Behavior:
- enforce capacity before enrollment confirmation
- waitlist cap maximum 50
- publish/unpublish tracked with version increment and change notes
- attendance state: `present | absent | violation`

### Charging sessions

- `POST /charging/sessions/start`
- `POST /charging/sessions/:sessionId/end`
- `POST /charging/sessions/:sessionId/exception`
- `POST /charging/sessions/:sessionId/compensate`
- `GET /charging/sessions/:sessionId`

Behavior:
- ties session to customer and charger asset
- tracks status, metered kWh, timestamps

### Orders, payments, reconciliation

- `POST /orders`
- `GET /orders/:orderId`
- `POST /orders/:orderId/finalize`
- `POST /orders/:orderId/cancel`
- `POST /orders/:orderId/payments`
- `POST /reconciliation/records`
- `GET /reconciliation/records`
- `GET /reconciliation/records/:recordId`
- `POST /reconciliation/records/:recordId/transitions`

Behavior:
- order creation/finalization honors global 24-hour idempotency keys
- unpaid drafts auto-cancel after 30 minutes
- payment references are encrypted at rest
- reconciliation transitions must be linear and timestamped

### Reports, exports, audit

- `POST /reports/kpis/analytics`
- `POST /reports/kpis/reconciliation`
- `GET /exports`
- `GET /exports/:exportId`
- `GET /exports/:exportId/download`
- `GET /audit/logs`
- `GET /audit/logs/:auditId`

Report contract:
- KPI dataset payload
- persisted export reference for offline download by internal client systems

Audit contract:
- append-only log records with actor, action, before/after hashes, correlation ID

## Access summary

- **Administrator:** catalog, promotions, vouchers, pricing-policy inputs, reconciliation transitions
- **Operations Manager:** courses/classes scheduling, capacity, waitlists, instructor assignment
- **Proctor / Instructor:** attendance and violations
- **Sales Associate:** order creation, voucher application, payments, charging operations
- **Auditor:** immutable audit reads, reconciliation reads, report/export access

## Non-functional API expectations

- median search latency target under 200 ms for 50,000 products
- local did-you-mean suggestions from catalog terms
- structured logs with correlation IDs
- all runtime behavior works offline with local filesystem export persistence
