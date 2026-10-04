import { formatMoneyCell } from '../../shared/reports';
import { officeIdentity, wordsFor, type ReceiptDocument } from '../../shared/documents';
import { A4_PORTRAIT, assemblePdf, escapePdf, fit, renderStream, textWidth, toWinAnsi, wrapText, type PdfLine, type PdfRule } from './pdf-core';

/**
 * The official receipt: a portrait form a subscriber takes home.
 *
 * It is not a report table and is deliberately not rendered by `pdf.ts`. A report is read by
 * the office; a receipt is handed to somebody who will check it with their own eyes, so the
 * layout is the one they expect: letterhead, the amount written in words beside the amount in
 * figures, the invoices it settled, and two lines for signatures.
 *
 * Three decisions are worth stating, because they are the ones that make the document
 * trustworthy rather than decorative:
 *
 * 1. **The amount appears twice, in words and in figures.** Either alone can be a typo;
 *    together they are checkable by someone who is not a programmer. `assertReceiptBalanced`
 *    verifies server-side that the two describe the same number before anything is drawn.
 * 2. **A receipt that is not POSTED says so on the paper.** A pending GCash claim and a
 *    reversal each carry their own wording, because handing someone a document that looks
 *    like a settled receipt is the failure this is guarding against.
 * 3. **Reversals are signed, not absolute.** Every figure on a reversal receipt is negative,
 *    so a reversal cannot be mistaken for a fresh payment by a reader who only sees the
 *    amount.
 */

const PAGE_WIDTH = A4_PORTRAIT.width;
const PAGE_HEIGHT = A4_PORTRAIT.height;
const MARGIN = 40;
const PRINTABLE = PAGE_WIDTH - MARGIN * 2;
const TOP = PAGE_HEIGHT - MARGIN;
const BOTTOM = MARGIN;

const SMALL = 7.5;
const BODY = 9;
const MUTED = 8;

/**
 * The bands the foot of the page is reserved for.
 *
 * These are measured from the layout rather than guessed: each signature block opens with 26
 * points of signing space and closes with a caption, a name and a "(printed name)" line, and
 * the footnote is up to three small lines. Reserving them up front is what stops a receipt with
 * many invoices from printing its total over somebody's signature, which is the one defect on
 * this document a subscriber would notice immediately.
 */
const SIGNATURE_BLOCK = 26 + BODY + 4 + SMALL + 6;
const SIGNATURE_BAND = 2 * SIGNATURE_BLOCK + 8;
const FOOTNOTE_BAND = 3 * (SMALL + 3);
/**
 * Where the content hands over to the signatures.
 *
 * `signature()` opens by advancing past the signing space, so the first rule lands one
 * `advance(26)` below this line. Content must finish above it with a line to spare, which is
 * what turns "this receipt is too full" into an error rather than an overlapped signature.
 */
const SIGNATURE_TOP = BOTTOM + FOOTNOTE_BAND + SIGNATURE_BAND - 26;

/** The wording a receipt carries for each state it can be printed in. */
const STATUS_BANNER: Record<ReceiptDocument['status'], { text: string; note: string }> = {
  POSTED: { text: '', note: '' },
  PENDING: {
    text: 'PENDING CONFIRMATION - NOT YET A RECEIPT OF PAYMENT',
    note: 'This GCash claim has been recorded but is not confirmed by a second person, so it is not yet counted as collected. It carries no receipt number.',
  },
  VOID: {
    text: 'VOID - THIS DOCUMENT HAS NO FINANCIAL EFFECT',
    note: 'This entry was voided before it posted. It settled nothing and holds no receipt number. The entry stays on the record for audit.',
  },
  REVERSED: {
    text: 'REVERSED - THIS MONEY HAS BEEN TAKEN BACK',
    note: 'This receipt was reversed. A new receipt with its own number records the reversal, the invoices above were reopened, and this receipt stays on the record rather than being erased.',
  },
};

class ReceiptWriter {
  private readonly page: { lines: PdfLine[]; rules: PdfRule[] } = { lines: [], rules: [] };
  private cursor = TOP;

  constructor(private receipt: ReceiptDocument) {}

