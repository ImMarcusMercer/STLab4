# Verification evidence

Each phase below records what was actually executed in this repository, with its own
date, scope, results and defect record. The PDF's financial acceptance cases are
referenced as AT-01 through AT-12; each is only claimed in the phase that tests it.

## Test coverage

- Fastify liveness remains available when PostgreSQL is down; readiness reports 503 instead of a false healthy state.
- Readiness reports success only after its database check completes.
- Unknown routes return safe errors with request IDs.
- Configuration rejects invalid ports and non-PostgreSQL URLs.
- Desktop HTTP boundary handles real local HTTP responses, malformed payloads, inconsistent readiness states and disconnected servers.
- API origin configuration rejects embedded credentials, paths, query strings and unsafe protocols.
- Trusted renderer comparison accepts Chromium's canonical development URL while rejecting other pages and origins.
- Local database setup rejects connection-query overrides and unrelated databases.
- Real PostgreSQL migration/check verifies schema readiness and repeat execution preserving metadata.
- Playwright Electron checks the built screen, refresh, sandbox/context isolation, absent renderer Node access, narrow bridge, unavailable API feedback, development renderer and database-outage feedback.

## Defect and correction evidence

| Finding | Root cause | Correction | Verification |
|---|---|---|---|
| Dependency resolution failed | electron-vite 5 does not accept Vite 8 | Pin compatible Vite 7 and React plugin 5 | Dependency installation and build |
| Electron launch rejected Chromium flags | IDE inherited `ELECTRON_RUN_AS_NODE=1` | Remove only that variable in desktop launcher/test environment | Electron startup tests |
| Electron startup timed out | Main module awaited `app.whenReady()` at top level, preventing ESM startup completion | Register a promise callback and finish module evaluation | Previously failing startup tests pass |
| Development IPC rejected a legitimate renderer | Raw origin lacked Chromium's trailing slash | Canonical URL comparison | Regression observed failing before fix; unit and development Electron tests |
| Local setup could target another host via URL query | pg honors query parameters overriding URL authority | Reject query/fragment in local setup configuration | Three regression cases failed before fix and pass afterward |

An independent read-only review identified the URL comparison and database override issues. Both were corrected. Existing student-project Git status was checked and still contains exactly its pre-existing modifications; no student-project code was changed by this work.

## Execution results

The following commands completed successfully after a clean dependency installation:

| Command | Observed result |
|---|---|
| `npm.cmd ci` | Clean install completed; 563 packages installed |
| `npm.cmd run check` | TypeScript strict and ESLint passed; 28 tests passed in 5 Vitest files |
| `npm.cmd run build` | Electron main, sandboxed preload and React production bundles generated |
| `npm.cmd run db:setup` | Repeat setup reused the dedicated cluster/configuration without resetting data |
| `npm.cmd run test:db` | PostgreSQL connection, migrated schema, repeat migration and API readiness passed |
| `npm.cmd run test:e2e` | 4 tests passed: healthy/secure desktop, unavailable API, development renderer, database outage |
| `npm.cmd audit` | 0 vulnerabilities reported |

The healthy desktop test also refreshed the connection and resized the window to 900 pixels wide with no horizontal document overflow. [Workspace screenshot](screenshots/workspace.png) was visually inspected: readable content, consistent layout and no overlap. The screenshot is real Electron output against the local API and PostgreSQL.

npm emits upstream package deprecation/install-script notices, and the inherited test environment emits a NO_COLOR/FORCE_COLOR warning. These did not fail installation, build or tests. Windows installer packaging is still pending.

## Limits

This is a local foundation, not a finished billing system. At this Phase 1 checkpoint, authentication was not yet implemented. Financial postings, production installer, backup/restore, and physical three-PC acceptance remain pending. The development database user owns its isolated local cluster. LAN rollout and restricted production service credentials belong to the deployment phase.


## Phase 2 verification ? 2026-09-28

Authentication and user management are implemented. Tests use synthetic accounts and uniquely named disposable databases, separate from the development database.

