import {
  reportFileName, type ExportFormat, type ReportColumn, type ReportCell, type ReportRow, type ReportTable,
} from '../../shared/reports';
import { renderPdf } from './pdf';
import { centsToDecimal, renderXlsx, csvField } from './xlsx';

/**
 * The three export formats, produced on the server.
 *
 * The desktop receives bytes and a file name and shows a save dialog. It never builds a
 * document itself, which is why an exported report cannot show a figure the API did not
 * send, and why the same report exported twice has the same contents.
 */

const CONTENT_TYPES: Record<ExportFormat, string> = {
  PDF: 'application/pdf',
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  CSV: 'text/csv; charset=utf-8',
};

export type RenderedDocument = { fileName: string; contentType: string; body: Buffer };

/**
 * Text a spreadsheet must not read as a formula.
 *
 * A report row can carry a subscriber name or a free-text void reason straight from a user.
 * Excel evaluates a cell beginning `=`, `+`, `-` or `@` when the file is opened, so an
 * exported CSV would run whatever that text says. Prefixing an apostrophe makes Excel show
 * the text instead of executing it. A value that is genuinely a number is left alone, so a
 * negative amount stays a negative amount rather than becoming text.
 */
const FORMULA_START = /^[-+=@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;
export function csvSafeText(value: string): string {
  return FORMULA_START.test(value) && !PLAIN_NUMBER.test(value) ? `'${value}` : value;
}

/**
 * A money cell, ungrouped and unprefixed, so the spreadsheet reads it as a number. A blank
 * cell stays blank rather than becoming a zero nobody asked for.
 */
const moneyText = (value: ReportCell): string => (typeof value === 'number' ? centsToDecimal(value) : '');

/** RFC 4180 quoting, applied to every field whether or not it needs it. */
function csvRow(cells: string[]): string {
  return cells.map((cell) => csvField(csvSafeText(cell.replace(/\r?\n/g, ' ')))).join(',');
}

/**
 * A spreadsheet-safe CSV.
 *
 * The UTF-8 byte order mark is deliberate: without it Excel on Windows reads a peso sign as
 * a replacement character, and a finance officer's export silently loses its currency.
 *
 * Money is written as an ungrouped two-decimal number rather than "PHP 1,234.56". A thousands
 * separator would force the cell to be quoted, and a quoted cell is text: the finance
 * officer who opens this in Excel to total a column would get nothing. So the separators come
 * off, and the number stays a number.
 */
export function renderCsv(table: ReportTable): Buffer {
  const lines: string[] = [];
  lines.push(csvRow([table.title]));
  lines.push(csvRow([table.periodLabel]));
  lines.push(csvRow([`Generated ${table.generatedAt.replace('T', ' ').slice(0, 19)} by ${table.generatedBy}`]));
  lines.push('');
  // The account a statement belongs to is the one thing a customer opening the file in a plain
  // text editor still needs, so it goes in before the column labels in every format.
  if (table.subject) {
    lines.push(csvRow([table.subject.label]));
    table.subject.fields.forEach((field, index) => {
      if (index % 2 === 0 && index + 1 < table.subject!.fields.length) {
        const right = table.subject!.fields[index + 1]!;
        lines.push(csvRow([`${field.label}: ${field.value}`, `${right.label}: ${right.value}`]));
      } else lines.push(csvRow([`${field.label}: ${field.value}`]));
    });
    lines.push('');
  }
  lines.push(csvRow(table.columns.map((column) => column.label)));

  const cellText = (column: ReportColumn, row: ReportRow) => {
    const value = row[column.key] ?? null;
    return column.kind === 'MONEY' ? moneyText(value) : value === null || value === undefined ? '' : String(value);
  };
  for (const row of table.rows) lines.push(csvRow(table.columns.map((column) => cellText(column, row))));

  lines.push('');
  for (const total of table.totals) {
    lines.push(csvRow([total.label, ...table.columns.slice(1).map((column) => {
      const value = total.values[column.key];
      if (value === null || value === undefined) return '';
      return column.kind === 'MONEY' ? moneyText(value) : String(value);
    })]));
  }

  if (table.reconciliations.length > 0) {
    lines.push('');
    lines.push(csvRow(['Reconciliation', 'Sum of rows', 'Stated total', 'Result']));
    for (const entry of table.reconciliations) {
      lines.push(csvRow([entry.label, centsToDecimal(entry.summedCentavos), centsToDecimal(entry.statedCentavos), entry.balanced ? 'Balanced' : 'OUT OF BALANCE']));
    }
  }
  if (table.footnote) lines.push('', csvRow([table.footnote]));
  if (table.truncated) lines.push(csvRow(['PARTIAL EXPORT: narrow the date range for a complete file']));

  return Buffer.concat([Buffer.from('\uFEFF', 'utf8'), Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8')]);
}

export function renderDocument(table: ReportTable, format: ExportFormat): RenderedDocument {
  const fileName = reportFileName(table.code, table.from, table.to, format);
  if (format === 'CSV') return { fileName, contentType: CONTENT_TYPES.CSV, body: renderCsv(table) };
  if (format === 'XLSX') return { fileName, contentType: CONTENT_TYPES.XLSX, body: renderXlsx(table) };
  return { fileName, contentType: CONTENT_TYPES.PDF, body: renderPdf(table) };
}