  private text(value: string, x: number, size = BODY, font: 'F1' | 'F2' = 'F1') {
    const content = escapePdf(toWinAnsi(value));
    if (content !== '') this.page.lines.push({ font, size, x, y: this.cursor, text: content });
  }

  /** Text drawn relative to the top of the current line, for a second line under a heading. */
  private baseline(value: string, x: number, y: number, size = BODY, font: 'F1' | 'F2' = 'F1') {
    const content = escapePdf(toWinAnsi(value));
    if (content !== '') this.page.lines.push({ font, size, x, y, text: content });
  }

  /** Centred text, measured rather than guessed, because the page centre is not the column centre. */
  private centred(value: string, size: number, font: 'F1' | 'F2' = 'F1') {
    this.text(value, (PAGE_WIDTH - textWidth(toWinAnsi(value), size)) / 2, size, font);
  }

  private right(value: string, y: number, size = BODY, font: 'F1' | 'F2' = 'F1') {
    this.baseline(value, PAGE_WIDTH - MARGIN - textWidth(toWinAnsi(value), size), y, size, font);
  }

  private rule(y: number, size = 0.5, from = MARGIN, to = PAGE_WIDTH - MARGIN) {
    this.page.rules.push({ kind: 'line', x1: from, y1: y, x2: to, y2: y, size });
  }

  private band(y: number, height: number, from = MARGIN, to = PAGE_WIDTH - MARGIN) {
    this.page.rules.push({ kind: 'fill', x1: from, y1: y - height + 3.5, x2: to, y2: y + 3.5, size: height });
  }

  private advance(points: number) { this.cursor -= points; }

  /** Wrapped paragraph, returning the height it used. */
  private paragraph(value: string, x: number, width: number, size = SMALL, maxLines = 4): number {
    const lines = wrapText(toWinAnsi(value), size, width, maxLines);
    for (const line of lines) { this.text(line, x, size); this.advance(size + 2); }
    return lines.length * (size + 2);
  }

  /**
   * A label above its value, which is how a receipt reads: the caption is small and grey and
   * the value is bold. Used for the subscriber and payment particulars.
   */
  private field(label: string, value: string, x: number, width: number, emphasis = false) {
    this.text(label.toUpperCase(), x, MUTED);
    this.advance(BODY + 3);
    const lines = wrapText(toWinAnsi(value), BODY, width, 2);
    for (const line of lines) { this.text(line, x, BODY, emphasis ? 'F2' : 'F1'); this.advance(BODY + 2); }
    return lines.length * (BODY + 2);
  }

  /** Two fields side by side, which is the only reason the header block is taller than a line. */
  private pair(left: [string, string, boolean], right: [string, string, boolean]) {
    const half = PRINTABLE / 2 - 8;
    const used = Math.max(
      this.field(left[0], left[1], MARGIN, half, left[2]),
      this.field(right[0], right[1], MARGIN + PRINTABLE / 2 + 8, half, right[2]),
    );
    this.advance(Math.max(0, used) + 4);
  }

  private wideField(label: string, value: string, emphasis = false) {
    const used = this.field(label, value, MARGIN, PRINTABLE, emphasis);
    this.advance(used + 2);
  }

  /** A ruled signature line with a caption under it, for the two people who handle the money. */
  private signature(caption: string, name: string) {
    this.advance(26);
    this.rule(this.cursor, 0.5, MARGIN, MARGIN + PRINTABLE * 0.42);
    this.text(caption, MARGIN, MUTED);
    this.text(name, MARGIN, BODY, 'F2');
    this.advance(BODY + 4);
    if (name !== '') this.text('(printed name)', MARGIN, SMALL);
    this.advance(SMALL + 6);
  }

  private tableHeadings() {
    this.text('INVOICE', MARGIN, MUTED);
    this.text('PERIOD', MARGIN + 105, MUTED);
    this.text('APPLIED FROM', MARGIN + 205, MUTED);
    this.right('AMOUNT', this.cursor, MUTED);
    this.advance(SMALL + 5);
    this.rule(this.cursor, 0.7);
    this.advance(BODY + 3);
  }