| Command | Observed result |
|---|---|
| `npm.cmd run check` | Strict typecheck and lint passed; 34 unit tests passed in 7 files |
| `npm.cmd run test:integration` | 12 real-PostgreSQL authentication/RBAC tests passed |
| `npm.cmd run build` | Main, preload and renderer bundles built successfully |
| `npm.cmd run test:e2e` | 7 Electron tests passed |
| `npm.cmd run test:db` | Connection, migration, repeat migration and readiness passed |
| `npm.cmd run db:generate` | No schema changes; migrations match the schema |
| `npm.cmd audit` | Zero vulnerabilities reported |

Coverage includes hashed passwords and session digests, generic invalid-login errors, rate limiting, anonymous rejection, cashier denial of direct user-management requests (AT-10 scope), owner creation/update, duplicate usernames, pagination, inactive/expired/revoked sessions, password and role changes, idempotent seeding, audit records, and concurrent last-owner protection. The desktop suite exercises owner login, account creation, lock, unlock, logout, cashier navigation and direct preload denial, incorrect login, and the four foundation connection/security scenarios.

A desktop test exposed a password field whose helper text changed its accessible name. Explicit label and description associations corrected it; the previously failing owner workflow now passes. During API implementation, an incorrect role-column reference was corrected and the integration suite passed afterward.

[Login](screenshots/login.png) and [user accounts](screenshots/user-accounts.png) screenshots were visually inspected with readable labels, intact layout and no overlap. Existing student-project Git changes still match the pre-existing list; no student code was edited.

Build output includes upstream Zod comment-annotation warnings; bundles and tests succeed. Financial permissions, backup permissions on actual backup operations, LAN transport hardening and multi-PC operation require their later phases. No completion of financial acceptance cases is claimed.


## Phase 3 verification - 2026-09-28

| Command | Observed result |
|---|---|
| `npm.cmd run check` | Typecheck and lint passed; 36 unit tests in 8 files |
| `npm.cmd run test:integration` | 22 PostgreSQL tests in 2 files |
| `npm.cmd run build` | Desktop main/preload/renderer production bundles generated |
| `npm.cmd run test:e2e` | 9 Electron tests passed, including both new Phase 3 tests |
| `npm.cmd run test:db` | Connection, migration, repeat migration and readiness passed |
| `npm.cmd run db:generate` | Schema matches migrations; no changes |
| `npm.cmd audit` | Zero vulnerabilities |

The Phase 3 integration suite validates exact money and service attributes, normalized duplicate codes, multiple subscriber addresses/services, retained plan revisions and current rates, valid dates, invalid/inactive references, transactional rollback, collector assignments, optimistic concurrency, audit history, literal search, sorting validation and pagination. Authorization checks cover anonymous access, cashier write denial, supervisor limited assignments, technician private-history denial and viewer denial. Tests also reject inactive subscriber activation and preserve inactive historical references on unrelated edits.

The owner Electron workflow creates an area, collector, plan, subscriber with two addresses and assignments, and two service accounts. It reads history and searches by the secondary address. The cashier test verifies searchable read-only navigation. Existing authentication and foundation tests remain green.

[Subscriber list](screenshots/subscribers.png), [subscriber form](screenshots/subscriber-form.png) and [service accounts](screenshots/services.png) were visually inspected. The form scrolls within the viewport; required indicators were adjusted to remain beside their labels. Tables are readable without overlapping controls.

Defect record: PostgreSQL DATE values were returned as JavaScript Date objects, causing timezone-shifted timestamps in POST/GET/history and failed Electron response validation. A failing integration assertion reproduced the mismatch. Canonical SQL calendar-date formatting fixed service save/read/update/assignment and history; regression assertions and the Electron workflow passed. The desktop boundary allowlist test was updated for the new named operations. An encoding typo in two test dropdown labels was corrected without changing the application behavior.

Independent review reported the same date defect and no other important findings. Additional suggested permission/reference tests pass. The earlier student-project Git modification list is unchanged.

Limits: invoice generation and immutable billed line items, payment/receipt/reference search, suspension approvals, route sheets, batches/remittances and financial exports remain in later phases. The 20,000-subscriber load target, production LAN security and three-PC operation are not claimed by these local tests. Existing upstream Zod annotation and NO_COLOR/FORCE_COLOR warnings do not fail the build/tests.


## Phase 4 verification - 2026-09-29

Billing cycles, immutable invoice documents, corrections and the subscriber ledger are
implemented behind the API. All test data is synthetic and lives in uniquely named
disposable databases, separate from the development database.

