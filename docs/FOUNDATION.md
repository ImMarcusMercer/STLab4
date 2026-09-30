# BCIS foundation design

Source: `../BCIS_Subscription_Billing_and_Collection_Laboratory_Activity.pdf`, sections 2, 6 and 9.

## Intent and scope

Build BCIS in a separate directory without modifying the previous student-information activities. This first increment delivers Phase 1: a runnable desktop shell, central API, PostgreSQL connection, migration, tests and setup documentation. It does not claim that billing or authentication is implemented.

## Architecture

```text
Office desktop 1 ---+
Office desktop 2 ---+--> Fastify API --> PostgreSQL
Office desktop 3 ---+        |
                            +--> Attachments / audit / backups (later phases)

Each desktop: React renderer --> typed preload --> Electron main --> HTTP API
```

The current foundation verifies one local desktop. The three-PC deployment is a later acceptance checkpoint.

- `source/desktop`: Electron main process, sandboxed preload, React renderer. The main process calls the configured API; the renderer receives only named, typed operations through preload. No database credentials or general-purpose IPC are exposed.
- `source/api`: Fastify server owns database access, validation and future business rules. `/health` checks process liveness; `/api/v1/system/status` checks PostgreSQL and the migrated schema. Errors have safe messages and request IDs.
- `source/shared`: Zod response contracts and TypeScript interfaces shared across the API and desktop boundary.
- `database`: Drizzle schema and versioned migrations. Financial entities will be introduced alongside their workflows, with exact money handling and transactions.
- `scripts`: repeatable local setup and isolated PostgreSQL lifecycle. Local PostgreSQL listens on loopback port 55432; API defaults to loopback port 3100. The student API on 8000 is untouched.

The lab's stack is used instead of extending Django or replacing the student application. One project with explicit source boundaries keeps the initial setup simpler than separately published workspace packages. Future deployment runs one API/PostgreSQL server for three desktop clients.

## First screen

A BCIS workspace shows a restrained navy sidebar with the lab's module groups, connection status, and an honest implementation checklist. Planned modules are marked unavailable. No fabricated subscribers, balances, or business KPIs. Connection refresh reports loading, ready, database unavailable and API unreachable states.

## Security and errors

Electron uses context isolation, sandboxing, disabled Node integration, denied popups, navigation restrictions, and a content security policy. Only `getSystemStatus()` crosses IPC. API URLs are configured outside the renderer and validated. Responses are validated before rendering. Requests have timeouts; internal exceptions are not sent to the renderer or API consumers. No financial API is exposed before server authorization is implemented.

## Validation

Vitest tests check live/readiness separation, unavailable database behavior, safe errors, invalid configuration, and upstream contract validation. A real PostgreSQL check applies migrations twice and verifies readiness. Playwright launches the built Electron application and verifies secure preferences and connection states. TypeScript strict, ESLint and production builds are required.

## Next increments

Authentication/RBAC precedes subscriber management. Financial workflows require integer centavos or exact decimal arithmetic, immutable posting history, transactions, and AT-01 through AT-12 acceptance evidence. Physical three-PC validation and a release installer remain later deliverables.
