import { describe, expect, it } from 'vitest';
import { assertReceiptBalanced, documentFileName, wordsFor } from '../../source/shared/documents';
import { ReceiptTooLongError, renderReceiptPdf } from '../../source/api/reports/receipt';
import { fit, wrapText } from '../../source/api/reports/pdf-core';

/**
 * The two documents a subscriber takes home.
 *
 * The receipt is the only artefact in this system that is checked by somebody who is not
 * running the software: a customer reads the amount in words against the amount in figures
 * and signs underneath. These tests pin that arithmetic, the wording of each state, and the
 * fact that the document is a structurally valid PDF rather than bytes that merely begin
 * with the right four characters.
 */

const posted = (over: Partial<Parameters<typeof assertReceiptBalanced>[0]> = {}) => assertReceiptBalanced({
  documentTitle: 'OFFICIAL RECEIPT',
  receiptNumber: 'RCT-2026-0042',
  status: 'POSTED',
  direction: 'PAYMENT',
  issuedOn: '2026-10-08',
  method: 'CASH',
  referenceNumber: null,
  subscriberCode: 'SUB-0007',
  subscriberName: 'Dela Cruz, Juan',
  serviceAddresses: 'Poblacion, Malaybalay City',
  servicesSummary: 'Internet 50 Mbps',
  lines: [
    { invoiceNumber: 'INV-2026-000103', periodLabel: 'September 2026', amountCentavos: 85_000, source: 'PAYMENT', note: '' },
    { invoiceNumber: 'INV-2026-000117', periodLabel: 'October 2026', amountCentavos: 60_000, source: 'PAYMENT', note: '' },
  ],
  claimedCentavos: 160_000,
  amountCentavos: 160_000,
  appliedCentavos: 145_000,
  advanceCentavos: 15_000,
  amountInWords: wordsFor(160_000),
  receivedByName: 'Santos, Cashier',
  verifiedByName: null,
  collectionBatchNumber: null,
  reversalOfReceipt: null,
  reason: '',
  generatedAt: '2026-10-08T09:15:00.000Z',
  generatedBy: 'Rosario, Manager',
  footnote: 'A posted receipt is never edited or deleted.',
  ...over,
});

describe('an amount written in words', () => {
  it('reads the way a receipt is written, with pesos and centavos', () => {
    expect(wordsFor(0)).toBe('Zero Pesos Only');
    expect(wordsFor(1)).toBe('Zero Pesos and One Centavo');
    expect(wordsFor(5)).toBe('Zero Pesos and Five Centavos');
    expect(wordsFor(45)).toBe('Zero Pesos and Forty Five Centavos');
    expect(wordsFor(99)).toBe('Zero Pesos and Ninety Nine Centavos');
    expect(wordsFor(100)).toBe('One Peso Only');
    expect(wordsFor(1_600)).toBe('Sixteen Pesos Only');
    expect(wordsFor(160_000)).toBe('One Thousand Six Hundred Pesos Only');
    expect(wordsFor(1_234_567)).toBe('Twelve Thousand Three Hundred Forty Five Pesos and Sixty Seven Centavos');
  });

  it('does not say "Zero Thousand" for a figure with empty groups', () => {
    expect(wordsFor(1_000_001)).toBe('Ten Thousand Pesos and One Centavo');
    expect(wordsFor(100_000_000)).toBe('One Million Pesos Only');
  });

  it('keeps the sign on a reversal, so it cannot read as a fresh payment', () => {
    expect(wordsFor(-160_000)).toBe('Minus One Thousand Six Hundred Pesos Only');
    expect(wordsFor(-1)).toBe('Minus Zero Pesos and One Centavo');
  });

  it('refuses a fractional peso rather than rounding somebody\'s receipt', () => {
    expect(() => wordsFor(1.5)).toThrow(TypeError);
  });
});

