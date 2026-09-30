import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { proofByteLimit, proofExtension, proofMimeValues, type PaymentProof } from '../../shared/payments';
import { ApiError } from '../auth/errors';

/** The bytes each accepted type must start with, so a renamed executable is never stored. */
const signatures: Record<string, string[]> = {
  'image/png': ['89504e470d0a1a0a'],
  'image/jpeg': ['ffd8ff'],
  'application/pdf': ['25504446'],
};

const rejected = (message: string) => new ApiError(422, 'VALIDATION', message, { proof: [message] });

/**
 * Proofs live beside the data, never inside the project, so a backup of the profile and
 * the database covers a payment and its attachment together.
 */
export function proofDirectory(): string {
  const configured = process.env.BCIS_PROOF_DIR?.trim();
  if (configured) return resolve(configured);
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BCIS', 'proofs')
    : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'bcis', 'proofs');
}

/** Only a generated name is ever read, and a path may not leave the proof directory. */
function proofPath(storedName: string) {
  if (!/^[a-f0-9-]{36}\.(png|jpg|pdf)$/.test(storedName)) throw new ApiError(404, 'NOT_FOUND', 'Proof not found.');
  const directory = proofDirectory();
  const target = resolve(directory, storedName);
  if (target !== directory && !target.startsWith(directory + sep)) throw new ApiError(404, 'NOT_FOUND', 'Proof not found.');
  return target;
}

/**
 * Stores an uploaded receipt. The declared type must match the bytes, the size is capped
 * before anything is written, the name on disk is generated, and the digest is recorded
 * so a restored backup can be checked. The file is removed again when the caller cannot
 * finish its transaction, which keeps a failed payment from leaving an orphan behind.
 */
export async function storeProof(file: { fileName: string; mimeType: string; base64: string }): Promise<PaymentProof & { storedPath: string }> {
  const mimeType = file.mimeType as (typeof proofMimeValues)[number];
  if (!proofMimeValues.includes(mimeType)) throw rejected('Attach a PNG, JPEG or PDF receipt.');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(file.base64) || file.base64.length % 4 !== 0) throw rejected('The attachment is not readable as base64 content.');
  const bytes = Buffer.from(file.base64, 'base64');
  // Re-encoding catches content that the decoder silently dropped.
  if (bytes.toString('base64').replace(/=+$/, '') !== file.base64.replace(/=+$/, '')) throw rejected('The attachment is not readable as base64 content.');
  if (bytes.length < 1) throw rejected('The attachment is empty.');
  if (bytes.length > proofByteLimit) throw rejected('The attachment is larger than 5 MB.');
  const expected = signatures[mimeType] ?? [];
  if (!expected.some(signature => bytes.subarray(0, signature.length / 2).toString('hex') === signature)) {
    throw rejected('The attachment does not look like the file type it claims.');
  }
  const storedName = `${randomUUID()}${proofExtension(mimeType)}`;
  await mkdir(proofDirectory(), { recursive: true });
  await writeFile(proofPath(storedName), bytes, { flag: 'wx' });
  return {
    id: '', storedName, storedPath: proofPath(storedName), originalName: file.fileName.slice(0, 180), mimeType,
    byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), uploadedAt: new Date().toISOString(),
  };
}

export async function readProof(storedName: string) {
  try {
    return await readFile(proofPath(storedName));
  } catch {
    throw new ApiError(404, 'NOT_FOUND', 'The stored proof is missing. Report this to an administrator.');
  }
}

export async function removeProof(storedName: string) {
  try {
    await unlink(proofPath(storedName));
  } catch {
    // A proof that was never written needs no cleanup.
  }
}
