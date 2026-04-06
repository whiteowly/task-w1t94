# TrailForge Clarification Questions

## Business Logic Questions Log

### 1. Clarification Defaults for Planning
- Question: Can the drafted clarification defaults be used for planning?
- My Understanding: The prompt was large enough that planning needed explicit confirmation that the clarification package was acceptable. We needed to lock this in rather than carrying uncertainty forward into the planning phase.
- Solution: Yes. Proceed with the drafted defaults, allowing planning to start from the approved clarification brief instead of an uncertain baseline.

### 2. Offline Deployment Style
- Question: What offline deployment style should the initial build assume?
- My Understanding: The prompt required a fully offline system but did not force or prescribe a specific local deployment mechanism.
- Solution: Use Docker Compose as the default offline deployment path. The project runtime contract will use docker compose up --build as the primary launch command.

### 3. Excel Support Handling
- Question: How should Excel support be handled in the first implementation pass?
- My Understanding: The prompt required CSV/Excel support but did not specify whether legacy .xls format support was necessary alongside modern formats.
- Solution: Support .xlsx plus CSV, and do not include legacy .xls in the first pass. Import/export planning and validation will target the newer .xlsx standard.

### 4. Frontend Implementation Stack
- Question: What specific technologies should be used for the frontend implementation?
- My Understanding: The prompt already required a Vue workspace and a modern frontend framework. We need a default that keeps the implementation conventional and robust without changing the product scope.
- Solution: Use Vue 3 + Vite + TypeScript + Vue Router + Pinia.

### 5. Backend Implementation Stack
- Question: What specific technologies should be used for the backend implementation?
- My Understanding: The prompt already required FastAPI and PostgreSQL. We need to define the expected persistence, schema, and migration foundations based on those requirements.
- Solution: Use FastAPI + SQLAlchemy + Alembic + Pydantic.

### 6. Offline Sync Package Shape
- Question: How should the file structure for the offline sync package be defined?
- My Understanding: The prompt required an offline sync package for cross-device transfer but did not define the specific file structure or mechanism for this package.
- Solution: Use a versioned portable archive containing manifest metadata, serialized payloads, checksums, and referenced assets.

### 7. HTTPS Setup Approach
- Question: How should HTTPS be handled for a local-network offline environment?
- My Understanding: The prompt required local-network HTTPS, so we need a practical, offline-safe way to satisfy this requirement without relying on external, internet-dependent certificate authorities.
- Solution: Use a locally generated certificate workflow and explicitly document the trust/setup steps for the end user.

### 8. Non-Image Resource Preview Behavior
- Question: How should resource previews be handled for non-image files?
- My Understanding: The prompt required thumbnail previews and controlled media handling, but non-image assets inherently need a different presentation strategy than standard image files.
- Solution: Use document preview/file cards for non-image assets, while preserving stronger thumbnail behavior where applicable for images.

### 9. Reserved Outbound Connectors
- Question: How should SMS, email, and push notifications be implemented in an offline-first system?
- My Understanding: The prompt explicitly stated that these connectors should be reserved for future use, but they are not required for core offline operations.
- Solution: Keep SMS, email, and push as provider abstraction points, implementing them as disabled placeholders in v1.