| Command | Observed result |
|---|---|
| `npm.cmd run check` | Strict typecheck and lint passed; 47 unit tests in 10 files, of which 4 are the new billing desktop boundary tests |
| `npm.cmd run test:integration` | 36 PostgreSQL tests in 3 files, of which 14 are the Phase 4 billing suite |
| `npm.cmd run build` | Desktop main/preload/renderer production bundles generated |
| `npm.cmd run test:e2e` | 11 Electron tests passed, including the 2 new Phase 4 billing tests |
| `npm.cmd run db:generate` | Schema matches migrations 0000-0009; no changes |
| `npm.cmd run test:db` | Connection, migration, repeat migration and readiness passed |
| `npm.cmd run db:migrate` | 0007-0009 applied to the development database |
| `npm.cmd audit` | 0 vulnerabilities |

The billing suite proves, against a real PostgreSQL database: role separation
(anonymous, cashier, supervisor, technician and owner); one invoice per service and
period under a concurrent double run; a re-run reporting `idempotent: true` with
`skippedCount`; a plan price and service rate edit leaving a posted invoice unchanged;
a manual draft with a multi-line total, re-issue, numbering and finalisation; a
debit and a credit adjustment that leave the original line untouched and append their
own lines and statement entries; a credit that may neither equal nor exceed the
outstanding balance; a back-dated period that is re-derived into the statement in date
order; a void with a reason, a linked reversal and a replacement document on re-run;
the overdue sweep; strict request validation; every stored amount as an exact integer
of centavos; the database guards; and the statement read path.

The desktop evidence adds the three billing screens. The owner workflow generates
period 2026-09 for two service accounts totalling PHP 1349.00, repeats the same period
and observes the reused run with both services reported as already invoiced, opens
`INV-2026-1001`, records a PHP 100.00 debit adjustment and reads the resulting balance
of PHP 1099.00, then opens the subscriber ledger and finds the two invoice entries, the
adjustment entry and statement totals of PHP 1449.00 in date order. The cashier
workflow sees the billing navigation and the issued documents but no `Generate period`,
`Sweep overdue` or `New invoice` control, which matches the server-side permission
check. The billing unit tests additionally prove that a response the shared contracts
reject is never handed to the renderer, that an impossible document shape fails the
invoice contract, and that an invalid period, key, amount or reason is refused in the
main process without any request being sent.

Defect record, each found by a failing assertion and fixed before re-running:

| Finding | Root cause | Correction | Verification |
|---|---|---|---|
| `invoice_totals` violation on every manual invoice | `balance_centavos` was inserted as 0 instead of the computed total | Set the balance from the computed totals in the same statement | Manual draft test passes |
| Ledger lines showed an empty document number | The reference number was stored as an empty string at posting | `finalizeInvoice` returns the allocated number and the posting stores it | Ledger read returns `INV-2026-1001` and `INV-2026-1002` |
| `UPDATE invoices` on a posted document was refused by a check violation instead of the guard, and a direct delete was refused only by a foreign key | The guard covered identity columns and `UPDATE` only | Migrations 0007 and 0008 refuse posted figures and deletes unless the transaction set the transaction-local `bcis.posting` flag; the service sets it in every posting transaction | Direct SQL cases raise `bcis_immutable_row` |
| A discarded draft could not be voided | The check required a number for every non-`DRAFT` status | Migration 0009 accepts a `VOID` document with or without a number | Draft void test passes with `invoiceNumber: null` and no statement line |
| A date-filtered statement reported a wrong closing balance and could not be verified | The filter was applied before the balance was reproduced, and the closing balance was the range total | The complete statement is read and verified, the range is filtered afterwards, and the closing balance is the balance reached at the end of the range | Range and paging cases pass, including an empty range |
| An adjustment against a draft was accepted | Only `VOID` was refused | A draft must be re-issued, so `DRAFT` is refused with a conflict | Draft adjustment test passes |
| `tsc` error `'query.from' is possibly 'undefined'` inside a filter callback | The narrowed value was not captured outside the closure | Destructure `from`/`to` once | `npm.cmd run check` passes |
| The desktop billing tabs lost the confirmation of the command they had just run | The tab was remounted with a new `key` to force a reload, which also reset its state | A `revision` value is passed in and listed in the data-loading effect, so the data reloads without remounting | The owner Electron workflow observes both the generation and the adjustment confirmations |
| The billing screens did not compile | `MasterList`/`MasterRecord` were imported from the billing module, the dialog referenced an undefined `setIntent`, and the two pages imported each other | The master types come from the shared master-data module, the dialog keeps its own intent state, and the line editor is exported from the page it renders in | `npm.cmd run typecheck` and `npm.cmd run lint` pass, and the Electron workflow runs |
| The billing Electron test failed and reported an empty invoice list | The walkthrough exceeded the 30 s default test timeout, so Playwright restarted the worker and `beforeAll` created a new empty database | The two billing tests declare a 120 s budget, which is also the honest cost of a full desktop walkthrough | 11 Electron tests pass; the cashier test reads the invoices created by the owner test |
| The `Sweep overdue` and `New invoice` controls were invisible to the cashier but the API had to be checked too | The renderer hides the commands by permission, and the server refuses them | Both layers are exercised: the controls are absent and the integration suite proves the refusal | Cashier Electron test and the billing authorization integration test |

