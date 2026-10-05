# BCIS implementation tasks

**Goal:** Implement the laboratory in this directory while preserving `../student-information-api`.
**Architecture:** Electron/React desktop clients communicate with a Fastify API; PostgreSQL is accessed only by the server.
**Spec:** [Foundation design](docs/FOUNDATION.md); the BCIS laboratory PDF in the parent directory.
**Execution:** Implement tasks sequentially and mark done only after verification. Phases 1 through 9 are complete; Phase 10 is in progress.

**Verification:** Use [TEST_CHECKLIST.md](TEST_CHECKLIST.md) for manual steps, expected results, automated commands and a results log covering completed features.

## Phase 1 â€” Project foundation

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

## Phase 2 â€” Authentication and RBAC

Design and execution details: [authentication plan](docs/AUTHENTICATION.md).

- [x] Add users, roles, permissions, role_permissions and user_roles migrations.
- [x] Seed an administrator safely; hash passwords; implement login, lock and logout.
- [x] Enforce server permissions and permission-aware navigation; test AT-10.

Verified 2026-09-28: 34 unit tests, 12 PostgreSQL integration tests and 7 Electron tests passed, including owner account management, lock/unlock/logout and AT-10 user-management access restrictions. Typecheck, lint, build, migration checks and npm audit passed. Financial permission acceptance remains with the corresponding modules.

## Phase 3 â€” Plans, subscribers and service accounts

- [x] Add Internet/Cable/Combo plans with exact rates and retained pricing revisions.
- [x] Add subscribers, multiple addresses/service accounts, status history and search.
- [x] Add collection areas and collector assignments with validated CRUD.

Verified 2026-09-28: 36 unit tests, 22 PostgreSQL integration tests and 9 Electron tests passed. Includes retained plan/service rates, date consistency, multiple services, collector assignments, RBAC, search, history and concurrent edit protection. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [Phase 3 design](docs/PHASE3.md) and [test evidence](docs/TEST_EVIDENCE.md).

Rate-history scope: plan and service revisions are retained now. Immutable billed-rate snapshots require the invoice engine in Phase 4; no historical invoice implementation is claimed in Phase 3.

## Phase 4 â€” Billing and ledger

Design and execution details: [billing design](docs/PHASE4.md).

- [x] Define exact money, billing dates, numbering, adjustment and advance-credit policies.
- [x] Generate monthly invoices and immutable line items transactionally.
- [x] Prevent duplicate billing and post reproducible ledger debits; test AT-11.

Verified 2026-09-29: 47 unit tests, 36 PostgreSQL integration tests (14 for billing) and 11 Electron tests passed. Includes gap-free per-year numbering, idempotent period generation, reissue of a discarded draft, immutable posted figures guarded in the database, debit/credit adjustments, voids with linked reversals, overdue sweeping, and a subscriber ledger that is reproduced from its own entries. Includes the desktop billing screens for cycles, invoices and the account statement. Typecheck, lint, build, database checks and migration consistency passed. See [test evidence](docs/TEST_EVIDENCE.md).

## Phase 5 â€” Payments, allocation and receipts

- [x] Implement exact, partial, advance and oldest-first allocations; test AT-01â€“AT-04.
- [x] Add safe proof uploads and GCash verification/duplicate protection; test AT-05.
- [x] Add unique receipts, audited reversals and void history; test AT-06.

Verified 2026-09-30: 64 unit tests, 50 PostgreSQL integration tests (14 for payments) and 13 Electron tests passed. Includes oldest-due-first allocation proven by a fixture whose later-due invoice is issued second, overpayment held as credit and spent on a later invoice, gap-free per-year receipt numbers, GCash claims that stay inert and unreceipted until a second authorised user confirms them, a live-reference unique index, void that keeps history and frees the reference, reversal that posts its own receipt and reopens the settled invoices, and database guards that refuse editing, deleting or unbalancing a recorded payment outside the service. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [Phase 5 design](docs/PHASE5.md) and [test evidence](docs/TEST_EVIDENCE.md).

## Phase 6 â€” Collections and remittance

Design and execution details: [collection design](docs/PHASE6.md).

