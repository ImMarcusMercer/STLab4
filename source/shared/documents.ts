import { z } from 'zod';
import { PaymentMethod, PaymentStatus } from './payments';
import { formatMoneyCell } from './reports';

/**
 * Phase 8: the two documents a subscriber is actually handed.
 *
 * A report is a query for the office. A receipt and a statement of account are different:
 * they leave the building in someone's hand, so they carry an amount in words, a signature
 * line, a status they cannot be talked out of, and the arithmetic that lets the reader check
 * the document against itself.
 *
 * Both are therefore contracts, not rows. The server decides what is on them and the
 * renderer decides nothing except where the bytes are saved.
 *
 * The rule that shapes this module: **a document states its own total and carries the
 * proof of it.** A receipt whose invoice lines do not add up to what it applied, or whose
 * amount differs from the money actually recorded, is a defect, and `assertReceiptBalanced`
 * refuses to render one rather than printing it.
 */

/** Receipt amounts are signed: a reversal takes money back, and its document says so. */
const signedMoney = z.number().int().max(999999999).min(-999999999);

/**
 * Who the printed document is issued by.
 *
 * One constant, read by the receipt and the statement alike, because two documents from the
 * same office that letterhead differently is the kind of detail that undermines both of
 * them. There is deliberately no street address here: this project holds no real business
 * address to print, and inventing one on an official-looking document would be worse than
 * leaving it to the operator's own stationery.
 */
export const officeIdentity = {
  name: 'BUKIDNON CABLE & INTERNET SERVICES',
  system: 'BCIS Subscription Billing and Collection System',
} as const;

/** One line of the allocation table: which invoice this money settled, and how much of it. */
export const ReceiptLineSchema = z.object({
  invoiceNumber: z.string().nullable(),
  /** The billing period the invoice covers, so the line reads without the invoice open. */
  periodLabel: z.string().max(60),
  amountCentavos: signedMoney,
  /** 'Payment' or 'Advance credit', which is where the money came from. */
  source: z.enum(['PAYMENT', 'ADVANCE']),
  note: z.string().max(120),
});
export type ReceiptLine = z.infer<typeof ReceiptLineSchema>;

export const ReceiptDocumentSchema = z.object({
  documentTitle: z.string().min(1).max(60),
  /** Null while a GCash claim is still waiting for a second person to confirm it. */
  receiptNumber: z.string().nullable(),
  status: PaymentStatus,
  direction: z.enum(['PAYMENT', 'REVERSAL']),
  issuedOn: z.string().min(1).max(20),
  method: PaymentMethod,
  referenceNumber: z.string().nullable(),
  subscriberCode: z.string(),
  subscriberName: z.string(),
  /** The addresses the account is served from, joined for the printed header. */
  serviceAddresses: z.string().max(300),
  /** The plans or service accounts this subscriber holds. */
  servicesSummary: z.string().max(300),
  lines: z.array(ReceiptLineSchema),
  /**
   * The face value of the entry, which is not always what this document settles.
   *
   * A voided entry claimed an amount and received nothing, so it prints `0` as its total
   * while `claimedCentavos` still shows what was claimed and discarded. Without the second
   * figure a void receipt would claim a peso total of zero with nothing on the paper saying
   * why, which reads as a lost receipt rather than a deliberately voided one.
   */
  claimedCentavos: signedMoney,
  /** What was handed over. Negative on a reversal, zero on a void. */
  amountCentavos: signedMoney,
  /** How much of it settled an invoice. Negative on a reversal. */
  appliedCentavos: signedMoney,
  /** Held for the subscriber against a later bill. Negative on a reversal. */
  advanceCentavos: signedMoney,
  /** The same amount in words, because that is what makes a receipt checkable by hand. */
  amountInWords: z.string().min(1).max(200),
  receivedByName: z.string(),
  verifiedByName: z.string().nullable(),
  /** The route sheet this money was collected on, when it was collected on one. */
  collectionBatchNumber: z.string().nullable(),
  reversalOfReceipt: z.string().nullable(),
  /** Why it was voided or reversed, or the note left when it was recorded. */
  reason: z.string().max(500),
  generatedAt: z.string(),
  generatedBy: z.string(),
  /** What this receipt is, in words, on the paper itself. */
  footnote: z.string().max(400),
});
export type ReceiptDocument = z.infer<typeof ReceiptDocumentSchema>;

