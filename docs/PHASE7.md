# Phase 7: receivables, aging and service control

## Design

An office does not store a "balance owed" field. What it stores are **open finalized
invoices**, and every receivable figure in this phase is derived from them by the API at the
moment the question is asked:

| Question | Answered by |
|---|---|
| What does this account owe today? | Open invoices `UNPAID` / `PARTIALLY_PAID` / `OVERDUE` |
| How late is it? | Each invoice's issue date against the requested as-of date |
| How much is in each aging band? | A grouping of those invoices by `monthsUnpaid` |
| What did the office decide, and why? | A `suspension` or `reconnection` document |

Nothing here rewrites an invoice and nothing recomputes an old invoice's balance backwards.
Paying an account reduces the open invoices it settles; the aging report then reflects the
payment the same way any other query would.

## Aging (AT-10)

`monthsUnpaid` is the whole number of months between the invoice issue date and the as-of
date, which is what makes the bands testable:

```
CURRENT     < 1 month since issue
D1_30       1 to 30 days late
D31_60      31 to 60 days late
D61_90      61 to 90 days late
D90_PLUS    more than 90 days late
```

The band of an invoice is a function of **its own** issue date, not of the account's oldest
invoice. An account with four invoices issued a month apart each land in their own band,
which is why the test fixture staggers the issue dates instead of billing everything at once.

Two policy numbers decide whether an account is even a candidate for disconnection:

- `gracePeriodDays` — inside it, nothing is suspended;
- `suspensionThresholdCentavos` — below it, nothing is suspended.

Both are read from the single `service_policy` row, so the office changes them once and every
decision follows. The renderer is told the answer (`suspensionCandidate`, `suspensionBlockedBy`)
and hides the command when the API would refuse it, rather than letting the user fail.

## Service documents

A suspension and a reconnection are **documents with numbers, reasons, actors and frozen
figures**, in the same spirit as a Phase 6 route sheet:

- `suspension` records the arrears **at the moment of the decision**. A later payment does not
  change that stored figure, because the document answers "why was this cut off?", not
  "what does it owe now?".
- `requestReconnection` is refused while the account is suspended **and** still owes money.
  The fee defaults to `reconnectionFeeCentavos` from the policy when the caller omits it.
- Technician assignment and completion are separate steps by separate people, and completion
  is the only thing that lifts the suspension.
- `service_history` is append-only. Suspension, lift, reconnection request, assignment and
  completion each append one row, so the full trail is readable after the fact.

## Immutability and the transaction-local flag

Suspensions, reconnections and history rows cannot be updated or deleted. The legitimate
writers run inside a transaction that sets `set_config('bcis.control','on',true)`, the same
pattern as `bcis.posting` in Phase 5 and `bcis.collection` in Phase 6. A lifecycle change
outside that flag is refused by the database, so a repair script cannot invent a status.

## API contract

| Operation | Permission |
|---|---|
| `GET /receivables/summary` (aging figures) | `receivable.view` |
| `GET /receivables/overdue` (filter, search, page) | `receivable.view` |
| `GET /service-control/policy` | `service.control` |
| `PUT /service-control/policy` | `service.control` |
| `GET /service-control/technicians` | `service.control` |
| `GET /service-control/suspensions` | `service.control` |
| `GET /service-control/suspensions/:id` | `service.control` |
| `POST /service-control/services/:id/suspend` | `service.control` |
| `POST /service-control/suspensions/:id/lift` | `service.control` |
| `POST /service-control/suspensions/:id/request-reconnection` | `service.control` |
| `POST /service-control/reconnections/:id/assign` | `service.control` |
| `POST /service-control/reconnections/:id/complete` | `service.control` |

`receivable.view` covers OWNER, ADMIN, SUPERVISOR and AUDITOR, which is what lets an auditor
read the aging report. `service.control` covers OWNER, ADMIN and SUPERVISOR only. The register
and the policy are **decisions**, not money, so they are read and written under
`service.control` and the auditor is refused with `403` — verified as an explicit assertion in
`tests/integration/receivables.test.ts` rather than left to a role-mapping assumption.

The renderer goes one step further: a user without `service.control` is never shown the
register or policy tabs at all, because a screen whose every command the API would refuse is
a worse experience than an absent screen.

## Desktop

- **Receivables** module: the aging report (totals, the four overdue bands, filter and search,
  a detail grid per account), the suspension register with the service history, and the
  service policy form.
- **Suspension command**: available only on a row the server marked eligible, with a
  compulsory reason. The confirmation states the fee and the number that will be issued.
- **Reconnection command**: refused by the screen when the account is inside the grace period,
  refused by the API when the balance is open, and the fee is shown before it is filed.
- Narrow-width: the totals and the table fit 900 px with no horizontal overflow (FND-07),
  which the Electron walkthrough asserts on the aging screen.

## Schema migrations

`0014_service_control.sql` adds `service_policy`, `suspensions`, `reconnections` and
`service_history`. `0015_service_control_guards.sql` adds the immutability, lifecycle and
append-only triggers and the payments reference kind for `SUSPENSION` / `RECONNECTION`
numbers, so documents come from the same gap-free per-year sequences as invoices and receipts.

The `service_status` check constraint was **not** hand-edited in `0015`. Editing a generated
migration leaves the database schema and `database/schema.ts` disagreeing, which is exactly
the drift `AUTO-06` is meant to catch. The status value was added to `database/schema.ts` and
the constraint was regenerated as `0016_service_status_suspended.sql`, so `npm run db:generate`
reports "No schema changes" and the journal, snapshot and applied history all agree.

## Review focus

- Is any receivable or aging figure stored rather than derived?
- Can an account be suspended inside its grace period, or below the threshold?
- Can a reconnection be filed while money is still owed?
- Can a suspension be lifted without a reconnection being completed?
- Does the register ever show a command the caller is not permitted to use?

## Deferred to later phases

Reports, dashboards, exports and non-route printing (Phase 8); backup/restore, multi-office
concurrent posting and packaging (Phase 9). The manual Phase 6 and Phase 7 walkthroughs in
`TEST_CHECKLIST.md` have not been performed by a human, and the aging report has not been
sent to a physical printer.
