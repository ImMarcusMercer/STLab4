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
| A multi-page report repeated the last page on every page, losing its earlier rows | `PageWriter.serialise` read `this.page`, the page currently being filled, instead of the page it was asked to serialise | Pass the target page into `serialise` | New geometry regression in `report-exports.test.ts`; every row of a 120-row report now appears exactly once |
| Report rows ran off the top of the page and broke after about four rows | The row cursor counted up while PDF `y` grows upward, and `fits` compared against the page top rather than the foot | Cursor counts down; the fit test measures against a floor above the bottom margin | Rows now descend the page in order and 12 rows fit one A4 landscape page |
| Subscriber statement omitted the account it belonged to | The subject block existed only in the service response; no writer emitted it | Subject added to the PDF, XLSX and CSV writers ahead of the column headings | `reports.test.ts` asserts the header in all three formats and the frozen pane follows the taller header |
| A receipt too large for one page was refused by a duplicated cap in the service | The service and the renderer each decided the limit, so the two could disagree | The renderer owns the limit; the service no longer counts lines | 20-invoice payment returns 422 naming the statement of account, with no print audited |

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


## Phase 6 verification - 2026-09-30

Collection routes, the batch lifecycle, remittance with shortage/overage, authorised
reconciliation and the printable route sheet are implemented behind the API and on the
desktop screens. All test data is synthetic and lives in uniquely named disposable
databases, separate from the development database.

| Command | Observed result |
|---|---|
| `npm.cmd run check` | Strict typecheck and lint passed; 76 unit tests in 13 files, of which 12 are the new collection contract tests |
| `npm.cmd run test:integration` | 76 PostgreSQL tests in 5 files, of which 26 are the new Phase 6 collection suite (AT-07 to AT-09) |
| `npm.cmd run build` | Desktop main, sandboxed preload and renderer production bundles generated; only the upstream Zod comment-annotation warnings |
| `npm.cmd run test:db` | `PASS: PostgreSQL connection, migration, repeat migration preserves data, API readiness.` |
| `npm.cmd run db:generate` | `No schema changes, nothing to migrate` - the checked-in schema matches migrations 0000-0013 |
| `npm.cmd run test:e2e` | 15 Electron tests passed, of which 2 are the new Phase 6 collection walkthroughs |
| `npm.cmd audit` | `found 0 vulnerabilities` |

The 26 collection integration tests cover, against real PostgreSQL: authorization for
anonymous, cashier, auditor and supervisor requests; opening a route that freezes the
account list with the latest open invoice as the current bill and the older open invoice
as arrears (AT-09); refusing an area with nothing owing; refusing an explicit subscriber
list that does not belong to the chosen area; refusing a duplicate route for the same
collector, area and date; refusing a route over the 500-account limit; narrowing a route
to a chosen account list; the automatic `OPEN` to `IN_PROGRESS` move on first collection;
cash collection, a partial collection, and a GCash claim that stays pending; the
collected, uncollected and pending figures agreeing between the list and the detail
read; a remittance that is exactly balanced (AT-07); a shortage (AT-08) and an overage
(AT-08); a nil remittance; reconciliation refused for the person who counted the cash;
reconciliation accepted by a second user; closing a balanced route; a route closed on a
shortage that still carries its variance; the route sheet; list filtering; and direct-SQL
attempts to change a batch status, edit a frozen account, edit a remittance and re-point
a recorded payment, all refused by the database guards.

The 12 collection unit tests cover the arithmetic and the contracts without a database:
per-year batch and remittance numbering, exactly one forward lifecycle step with nothing
backwards, collections refused once a route is handed in, `reconcileCash` matching
(AT-07), shortage and overage in both directions with never both set at once and negative
or fractional amounts refused (AT-08), the five account statuses, route summary sums with
pending claims held apart from collected money, the route sheet being a projection of the
detail, the 500-account bound, a required written reconciliation reason, and the detail
contract refusing a document missing a figure the printed sheet is built from.

