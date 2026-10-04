import { formatCell, formatMoneyCell, type ReportColumn, type ReportRow, type ReportTable, type ReportTotal } from '../../shared/reports';
import { A4_LANDSCAPE, assemblePdf, escapePdf, fit, renderStream, textWidth, toWinAnsi, type PdfLine, type PdfRule } from './pdf-core';

/**
 * The report PDF: a wide table, repeated down A4 landscape pages with the header on each.
 *
 * The alternative was a PDF library, but the versions available either ship dependencies with
 * published advisories or expose their layout engine only through an internal path a version
 * bump would break. A report PDF is a small, fixed problem: a grid of columns, a header,
 * totals and a footnote. Writing it directly means the export has no dependency to audit and
 * no rendering surprise. The measurements and the serialiser live in `pdf-core.ts`, which
 * the official receipt shares.
 */

const PAGE_WIDTH = A4_LANDSCAPE.width;
const PAGE_HEIGHT = A4_LANDSCAPE.height;
const MARGIN = 32;
const ROW_HEIGHT = 14;
const FONT_SIZE = 8;
const TITLE_SIZE = 15;
const BODY_TOP = PAGE_HEIGHT - MARGIN - 66;

type Line = PdfLine;
type Rule = PdfRule;

/**
 * Column widths from the declared weights, scaled to the printable area. Weights rather
 * than absolute widths keep the same table readable on A4 landscape and on letter.
 */
function layout(columns: ReportColumn[], available: number) {
  const weight = columns.map((column) => column.width ?? (column.kind === 'MONEY' ? 22 : 18));
  const total = weight.reduce((sum, value) => sum + value, 0);
  const widths = weight.map((value) => Math.floor((value / total) * available));
  // The rounding remainder goes to the last column, so a row spans exactly the page.
  widths[widths.length - 1] = widths[widths.length - 1]! + (available - widths.reduce((sum, value) => sum + value, 0));
  const offsets: number[] = [];
  let cursor = MARGIN;
  for (const width of widths) { offsets.push(cursor); cursor += width; }
  return { widths, offsets };
}

class PageWriter {
  readonly pages: { lines: Line[]; rules: Rule[] }[] = [];
  private page: { lines: Line[]; rules: Rule[] } = { lines: [], rules: [] };
  /** How far down the body the next row goes, in points. */
  private cursor = 0;
  private widths: number[] = [];
  private offsets: number[] = [];

  constructor(private table: ReportTable) { this.pages.push(this.page); }

  /**
   * The lowest y a row may occupy.
   *
   * y grows upward, so this is the small number at the foot of the page. `fits` measures
   * against it to decide when to break: `cursor` counts down towards it as rows are written,
   * which is the direction a PDF reader's eye travels down the sheet.
   */
  get floor() { return MARGIN + 16; }

  fits(rows: number, rowHeight = ROW_HEIGHT) { return this.cursor - rows * rowHeight >= this.floor; }

  addPage(continued: boolean) {
    this.page = { lines: [], rules: [] };
    this.pages.push(this.page);
    this.title(continued ? `${this.table.title} (continued)` : this.table.title, continued);
  }

  text(font: 'F1' | 'F2', size: number, x: number, y: number, value: string) {
    const content = escapePdf(toWinAnsi(value));
    if (content !== '') this.page.lines.push({ font, size, x, y, text: content });
  }

  rule(y: number, size = 0.5, from = MARGIN, to = PAGE_WIDTH - MARGIN) {
    this.page.rules.push({ kind: 'line', x1: from, y1: y, x2: to, y2: y, size });
  }

  band(y: number) {
    this.page.rules.push({ kind: 'fill', x1: MARGIN, y1: y - 3, x2: PAGE_WIDTH - MARGIN, y2: y + ROW_HEIGHT, size: ROW_HEIGHT - 2 });
  }

  title(text: string, continued: boolean) {
    this.text('F2', TITLE_SIZE, MARGIN, PAGE_HEIGHT - MARGIN - 14, `BCIS - ${text}`);
    this.text('F1', FONT_SIZE, MARGIN, PAGE_HEIGHT - MARGIN - 27, `${this.table.periodLabel}   |   ${this.table.rowCount} row(s)`);
    this.rule(PAGE_HEIGHT - MARGIN - 33, 1);
    if (!continued) {
      this.text('F1', FONT_SIZE, MARGIN, PAGE_HEIGHT - MARGIN - 45, `Generated ${this.table.generatedAt.replace('T', ' ').slice(0, 19)} by ${this.table.generatedBy}`);
      // The account a document is about, when it is about one. Only on the first page: a
      // statement's second page is still obviously the same statement, and repeating the
      // header there would push the table off the bottom for no reader's benefit.
      const subject = this.table.subject;
      if (subject !== null && subject !== undefined) {
        this.text('F2', FONT_SIZE, MARGIN, PAGE_HEIGHT - MARGIN - 59, subject.label);
        subject.fields.forEach((field, index) => {
          const column = MARGIN + (index % 2) * (PAGE_WIDTH - MARGIN) / 2;
          const line = PAGE_HEIGHT - MARGIN - 71 - Math.floor(index / 2) * (FONT_SIZE + 2);
          this.text('F1', FONT_SIZE, column, line, `${field.label}: ${field.value}`);
        });
      }
    }
    this.columnHeadings();
  }

