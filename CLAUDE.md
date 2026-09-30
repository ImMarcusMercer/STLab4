# BCIS project rules

- Work only within this BCIS project. Do not alter `../student-information-api`.
- Read `TASK.md` and the BCIS laboratory PDF before a new feature. Implement coherent tasks sequentially and record actual verification before checking them off.
- Keep the React renderer free of Node, credentials, SQL and authoritative business logic. Use named typed preload operations and validate server inputs with Zod.
- The API owns authentication, permission checks, financial calculations and PostgreSQL transactions.
- Use migrations for schema changes. Use integer centavos or exact NUMERIC/DECIMAL values for money. Never delete or overwrite posted financial history; reverse/adjust with an actor and reason.
- Never commit `.env`, real customer/payment data, database files, attachments, or private credentials. Demonstration data must be synthetic.
- Test financial invariants and acceptance cases before claiming business workflows complete. Keep incomplete phases visibly pending.
- Run `npm run check`, `npm run build`, `npm run test:db` and `npm run test:e2e` for foundation changes. See README for PostgreSQL lifecycle and Windows commands.