The two Electron walkthroughs exercise the real screens against the real API. The full
route walkthrough refuses an empty area, opens a route for two accounts totalling
PHP 1000.00, refuses a duplicate route for the same day, collects PHP 500.00 in cash from
one account and observes the status move to in progress on its own, submits the route and
observes the collect form disappear, counts PHP 450.00 against the expected PHP 500.00 and
observes a stored shortage of PHP 50.00, is refused when the same user tries to reconcile
it, signs out and returns as a supervisor, reconciles with a written reason, and observes
that the shortage is still on the record afterwards. It then closes the route and opens
the printable sheet, which shows the stored batch number, area, collector, both account
lines and the day's totals. The second walkthrough proves a supervisor reaches the
collections screen and can open a route but is not offered a payment form.

Defect record, each found by a failing assertion and fixed before re-running:

| Symptom | Cause | Correction | Evidence |
|---|---|---|---|
| The route list and detail reported a shortage of PHP 0 | `remittanceColumns` aliased `shortage_centavos`, but the remittance CTE had already aliased them, and the projection used the wrong case | Project `rm.shortage_centavos`, `rm.overage_centavos` and `rm.balanced` | Shortage and overage integration cases pass |
| The route detail 500-ed on a recorded remittance | The remittance JSON subquery selected from `batch_remittances`, which is not in scope where `recordedName` is resolved | Select from the `remittance` CTE | Remittance and reconciliation cases pass |
| A snapshot with a manual arrears invoice showed arrears of PHP 0 | The fixture left the manual invoice as a draft, so it was not an open invoice | Finalise the manual invoice in the fixture | Opening-snapshot case shows the arrears |
| Reconciling a route as its own counter was expected to be a conflict | The service returns `403`, because this is a permission-style refusal rather than a state conflict | Assert `403` | Reconciliation case passes |
| The validations suite expected `400` for a rejected payload | The API answers a schema failure with `422` | Assert `422` | Validation cases pass |
| The desktop boundary snapshot listed nine operations too few | `desktop.spec.ts` pins the exact preload surface as a security boundary | Added the nine collection operations | Desktop boundary test passes |
| `master-data.spec.ts` could not find `New area` | The areas/collectors setup moved under the Collections module behind its own tab | The walkthrough clicks the *Areas & collectors* tab first | 15 Electron tests pass |
| A route's account dropdown rejected the subscriber id | The option value was the internal `batch_accounts` join id, not the subscriber the payment needs | The option value is the subscriber id, which is also what the row highlight and the payment call use | The route walkthrough selects an account and collects |
| The signing supervisor could not read what the collector wrote | The remittance block showed the counts but not the stored notes | The collector's note is displayed beside the variance | The walkthrough asserts the stored note |
| The walkthrough could not find `Open route` | The control carries `aria-label="Open collection route"`, which is its accessible name | The test addresses the accessible name | Route walkthrough opens the form |

The e2e suite runs against the built application in `out/`, so a renderer change requires
`npm.cmd run build` before `npm.cmd run test:e2e`. That was confirmed twice during this
phase and is recorded here so a later reviewer does not read a stale bundle as a code
defect.

Screenshots [route in progress](screenshots/collections-route.png),
[shortage pending sign-off](screenshots/collections-remittance.png) and
[route sheet](screenshots/collections-route-sheet.png) are real full-page Electron output
written by the collection walkthrough. They are recorded as captured evidence; visual
inspection of these three images is still outstanding for a human reviewer, and the
900-pixel no-overflow assertion still covers the workspace screen only, so the collection
screens at that width remain a manual check (FND-07).

Limits: receivables, aging and suspension/reconnection approvals remain Phase 7; reports,
exports and non-route printing remain Phase 8. The collection evidence uses two accounts
in one area with one collector and one machine; concurrent posting from three office
clients, a 20,000-subscriber load target, production LAN security, backup/restore of the
proof directory and the Windows installer are not claimed by these local tests. The
printed sheet was asserted from the rendered DOM and not sent to a physical printer.

## Phase 7 verification — 2026-10-01