/**
 * The receipt's own arithmetic.
 *
 * Three equalities have to hold, and each is a different mistake:
 *
 * - the lines add up to what was applied, so the document says what it paid against;
 * - applied plus advance equals the amount handed over, so no peso appears or vanishes
 *   between the customer's hand and the ledger;
 * - the words and the figures describe the same amount.
 *
 * A reversal inverts the sign of all three, which is why the sums are compared as signed
 * figures rather than absolutes: taking a receipt's amounts at face value would make a
 * perfectly correct reversal look unbalanced.
 */export function assertReceiptBalanced(receipt: ReceiptDocument): ReceiptDocument {
  const summed = receipt.lines.reduce((total, line) => total + line.amountCentavos, 0);
  const appliedPlusAdvance = receipt.appliedCentavos + receipt.advanceCentavos;
  if (summed !== receipt.appliedCentavos) {
    throw new Error(`Receipt ${receipt.receiptNumber ?? receipt.status}: its lines total ${summed} but it claims to have applied ${receipt.appliedCentavos}.`);
  }
  if (appliedPlusAdvance !== receipt.amountCentavos) {
    throw new Error(`Receipt ${receipt.receiptNumber ?? receipt.status}: applied ${receipt.appliedCentavos} plus advance ${receipt.advanceCentavos} is not the ${receipt.amountCentavos} received.`);
  }
  if (receipt.amountInWords !== wordsFor(receipt.amountCentavos)) {
    throw new Error(`Receipt ${receipt.receiptNumber ?? receipt.status}: the written amount does not describe ${formatMoneyCell(receipt.amountCentavos)}.`);
  }
  return receipt;
}

/** The word form of a peso amount, for the line a subscriber reads and the cashier checks. */
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
] as const;
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'] as const;
const SCALES = ['', 'Thousand', 'Million', 'Billion', 'Trillion'] as const;

/** English number words for 0-999. The building block for every larger figure. */
function underThousand(value: number): string {
  if (value === 0) return '';
  const parts: string[] = [];
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest >= 20) parts.push(`${TENS[Math.floor(rest / 10)]} ${ONES[rest % 10]}`.trim());
  else if (rest > 0) parts.push(ONES[rest]!);
  return parts.join(' ');
}

/**
 * The whole-number part, in English, grouped so the largest group comes first. Groups of
 * zero are skipped rather than printed as "Zero Thousand", and the result is trimmed, so
 * 1,000,001 is "One Million One" and not "One Million Zero Thousand One".
 */
function wholeWords(value: number): string {
  if (value === 0) return 'Zero';
  const groups: string[] = [];
  let remaining = value;
  for (let scale = 0; remaining > 0; scale += 1, remaining = Math.floor(remaining / 1000)) {
    const group = underThousand(remaining % 1000);
    if (group !== '') groups.push(`${group}${SCALES[scale] ? ` ${SCALES[scale]}` : ''}`);
  }
  return groups.reverse().join(' ');
}

/**
 * The amount in words, as a receipt states it: the pesos, then the centavos, or "Only" when
 * the peso amount is whole.
 *
 * The centavos run through the same `underThousand` builder as the pesos, so 45 is "Forty
 * Five" and not "Forty Zero Five", and negative amounts keep their sign: a reversal receipt
 * has to say it is taking money back rather than quietly printing a positive figure.
 */
export function wordsFor(centavos: number): string {
  if (!Number.isInteger(centavos)) throw new TypeError('An amount in words must be whole-number centavos.');
  const sign = centavos < 0 ? 'Minus ' : '';
  const absolute = Math.abs(centavos);
  const pesoCount = Math.floor(absolute / 100);
  const pesos = wholeWords(pesoCount);
  const remainder = absolute % 100;
  // "One Peso Only", not "One Pesos Only": a receipt is read by a person, and the grammar is
  // the cheapest thing on the page to get right.
  if (remainder === 0) return `${sign}${pesos} ${pesoCount === 1 ? 'Peso' : 'Pesos'} Only`;
  return `${sign}${pesos} Pesos and ${underThousand(remainder)} Centavo${remainder === 1 ? '' : 's'}`;
}

/**
 * A file name that identifies one receipt or statement and cannot escape a directory.
 *
 * The receipt number comes from the server's own gap-free sequence and the subscriber code
 * from a validated column, but neither is trusted with a path: everything outside `[0-9A-Z-]`
 * is dropped, so a code carrying a separator produces a shorter name rather than a new folder.
 */
export function documentFileName(kind: 'receipt' | 'statement', parts: (string | null)[]): string {
  const kept = parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/[^0-9A-Za-z-]+/g, '').slice(0, 40))
    .filter((part) => part !== '');
  return `BCIS-${kind}${kept.length > 0 ? `-${kept.join('-')}` : ''}.pdf`;
}
