BCIS demonstration accounts

username: demo-admin, demo-cashier, demo-supervisor, demo-auditor, demo-viewer, demo-technician
password: Demo-GPiwm1_bHugB-Fp0s_sfb

Synthetic laboratory data only. Delete this file before any submission.
Role	                Username	            Password
Owner	                owner	                70679407fdf0e5ad99922f95b759986e2e6a823248414356
Administrator	        demo-admin	            Demo-GPiwm1_bHugB-Fp0s_sfb
Cashier	                demo-cashier	        Same demo password
Collection Supervisor	demo-supervisor	        Same demo password
Auditor	                demo-auditor	        Same demo password
Viewer	                demo-viewer	            Same demo password
Technician	            demo-technician	        Same demo password

npm.cmd run db:start
npm.cmd run dev

npm.cmd run db:stop

# BCIS Subscription Billing and Collection System

Independent implementation of the BCIS laboratory. The earlier student-information application remains in `../student-information-api` and is not a dependency of this project.

**Current increment: Phase 10 QA, documentation and defense.** All Phases 1–9 are complete; Phase 10 delivers acceptance evidence (AT-01–AT-12), the demonstration dataset, technical documentation (ERD), a user manual, report/receipt samples, refreshed screenshots (including reports), and release/demonstration prep. See [TASK.md](TASK.md), [User Manual](docs/USER_MANUAL.md), [ERD](docs/ERD.md), [Acceptance](docs/ACCEPTANCE.md) and [Sample exports](docs/samples/README.md).

Verification results and screenshots are recorded in [test evidence](docs/TEST_EVIDENCE.md).

Use the [test and verification checklist](TEST_CHECKLIST.md) to check completed features, record expected/actual results and rerun automated verification.

## Windows setup

Prerequisites: Node.js 22.13+, 24.x, or 26+ (verified environment uses Node 26), npm, and PostgreSQL 17 binaries. Commands use `npm.cmd` so PowerShell does not require an execution-policy change.

From this directory:

```powershell
npm.cmd ci
npm.cmd run db:setup
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

`db:setup` creates a dedicated local development PostgreSQL cluster under ignored `.local/postgres`, on **127.0.0.1:55432**, and database `bcis`. It generates a random database password in ignored `.env`, preserves existing configuration, and never opens or modifies the student database. It uses `PG_BIN` if set, otherwise PostgreSQL 17's standard Windows installation path (or PATH on other platforms). The generated database user owns this development cluster; use restricted service credentials for a later production deployment.

The initial username is `owner`; open your local ignored `.env` and use `BOOTSTRAP_ADMIN_PASSWORD` to sign in. The seed generates this password without printing it. Rerunning the seed preserves existing accounts and passwords; editing the bootstrap value does not reset an existing account. Owners can manage accounts through Administration.

The Fastify API uses **127.0.0.1:3100**. The desktop opens alongside it. Close the desktop and press Ctrl+C in the terminal to end development processes. PostgreSQL has its own lifecycle:

```powershell
npm.cmd run db:stop
npm.cmd run db:start
```

On subsequent runs, use `db:start` followed by `dev`. Setup can be rerun without resetting the database. It rejects an existing `.env` pointing at a different database: custom/remote databases should be provisioned separately, then use `db:migrate`.

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Server-only PostgreSQL connection string |
| `HOST` | API bind address; default `127.0.0.1` |
| `PORT` | API port; default `3100` |
| `BCIS_API_URL` | Desktop main-process API origin; default `http://127.0.0.1:3100` |
| `LOG_LEVEL` | Pino verbosity; default `info` |
| `PG_BIN` | Optional directory containing `initdb` and `pg_ctl` |

The `.env` is read from the working directory. Never commit it. Packaged-client configuration and LAN deployment are later milestones. Keep the API on loopback until transport security and deployment hardening are implemented.

## Commands

```powershell
npm.cmd run check       # TypeScript strict, ESLint, Vitest
npm.cmd run build       # Electron main/preload and React production bundles
npm.cmd run test:db     # Real PostgreSQL migration and readiness check
npm.cmd run test:integration # Auth/RBAC against a disposable PostgreSQL database
npm.cmd run test:e2e    # Built Electron integration tests (build + start DB first)
npm.cmd run db:generate # Generate migration after an intentional schema change
npm.cmd run package:win  # Build and create unpacked Windows application
npx electron-builder --win # Generate full NSIS installer
```