Policy correction: the database immutability test originally asserted that a direct
write to `ledger_entries.balance_centavos` is refused. The balance is a derived
column that the posting transaction must be able to rebuild, so refusing it would
break the back-dated rebuild. The suite now proves the real contract instead: the
derived column may be written, the read path then refuses to present the statement
with `500 LEDGER_INCONSISTENT`, and the next posting rebuilds every balance from the
append-only entries.

Screenshots [billing cycles](screenshots/billing-cycles.png),
[billing invoice](screenshots/billing-invoice.png) and
[billing ledger](screenshots/billing-ledger.png) are real full-page Electron output
written by the billing walkthrough. They are recorded as captured evidence; the visual
inspection of these three images is still outstanding for a human reviewer. The
900-pixel no-overflow assertion still covers the workspace screen only, so the billing
screens at that width remain a manual check (FND-07).

Limits: payments, receipts, allocation, advance-credit settlement, batches,
remittances, receivables, reports, export and printing remain in Phases 5-8.
`PARTIALLY_PAID` and `CREDITED` are validated and stored but never produced. The
20,000-subscriber load target, production LAN security, Windows installer and
three-PC operation are not claimed by these local tests. The desktop billing evidence
uses two service accounts on one subscriber; multi-subscriber, multi-office and
concurrent-client operation is Phase 9 work.


## Phase 5 verification - 2026-09-30

Payments, allocation, receipts, GCash proof verification, void and reversal are
implemented behind the API. All test data is synthetic and lives in uniquely named
disposable databases, separate from the development database. GCash receipts in the
automated run are a generated 1-pixel PNG written to a temporary proof directory that is
removed afterwards; no real customer document was used.

| Command | Observed result |
|---|---|
| `npm.cmd run check` | Strict typecheck and lint passed; 64 unit tests in 12 files, of which 17 are the payment allocation and desktop boundary tests |
| `npm.cmd run test:integration` | 50 PostgreSQL tests in 4 files, of which 14 are the Phase 5 payment suite (AT-01 to AT-06) |
| `npm.cmd run build` | Desktop main/preload/renderer production bundles generated; only the upstream Zod comment-annotation warnings |
| `npm.cmd run test:db` | `PASS: PostgreSQL connection, migration, repeat migration preserves data, API readiness.` |
| `npm.cmd run db:generate` | `No schema changes, nothing to migrate` - the checked-in schema matches the migrations |
| `npm.cmd run test:e2e` | 13 Electron tests passed, of which 2 are the new Phase 5 payment walkthroughs |
| `npm.cmd audit` | `found 0 vulnerabilities` |

The fourteen payment integration tests cover, against real PostgreSQL: authorization for
anonymous, wrong-permission and wrong-role requests; the subscriber account showing the
oldest due date and the outstanding total; exact settlement and the first receipt
(AT-01, AT-06); oldest-due-first ordering for a single payment and for one payment
covering two invoices (AT-04); overpayment held as credit and that credit spent on a
later invoice without a new payment (AT-02, AT-03); a GCash payment refused without a
reference or a receipt image, held pending until a second person confirms it, and a live
reference that cannot be reused (AT-05); a voided claim that keeps its history and frees
its reference (AT-06); a reversal that takes its own receipt and reopens the invoices it
settled (AT-06); register listing and filtering; and a direct-SQL attempt to change,
delete or unbalance a payment outside the service, which the database guards refuse
(AT-06).

