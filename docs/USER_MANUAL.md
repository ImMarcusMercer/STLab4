# BCIS user manual

Operator and reviewer guide for the BCIS Subscription Billing and Collection System — the
desktop application the office uses for subscribers, billing, payments, collections,
receivables, reports and backups.

This manual describes the application as it runs today. Every screen, button and rule below
was read from the source and exercised by the automated suites; where something has not been
performed by a human (a physical print, a three-PC test) it says so rather than implying it.

- Design and phase records: [foundation](FOUNDATION.md), [authentication](AUTHENTICATION.md),
  [phase 3](PHASE3.md) … [phase 9](PHASE9.md)
- Database picture: [ERD](ERD.md)
- Evidence that the rules below actually hold: [test evidence](TEST_EVIDENCE.md),
  [acceptance report](ACCEPTANCE.md)
- Demonstration data for a review: [demo dataset](DEMO_DATASET.md)

## 1. Starting the application

The office runs three pieces: PostgreSQL, the API server and this desktop client. The
developer commands are in the [README](../README.md); for a packaged installation see the
[deployment guide](DEPLOYMENT.md).

1. Start PostgreSQL (`npm.cmd run db:start` on a development machine).
2. Start the API (`npm.cmd run start:api`, listening on `127.0.0.1:3100` by default).
3. Start the desktop (`npm.cmd start`, or the installed application).

Sign in with your username and password. Sessions last **eight hours**; a password, role or
activation change ends the sessions of the account it happens to. **Lock workspace** in the
top bar returns to the lock screen without ending the session early; **Sign out** ends it.

The **Overview** screen shows a connection card with three nodes — desktop client, API server,
database — and one of four states:

| State | Meaning | What to do |
|---|---|---|
| All systems connected | Desktop, API and PostgreSQL are talking, migrations applied | Nothing |
| Database needs attention | API is up, PostgreSQL or its migrations are not | Start the database, run migrations |
| API unavailable | The desktop cannot reach the server | Check the API process, then refresh |
| Checking your connection | A check is in flight | Wait; it re-reports when finished |

## 2. Who can do what

Navigation is filtered by permission: a screen the API would refuse is not offered. The
permissions themselves are decided by the API on every request, so hiding a button is a
convenience, not the security control.

| Role | Held permissions (summary) |
|---|---|
| **Owner / Super Admin** (`OWNER`) | Everything, including user management, audit trail and backup restore |
| **Administrator** (`ADMIN`) | Everything except user management, audit trail, payment reversal and backup restore |
| **Cashier** (`CASHIER`) | Dashboard, read subscribers and billing, record and confirm payments |
| **Collection Supervisor** (`SUPERVISOR`) | Dashboard, subscribers, routes and remittances, receivables, service control, reports |
| **Accounting / Auditor** (`AUDITOR`) | Dashboard, read payments, reverse payments, receivables, reports, audit trail, read and verify backups |
| **Technician** (`TECHNICIAN`) | Read service accounts only |
| **Read-only Viewer** (`VIEWER`) | Dashboard and reports (read only; no export) |

The authoritative matrix is `source/api/auth/roles.ts`. Two splits are deliberate and are
asserted by tests:

- **Backup permissions are split by what they do.** Owner, Administrator and Auditor may view
  and verify; only **Owner** may restore, because a restore replaces every posted figure.
- **Reading a report and exporting it are separate grants.** A Viewer sees reports; only
  Owner, Administrator, Supervisor and Auditor may export one.

## 3. Screens

### 3.1 Overview

The landing page: the connection card above, plus the project roadmap panels. Use it to
confirm the system is live before anyone posts money.

### 3.2 Subscribers and Services

Tabs: **Subscribers**, **Service accounts**, **Plans** (and, from
Collections → *Areas & collectors*, **Areas & routes** and **Collectors**).

1. Search by account number, name, contact or address; filter by status; sort by code or name.
2. **New subscriber** (or **New plan** / **New service**) opens the form. Codes are permanent.
3. **Edit** asks for a reason and keeps the previous revision — **History** shows every saved
   revision with who changed it and why.
