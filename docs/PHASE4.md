# Phase 4: billing and ledger engine

## Design

The Fastify/PostgreSQL boundary gains a billing module. The API owns every financial
decision; the renderer only sends validated commands and renders what the server
returns. Money is integer centavos end to end, invoice line items are insert-only,
and every posted amount is either an original entry or a linked reversal/adjustment.
Phase 4 does not implement payments, receipts, GCash, collections, receivables or
reports; those remain Phases 5–8 and are described as pending.

## Money policy

- Every amount is an integer number of centavos, 0 … 999,999,999
  (PHP 0.00 … 9,999,999.99). No float ever holds an authoritative amount.
- Amounts are non-negative except where a correction is explicitly signed: an
  `invoices.adjustment_centavos` and the matching `ADJUSTMENT` line are negative for a
  credit and positive for a debit. Every other amount column is non-negative, and the
  database enforces that range.
- A line item amount is `quantity × unitPriceCentavos` in integer arithmetic.
  `unitPriceCentavos` is always positive (1 … 999,999,999); a `DISCOUNT` line stores a
  **negative** `amountCentavos` and every other type stores a positive amount. Only an
  `ADJUSTMENT` line chooses its own sign.
- The invoice total is always `sum(invoice_items.amountCentavos)`. The denormalised
  `subtotalCentavos`, `adjustmentCentavos` and `totalCentavos` columns are written in
  the same statement as the items and are re-verified by a repository query; they
  are a cache, never an independent source of truth. A check constraint keeps
  `subtotal + adjustment = total` and `balance = total - paid` true at all times, so
  the total can never be negative.
- `balanceCentavos = totalCentavos - paidCentavos`. `paidCentavos` stays 0 in Phase 4
  and is written only by Phase 5 payment allocation.
- Rates are snapshotted, never referenced. A line item copies the plan id, the plan
  revision, the plan code/name and the unit price in force at billing time, so a
  later plan or service-rate edit cannot rewrite a posted invoice.

## Billing period and cycle

- A period is written `YYYY-MM`. `billing_cycles` stores one immutable row per
  period with its first and last calendar date. Periods are never edited or reused.
- Generation targets exactly one cycle. A cycle may be generated at any time: the
  first run creates the cycle, the run record and the invoices, and a later run
  reuses all three (see idempotency below).

## Eligibility

A service account is billed for a cycle when all of the following hold:

1. the service account status is `ACTIVE`;
2. the subscriber status is `ACTIVE`;
3. `billing_start_date <= cycle.period_end`;
4. `activation_date <= cycle.period_end`.

Services that activate during the month are charged the **full monthly rate**. The
laboratory defines no proration rule, so partial-month proration is explicitly not
implemented and is recorded here as a documented limitation. A zero-rate service
produces a zero-total invoice that is numbered and immediately `PAID` and posts no
ledger entry, because a zero amount is not a financial event.

## Billing and due dates

`billingDay`/`dueDay` (1–31) come from the service account.

- `issueDate = clamp(billingDay)` inside the cycle month.
- `dueDate = clamp(dueDay)` in the cycle month when `dueDay >= billingDay`,
  otherwise in the following month. A due day before the billing day therefore
  always falls after the issue date.
- `clamp(day)` = `min(day, lastDayOfThatMonth)`, so 29, 30 and 31 all resolve
  correctly in February and in 30-day months. The 2026-02-31 style input cannot
  occur because the day is a 1–31 integer and is clamped, not parsed as a date.

The same clamping is used by the overdue calculation, so an invoice issued on
2026-02-28 with due day 31 is due 2026-02-28, never 2026-03-03.

## Invoice numbering

- Format `INV-YYYY-NNNN`, where `YYYY` is the issue year and `NNNN` starts at
  1001 and increases by one per year.
- `document_sequences` holds one counter per (kind, year). Allocation is
  `UPDATE … SET next_value = next_value + 1 … RETURNING`, which takes a row lock
  inside the posting transaction. Concurrent generators therefore receive distinct,
  gap-free numbers and a rolled-back transaction also rolls back its counter.