The eleven payment allocation unit tests cover the arithmetic itself, without a
database: oldest-due-first order, the tie-break on issue date then identifier so a
repeated run is stable, exact settlement, advance credit when nothing is outstanding,
the retained excess of an overpayment (AT-02), never allocating to a settled invoice or
with a zero amount, refusing a negative amount, the credit still held, per-year receipt
numbering that never reuses a number, the GCash reference/receipt pairing rule, and
keeping the stored proof name on an extension the file type controls. Six further unit
tests cover the desktop payment boundary.

The two Electron walkthroughs exercise the real screens against the real API. The cash
walkthrough generates a period whose **later** due invoice is issued second, proves the
collector sees the oldest due date first, records a partial payment, then one payment
that settles both invoices and holds PHP 51.00 as credit, and finally reverses it and
observes both invoices reopened and the credit released. The GCash walkthrough records
two claims, proves a live reference is refused on reuse, proves the recorder cannot
confirm their own claim, voids one claim and then has a second user confirm the other,
which is the only point at which a receipt number is issued.

Desktop findings, each corrected before re-running:

| Symptom | Cause | Correction | Evidence |
|---|---|---|---|
| A successful payment left the confirmation banner and the account panel unusable | The tab was remounted with `key={revision}` to force a reload, which reset its state and the notice | `revision` is passed in and listed in the data-loading effect, so the data reloads without remounting | Owner Electron cash walkthrough observes the confirmation and the refreshed balance together |
| Re-picking the same receipt image after a payment did nothing | Clearing the attachment cleared the React state but not the file control, so the browser reported no change for the same file | `clearProof` also empties the control, keeping the shown state and the control in agreement | The GCash walkthrough attaches a second claim with its own image |
| A collector could not see why a posted receipt had been reversed | The dialog showed the reason for a voided entry but not for a reversed one | The `REVERSED` state now shows the reversal date and reason | The cash walkthrough opens the reversed receipt and reads the reason |
| The confirmation after a GCash confirmation omitted how many invoices were settled | The verify message was written separately from the record message and lost the count | The verify message now reports the touched invoice count, matching the record message | The GCash walkthrough asserts `PHP 200.00 applied to 1 invoice(s)` |
| The GCash walkthrough reported an empty register and receipt numbers restarting at 1001 | The cash walkthrough had failed first; Playwright discards the worker after a failure and re-runs `beforeAll`, which creates a new empty database | Fixed the first failure, so the second test runs against the state the first one left. Diagnosed with a two-test probe rather than by guessing | Both walkthroughs pass; the cashier test reads the claims the owner recorded |
| `no-control-regex` lint failure in the shared payment contract | The display-name pattern used a literal control-character range | `.min()`, `.max()` and a `\p{Cc}` refinement replace the character class | `npm.cmd run lint` passes |

Screenshots [collect payment](screenshots/payments-collect.png),
[posted receipt](screenshots/payments-receipt.png) and
[GCash verification](screenshots/payments-gcash.png) are real full-page Electron output
written by the payment walkthroughs. They are recorded as captured evidence; visual
inspection of these three images is still outstanding for a human reviewer, and the
900-pixel no-overflow assertion still covers the workspace screen only, so the payments
screens at that width remain a manual check (FND-07).

Limits: collection routes, printed route sheets, batch lifecycle, remittances,
shortage/overage and authorised reconciliation remain Phase 6; receivables, aging and
suspension/reconnection approvals remain Phase 7; reports, exports and printing remain
Phase 8. The payment allocation is serialised per subscriber by an advisory lock, but
concurrent posting from three office clients is not exercised here and remains Phase 9
work, as do backup/restore of the proof directory, the 20,000-subscriber load target,
production LAN security and the Windows installer. The GCash evidence confirms the
two-person rule with one owner and one cashier on one machine; it does not claim a
reviewed-against-the-banking-app workflow.