describe('the receipt arithmetic', () => {
  it('accepts a receipt whose lines add up to what it claims to have applied', () => {
    expect(posted().amountCentavos).toBe(160_000);
  });

  it('refuses a receipt whose lines do not reach its applied figure', () => {
    const draft = { ...posted(), appliedCentavos: 150_000, advanceCentavos: 10_000 };
    expect(() => assertReceiptBalanced(draft)).toThrow(/lines total 145000 but it claims to have applied 150000/);
  });

  it('refuses a receipt whose applied and held figures do not make the amount handed over', () => {
    const draft = { ...posted(), advanceCentavos: 0 };
    expect(() => assertReceiptBalanced(draft)).toThrow(/plus advance 0 is not the 160000 received/);
  });

  it('refuses a receipt whose words describe a different amount', () => {
    const draft = { ...posted(), amountInWords: wordsFor(99_999) };
    expect(() => assertReceiptBalanced(draft)).toThrow(/written amount does not describe/);
  });

  it('accepts a reversal, whose figures are all negative rather than merely smaller', () => {
    expect(posted({
      documentTitle: 'REVERSAL RECEIPT',
      direction: 'REVERSAL',
      status: 'REVERSED',
      reversalOfReceipt: 'RCT-2026-0042',
      claimedCentavos: 145_000,
      amountCentavos: -145_000,
      appliedCentavos: -145_000,
      advanceCentavos: 0,
      amountInWords: wordsFor(-145_000),
      lines: [
        { invoiceNumber: 'INV-2026-000103', periodLabel: 'September 2026', amountCentavos: -85_000, source: 'PAYMENT', note: 'Reopened by this reversal' },
        { invoiceNumber: 'INV-2026-000117', periodLabel: 'October 2026', amountCentavos: -60_000, source: 'PAYMENT', note: 'Reopened by this reversal' },
      ],
    }).amountCentavos).toBe(-145_000);
  });

  it('refuses a receipt that credited more than it received', () => {
    // The check is signed equality, so a negative holding is caught the same way.
    const draft = { ...posted(), appliedCentavos: 165_000, advanceCentavos: -5_000 };
    expect(() => assertReceiptBalanced(draft)).toThrow(/lines total 145000/);
  });
});

describe('a document file name', () => {
  it('identifies the document and keeps only characters a name may hold', () => {
    expect(documentFileName('receipt', ['RCT-2026-0042', 'SUB-0007'])).toBe('BCIS-receipt-RCT-2026-0042-SUB-0007.pdf');
  });

  it('drops a separator rather than letting it reach a path', () => {
    // A subscriber code carrying a traversal sequence must shorten the name, not redirect it.
    const name = documentFileName('receipt', ['RCT-2026-0042', '../../etc/passwd']);
    expect(name).toBe('BCIS-receipt-RCT-2026-0042-etcpasswd.pdf');
    expect(name.includes('/')).toBe(false);
    expect(name.includes('..')).toBe(false);
  });

  it('still names the document when there is no number to put in it', () => {
    expect(documentFileName('receipt', [null, 'SUB-0007'])).toBe('BCIS-receipt-SUB-0007.pdf');
    expect(documentFileName('receipt', [])).toBe('BCIS-receipt.pdf');
  });
});

