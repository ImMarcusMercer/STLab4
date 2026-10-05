# BCIS Demo Script (5–7 minutes)

Prerequisites: database seeded (npm.cmd run db:seed:demo), API running, demo credentials in `.local/demo-credentials.txt` (never committed).

1. Login (30s)
- Launch desktop; sign in as `demo-owner` / password from `.local/demo-credentials.txt`
- Show workspace, role-based nav (OWNER sees all; VIEWER restricted)

2. Master data (30s)
- Subscribers/Services: search `DEMO-S001`, show multiple services, addresses, collector/area
- Plans: show Internet/Cable/Combo, retained pricing

3. Billing (1m)
- Billing cycles/invoices: show finalized invoices, statement for `DEMO-S001`
- Highlight immutability (posted figures)

4. Payments (1m)
- Collect payment (cash), oldest-due-first, overpayment held as credit
- GCash claim lifecycle (unconfirmed until second user)
- Receipt PDF: allocations + signatures; note line cap

5. Collections & Remittances (1m)
- Route sheet, remittance, shortage/overage, two-person reconciliation
- Closed batches not editable

6. Receivables & Control (1m)
- Aging buckets sum back to total; suspended vs reconnected
- Suspension policy, technician assignment, fee

7. Reports & Exports (2m)
- Dashboard: KPIs, aging strip, billing vs collection trend
- Run AR_AGING, REVENUE (by plan), export PDF/XLSX/CSV
- Show samples in `docs/samples/` (match API output)

8. Backups (30s)
- History/read-only verify; restore requires `RESTORE` + reason (OWNER only)

Notes: Synthetic data only. No secrets in screenshots. Receipt `RCT-2026-1001` exceeds line cap → statement fallback (documented).
