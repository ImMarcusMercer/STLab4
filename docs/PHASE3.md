# Phase 3: plans, subscribers and service accounts

## Design

Extend the existing Fastify/PostgreSQL and named Electron bridge. Support plans (Internet, Cable, Combo), collection areas, collectors, subscribers with multiple addresses, and multiple service accounts per subscriber. Each list is searched, sorted and paginated by the server. All mutations enforce permissions, validate inputs, retain audit snapshots and use optimistic versions to reject stale edits.

Money is integer centavos, bounded to 999,999,999. Plan revisions are retained; service accounts store the selected plan revision and their independently editable current rate. Editing a plan never rewrites a service rate or previous revision. Phase 4 must copy rates into immutable invoice items. This phase does not claim invoice behavior is implemented.

Subscribers retain account numbers permanently. Archive/terminate replaces deletion. Billing/due days accept 1–31; Phase 4 will clamp to the calendar month's last day. Service statuses in this phase are PENDING, ACTIVE, INACTIVE, TERMINATED and ARCHIVED. Suspension approvals/reconnection remain Phase 7. Every edit requires a reason; history records actor, timestamp and the complete saved snapshot.

Collectors are independent staff records with contact information. Collection Supervisor may maintain collectors/areas and assign collectors/areas to existing subscribers/services, but cannot edit their identity, rates or plans. Owner/Administrator maintain all Phase 3 records. Cashier can search/read subscribers and services. Technician reads service operational information without subscriber notes/contact details. Viewer has no master-data access.

Inactive referenced records cannot be newly assigned. Existing references remain readable and may be retained during unrelated edits. A service's subscriber cannot be changed after creation. Its account number and subscriber account numbers are immutable. No hard-delete endpoint exists. Plans cannot change service type after creation. A service cannot be newly activated under an inactive/terminated/archived subscriber.

## Implementation plan

> Use superpowers:executing-plans and test-driven development, completing each checkpoint before marking it done.

- [x] Add failing real-PostgreSQL tests for creation, exact money validation, duplicate numbers, retained revisions, reference validation, permissions, history, pagination/search and stale-write conflicts.
- [x] Implement shared Zod contracts, relational schema/migration, transaction-safe domain services and authenticated routes. Verify integration tests.
- [x] Add named desktop methods and operational screens for plans, subscribers, services, areas and collectors. Add searchable reference selection and history.
- [x] Verify real Electron workflows and read-only roles; run unit/integration/E2E, lint/typecheck/build, migration consistency and database checks.
- [x] Review code, inspect screenshots, update TASK.md, setup and evidence.

## API contract

Resources: `plans`, `areas`, `collectors`, `subscribers`, `services` under `/api/v1/`. GET collection accepts `q`, `page`, `perPage`, `sort` (name/code), `direction` (asc/desc), optional `status`, `subscriberId`. GET `/:id` returns a record. POST creates; PUT `/:id` requires `{ data, version, reason }`. POST requires `{ data, reason }`. GET `/:id/history` returns paginated immutable snapshots. PATCH `/subscribers/:id/assignment` and `/services/:id/assignment` accept `{ areaId, collectorId, version, reason }` for supervisors. No arbitrary URL/SQL is exposed in preload.

## Review focus

Concurrent updates must not silently overwrite each other. Invalid/inactive references must roll back completely. Plan price changes must leave service rates/revisions intact. Authorization must hold on direct HTTP and preload calls. Search input must remain parameterized and literal (including percent/underscore). History must not expose subscriber personal data to technician accounts.


## Execution record

- Ran the new API tests before implementation: all eight failed because the Phase 3 routes were absent. Implemented the schema, services and routes; all eight passed. Added two further authorization/reference regressions and date-response contract assertions.
- Created the Electron workflow before enabling its navigation; observed failure against the existing disabled Subscribers button. Implemented the bridge and screens, then exercised collection setup, plan creation, subscriber addresses/assignments, multiple services, history and cashier read-only navigation.
- A real Electron save exposed pg DATE serialization as JavaScript timestamps. A failing response-schema regression and independent code review confirmed the cause. SQL now formats DATE columns as YYYY-MM-DD before the driver parses them. Save/get/edit/assignment/history preserve the exact calendar date and selected plan revision.
- Final verification: 36 unit tests, 22 real-DB integration tests and 9 Electron tests. Strict typecheck, lint, build, database check, migration consistency and npm audit passed. Screenshots inspected; form labels refined for readable required indicators.
- Review: one important date defect corrected; no other important findings. Added regression checks for viewer denial, technician subscriber-history denial, inactive-reference retention, inactive-subscriber activation and supervisor field-injection rejection.
- Ruling: subscriber addresses use a bounded validated JSON array, and assignment/plan revisions use immutable master_history snapshots. Foreign keys remain on live subscriber/service references; no hard deletion or history mutation API is exposed. Separate invoice rate snapshots are still required in Phase 4.
- Ruling: continue in the user's existing isolated sibling directory. No commits, merges or changes to the student project were made.