To run built desktop code, use `npm.cmd run start:api` in one terminal and `npm.cmd start` in another. `package:win` creates an unpacked Windows application; use `npx electron-builder --win` to generate the full NSIS installer. See [Deployment guide](docs/DEPLOYMENT.md) for details.

## API

- `GET /health`: process liveness, independent of database availability.
- `GET /api/v1/system/status`: 200 when PostgreSQL and the foundation migration are ready; 503 with a safe degraded response otherwise.
- `POST /api/v1/auth/login`: validated credentials, rate-limited sign-in.
- `GET /api/v1/auth/me`: current account and permissions using a bearer session.
- `POST /api/v1/auth/logout` and `/api/v1/auth/lock`: revoke the current session.
- `GET`/`POST /api/v1/admin/users` and `PATCH /api/v1/admin/users/:id`: Owner-only paginated listing, creation and updates.
- `GET`/`POST /api/v1/{plans,areas,collectors,subscribers,services}`: paginated search and validated creation.
- `GET`/`PUT /api/v1/{resource}/:id`: read/update a record, with an expected version and reason for edits.
- `GET /api/v1/{resource}/:id/history`: paginated saved revisions.
- `PATCH /api/v1/{subscribers,services}/:id/assignment`: collection-authorized area/collector reassignment.
- `GET /api/v1/billing/cycles` and `GET /api/v1/billing/runs`: billing periods and the generation history.
- `POST /api/v1/billing/runs`: generate one period; re-running it is safe and reports what was skipped.
- `GET /api/v1/billing/invoices` and `GET /api/v1/billing/invoices/:id`: search and read documents.
- `POST /api/v1/billing/invoices`, `PUT /api/v1/billing/invoices/:id/items` and `POST /api/v1/billing/invoices/:id/finalize`: manual draft, re-issue and numbering.
- `POST /api/v1/billing/invoices/:id/adjustments` and `POST /api/v1/billing/invoices/:id/void`: audited corrections and reversal.
- `POST /api/v1/billing/overdue-sweep` and `GET /api/v1/billing/ledger`: overdue status and the account statement.
- Unknown routes, including hard-delete routes: structured 404 with a request ID.

### Payments

- `GET /api/v1/payments` and `GET /api/v1/payments/account`: search the register and open a subscriber's balance.
- `GET /api/v1/payments/:id` and `GET /api/v1/payments/:id/proof`: read a payment with its allocations, and its receipt image.
- `POST /api/v1/payments`: record a cash payment or a GCash claim.
- `POST /api/v1/payments/:id/verify`, `POST /api/v1/payments/:id/void` and `POST /api/v1/payments/:id/reverse`: second-person confirmation, void of an unposted claim, and reversal of a posted receipt.

Sessions expire after eight hours. Password, role and activation changes revoke the affected account's sessions. The last active Owner cannot be removed. Tokens stay in Electron main memory; the renderer receives only account information. See [authentication design](docs/AUTHENTICATION.md).

## Using Phase 3

1. Open **Collections** to create areas/routes and collectors. Field collectors are staff records and do not require login accounts.
2. Open **Subscribers → Plans** to create Internet, Cable or Combo offers. Enter PHP amounts with at most two decimals; the API stores integer centavos.
3. Use **Subscribers → New subscriber** for identity, contacts, multiple addresses, collection assignments and billing/due days.
4. Open **Service accounts** to add one or more installations for a subscriber. Select a plan and enter the agreed current rate, installation address, billing start and status. An active service requires an activation date.
5. Use **Edit** with a reason to maintain a record, or **History** to review saved revisions. Codes are permanent. Archive/terminate accounts instead of deleting them; deactivate active services before making their subscriber inactive.

Reference dropdowns show up to 30 active matches; their search boxes find additional records. Lists use server pagination, search, status filters and sorting. A stale edit is rejected: close the form, refresh and reopen the latest record before reapplying it.

Owner/Administrator maintain subscribers, plans and services. Collection Supervisors maintain areas/collectors and change assignments, without changing subscriber identity or service rates. Cashiers can search/read subscribers; Technicians can read service operations. Viewers have no access to these maintenance screens.

Plan edits preserve every revision and leave existing service rates unchanged. Each service retains its selected plan revision. Explicit service-rate edits are audited. Immutable invoice rate snapshots and calendar billing calculations are implemented in the Phase 4 engine below; suspension/reconnection approval workflows are Phase 7. See [Phase 3 design and implementation record](docs/PHASE3.md).