| Symptom | Cause | Fix | Evidence |
|---|---|---|---|
| The technician query failed at runtime | The projection selected `r.role`, but `user_roles` has no such column | Select `r.role_code` | Technician list is returned and the assignment walkthrough passes |
| A reconnection request with no fee was refused | `RequestReconnectionInput.feeCentavos` was required, so the policy default was unreachable | Make the fee optional; the service falls back to `reconnectionFeeCentavos` | The walkthrough omits the fee and files at the policy figure |
| The desktop bridge threw on a lifted suspension | `liftedAt` serialised as a full ISO timestamp while `IsoDate` expects `YYYY-MM-DD` | Return the date only | Lift and completion both render |
| Every fixture invoice landed in one aging band | The test billed the same date four times, so `monthsUnpaid` could not differ | Stagger the issue dates one month apart | The bands show four different values |
| `Suspend` was offered on an account inside the grace period | The button was rendered from the row existing, not from the server's eligibility answer | Render the command only when `suspensionCandidate` is true and the account is `ACTIVE` | The grace row has no command, and the API refuses independently |
| The suspension form vanished as soon as the reason was typed | A conditional in the panel returned early once the reason was non-empty | Track the form unconditionally and disable the submit instead | The form stays open and the confirm button enables |
| The technician select and its button shared an accessible name | The `select` label and the submit `aria-label` were both "Assign technician" | Label the select `Choose technician` | One locator, one control |
| The history list never mentioned a reconnection | The list rendered the stored summary, which names the document number rather than the event | Include the event type in each history line | The trail reads "reconnection completed" |
| An auditor test expected a register row that the API refuses | `listSuspensions` requires `service.control`, which the auditor does not hold | Assert the refusal, and hide the register and policy tabs for users without `service.control` | The auditor sees the aging report only |
| A post-reconnection suspension was expected to succeed | The account owes nothing after the settlement, so the policy refuses it | Assert `409` for both the settled account and the grace account, and that exactly one suspension row exists | The walkthrough passes |
| `db:generate` reported drift after Phase 7 | The `service_status` constraint had been hand-edited inside `0015`, so the applied history no longer matched `database/schema.ts` | Add `SUSPENDED` to the schema and regenerate as `0016_service_status_suspended.sql` | `No schema changes, nothing to migrate` for 0000–0016 |
| The desktop boundary test failed after the bridge grew | `desktop.spec.ts` pins the exact preload surface as a security boundary | Add the thirteen receivables operations to the pinned list | Boundary test passes |

Executed 2026-10-01, each command on its own:

- [x] `npm.cmd run typecheck` — exit 0.
- [x] `npm.cmd run lint` — exit 0, no warnings.
- [x] `npm.cmd run build` — exit 0; main, preload and renderer bundles written to `out/`.
- [x] `npm.cmd test` — `Test Files 13 passed (13)`, `Tests 76 passed (76)`.
- [x] `npm.cmd run test:integration` — `Test Files 6 passed (6)`, `Tests 97 passed (97)`; `tests/integration/receivables.test.ts` contributes 21.
- [x] `npx playwright test --config playwright.config.ts tests/e2e/receivables.spec.ts` — `2 passed`.
- [x] `npm.cmd run test:e2e` — `17 passed`, including the receivables aging/suspension/reconnection walkthrough and the auditor restriction walkthrough.
- [x] `npm.cmd run test:db` — `PASS: PostgreSQL connection, migration, repeat migration preserves data, API readiness.`
- [x] `npm.cmd run db:generate` — `No schema changes, nothing to migrate` for 0000–0016.
- [x] `npm.cmd audit` — `found 0 vulnerabilities`.

Screenshots [aging report](screenshots/receivables-aging.png),
[suspended account](screenshots/receivables-suspended.png) and
[reconnected account](screenshots/receivables-reconnected.png) are real full-page Electron
output written by the receivables walkthrough, and the aging screenshot was taken while the
window was resized to 900 px, so the no-overflow assertion and the image agree. They are
recorded as captured evidence; visual inspection of these three images is still outstanding
for a human reviewer.

