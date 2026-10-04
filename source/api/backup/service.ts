import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { AuthService } from '../auth/service';
import { ApiError } from '../auth/errors';
import { migrateDatabase } from '../../../database/migrate';
import {
  BackupRecordSchema, BackupVerificationSchema, CreateBackupInputSchema, RestoreBackupInputSchema,
  RestoreReportSchema, RowCountsSchema, countedTables, type CreateBackupInput, type RowCounts,
} from '../../shared/backups';
import { attachmentBackupDirectory, digestFile, dumpPath, ensureBackupDirectory, newBackupName } from './paths';

export {
  BackupRecordSchema, BackupVerificationSchema, RestoreReportSchema, countedTables,
} from '../../shared/backups';
export type { RowCounts, CreateBackupInput } from '../../shared/backups';

const toolName = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);

export class BackupToolError extends Error {
  constructor(readonly tool: string, readonly detail: string) { super(`${tool} failed: ${detail}`); }
}

export type ToolRunner = (tool: 'pg_dump' | 'pg_restore', args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string; stderr: string }>;

/**
 * Runs a PostgreSQL client tool.
 *
 * The connection string travels in `PG*` environment variables rather than as an argument.
 * Arguments appear in the process list, which on a shared office machine another logged-in user
 * could read, and a crash report can quote them. Nothing here logs the value.
 */
export const runTool: ToolRunner = (tool, args, env) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(toolName(tool), args, { windowsHide: true, env: { ...process.env, ...env } });
  let stdout = ''; let stderr = '';
  // Bounded: the dump goes to a file, so only the tool's own reporting needs to be kept, and an
  // unbounded buffer would let a misdirected invocation exhaust the API host's memory.
  const limit = 4 * 1024 * 1024;
  child.stdout.on('data', (chunk: Buffer) => { if (stdout.length < limit) stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < limit) stderr += chunk.toString(); });
  child.on('error', (error) => rejectRun(new BackupToolError(tool, (error as Error).message)));
  child.on('close', (code) => {
    if (code === 0) resolveRun({ stdout, stderr });
    // The tool's own words are kept verbatim in the failure record, since "permission denied"
    // and "no such file" need different responses from an operator.
    else rejectRun(new BackupToolError(tool, stderr.trim() || stdout.trim() || `exit code ${code}`));
  });
});

/** Splits a connection string into the variables the tools read, keeping the password out of arguments. */
export function toolEnvironment(connectionString: string): NodeJS.ProcessEnv {
  const url = new URL(connectionString);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: url.pathname.replace(/^\//, ''),
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
  };
}

/**
 * The database name, which the tools do need as an argument.
 *
 * Unlike the password this is not a secret, and `pg_restore` refuses to run without an explicit
 * target even when PGDATABASE is set. Naming the database on the command line also makes the
 * connection string the only place a host and a password are configured.
 */
