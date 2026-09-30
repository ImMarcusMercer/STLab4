# Phase 5: payments, allocation and receipts

## Design

The API gains a payments module. The collector chooses a subscriber, a method, an amount
and, for GCash, a reference and a receipt image; the server decides which invoices the
money settles, issues the receipt number, moves the ledger and stores the attachment. The
renderer never computes an authoritative amount, never picks an invoice and never writes
a document number. Phase 5 does not implement collection batches, remittances,
receivables, reports or printing; those remain Phases 6–8 and are described as pending.

## Money policy

- Every amount is an integer number of centavos, exactly as in Phase 4. Allocation is
  integer arithmetic only; no division or rounding decides who gets paid.
- `payments.amount_centavos` is the money that arrived. It never changes. What the money
  did is recorded separately in `payment_allocations`, one row per invoice step, and the
  sum of the standing allocations of a payment is always `<= amount_centavos`.
- A payment is never edited. Its identity (`subscriber_id`, `method`, `direction`,
  `amount_centavos`, `received_on`, `reference_number`, `recorded_by`, `reversal_of_id`,
  `notes`, `created_at`) is fixed by a trigger, so an amount that turns out to be wrong
  is corrected by a reversal, never by overwriting the row.

## Allocation order (AT-01, AT-03, AT-04)

The set of invoices a payment may settle is the subscriber's invoices that are neither
`DRAFT` (not a debt yet) nor `VOID` (keeps no balance) and still have
`balance_centavos > 0`, ordered by `due_date, issue_date, id`. The **due date decides**,
not the invoice number and not the order the invoices were created in, so a payment always
lands on the oldest debt first. The integration fixture deliberately issues the
later-due invoice first, which is what makes the ordering observable.

One amount is then applied greedily, oldest invoice first, for as long as money remains:

- an amount equal to the balance settles that invoice exactly;
- a smaller amount settles it partially and the invoice becomes `PARTIALLY_PAID`;
- a larger amount continues to the next open invoice;
- whatever is left when no open invoice remains is **not lost**: it stays on the account
  as advance credit and is reported as `advanceCentavos`.

Every step is a `payment_allocations` row with its own actor and timestamp, so the
statement can always answer "which money settled this invoice" and not merely "how much
was paid in total".

## Held credit (AT-03)

Credit is not a balance column that can drift. It is computed as
`sum(amount_centavos) - sum(standing allocations)` over the subscriber's `POSTED`
payments of direction `PAYMENT`, oldest first, so the credit that is spent is the credit
that was received first and every centavo keeps the identity of the receipt it came from.

When a new payment is posted, the credit the subscriber already holds is spent against
their open invoices **before** the new money is allocated, and those rows are written
with `source = 'ADVANCE'` against the older payment. The payment being posted is
excluded from that search, because its own money is allocated by the same command and
must never be spent twice. An invoice whose balance reaches zero while an advance
allocation is standing is shown as `CREDITED` rather than as a cash payment, which is the
distinction an auditor needs on the statement.

## Receipts (AT-01, AT-06)

- A receipt number is `RCT-<year>-<counter>`, allocated from the same
  `document_sequences` mechanism as invoices, so numbers are gap-free per year, start at
  `1001` and are never reused — not even by a reversed or voided entry.
- A number exists only on a `POSTED` payment. A `PENDING` GCash claim and a `VOID` entry
  never held one, and the database check constraint refuses the combination.
- A cash payment posts immediately and takes its number in the same transaction that
  allocates it. A GCash payment takes its number only at confirmation.
- The API returns the receipt together with the invoices it touched, the applied total
  and the advance total, and the desktop renders exactly that response.

## GCash, proof and two-person verification (AT-05)

A GCash payment is a claim, not a posting. It is stored `PENDING` and:

- requires a non-empty reference number and an attached receipt image; both are refused
  server-side with a validation error, not just hidden in the UI;
- holds **no** receipt number, reduces **no** invoice balance and posts **no** ledger
  entry while it waits;
- can be confirmed only by a second user who holds `payment.verify` and who did **not**
  record it. The API refuses a self-confirmation, and the confirm control is disabled in
  the renderer with the reason shown, so the rule is visible before it is attempted;
- is protected against a double entry by the partial unique index
  `payments_gcash_reference_idx` on `reference_number` for `method = 'GCASH' AND
  status <> 'VOID'`. The reference of a live claim therefore cannot be reused, while
  voiding a claim releases it. The conflict is raised by the database and translated into
  a clear message, so the rule does not depend on a check-then-insert race.

### Proof storage

An uploaded receipt is treated as untrusted input:

- the declared MIME type must be one of `image/png`, `image/jpeg`, `application/pdf`,
  and the leading bytes must match that type's signature, so a renamed executable is
  refused;
- the content must be well-formed base64, re-encodes to the same bytes, is not empty and
  is at most 5 MB, which is checked before anything is written;
- the file is stored under a **generated** `<uuid>.<ext>` name with the `wx` flag, so an
  upload can never overwrite an existing proof or choose its own path. The original name
  is kept only as a display label;
- the resolved path must stay inside the proof directory, and only a name matching the
  generated pattern is ever read back;
- the SHA-256 digest, byte size and type are stored with the payment, so a restored
  backup can be verified against the database;
- if the payment transaction fails after the file was written, the file is removed again,
  so a rejected payment never leaves an orphan attachment.

## Void and reversal (AT-06)

Two different corrections, because the money is in a different state:

- **Void** applies only to a `PENDING` claim, which never posted anything. The entry is
  kept with its reason, and its reference is released. Nothing is deleted.
- **Reverse** applies only to a `POSTED` payment. It creates a **new** payment row of
  direction `REVERSAL` linked to the original, takes its **own** receipt number, posts a
  linked ledger debit, marks each original allocation with `reversed_at` instead of
  deleting it, and reopens the invoices it had settled. The original keeps its receipt
  number and moves to `REVERSED`, so the register shows both documents.

A reversal is refused for a `PENDING`, `VOID` or already `REVERSED` payment, and a
collector who holds no `payment.reverse` permission cannot post one at all; the
integration and Electron suites cover both refusals.

## Immutability and allocation invariants

Migration `0012_payment_history_guards.sql` adds the database-level guarantees, so the
rules hold even for a direct SQL write that bypasses the API:

- `payments` cannot be deleted, and its identity columns cannot change. Its state may
  move only inside a transaction that sets the transaction-local `bcis.posting` flag,
  which is what the service does.
- `payment_allocations` cannot be deleted or edited; a reversal may only add the
  `reversed_at` mark, and only inside a posting transaction.
- `payment_proofs` cannot be updated or deleted at all: an attachment is kept for the
  life of the payment.
- A deferred constraint trigger proves both sides of every allocation: the standing
  allocations of an invoice always equal its `paid_centavos`, and the standing
  allocations of a payment never exceed the amount it received. The first catches an
  allocation written without moving the invoice; the second is what stops one receipt
  from being counted twice.

## Concurrency

Allocation and credit spending both take a transaction-scoped advisory lock keyed on the
subscriber (`allocation:<subscriberId>`), and every invoice row is re-read `FOR UPDATE`
before its figures move. Two collectors posting for the same subscriber therefore
serialise, while different subscribers do not block each other. The invoice lock and the
`bcis.posting` flag are the same mechanism Phase 4 uses for the ledger.

## API contract

| Operation | Route | Permission |
|---|---|---|
| List payments | `GET /api/v1/payments` | `payment.view` |
| Subscriber account and balance | `GET /api/v1/payments/account` | `payment.view` |
| One payment with allocations and proof | `GET /api/v1/payments/:id` | `payment.view` |
| Receipt image | `GET /api/v1/payments/:id/proof` | `payment.view` |
| Record a payment | `POST /api/v1/payments` | `payment.create` |
| Confirm a GCash claim | `POST /api/v1/payments/:id/verify` | `payment.verify` |
| Void a pending claim | `POST /api/v1/payments/:id/void` | `payment.create` |
| Reverse a posted payment | `POST /api/v1/payments/:id/reverse` | `payment.reverse` |

Every request is validated with Zod before the service runs, every response is
`Cache-Control: no-store`, and the upload is the only route with a larger body limit
(8 MB, to carry a 5 MB file as base64). `OWNER` holds all four payment permissions,
`ADMIN` and `CASHIER` hold view/create/verify, and `AUDITOR` holds view and reverse but
cannot record money.

## Desktop

The Payments screen has two tabs, **Collect payment** and **Payment history**, and uses
named preload operations only: `listPayments`, `getSubscriberAccount`, `recordPayment`,
`verifyPayment`, `voidPayment`, `reversePayment`, `getPayment` and `getPaymentProof`. The
token stays in main-process memory; the renderer holds no credential and no SQL.

- The account panel shows what the server decided — outstanding total, advance credit,
  the oldest open due date, and every invoice with its status — so the collector never
  has to add up the table.
- The allocation preview under the form follows the same oldest-due-first rule and is
  labelled as a preview; the stored allocation always comes from the response, and the
  preview is replaced by it after the command.
- After a successful command the screen refreshes through a `revision` value instead of
  remounting, so the confirmation of the command and the open account both stay on
  screen.
- A GCash claim must be confirmed by someone else: the control is disabled for the
  recorder with the reason shown, and the server refuses it independently.
- The receipt dialog shows the allocations oldest first, the attached receipt with its
  digest, and the void or reversal reason. Cashiers see no reverse control, matching the
  permission the API enforces.

## Schema migrations

- `0010_concerned_randall_flagg.sql` — `payments`, `payment_allocations`,
  `payment_proofs`, the state/identity check constraints, the GCash reference index and
  the allocation lookup indexes.
- `0011_petite_korvac.sql` — one proof per payment, so a claim cannot carry a second
  receipt image.
- `0012_payment_history_guards.sql` — the immutability triggers and the deferred
  allocation invariant check described above.

## Review focus

- A cash payment must settle the **oldest due** invoice first, and an overpayment must
  become visible credit rather than disappear.
- A GCash claim must be inert while it waits: no receipt, no balance change, no ledger
  entry, and no self-confirmation.
- The amount, the subscriber, the method and the date of a recorded payment must be
  impossible to change afterwards, from the UI or from SQL.
- A reversal must be a new document with its own receipt, and it must leave the original
  readable.
- The API, not the renderer, owns allocation, numbering and permissions.

## Deferred to later phases

Collection routes, printable route sheets and batch lifecycle; remittances with
shortage/overage and authorised reconciliation; receivables, aging and follow-up;
suspension and reconnection approvals; financial reports, exports and subscriber
statements; backup and restore of the proof directory; installer delivery. A collector
cannot yet take a payment as part of a collection batch, and no payment screen is
printed, which are Phases 6 and 8.