## Using Phase 4

1. Open **Billing → Billing cycles**, choose a period (`YYYY-MM`) and click **Generate period**. Each active service whose billing start date has passed receives one invoice, issued on its billing day and due on its due day, with the month length clamped where necessary.
2. Repeating the same period issues nothing twice: the stored run is reused, services that already hold a document are reported as skipped, and only the slot released by a void is filled, with a new document and a new number.
3. Open **Invoices** to search issued and draft documents. A document is never edited after issue. Use **Adjust** with a reason to append a debit or credit line, or **Void** with a reason to keep the document and post a linked reversal. A credit may be smaller than the balance but never settles it; a payment settles it (Phase 5 below).
4. Use **New invoice** for a manual document. It is saved as a draft with no number and no statement line; issue it from the dialog to assign the number and post the debit. A draft you discard can be voided without ever being numbered.
5. **Sweep overdue** marks unpaid documents past their due date as overdue; settled and voided documents are untouched.
6. Open **Subscriber ledger**, search the account and choose **Open**. The statement lists every posted debit, credit and reversal in date order with the running balance the API reproduced from those entries, and a From/To range reports the balance at the start and end of that range.

Owners generate periods, issue, adjust and void. Cashiers can read cycles, invoices and statements without those controls. Collection Supervisors and Technicians have no billing access. Numbers are per year, start at `1001` and are never reused; stored amounts are exact integer centavos, and the database refuses edits or deletes of posted financial rows. See [Phase 4 design and implementation record](docs/PHASE4.md).

## Using Phase 5

1. Open **Payments**, search for the subscriber and click **Collect from …**. The account panel shows the outstanding total, any advance credit, the oldest open due date and every invoice with its status, all as the API calculated them.
2. Choose **Cash** and the amount received, then **Record payment**. The server settles the oldest due invoice first, continues across invoices while money remains, and holds any excess as advance credit on the account. The confirmation reports what was applied and what was held.
3. Choose **GCash** for a wallet transfer. A reference number and a receipt image (PNG, JPEG or PDF, at most 5 MB) are both required. The entry is stored as a **pending claim**: it holds no receipt number, reduces no balance and posts nothing to the ledger until someone else confirms it.
4. A claim cannot be confirmed by the person who recorded it, and its reference cannot be reused while it is live. Ask a second authorised user to open the claim, compare the reference with the attached image, and click **Confirm and post** — that is where the receipt number is issued.
5. Use **Void** on a pending claim that must be discarded; the entry keeps its reason and releases its reference. Use **Reverse** on a posted receipt that took the wrong money; it posts its own receipt, marks the original allocations as reversed and reopens the invoices it had settled. The original receipt number stays visible.
6. **Payment history** searches by receipt, reference or subscriber and filters by status and method. Open any entry to see its allocations oldest first, its attached receipt with its SHA-256 fingerprint, and its void or reversal reason.

A recorded payment can never be edited, from the screen or from SQL: the amount, subscriber, method and date are fixed when it is stored, and the database refuses a delete. Owners hold every payment permission; Administrators and Cashiers can record, view and confirm but cannot reverse; Auditors can read and reverse but cannot record. Collection routes, batches and remittances are Phase 6 and remain pending. See [Phase 5 design and implementation record](docs/PHASE5.md).

## Layout

```text
source/api/                 Fastify server and database boundary
source/desktop/main/        Electron lifecycle and bounded HTTP calls
source/desktop/preload/     Typed, named IPC bridge
source/desktop/renderer/    React UI and styles
source/shared/              Zod contracts
database/                   Drizzle schema, migrations and migration runner
scripts/                    Local PostgreSQL setup and integration verification
tests/                      Vitest and Playwright Electron tests
docs/                       Architecture, development log and test evidence
```

The renderer has no Node/database access. Authoritative financial logic resides in the API, with PostgreSQL transactions and exact integer-centavo money. [Foundation design](docs/FOUNDATION.md) describes the boundaries.

## References

- Local BCIS laboratory PDF: architecture, required modules and acceptance tests.
- [Electron context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) and [sandboxed preload limitations](https://www.electronjs.org/docs/latest/tutorial/esm).
- [electron-vite development](https://electron-vite.org/guide/dev).
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations).
- [PostgreSQL initdb](https://www.postgresql.org/docs/17/app-initdb.html).