4. **Assign** (Supervisor, or anyone with collection management) changes the collection area
   and collector without touching identity or price.

Rules the office should know:

- Money fields take pesos with at most two decimals; the system stores exact centavos.
- A plan edit never rewrites an existing service's rate, and each service keeps the plan
  revision it took.
- Records are never deleted. Deactivate, archive or terminate instead.
- A stale edit (the record changed while your form was open) is refused; close the form,
   refresh and reopen before reapplying it.

Screenshots: `subscribers.png`, `subscriber-form.png`, `services.png`, `user-accounts.png`.

### 3.3 Billing

Tabs: **Billing cycles**, **Invoices**, **Subscriber ledger**.

1. Choose a period (`YYYY-MM`) and press **Generate period**. Every eligible active service
   receives one invoice, issued on its billing day and due on its due day.
2. Running the same period again never bills twice: the stored run is reused and services
   that already hold a document are reported as skipped.
3. In **Invoices**, open a document to read it. Use **Adjust** with a reason to append a
   debit or credit line, or **Void** with a reason, which keeps the document and posts a
   linked reversal. **New invoice** creates a draft; issuing it assigns the number and posts
   the debit.
4. **Sweep overdue** marks unpaid documents past their due date as overdue.
5. In **Subscriber ledger**, search an account and open it: every posted debit, credit and
   reversal in date order with the running balance, and statement totals.

An issued invoice is never edited. Numbers are per year (`INV-2026-0001`), gap-free, never
reused.

Screenshots: `billing-cycles.png`, `billing-invoice.png`, `billing-ledger.png`.

### 3.4 Payments

Tabs: **Collect payment**, **Payment history**.

**Collect payment**

1. Search and select the subscriber account.
2. Choose the method: **CASH** or **GCASH**.
3. Enter the amount received and the date received on.
4. For GCash: enter the reference number and attach the receipt image. A GCash payment with
   no reference or no image is refused.
5. Press **Record payment**.

What happens next:

- **Cash** posts immediately. The money is applied to the oldest due invoice first; anything
  left over after everything open is settled becomes an **advance credit** on the account,
  never a loss and never a change to a past receipt.
- **GCash** is recorded as **PENDING** — no receipt number, no allocation, no effect on any
  balance — until a second person presses **Confirm** in *Payment history*.
- One GCash reference identifies one transfer: a second claim reuses nothing. A reference is
  freed only if the claim was voided before it was ever posted.

**Payment history**

Search and filter by status and method, then use the row actions:

| Action | Available for | Effect |
|---|---|---|
| **View** | any entry | Payment with its allocations, and the receipt image |
| **Confirm** | a pending GCash claim | Second-person verification; the receipt number is issued |
| **Void** | an unposted claim | Keeps the history, frees the reference, prints as received nothing |
| **Reverse** | a posted receipt | Posts a linked reversal receipt, reopens the invoices it settled, records actor and reason |

A posted payment is never edited or deleted — the database refuses it. Corrections are a
void (before posting) or a reversal (after), both with an actor and a reason.

Receipts print as `RCT-2026-1001` and so on, gap-free per year. A receipt with too many
allocation lines for one page is refused with a message pointing at the statement of account
instead.

Screenshots: `payments-collect.png`, `payments-gcash.png`, `payments-receipt.png`,
`payments-official-receipt.png`.

### 3.5 Collections

Tabs: **Collection routes**, **Areas & collectors**.

A route is one day's work for one collector in one area.

1. **Open collection route** — choose area, collector and date, then create. The accounts on
   the route and the amounts due are frozen into the sheet at this moment, so what the
   collector carries is what the office reconciles against.
2. **Start collection** marks the route in progress (the first collection does this on its
   own).
3. Collect on the route using the same cash/GCash rules as the Payments screen. Collected
   figures are always derived from posted payments: a pending GCash claim is shown as
   pending and blocks submission.
4. **Submit route** freezes the sheet; no further collections are accepted.
5. **Record remittance** — expected cash is shown read-only; type the counted cash and the
   date. The difference is stored as an explicit **shortage** or **overage** and is never
   adjusted away. Counting exactly what was expected is *balanced*.
