# Phase 8: reports, dashboard and printing

## Design

A report in this system is **a query, not a document that is kept**. Every figure on every
screen and every exported file is computed from the posted financial rows at the moment it is
asked for:

```
invoices ── posted, not void ──┐
                              ├── report query ── columns/rows/totals ── reconcile ── render
payments ── POSTED only ───────┘                                                 ├─ screen
receivables ── open invoices ─┘                                                 ├─ PDF
                                                                                └─ XLSX / CSV
```

There is no `report_snapshots` table, and there is deliberately no scheduled "yesterday's
report" job. A stored report is a number that can go stale while still looking authoritative,
which is the exact failure the laboratory calls out when it asks for reports whose totals are
correct. The consequence is that every report carries its own arithmetic proof.

## Reconciliation is the contract

Each report answers with four things:

| Part | Meaning |
|---|---|
| `rows` | the figures, one per grouping, in centavos |
| `totals` | one or more labelled total rows, also in centavos |
| `reconciliations` | for every money column, the sum of the rows next to the stated total |
| `footnote` | what the report counted and what it deliberately excluded |

`reconcileMoney()` sums a column with integer arithmetic and reports whether it equals the
stated total. `assertBalanced()` then runs on the server before the response leaves: **a report
whose rows do not add up to its total is refused rather than printed.** That is the difference
between a report and a table of numbers, and it is what "reports with reconciled totals" means
here.

Two cross-checks are asserted by the integration tests rather than trusted:

- `AR_AGING` must equal the Phase 7 `receivables/summary` aging for the same as-of date, even
  though the two are computed by different queries in different modules.
- `BILLING_VS_COLLECTION` must have `collected − billed` equal its own `difference` column.

Money never becomes a float on the way out. Rows and totals carry integer centavos; the peso
string (`PHP 1,234.56`) is produced once, at the display and export edge, by `formatMoneyCell`.

## The nine reports

`source/shared/reports.ts` publishes the catalogue, and the API refuses any code that is not in
it, so the desktop and the server cannot disagree about what exists.

| Code | Answers | Grouping |
|---|---|---|
| `COLLECTIONS` | What was collected, by method | day / week / month / year × method |
| `BILLING_VS_COLLECTION` | What was billed against what was collected | period, over a range |
| `REVENUE` | Revenue by plan, by service type or by area | chosen dimension |
| `AR_AGING` | Accounts receivable by aging bucket | the five published buckets |
| `SUBSCRIBER_LEDGER` | One subscriber's statement for a date range | ledger entries |
| `SUBSCRIBER_MASTER` | Every subscriber with their services and balance | subscriber |
| `COLLECTOR_PERFORMANCE` | Collector accountability | collector |
| `PAYMENT_EXCEPTIONS` | Voids, reversals and awaiting verification | payment event |
| `AUDIT_TRAIL` | Who did what, and when | audit row |

`COLLECTIONS` answers the laboratory's daily, weekly, monthly and annual collection reports
from one query by changing the period bucket, and its per-method split is the Cash/GCash
payment-method summary. `COLLECTOR_PERFORMANCE` answers the assignment, collection, remittance
and shortage/overage reports together, because a shortage that is not shown beside the
remittance it belongs to is the figure Phase 6 exists to keep visible.

`AR_AGING` is a **snapshot of today**, not a period report: `from` and `to` both default to the
current day and the as-of date is reported explicitly, so a report read next month cannot look
like it describes the previous month.

## Dashboard

The dashboard is six KPIs over the same queries the reports use:

1. Collected this month
2. Billed this month
3. Total receivable
4. Overdue receivable
5. Accounts overdue
6. Accounts for follow-up / suspension

plus billing-versus-collection over the last six periods, the payment-method split, the AR
aging bars, collector performance and the most recent payments.

The dashboard needs `dashboard.view` only, which is deliberately *not* the same permission as
`receivable.view`. A cashier may see what the office has collected without seeing the whole
receivables worklist. The receivable figures on the dashboard are therefore computed by the
reports module under `dashboard.view`, not read through the receivables service — and the
integration test asserts they agree with `receivables/summary` for the same day, so the second
path to the number cannot quietly start telling a different story.

## Exports

`GET /api/v1/reports/:code/export?format=PDF|XLSX|CSV` returns the file's bytes.

| Format | Produced by | Notes |
|---|---|---|
| PDF | `source/api/reports/pdf.ts` | base-14 Helvetica, no embedded font, one table per page with a repeated header |
| XLSX | `source/api/reports/xlsx.ts` | OOXML SpreadsheetML written as a ZIP of XML parts |
| CSV | `source/api/reports/csv.ts` | useful where a spreadsheet is not needed |

The desktop never generates a document. The renderer asks for a save through the bridge, the
**main** process fetches the bytes from the API and writes them to a path the operator chose in
a native dialog. The renderer therefore still has no filesystem, no `Buffer` and no document
library, which is what keeps the Phase 1 boundary intact.

`report.export` is separate from `report.view`, so an auditor may read the aging report and a
viewer may read the dashboard without either being able to write files to disk. Export is
audited: `report.export` records the code, the format, the period and the row count.

### Why no ExcelJS and no pdfmake

The laboratory's stack table *recommends* ExcelJS and pdfmake. Both were evaluated against this
codebase and rejected, and the reasoning is recorded here because it is part of the design:

- **pdfmake 0.3.11** no longer exports a printer from its documented entry point. `main` is
  `js/index.js`, which exports only `virtualfs`, `urlAccessPolicy` and `localAccessPolicy`.
  Reaching `pdfmake/js/Printer.js` works but is an undocumented internal path with no `exports`
  map, i.e. a private API the package can move between patch releases. It also carries
  deprecated `glob`, `fstream`, `uuid@8` and `lodash.isequal` dependencies.
- **exceljs 4.4.0** is the current release and depends on a vulnerable `uuid`; the only fix
  `npm audit` offers is a breaking downgrade to exceljs 3.4.0. That trade was refused, because
  zero-vulnerability dependencies are a stated property of this project
  (see the Phase 1 evidence) and are worth more on a submission than a convenience import.

Both output formats are stable, fully specified and deterministic, so the writers are small and
their output is asserted byte-for-byte in `tests/unit/reports.test.ts` — the XLSX is read back
with an independent ZIP reader, and `npm run test:db` plus a `.NET ZipFile` cross-check during
verification confirm real-world readability.

Money formatting inside a spreadsheet is written as a **number** with a peso number format, not
as a pre-formatted string, so a report that is exported to XLSX can still be summed in Excel.
That is the difference between a report and a picture of a report.

## Statements name their account

A statement is handed to one subscriber, so `ReportTable` carries an optional `subject`: a
caption and a list of labelled fields. Only `SUBSCRIBER_LEDGER` sets it, to Account, Subscriber
and Contact. Every writer emits it ahead of the column headings, so the account cannot be lost
by saving the file in a different format: PDF, XLSX and CSV all carry it, and the XLSX frozen
pane grows with it so the block does not scroll away under the pinned headings.

This matters more than it looks. Without the account on the page, a ledger extract can be filed
against the wrong person and nothing about it looks wrong — which is the specific outcome the
laboratory's "printable Statement of Account" requirement exists to prevent.

## Printing

`source/desktop/renderer/styles.css` carries a print block that hides the sidebar, the topbar
and every action button and prints only the report region, with `print-color-adjust: exact` so
the status badges keep their colours. The receipt, the statement of account and the route sheet
each get a clean layout with no application navigation, as the screen-level requirements ask.
PDF export is the primary path because it is identical on all three office PCs; the print
layout is the fallback for a printer that is already configured.

### The official receipt

`GET /api/v1/payments/:id/receipt` produces the document a customer leaves with. It is rendered
by the API from the allocation that was actually posted, not from anything the renderer holds,
and the desktop reaches it through the same save-dialog path as a report export.

Three decisions are worth stating because they are not the obvious ones:

- **The renderer owns the one-page limit, not the service.** The service used to refuse a receipt
  past 40 allocation lines with a cap of its own. Two authorities for one limit can disagree, and
  when they did the service would refuse a receipt the renderer could have laid out. The renderer
  now measures the real layout and throws `ReceiptTooLongError`, which the route maps to 422 with
  a message naming the statement of account as the way out. A payment against many invoices is a
  legitimate thing to make; the answer is a statement, not an error about the payment.
- **The print is audited when the bytes render, not when the request arrives.** `document()`
  returns the actor alongside the receipt so `recordPrint()` can run after a successful render.
  An audit entry for a receipt nobody received would be a false record.
- **A voided GCash claim still prints.** The receipt shows the claimed amount as discarded, so
  the number the customer sent is on the record and the zero financial effect is on the record
  with it.

## Permissions

| Operation | Permission |
|---|---|
| `GET /dashboard` | `dashboard.view` |
| `GET /reports`, `GET /reports/:code` | `report.view` |
| `GET /reports/:code/export` | `report.export` |
| `GET /payments/:id/receipt` | `report.export` |

`report.view` covers OWNER, ADMIN, SUPERVISOR, AUDITOR and VIEWER, which is what the laboratory's
read-only Viewer role needs. `report.export` covers OWNER, ADMIN, SUPERVISOR and AUDITOR — the
viewer may read a report on screen but may not write files. A technician holds neither and is
never offered the screens.

Producing a receipt is treated as producing a document, so it needs `report.export` and not
`payment.view`. A cashier holds `payment.view` and may read every payment, but writing a receipt
PDF to the operator's disk is a separate act from reading the payment it belongs to. The
supervisor and auditor roles hold `report.export` without `payment.create`, so they can print a
copy of a receipt for a disputed payment without being able to post one.

## Review focus

- Is any report figure stored, cached or recalculated outside the query?
- Does every money column reconcile, and is the check refused when it does not?
- Does `AR_AGING` still agree with the receivables summary for the same day?
- Is money exported as a number or as a picture of a number?
- Can a viewer read a report, and can they also write one to disk?
- Does the renderer still have no filesystem and no document library?
- Would a reader of the printed page alone be able to tell whose account it is?
- Does a multi-page document still contain every row, and are the rows in order down the page?

## Deferred to later phases

Backup and restore of the generated documents, a scheduled e-mail of a report, and
multi-thousand-row XLSX streaming are Phase 9 or later; the report queries are paginated in the
query layer and the export is bounded to 5,000 rows per file with an explicit truncation note
in the footnote rather than a silent cut.