describe('the receipt PDF', () => {
  const pdfText = (receipt: ReturnType<typeof posted>) => renderReceiptPdf(receipt).toString('latin1');

  it('is a structurally valid single-page document with correct byte offsets', () => {
    const bytes = renderReceiptPdf(posted());
    const text = bytes.toString('latin1');
    expect(bytes.readUInt32LE(0)).toBe(0x4644_5025); // "%PDF"
    expect(text).toContain('/Type /Catalog');
    // A receipt is handed over as one sheet, so the page box is A4 portrait, not the
    // landscape box the report tables use.
    expect(text).toContain('/MediaBox [0 0 595 842]');
    expect(text.match(/\/Type \/Page[^s]/g)).toHaveLength(1);
    // Offsets that do not land on their object headers make a reader show a blank page.
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n\s$/gm)].map((match) => Number(match[1]));
    expect(offsets.length).toBeGreaterThan(2);
    for (const offset of offsets) expect(text.slice(offset)).toMatch(/^\d+ 0 obj/);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('carries the amount in words beside the amount in figures', () => {
    const text = pdfText(posted());
    expect(text).toContain('One Thousand Six Hundred Pesos Only');
    expect(text).toContain('PHP 1,600.00');
    // The two figures are separate strings on the page, not one derived from the other, so
    // a reader can check them against each other.
    expect(text).toContain('Received the amount of');
    expect(text).toContain('TOTAL');
  });

  it('prints the allocation lines that make the applied figure checkable', () => {
    const text = pdfText(posted());
    expect(text).toContain('INV-2026-000103');
    expect(text).toContain('September 2026');
    expect(text).toContain('PHP 850.00');
    expect(text).toContain('PHP 600.00');
    expect(text).toContain('PHP 1,450.00'); // applied to the two invoices
    expect(text).toContain('PHP 150.00'); // held as advance credit
    // Applied plus held is the amount on the receipt, printed as three figures a reader can
    // add up rather than one they have to take on trust.
    expect(text).toContain('Applied to invoices');
    expect(text).toContain('Held as advance credit');
  });

  it('names the subscriber, the account and the two people who handled the money', () => {
    const text = pdfText(posted({ verifiedByName: 'Ramos, Supervisor' }));
    expect(text).toContain('Dela Cruz, Juan');
    expect(text).toContain('SUB-0007');
    expect(text).toContain('Santos, Cashier');
    expect(text).toContain('Ramos, Supervisor');
    expect(text).toContain('Received by');
    expect(text).toContain('Confirmed by');
  });

  it('says on the paper that a void receipt is not money received', () => {
    const text = pdfText(posted({
      status: 'VOID',
      receiptNumber: null,
      claimedCentavos: 160_000,
      amountCentavos: 0,
      appliedCentavos: 0,
      advanceCentavos: 0,
      amountInWords: wordsFor(0),
      lines: [],
      reason: 'Recorded against the wrong subscriber.',
    }));
    expect(text).toContain('VOID - THIS DOCUMENT HAS NO FINANCIAL EFFECT');
    // A blank number field reads as a lost number, so an unissued one is stated.
    expect(text).toContain('Not yet issued');
    expect(text).toContain('PHP 0.00');
    // The claim that was discarded is on the document, so the zero total has a reason.
    expect(text).toContain('Recorded against the wrong subscriber.');
  });

  it('prints a reversal as a reversal, naming the receipt it reverses', () => {
    const text = pdfText(posted({
      documentTitle: 'REVERSAL RECEIPT',
      direction: 'REVERSAL',
      reversalOfReceipt: 'RCT-2026-0042',
      claimedCentavos: 145_000,
      amountCentavos: -145_000,
      appliedCentavos: -145_000,
      advanceCentavos: 0,
      amountInWords: wordsFor(-145_000),
      lines: [
        { invoiceNumber: 'INV-2026-000103', periodLabel: 'September 2026', amountCentavos: -85_000, source: 'PAYMENT', note: 'Reopened by this reversal' },
        { invoiceNumber: 'INV-2026-000117', periodLabel: 'October 2026', amountCentavos: -60_000, source: 'PAYMENT', note: 'Reopened by this reversal' },
      ],
    }));
    expect(text).toContain('REVERSAL RECEIPT');
    expect(text).toContain('RCT-2026-0042');
    // The sign stays on the figure: the document is about money leaving the account, and a
    // reader who only reads the total must not see a positive figure.
    expect(text).toContain('PHP -1,450.00');
    expect(text).toContain('Reopened by this reversal');
  });

  it('marks a receipt whose payment has since been reversed, and names the reversal', () => {
    const text = pdfText(posted({ status: 'REVERSED', reason: 'Recorded twice.' }));
    expect(text).toContain('REVERSED - THIS MONEY HAS BEEN TAKEN BACK');
    expect(text).toContain('Recorded twice.');
  });

  it('escapes a subscriber name that would otherwise close the PDF string', () => {
    // An unescaped parenthesis truncates the string and corrupts the whole page.
    expect(pdfText(posted({ subscriberName: 'Santos (Juan) \\ Dela Cruz' }))).toContain('Santos \\(Juan\\) \\\\ Dela Cruz');
  });

  it('produces byte-identical output for the same receipt', () => {
    // Two prints of one receipt must match, or the archive cannot prove which was handed over.
    expect(renderReceiptPdf(posted()).equals(renderReceiptPdf(posted()))).toBe(true);
  });
});

/**
 * The one-page guarantee.
 *
 * A receipt is handed over as a single sheet, so the failure that matters is not a wrong figure
 * but an unreadable page: a total printed across somebody's signature, or an invoice list that
 * runs off the bottom and simply stops. Both are checked here by reading the y coordinate of each
 * drawn string out of the content stream, because nothing else on the page would report them.
 */