Limits: financial reports, exports, subscriber statements and non-route printing remain
Phase 8. The aging report was asserted from the rendered DOM and has not been sent to a
physical printer. The manual REC-01 to REC-18 walkthrough in `TEST_CHECKLIST.md` section 10c
has not been performed by a human. This phase adds no automated evidence for the
20,000-subscriber load target, concurrent posting from three office clients, LAN security, or
backup and restore of the proof directory.

## Phase 8 verification - 2026-10-02

Phase 8 covers management KPIs and reports, PDF/XLSX/CSV export, official receipts, subscriber
statements and the desktop document actions that reach them.

| Command | Observed result |
|---|---|
| `npm.cmd run typecheck` | TypeScript strict passed with no diagnostics |
| `npm.cmd run lint` | ESLint passed |
| `npm.cmd test` | `Test Files 16 passed (16)`, `Tests 179 passed (179)` |
| `npm.cmd run test:integration` | `Test Files 8 passed (8)`, `Tests 153 passed (153)`; `tests/integration/receipts.test.ts` contributes 15 and `tests/integration/reports.test.ts` 41 |
| `npm.cmd run test:e2e` | `17 passed`, including the official-receipt save through the native dialog |
| `npm.cmd run build` | Main, preload and renderer bundles built; only the pre-existing zod annotation warnings |

Coverage added in this phase:

- `tests/integration/receipts.test.ts` proves exact, partial and advance receipts, that a voided
  GCash claim keeps its history and reports the discarded claim, that a reversal negates the
  original allocations, that producing a receipt needs `report.export`, that the audit record
  is written only after the bytes render, and that an oversized payment is refused.
- `tests/integration/reports.test.ts` proves all nine reports reconcile, that `AR_AGING` agrees
  with the receivables summary, and that a statement names its account in the JSON and on paper
  in PDF, XLSX and CSV.
- `report-exports.test.ts` reads the y coordinate of every row back out of the content stream.
  This is the only assertion style that would have caught the page-ordering and cursor-direction
  defects above: the affected files still contained all their text, still parsed as a PDF and
  still had valid byte offsets.
- `payments.spec.ts` saves a receipt through the native save dialog during the cashier
  walkthrough and asserts the bytes on disk begin `%PDF` and name the receipt number.

Screenshot [official receipt](screenshots/payments-official-receipt.png) was written by that
walkthrough. It has not been visually inspected by a human reviewer.

Limits: the generated documents have not been sent to a physical printer, and the manual
`TEST_CHECKLIST.md` walkthrough for this phase has not been performed by a human. The exported
file is bounded to 5,000 rows per file with a truncation note in the footnote. Backup and restore
of the generated documents, installer packaging, LAN deployment and three-client concurrency
remain Phase 9.

## Phase 9 verification - 2026-10-03 (security, logging, indexes, data volume)

Hardening review and the realistic data-volume check. The backup item above is unchanged; the
concurrency (AT-09) and installer/LAN items in this phase remain pending and are still unchecked in
`TASK.md`.

| Command | Observed result |
|---|---|
| `npm run typecheck` | Passed, no diagnostics |
| `npm run lint` | Passed |
| `npm run build` | Main, preload and renderer bundles built |
| `npm test` | `Test Files 17 passed (17)`, `Tests 200 passed (200)` (was 16 files / 189 tests; `tests/unit/logging.test.ts` adds 11) |
| `npm run test:integration` | `Test Files 9 passed (9)`, `Tests 163 passed (163)`; `tests/integration/security.test.ts` contributes 8 against a real PostgreSQL database |
| `npm run test:e2e` | `19 passed` |
| `npm run test:db` | `PASS: PostgreSQL connection, migration, repeat migration preserves data, API readiness.` |
| `npm run db:generate` | `No schema changes, nothing to migrate` |
| `npm run db:migrate` | Migration `0019_search_and_volume_indexes` applied to the local database |
| `npm run test:performance` | `PASS: 19 screens within budget on 20,000 subscribers, index plans confirmed.` |

