## Item 1: Runtime language selection on Node.js

### What was unclear
The prompt fixes the backend stack to Node.js and Fastify, but it does not explicitly choose JavaScript or TypeScript for implementation.

### Interpretation
The API still needs a concrete language choice so the persistence, validation, and service contracts can be designed consistently.

### Decision
Implement the Fastify backend in TypeScript on Node.js.

### Why this is reasonable
TypeScript is a prompt-faithful safe default for a large rules-heavy API with RBAC, promotions, pricing, reconciliation, and audit behavior because it improves correctness without changing the requested platform.

## Item 2: Authentication and session shape

### What was unclear
The prompt requires local username/password login and session issuance, but it does not define whether sessions are cookie-based, bearer-token based, or fully server-backed.

### Interpretation
The system needs a concrete offline-friendly session model that works for internal client systems and ordinary API consumers without external identity services.

### Decision
Use local username/password authentication with salted password hashing, issue opaque bearer session tokens, persist only token hashes and session metadata server-side, and expose role/permission discovery from the authenticated session context.

### Why this is reasonable
This stays fully local, supports revocation and auditability, and fits the prompt's explicit session-issuance requirement without introducing third-party auth dependencies.

## Item 3: Promotion applicability coverage

### What was unclear
The prompt requires configurable applicability selectors for promotions, but it does not spell out the exact selector model across merchandise, courses, vouchers, and charging-related billing.

### Interpretation
Promotions need a consistent selector format that can express order-level, line-level, and service-specific applicability while preserving the requested offer types.

### Decision
Model applicability selectors as structured rule sets that can target specific SKUs, product categories, course categories, class instances, charging-session billing, customer membership tiers, and whole-order minimum spend conditions.

### Why this is reasonable
This covers the prompt's commerce and operations surfaces without narrowing eligibility logic to only one product family.

## Item 4: Reconciliation state machine

### What was unclear
The prompt requires exportable reconciliation states and linear timestamped transitions, but it does not define the concrete states.

### Interpretation
The API needs a fixed internal lifecycle so exports and audit logs can reflect an enforceable, non-skippable reconciliation history.

### Decision
Use a linear reconciliation lifecycle of pending -> reviewed -> exported -> archived, with every transition recorded with actor and timestamp and with no backward or skipped transitions.

### Why this is reasonable
It satisfies the prompt's linear-transition requirement and gives auditors and internal client systems a concrete export contract.

## Item 5: Local-time policy handling

### What was unclear
Promotion validity windows are explicitly stored in local time, but the prompt does not specify how the facility's local time zone is supplied.

### Interpretation
The system needs a deterministic facility-local clock policy so offer eligibility, schedules, and exports behave consistently.

### Decision
Use a single configured facility IANA time zone for all local-time business rules, with timestamps stored in UTC where appropriate and converted at API boundaries or rule-evaluation boundaries when local-time semantics are required.

### Why this is reasonable
This preserves the prompt's local-time semantics while avoiding ambiguous server-local behavior.

## Item 6: Encryption key provisioning

### What was unclear
The prompt requires AES-GCM encryption for sensitive fields, but it does not define how the encryption key is provided in a local offline deployment.

### Interpretation
The backend needs a runtime key source compatible with Docker and local execution while avoiding committed secrets or env files in the repo.

### Decision
Use a runtime-provided symmetric encryption key supplied through process or container configuration, with deterministic non-secret test defaults created outside source-controlled env files for local verification paths.

### Why this is reasonable
This satisfies the encryption requirement, works offline, and stays aligned with the repository rule forbidding committed env files.

## Item 7: Export scheduling and storage contract

### What was unclear
The prompt requires daily CSV exports for analytics and reconciliation on the local filesystem, but it does not specify how those exports are triggered or organized.

### Interpretation
The backend needs a concrete offline export contract so internal client systems can locate persisted exports reliably.

### Decision
Generate daily analytics and reconciliation CSV exports through an in-process scheduler, store them under a dedicated local exports directory with stable dated filenames plus persisted export-reference records, and expose download metadata through report and reconciliation endpoints.

### Why this is reasonable
This stays fully offline, matches the persisted export-reference requirement, and gives auditors/internal systems a predictable handoff surface.
