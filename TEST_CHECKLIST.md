# Test and verification checklist — completed Phases 1–5

> **RECONSTRUCTION NOTICE — read first.** This file was accidentally truncated to 1 byte
> during a section-reordering edit and could not be recovered: the project has no git
> commits, and no backup or shadow copy was accessible. The content below has been
> restored verbatim from the portions that were read earlier in the same session.
> Sections marked `[NOT RECOVERED]` were not captured and are **missing content, not
> passing checks**. They must be rewritten before this checklist is used for a
> verification run. Nothing here has been invented to fill a gap.

Scope: foundation, authentication/RBAC, plans, subscribers, service accounts, collection areas, collectors, assignments, billing cycles, invoice documents, the subscriber ledger, and payments/allocation/receipts. Based on [TASK.md](TASK.md), the current implementation and [recorded test evidence](docs/TEST_EVIDENCE.md).

This is a **new, unexecuted checklist**. Existing automated results are historical evidence, not a pass for this run. Check a box only after its expected result is observed. Record failures or blocked checks in the results table at the end.

## Run details

| Field | Value |
|---|---|
| Tester | |
| Date/time | |
| Build/commit or source snapshot | |
| Windows / Node / PostgreSQL versions | |
| Database and API location | |
| Test-data prefix, e.g. `QA260928A` | |
| Evidence folder | |

Use synthetic records with a unique prefix for each run. Manual records persist in the development database; deactivate/archive them afterward. Do not delete the database to reset tests. Keep passwords, tokens and `.env` contents out of screenshots and reports.

## 1. Prepare the application

Run commands from `BCIS-Subscription-Billing-System` in PowerShell. See [README](README.md) for prerequisites and initial setup.

