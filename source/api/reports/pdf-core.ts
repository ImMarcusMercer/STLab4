/**
 * The PDF primitives, with no opinion about what is being printed.
 *
 * Two documents in this system are PDFs: the report tables (`pdf.ts`) and the official
 * receipts (`receipt.ts`). They are laid out nothing alike — one is a grid, the other a
 * form — but they are written the same way, so the parts that must be identical live here:
 *
 * - the base-14 Helvetica metrics, because a column has to be measured the same way in
 *   both or a receipt's figures will not line up with its labels;
 * - the WinAnsi mapping, so a subscriber's name with an apostrophe prints as a letter and
 *   not as a blank box;
 * - the serialiser, which is the only place a PDF byte stream is assembled.
 *
 * Nothing is embedded and nothing is licensed: these are the standard's base fonts. They
 * cover WinAnsi, which is why money is labelled "PHP" rather than with the peso sign, a
 * glyph the base font does not contain.
 */

export type PageGeometry = { width: number; height: number };

/** A4 in PostScript points, the two orientations the two documents need. */
export const A4_LANDSCAPE: PageGeometry = { width: 842, height: 595 };
export const A4_PORTRAIT: PageGeometry = { width: 595, height: 842 };

/** Helvetica's advance width at 1000 units/em, for the characters this writer emits. */
const WIDTHS: Record<string, number> = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191, '(': 333, ')': 333,
  '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278, 0: 556, 1: 556, 2: 556, 3: 556, 4: 556,
  5: 556, 6: 556, 7: 556, 8: 556, 9: 556, ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556,
  '@': 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500, K: 667,
  L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944,
  X: 667, Y: 667, Z: 611, '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333, a: 556, b: 556,
  c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556,
  o: 556, p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

/**
 * Maps the typographic characters the documents carry onto WinAnsi equivalents. Without this
 * the apostrophe in a subscriber's name would print as a blank box.
 */
const WIN_ANSI: Record<string, string> = {
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201C': '"', '\u201D': '"', '\u201E': '"',
  '\u2013': '-', '\u2014': '-', '\u2212': '-', '\u2026': '...', '\u2022': '-', '\u00A0': ' ',
  '\u00D7': 'x', '\u00B7': '-', '\u20B1': 'PHP',
};

/** Anything WinAnsi cannot represent becomes a question mark rather than corrupting the stream. */
export function toWinAnsi(value: string): string {
  let out = '';
  for (const character of value) {
    const mapped = WIN_ANSI[character];
    if (mapped !== undefined) { out += mapped; continue; }
    out += (character.codePointAt(0) ?? 63) < 256 ? character : '?';
  }
  return out;
}

export function textWidth(value: string, size: number): number {
  let total = 0;
  for (const character of value) total += WIDTHS[character] ?? 556;
  return (total * size) / 1000;
}

/** Truncates with an ellipsis, so a clipped value still reads as clipped. */
export function fit(value: string, size: number, maxWidth: number): string {
  if (textWidth(value, size) <= maxWidth) return value;
  let out = '';
  for (const character of value) {
    if (textWidth(`${out}${character}...`, size) > maxWidth) break;
    out += character;
  }
  return `${out}...`;
}

/** A PDF string literal: the delimiters themselves have to be escaped, or the file is malformed. */
export const escapePdf = (value: string) => value.replace(/[\\()]/g, '\\$&');

/**
 * Wraps text to a column width and returns the lines, so a long subscriber name or void
 * reason runs down the document instead of being silently cut at the first word.
 *
 * Words longer than the column (a long unbroken reference) are broken by character, because
 * a receipt whose reference is unreadable is worse than one that has been hyphenated. Past
 * `maxLines` the text is truncated, so an unexpectedly long reason cannot run a page off
 * the bottom of the paper.
 */
