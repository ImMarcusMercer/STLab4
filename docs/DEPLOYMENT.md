# Deployment guide

## Windows installer

The project is packaged for Windows using electron-builder with the NSIS target.

### Building the installer

From the project root:

```powershell
npm.cmd run build
npx electron-builder --win
```

The installer is generated in `release/`:
- `BCIS Billing Setup 0.1.0.exe` - NSIS installer (one-click disabled, allows changing installation directory)
- `win-unpacked/` - unpacked application (for testing without installing)

The current package.json includes `package:win` which builds and creates the unpacked package. Use the full electron-builder command above to generate the complete NSIS installer.

### Installer configuration

Configured in `electron-builder.yml`:
- App ID: `ph.bcis.billing`
- Product name: `BCIS Billing`
- NSIS: one-click disabled, installation directory change allowed
- Output directory: `release/`

## LAN deployment

### Requirements

- Windows machines on the same LAN
- PostgreSQL installed and accessible on the network (or on a dedicated database server)
- Network connectivity between API server and desktop clients
- `pg_dump` and `pg_restore` available on PATH for backup operations

### Architecture

The system follows a client-server model:
- Fastify API server (runs on loopback by default in development)
- Electron desktop clients communicate with the API
- PostgreSQL database accessed only by the API server

### Production deployment steps

1. **Database server setup** (if separate from API server):
   - Install PostgreSQL on the database machine
   - Configure PostgreSQL to accept connections from LAN IPs (update `postgresql.conf` and `pg_hba.conf`)
   - Create the BCIS database and user with appropriate permissions
   - Restrict credentials - use service accounts, never use superuser for application access

2. **API server deployment**:
   - Install Node.js 22+ on the server machine
   - Deploy the built application or source
   - Configure environment variables (`.env`):
     - `DATABASE_URL` - PostgreSQL connection string to the database server
     - `HOST` - Bind address (use `0.0.0.0` to allow LAN access, or the server's LAN IP)
     - `PORT` - API port (default `3100`)
     - `LOG_LEVEL` - Set to `info` for production
   - Start the API server (`npm run start:api`)
   - Ensure firewall allows connections on the API port
   - Set up the database: run migrations (`npm run db:migrate`) and seed initial data as needed

3. **Desktop client deployment**:
   - Install the generated NSIS installer on each client machine
   - Configure `BCIS_API_URL` environment variable or set in the application's configuration to point to the API server's LAN address (e.g., `http://192.168.1.10:3100`)
   - Launch the application

### Security notes

- Keep API bound to loopback until transport security (TLS/HTTPS) and deployment hardening are fully implemented
- Use strong passwords for database and application accounts
- Restrict network access with firewalls
- Regular backups using the built-in backup functionality (requires `pg_dump`/`pg_restore` on PATH)
- Backups include database dumps and payment proof files with integrity verification

### Backup considerations

- The API requires `pg_dump` and `pg_restore` in PATH for backup/restore operations
- Backup files are stored in the configured backup directory
- FULL backups include payment proofs with SHA-256 digest verification
- Restore operations require explicit confirmation (`RESTORE`) and a reason
- Backups are recorded in `backup_history` with integrity checks

### Limitations

- A single billing cycle is capped at PHP 9,999,999.99 (about 10,000 subscribers at PHP 999/month)
- Performance tested to 20,000 subscribers with acceptable response times on read paths
- The running application does not depend on the `electron-builder` packaging chain vulnerabilities (they are build-time only)
- LAN deployment without TLS is suitable for trusted internal networks only; additional hardening required for untrusted networks
