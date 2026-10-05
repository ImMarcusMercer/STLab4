# Acceptance test report — AT-01 to AT-12

Section 7 of the laboratory lists twelve mandatory acceptance tests and says a feature may
look complete and still be incomplete if the financial result is wrong. This report is the
Phase 10 record of those twelve: what each one asks for, the evidence that exists for it today,
where that evidence lives, and what it does not cover.

Reproduced on 2026-10-05 against PostgreSQL 17 with the commands below. Each was run on its
own and every one exited 0.

| Command | Result |
|---|---|
| `npm.cmd run check` | strict TypeScript and ESLint clean; 200 unit tests in 17 files |
| `npm.cmd run test:integration` | 186 tests in 11 files, real PostgreSQL, 116 s |
| `npm.cmd run test:e2e` | build ok; 19 Electron tests |
| `npm.cmd run db:seed:demo` | demonstration dataset meets all twenty section 8 minimums |
| `npm.cmd run test:db` | connection, migration, repeat migration, readiness |

## What section 7.1 asks for

| Required evidence | Where it is |
|---|---|
| Automated test output for domain/business rules | `tests/unit/*` (17 files): allocation order, money arithmetic, receipt numbering, reconciliation, aging, export writers |
| API/integration test results for posting flows | `tests/integration/*` (11 files, 186 tests): payments, billing, collections, receivables, receipts, backups, reports, auth, master data, security, demonstration dataset |
| E2E or reproducible manual evidence for desktop workflows | `tests/e2e/*` (19 tests): the payment, GCash, billing, route, receivable, backup, master-data and permission walkthroughs |
| Screenshots or report files showing expected balances | `docs/screenshots/*.png` (22 files); PDF/XLSX/CSV receipts, statements and reports written by `receipts.test.ts` and `reports.test.ts` |
| Bug log with issue, root cause, fix and regression test | This report's [defect log](#defect-log), plus the per-phase defect tables in [test evidence](TEST_EVIDENCE.md) |

## The twelve

Legend — **Auto**: unit + API/integration evidence. **Desktop**: Electron/Playwright evidence.
**Artifacts**: files a reviewer can open. Manual items refer to the checklist in
`TEST_CHECKLIST.md`; those marked *not run* have not been performed by a human.