export function toolDatabase(connectionString: string): string {
  return new URL(connectionString).pathname.replace(/^\//, '');
}

/**
 * The connection string the pool is actually using.
 *
 * Read from the pool rather than from the environment, because a backup taken from one database
 * and restored into another is the one mistake this feature exists to prevent, and two places
 * configured separately is how that mistake gets made. Returns nothing when the pool was built
 * from discrete options instead of a URL.
 */
export function poolConnectionString(pool: pg.Pool): string | undefined {
  const options = pool.options as { connectionString?: string } | undefined;
  return options?.connectionString;
}

async function countRows(client: pg.Pool | pg.PoolClient): Promise<RowCounts> {
  const counts: Partial<RowCounts> = {};
  for (const table of countedTables) {
    // The table name comes from the frozen list in the shared contract, never from a caller, so
    // this is a fixed set of identifiers rather than an interpolated query.
    const result = await client.query(`SELECT count(*)::int AS n FROM "${table}"`);
    counts[table] = result.rows[0]?.n ?? 0;
  }
  return RowCountsSchema.parse(counts);
}

export interface BackupEnvironment {
  /**
   * Used by the tools only. Never logged and never returned in a response. Prefer the pool's own
   * connection string; this exists for the tests, which point at their own scratch database.
   */
  connectionString?: string;
  /** Where the payment proofs live, so a FULL backup can carry them. */
  proofDirectory: string;
  /** Replaced in tests so the flow is exercised without a live cluster. */
  run?: ToolRunner;
  /** Replaced in tests so the post-restore migration is not a side effect. */
  migrate?: (connectionString: string) => Promise<void>;
}

const recordColumns = `id,kind,file_name AS "fileName",byte_size AS "byteSize",sha256,
  row_counts AS "rowCounts",attachment_count AS "attachmentCount",attachment_bytes AS "attachmentBytes",
  note,status,failure_reason AS "failureReason",created_by AS "createdBy",created_at AS "createdAt",
  verified_at AS "verifiedAt",restored_at AS "restoredAt",restored_by AS "restoredBy"`;

export class BackupService {
  constructor(readonly pool: pg.Pool, readonly auth: AuthService, readonly environment: BackupEnvironment) {}

  #run(): ToolRunner { return this.environment.run ?? runTool; }

  /**
   * The connection the dump tools are pointed at.
   *
   * Refuses rather than guessing: a backup run against the wrong database would look identical to
   * a correct one until the day somebody needed it.
   */
  #connectionString(): string {
    const connectionString = this.environment.connectionString ?? poolConnectionString(this.pool);
    if (!connectionString) throw new Error('The backup tools need the pool connection string; none was configured.');
    return connectionString;
  }

  #env(): NodeJS.ProcessEnv { return toolEnvironment(this.#connectionString()); }

  /**
   * The `--dbname` argument.
   *
   * A database name is not a secret, and `pg_restore` will not run at all without an explicit
   * target even when PGDATABASE is set, so the name goes on the command line while the password
   * stays in the environment where the process list cannot show it.
   */
  #dbname(): string { return toolDatabase(this.#connectionString()); }

  /** `pg_restore --list`: proves the archive can be read without writing anything. */
  #list(target: string) {
    return this.#run()('pg_restore', ['--list', target, '--dbname', this.#dbname()], this.#env());
  }

  #migrate() { return this.environment.migrate ?? migrateDatabase; }

  async list(token: string) {
    await this.auth.authorize(token, 'backup.view');
    const result = await this.pool.query(`SELECT ${recordColumns} FROM backup_history ORDER BY created_at DESC LIMIT 100`);
    return result.rows.map((row) => this.#parse(row));
  }

  async get(token: string, id: string) {
    await this.auth.authorize(token, 'backup.view');
    return this.#record(id);
  }

  async #record(id: string) {
    const result = await this.pool.query(`SELECT ${recordColumns} FROM backup_history WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'That backup does not exist.');
    return this.#parse(result.rows[0]);
  }

  #parse(row: Record<string, unknown>) {
    return BackupRecordSchema.parse({
      ...row,
      createdAt: new Date(row.createdAt as string).toISOString(),
      verifiedAt: row.verifiedAt ? new Date(row.verifiedAt as string).toISOString() : null,
      restoredAt: row.restoredAt ? new Date(row.restoredAt as string).toISOString() : null,
    });
  }

  /**
   * Takes a backup and proves it can be read back before reporting success.
   *
   * The order is deliberate. The row is written first as FAILED so a crash still leaves a record,
   * the counts and the archive are taken from one exported snapshot, and the finished archive is
   * then listed with pg_restore. A dump that cannot be listed is not a backup, whatever its size.
   */
  async create(token: string, input: unknown) {
    const actor = await this.auth.authorize(token, 'backup.create');
    const parsed = CreateBackupInputSchema.safeParse(input ?? {});
    if (!parsed.success) throw new ApiError(422, 'VALIDATION', 'Check the backup details.', { kind: ['Choose FULL or DATABASE.'] });
    const fileName = newBackupName();
    const id = await this.#begin(parsed.data, fileName, actor.id);
    // The snapshot transaction stays open across the dump, because PostgreSQL invalidates an
    // exported snapshot the moment its exporting transaction ends. If the dump fails, the finally
    // block releases it, so the connection is never left holding a snapshot open.
    const snapshot = await this.#openSnapshot();
    try {
      await ensureBackupDirectory();
      const target = dumpPath(fileName);
      await this.#run()('pg_dump', ['--format=custom', '--file', target, '--no-owner', '--no-privileges', '--snapshot', snapshot.id], this.#env());
      const { byteSize, sha256 } = await this.#measure(target);
      let attachmentCount = 0;
      let attachmentBytes = 0;
      // Read inside the same snapshot, so the proofs carried are the ones the archive refers to
      // rather than whichever ones happen to have arrived while the dump was running.
      if (parsed.data.kind === 'FULL') ({ attachmentCount, attachmentBytes } = await this.#collectAttachments(fileName, snapshot.client));
      await this.#list(target);
      const verifiedAt = new Date().toISOString();
      await this.#complete(id, { byteSize, sha256, rowCounts: snapshot.counts, attachmentCount, attachmentBytes, verifiedAt });
      await this.pool.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id, 'backup.create', id, JSON.stringify({ kind: parsed.data.kind, byteSize, sha256 })]);
      return this.#record(id);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.#fail(id, reason);
      await this.pool.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id, 'backup.failed', id, JSON.stringify({ reason: reason.slice(0, 400) })]);
      throw new ApiError(500, 'BACKUP_FAILED', 'The backup could not be completed. The failure has been recorded.', undefined);
    } finally {
      await snapshot.close();
    }
  }

  /**
   * Opens one consistent view of the database and holds it open.
   *
   * The row counts a backup records are what a later restore is judged against, so they have to
   * describe the same data the archive contains. Counting in a transaction of its own would not:
   * a cashier posting a payment between the count and the dump would produce a backup whose
   * recorded count never existed in the archive, and the restore would report a difference that
   * was an artefact of how the backup was taken.
   *
   * `pg_export_snapshot` is what makes it exact. The snapshot stays valid only while the
   * exporting transaction is open, which is why `close` must be called, and holding one connection
   * for the length of a dump is the cost of that guarantee.
   */
  async #openSnapshot(): Promise<{ id: string; counts: RowCounts; client: pg.PoolClient; close: () => Promise<void> }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const exported = await client.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot');
      const counts = await countRows(client);
      return {
        id: exported.rows[0]!.snapshot,
        counts,
        client,
        close: async () => {
          await client.query('COMMIT').catch(() => undefined);
          client.release();
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw error;
    }
  }

  async #measure(path: string) {
    const size = await stat(path);
    return { byteSize: size.size, sha256: await digestFile(path) };
  }

  /**
   * Copies the proofs belonging to this backup.
   *
   * Only names matching the pattern the payment reader accepts are copied, so a file cannot be
   * drawn in from outside the proof directory, and each is checked against the SHA-256 recorded
   * when it was uploaded. A proof that no longer matches is reported as a failure: a backup
   * carrying a corrupt attachment and claiming to be complete is more dangerous than one that
   * says what is wrong.
   */
  async #collectAttachments(fileName: string, reader: pg.Pool | pg.PoolClient): Promise<{ attachmentCount: number; attachmentBytes: number }> {
    const source = this.environment.proofDirectory;
    const target = attachmentBackupDirectory(fileName);
    let names: string[];
    try { names = await readdir(source); } catch { return { attachmentCount: 0, attachmentBytes: 0 }; }
    const stored = await reader.query<{ stored_name: string; sha256: string }>('SELECT stored_name,sha256 FROM payment_proofs ORDER BY stored_name');
    const proofs = new Map(stored.rows.map((row) => [row.stored_name, row.sha256]));
    await mkdir(target, { recursive: true });
    let bytes = 0;
    let count = 0;
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.(png|jpg|pdf)$/.test(name)) continue;
      const expected = proofs.get(name);
      // A file with no payment_proofs row is not a receipt the database knows about, so it is left
      // out rather than carried as an unexplained extra.
      if (!expected) continue;
      const contents = await readFile(join(source, name));
      if (createHash('sha256').update(contents).digest('hex') !== expected) {
        await rm(target, { recursive: true, force: true });
        throw new Error(`A stored payment proof no longer matches its recorded digest, so the backup was abandoned.`);
      }
      await writeFile(join(target, name), contents, { flag: 'wx' });
      bytes += contents.length;
      count += 1;
    }
    return { attachmentCount: count, attachmentBytes: bytes };
  }

  /**
   * Re-checks a stored backup without restoring it.
   *
   * Worth doing on a schedule, because a backup nobody has read back is a claim rather than
   * evidence. The digest answers "are these still the same bytes"; the listing answers "is this
   * still a readable archive". Neither one restores, so this is safe to run at any time.
   */
  async verify(token: string, id: string) {
    // Read-only, so an auditor may run it: proving a backup still restores is an audit function.
    const actor = await this.auth.authorize(token, 'backup.verify');
    const record = await this.#record(id);
    if (record.status !== 'COMPLETED') throw new ApiError(409, 'CONFLICT', 'That backup did not complete, so there is nothing to verify.');
    const target = dumpPath(record.fileName);
    const { sha256 } = await this.#measure(target);
    const digestMatched = sha256 === record.sha256;
    let readable = true;
    try { await this.#list(target); } catch { readable = false; }
    const checkedAt = new Date().toISOString();
    await this.pool.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id, 'backup.verify', id, JSON.stringify({ digestMatched, readable })]);
    return BackupVerificationSchema.parse({ fileName: record.fileName, digestMatched, readable, checkedAt });
  }

  /**
   * Restores a backup over the live database.
   *
   * The digest is checked before anything is written, because a restore that starts and then
   * fails leaves a database that is neither the old data nor the new. Other sessions are ended
   * first so none is holding a table the restore is replacing, the restore itself runs as one
   * transaction so a partial restore rolls back, and the migrations are applied afterwards so a
   * backup taken before a migration is not left on an old schema.
   *
   * The verification that matters is the row counts. A restore that reported success while the
   * subscriber count had changed is not a restore, so any difference is returned by name rather
   * than summarised away.
   */
  async restore(token: string, id: string, input: unknown) {
    const actor = await this.auth.authorize(token, 'backup.restore');
    const parsed = RestoreBackupInputSchema.safeParse(input ?? {});
    if (!parsed.success) throw new ApiError(422, 'VALIDATION', 'Type RESTORE and give a reason before restoring.', { confirm: ['Type RESTORE to confirm.'], reason: ['Give a reason of at least three characters.'] });
    const record = await this.#record(id);
    if (record.status !== 'COMPLETED') throw new ApiError(409, 'CONFLICT', 'That backup did not complete, so it cannot be restored.');
    const target = dumpPath(record.fileName);
    const { sha256 } = await this.#measure(target);
    if (sha256 !== record.sha256) {
      // Refused before anything is written: overwriting a good database with a damaged file is
      // the one outcome a restore must never produce.
      throw new ApiError(422, 'DIGEST_MISMATCH', 'This backup file does not match its recorded digest. Nothing has been restored; treat the file as damaged.');
    }
    try { await this.#list(target); }
    catch { throw new ApiError(422, 'UNREADABLE_BACKUP', 'This backup file cannot be read as a PostgreSQL archive. Nothing has been restored.'); }

    // Only sessions actually holding an open transaction can block the restore, because only those
    // hold locks on the tables being replaced. Killing every other session would also fail the
    // requests of the other two office clients, which is not the API's business during a restore.
    await this.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname=current_database() AND pid<>pg_backend_pid() AND xact_start IS NOT NULL`,
    ).catch(() => undefined);
    try {
      await this.#run()('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--dbname', this.#dbname(), target], this.#env());
    } catch (error) {
      const detail = error instanceof BackupToolError ? error.detail : String(error);
      await this.pool.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id, 'backup.restore.failed', id, JSON.stringify({ reason: parsed.data.reason, detail: detail.slice(0, 400) })]);
      throw new ApiError(500, 'RESTORE_FAILED', 'The restore did not complete. The database is unchanged because the restore runs as a single transaction.');
    }
    await this.#migrate()(this.#connectionString());

    const actual = await countRows(this.pool);
    const differences = countedTables
      .filter((table) => record.rowCounts[table] !== actual[table])
      .map((table) => ({ table, expected: record.rowCounts[table], actual: actual[table] }));
    const attachmentsRestored = record.kind === 'FULL' ? await this.#restoreAttachments(record.fileName) : 0;
    const restoredAt = new Date().toISOString();
    // The archive contains this backup's own row as it stood mid-flight, because the row is
    // written before the dump so a crash still leaves a record. Restoring therefore rewinds the
    // record to "Backup in progress", and it is put back to COMPLETED here: the file was read
    // back and its counts checked, which is exactly what COMPLETED asserts.
    await this.pool.query(`UPDATE backup_history SET status='COMPLETED',failure_reason='',restored_at=$2,restored_by=$3 WHERE id=$1`, [id, restoredAt, actor.id]);
    const rowCountsMatched = differences.length === 0;
    await this.pool.query('INSERT INTO audit_logs(actor_id,action,subject_id,details) VALUES($1,$2,$3,$4)', [actor.id, 'backup.restore', id, JSON.stringify({ reason: parsed.data.reason, rowCountsMatched, differences, attachmentsRestored })]);
    return RestoreReportSchema.parse({ fileName: record.fileName, verified: rowCountsMatched, digestMatched: true, rowCountsMatched, differences, attachmentsRestored, restoredAt });
  }

  /**
   * Puts this backup's proofs back in place.
   *
   * The files are copied back under the names the database already refers to, so no row is
   * rewritten. A file already present is left alone: overwriting it would be pointless and would
   * discard what may be the only good copy of something.
   */
  async #restoreAttachments(fileName: string): Promise<number> {
    const source = attachmentBackupDirectory(fileName);
    const target = this.environment.proofDirectory;
    let names: string[];
    try { names = await readdir(source); } catch { return 0; }
    await mkdir(target, { recursive: true });
    let restored = 0;
    for (const name of names) {
      if (!/^[a-f0-9-]{36}\.(png|jpg|pdf)$/.test(name)) continue;
      const destination = join(target, name);
      const alreadyThere = await stat(destination).then(() => true).catch(() => false);
      if (!alreadyThere) await writeFile(destination, await readFile(join(source, name)), { flag: 'wx' }).catch(() => undefined);
      restored += 1;
    }
    return restored;
  }

  async #begin(input: CreateBackupInput, fileName: string, actorId: string): Promise<string> {
    // Recorded as FAILED first. A backup that dies partway is a fact the operator needs to see,
    // and a history listing only successes would hide a broken backup schedule until a restore
    // was attempted.
    const result = await this.pool.query(
      `INSERT INTO backup_history(kind,file_name,byte_size,sha256,row_counts,attachment_count,attachment_bytes,note,status,failure_reason,created_by)
       VALUES($1,$2,0,$3,'{}'::jsonb,0,0,$4,'FAILED','Backup in progress.',$5) RETURNING id`,
      [input.kind, fileName, '0'.repeat(64), input.note, actorId],
    );
    return result.rows[0]!.id as string;
  }

  async #complete(id: string, entry: { byteSize: number; sha256: string; rowCounts: RowCounts; attachmentCount: number; attachmentBytes: number; verifiedAt: string }) {
    await this.pool.query(
      `UPDATE backup_history SET status='COMPLETED',failure_reason='',byte_size=$2,sha256=$3,row_counts=$4,attachment_count=$5,attachment_bytes=$6,verified_at=$7 WHERE id=$1`,
      [id, entry.byteSize, entry.sha256, JSON.stringify(entry.rowCounts), entry.attachmentCount, entry.attachmentBytes, entry.verifiedAt],
    );
  }

  async #fail(id: string, reason: string) {
    await this.pool.query(`UPDATE backup_history SET failure_reason=$2 WHERE id=$1`, [id, reason.slice(0, 400)]);
  }
}