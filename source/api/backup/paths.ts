import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ApiError } from '../auth/errors';

/**
 * Backups live beside the payment proofs, never inside the project, so the operator can copy one
 * to removable media without reaching into the source tree. The default mirrors the platform
 * convention the proofs already use.
 */
export function backupDirectory(): string {
  const configured = process.env.BCIS_BACKUP_DIR?.trim();
  if (configured) return resolve(configured);
  return process.platform === 'win32'
    ? resolve(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BCIS', 'backups')
    : resolve(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'bcis', 'backups');
}

export function attachmentDirectory(): string {
  const configured = process.env.BCIS_PROOF_DIR?.trim();
  if (configured) return resolve(configured);
  return process.platform === 'win32'
    ? resolve(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BCIS', 'proofs')
    : resolve(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'bcis', 'proofs');
}

/**
 * The directory holding one backup's attachments, named for the dump it belongs to.
 *
 * Keeping each backup's proofs in its own directory is what lets a restore put back the
 * attachments that were current when that backup was taken, instead of the newest ones on disk.
 * A restore that only copied the newest proofs would produce a database referring to files that
 * do not exist, which is a worse outcome than not restoring the attachments at all.
 */
export function attachmentBackupDirectory(fileName: string): string {
  assertBackupName(fileName);
  const directory = backupDirectory();
  const target = resolve(directory, `${fileName}.attachments`);
  if (!target.startsWith(directory + sep)) throw new ApiError(404, 'NOT_FOUND', 'Backup not found.');
  return target;
}

/**
 * The dump path for a name read back out of the database.
 *
 * The name is a generated UUID, but it still comes from stored data, so it is validated rather
 * than joined. Without the check, a row whose `file_name` held `../../../` would let a restore
 * read or overwrite a file outside the backup directory.
 */
export function assertBackupName(fileName: string): string {
  if (!/^[a-f0-9-]{36}\.dump$/.test(fileName)) throw new ApiError(404, 'NOT_FOUND', 'Backup not found.');
  return fileName;
}

export function dumpPath(fileName: string): string {
  const directory = backupDirectory();
  const target = resolve(directory, assertBackupName(fileName));
  // Redundant given the pattern above, but the containment check is the one that would still
  // hold if that pattern were ever widened.
  if (!target.startsWith(directory + sep)) throw new ApiError(404, 'NOT_FOUND', 'Backup not found.');
  return target;
}

export function newBackupName(): string {
  return `${randomUUID()}.dump`;
}

/** The digest is taken over the finished file, so it covers the bytes a restore will read. */
export async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function ensureBackupDirectory(): Promise<string> {
  const directory = backupDirectory();
  await mkdir(directory, { recursive: true });
  return directory;
}