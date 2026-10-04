import { describe, expect, it } from 'vitest';
import { crc32, zip } from '../../source/api/reports/zip';
import { centsToDecimal, columnReference, csvField, renderXlsx } from '../../source/api/reports/xlsx';
import { renderPdf, textWidth, toWinAnsi } from '../../source/api/reports/pdf';
import { renderCsv, renderDocument } from '../../source/api/reports/documents';
import { emptyTable, type ReportRow, type ReportTable } from '../../source/shared/reports';
import { inflateRawSync } from 'node:zlib';

/**
 * Reads back an archive the writer produced, by walking the local file headers. Testing an
 * export by trusting the writer that made it proves only that it is self-consistent, so the
 * bytes are parsed the way a spreadsheet would read them.
 */
function unzip(archive: Buffer): Map<string, string> {
  const parts = new Map<string, string>();
  for (let at = 0; at < archive.length - 4; at += 1) {
    if (archive.readUInt32LE(at) !== 0x0403_4b50) continue;
    const method = archive.readUInt16LE(at + 8);
    const size = archive.readUInt32LE(at + 18);
    const nameLength = archive.readUInt16LE(at + 26);
    const extraLength = archive.readUInt16LE(at + 28);
    const name = archive.toString('utf8', at + 30, at + 30 + nameLength);
    const body = archive.subarray(at + 30 + nameLength + extraLength, at + 30 + nameLength + extraLength + size);
    // Stored, or deflated with a raw zlib stream.
    parts.set(name, (method === 0 ? body : inflateRawSync(body)).toString('utf8'));
    at += 30 + nameLength + extraLength + size - 1;
  }
  return parts;
}

const table = (rows: ReportRow[] = [], from = '2026-10-01', to = '2026-10-01'): ReportTable => ({
  ...emptyTable({ code: 'COLLECTIONS', from, to, generatedAt: '2026-10-01T12:00:00.000Z', generatedBy: 'Rosario, Manager' }),
  periodLabel: from === to ? from : `${from} to ${to}`,
  footnote: 'Cash is cash collected on the receipt date.',
  columns: [
    { key: 'period', label: 'Period', kind: 'TEXT', align: 'LEFT', width: 20, runningTotal: false },
    { key: 'receipts', label: 'Receipts', kind: 'NUMBER', align: 'RIGHT', width: 10, runningTotal: false },
    { key: 'amountCentavos', label: 'Collected', kind: 'MONEY', align: 'RIGHT', width: 18, runningTotal: false },
  ],
  rows,
  totals: [{ label: 'Total', values: { amountCentavos: rows.reduce((sum, row) => sum + Number(row.amountCentavos ?? 0), 0) }, emphasis: true }],
  reconciliations: [],
});