export function wrapText(value: string, size: number, maxWidth: number, maxLines = 6): string[] {
  const lines: string[] = [];
  let current = '';
  const flush = () => { if (current !== '') { lines.push(current); current = ''; } };

  for (const word of value.split(/\s+/).filter(Boolean)) {
    if (textWidth(current === '' ? word : `${current} ${word}`, size) <= maxWidth) {
      current = current === '' ? word : `${current} ${word}`;
      continue;
    }
    flush();
    if (textWidth(word, size) <= maxWidth) { current = word; continue; }
    let piece = '';
    for (const character of word) {
      if (textWidth(`${piece}${character}`, size) > maxWidth) { lines.push(piece); piece = ''; }
      piece += character;
    }
    current = piece;
  }
  flush();

  if (lines.length <= maxLines) return lines;
  // Over the limit: the last surviving line is clipped and marked, rather than the text
  // simply stopping, so a truncated reason is visible as a truncated reason.
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = fit(`${kept[maxLines - 1]}...`, size, maxWidth);
  return kept;
}

export type PdfLine = { font: 'F1' | 'F2'; size: number; x: number; y: number; text: string };
export type PdfRule = { kind: 'line' | 'fill'; x1: number; y1: number; x2: number; y2: number; size: number };
export type PdfPage = { lines: PdfLine[]; rules: PdfRule[] };

/**
 * Serialises one page's commands into a PDF content stream.
 *
 * The footer is positioned rather than left to a default, because the two documents put it
 * in different places: a landscape report numbers its pages in the margin, while a portrait
 * receipt leaves that corner to the signature line.
 */
export function renderStream(page: PdfPage, footer: { text: string; x: number; y: number }): string {
  const parts = ['q', '0.5 w', '0.15 0.15 0.2 RG'];
  for (const rule of page.rules) {
    if (rule.kind === 'fill') { parts.push('0.955 0.958 0.97 rg', `${rule.x1} ${rule.y1} ${rule.x2 - rule.x1} ${rule.size} re`, 'f'); continue; }
    parts.push(`${rule.size} w`, `${rule.x1} ${rule.y1} m ${rule.x2} ${rule.y2} l S`);
  }
  parts.push('0 0 0 rg');
  for (const line of page.lines) parts.push('BT', `/${line.font} ${line.size} Tf`, `${line.x.toFixed(2)} ${line.y.toFixed(2)} Td`, `(${line.text}) Tj`, 'ET');
  parts.push('Q', 'BT /F1 7 Tf', `${footer.x.toFixed(2)} ${footer.y.toFixed(2)} Td`, `(${footer.text}) Tj`, 'ET');
  return parts.join('\n');
}

/**
 * Serialises the objects, the cross-reference table and the trailer of a PDF 1.4 file.
 *
 * The cross-reference offsets are byte positions, so they are accumulated from the length
 * of what has actually been written rather than estimated: an offset that is wrong by one
 * byte produces a file most readers open anyway, which is the worst outcome, because the
 * corruption is invisible until someone archives it.
 */
export function assemblePdf(content: string[], page: PageGeometry, title: string): Buffer {
  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };

  const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const contentIds = content.map((stream) => {
    const bytes = Buffer.from(stream, 'latin1');
    return add(`<< /Length ${bytes.length} >>\nstream\n${bytes.toString('latin1')}\nendstream`);
  });
  // The parent is patched below, once the page numbers are known.
  const pageIds = contentIds.map((id) => add(
    `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${id} 0 R >>`,
  ));
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pageIds.forEach((id) => { objects[id - 1] = objects[id - 1]!.replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`); });
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const infoId = add(`<< /Type /Info /Title (BCIS ${escapePdf(title)}) /Producer (BCIS Subscription Billing System) >>`);

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let position = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    const bytes = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    offsets.push(position);
    chunks.push(bytes);
    position += bytes.length;
  });

  const xrefStart = position;
  chunks.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n` +
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
    'latin1',
  ));
  return Buffer.concat(chunks);
}
