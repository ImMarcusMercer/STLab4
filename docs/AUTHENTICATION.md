# Phase 2 design and execution plan

## Outcome

Only authenticated users enter the BCIS workspace. The central API enforces granular permissions on protected operations. Owner accounts can create accounts, assign roles and deactivate accounts. Other roles cannot bypass restrictions by calling the API directly. Subscriber and financial modules remain pending.

## Decisions

- Add users, roles, permissions and their join tables through a new migration. Add hashed opaque sessions and append-only security audit events alongside them.
- Passwords use Node scrypt with random salts and N=131072, r=8, p=1. Server responses never contain hashes. API login failures are generic and rate limited.
- Generate a 256-bit random session token on login; persist only its SHA-256 digest. Sessions expire after eight hours and users/permissions are rechecked against PostgreSQL for each request.
- Electron main keeps the token only in memory. Named preload methods expose user data/results, never bearer tokens or general HTTP/IPC access.
- Lock and logout both revoke the server session. Lock retains only the display identity on the local screen so the same user can reauthenticate. Network errors still clear the local token and disclose that remote revocation could not be confirmed.
- A safe local seed generates an initial owner password in ignored `.env`; repeat seeding never resets an existing account's password or roles. No sample credentials are committed or printed.
- Role matrix follows the PDF: Owner, Administrator, Cashier, Collection Supervisor, Auditor, Technician and Viewer. Owner alone manages users and backup settings. Administrator handles operational resources. Cashier receives payments but cannot reverse them or manage users.
- Last-active-owner protection and session revocation accompany account/role changes. User management writes and their audit rows share one transaction.

## Implementation steps

- [x] Write password and real-PostgreSQL authentication/authorization tests, observe missing behavior, then implement schema, security helpers and services.
- [x] Add routes for login/me/logout/lock and permission-guarded user list/create/update. Validate all payloads and paginate users; verify anonymous 401, cashier 403 and owner success (AT-10).
- [x] Seed role permissions and initial owner idempotently. Verify no password/token leakage, inactive accounts, expired/revoked sessions, role updates and last-owner protection.
- [x] Add named desktop auth/user methods and login/lock/account screens; show navigation only for current permissions.
- [x] Run unit, real-DB API and Electron E2E tests plus typecheck/lint/build. Capture login/admin screenshots and update TASK.md and evidence.

## Review focus

Token/hashes must never reach renderer storage; roles sent by clients must not grant access; locked/revoked/expired sessions must be rejected; deactivated accounts lose existing sessions; two concurrent administrator changes cannot remove every active owner; repeated seeds must not reset account changes.

## Test isolation

Integration tests create a uniquely named disposable PostgreSQL database on the dedicated local cluster. They apply real migrations and remove only that generated database on completion. They never truncate development or student tables. Tests must not print local `.env` credentials.
