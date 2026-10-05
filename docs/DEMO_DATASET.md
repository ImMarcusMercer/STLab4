# The demonstration dataset

Section 8 of the laboratory asks for a minimum dataset that makes the finished system
demonstrable without a real customer: five users across the roles, seven plans, fifty
subscribers with more than one service account each, three billing months, a mix of payment
kinds, overdue accounts in more than one aging bucket, a correction, and a disconnection that
comes back. This document records what the seed writes, how to run it, and how it is checked.

Nothing in the dataset is real. Subscriber codes are `DEMO-S…`, e-mail addresses end in
`@bcis.invalid` (a domain reserved by RFC 2606), GCash references are `GC-DEMO-…`, and every
subscriber row says in its notes that it is a synthetic laboratory demonstration record.

## Running it

The seed is meant for a fresh database, because it refuses to run over rows that are already
there:

```powershell
npm run db:start        # local PostgreSQL on 127.0.0.1:55432
npm run db:migrate
npm run db:seed         # role permissions and the bootstrap owner
npm run db:seed:demo    # the demonstration dataset
```

`db:seed:demo` refuses a database whose name looks like a test database unless
`BCIS_ALLOW_TEST_DEMO=1` is set, so a suite database cannot be seeded by accident. On a
development database it takes about 11 seconds and writes 188 invoices, 53 receipts and 437
audit entries — every one of them through the API, not around it.

The staff password is generated the first time and appended to the ignored local `.env` as
`DEMO_PASSWORD`, and written to the ignored `.local/demo-credentials.txt`. It is never
committed and never printed. The accounts are `demo-admin`, `demo-cashier`, `demo-supervisor`,
`demo-auditor`, `demo-viewer` and `demo-technician`; the bootstrap `owner` is separate.

```text
$ npm run db:seed:demo

  OK   Users covering Admin, Cashier, Supervisor, Auditor/Viewer       6  (minimum 5)
  OK   Internet plans                                                  3  (minimum 3)
  OK   Cable plans                                                     2  (minimum 2)
  OK   Combo plans                                                     2  (minimum 2)
  OK   Subscribers                                                    50  (minimum 50)
  OK   Service accounts                                               63  (minimum 60)
  OK   Service types in use across those accounts                      3  (minimum 3)
  OK   Collectors                                                      2  (minimum 2)
  OK   Collection areas                                                3  (minimum 3)
  OK   Billing months generated                                        5  (minimum 3)
  OK   Posted cash payments                                           36  (minimum 1)
  OK   Verified GCash payments                                        16  (minimum 1)
  OK   Partial payments leaving a part-paid invoice                   10  (minimum 1)
  OK   Advance payments holding a credit                               3  (minimum 1)
  OK   Overdue accounts                                               20  (minimum 10)
  OK   Aging buckets holding overdue money                             5  (minimum 3)
  OK   Reversed payments                                               1  (minimum 1)
  OK   Voided payment entries                                          1  (minimum 1)
  OK   Reconciled and closed collection routes                         3  (minimum 1)
  OK   Suspension / reconnection scenarios                             2  (minimum 2)

PASS: the demonstration dataset meets every minimum in section 8 of the laboratory.
```

The script exits non-zero when a minimum is unmet, so the table is a check rather than a
report.

## How it is written

`database/seed-demo.ts` drives the real Fastify routes with `app.inject`. Nothing is inserted
with raw SQL: a subscriber is created through `POST /subscribers`, an invoice through
`POST /billing/invoices` and its `…/finalize`, a payment through `POST /payments`, a route
through the collection batch lifecycle, a suspension and its reconnection through the
service-control routes. The point is that the numbers on the demonstration screens are the
numbers the application's own guards, numbering, allocation and audit trail produced — if the
API would refuse an office, it refuses the seed too.

Two consequences are worth knowing before a rehearsal:

- **It is not re-seeded.** Posted financial history is never deleted, so a second run over the
  same database fails with an explanation. Another rehearsal needs a fresh database (drop and
  recreate it, then migrate and seed again).
- **Role permissions are topped up, not reset.** The seed calls the same security seed the
  bootstrap uses, so a development database created before a later phase added a permission is
  brought up to date. An existing owner keeps its password; the seed only inserts what is
  missing.

## What is in it

**People.** Six demonstration accounts plus the bootstrap `owner`:

| Username | Role | Can demonstrate |
|---|---|---|
| `demo-admin` | ADMIN | billing, service control, reconciliation, reports |
| `demo-cashier` | CASHIER | recording payments, proofs, part payments |
| `demo-supervisor` | SUPERVISOR | route sheets, remittance, receivables follow-up |
| `demo-auditor` | AUDITOR | reversal, audit trail, reports, read-only evidence |
| `demo-viewer` | VIEWER | permission-aware navigation: dashboards and reports only |
| `demo-technician` | TECHNICIAN | reading service accounts; the account the office assigns reconnection work to (assignment itself is done by an Administrator) |