  /**
   * One allocation row, with its note on a second line beneath.
   *
   * The note is not decoration: it is where "Reopened by this reversal" and "Reversed on
   * <date>" live, so a reader can tell which of the lines on the document are still in force.
   * It goes under the row rather than into a fifth column because the four columns already
   * span the page, and squeezing a fifth would clip the invoice number to fit it.
   */
  private tableRow(index: number, cells: { invoice: string; period: string; source: string; amount: string; note: string }) {
    if (index % 2 === 1) this.band(this.cursor, BODY + 2);
    this.text(fit(cells.invoice, BODY, 100), MARGIN, BODY);
    this.text(fit(cells.period, BODY, 95), MARGIN + 105, BODY);
    this.text(fit(cells.source, BODY, 95), MARGIN + 205, BODY);
    this.right(cells.amount, this.cursor, BODY);
    this.advance(BODY + 3);
    if (cells.note !== '') {
      this.text(fit(cells.note, SMALL, PRINTABLE - 10), MARGIN, SMALL);
      this.advance(SMALL + 2);
    }
  }

  build() {
    const receipt = this.receipt;

    // ---- letterhead
    this.centred(officeIdentity.name, 12, 'F2');
    this.advance(11);
    this.centred(officeIdentity.system, SMALL);
    this.advance(16);

    this.centred(receipt.documentTitle, 10.5, 'F2');
    this.advance(13);
    this.rule(this.cursor, 0.7);
    this.advance(4);
    this.text('Receipt no.', MARGIN, MUTED);
    // An unnumbered document has to say so rather than leave the field blank, which reads as
    // a number that was lost.
    this.right(receipt.receiptNumber ?? 'Not yet issued', this.cursor, BODY, 'F2');
    this.advance(BODY + 5);

    const banner = STATUS_BANNER[receipt.status];
    if (banner.text !== '') {
      this.band(this.cursor, SMALL + 4);
      this.centred(banner.text, SMALL, 'F2');
      this.advance(SMALL + 8);
    }

    // ---- particulars
    this.pair(['Date received', receipt.issuedOn, true], ['Payment method', receipt.method, true]);
    this.pair(['Subscriber', receipt.subscriberName, true], ['Account no.', receipt.subscriberCode, true]);
    if (receipt.referenceNumber !== null) this.pair(['Reference no.', receipt.referenceNumber, false], ['Collected on', receipt.collectionBatchNumber ?? 'Office counter', false]);
    if (receipt.serviceAddresses !== '') this.wideField('Service address', receipt.serviceAddresses);
    if (receipt.servicesSummary !== '') this.wideField('Service', receipt.servicesSummary);
    if (receipt.reversalOfReceipt !== null) this.wideField('Reverses receipt', receipt.reversalOfReceipt, true);
    if (receipt.reason !== '') this.wideField(receipt.status === 'POSTED' ? 'Note' : 'Reason', receipt.reason);

    // ---- the amount, twice
    this.advance(6);
    this.rule(this.cursor, 0.5);
    this.advance(BODY + 4);
    this.text('Received the amount of', MARGIN, MUTED);
    this.advance(BODY + 2);
    // The words run the full width and wrap, because a subscriber's figure in words is the
    // longest line on the document and a clipped one is the whole point lost.
    this.paragraph(`${wordsFor(receipt.amountCentavos)} (${receipt.direction === 'REVERSAL' ? 'reversal of the amount above' : 'inclusive of all charges'})`, MARGIN, PRINTABLE - 130, BODY, 2);
    this.advance(4);
    this.rule(this.cursor, 0.5);
    this.advance(BODY + 6);
    this.right(formatMoneyCell(receipt.amountCentavos), this.cursor, 14, 'F2');
    this.advance(20);

    // ---- what the money settled
    if (receipt.lines.length > 0) {
      this.tableHeadings();
      receipt.lines.forEach((line, index) => this.tableRow(index, {
        invoice: line.invoiceNumber ?? line.note,
        period: line.periodLabel,
        source: line.source === 'ADVANCE' ? 'Advance credit' : 'This payment',
        amount: formatMoneyCell(line.amountCentavos),
        note: line.note,
      }));
      this.advance(2);
      this.rule(this.cursor, 0.5);
    }

    // ---- the arithmetic, printed so the document checks itself
    // The allocation table is the only part that grows, so it is the only part that can push the
    // total into the reserved band below. Checked here, before the total is drawn, so an
    // over-full receipt is refused rather than allowed to print a figure across a signature.
    // Measured from the advances below rather than guessed: three labels, three figures and the
    // rule above the total, plus the discarded-claim pair a void receipt adds underneath them.
    const ARITHMETIC_BAND = 3 * (BODY + 4) + 2 * (BODY + 2) + (BODY + 5);
    const DISCARDED_BAND = (BODY + 2) + (BODY + 4);
    const needed = ARITHMETIC_BAND + (receipt.status === 'VOID' && receipt.claimedCentavos !== 0 ? DISCARDED_BAND : 0);
    if (this.cursor - needed < SIGNATURE_TOP + BODY + 6) throw new ReceiptTooLongError(receipt.lines.length);
    this.advance(BODY + 4);
    // A void received nothing, so its total is a zero. Printing the discarded claim beside it
    // is what turns that zero into an explained zero: a reader sees what was claimed, sees
    // that none of it was received, and does not have to guess which of the two went wrong.
    if (receipt.status === 'VOID' && receipt.claimedCentavos !== 0) {
      this.right('Claimed amount, discarded', this.cursor, MUTED);
      this.advance(BODY + 2);
      this.right(formatMoneyCell(receipt.claimedCentavos), this.cursor);
      this.advance(BODY + 4);
    }
    this.right('Applied to invoices', this.cursor, MUTED);
    this.advance(BODY + 2);
    this.right(formatMoneyCell(receipt.appliedCentavos), this.cursor);
    this.advance(BODY + 4);
    this.right('Held as advance credit', this.cursor, MUTED);
    this.advance(BODY + 2);
    this.right(formatMoneyCell(receipt.advanceCentavos), this.cursor);
    this.advance(BODY + 5);
    this.rule(this.cursor, 0.5, MARGIN + PRINTABLE * 0.5, PAGE_WIDTH - MARGIN);
    this.advance(BODY + 4);
    this.right('TOTAL', this.cursor, BODY, 'F2');
    this.right(formatMoneyCell(receipt.amountCentavos), this.cursor, BODY, 'F2');

    // ---- signatures
    // The band is reserved from the foot upwards rather than pinned to a fixed line, so the
    // signatures sit in the same place on every receipt and nothing is drawn underneath them.
    this.cursor = SIGNATURE_TOP + 26;
    this.signature('Received by', receipt.receivedByName);
    if (receipt.verifiedByName !== null) this.signature('Confirmed by', receipt.verifiedByName);

    // ---- footnote
    const notes = [banner.note, receipt.footnote].filter((note) => note !== '');
    if (notes.length > 0) {
      this.cursor = BOTTOM + FOOTNOTE_BAND - 6;
      for (const note of notes) this.paragraph(note, MARGIN, PRINTABLE, SMALL, 3);
    }

    return renderStream(this.page, {
      text: `Printed ${receipt.generatedAt.replace('T', ' ').slice(0, 19)} by ${receipt.generatedBy}`,
      x: MARGIN,
      y: BOTTOM - 14,
    });
  }
}

/**
 * Raised when a receipt has more allocation lines than one page can carry.
 *
 * This is a layout refusal rather than a crash, so it is a named type the route can turn into a
 * 422 with a message the cashier can act on. Silently dropping the overflow or letting the total
 * print over a signature would both be worse than saying "print the statement instead".
 */
export class ReceiptTooLongError extends Error {
  constructor(readonly lines: number) {
    super(`Receipt ${lines} invoice lines do not fit on one page. Print the statement of account instead.`);
    this.name = 'ReceiptTooLongError';
  }
}

/**
 * Builds the official receipt PDF.
 *
 * A receipt is one page by construction: its contents are bounded by one payment, and the
 * allocation table is the only part that can grow. Rather than paginate a document meant to be
 * handed over as a single sheet, this function refuses one that will not fit. It is therefore
 * the authority on how many lines a receipt can carry, and the route translates the refusal into
 * a 422 rather than passing a clipped page to a subscriber.
 */
export function renderReceiptPdf(receipt: ReceiptDocument): Buffer {
  return assemblePdf([new ReceiptWriter(receipt).build()], A4_PORTRAIT, `${officeIdentity.name} ${receipt.documentTitle}`);
}