6. **Reconcile remittance** — a second person, someone other than whoever counted, with a
   written reason of at least three characters.
7. **Close batch** — the route, its sheet and its remittance are kept as history.

Lifecycle: `OPEN → IN_PROGRESS → SUBMITTED → REMITTED → RECONCILED → CLOSED`. Steps cannot be
skipped or moved backwards, in the screen or in the database.

Screenshots: `collections-route.png`, `collections-route-sheet.png`,
`collections-remittance.png`.

### 3.6 Receivables

Tabs: **Aging report**; and for those with service control, **Suspensions & reconnections**
and **Service policy**.

**Aging report** — totals plus five buckets (Current / not yet due, 1–30, 31–60, 61–90,
90+ days), with filters for bucket, area and collector and a report date. A bucket is decided
by the oldest unpaid due date, so an account moves only when an invoice crosses a boundary.

**Suspension** — a row is offered a **Suspend** command only when the server marked it
eligible. A reason is compulsory; the confirmation states the fee and the number
(`SUS-2026-0001`) that will be issued. The arrears are frozen onto the document at the moment
of the decision, so a later payment never rewrites why the service was cut.

**Reconnection** — requested from the same screen; refused while the account still owes
money, and refused by the screen inside the grace period. A technician is assigned, the work
is completed, and completion is what lifts the suspension. Numbers look like
`RCO-2026-0001`.

**Service policy** — grace days, suspension threshold, reconnection fee and whether automatic
suspension is allowed, each change stamped with who set it.

A user without service control is not shown the register or the policy at all, and the API
refuses the same calls directly.

Screenshots: `receivables-aging.png`, `receivables-suspended.png`,
`receivables-reconnected.png`.

### 3.7 Reports

Tabs: **Dashboard**, **Reports**.

**Dashboard** — six tiles, the aging summary and the panels an owner checks first, with a
date picker, refresh and print.

**Reports** — choose one of the nine reports, set the date range and the grouping
(daily / weekly / monthly / yearly; revenue by plan, service type or area), press
**Run report**, then optionally **Save as PDF / XLSX / CSV** or **Print report**.

| Report | Answers |
|---|---|
| Collections | What was collected, by method |
| Billing vs collections | What was billed against what was collected |
| Revenue | Revenue by plan, service type or area |
| AR aging | Accounts receivable by aging bucket |
| Subscriber ledger | One subscriber's statement for a range |
| Subscriber master | Every subscriber with services and balance |
| Collector performance | Collector accountability |
| Payment exceptions | Voids, reversals and awaiting verification |
| Audit trail | Who did what, and when |

Two guarantees worth stating:

- The exported file is built by the API from the same query as the table on screen, so a
  saved report always matches what was displayed, and every export writes an audit entry.
- A statement carries the account name and number in a subject block at the top of the page
  in **all three formats**, so a saved ledger cannot be filed against the wrong person.
- Very large results are bounded; the screen says so and suggests narrowing the range instead
  of silently cutting the file.

Exports are saved through the operating system's save dialog — the file lands where you put
it, and the renderer never handles the bytes.

### 3.8 Backups

The **Backups** screen shows the storage directory, the request form and the history.

1. Choose **Full — database and payment proofs** (what "a backup of the office" means) or
   **Database only** (quicker, recorded as incomplete), add a note and press **Take backup**.
2. **Verify** re-reads the file and reports what it found — the digest and that the archive
   can still be read. A file whose bytes changed is reported as damaged.
3. **Restore** is Owner-only. Type **RESTORE** in full and give a reason of at least three
   characters, then **Restore now**. The report that follows names every table whose row
   count differs between the backup and the restored database.

A backup records its digest and the row counts taken inside the snapshot, so a restore is
checked twice: right file, right contents. Both the verification and the restore are in the
audit trail. Backups are taken and restored by the API's own processes; no screen ever
handles the archive bytes or supplies a path.

Screenshots: `backups-history.png`, `backups-restore-confirmation.png`.

### 3.9 Administration

Owner-only. **User accounts**: search and page through accounts, create one with a username,
display name, password (12–128 characters) and one or more roles, edit it, deactivate it and
lock or unlock it.

