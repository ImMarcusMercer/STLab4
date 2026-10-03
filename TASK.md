# BCIS implementation tasks

**Goal:** Implement the laboratory in this directory while preserving `../student-information-api`.
**Architecture:** Electron/React desktop clients communicate with a Fastify API; PostgreSQL is accessed only by the server.
**Spec:** [Foundation design](docs/FOUNDATION.md); the BCIS laboratory PDF in the parent directory.
**Execution:** Implement tasks sequentially and mark done only after verification. Phases 1 through 6 are complete; subsequent phases remain pending.

**Verification:** Use [TEST_CHECKLIST.md](TEST_CHECKLIST.md) for manual steps, expected results, automated commands and a results log covering completed features.

## Phase 1 — Project foundation

- [x] Review laboratory requirements and select an isolated sibling directory.
- [x] Write architecture and implementation checklist.
- [x] Configure Node dependencies, strict TypeScript, lint, Vitest and build scripts.
- [x] Test and implement Fastify liveness/readiness endpoints, validation and safe errors.
- [x] Add PostgreSQL setup, Drizzle migration and a repeatable real-database check.
- [x] Build the secure Electron preload boundary and React connection screen.
- [x] Test desktop startup, connection states and Electron security settings.
- [x] Verify lint, typecheck, automated tests, database migration and production build.
- [x] Document setup, architecture, test results and known limitations.

Verified 2026-09-28: 28 Vitest tests, 4 Playwright Electron tests, strict typecheck, lint, production build, repeated PostgreSQL setup/migration and zero npm audit vulnerabilities. See [test evidence](docs/TEST_EVIDENCE.md).

## Phase 2 — Authentication and RBAC

Design and execution details: [authentication plan](docs/AUTHENTICATION.md).

- [x] Add users, roles, permissions, role_permissions and user_roles migrations.
- [x] Seed an administrator safely; hash passwords; implement login, lock and logout.
- [x] Enforce server permissions and permission-aware navigation; test AT-10.

Verified 2026-09-28: 34 unit tests, 12 PostgreSQL integration tests and 7 Electron tests passed, including owner account management, lock/unlock/logout and AT-10 user-management access restrictions. Typecheck, lint, build, migration checks and npm audit passed. Financial permission acceptance remains with the corresponding modules.

## Phase 3 — Plans, subscribers and service accounts

- [x] Add Internet/Cable/Combo plans with exact rates and retained pricing revisions.
- [x] Add subscribers, multiple addresses/service accounts, status history and search.
- [x] Add collection areas and collector assignments with validated CRUD.

Verified 2026-09-28: 36 unit tests, 22 PostgreSQL integration tests and 9 Electron tests passed. Includes retained plan/service rates, date consistency, multiple services, collector assignments, RBAC, search, history and concurrent edit protection. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [Phase 3 design](docs/PHASE3.md) and [test evidence](docs/TEST_EVIDENCE.md).

Rate-history scope: plan and service revisions are retained now. Immutable billed-rate snapshots require the invoice engine in Phase 4; no historical invoice implementation is claimed in Phase 3.

## Phase 4 — Billing and ledger

Design and execution details: [billing design](docs/PHASE4.md).

- [x] Define exact money, billing dates, numbering, adjustment and advance-credit policies.
- [x] Generate monthly invoices and immutable line items transactionally.
- [x] Prevent duplicate billing and post reproducible ledger debits; test AT-11.

Verified 2026-09-29: 47 unit tests, 36 PostgreSQL integration tests (14 for billing) and 11 Electron tests passed. Includes gap-free per-year numbering, idempotent period generation, reissue of a discarded draft, immutable posted figures guarded in the database, debit/credit adjustments, voids with linked reversals, overdue sweeping, and a subscriber ledger that is reproduced from its own entries. Includes the desktop billing screens for cycles, invoices and the account statement. Typecheck, lint, build, database checks and migration consistency passed. See [test evidence](docs/TEST_EVIDENCE.md).

## Phase 5 — Payments, allocation and receipts

- [x] Implement exact, partial, advance and oldest-first allocations; test AT-01–AT-04.
- [x] Add safe proof uploads and GCash verification/duplicate protection; test AT-05.
- [x] Add unique receipts, audited reversals and void history; test AT-06.

Verified 2026-09-30: 64 unit tests, 50 PostgreSQL integration tests (14 for payments) and 13 Electron tests passed. Includes oldest-due-first allocation proven by a fixture whose later-due invoice is issued second, overpayment held as credit and spent on a later invoice, gap-free per-year receipt numbers, GCash claims that stay inert and unreceipted until a second authorised user confirms them, a live-reference unique index, void that keeps history and frees the reference, reversal that posts its own receipt and reopens the settled invoices, and database guards that refuse editing, deleting or unbalancing a recorded payment outside the service. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [Phase 5 design](docs/PHASE5.md) and [test evidence](docs/TEST_EVIDENCE.md).

## Phase 6 — Collections and remittance

Design and execution details: [collection design](docs/PHASE6.md).

- [x] Implement routes, printable sheets and collection batch lifecycle.
- [x] Record remittances, shortage/overage and authorized reconciliation; test AT-07–AT-08.