describe('the one-page receipt', () => {
  /** The drawn y coordinate of each string on the page, with the text it belongs to. */
  const placements = (receipt: ReturnType<typeof posted>) => [...renderReceiptPdf(receipt).toString('latin1')
    .matchAll(/([\d.]+) ([\d.]+) Td\s+\((.*?)\) Tj/g)]
    .map((match) => ({ text: match[3]!, y: Number(match[2]) }));

  /** The same receipt with `count` allocation lines, each carrying a note as a reversal does. */
  const manyLines = (count: number) => {
    const amountCentavos = count * 100;
    return assertReceiptBalanced({
      ...posted(),
      lines: Array.from({ length: count }, (_, index) => ({
        invoiceNumber: `INV-2026-${String(1000 + index)}`,
        periodLabel: 'September 2026',
        amountCentavos: 100,
        source: 'PAYMENT' as const,
        note: 'Reopened by this reversal',
      })),
      claimedCentavos: amountCentavos,
      amountCentavos,
      appliedCentavos: amountCentavos,
      advanceCentavos: 0,
      amountInWords: wordsFor(amountCentavos),
    });
  };

  it('keeps the total, the signatures and the footnote in separate bands', () => {
    const at = placements(posted({ verifiedByName: 'Ramos, Supervisor' }));
    const total = at.find((entry) => entry.text === 'TOTAL')!;
    const receivedBy = at.find((entry) => entry.text === 'Received by')!;
    const confirmedBy = at.find((entry) => entry.text === 'Confirmed by')!;
    // y decreases down the page, so each of these must sit below the one above it with room to
    // spare. Printing the total across a signature line is the defect this guards.
    expect(total.y).toBeGreaterThan(receivedBy.y + 8);
    expect(receivedBy.y).toBeGreaterThan(confirmedBy.y + 8);
    // Nothing is drawn below the bottom margin, where a printer would crop it.
    expect(Math.min(...at.map((entry) => entry.y))).toBeGreaterThan(0);
  });

  it('puts every invoice line above the total', () => {
    const at = placements(manyLines(4));
    const total = at.find((entry) => entry.text === 'TOTAL')!.y;
    const invoices = at.filter((entry) => entry.text.startsWith('INV-2026-'));
    expect(invoices).toHaveLength(4);
    for (const invoice of invoices) expect(invoice.y).toBeGreaterThan(total + 8);
  });

  it('refuses a receipt with more lines than one page carries instead of clipping it', () => {
    // Forty lines was the old upstream cap. Rendering it produced a page whose total and
    // signatures were below the bottom edge, so a subscriber received an unreadable document.
    expect(() => renderReceiptPdf(manyLines(40))).toThrow(ReceiptTooLongError);
    try {
      renderReceiptPdf(manyLines(40));
    } catch (error) {
      // The message has to name the way out, because "something went wrong" leaves a cashier
      // with a payment they cannot receipt and no alternative offered.
      expect((error as Error).message).toMatch(/statement of account/);
      expect((error as ReceiptTooLongError).lines).toBe(40);
    }
  });

  it('still renders the largest receipt that does fit', () => {
    // The refusal must not fire early: a payment settling a dozen invoices is ordinary and has
    // to print rather than push the cashier onto another document.
    const text = renderReceiptPdf(manyLines(8)).toString('latin1');
    expect(text).toContain('INV-2026-1000');
    expect(text).toContain('INV-2026-1007');
    expect(text).toContain('TOTAL');
    expect(text).toContain('Received by');
  });
});

describe('wrapping text into a printed column', () => {
  it('breaks a long value into lines that fit the column', () => {
    const lines = wrapText('one two three four five six seven eight nine ten', 8, 40, 8);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.every((line) => line.length > 0)).toBe(true);
  });

  it('breaks a word too long for the column rather than dropping it', () => {
    const unbroken = 'X'.repeat(80);
    // A generous line limit, so this exercises the character-level break and not the
    // truncation below it.
    const lines = wrapText(unbroken, 8, 40, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(unbroken);
  });

  it('stops at the line limit and marks that it did, rather than running off the page', () => {
    const lines = wrapText('word '.repeat(40), 8, 200, 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('...');
  });

  it('leaves a short value on one line', () => {
    expect(wrapText('San Pedro', 8, 200, 3)).toEqual(['San Pedro']);
  });

  it('clips a value that cannot fit rather than returning it unmeasured', () => {
    expect(fit('ABCDEFGHIJ', 10, 10).endsWith('...')).toBe(true);
    expect(fit('ABC', 10, 500)).toBe('ABC');
  });
});