| ID | What the laboratory asks | Auto evidence | Desktop evidence | Artifacts | Result |
|---|---|---|---|---|---|
| AT-01 | Invoice P999, payment P999 → remaining P0, invoice `PAID`, ledger balanced, receipt created | `payments.test.ts` *settles an invoice exactly with one payment and issues the first receipt (AT-01, AT-06)* — asserts the touched invoice, `PAID`, `paidCentavos`, the receipt number, the ledger entry and the running balance. Unit: `payments.test.ts` *settles several invoices exactly and stops at the balance of each (AT-01)* | `payments.spec.ts` *cash settles the oldest due invoice first…* | receipt PNG walkthrough `payments-receipt.png`, `payments-official-receipt.png` | **Pass** (manual PAY-03 not run) |
| AT-02 | Invoice P999, payment P500 → remaining P499, `PARTIALLY_PAID`, allocation and ledger correct | `payments.test.ts` *applies the next payment to the oldest invoice that is still open and leaves the rest part-paid (AT-02, AT-04)* — `appliedCentavos` 20,000, `balanceCentavos` 15,000, `PARTIALLY_PAID`, `paidCentavos` 20,000. `receipts.test.ts` *prints the invoice a part payment settled without pretending the balance was received*. Unit: *keeps the excess of an overpayment as a credit after settling the oldest invoice (AT-02, AT-03)* | `payments.spec.ts` (same walkthrough) | `payments-collect.png` | **Pass** (manual PAY-04 not run) |
| AT-03 | Monthly P1,000, payment P3,000 → allocation/credit follows the documented policy without losing value | `payments.test.ts` *holds the excess of an overpayment as a credit on the account (AT-03)* and *spends the held credit on the next invoice without a new payment (AT-03)*. `receipts.test.ts` *prints the credit an overpayment held, rather than losing the difference*. Unit: *holds everything as an advance credit when nothing is outstanding (AT-03)* | `payments.spec.ts` *…holds an overpayment…* | statement/receipt exports | **Pass** (manual PAY-06 not run) |
| AT-04 | August P999 + September P999, payment P1,200 → August P0, September P798 | `payments.test.ts` *settles the oldest open invoice first when one payment covers two (AT-04)* and the AT-02/AT-04 test above; *applies the next payment to the oldest invoice that is still open*. Unit: *applies a payment to the oldest due date first (AT-04)* — the later-due invoice is first in the input array and is allocated last | `payments.spec.ts` *cash settles the oldest due invoice first…* | `billing-ledger.png` | **Pass** (manual PAY-05 not run) |
| AT-05 | Post an already-used verified GCash reference → the system blocks or warns per the documented policy | `payments.test.ts` *refuses a GCash payment that arrives without a reference or a receipt image*, *holds a GCash payment as pending until a second person confirms it*, *refuses a second claim that reuses a live GCash reference*. `receipts.test.ts` *refuses a receipt for a GCash claim nobody has confirmed*. `demo-dataset.test.ts` *never lets an unconfirmed GCash claim touch a balance* | `payments.spec.ts` *a GCash claim waits for a second person, a voided claim keeps its history and the receipt is issued only after confirmation* | `payments-gcash.png` | **Pass** (manual PAY-09/11–14 not run) |
| AT-06 | Reverse an incorrectly posted payment → original stays visible, linked reversal exists, balances restore, actor/reason audited | `payments.test.ts` *reverses a posted payment with its own receipt and reopens the invoices it settled (AT-06)*, *keeps a voided claim in the history and frees its reference (AT-06)*, *refuses to change, delete or unbalance a payment outside the service (AT-06)* (database guards). `receipts.test.ts` *prints a reversal as money taken back, naming the receipt it reverses* and *keeps the original of a reversed receipt printable, marked as reversed* | `payments.spec.ts` *…is reversed with a new receipt* | `payments-receipt.png` | **Pass** (manual PAY-15/16 not run) |
| AT-07 | Collected P20,000, remitted P20,000 → difference P0, batch may reconcile and close | `collections.test.ts` *submits, then records the counted cash* — `balanced: true`, shortage 0, overage 0, then a second remittance refused 409; *closes only after the reconciliation…*. Unit: *AT-07: compares the cash handed in with the cash that was due* | `collections.spec.ts` *a route is opened, worked, counted short, signed off by a second person and printed* (balanced path in the same lifecycle) | `collections-remittance.png`, `collections-route-sheet.png` | **Pass** (manual COL-11 not run) |
| AT-08 | Collected P20,000, remitted P19,500 → P500 shortage displayed, cannot silently close as balanced | `collections.test.ts` under *AT-07 and AT-08: a remittance that does not match* — *stores a shortage explicitly and never adjusts it away*, *stores an overage explicitly as well*, *refuses a negative, fractional or future count*; *refuses a signer who counted the cash, and keeps the shortage on the record*. Unit: *AT-08: reports a difference as an explicit shortage or an explicit overage, never as a silent fix* | `collections.spec.ts` — the walkthrough counts short and asserts the stored shortage | `collections-remittance.png` | **Pass** (manual COL-12/13 not run) |
| AT-09 | Two/three PCs post and read different valid operations → no data corruption, no duplicate numbering, no cross-session effect | `payments.test.ts` *posts from three office sessions at once without repeating a receipt number (AT-09)* — three concurrent calls on separate connections; receipts must be the next two numbers and unique; the money either settles or is held, to the peso. `billing.test.ts` *prevents duplicate billing for the same service account and period (AT-11)* fires two generation requests for the same period at once and requires both to return 200 with one invoice per service. `auth.test.ts` *concurrent owner removals cannot leave zero active owners*. `master-data.test.ts` *rejects stale concurrent edits and records only successful history* | `desktop.spec.ts` (renderer isolation, no shared state) | — | **Pass** for concurrent API sessions; a physical three-PC test has not been performed |
| AT-10 | Cashier attempts an admin-only user/backup operation → the server rejects it even when the API is called directly | `auth.test.ts` *AT-10: cashier cannot list/create users even through direct HTTP*; `backups.test.ts` *will not let a cashier restore, however it is asked* and *keeps backups to users who may create them*; `reports.test.ts` *lets a viewer read reports but not export them*, *refuses a technician both the dashboard and every report*; `payments.test.ts` *refuses anonymous, unauthorized and unauthorized-by-role payment requests* | `auth.spec.ts` *cashier cannot see administration or bypass it through the preload API*; `backups.spec.ts` *a cashier has no backup screen and no backup permission*; `receivables.spec.ts` *an auditor may read the aging report but is never offered a service control screen*; `master-data.spec.ts`, `billing.spec.ts`, `collections.spec.ts` each assert the same for their own screens | — | **Pass** |
| AT-11 | Run billing generation twice for the same period → no duplicate finalized invoice for the same service account/period | `billing.test.ts` *prevents duplicate billing for the same service account and period (AT-11)*, including two generation requests fired concurrently; *reproduces the subscriber ledger balance from the posted entries alone* | `billing.spec.ts` *owner generates a period, inspects an invoice, corrects it and reads the statement* | `billing-cycles.png`, `billing-invoice.png` | **Pass** (manual not run) |
| AT-12 | Create a test backup, change data, restore the approved backup → the restored database passes its integrity check and the expected records return | `backups.test.ts` under *AT-12 restoring a backup*: *brings the data back and reports the difference it found*, *refuses a damaged file without writing anything*, *refuses to restore a file that is not a PostgreSQL archive*, *requires the confirmation phrase and a reason before it will restore*, *will not let a cashier restore*; plus *a backup taken while the office is working > records counts that describe the archive, not the moment it finished* | `backups.spec.ts` *an owner takes a verified backup, sees what it contains, and restores it with a reason* | `backups-history.png`, `backups-restore-confirmation.png` | **Pass** (manual not run) |