describe('the zip writer', () => {
  it('produces the same archive every time, so a saved report can be checked later', () => {
    const parts = { 'hello.txt': 'Hello', 'sub/second.txt': 'Second' };
    expect(zip(parts).equals(zip(parts))).toBe(true);
  });

  it('deflates an entry when that helps, and stores it when it does not', () => {
    // 400 identical characters compress; a tiny part would only grow.
    const parts = unzip(zip({ 'big.txt': 'x'.repeat(400), 'tiny.txt': 'a' }));
    expect(parts.get('big.txt')).toBe('x'.repeat(400));
    expect(parts.get('tiny.txt')).toBe('a');
    expect(zip({ 'big.txt': 'x'.repeat(400) }).length).toBeLessThan(400);
  });

  it('writes a checksum that matches the reference CRC-32', () => {
    // Verified against Python's zlib.crc32, so this is the real algorithm and not a
    // self-consistent invention of it.
    expect(crc32(Buffer.from('The quick brown fox'))).toBe(0xb74574de);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('ends the central directory with the count of entries it says it has', () => {
    const archive = zip({ 'a.txt': 'a', 'b.txt': 'bb', 'c.txt': 'ccc' });
    const records = archive.readUInt16LE(archive.length - 12);
    expect(records).toBe(3);
  });
});

describe('the xlsx writer', () => {
  it('names a column the way a spreadsheet does', () => {
    expect(columnReference(0)).toBe('A');
    expect(columnReference(25)).toBe('Z');
    expect(columnReference(26)).toBe('AA');
    expect(columnReference(51)).toBe('AZ');
    expect(columnReference(701)).toBe('ZZ');
    expect(columnReference(702)).toBe('AAA');
  });

  it('writes cents as an exact two-decimal number, never a divided float', () => {
    expect(centsToDecimal(0)).toBe('0.00');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(centsToDecimal(999)).toBe('9.99');
    expect(centsToDecimal(123_456_789)).toBe('1234567.89');
    expect(centsToDecimal(-2_500)).toBe('-25.00');
    // The value a spreadsheet stores after reading it back is the same number either way.
    expect(Number(centsToDecimal(9_999))).toBe(Number(9_999 / 100));
    expect(centsToDecimal(9_999)).toBe('99.99');
  });

  it('quotes a CSV field only when it has to', () => {
    expect(csvField('Rosario')).toBe('Rosario');
    expect(csvField('with,comma')).toBe('"with,comma"');
    expect(csvField('with"quote')).toBe('"with""quote"');
    expect(csvField('with\nnewline')).toBe('"with\nnewline"');
    expect(csvField(' leading space')).toBe(' leading space');
  });

  it('lays out a sheet with the columns, rows and total', () => {
    const sheet = renderXlsx(table([{ period: '2026-10', receipts: 2, amountCentavos: 123_456 }]));
    // The workbook is a zip, so it opens with the zip signature and names its parts.
    expect(sheet.readUInt32LE(0)).toBe(0x0403_4b50);
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']) {
      expect(sheet.includes(Buffer.from(part)), `missing ${part}`).toBe(true);
    }
    // Read the sheet back out of the archive, so the assertions are on the cells a
    // spreadsheet would actually open rather than on the writer's own intentions.
    const archive = unzip(sheet);
    const xml = archive.get('xl/worksheets/sheet1.xml') ?? '';
    expect(xml).toContain('<v>1234.56</v>');
    expect(xml).toContain('Rosario, Manager');
    expect(archive.get('[Content_Types].xml')).toContain('sheet1.xml');
  });
});

describe('the pdf writer', () => {
  it('strips what the base fonts cannot show instead of emitting broken glyphs', () => {
    expect(toWinAnsi('Amount in PHP')).toBe('Amount in PHP');
    expect(toWinAnsi('caf\u00e9 \u00b5 \u00b1')).toBe('caf\u00e9 \u00b5 \u00b1');
    // Em dash and curly quotes are not in WinAnsi; a statement of account needs them.
    expect(toWinAnsi('Week of 28 Sep \u2013 4 Oct')).toBe('Week of 28 Sep - 4 Oct');
    expect(toWinAnsi('\u201cquoted\u201d')).toBe('"quoted"');
    expect(toWinAnsi('\u2026')).toBe('...');
    // The peso sign is the one currency this system deals in, so it is spelled out rather
    // than left to fall through to a question mark on a customer's statement.
    expect(toWinAnsi('\u20b11,234.56')).toBe('PHP1,234.56');
    // Genuinely unrepresentable characters are still replaced, never dropped silently.
    expect(toWinAnsi('\u4e2d\u6587')).toBe('??');
  });

  it('estimates a string width so a column can be fitted and right-aligned', () => {
    expect(textWidth('abc', 10)).toBeGreaterThan(textWidth('ab', 10));
    expect(textWidth('abc', 20)).toBeCloseTo(textWidth('abc', 10) * 2);
    expect(textWidth('', 10)).toBe(0);
  });

  it('writes a document that declares its page size and holds its own byte offsets', () => {
    const document = renderPdf(table([{ period: '2026-10', receipts: 2, amountCentavos: 123_456 }]));
    const text = document.toString('latin1');
    expect(document.readUInt32LE(0)).toBe(0x4644_5025); // "%PDF", little-endian
    expect(text).toContain('/Type /Catalog');
    expect(text).toMatch(/\/MediaBox \[0 0 \d+ \d+\]/);
    // Every cross-reference offset must land exactly on its object header, or a reader
    // silently shows a blank page instead of the report.
    const offsets = [...text.matchAll(/^(\d{10}) 00000 n\s$/gm)].map((match) => Number(match[1]));
    expect(offsets.length).toBeGreaterThan(2);
    for (const offset of offsets) expect(text.slice(offset)).toMatch(/^\d+ 0 obj/);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('keeps the peso sign out of the stream, because the base fonts cannot draw it', () => {
    const document = renderPdf(table([{ period: '2026-10', receipts: 1, amountCentavos: 1 }])).toString('latin1');
    expect(document).toContain('PHP 0.01');
    expect(document.includes('\u20b1')).toBe(false);
  });

  /**
   * Page geometry.
   *
   * These assertions exist because the earlier layout bugs were invisible to every other test
   * in this file: the report still contained all its text, still parsed as a PDF, and still had
   * valid byte offsets. What was wrong was where the rows landed. So each of these reads the y
   * coordinate back out of the content stream, which is the only place the truth is written.
   */
  it('lays rows out down the page instead of running off the top of it', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({ period: `2026-${String(index + 1).padStart(2, '0')}`, receipts: 1, amountCentavos: 100 }));
    const text = renderPdf(table(rows)).toString('latin1');
    // Each period label appears once, with the y it was drawn at.
    const drawn = [...text.matchAll(/([\d.]+) ([\d.]+) Td\s+\((2026-\d\d)\) Tj/g)].map((match) => ({ label: match[3]!, y: Number(match[2]) }));
    expect(drawn).toHaveLength(12);
    // y decreases down the page, so each row must sit below the one before it.
    for (let index = 1; index < drawn.length; index += 1) {
      expect(drawn[index]!.y).toBeLessThan(drawn[index - 1]!.y);
    }
    // And none of them may reach the bottom margin, where a printer crops them.
    expect(Math.min(...drawn.map((entry) => entry.y))).toBeGreaterThan(40);
    // Twelve rows fit an A4 landscape page. When they did not, the writer was breaking early
    // and producing one near-empty page per row.
    expect(text.match(/\/Type \/Page[^s]/g)).toHaveLength(1);
  });

  it('keeps every row when a report runs past one page', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ period: `P${String(index).padStart(3, '0')}`, receipts: 1, amountCentavos: 100 }));
    const text = renderPdf(table(rows)).toString('latin1');
    const pages = text.match(/\/Type \/Page[^s]/g)?.length ?? 0;
    expect(pages).toBeGreaterThan(1);
    // The defect this guards against stamped the final page's contents onto every page, so the
    // file had the right number of pages and the wrong rows on all of them.
    for (const row of rows) expect(text).toContain(`(${row.period})`);
    // The rows are spread over the pages rather than repeated on each one.
    expect(text.match(/\(P000\)/g)).toHaveLength(1);
  });

  it('numbers its pages so a reader can tell one from a continuation', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ period: `P${String(index).padStart(3, '0')}`, receipts: 1, amountCentavos: 100 }));
    const text = renderPdf(table(rows)).toString('latin1');
    const pages = text.match(/\/Type \/Page[^s]/g)?.length ?? 0;
    expect(text).toContain(`Page 1 of ${pages}`);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    // Only the first page carries the real title; the rest are marked as continuations.
    expect(text.match(/\(BCIS - /g)).toHaveLength(pages);
  });
});