- Drafts have no number. A number is assigned when the invoice is finalised, and the
  database guard allows exactly that one `NULL → INV-…` transition.
- A void does not return its number: the counter only ever increases, so a voided
  number stays reserved and is never reused (Phase 5 extends this to receipts).
- A draft that is discarded is voided instead of deleted, so it keeps a `VOID` status
  and a reason without ever receiving a number.

## Invoice states

`DRAFT → UNPAID → PARTIALLY_PAID → PAID`, with `UNPAID`/`PARTIALLY_PAID → OVERDUE`
and any finalised state `→ VOID`.

| State | Meaning in Phase 4 |
|---|---|
| `DRAFT` | Manually created invoice whose items are still editable; unnumbered, no ledger entry |
| `UNPAID` | Finalised with a number and a posted debit; nothing allocated yet |
| `PARTIALLY_PAID` | Reserved for Phase 5 allocation; validated and stored, not yet produced |
| `PAID` | Balance is zero (a zero-rate period, or after Phase 5 allocation) |
| `OVERDUE` | Balance is positive and the due date has passed; applied by the sweep |
| `VOID` | Cancelled by an authorised actor; original items kept, reversal posted |
| `CREDITED` | Reserved for Phase 5 advance-credit settlement; validated, not yet produced |

The status is recomputed from the totals after every financial event, never set by
the caller. Only `DRAFT` and `VOID` are requested by a caller; the rest are derived.
`POST /api/v1/billing/overdue-sweep` moves due-date-passed `UNPAID` invoices to
`OVERDUE` so the transition is explicit and audited rather than implied by the clock.
A document that is already `OVERDUE` is never swept again, and a `VOID` document is
never swept.

## Immutability and corrections

- `invoice_items` rows are insert-only. A trigger rejects `UPDATE` and `DELETE`
  unless the parent invoice is still `DRAFT`, so a draft can be re-issued but a
  finalised invoice's line items are permanent.
- A trigger rejects a `DELETE` of any stored invoice: a document is voided, never
  removed.
- A trigger rejects changes to the identifying columns of `invoices`
  (number, cycle, subscriber, service, dates, period label, source, creator).
- The figures of a finalised invoice (status, subtotal, adjustment, total, paid,
  balance, finalised/voided timestamps, void reason, notes) may only be changed by a
  transaction that identifies itself with the transaction-local
  `set_config('bcis.posting','on',true)` flag, which only the posting service sets.
  Any other session issuing `UPDATE invoices` is refused by the database, including a
  direct SQL session, so no application bug can rewrite a posted document.
- `adjustments` and `ledger_entries` are insert-only, except that a ledger entry's
  `balance_centavos` may be recomputed by the ledger rebuild. The read path refuses to
  present a statement whose stored balance cannot be reproduced, so a rewritten
  balance is detectable and is repaired by the next posting.
- Corrections are additive: a **void** posts a linked credit reversal; an
  **adjustment** posts a new DEBIT or CREDIT line item. Nothing overwrites or
  deletes a posted amount, and every correction stores actor, reason and timestamp.
- A `DRAFT` invoice is corrected by re-issuing its items, never by an adjustment,
  because nothing has been posted for it yet. An adjustment against a `DRAFT` or a
  `VOID` invoice is refused.
- A credit adjustment must be **strictly less** than the invoice's outstanding
  balance, so an adjustment can neither create unrecorded credit nor settle the
  invoice. Settling an invoice with a credit is a Phase 5 allocation step, not an
  adjustment.

## Advance-credit policy

Payment receipt is Phase 5, so this phase only fixes the rule the ledger follows:

- Money received beyond the outstanding balance is never discarded and never
  silently re-absorbed into an invoice. It remains a credit on the subscriber
  ledger.
- An invoice settled entirely by credit carried from an earlier period is marked
  `CREDITED`, not `PAID`: no new receipt is issued for value already received.
