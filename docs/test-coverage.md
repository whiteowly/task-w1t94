# Actual Test Coverage

| Requirement / risk | Implemented tests / proof | Key assertions | Status | Remaining gap | Minimum addition if gap remains |
| --- | --- | --- | --- | --- | --- |
| Auth login and session issuance | `tests/auth.test.ts` | valid login issues opaque token; only token hash persists; failed-login counter increments on bad login; last-login updates on success | Verified | logout/session-expiry depth | Add revoked/expired-session matrix if needed |
| 401 behavior | route-family auth tests across implemented suites | missing or invalid auth returns normalized 401 with correlation ID | Verified | broader route-family matrix | Add more endpoint-specific negatives if needed |
| 403 role enforcement | `tests/catalog-search.test.ts`, `tests/training.test.ts`, `tests/commerce.test.ts`, `tests/charging.test.ts`, `tests/reconciliation-reporting.test.ts` | role boundaries enforced for admin/ops/proctor/instructor/sales/auditor across implemented domains | Verified | finer-grained finance/reconciliation separation | Add deeper mixed-role matrix |
| 404 behavior | implemented integration suites | missing products/classes/orders/sessions/reconciliation/audit/export records return 404 | Verified | some cross-module edges | Add remaining edge lookups |
| Product search correctness | `tests/catalog-search.test.ts` | keyword + category + attribute + fitment filters combine correctly; response includes applied filters and sort metadata | Verified | pagination edge depth | Add pagination-specific cases |
| Search suggestions | `tests/catalog-search.test.ts` | misspelled terms return local suggested terms when relevant | Verified | empty/no-suggestion edge depth | Add explicit empty suggestion case |
| Search performance | 50k benchmark command in repo docs | p50 uncached search latency under 200 ms for 50k products; latest hardening proof: 2.18 ms median, 2.60 ms p95 | Verified | CI-style perf gate absent | Add automated perf gate if needed |
| Cache behavior | `tests/catalog-search.test.ts` | normalized cache hit behavior and invalidation on catalog mutation | Verified | TTL-expiry depth | Add explicit TTL expiry test |
| Promotion eligibility and best-offer selection | `tests/commerce.test.ts` | highest valid savings chosen; exclusive/stackable rules respected; order breakdown stable | Verified | broader combinatorial depth | Add more mixed selector cases |
| Voucher reuse blocking | `tests/commerce.test.ts` | redeemed voucher cannot be reused; bound/expired voucher paths reject cleanly | Verified | more expiration boundary variants | Add extra boundary fixtures |
| Local-time promotion windows | `tests/commerce.test.ts` | canonical local-time fields drive eligibility; out-of-window promotion not applied; expired voucher rejected | Verified | DST-specific edge case | Add explicit DST crossover proof |
| Capacity enforcement | `tests/training.test.ts` | class cannot exceed capacity; waitlist used only when class full and waitlist has room | Verified | concurrent contention depth | Add transaction-race case |
| Waitlist promotion | `tests/training.test.ts` | seat release promotes first waitlisted attendee and resequences queue | Verified | concurrent race depth | Add race case |
| Publish/version history | `tests/training.test.ts` | publish/unpublish increments version; change notes/history retrievable | Verified | snapshot-diff depth | Add stronger diff assertions |
| Attendance authorization | `tests/training.test.ts` | only proctors/instructors can record present/absent/violation; non-enrolled writes rejected | Verified | wider negative matrix | Add ops/admin denial breadth if needed |
| Charging lifecycle | `tests/charging.test.ts` | valid transitions succeed; invalid transitions conflict; chronology enforced | Verified | deeper charger/customer registry depth not applicable yet | Add richer linkage checks if registry is added |
| Order idempotency | `tests/commerce.test.ts` | duplicate key within 24h conflicts; create/finalize paths enforce uniqueness | Verified | concurrent duplicate-submit depth | Add concurrent submit case |
| Draft auto-cancel | `tests/commerce.test.ts` plus `draft-expiration-job` | unpaid draft orders cancel after 30 minutes; paid or valid drafts preserved | Verified | scheduler E2E path | Add startup catch-up end-to-end proof |
| Payment reference encryption | `tests/commerce.test.ts`, `tests/training.test.ts` | DB never stores plaintext payment references or sensitive notes | Verified | broader key-version/rotation depth | Add key-version fixture |
| Reconciliation linear transitions | `tests/reconciliation-reporting.test.ts` | only pending->reviewed->exported->archived allowed; skip/backtrack/terminal transitions return 409; attribution captured | Verified | export-job linkage not embedded in transition rows | Add linkage assertions if schema changes |
| Audit immutability | `tests/hardening-proof.test.ts` | direct SQL update/delete against audit table are blocked; row remains unchanged | Verified | broader mutation-surface depth | Add more direct SQL mutation cases if needed |
| Sensitive-log exposure | `tests/hardening-proof.test.ts` | passwords, tokens, payment refs, personal notes, encrypted artifacts are redacted | Verified | failure-path log samples | Add more failure-path log assertions |
| KPI/report/export contract | `tests/reconciliation-reporting.test.ts` | report payload includes KPI datasets and persisted export reference; export file exists on filesystem and downloads cleanly | Verified | checksum/row-count assertion breadth | Add explicit metadata assertions if needed |
| Auditor-only audit/export access | `tests/reconciliation-reporting.test.ts` | auditors can read audit/export surfaces; non-auditors are denied | Verified | more mixed-role negatives | Add broader cross-role matrix |
| Broad runtime contract | owner broad runtime gate + `./run_tests.sh` | `docker compose up --build --wait`, readiness, and broad Dockerized tests all passed | Verified | separate clean-room VM proof not rerun | Add clean-room startup proof if required |

## Coverage posture target

The current evidence covers the major implemented requirement surface with direct proof for:

- 401 / 403 / 404 / 409 paths
- lifecycle authorization and state transitions
- pricing correctness and voucher/promotion rules
- search correctness plus 50k local benchmark proof
- audit immutability and sensitive-data handling
- scheduled draft expiration plus persisted export behavior

## Remaining evidence gaps

- deeper 403 role-matrix coverage for finer-grained finance/reconciliation separation
- additional object-level authorization coverage if future multi-tenant boundaries are introduced
- wider encryption persistence checks beyond current payment-reference and attendance-note coverage
- scheduler/export and draft-expiration end-to-end startup-catch-up proof