- The last active Owner cannot be removed or deactivated.
- A password, role or activation change revokes that account's sessions immediately.
- Repeated failed sign-ins from one address are throttled.

Screenshots: `user-accounts.png`, `login.png`, `workspace.png`.

## 4. Rules the system keeps for you

| Rule | What it means in practice |
|---|---|
| Money is exact | Integer centavos end to end; a peso field with three decimals is rejected, never rounded |
| Posted history is append-only | Invoices, ledger lines, posted payments, frozen routes and remittances are never edited or deleted — adjust, void or reverse with an actor and a reason |
| Numbers are gap-free per year | `INV-`, `RCT-`, `BCH-`, `RMT-`, `SUS-`, `RCO-` documents; a void never frees a number for reuse |
| Oldest first | A payment settles the oldest due invoice first, then the next, and the remainder becomes credit |
| Two people where money is counted | A GCash claim needs a confirmer; a remittance needs a signer who is not the counter |
| The API decides | The desktop never computes a balance, an allocation or a permission |

## 5. A working day

1. **Open** — check the Overview connection card before anyone posts.
2. **Billing** — generate the period when it is due; check what was skipped.
3. **Payments** — collect; confirm any GCash claims left pending from yesterday.
4. **Collections** — open today's routes; after they return, submit, count, and have a
   second person sign off the remittance.
5. **Receivables** — review accounts that crossed a bucket or a policy threshold.
6. **Reports** — export what the office needs; print statements for customers who ask.
7. **Backups** — take a full backup at the end of the day and **Verify** it; copy it to
   removable media using the storage directory shown on the screen.

## 6. When something goes wrong

| What you see | What it means | What to do |
|---|---|---|
| Returned to the lock screen | The session expired or was revoked | Sign in again; a password or role change does this on purpose |
| "Forbidden" / a screen you had is gone | Your roles no longer hold that permission | Ask an Owner; the navigation and the API both follow the same roles |
| "Conflict" or a stale-edit message | The record changed while your form was open, or the document already moved on | Refresh, reopen the record, reapply the change |
| "Validation" on a money field | More than two decimals, a negative amount, or a value the contract does not allow | Re-enter the amount; nothing was saved |
| Database needs attention | PostgreSQL is down or migrations are not applied | Start the database, run `npm.cmd run db:migrate`, refresh |
| A receipt says it is too long | One payment would need more than one page of allocations | Print the statement of account for that subscriber instead |
| A GCash claim will not confirm | Someone else must confirm it — the recorder cannot | Ask a second person; that separation is the control |

## 7. Screenshots

`screenshots/` holds 24 PNGs taken by the Electron walkthroughs: `login.png`,
`workspace.png`, `user-accounts.png`, `subscribers.png`, `subscriber-form.png`,
`services.png`, `billing-cycles.png`, `billing-invoice.png`, `billing-ledger.png`,
`payments-collect.png`, `payments-gcash.png`, `payments-receipt.png`,
`payments-official-receipt.png`, `collections-route.png`, `collections-route-sheet.png`,
`collections-remittance.png`, `receivables-aging.png`, `receivables-suspended.png`,
`receivables-reconnected.png`, `backups-history.png`,
`backups-restore-confirmation.png`, `connection.png`, `reports-dashboard.png`,
`reports-aging.png`.

They are regenerated by `npm.cmd run test:e2e` and show the demonstration dataset, whose dates
move with the day it was seeded. Sample exported documents are in `samples/`.

## 8. Limits of this manual

- Every `PAY-*`, `COL-*`, `REC-*` and `SEC-01`–`SEC-03` item in [TEST_CHECKLIST](../TEST_CHECKLIST.md)
  is still **not run by a human**: the workflows above are proven by the automated suites, not
  by a supervised office session.
- No document has been sent to a physical printer; PDF export is the primary path and the
  print layout is the fallback.
- A physical three-machine LAN test has not been performed.
- The new reports screenshots (`reports-dashboard.png`, `reports-aging.png`) show the dashboard
  KPIs/aging/trend and the report viewer offering export where allowed; a full human visual
  review of all 24 is still outstanding.