- Credit is consumed oldest-invoice-first, matching the documented default
  allocation order.
- The invoice-level balance never goes below zero; the subscriber ledger carries an
  explicit forward credit instead of a negative invoice.

## Ledger

- One row per financial event: `INVOICE` (debit), `VOID` (credit reversal),
  `ADJUSTMENT` (debit or credit), and in Phase 5 `PAYMENT` and `CREDIT`.
- A debit increases the balance and a credit decreases it, matching the laboratory's
  worked example (999.00 debit, 500.00 credit, 499.00 balance).
- Each entry stores the number of the document it belongs to, so a statement line is
  readable without a join, and a `VOID` entry stores the `reversal_of_id` of the debit
  it cancels.
- Ordering is `(entry_date, entry_no)`. `entry_no` restarts at 1 for every subscriber
  and is allocated while the subscriber row is locked, so the order of entries is
  per-subscriber, gap-free and reproducible, and the ordering of one subscriber's
  postings never depends on another subscriber's traffic.
- After every posting the affected subscriber's running balances are rebuilt inside
  the same transaction with a window function, so a back-dated run cannot corrupt the
  running balance. A back-dated document is inserted at the end of the statement in
  entry order but takes its place in the date order, and every later line's stored
  balance is re-derived from the immutable entries.
- `verifyRunningBalance()` recomputes the whole subscriber ledger from the immutable
  entries. `GET /api/v1/billing/ledger` always verifies the complete statement before
  answering and returns `500 LEDGER_INCONSISTENT` if a stored balance cannot be
  reproduced, so a tampered balance is never presented as final.
- The response reports `openingBalanceCentavos`, `closingBalanceCentavos` and the debit
  and credit totals for the requested range. With a `from` date the statement opens
  with the balance brought forward by the entries before the range; without one it is
  paged and opens with the balance of the lines before the page. The closing balance
  is the account balance reached at the end of the range, so it does not change when
  only the page changes. An empty range is an empty statement, not an error.

## Duplicate-billing prevention (AT-11)

Four independent guards; the first two do not depend on application logic:

1. **Database constraint** — a partial unique index on
   `(service_account_id, billing_cycle_id)` for every invoice whose status is not
   `DRAFT` or `VOID`. Two concurrent generators cannot finalise two invoices for the
   same service and period even if both pass application checks.
2. **Serialised generation** — generation takes a per-cycle advisory lock
   (`pg_advisory_xact_lock`), so a second concurrent request waits and then reports
   the existing run instead of racing.
3. **Idempotent run** — `billing_runs` is unique per cycle. Generating the same
   period again reuses the stored run, reports `idempotent: true`, and issues nothing
   for a service that already holds a finalised invoice for the period.
4. **Conflict reporting** — an insert conflict is reported as a skipped service,
   never as a second invoice.

A re-run of a period is also how a gap is filled: a voided invoice releases its
`(service, period)` slot, so a later run issues a **replacement** document with a new
number while the voided document and its reversal remain visible forever. A service
that was already invoiced for the period is counted as `skippedCount`, never
re-invoiced.

## API contract

