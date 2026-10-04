import { formatCell, type ReportColumn, type ReportRow, type ReportTable, type ReportTotal } from '../../shared/reports';
import { zip } from './zip';

/**
 * A real .xlsx workbook, assembled from the XML parts Excel actually reads.
 *
 * Money is written as a NUMBER with two decimals, because a text column cannot be summed in
 * a spreadsheet and a money report that cannot be added up is not much use. The conversion
 * is done on the decimal string rather than by dividing centavos by 100, so 9999 centavos
 * is written as "99.99" and never as 98.999999999.
 *
 * Every column keeps its declared kind, so a date is a date, a count is a count and only
 * money cells carry the accounting format.
 */

const escapeXml = (value: string) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  // Control characters are not legal in XML 1.0 at all, so they are dropped rather than
  // written out and rejected by Excel. Built from a string, because a literal control
  // range in a regular expression is a lint error and an unreadable line.
  .split('')
  .filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f);
  })
  .join('');

/** `1` -> `A`, `27` -> `AA`. Spreadsheet column references, as Excel counts them. */
export function columnReference(index: number): string {
  let name = '';
  let value = index + 1;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

/** Centavos to a two-decimal string, without ever going through a float. */
export function centsToDecimal(value: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

const STYLE_DEFAULT = 0;
const STYLE_BOLD = 1;
const STYLE_MONEY = 2;
const STYLE_MONEY_BOLD = 3;
const STYLE_TITLE = 4;
const STYLE_WRAP = 5;

/**
 * `numeric` marks a cell whose value is a number written as a string, which is how money
 * keeps its two decimal places: `Number("80.00")` is `80`, and a spreadsheet showing `80`
 * for eighty pesos is a rounding error waiting to be quoted back.
 */
type CellSpec = { style: number; value: string | number | null; numeric?: boolean };

class Sheet {
  private readonly rows: string[] = [];
  private row = 0;

  add(cells: CellSpec[]) {
    this.row += 1;
    const parts = cells.map((cell, index) => {
      if (cell.value === null || cell.value === '') return '';
      const reference = `${columnReference(index)}${this.row}`;
      if (cell.numeric || typeof cell.value === 'number') return `<c r="${reference}" s="${cell.style}"><v>${escapeXml(String(cell.value))}</v></c>`;
      return `<c r="${reference}" s="${cell.style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.value)}</t></is></c>`;
    }).join('');
    this.rows.push(`<row r="${this.row}">${parts}</row>`);
    return this;
  }

  blank() { this.rows.push(`<row r="${++this.row}"/>`); return this; }

  xml() { return this.rows.join(''); }
}

function cellFor(column: ReportColumn, row: ReportRow, bold = false): CellSpec {
  const value = row[column.key];
  if (value === null || value === undefined || value === '') return { style: STYLE_DEFAULT, value: null };
  if (column.kind === 'MONEY' && typeof value === 'number') return { style: bold ? STYLE_MONEY_BOLD : STYLE_MONEY, value: centsToDecimal(value), numeric: true };
  if (column.kind === 'NUMBER' && typeof value === 'number') return { style: bold ? STYLE_BOLD : STYLE_DEFAULT, value };
  return { style: bold ? STYLE_BOLD : column.kind === 'TEXT' ? STYLE_WRAP : STYLE_DEFAULT, value: formatCell(value, column) };
}

const totalCells = (column: ReportColumn, total: ReportTotal): CellSpec => {
  const value = total.values[column.key];
  if (value === null || value === undefined || value === '') return { style: STYLE_DEFAULT, value: null };
  if (column.kind === 'MONEY' && typeof value === 'number') return { style: total.emphasis ? STYLE_MONEY_BOLD : STYLE_MONEY, value: centsToDecimal(value), numeric: true };
  return { style: total.emphasis ? STYLE_BOLD : STYLE_DEFAULT, value: typeof value === 'number' ? value : String(value) };
};

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFEFEF"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF808080"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs></styleSheet>`;

export function renderXlsx(table: ReportTable): Buffer {
  const sheet = new Sheet();
  sheet.add([{ style: STYLE_TITLE, value: table.title }]).blank();
  sheet.add([{ style: STYLE_BOLD, value: table.periodLabel }]);
  sheet.add([{ style: STYLE_DEFAULT, value: `Generated ${table.generatedAt.replace('T', ' ').slice(0, 19)} by ${table.generatedBy}` }]).blank();
  // A statement names the account it belongs to, so the spreadsheet a subscriber is handed is
  // not a ledger extract with no owner on it. The freeze pane below counts these rows, which
  // is why the count is tracked rather than assumed.
  const subjectRows = table.subject === null ? 0 : 1 + Math.ceil(table.subject.fields.length / 2);
  if (table.subject !== null) {
    sheet.add([{ style: STYLE_BOLD, value: table.subject.label }]);
    for (let index = 0; index < table.subject.fields.length; index += 2) {
      const pair = table.subject.fields.slice(index, index + 2);
      sheet.add(pair.flatMap((field) => [{ style: STYLE_WRAP, value: field.label }, { style: STYLE_BOLD, value: field.value }]));
    }
    sheet.blank();
  }

  sheet.add(table.columns.map((column) => ({ style: STYLE_BOLD, value: column.label })));
  for (const row of table.rows) sheet.add(table.columns.map((column) => cellFor(column, row)));

  for (const total of table.totals) {
    sheet.add([{ style: total.emphasis ? STYLE_BOLD : STYLE_DEFAULT, value: total.label }, ...table.columns.slice(1).map((column) => totalCells(column, total))]);
  }

  sheet.blank().add([{ style: STYLE_BOLD, value: 'Reconciliation' }])
    .add([{ style: STYLE_BOLD, value: 'Check' }, { style: STYLE_BOLD, value: 'Sum of rows' }, { style: STYLE_BOLD, value: 'Stated total' }, { style: STYLE_BOLD, value: 'Result' }]);
  for (const entry of table.reconciliations) {
    sheet.add([
      { style: STYLE_WRAP, value: entry.label },
      { style: STYLE_MONEY, value: centsToDecimal(entry.summedCentavos), numeric: true },
      { style: STYLE_MONEY, value: centsToDecimal(entry.statedCentavos), numeric: true },
      { style: STYLE_BOLD, value: entry.balanced ? 'Balanced' : 'OUT OF BALANCE' },
    ]);
  }

  if (table.footnote) sheet.blank().add([{ style: STYLE_WRAP, value: table.footnote }]);
  if (table.truncated) sheet.add([{ style: STYLE_BOLD, value: 'This export is a partial view. Narrow the date range for a complete file.' }]);

  const widths = table.columns.map((column, index) => {
    const label = column.label.length;
    const longest = Math.max(0, ...table.rows.map((row) => formatCell(row[column.key] ?? null, column).length));
    return `<col min="${index + 1}" max="${index + 1}" width="${Math.min(60, Math.max(10, Math.max(label, Math.min(longest, 40)) + 2))}" customWidth="1"/>`;
  }).join('');

  // The frozen rows are the header, so the split has to follow the header's actual height. A
  // statement's header is taller than a report's, and a pane left at the old row would freeze
  // the account block into the scroll area and hide the column labels.
  const frozen = 5 + subjectRows;
  const freeze = `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${frozen}" topLeftCell="A${frozen + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}<cols>${widths}</cols><sheetData>${sheet.xml()}</sheetData></worksheet>`;

  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(table.title)}</dc:title><dc:creator>${escapeXml(table.generatedBy)}</dc:creator><cp:lastModifiedBy>BCIS</cp:lastModifiedBy></cp:coreProperties>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${escapeXml(table.title.slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES_XML,
    'xl/worksheets/sheet1.xml': worksheet,
  });
}

/** The CSV escape used by the CSV export, and by the XLSX writer's tests. */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