Verified 2026-09-30: 76 unit tests (12 for the collection contracts), 76 PostgreSQL integration tests (26 for collections) and 15 Electron tests (2 collection walkthroughs) passed. Includes a route that freezes the account list, the latest open invoice as the current bill and the older open invoice as arrears (AT-09); refusal of an area with nothing owing, an out-of-area subscriber list, a duplicate route for the same day and a route over 500 accounts; cash, partial and pending-GCash collections counted from posted payments only; an exact remittance (AT-07), a shortage and an overage (AT-08) that is stored rather than adjusted away; reconciliation refused for the person who counted the cash and accepted by a second user with a written reason; the shortage still on the record after the signature; closing; a printable route sheet that is a read-only projection of the stored route; and database guards refusing a direct status change, a frozen-account edit, a remittance edit and a payment re-point. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [Phase 6 design](docs/PHASE6.md) and [test evidence](docs/TEST_EVIDENCE.md).

Limits: the evidence uses two accounts in one area, one collector and one machine; concurrent posting from three office clients, a 20,000-subscriber load target, production LAN security and the Windows installer remain Phase 9 work.

## Phase 7 — Receivables and service control

Design and execution details: [service control design](docs/PHASE7.md).

- [x] Implement outstanding/overdue lists, aging and follow-up filters.
- [x] Implement suspension/reconnection approvals, fees and service history.

Verified 2026-10-01: 76 unit tests, 97 PostgreSQL integration tests (28 for receivables and service control) and 17 Electron tests passed. Includes aging buckets derived from the oldest unpaid due date that sum back to the total receivable, filters by collector, area and delinquency age, a configurable grace period and suspension threshold, a policy that refuses to suspend inside the grace period or below the threshold, a suspension document that freezes the arrears and months unpaid at the moment of the decision, a reconnection the API refuses while money is still owed and that carries the policy fee, technician assignment and completion as separate steps where only completion lifts the suspension, an append-only service history, and database guards refusing a suspend/lift/edit/delete through raw SQL. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [test evidence](docs/TEST_EVIDENCE.md).

Limits: the manual Phase 6 and Phase 7 walkthroughs in TEST_CHECKLIST.md have not been performed by a human and the aging report has not been sent to a physical printer; a 20,000-subscriber load target and three concurrent office clients remain Phase 9 work.

## Phase 8 — Reports, dashboard and printing

- [x] Add real KPIs and at least six reports with reconciled totals.
- [x] Implement PDF/XLSX exports, receipts and subscriber statements.

## Phase 9 — Backup, hardening and deployment

Design and execution details: [backup and restore design](docs/PHASE9.md).

- [x] Back up database and attachments; verify restore and integrity; test AT-12.
- [x] Test concurrent posting/numbering and three office clients; test AT-09.
- [ ] Review security, structured logs, indexes and realistic data-volume performance.
- [ ] Package Windows installer and document LAN deployment.

Verified 2026-10-02 for the first task: 189 unit tests, 169 PostgreSQL integration tests (16 of them for backup and restore) and 19 Electron tests passed, along with typecheck, lint and build. A real `pg_dump` custom-format archive is taken of the test database, listed back with `pg_restore` before it is recorded as complete, and checked against the SHA-256 recorded at backup time; a FULL backup additionally copies the GCash payment proofs, each verified against the digest stored when it was uploaded, and abandons the backup if one no longer matches. AT-12 restores over deliberately changed data and asserts the row counts come back to the ones the backup recorded, that a subscriber created after the backup is gone, that the reason reaches the audit trail, and that any table whose count differs is named in the report rather than summarised away. The digest is checked before a restore writes anything, so a damaged or non-archive file is refused with the database unchanged. The consistency guarantee is proved rather than asserted: a payment posted while `pg_dump` is held open is excluded from both the recorded counts and the archive, checked by restoring that archive into a second database and counting it directly. A restore requires the literal confirmation `RESTORE` and a reason, ends only the sessions holding an open transaction, runs as a single transaction so a partial restore rolls back, and re-applies migrations. Permissions are split into read-only `backup.view`/`backup.verify` (owner, admin, auditor), `backup.create` (owner, admin) and `backup.restore` (owner only), and no backup operation returns archive bytes or accepts a path from the desktop. See [test evidence](docs/TEST_EVIDENCE.md).

Limits: a FULL restore does not delete proofs added after the backup (they are unreferenced, so harmless); `pg_dump` and `pg_restore` are taken from `PATH`; the backup screenshots have not been reviewed by a human.

## Phase 10 — QA, documentation and defense

- [ ] Seed the PDF's synthetic demonstration dataset.
- [ ] Complete AT-01–AT-12 with automated/manual evidence and defect log.
- [ ] Produce technical documentation, user manual, ERD, screenshots and report samples.
- [ ] Prepare release and live demonstration/defense.

## Foundation implementation sequence

1. Create configuration and failing API/configuration tests in `tests/`. Implement `buildApp({ checkDatabase })` in `source/api/app.ts`, then run `npm test`.
2. Create `database/schema.ts`, generate a migration, implement `source/api/database.ts` and local PostgreSQL scripts. Run `npm run db:setup`, `npm run db:migrate`, and `npm run test:db`; migration reruns must preserve the version row.
3. Define `SystemStatus` and `DesktopBridge` in `source/shared/contracts.ts`. Test upstream unavailable/malformed responses, then implement the narrow API client and preload/main processes. Build the renderer around these states.
4. Run `npm run check`, `npm run build`, `npm run test:db`, and `npm run test:e2e`. Record actual results and mark only verified Phase 1 tasks done.

## Review focus

- Database down must not be reported as ready or leak connection credentials.
- Incorrect/malformed upstream responses must not display a healthy connection.
- Renderer must have neither Node access nor arbitrary IPC/network/database access.
- Setup must preserve existing configuration and avoid the student project's files/services.
- Database setup and migrations must be repeatable without erasing data.