### Reading the result column

**Pass** means the expected result is asserted by at least one automated test that runs today,
with desktop evidence where the case involves a screen. It does not mean a human has performed
the manual walkthrough: every `PAY-*`, `COL-*` and `REC-*` checklist item is still unticked, and
the three-PC physical test and a physical print of a report have not happened. Those are
recorded as *not run* rather than passed.

## Defect log

Entries for this task. Earlier phases carry their own tables in
[test evidence](TEST_EVIDENCE.md) (page ordering, mirrored row cursor, statement subject block,
`pg_restore --dbname`, restore session kill, bigint overflow in money aggregates, a password
leaking through `err.stack`, and others), and the checklist keeps the operator defect template.

| # | Discovered issue | Root cause | Fix | Regression test |
|---|---|---|---|---|
| 1 | **The Phase 5 payment API suite was not in the repository.** `docs/TEST_EVIDENCE.md` claims "14 PostgreSQL tests … the Phase 5 payment suite (AT-01 to AT-06)", but `npm run test:integration` had no payments file at all, so AT-01 to AT-06 had no API-level evidence running | The file `tests/integration/payments.test.ts` was deleted in commit `98b3192` ("Phase 9 complete") while the evidence documents that describe it were left unchanged. Nothing replaced the coverage: `receipts.test.ts` proves printing, not posting | Restored the file from commit `04bf5d7` and confirmed it passes unmodified against the current API; the acceptance matrix above now names the tests that actually run | `tests/integration/payments.test.ts`, 15 tests, passes in the 11-file integration run |
| 2 | **AT-09 had no evidence for money posting or numbering under concurrency.** The existing concurrent tests covered billing generation, owner removal and stale edits, but nothing posted two payments at the same time to prove receipt numbers stay unique and no money is lost | Receipt numbering is serialized by a per-year advisory lock and allocations by row locks; neither had been exercised from two sessions at once | Added *posts from three office sessions at once without repeating a receipt number (AT-09)*: two concurrent `POST /payments` plus a concurrent register read on separate connections, asserting the two receipts are the next two numbers and unique, that every peso is either applied or held as credit, and that no receipt number appears twice in the table | `tests/integration/payments.test.ts`, the last test in the file |
| 3 | **The demonstration seed was refused with 403 on the development database** when it set the service-control policy, although the same call succeeded on a test database | `role_permissions` is written only by the security seed, never by a migration, so a database seeded before Phase 7 introduced `service.control` had no row for it and no later run topped it up | The demonstration seed now runs the same idempotent security seed first, which inserts any missing permission and leaves an existing owner's password alone | `tests/integration/demo-dataset.test.ts` (seeds through the same path) and a clean `npm run db:seed:demo` |

### Known findings carried forward

| Finding | Status |
|---|---|
| `npm audit`: 8 high-severity vulnerabilities in the `electron-builder` chain (GHSA-ch52-4w7c-c8xp) | Open, build-time only, no non-breaking fix; recorded in the checklist as AUTO-07 **Fail** |
| Manual `PAY-*`, `COL-*`, `REC-*` walkthroughs, `SEC-01`–`SEC-03` review items, `END-01`–`END-04` | **Not run** — automated coverage exists, a human has not performed them |
| Physical print of a receipt, route sheet and aging report; three physical PCs | **Not run** |
| Screenshots not visually inspected by a human | **Open** — 22 files in `docs/screenshots/` |

## Limits

- The matrix records evidence that exists in this repository today; it was produced by reading
  the test files and running the suites, not by re-executing every manual checklist step.
- Test titles are quoted as they appear in the source, so the matrix can be checked with a
  search rather than trusted.
- AT-09 is proved for concurrent API sessions against one PostgreSQL instance. A physical
  two- or three-machine test on a LAN is still outstanding.
- The demonstration dataset's dates drift with the day it was seeded, so bucket ages in
  screenshots taken from it will move.
