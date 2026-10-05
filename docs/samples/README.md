# Sample exports

Six documents produced by the API against the **synthetic demonstration dataset**
(`npm.cmd run db:seed:demo`) in the local development database on **2026-10-05**. Every figure in
them comes from posted invoices, payments and ledger rows written by that seed — no file here is
hand-made. They are committed so a reader can open the output formats without running the system,
and so the report suites have a visible reference to compare against.

| File | Endpoint | What to look for |
|---|---|---|
| `AR_AGING_2026-10-05.PDF` | `GET /api/v1/reports/AR_AGING/export?format=PDF&to=2026-10-05` | The five published buckets as of one day, the footnote naming the age each bucket is measured from, and a reconciliation line that sums the rows back to the stated receivable |
| `COLLECTIONS_2026-09-01_2026-10-05.CSV` | `GET /api/v1/reports/COLLECTIONS/export?format=CSV&from=2026-09-01&to=2026-10-05` | Cash and GCash per period with the receipts behind each figure; RFC 4180 quoting, UTF-8 BOM so Excel opens it correctly |
| `PAYMENT_EXCEPTIONS_2026-09-01_2026-10-05.CSV` | `GET /api/v1/reports/PAYMENT_EXCEPTIONS/export?format=CSV&from=2026-09-01&to=2026-10-05` | The reversal, the void and the GCash claim still waiting for a second person |
| `REVENUE_2026-09-01_2026-10-05.XLSX` | `GET /api/v1/reports/REVENUE/export?format=XLSX&from=2026-09-01&to=2026-10-05&granularity=MONTH&dimension=PLAN` | Billed against collected revenue grouped by plan, one sheet, money stored as numbers |
| `SUBSCRIBER_LEDGER_DEMO-S001.PDF` | `GET /api/v1/reports/SUBSCRIBER_LEDGER/export?format=PDF&from=…&to=…&subscriberId=…` | One account's debit and credit history with a running balance that can be re-summed by hand |
| `RCT-2026-1049.PDF` | `GET /api/v1/payments/<payment-id>/receipt` | An issued receipt: the allocation order, the amount in words, the signature block and the printed instructions |

## Reproducing them

Start the database and the API (`npm.cmd run db:start`, `npm.cmd run db:seed:demo`,
`npm.cmd run start:api`), then from the repository root:

```powershell
$token = ((Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/api/v1/auth/login `
  -ContentType 'application/json' `
  -Body '{"username":"demo-admin","password":"<from .local/demo-credentials.txt>"}').token)
$headers = @{ Authorization = "Bearer $token" }

Invoke-WebRequest -Headers $headers -OutFile AR_AGING_2026-10-05.PDF `
  'http://127.0.0.1:3100/api/v1/reports/AR_AGING/export?format=PDF&to=2026-10-05'
Invoke-WebRequest -Headers $headers -OutFile COLLECTIONS.CSV `
  'http://127.0.0.1:3100/api/v1/reports/COLLECTIONS/export?format=CSV&from=2026-09-01&to=2026-10-05&granularity=MONTH'
Invoke-WebRequest -Headers $headers -OutFile PAYMENT_EXCEPTIONS.CSV `
  'http://127.0.0.1:3100/api/v1/reports/PAYMENT_EXCEPTIONS/export?format=CSV&from=2026-09-01&to=2026-10-05'
Invoke-WebRequest -Headers $headers -OutFile REVENUE.XLSX `
  'http://127.0.0.1:3100/api/v1/reports/REVENUE/export?format=XLSX&from=2026-09-01&to=2026-10-05&granularity=MONTH&dimension=PLAN'

$subscriberId = (Invoke-RestMethod -Headers $headers `
  'http://127.0.0.1:3100/api/v1/subscribers?q=DEMO-S001&perPage=1').items[0].id
Invoke-WebRequest -Headers $headers -OutFile SUBSCRIBER_LEDGER.PDF `
  "http://127.0.0.1:3100/api/v1/reports/SUBSCRIBER_LEDGER/export?format=PDF&from=2026-01-01&to=2026-10-05&subscriberId=$subscriberId"

$paymentId = (Invoke-RestMethod -Headers $headers `
  'http://127.0.0.1:3100/api/v1/payments?q=RCT-2026-1049&perPage=5').items[0].id
Invoke-WebRequest -Headers $headers -OutFile RCT-2026-1049.PDF `
  "http://127.0.0.1:3100/api/v1/payments/$paymentId/receipt"
```

The API suggests its own names (`BCIS-ar-aging-2026-10-05.pdf`, `BCIS-subscriber-ledger-…`); the
files here were renamed so a reader can see the report and the period without opening them.
Re-running the commands above reproduces them byte for byte apart from two characters' worth of
footer text: the document footer records the account that asked for the export (`BCIS Owner` on
these samples, `Demo Administrator` if you sign in as `demo-admin`).

The exports are also exercised on every run by `tests/integration/reports.test.ts` and
`tests/integration/receipts.test.ts`, which read the PDF text and the XLSX/CSV bytes back out and
reconcile the totals, so these files are a snapshot of output the suites already check.

## Limits

- The data is synthetic. Dates in the files move with the day the dataset was seeded; a later
  seed produces different numbers and different file names.
- `RCT-2026-1001` (the reversed demonstration receipt) deliberately settles six invoices and is
  **not** here: a single receipt page will not hold that many allocations, so the API answers 422
  and tells the reader to print the subscriber's statement instead. `RCT-2026-1049`, one invoice,
  prints normally and is the sample above.
- Nobody has opened these files and signed off on their appearance; the suites check their
  contents, not a human's opinion of the layout.
