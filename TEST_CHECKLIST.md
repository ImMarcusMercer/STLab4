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

## 11. Automated and technical verification

Close the development desktop/server before E2E testing so the configured ports are available. Keep PostgreSQL running. Run each command separately; record its exit code and summary. Existing integration/E2E helpers use uniquely named disposable test databases, not development-table truncation.

| Check | Command | Expected result / previous baseline |
|---|---|---|
| AUTO-01 | `npm.cmd run check` | Exit 0; strict TypeScript, ESLint and unit tests pass. Previous baseline: 64 tests. |
| AUTO-02 | `npm.cmd run test:integration` | Exit 0; real PostgreSQL auth/RBAC, master-data, billing and payment tests pass. Previous baseline: 50 tests. |
| AUTO-03 | `npm.cmd run build` | Exit 0; main, preload and renderer bundles generated. Run before E2E. |
| AUTO-04 | `npm.cmd run test:e2e` | Exit 0; Electron workflows pass, including the two billing and two payment walkthroughs. Previous baseline: 13 tests. |
| AUTO-05 | `npm.cmd run test:db` | Connection, migration, repeat migration and readiness pass. |
| AUTO-06 | `npm.cmd run db:generate` | “No schema changes.” If a migration is generated unexpectedly, record/review the drift; do not treat it as a pass. |
| AUTO-07 | `npm.cmd audit` | Review current results. Previous baseline: zero vulnerabilities; this result may change over time. |

- [ ] **AUTO-01** completed; attach output.
- [ ] **AUTO-02** completed; attach output.
- [ ] **AUTO-03** completed; attach output.
- [ ] **AUTO-04** completed; attach output.
- [ ] **AUTO-05** completed; attach output.
- [ ] **AUTO-06** completed; attach output.
- [ ] **AUTO-07** completed; attach output.
- [ ] **SEC-01 — Desktop boundary:** Review passing Electron boundary assertions. **Expected:** `contextIsolation=true`, `sandbox=true`, `nodeIntegration=false`, no renderer `require`, and only the named preload operations.
- [ ] **SEC-02 — Session secrets:** Review passing authentication unit/integration/E2E assertions. **Expected:** Renderer login responses/storage contain no bearer token or password hash; database session storage uses token digests; lock/logout/role/password changes revoke applicable access.
- [ ] **SEC-03 — Server validation:** Review integration failures for invalid money, dates, duplicate codes, missing/inactive references and unauthorized assignments. **Expected:** Requests fail safely; successful records/history are unchanged.

Historical totals are a comparison point, not a fixed requirement for future code. Record the actual current count. Investigate unexpected reductions. Upstream Zod comment-annotation and NO_COLOR/FORCE_COLOR warnings were present in previous passing runs; errors and nonzero exit codes are failures.

## 12. Completion and results

- [ ] **END-01 — Restore local services:** Restart the dedicated database/API if an outage check stopped them.
- [ ] **END-02 — Retire test data:** Restore test roles/activation states needed for further testing; leave at least one active Owner. Deactivate/archive disposable manual records when finished. Retain their histories.
- [ ] **END-03 — Evidence:** Attach command summaries and screenshots of login, subscribers, services, assignments, history, billing cycles, an issued invoice and a statement, without secrets.
- [ ] **END-04 — Review:** Every applicable check has Pass, Fail, Blocked or Not run recorded. Unexecuted checks are not marked passed. Link defects and record any accepted limitations.

| Check ID(s) | Result | Actual result / evidence path | Defect / follow-up |
|---|---|---|---|
| | | | |
| | | | |
| | | | |

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

Do not mark these as passed based on Phases 1–5: collection routes, printed route sheets or batch lifecycle; remittances, shortage/overage and authorised reconciliation; receivables, aging and follow-up filters; suspension/reconnection approvals; financial reports, exports and subscriber statements; backup and restore of the proof directory; installer delivery; production LAN hardening; 20,000-subscriber load tests; physical three-PC financial posting. These remain Phases 6–10. Current permission tests cover implemented operations only and do not complete every part of the laboratory's AT-10.