  /**
   * Where the column headings sit, which depends on how tall the header above them is.
   *
   * A statement carries the account it belongs to, so its header is taller than a management
   * report's. Measuring it rather than reserving a fixed height keeps the nine reports on one
   * layout while still leaving the subject block clear of the table.
   */
  private get headingTop() {
    const subject = this.table.subject;
    if (subject === null || subject === undefined) return BODY_TOP;
    const lines = Math.ceil(subject.fields.length / 2);
    return BODY_TOP - (14 + lines * (FONT_SIZE + 2));
  }

  /** Draws the column headings and starts the body below them. */
  columnHeadings() {
    const top = this.headingTop;
    this.table.columns.forEach((column, index) => {
      const value = column.label.toUpperCase();
      const x = column.align === 'RIGHT'
        ? this.offsets[index]! + this.widths[index]! - 4 - textWidth(value, FONT_SIZE)
        : this.offsets[index]! + 4;
      this.text('F2', FONT_SIZE, x, top, value);
    });
    this.rule(top + 4);
    this.cursor = top - 14;
  }

  setLayout(widths: number[], offsets: number[]) { this.widths = widths; this.offsets = offsets; }

/** A gap before a block, such as the space above a totals line. The cursor counts down. */
advance(points: number) { this.cursor -= points; }

  private cell(column: ReportColumn, index: number, value: string, font: 'F1' | 'F2', baseline: number) {
    if (value === '') return;
    const clipped = fit(value, FONT_SIZE, this.widths[index]! - 8);
    const x = column.align === 'RIGHT'
      ? this.offsets[index]! + this.widths[index]! - 4 - textWidth(clipped, FONT_SIZE)
      : this.offsets[index]! + 4;
    this.text(font, FONT_SIZE, x, baseline, clipped);
  }

  dataRow(row: ReportRow, shaded: boolean) {
    if (!this.fits(1)) this.addPage(true);
    const baseline = this.cursor;
    this.table.columns.forEach((column, index) => {
      const raw = row[column.key] ?? null;
      const value = column.kind === 'MONEY' ? formatMoneyCell(raw) : formatCell(raw, column);
      this.cell(column, index, value, 'F1', baseline);
    });
    if (shaded) this.band(baseline);
    this.cursor -= ROW_HEIGHT;
  }

  /** A totals line: the label sits in the margin and the figures keep the column alignment. */
  totalRow(label: string, values: ReportTotal['values'], emphasis: boolean) {
    if (!this.fits(1)) this.addPage(true);
    const font = emphasis ? 'F2' : 'F1';
    const baseline = this.cursor;
    this.text(font, FONT_SIZE, MARGIN, baseline, label);
    this.table.columns.forEach((column, index) => {
      const value = values[column.key];
      if (value === null || value === undefined || value === '') return;
      const text = column.kind === 'MONEY' ? formatMoneyCell(value) : formatCell(value, column);
      this.cell(column, index, text, font, baseline);
    });
    this.cursor -= ROW_HEIGHT;
  }

  note(value: string) {
    if (!this.fits(2, ROW_HEIGHT - 2)) this.addPage(true);
    this.text('F1', 7, MARGIN, this.cursor, value);
    this.cursor -= ROW_HEIGHT - 2;
  }

  /**
   * One page's content stream.
   *
   * The page is passed in rather than read from `this.page`, because `this.page` is whichever
   * page is being filled *now*: reading it here would stamp the last page's rows onto every
   * page of the document, which loses all the rows before it without any visible error.
   */
  serialise(page: { lines: Line[]; rules: Rule[] }, index: number, total: number) {
    return renderStream(page, { text: `Page ${index + 1} of ${total}`, x: MARGIN, y: MARGIN - 16 });
  }
}

/**
 * Builds the report PDF.
 *
 * The reconciliations and the footnote are printed, because a report whose totals cannot be
 * checked from the paper it is printed on is asking to be trusted.
 */
export function renderPdf(table: ReportTable): Buffer {
  const printable = PAGE_WIDTH - MARGIN * 2;
  const { widths, offsets } = layout(table.columns, printable);
  const writer = new PageWriter(table);
  writer.setLayout(widths, offsets);
  writer.title(table.title, false);

  table.rows.forEach((row, index) => writer.dataRow(row, index % 2 === 1));

  for (const total of table.totals) {
    writer.advance(4);
    writer.totalRow(total.label, total.values, total.emphasis);
  }

  if (table.reconciliations.length > 0) {
    writer.advance(4);
    writer.totalRow('Reconciliation', {}, true);
    for (const entry of table.reconciliations) {
      writer.note(`${entry.balanced ? 'Balanced' : 'OUT OF BALANCE'}  ${entry.label}  rows ${formatMoneyCell(entry.summedCentavos, false)} against stated ${formatMoneyCell(entry.statedCentavos, false)}`);
    }
  }
  if (table.footnote) writer.note(toWinAnsi(table.footnote));
  if (table.truncated) writer.note('PARTIAL EXPORT: this file is a partial view. Narrow the date range for a complete export.');

  return assemblePdf(
    writer.pages.map((page, index) => writer.serialise(page, index, writer.pages.length)),
    A4_LANDSCAPE,
    `${table.title} report`,
  );
}

/** Re-exported so the report module's callers keep one import for PDF measurement. */
export { fit, textWidth, toWinAnsi };