**Master data.** Three collection areas (`DEMO-A1` Poblacion North, `DEMO-A2` Mabini South,
`DEMO-A3` San Isidro East), two collectors, and seven plans: Internet `DEMO-N50` / `DEMO-N100` /
`DEMO-N200`, Cable `DEMO-C50` / `DEMO-C80`, and the two-combo pairing `DEMO-CB100` / `DEMO-CB200`.

**Subscribers and services.** 50 subscribers and 63 service accounts (every fourth subscriber
takes a second line), so the three service types are all in use.

**Billing.** Five invoice periods are represented — May, July, August, September and
October 2026 — covering three months generated by the billing engine plus the deliberately
dated drafts that create the aging fixtures.

**Money.** 36 posted cash payments, 16 verified GCash payments, 10 part payments that leave an
invoice part-paid, 3 advance payments that leave credit held against the account, 55 payment
rows in total and 241 ledger entries.

**The aging fixtures.** 20 accounts carry an open balance, deliberately spread so that five
buckets hold money — current, 1–30, 31–60, 61–90 and over 90 days. The oldest is `DEMO-S044`
with an invoice due 2026-05-27. These are raised with real draft invoices dated at
`today − {20, 45, 75, 130}` days and finalized through the API, then marked by the office's own
`POST /billing/overdue-sweep`.

**Corrections.**

| State | Reference | What it shows |
|---|---|---|
| `REVERSED` | receipt `RCT-2026-1001`, `GC-DEMO-000001` | an auditor reverses a posted payment; the original receipt stays, the settled invoices reopen, and the reversal posts its own receipt `RCT-2026-1053` |
| `VOID` | `GC-DEMO-000017` | a claim voided before posting, with the reference freed and the history kept |
| `PENDING` | `GC-DEMO-000018` | an unconfirmed claim: no receipt number, no allocation, no effect on any balance |

**Routes.** `BCH-2026-1001`, `BCH-2026-1002` and `BCH-2026-1003` — one per area — each opened,
worked, remitted exactly, reconciled by a second user and closed.

**Service control.** `SUS-2026-1001` (service `DEMO-S049-1`) is still **ACTIVE**: the account is
disconnected and stays disconnected, which is what the reconnection screen needs. `SUS-2026-1002`
(service `DEMO-S050-1`) is **LIFTED** after reconnection `RCO-2026-1001` completed with a
technician assigned and the policy fee charged.

## Suggested walkthrough

1. Sign in as `demo-viewer` and confirm the navigation offers dashboards and reports but not
   billing, payments or settings.
2. Sign in as `demo-cashier`, search `DEMO-S001`, and open its account: invoices, the payment
   history and the statement all come from the seeded rows.
3. Look at `DEMO-S044` (over 90 days) and `DEMO-S034` (1–30 days) in the receivables worklist,
   then the aging report — five buckets, summing back to the receivable total.
4. Open `SUS-2026-1001` to show a line still disconnected, and `SUS-2026-1002` to show the
   reconnection history with the technician and the fee.
5. Show the three closed route sheets and the exact remittance for `BCH-2026-1001`.
6. Show receipt `RCT-2026-1001` (reversed, with its own reversal receipt beside it), the voided
   claim `GC-DEMO-000017` and the still-pending claim `GC-DEMO-000018`.
7. Print or export the revenue report and the subscriber statement for `DEMO-S001`.

## How it is checked

`tests/integration/demo-dataset.test.ts` runs the seed against a throwaway PostgreSQL database
and then reads the result back. It checks the twenty minimums, that every row is marked as
demonstration data and uses the reserved domain, and — the part that would not survive a seed
written with raw inserts — that the money adds up:

- for every subscriber, billed = paid + open, paid = the standing allocations, received =
  allocations + credit still held, and the ledger's net balance = open − credit;
- every stored ledger running balance is reproduced by re-summing its own entries;
- an unconfirmed GCash claim has no allocation and no receipt number;
- receipt numbers per year run from 1001 with no gap and no repeat;
- a suspension and a completed reconnection are on the register, and the append-only service
  history records them;
- a second run over the same database is refused.

Both suites were run on 2026-10-05: 200 unit tests and 171 PostgreSQL integration tests pass,
with typecheck and lint clean.

## Limits

- The dataset is synthetic and is never re-seeded over posted history; a second rehearsal needs
  a fresh database.
- Dates are relative to the day the seed runs, so bucket ages and "overdue" counts drift a few
  days if the database is left standing.
- The generated demonstration password lives only in the ignored local `.env` and
  `.local/demo-credentials.txt`; delete `.local/demo-credentials.txt` before any submission.
- No human has yet walked the demonstration on screen; the walkthrough above is a plan, not a
  record.