- [x] Implement routes, printable sheets and collection batch lifecycle.
- [x] Record remittances, shortage/overage and authorized reconciliation; test AT-07â€“AT-08.

Verified 2026-09-30: 76 unit tests (12 for the collection contracts), 76 PostgreSQL integration tests (26 for collections) and 15 Electron tests (2 collection walkthroughs) passed. Includes a route that freezes the account list, the latest open invoice as the current bill and the older open invoice as arrears (AT-09); refusal of an area with nothing owing, an out-of-area subscriber list, a duplicate route for the same day and a route over 500 accounts; cash, partial and pending-GCash collections counted from posted payments only; an exact remittance (AT-07), a shortage and an overage (AT-08) that is stored rather than adjusted away; reconciliation refused for the person who counted the cash and accepted by a second user with a written reason; the shortage still on the record after the signature; closing; a printable route sheet that is a read-only projection of the stored route; and database guards refusing a direct status change, a frozen-account edit, a remittance edit and a payment re-point. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [Phase 6 design](docs/PHASE6.md) and [test evidence](docs/TEST_EVIDENCE.md).

Limits: the evidence uses two accounts in one area, one collector and one machine; concurrent posting from three office clients, a 20,000-subscriber load target, production LAN security and the Windows installer remain Phase 9 work.

## Phase 7 â€” Receivables and service control

Design and execution details: [service control design](docs/PHASE7.md).

- [x] Implement outstanding/overdue lists, aging and follow-up filters.
- [x] Implement suspension/reconnection approvals, fees and service history.

Verified 2026-10-01: 76 unit tests, 97 PostgreSQL integration tests (28 for receivables and service control) and 17 Electron tests passed. Includes aging buckets derived from the oldest unpaid due date that sum back to the total receivable, filters by collector, area and delinquency age, a configurable grace period and suspension threshold, a policy that refuses to suspend inside the grace period or below the threshold, a suspension document that freezes the arrears and months unpaid at the moment of the decision, a reconnection the API refuses while money is still owed and that carries the policy fee, technician assignment and completion as separate steps where only completion lifts the suspension, an append-only service history, and database guards refusing a suspend/lift/edit/delete through raw SQL. Typecheck, lint, build, database checks, migration consistency and npm audit passed. See [test evidence](docs/TEST_EVIDENCE.md).

Limits: the manual Phase 6 and Phase 7 walkthroughs in TEST_CHECKLIST.md have not been performed by a human and the aging report has not been sent to a physical printer; a 20,000-subscriber load target and three concurrent office clients remain Phase 9 work.

## Phase 8 â€” Reports, dashboard and printing

- [x] Add real KPIs and at least six reports with reconciled totals.
- [x] Implement PDF/XLSX exports, receipts and subscriber statements.

Verified 2026-10-02: 179 unit tests, 153 PostgreSQL integration tests (41 for reports and 15 for receipts) and 17 Electron tests passed, along with typecheck, lint and build. Nine reports reconcile against the stored balances, `AR_AGING` agrees with the receivables summary, and the reader test takes the y coordinate of every row back out of the PDF content stream rather than trusting that the text still parses. Two real defects came out of it: page ordering and a mirrored cursor direction, both of which produced files that still contained all their text and still parsed as valid PDFs. A receipt is saved through the native save dialog during the cashier walkthrough and the bytes on disk are checked. Re-run 2026-10-05 with the current tree: 200 unit tests, 171 PostgreSQL integration tests and 19 Electron tests pass. See [test evidence](docs/TEST_EVIDENCE.md) and [report design](docs/PHASE8.md).

Limits: the generated documents have not been sent to a physical printer and the manual `TEST_CHECKLIST.md` walkthrough for this phase has not been performed by a human.

## Phase 9 â€” Backup, hardening and deployment

Design and execution details: [backup and restore design](docs/PHASE9.md).

- [x] Back up database and attachments; verify restore and integrity; test AT-12.
- [x] Test concurrent posting/numbering and three office clients; test AT-09.
- [x] Review security, structured logs, indexes and realistic data-volume performance.
- [x] Package Windows installer and document LAN deployment.