Structured logging and redaction are proved by reading real log output, not by inspecting
configuration. `tests/unit/logging.test.ts` (11 cases): the default level and service name, ISO
timestamps, redaction of the authorization header, cookies, passwords, tokens and proof bytes, a
PostgreSQL connection string scrubbed out of an error *message* and out of a *stack*, the request
serializer exposing only method, URL, request id, address and user agent, the three security
headers on every response, and the injectable stream. `tests/integration/security.test.ts` (8
cases): successful and failed logins recorded under `auth.login.succeeded` / `auth.login.failed`
with no password, no session token and no stored SHA-256 digest; a revoked session; an
unauthenticated request as `security.unauthenticated`; a refused permission as
`security.permission_denied`; a readiness failure reported during a database outage with no
connection string in the line; and no secret anywhere in the captured log.

Data volume. `scripts/performance-check.ts` seeded a throwaway database with 20,000 subscribers,
20,000 service accounts, 140,000 invoices, 140,000 invoice lines, 41,692 payments, 41,692
allocations and 181,692 ledger entries, then measured 19 screens through the real routes with
`BCIS_RUNS=3`. Every screen was inside its budget; the slowest were the overdue worklist at
2,219 ms against 15,000, the revenue report at 1,436 ms against 10,000 and the dashboard at
977 ms against 10,000. The check also requires the index plans to be named
(`subscribers_name_trgm_idx`, `invoices_open_service_idx`, `payments_posted_subscriber_idx`) with no
sequential scan, and reconciles the receivable total (10,512,576,850 centavos) against the stored
open balances and the aging buckets.

Defects found and fixed by this review:

1. **`GET /receivables/summary` returned 500 at 20,000 subscribers.** `coalesce(sum(...),0)::int`
   casts a 64-bit sum to 32 bits; a receivable above PHP 21,474,836.47 overflows, which 20,000
   accounts pass without any single figure looking unusual. Every money aggregate that spans the
   whole office is now `bigint`, and `readWideNumbersAsNumbers()` converts 64-bit results to
   numbers once at the pool so the published contracts are unchanged.
2. **A database password reached the log through an error stack.** Found by the new integration
   suite on its first run; `err.message` and `err.stack` are now scrubbed of connection strings
   and `password=`-style assignments before they are written.
3. **The plan check itself was measuring the wrong thing.** Straight after a bulk insert, GIN
   pending lists and an unvisited visibility map make PostgreSQL cost a trigram search far above
   what it costs in steady state, so the check saw a sequential scan the office would never get.
   The harness now runs `VACUUM (ANALYZE)` before the plan checks, and below the reviewed volume it
   checks that the index is available rather than that it is chosen.

Limits: a single billing cycle is capped at PHP 9,999,999.99 by the `moneyBounds` check on every
stored money column, which at PHP 999 a month is about 10,000 subscribers per cycle; the read paths
that summarise those cycles are `bigint` and unaffected. The volume check writes invoices directly
rather than running billing generation, so it measures the read paths rather than the billing write
path. `npm audit` reports 8 high severity vulnerabilities, all in the `electron-builder` packaging
chain (GHSA-ch52-4w7c-c8xp), with no non-breaking fix; they are build-time dependencies not loaded by
the running application, and the finding is carried into the installer item. Screenshots for this
item do not exist, and no human has reviewed this evidence.

## Phase 9 verification - 2026-10-02

Phase 9 covers database and attachment backup, verified restore, integrity checking and AT-12.
The concurrency (AT-09), hardening/performance and installer/LAN items in this phase remain
pending and are still unchecked in `TASK.md`.

| Command | Observed result |
|---|---|
| `npm.cmd run typecheck` | TypeScript strict passed with no diagnostics |
| `npm.cmd run lint` | ESLint passed |
| `npm.cmd run build` | Main, preload and renderer bundles built |
| `npm.cmd test` | `Test Files 16 passed (16)`, `Tests 189 passed (189)` |
| `npm.cmd run test:integration` | `Test Files 9 passed (9)`, `Tests 169 passed (169)`; `tests/integration/backups.test.ts` contributes 16 |
| `npm.cmd run test:e2e` | `19 passed`, including `tests/e2e/backups.spec.ts` |

Design and the reasoning behind each decision: [PHASE9.md](PHASE9.md).

