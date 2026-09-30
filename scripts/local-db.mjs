import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'dotenv';
import pg from 'pg';
import { localDatabaseUrl } from './local-database-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(root, '.local');
const data = join(local, 'postgres');
const envPath = join(root, '.env');
const command = process.argv[2];
const bin = process.env.PG_BIN ?? (process.platform === 'win32' ? 'C:/Program Files/PostgreSQL/17/bin' : '');

function run(name, args, quiet = false) {
  const executable = bin ? join(bin, `${name}${process.platform === 'win32' ? '.exe' : ''}`) : name;
  const result = spawnSync(executable, args, { windowsHide: true, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.error) throw new Error(`Cannot run ${name}. Install PostgreSQL or set PG_BIN.`);
  if (!quiet && result.status !== 0) throw new Error(`${name} failed; see the output above.`);
  return result.status;
}

try {
  if (!['setup', 'start', 'stop'].includes(command)) throw new Error('Use setup, start or stop.');
  if (command === 'stop') {
    if (existsSync(data) && run('pg_ctl', ['-D', data, 'status'], true) === 0) {
      run('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']);
    }
    console.log('BCIS local PostgreSQL is stopped.');
  } else {
    mkdirSync(local, { recursive: true });
    if (!existsSync(envPath)) {
      if (command !== 'setup') throw new Error('Run npm run db:setup first.');
      if (existsSync(join(data, 'PG_VERSION'))) throw new Error('Existing cluster found without .env. Restore its original configuration before proceeding.');
      const password = randomBytes(24).toString('hex');
      writeFileSync(envPath, `HOST=127.0.0.1\nPORT=3100\nLOG_LEVEL=info\nDATABASE_URL=postgresql://bcis_local:${password}@127.0.0.1:55432/bcis\nBCIS_API_URL=http://127.0.0.1:3100\n`, { mode: 0o600, flag: 'wx' });
    }
    const config = parse(readFileSync(envPath));
    const url = localDatabaseUrl(config.DATABASE_URL ?? '');
    if (!existsSync(join(data, 'PG_VERSION'))) {
      if (command !== 'setup') throw new Error('Run npm run db:setup first.');
      const passwordFile = join(local, 'init-password');
      writeFileSync(passwordFile, decodeURIComponent(url.password), { mode: 0o600, flag: 'wx' });
      try {
        run('initdb', ['-D', data, '-U', 'bcis_local', '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C', `--pwfile=${passwordFile}`]);
      } finally { unlinkSync(passwordFile); }
    }
    if (run('pg_ctl', ['-D', data, 'status'], true) !== 0) {
      run('pg_ctl', ['-D', data, '-l', join(local, 'postgres.log'), '-o', '-h 127.0.0.1 -p 55432', '-w', 'start']);
    }
    const adminUrl = new URL(url);
    adminUrl.pathname = '/postgres';
    const client = new pg.Client({ connectionString: adminUrl.href, connectionTimeoutMillis: 3_000 });
    try {
      await client.connect();
      const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', ['bcis']);
      if (!exists.rowCount) await client.query('CREATE DATABASE bcis');
    } finally { await client.end(); }
    console.log('BCIS local PostgreSQL is ready on 127.0.0.1:55432. Run npm run db:migrate.');
  }
} catch (error) {
  // PostgreSQL errors may contain connection details; only our own safe diagnostics are shown.
  console.error(error instanceof Error && !('code' in error) ? error.message : 'Database setup failed. Check .local/postgres.log and local configuration.');
  process.exitCode = 1;
}