describe('the csv writer', () => {
  it('opens with a byte order mark, so Excel reads UTF-8 names correctly', () => {
    const csv = renderCsv(table([{ period: '2026-10', receipts: 1, amountCentavos: 250 }]));
    expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    // The file describes itself: a saved export still says what it is and when it was made.
    const lines = csv.toString('utf8').slice(1).split('\r\n');
    expect(lines[0]).toBe('Collection summary');
    expect(lines[1]).toBe('2026-10-01');
    // Quoted, because the generator's name contains a comma and must survive RFC 4180.
    expect(lines[2]).toBe('"Generated 2026-10-01 12:00:00 by Rosario, Manager"');
    expect(lines[4]).toBe('Period,Receipts,Collected');
    expect(lines[5]).toBe('2026-10,1,2.50');
  });

  it('writes money as an unquoted number, so a spreadsheet can add the column up', () => {
    const csv = renderCsv(table([{ period: '2026-10', receipts: 1, amountCentavos: 123_456 }])).toString('utf8');
    // A thousands separator would force quoting, and a quoted cell is text that Excel
    // refuses to total. This is the whole reason the separators come off here.
    expect(csv).toContain('2026-10,1,1234.56');
    expect(csv).not.toContain('"1,234.56"');
    expect(csv).not.toContain('PHP');
  });

  it('neutralises a value that Excel would otherwise run as a formula', () => {
    // A subscriber name or void reason arrives from a user and must not execute on open.
    const csv = renderCsv(table([{ period: '=cmd|\'/c calc\'!A0', receipts: 1, amountCentavos: 1 }])).toString('utf8');
    expect(csv).toContain("'=cmd|'/c calc'!A0");
    expect(csv.split('\r\n')[5]!.startsWith('=cmd')).toBe(false);
  });

  it('still writes a negative amount as a negative number, not as text', () => {
    const csv = renderCsv(table([{ period: '2026-10', receipts: 1, amountCentavos: -2_500 }])).toString('utf8');
    expect(csv).toContain('-25.00');
    expect(csv).not.toContain("'-25.00");
  });

  it('escapes a value that would otherwise break the column alignment', () => {
    const csv = renderCsv(table([{ period: 'a,b"c', receipts: 1, amountCentavos: 1 }])).toString('utf8');
    expect(csv).toContain('"a,b""c"');
  });
});

describe('choosing a format', () => {
  const exported = table([{ period: '2026-10', receipts: 1, amountCentavos: 100 }]);

  it('gives each format its own media type and file name', () => {
    expect(renderDocument(exported, 'PDF')).toMatchObject({ contentType: 'application/pdf', fileName: expect.stringMatching(/\.pdf$/) });
    expect(renderDocument(exported, 'XLSX')).toMatchObject({
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', fileName: expect.stringMatching(/\.xlsx$/),
    });
    expect(renderDocument(exported, 'CSV')).toMatchObject({ contentType: 'text/csv; charset=utf-8', fileName: expect.stringMatching(/\.csv$/) });
  });

  it('never returns an empty file, so a saved report is never a zero-byte surprise', () => {
    for (const format of ['PDF', 'XLSX', 'CSV'] as const) {
      const document = renderDocument(table(), format);
      expect(document.body.length).toBeGreaterThan(0);
    }
  });
});