Coverage added in this phase:

- `tests/integration/backups.test.ts` takes a **real** `pg_dump` custom-format archive, asserts it
  begins `PGDMP`, that its recorded size and SHA-256 match the bytes on disk, and that the server
  listed it back with `pg_restore` before recording it as complete.
- AT-12 restores over deliberately changed data: the row counts come back to the ones the backup
  recorded, the subscriber created after the backup is gone, the reason reaches `audit_logs`, and
  any table whose count differs is named in the report.
- A damaged file (one flipped byte) and a file that is not a PostgreSQL archive are both refused
  **before anything is written**, and the live subscriber count is asserted unchanged afterwards.
- The snapshot guarantee is proved rather than asserted. `pg_dump` is held open while a payment is
  posted; the archive is then restored into a **separate** database and counted directly, so the
  recorded counts are compared against the bytes that were written rather than against what the API
  says about them. The subscriber created mid-backup is absent from both.
- A FULL backup carries a GCash payment proof to disk and back; the same backup is abandoned with a
  recorded reason when a stored proof no longer matches its uploaded digest.
- A failed read-back is recorded as `FAILED` with the tool's own words, claims no size, stays visible
  in the history, and is refused for both verify and restore.
- The permission split is asserted: cashier refused everything, auditor may view and verify but not
  create, administrator may create but not restore, owner may do all four.
- The history is newest-first, contains failures, never returns a connection string, and is marked
  `no-store`.
- `tests/unit/auth-client.test.ts` holds the desktop boundary from both sides: nothing comes back
  but the server's own account, nothing goes out that could name a file, a malformed history is
  rejected, the confirmation word is required before a request is made, a restore report that
  disagrees with the backup is shown rather than tidied away, and a backup slower than ten seconds
  does not time out.
- `tests/unit/renderer-security.test.ts` asserts no backup call takes a path, folder or file name,
  that no archive bytes cross the bridge, and that the confirmation word is still checked in the
  renderer.
- `tests/e2e/backups.spec.ts` walks the operator's path: the nav entry appears for an owner and not
  for a cashier, a full backup is taken, the archive on disk begins `PGDMP`, verification reports
  `Verified`, a subscriber created afterwards is gone after the restore, the restore button stays
  disabled until `RESTORE` and a reason are typed, and the reason reaches the audit trail.

Screenshots `screenshots/backups-history.png` and `screenshots/backups-restore-confirmation.png`
were written by that walkthrough and have not been visually inspected by a human reviewer.

Defects found and fixed while building this:

1. **Every restore failed.** `pg_restore: one of -d/--dbname and -f/--file must be specified` --
   unlike `pg_dump` and `psql`, `pg_restore` does not fall back to `PGDATABASE`. Fixed by passing the
   database name as `--dbname` while the password stays in `PGPASSWORD`.
2. **A recorded failure could not be read back.** `CHECK (byte_size >= 1)` with a placeholder of `1`
   meant a failed backup claimed a size it never had. Now `>= 0`, and a failure claims none.
3. **One failed backup broke the whole history listing.** `z.record(z.enum([...]))` is exhaustive in
   Zod 4, so the empty `row_counts` of a recorded failure failed validation and every listing
   returned 500. Changed to `z.partialRecord`.
4. **A backup could describe a different database than the one being served.** The routes read
   `process.env.DATABASE_URL` while authentication used the injected pool; now taken from the pool.
5. **Recorded counts could not match the archive.** Counting in a separate transaction meant a
   payment posted during a dump was counted but not archived. Fixed with `pg_export_snapshot`.
6. **A restore killed every session on the database,** including the idle connections belonging to
   the other office clients. Now only sessions holding an open transaction are ended.
7. **A restore rewound the backup's own record to "Backup in progress",** because the archive
   contains that row as it stood mid-flight. It is set back to `COMPLETED` after the counts check.

Limits: a FULL restore does not delete proofs added after the backup; `pg_dump` and `pg_restore` are
taken from `PATH`; the backup screenshots have not been reviewed by a human; no physical operator has
performed the manual walkthrough.
