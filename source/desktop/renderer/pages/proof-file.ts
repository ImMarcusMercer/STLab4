import { proofByteLimit, proofMimeValues } from '../../../shared/payments';

export type ProofDraft = { fileName: string; mimeType: (typeof proofMimeValues)[number]; byteSize: number; base64: string };

/**
 * Reads an attached receipt into the exact shape the shared contract accepts, or explains
 * why it cannot. The renderer never decides a money rule, so this only checks the size and
 * the type the server would refuse anyway and hands back the bytes as base64.
 */
export async function readProofFile(file: File): Promise<{ ok: true; proof: ProofDraft } | { ok: false; message: string }> {
  if (file.size > proofByteLimit) return { ok: false, message: 'The receipt is larger than 5 MB. Attach a smaller image or PDF.' };
  const mimeType = file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'application/pdf' ? file.type : null;
  if (!mimeType) return { ok: false, message: 'Only a PNG, JPEG or PDF receipt can be attached.' };
  const base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  }).catch(() => '');
  if (!base64) return { ok: false, message: 'The receipt could not be read from disk.' };
  return { ok: true, proof: { fileName: file.name, mimeType, byteSize: file.size, base64 } };
}
