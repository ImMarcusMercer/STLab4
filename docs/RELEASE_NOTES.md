# Release notes — BCIS v0.1.0 (Phase 10)

## What’s included
- Fastify API + PostgreSQL (schema, migrations, seeds, demo dataset)
- Electron desktop (React + preload/main, secure IPC)
- RBAC, authentication, audit logging, redaction
- Billing, payments (allocations/reversals), receipts (PDF), collections/remittances
- Receivables, service control (suspend/reconnect), reports (PDF/XLSX/CSV), dashboard
- Backups/restore (pg_dump/pg_restore, integrity checks), AT-01–AT-12 evidence
- ERD, user manual, samples, screenshots, demo script

## Build
- npm.cmd ci
- npm.cmd run build (electron-vite)
- npm.cmd run package:win (unpacked)
- npx electron-builder --win (NSIS installer)

## Pre-release checks
- npm.cmd run check — typecheck/lint/unit: clean (200 unit, 186 integration, 21 e2e)
- Demo seed: npm.cmd run db:seed:demo on fresh DB (prints 20 minimums)
- Secrets: .env, .local/* must not be shipped; demo creds only in local ignored file
- Backups use pg_dump/pg_restore from PATH

## Known limits (for defense)
- No live LAN/physical three-PC test; concurrency proved via API sessions
- No physical printer test (PDF export primary)
- Human visual review of screenshots pending (24 files)
- npm audit: 8 high severity in electron-builder packaging chain (build-time only)
- Receipt line cap: some payments with many invoices return 422 → use subscriber statement

## Deployment notes
- Dev: 127.0.0.1:3100 + desktop; PostgreSQL 17, Node 22–26
- Production: harden transport (TLS), restrict PATH/pg tools, rotate credentials, monitor logs