| Method | Path | Permission | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/billing/runs` | `billing.generate` | Generate one cycle; idempotent |
| `GET` | `/api/v1/billing/runs` | `billing.view` | Past runs, newest first |
| `GET` | `/api/v1/billing/cycles` | `billing.view` | Periods available for generation |
| `GET` | `/api/v1/billing/invoices` | `billing.view` | Search/filter/paginate invoices |
| `GET` | `/api/v1/billing/invoices/:id` | `billing.view` | Invoice with immutable items |
| `POST` | `/api/v1/billing/invoices` | `billing.generate` | Create a `DRAFT` invoice |
| `PUT` | `/api/v1/billing/invoices/:id/items` | `billing.generate` | Replace draft items |
| `POST` | `/api/v1/billing/invoices/:id/finalize` | `billing.generate` | Number, post debit, finalise |
| `POST` | `/api/v1/billing/invoices/:id/adjustments` | `billing.generate` | Debit/credit adjustment |
| `POST` | `/api/v1/billing/invoices/:id/void` | `billing.generate` | Void with reason, post reversal |
| `POST` | `/api/v1/billing/overdue-sweep` | `billing.generate` | Mark due invoices overdue |
| `GET` | `/api/v1/billing/ledger` | `billing.view` | Subscriber ledger (`subscriberId` required, optional `from`/`to`) |

There is no delete route. Unknown routes, including `DELETE` on invoices, return
the structured 404.

Permissions are granted per role: `billing.view` and `billing.generate` belong to
`OWNER`, `billing.view` also belongs to `CASHIER` for collections work, and neither
belongs to `SUPERVISOR` or `TECHNICIAN`, who have no billing responsibility in this
phase. The permission check runs again inside the posting transaction, so a role
revoked mid-session cannot post a document.

## Desktop

The renderer never calculates an amount it then relies on. It sends the named preload
operations above, receives validated documents and renders the server's integers; the
only arithmetic in the renderer is the labelled draft-line preview, which the server
replaces with its own stored totals as soon as the document is saved. Navigation
follows `billing.view`, and the generation, sweep, issue, adjust and void controls are
rendered only for `billing.generate`, which mirrors the server's own refusal.

| Screen | Contents |
|---|---|
| Billing cycles | Period input (`YYYY-MM`) with optional status-as-of date, Generate period, Sweep overdue, and the run history with period, as-of date, issued/skipped counts, exact total and status |
| Invoices | Search, status filter, pagination, and per document the number or `Draft`, subscriber, service, issue/due dates, subtotal figures, status, and the View/Issue/Adjust action appropriate to its state |
| Invoice dialog | Stored figures and immutable lines, adjustments with their reasons, an adjustment form (type, amount, reason) that a draft refuses, a void confirmation that requires a reason, and a promotion from View to Issue for a draft |
| Subscriber ledger | Account search, From/To range, the statement in date order with the reproduced running balance, range opening/closing balance and statement totals |

A re-run confirmation reports the issued count, the exact total, how many services were
skipped and whether the stored run was reused, so the operator can see that a repeated
period issued nothing twice.

## Schema migrations

| Migration | Change |
|---|---|
| `0003_parched_jazinda` | Billing cycles, runs, invoices, items, adjustments, ledger, sequences and the immutability guards |
| `0004_mysterious_harrier` | Signed `invoices.adjustment_centavos` range |
| `0005_classy_speed_demon` | Per-subscriber `ledger_entries.entry_no`, global sequence removed |
| `0006_invoice_number_on_finalize` | Guard allows the one `NULL → number` transition |
| `0007_posted_invoice_figures` | Posted figures may only change inside a posting transaction |
| `0008_invoice_delete_guard` | `DELETE` of a stored invoice is refused |
| `0009_void_draft_without_number` | A discarded draft may be voided without a number |

## Review focus

- The same period generated twice must not create a second invoice, including under
  concurrency.
- Invoice totals must equal the sum of immutable items, and every posted debit must
  equal the invoice total.
- The ledger running balance must be reproducible from the entries alone, also for a
  back-dated document and for a date-filtered statement.
- A plan or service-rate edit after billing must not change a posted invoice.
- A void must restore the balance and keep the original document visible, and a
  re-run must then issue a replacement with a new number.
- A credit adjustment must be less than the outstanding balance and must never edit a
  line item or a draft.
- Only `OWNER` may bill, `CASHIER` may read, and `SUPERVISOR`/`TECHNICIAN` have no
  billing access.
- No delete or silent update path may exist for posted financial rows, from the API
  or from a direct SQL session.

## Deferred to later phases

Payments, allocation, receipts and GCash (Phase 5); batches, remittances and
reconciliation (Phase 6); receivable aging and suspension (Phase 7); reports, export
and printing (Phase 8). `PARTIALLY_PAID` and `CREDITED` are accepted and stored but
are only produced once payment allocation exists.