Verified 2026-10-02 for the first task: 189 unit tests, 169 PostgreSQL integration tests (16 of them for backup and restore) and 19 Electron tests passed, along with typecheck, lint and build. A real `pg_dump` custom-format archive is taken of the test database, listed back with `pg_restore` before it is recorded as complete, and checked against the SHA-256 recorded at backup time; a FULL backup additionally copies the GCash payment proofs, each verified against the digest stored when it was uploaded, and abandons the backup if one no longer matches. AT-12 restores over deliberately changed data and asserts the row counts come back to the ones the backup recorded, that a subscriber created after the backup is gone, that the reason reaches the audit trail, and that any table whose count differs is named in the report rather than summarised away. The digest is checked before a restore writes anything, so a damaged or non-archive file is refused with the database unchanged. The consistency guarantee is proved rather than asserted: a payment posted while `pg_dump` is held open is excluded from both the recorded counts and the archive, checked by restoring that archive into a second database and counting it directly. A restore requires the literal confirmation `RESTORE` and a reason, ends only the sessions holding an open transaction, runs as a single transaction so a partial restore rolls back, and re-applies migrations. Permissions are split into read-only `backup.view`/`backup.verify` (owner, admin, auditor), `backup.create` (owner, admin) and `backup.restore` (owner only), and no backup operation returns archive bytes or accepts a path from the desktop. See [test evidence](docs/TEST_EVIDENCE.md).

Limits: a FULL restore does not delete proofs added after the backup (they are unreferenced, so harmless); `pg_dump` and `pg_restore` are taken from `PATH`; the backup screenshots have not been reviewed by a human.

Verified 2026-10-03 for the security, logging, index and data-volume task: 200 unit tests (11 of them for logging and redaction), 163 PostgreSQL integration tests (8 of them reading real log lines from a live API) and 19 Electron tests passed, along with typecheck, lint, build, the database check and migration consistency. The API writes one JSON object per line with the service name, ISO timestamps and a request id; bearer tokens, cookies, passwords, password hashes, proof bytes and connection strings are removed from every line, including from inside an error message or stack, which is a leak the new integration suite found on its first run; requests are serialized down to method, URL, request id, address and user agent; every response carries `nosniff`, `DENY` and `no-referrer`; and authentication and authorization outcomes are logged under stable event names. Migration `0019` adds partial indexes for open invoices by service account and by subscriber, a covering index for the last posted payment, an index for the audit trail date range and conditional trigram indexes for search, and installs `pg_trgm` only where it is available so a restricted server still migrates. `npm run test:performance` builds a throwaway database of 20,000 subscribers, 140,000 invoices, 41,692 payments and 181,692 ledger entries and measures 19 screens through the real routes: all inside budget, the slowest being the overdue worklist at 2,219 ms of 15,000 and the revenue report at 1,436 ms of 10,000, with the index plans required by name and no sequential scan, and the receivable total reconciled against the stored open balances. Two real defects came out of it: `coalesce(sum(...),0)::int` returned 500 for the receivables summary once the receivable passed PHP 21,474,836.47, now `bigint` throughout the office-wide money aggregates, and the plan check was itself measuring post-bulk-load costs rather than the plans the office sees. See [test evidence](docs/TEST_EVIDENCE.md) and [Phase 9](docs/PHASE9.md).

Limits: a single billing cycle is capped at PHP 9,999,999.99 by the `moneyBounds` constraint on every stored money column, about 10,000 subscribers per cycle at PHP 999 a month; the volume check writes invoices directly, so it measures the read paths rather than billing generation; `npm audit` reports 8 high severity vulnerabilities in the `electron-builder` packaging chain with no non-breaking fix, which is build-time only and is carried into the installer task; no human has reviewed this evidence.

## Phase 10 â€” QA, documentation and defense

- [x] Seed the PDF's synthetic demonstration dataset.
- [x] Complete AT-01â€“AT-12 with automated/manual evidence and defect log.
- [x] Produce technical documentation, user manual, ERD, screenshots and report samples.
- [x] Prepare release and live demonstration/defense (release notes, demo script, evidence).


