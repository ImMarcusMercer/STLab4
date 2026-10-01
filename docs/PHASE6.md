# Phase 6: collection batches, remittance and route sheets

## Design

A collector leaves the office with a **route sheet**, not with a live balance. A route
(batch) is the office's frozen copy of one collector's account list for one area on one
day, and it exists so that four later questions can each have one authoritative answer:

| Question | Answered by |
|---|---|
| What was owed on the day the sheet was printed? | The frozen `batch_accounts` rows |
| How much of it was collected? | Posted payments carrying `collection_batch_id` |
| How much cash was handed in, and did it match? | The one `batch_remittances` row |
| Who accepted a difference, and why? | The remittance row signed by a second person |

Nothing is ever recalculated backwards onto an earlier sheet, and no route document is
deleted or rebalanced. This phase adds no new money arithmetic of its own: every peso
figure is derived by the API from the same integer centavos the billing and payment
phases already use.

## Route snapshot (AT-09)

Opening a route copies the area's accounts into `batch_accounts`:

- only accounts with an **open balance** are added, so a collector is never sent to an
  account with nothing due;
- at most `routeAccountLimit` (500) accounts, so a route stays a printable document
  rather than an unbounded list;
- the **latest** open invoice becomes the *current bill* and every earlier open invoice
  is summed into *arrears*, because "current bill" must mean the bill the customer
  considers current, not merely the newest row;
- `total_due_centavos = current_bill + arrears` is stored per account, so the sheet
  cannot drift if an invoice is later adjusted.

A duplicate route for the same collector, area and date is refused. That constraint is
the reason a collector cannot silently produce two competing sheets for one day.

## Lifecycle

`OPEN → IN_PROGRESS → SUBMITTED → REMITTED → RECONCILED → CLOSED`

| Step | Effect |
|---|---|
| Open | Snapshot written; nothing collected yet |
| Start | Optional explicit mark that the collector has left |
| First collection | Moves `OPEN → IN_PROGRESS` on its own |
| Submit | Sheet frozen; further collections are refused |
| Remit | Expected cash frozen against counted cash; variance stored |
| Reconcile | Variance accepted by a second person, with a written reason |
| Close | Document retained; no further changes |

The transition table lives in the shared contract so the renderer never invents a step,
and it is mirrored by a database trigger so direct SQL cannot skip a stage.

## Derived totals, never stored totals

The batch stores the frozen snapshot and never a running collected total. Collected
amount is derived from payments that are **posted**, excluding **pending** GCash claims
and excluding **reversed** entries. An unconfirmed GCash claim is money that has not
happened yet, so it is reported separately as a pending figure and it blocks submission.

Account status is read from the frozen amount and the collected amount:
`PENDING`, `PARTIAL`, `COLLECTED`, `OVERPAID`.

## Remittance (AT-07)

The remittance compares the cash the route expected against the cash actually counted:

```
reconcileCash(expected, counted) -> { balanced, shortageCentavos, overageCentavos }
```

- exact match ⇒ `balanced`, both variance fields `0` (AT-07);
- short ⇒ `shortageCentavos > 0`, `overageCentavos = 0` (AT-08);
- over ⇒ `overageCentavos > 0`, `shortageCentavos = 0` (AT-08).

Only one direction can ever be set, so a count can never claim to be both short and
over. A variance is **never** adjusted away to make a sheet look balanced; it stays on
the record until a second person explains it. A nil remittance (`0.00`) is legitimate.

## Four-eyes reconciliation

Reconciling requires both a non-blank written reason and a signer other than the person
who counted the cash. This is enforced twice on purpose:

- in the service, so the API refuses it and returns a clear message; and
- in a `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED`, so even a direct SQL
  insert cannot leave a self-signed remittance in the table at commit.

## Immutability and the transaction-local flag

Frozen route accounts, posted remittances and payment batch links cannot be edited or
deleted. The legitimate writers — the service opening a route, the payment service
recording or reversing a payment, the remittance being written — run inside a
transaction that sets a transaction-local flag (`bcis.collection`), exactly as Phase 4
and Phase 5 did with `bcis.posting`. Anything else is refused by the database.

A lifecycle change outside that flag is refused unless the statement carries
`bcis.collection = 'transition'` for the single expected step, so a repair script can
never invent a state change.

## API contract

| Operation | Permission |
|---|---|
| `GET /collections/batches` (list, filter, search, page) | `collection.view` |
| `GET /collections/batches/:id` | `collection.view` |
| `GET /collections/batches/:id/route-sheet` | `collection.view` |
| `POST /collections/batches` | `collection.manage` |
| `POST /collections/batches/:id/start` | `collection.manage` |
| `POST /collections/batches/:id/submit` | `collection.manage` |
| `POST /collections/batches/:id/remit` | `collection.manage` |
| `POST /collections/batches/:id/reconcile` | `collection.reconcile` |
| `POST /collections/batches/:id/close` | `collection.reconcile` |

The route sheet is a **read-only projection** of the stored route. The renderer does not
rebuild the printed figures; it renders what the API returned.

## Payment linkage

A payment may name `collectionBatchId`. The payment service then refuses any subscriber
that is not frozen on that route, auto-starts an `OPEN` route on the first collection,
and issues a receipt that carries the batch number. A reversal inherits the batch link,
so a reversed collection leaves the route's collected total rather than hiding it.

## Desktop

- **Collections** module: the routes tab (list, search, status filter, pagination, route
  creation) and the *Areas & collectors* setup tab, which reuses the existing master-data
  screen.
- **Batch panel**: the five figures (expected, cash, non-cash, uncollected, variance),
  the frozen account table with per-account status, the collect form, submit, remittance,
  reconciliation, close, and the route-sheet preview.
- **Print**: `@media print` hides the workspace and prints only the sheet. The final
  `window.print()` action is deliberately not clicked in automation, because it opens a
  native dialog.

Because the route's collect form needs **both** `collection.manage` and `payment.create`,
a supervisor manages routes but is never offered a payment form, and a cashier who lacks
`collection.view` never sees the module at all.

The GCash proof reader was extracted to `pages/proof-file.ts` and shared with the
Payments screen, so both screens enforce the same 5 MB and MIME limits.

## Schema migrations

`0013_collection_batches.sql` adds `collection_batches`, `batch_accounts`,
`batch_remittances`, the payment batch link, the unique route-per-day constraint, and
the immutability, lifecycle, variance and four-eyes triggers. The payment reference-kind
sequence accepts `BATCH` and `REMITTANCE` so batch and remittance numbers come from the
same gap-free per-year sequence as invoices and receipts.

## Review focus

- Is any collected or variance figure stored rather than derived?
- Can a pending GCash claim ever be counted as collected money?
- Can one signer both count and accept a variance?
- Does the printed sheet ever disagree with the stored route?

## Deferred to later phases

Receivables, aging and suspension/reconnection approvals (Phase 7); reports, exports and
non-route printing (Phase 8); multi-office concurrent operation (Phase 9).