```powershell
# First setup only, or when dependencies need reinstalling:
npm.cmd ci
npm.cmd run db:setup

# Before this verification run:
npm.cmd run db:start
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

- [ ] **SET-01 — Launch:** Start the application. **Expected:** Electron opens the sign-in screen; the connection indicator becomes “All systems connected.”
- [ ] **SET-02 — Owner credentials:** Sign in with the bootstrap username (normally `owner`) and the locally stored bootstrap password, or the account's subsequently changed password. **Expected:** The workspace opens. Rerunning `db:seed` does not reset an existing password.
- [ ] **SET-03 — Project isolation:** Compare `git -C ../student-information-api status --short` with the pre-run baseline. **Expected:** BCIS setup/testing introduces no changes to the previous student project.

Prepare these records through the application, replacing `QA` with your run prefix. Create staff login accounts through **Administration**; create field collectors through **Collections**. These are separate record types.

| Record | Suggested synthetic values |
|---|---|
| Staff users | One each: Administrator, Cashier, Collection Supervisor, Technician, Viewer; unique usernames and locally chosen passwords of 12+ characters |
| Area | Code `QA-AREA`, name `QA Central route`, active |
| Collector | Code `QA-COL`, name `QA Sample Collector`, contact `09170000000`, active |
| Internet plan | Code `QA-NET`, name `QA Internet`, monthly PHP 999.00, installation PHP 1,000.00, reconnection PHP 100.00, speed 100 Mbps, no channel count |
| Cable plan | Code `QA-CABLE`, monthly PHP 350.00, channel count 50, no speed |

`[NOT RECOVERED]` The remainder of the fixture table (Combo plan and any further rows) and
the closing text of section 1.

## 2. Foundation and connection handling

`[NOT RECOVERED]` This section's checks were not captured.

## 3. Authentication and user administration

`[NOT RECOVERED]` This section's checks were not captured.

## 4. Role permissions

`[NOT RECOVERED]` This section's checks were not captured.

## 5. Plans and exact prices

- [ ] **PLAN-01 — Plan types:** Create the Internet, Cable and Combo fixtures through **Subscribers → Plans**. **Expected:** All three types save with their correct attributes, fees and active status.
- [ ] **PLAN-02 — Attribute validation:** Try speed on a Cable-only plan and channel count on an Internet-only plan. **Expected:** Validation rejects incompatible attributes.
- [ ] **PLAN-03 — Exact amounts:** Save PHP 999.01 and reopen the plan. **Expected:** It displays 999.01 exactly; API storage is 99901 centavos. Restore the fixture rate to 999.00 before RATE-01.
- [ ] **PLAN-04 — Invalid amounts:** Try `-1`, `1.001`, `1e3` and `10000000` in a PHP money field. **Expected:** Each is rejected; no partial record/revision is saved.
- [ ] **PLAN-05 — Duplicate code:** Try creating the same plan code again using lowercase and surrounding spaces. **Expected:** Normalization still detects the duplicate; saving fails.
- [ ] **PLAN-06 — Permanent identity:** Edit a saved plan. **Expected:** Its code and service type cannot be changed; create a separate plan for another type.
- [ ] **PLAN-07 — Deactivate:** Deactivate an otherwise unused plan. **Expected:** It remains searchable with All statuses/Inactive and retains history, but cannot be newly assigned to a service.

## 6. Subscribers and multiple service accounts

- [ ] **SUB-01 — Create:** Create the subscriber fixture with both addresses, contact details, area/collector, billing/due days and notes. **Expected:** Saving succeeds; reopening shows all values and both addresses.
- [ ] **SUB-02 — Validate:** Try a missing name/address, malformed nonempty email, billing day 0 and due day 32. **Expected:** Each invalid submission is rejected with field feedback. Days 1 and 31 are accepted; calendar-month clamping belongs to Phase 4.
- [ ] **SUB-03 — Unique account:** Try creating the subscriber account number again. **Expected:** Duplicate creation fails. The existing subscriber's account number is read-only when editing.
- [ ] **SUB-04 — Search:** Search separately by account number, name, contact, main address and secondary address. **Expected:** Each finds the subscriber. A nonexistent search shows an empty state.

`[NOT RECOVERED]` SUB-05 onward, and the remainder of section 6.

## 7. Rate history, collections and reference integrity

`[NOT RECOVERED]` This section's checks were not captured.

## 8. History, concurrency and list usability

`[NOT RECOVERED]` This section's checks were not captured.

## 9. Billing cycles, invoice documents and the account ledger

`[NOT RECOVERED]` BIL-01 through BIL-17 were not captured. BIL-18 is retained below.

- [ ] **BIL-18 — Narrow layout:** At approximately 900 × 700 open Billing cycles, the invoice list and an invoice dialog. **Expected:** The command panel, tables and dialog actions stay reachable and readable; tables and the dialog body scroll rather than overflowing. The automated no-overflow check covers the workspace screen only, so this is a manual step.

- [ ] **FND-07 — Desktop layout:** Resize to approximately 900 × 700; open lists and a long form. **Expected:** Navigation and controls remain reachable and readable.

`[NOT RECOVERED]` FND-01 through FND-06, and any closing text for section 9.

## 10. Payments, allocation and receipts

Prepare the Phase 5 fixture: one subscriber with two active services whose billing and
due days differ, so one invoice becomes due before the other even though the later-due
one is issued first. Generate a period so both invoices exist.

- [ ] **PAY-01 — Open account:** On **Payments**, search the subscriber code and click **Collect from …**. **Expected:** The panel shows the outstanding total, advance credit, the oldest open due date and each invoice with its status. A subscriber with no invoice shows the empty state.
- [ ] **PAY-02 — Oldest due first:** Note the due dates. The panel and the allocation preview list the invoice with the earlier due date first, although it was issued second. **Expected:** Ordering follows the due date, not the invoice number or issue order.
- [ ] **PAY-03 — Exact payment (AT-01):** Record a cash payment equal to one invoice balance. **Expected:** That invoice becomes `PAID`, the receipt is issued, and the panel reloads with the confirmation still visible.
- [ ] **PAY-04 — Partial payment (AT-02):** Record a cash payment smaller than the oldest balance. **Expected:** The invoice becomes `PARTIALLY_PAID` with the remaining balance, and the confirmation reports the amount applied.
- [ ] **PAY-05 — One payment, two invoices (AT-04):** Record a single payment larger than the oldest balance but smaller than the combined total. **Expected:** It settles the oldest invoice completely and then the next, oldest first, and the receipt dialog lists both allocations in that order.
- [ ] **PAY-06 — Advance credit (AT-03):** Record a payment larger than everything outstanding. **Expected:** The confirmation reports the applied total and the amount held as advance credit, and the panel shows that credit on the account.
- [ ] **PAY-07 — Credit is spent later:** Issue a further period for the same subscriber, then record any payment. **Expected:** The held credit settles the new invoice first and is shown as `CREDITED`; no money is lost and the credit does not double-count.
- [ ] **PAY-08 — Receipt numbering:** Open **Payment history**. **Expected:** Receipt numbers are per year, start at `1001`, are gap-free, and are never reused — not by a voided or reversed entry.
- [ ] **PAY-09 — GCash needs proof (AT-05):** Select **GCash** and submit without a reference, then with a reference but no image. **Expected:** Each is refused with a clear message and nothing is recorded.
- [ ] **PAY-10 — Proof validation:** Attach a file larger than 5 MB, and a `.png` that is really a text or executable file renamed. **Expected:** Both are refused; the type is checked against the file's actual bytes, not its name.
- [ ] **PAY-11 — Pending claim is inert (AT-05):** Record a valid GCash claim. **Expected:** It appears as `PENDING` with no receipt number, the invoice balance is unchanged, and the statement has no new line.
- [ ] **PAY-12 — No self-confirmation (AT-05):** As the recording user, open the claim and try to confirm. **Expected:** The control is disabled with the reason shown, and the API refuses the confirmation independently.
- [ ] **PAY-13 — Duplicate reference (AT-05):** Record a second claim reusing the first claim's reference. **Expected:** It is refused. Void the first claim, then the reference becomes reusable.
- [ ] **PAY-14 — Second-person confirmation (AT-05):** Sign in as a different authorised user, open the claim, view the attached receipt and confirm. **Expected:** Only now is a receipt number issued, the balance falls and the statement shows the credit.
- [ ] **PAY-15 — Void history (AT-06):** Void a pending claim with a reason. **Expected:** The entry stays in the register as `VOID` with its reason, posts nothing, and the reference is released.
- [ ] **PAY-16 — Reversal (AT-06):** Open a posted receipt and reverse it with a reason. **Expected:** A new entry with its own receipt number and a linked ledger debit appears, the original moves to `REVERSED` and keeps its number, and the invoices it had settled are reopened with their balances.
- [ ] **PAY-17 — Void and reverse are distinct:** Try to void a posted receipt, and to reverse a pending or already reversed one. **Expected:** Each is refused; void is for entries that never posted, reverse for money that did.
- [ ] **PAY-18 — Recorded money is immutable:** Attempt to change or delete a recorded payment, an allocation or an attached proof directly in the database. **Expected:** Every attempt is refused. Only a posting transaction may move a payment's state or mark an allocation reversed.
- [ ] **PAY-19 — Proof path safety:** Confirm the stored attachment is written under a generated name, and that the recorded SHA-256 matches the file. **Expected:** The original file name is display-only, and the digest recorded with the payment matches the bytes on disk.
- [ ] **PAY-20 — Permissions:** Repeat a recording, a confirmation and a reversal as Cashier and as Auditor. **Expected:** Cashier can record, view and confirm but sees no reverse control and is refused by the API; Auditor can read and reverse but cannot record.

## 10b. Collections, remittance and route sheets

These checks have not been walked through by a human. Phase 6 is covered by automated
tests instead: 12 collection contract unit tests, 26 real-PostgreSQL collection
integration tests (AT-07 to AT-09) and 2 Electron walkthroughs. Run them before ticking
anything here.

Prepare the Phase 6 fixture: an area with two accounts that have an open balance, a
second area with nothing owing, and one collector. Generate a period so both accounts
have an issued invoice.

- [ ] **COL-01 — Areas and collectors:** On **Collections → Areas & collectors**, create an area and a collector. **Expected:** Both save with generated codes, appear in the table, and are selectable when a route is opened.
- [ ] **COL-02 — Empty area is refused:** Open a route for the area with nothing owing. **Expected:** It is refused with a message that no active account has an open balance, and no route is created.
- [ ] **COL-03 — Open a route:** Open a route for the collector and the populated area. **Expected:** The batch number is issued, the route lists both accounts with the frozen amounts due, and the newest open invoice is the current bill while older open invoices appear as arrears (AT-09).
- [ ] **COL-04 — One route per day:** Try to open a second route for the same collector, area and date. **Expected:** It is refused.
- [ ] **COL-05 — Out-of-area account is refused:** Open a route naming an account from another area. **Expected:** It is refused.
- [ ] **COL-06 — Route bound:** Confirm a route cannot exceed 500 accounts. **Expected:** An area beyond the bound is refused with the limit stated.
- [ ] **COL-07 — Cash collection:** Collect a cash payment on one route account. **Expected:** A receipt is issued carrying the batch number, the account moves toward `COLLECTED`, and the route moves to in progress on its own.
- [ ] **COL-08 — Partial and unpaid accounts:** Collect part of one balance and nothing from another. **Expected:** The account statuses read `PARTIAL` and `PENDING`, and the uncollected figure matches the route total.
- [ ] **COL-09 — Pending GCash is not money:** Record a GCash claim on the route. **Expected:** It appears as a pending figure, not as collected money, and the route cannot be submitted while it is outstanding.
- [ ] **COL-10 — Submit freezes the sheet:** Submit the route. **Expected:** The confirmation states no further collections are accepted, and the collect control disappears.
- [ ] **COL-11 — Exact remittance (AT-07):** Count cash equal to the expected cash. **Expected:** The route is balanced with no shortage or overage.
- [ ] **COL-12 — Shortage (AT-08):** Count less cash than expected. **Expected:** A shortage equal to the difference is stored and shown; the route is not silently balanced.
- [ ] **COL-13 — Overage (AT-08):** Count more cash than expected. **Expected:** An overage equal to the difference is stored and shown, and only one of shortage or overage is ever set.
- [ ] **COL-14 — Nil remittance:** Count zero cash on a route with no collections. **Expected:** It is accepted as a legitimate nil remittance.
- [ ] **COL-15 — No self-signature:** As the person who counted the cash, try to reconcile. **Expected:** The reconciliation is refused and the reason is shown.
- [ ] **COL-16 — Second-person reconciliation:** Sign in as another authorised user, reconcile with a written reason. **Expected:** The remittance is signed, and the shortage is still on the record with the explanation.
- [ ] **COL-17 — Reconciliation reason is required:** Try to reconcile with a blank reason. **Expected:** It is refused.
- [ ] **COL-18 — Close:** Close a reconciled route. **Expected:** The route is kept as history and its sheet, remittance and collections remain readable.
- [ ] **COL-19 — Route sheet:** Print the route sheet. **Expected:** The printed document shows the batch number, area, collector, every account line and the day's totals, and the workspace navigation is not printed.
- [ ] **COL-20 — Permissions:** Repeat opening, collecting, remitting and reconciling as Cashier, Auditor and Supervisor. **Expected:** Cashier and Auditor never see the module; Supervisor manages routes but is offered no payment form, because a collection needs both permissions.

## 10c. Receivables, aging and service control

These checks have not been walked through by a human. Phase 7 is covered by automated tests
instead: 21 real-PostgreSQL receivables integration tests (including the AT-10 aging bands)
and 2 Electron walkthroughs. Run them before ticking anything here.

Prepare the Phase 7 fixture: one account past the policy with an open balance, one account
inside the grace period, one account with a payment recorded and nothing owing, a fee policy
that says so explicitly, and at least one active technician.

- [ ] **REC-01 — Aging totals reconcile:** Open the aging report. **Expected:** The grand total equals the sum of the bands, and each band equals the sum of its accounts.
- [ ] **REC-02 — Bands follow each invoice's own date (AT-10):** Bill an account four times a month apart and let each invoice age. **Expected:** Each invoice sits in the band its own issue date places it in, not all four in the oldest account's band.
- [ ] **REC-03 — Only open invoices count:** Pay one invoice in full. **Expected:** It leaves the report and the total falls by exactly its balance.
- [ ] **REC-04 — Overdue filters:** Filter by band and by service status, then search by code. **Expected:** Only matching rows are listed, the count agrees with the rows, and an empty result says so.
- [ ] **REC-05 — Detail figures match:** Open one account. **Expected:** Current bill, arrears, total due, days overdue and last payment on the row equal the detail panel.
- [ ] **REC-06 — Grace period protects the account:** Try to disconnect an account inside `gracePeriodDays`. **Expected:** The control is not offered, and the API refuses independently with `409` and leaves the service `ACTIVE`.
- [ ] **REC-07 — Threshold protects the account:** Try to disconnect an account below `suspensionThresholdCentavos`. **Expected:** Refused with the reason shown.
- [ ] **REC-08 — Reason is compulsory:** Open the disconnection form and try to confirm with a blank reason. **Expected:** The confirm button is disabled and the API would refuse.
- [ ] **REC-09 — The document freezes the figure:** Disconnect an account, then pay its invoice. **Expected:** The register still shows the arrears figure from the moment of the decision, with its suspension number, reason and actor.
- [ ] **REC-10 — Reconnection needs the money cleared:** Request a reconnection while the balance is open. **Expected:** Refused with a message about the outstanding balance, and no reconnection document is filed.
- [ ] **REC-11 — Fee comes from the policy:** Request a reconnection without naming a fee. **Expected:** The confirmation shows `reconnectionFeeCentavos` from the policy before it is filed.
- [ ] **REC-12 — Two steps, two people:** Assign a technician, then complete the work as that technician. **Expected:** The register shows the assignment and the completion separately, each with its actor.
- [ ] **REC-13 — Only completion restores service:** Lift the suspension directly. **Expected:** The lift is recorded with its own reason in the history, and the trail still shows the reconnection.
- [ ] **REC-14 — Nothing is deleted:** Try to edit or delete a suspension, a reconnection or a history row directly in the database. **Expected:** Every attempt is refused.
- [ ] **REC-15 — History is the record:** Read the service history for a completed case. **Expected:** Suspension, reconnection request, assignment, completion and lift each appear once, with dates, amounts and actors, and nothing is recalculated onto them.
- [ ] **REC-16 — Policy changes take effect:** Change the grace period or threshold, then re-open the aging report. **Expected:** The affected account's command appears or disappears accordingly.
- [ ] **REC-17 — Auditor reads money, not decisions:** Sign in as Auditor. **Expected:** The aging report is readable and the register and policy tabs are not offered; a direct API call is refused with `403`.
- [ ] **REC-18 — Permissions:** Repeat suspension, lift, request and completion as Cashier, Auditor and Supervisor. **Expected:** Only OWNER, ADMIN and SUPERVISOR can act, and the API refuses the others regardless of the screen.

## 11. Automated and technical verification

Close the development desktop/server before E2E testing so the configured ports are available. Keep PostgreSQL running. Run each command separately; record its exit code and summary. Existing integration/E2E helpers use uniquely named disposable test databases, not development-table truncation.

| Check | Command | Expected result / previous baseline |
|---|---|---|
| AUTO-01 | `npm.cmd run check` | Exit 0; strict TypeScript, ESLint and unit tests pass. Previous baseline: 76 tests. |
| AUTO-02 | `npm.cmd run test:integration` | Exit 0; real PostgreSQL auth/RBAC, master-data, billing, payment, collection and receivables tests pass. Previous baseline: 97 tests. |
| AUTO-03 | `npm.cmd run build` | Exit 0; main, preload and renderer bundles generated. Run before E2E. |
| AUTO-04 | `npm.cmd run test:e2e` | Exit 0; Electron workflows pass, including the billing, payment, collection and receivables walkthroughs. Previous baseline: 17 tests. |
| AUTO-05 | `npm.cmd run test:db` | Connection, migration, repeat migration and readiness pass. |
| AUTO-06 | `npm.cmd run db:generate` | “No schema changes.” If a migration is generated unexpectedly, record/review the drift; do not treat it as a pass. |
| AUTO-07 | `npm.cmd audit` | Review current results. Previous baseline: zero vulnerabilities; this result may change over time. |

Executed 2026-10-01 after the Phase 7 changes, each on its own:

- [x] **AUTO-01** — exit 0; strict typecheck and lint clean; `Test Files 13 passed`, `Tests 76 passed` in 13 files.
- [x] **AUTO-02** — exit 0; `Test Files 6 passed (6)`, `Tests 97 passed (97)`, of which 21 are the receivables suite in `tests/integration/receivables.test.ts`.
- [x] **AUTO-03** — exit 0; main, preload and renderer bundles written to `out/`.
- [x] **AUTO-04** — exit 0; `17 passed`, including the new receivables walkthroughs. Note that E2E runs the built app in `out/`, so a renderer change needs AUTO-03 first.
- [x] **AUTO-05** — `PASS: PostgreSQL connection, migration, repeat migration preserves data, API readiness.`
- [x] **AUTO-06** — `No schema changes, nothing to migrate` for migrations 0000–0016, after regenerating the `service_status` constraint as `0016_service_status_suspended.sql` rather than hand-editing `0015`.
- [x] **AUTO-07** — `found 0 vulnerabilities`.
- [ ] **SEC-01 — Desktop boundary:** Review passing Electron boundary assertions. **Expected:** `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false`, no renderer `require`, and only the named preload operations.
- [ ] **SEC-02 — Session secrets:** Review passing authentication unit/integration/E2E assertions. **Expected:** Renderer login responses/storage contain no bearer token or password hash; database session storage uses token digests; lock/logout/role/password changes revoke applicable access.
- [ ] **SEC-03 — Server validation:** Review integration failures for invalid money, dates, duplicate codes, missing/inactive references and unauthorized assignments. **Expected:** Requests fail safely; successful records/history are unchanged.
- [x] **SEC-04 — Logged secrets:** Review the passing logging assertions. **Expected:** No bearer token, cookie, password, password hash, proof bytes, `DATABASE_URL` or connection string in any log line, including inside an error message or stack; requests log only method, URL, request id, address and user agent; every response carries `nosniff`, `DENY` and `no-referrer`. **Actual:** `tests/unit/logging.test.ts` (11 cases) and `tests/integration/security.test.ts` (8 cases) read real log lines from an injectable stream and from a live API against a real database. The suite caught a real leak on its first run: the pool password arriving through the stack of a failed readiness check.

Executed 2026-10-03 after the Phase 9 hardening, logging, index and data-volume changes, each on its own:

- [x] **AUTO-01** �?" exit 0; strict typecheck and lint clean; `Test Files 17 passed`, `Tests 200 passed` in 17 files.
- [x] **AUTO-02** �?" exit 0; `Test Files 9 passed (9)`, `Tests 163 passed (163)`, of which 8 are the security-log suite in `tests/integration/security.test.ts`.
- [x] **AUTO-03** �?" exit 0; main, preload and renderer bundles written to `out/`.
- [x] **AUTO-04** �?" exit 0; `19 passed`.
- [x] **AUTO-05** �?" `PASS: PostgreSQL connection, migration, repeat migration preserves data, API readiness.`
- [x] **AUTO-06** �?" `No schema changes, nothing to migrate` for migrations 0000�?"0019; `0019` is hand-written and deliberately absent from `schema.ts`.
- [ ] **AUTO-07** �?" `8 high severity vulnerabilities`, all in the `electron-builder` packaging chain (`app-builder-lib` �? `@electron/get` �? `got` �? `http-cache-semantics`, advisory GHSA-ch52-4w7c-c8xp). No fix is offered except a breaking change, so this is recorded as a finding rather than a pass. It is a build-time dependency used only by the installer task, not by the running application; the earlier baseline of zero vulnerabilities predates the installer dependency. Follow-up in the installer item.
- [x] **AUTO-08 �?" Data volume:** `npm run test:performance`. **Expected:** 20,000 subscribers, 19 screens inside budget, index plans confirmed by name with no sequential scan, and the receivable total equal to the stored open balances. **Actual:** `PASS: 19 screens within budget on 20,000 subscribers, index plans confirmed.` Slowest screens: overdue worklist 2,219 ms of 15,000; revenue report 1,436 ms of 10,000; dashboard 977 ms of 10,000. Evidence in `docs/TEST_EVIDENCE.md`, Phase 9 section 2026-10-03.

Historical totals are a comparison point, not a fixed requirement for future code. Record the actual current count. Investigate unexpected reductions. Upstream Zod comment-annotation and NO_COLOR/FORCE_COLOR warnings were present in previous passing runs; errors and nonzero exit codes are failures.

## 12. Completion and results

- [ ] **END-01 — Restore local services:** Restart the dedicated database/API if an outage check stopped them.
- [ ] **END-02 — Retire test data:** Restore test roles/activation states needed for further testing; leave at least one active Owner. Deactivate/archive disposable manual records when finished. Retain their histories.
- [ ] **END-03 — Evidence:** Attach command summaries and screenshots of login, subscribers, services, assignments, history, billing cycles, an issued invoice and a statement, without secrets.
- [ ] **END-04 — Review:** Every applicable check has Pass, Fail, Blocked or Not run recorded. Unexecuted checks are not marked passed. Link defects and record any accepted limitations.

| Check ID(s) | Result | Actual result / evidence path | Defect / follow-up |
|---|---|---|---|
| AUTO-01 to AUTO-07 | Pass 2026-10-01 | Unit 76/76, integration 97/97, build exit 0, e2e 17/17, database check PASS, schema in sync, 0 vulnerabilities | `docs/TEST_EVIDENCE.md`, Phase 7 section |
| AUTO-01 to AUTO-06, AUTO-08 | Pass 2026-10-03 | Typecheck and lint clean; unit 200/200 in 17 files; integration 163/163 in 9 files; build exit 0; e2e 19/19; database check PASS; schema in sync through migration 0019; 19 of 19 screens within budget on 20,000 subscribers with index plans confirmed | `docs/TEST_EVIDENCE.md` and `docs/PHASE9.md`, sections dated 2026-10-03 |
| AUTO-07 | Fail 2026-10-03 | `npm audit` reports 8 high severity vulnerabilities in the `electron-builder` chain (GHSA-ch52-4w7c-c8xp via `http-cache-semantics`). Build-time only; no non-breaking fix exists | Follow-up recorded in the installer item; the running application does not load these packages |
| SEC-04 | Pass 2026-10-03 | 11 unit and 8 integration logging assertions read real log output; a real credential leak through `err.stack` was found and fixed | The suite now guards the serializer, the redaction list and the stack scrubbing |
| SEC-01 | Pass | `tests/e2e/desktop.spec.ts` asserts sandbox, context isolation, no renderer `require`, and the exact preload surface, which now includes the thirteen receivables operations | Boundary list updated when the receivables bridge was added |
| REC-01 to REC-18 | Not run | Phase 7 is covered by automated tests; the manual walkthrough above has not been performed by a human | Run and record before defence |
| COL-01 to COL-20 | Not run | Phase 6 is covered by automated tests; the manual walkthrough above has not been performed by a human | Run and record before defence |
| PAY-01 to PAY-20, and the other `[NOT RECOVERED]` sections | Not run | Reconstructed from the specification; never executed as written | — |

Defect template:

```text
Check ID:
Title:
Role and synthetic record codes:
Steps to reproduce:
Expected:
Actual:
Screenshot/log path:
Severity:
Retest result:
```

## Outside this checklist

Do not mark these as passed based on Phases 1–7: financial reports, exports and subscriber
statements; backup and restore of the proof directory; installer delivery; production LAN
hardening; 20,000-subscriber load tests; physical three-PC financial posting. These remain
Phases 8–10. Current permission tests cover implemented operations only and do not complete
every part of the laboratory's AT-10.

Collection routes, printed route sheets, batch lifecycle, remittances, shortage/overage
and authorised reconciliation are implemented in Phase 6 and are covered by the
automated checks above, but the manual COL-01 to COL-20 walkthrough in section 10b has
not been performed by a human, so it stays unticked.

Receivables, aging, suspension and reconnection are implemented in Phase 7 and covered by
the automated checks above, but the manual REC-01 to REC-18 walkthrough in section 10c has
not been performed by a human, so it stays unticked. The three receivables screenshots are
recorded as captured evidence; visual inspection of them is still outstanding.