Verified 2026-10-05 for Phase 10 task 3: technical documentation complete — [docs/ERD.md](docs/ERD.md) contains five Mermaid diagrams and the FK/relationship inventory verified against database/migrations/0001– 017; the [user manual](docs/USER_MANUAL.md) documents the interface, role permissions, daily routines, troubleshooting and the 24-screenshot index; [docs/samples/](docs/samples/) holds 6 exported artifacts (AR_AGING PDF, COLLECTIONS CSV, PAYMENT_EXCEPTIONS CSV, REVENUE XLSX, SUBSCRIBER_LEDGER PDF, RCT-2026-1049 PDF) produced from the synthetic demo dataset on 2026-10-05 and reproducible from the API, with their [README](docs/samples/README.md) explaining the limit that RCT-2026-1001 exceeds the receipt line cap and returns 422. The new tests/e2e/reports.spec.ts covers the dashboard and report viewer, adding 
eports-dashboard.png and 
eports-aging.png to the screenshots (total 24). Typecheck, lint, 200 unit, 186 integration and 21 Electron tests all pass on this tree. See [test evidence](docs/TEST_EVIDENCE.md) for the full task 3 section.
Verified 2026-10-05: `npm.cmd run db:seed:demo` writes the laboratory's section 8 dataset into a fresh development database and prints all twenty minimums as met â€” 6 staff accounts across the roles, 3 Internet / 2 Cable / 2 Combo plans, 50 subscribers, 63 service accounts of 3 service types, 2 collectors and 3 areas, 5 billing periods, 36 cash and 16 verified GCash payments with partial and advance cases, 20 overdue accounts spread over 5 aging buckets, 1 reversal, 1 void, 3 reconciled and closed routes and 2 suspension/reconnection scenarios â€” in 11 seconds, writing 188 invoices, 53 receipts and 437 audit entries through the API. The same seed is exercised by `tests/integration/demo-dataset.test.ts` against a throwaway PostgreSQL database, which additionally proves for every subscriber that billed = paid + open, paid = standing allocations, received = allocations + held credit and ledger net = open âˆ’ credit, that every stored ledger running balance is reproduced from its own entries, that an unconfirmed GCash claim allocates nothing and carries no receipt, and that receipt numbers per year run from 1001 with no gap. Re-verified the same day: 200 unit tests and 19 Electron tests, with the integration run at 171 tests in 10 files at that point and 186 in 11 after the payments suite was restored under the next task. See [demonstration dataset](docs/DEMO_DATASET.md) and [test evidence](docs/TEST_EVIDENCE.md).

Verified 2026-10-05 for AT-01â€“AT-12: the acceptance report is [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md), which names the exact test title behind every case so the matrix can be checked by searching the source. All twelve have evidence that runs today: 200 unit tests, 186 PostgreSQL integration tests in 11 files, 19 Electron tests, the 22 screenshots in `docs/screenshots` and the PDF/XLSX/CSV receipts and reports written by the receipt and report suites. Auditing the evidence found two real defects. The Phase 5 payment API suite, `tests/integration/payments.test.ts` â€” the 14 tests `TEST_EVIDENCE.md` and this file claim for AT-01 to AT-06 â€” had been deleted in commit `98b3192` while the documents describing it were left in place, and nothing replaced the coverage, so it is restored from `04bf5d7` and passes unmodified. AT-09 had no evidence for money under concurrency: a new test posts from three office sessions at once and requires the two receipts to be the next two unique numbers, every peso to be applied or held as credit, and no receipt number to appear twice. `TEST_CHECKLIST.md` records the result and the defect, and its stale note that permission tests "do not complete every part of the laboratory's AT-10" is corrected: AT-10's user and backup cases now have direct-HTTP refusal tests. See [test evidence](docs/TEST_EVIDENCE.md).

Limits: no acceptance case has been performed by a human â€” every `PAY-*`, `COL-*`, `REC-*` and `SEC-01`â€“`SEC-03` checklist item is still unticked; AT-09 is proved for concurrent API sessions against one PostgreSQL instance rather than three physical machines; no document has been sent to a physical printer; the screenshots have not been visually inspected; `npm audit` still reports the 8 build-time `electron-builder` vulnerabilities recorded as AUTO-07 Fail.

Limits: the demonstration password is generated into the ignored local `.env` and `.local/demo-credentials.txt` only; the dataset is synthetic and is never re-seeded over posted history, so another rehearsal needs a fresh database.

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
