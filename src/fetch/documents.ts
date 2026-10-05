/**
 * Document parsing.
 *
 * Turns the file formats a model is most often pointed at into Markdown or
 * plain text, with no native dependencies and no external services:
 *
 *   PDF   -> unpdf (a bundled, pure-JS pdf.js build), loaded lazily
 *   DOCX  -> zip + `word/document.xml` (headings, lists and tables preserved)
 *   XLSX  -> zip + shared strings + per-sheet XML, rendered as Markdown tables
 *   PPTX  -> zip + per-slide XML, one section per slide
 *   EPUB  -> zip + OPF spine order, each chapter through the HTML pipeline
 *   ODT   -> zip + `content.xml`
 *   CSV   -> RFC-4180-ish parser rendered as a Markdown table
 *   JSON  -> pretty-printed, with a compact preview for very large payloads
 *
 * Everything reads from a `Uint8Array` so the same code path serves a remote
 * URL, a local file and a cached copy.
 */

import { unzipSync, strFromU8, type Unzipped } from 'fflate';
import type { DocumentInfo } from '../types.js';
import { decodeEntities, htmlToMarkdown } from '../html/markdown.js';
import { collapseWhitespace, tidyMarkdown, truncate } from '../util/text.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('documents');

export type DocumentKind = DocumentInfo['kind'];

/** Detect the document kind from a content type and/or a file name. */
export function detectDocumentKind(contentType: string, fileNameOrUrl = ''): DocumentKind {
  const ct = (contentType || '').toLowerCase().split(';')[0]!.trim();
  const name = fileNameOrUrl.toLowerCase().split(/[?#]/)[0]!;
  const ext = /\.([a-z0-9]{1,5})$/.exec(name)?.[1] ?? '';

  if (ct === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (ct.includes('wordprocessingml') || ct === 'application/msword' || ext === 'docx') return 'docx';
  if (ct.includes('spreadsheetml') || ct === 'application/vnd.ms-excel' || ext === 'xlsx') return 'xlsx';
  if (ct.includes('presentationml') || ct === 'application/vnd.ms-powerpoint' || ext === 'pptx') return 'pptx';
  if (ct === 'application/epub+zip' || ext === 'epub') return 'epub';
  if (ct === 'application/vnd.oasis.opendocument.text' || ext === 'odt') return 'odt';
  if (ct === 'text/csv' || ext === 'csv') return 'csv';
  if (ct === 'application/json' || ct.endsWith('+json') || ext === 'json') return 'json';
  if (ct === 'text/html' || ct === 'application/xhtml+xml' || ext === 'html' || ext === 'htm' || ext === 'xhtml') return 'html';
  if (ct.startsWith('text/') || ['txt', 'md', 'markdown', 'rst', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'tex'].includes(ext)) {
    return 'text';
  }
  // A zip-ish content type with an unknown name: sniffing happens in `parseDocument`.
  if (ct.includes('zip') || ct === 'application/octet-stream') return 'unknown';
  return 'unknown';
}

export interface ParsedDocument {
  markdown: string;
  info: DocumentInfo;
  title?: string;
}

export interface ParseDocumentOptions {
  /** File name or URL, used for extension-based detection and titles. */
  name?: string;
  contentType?: string;
  /** Hard cap on the returned characters (default 200 000). */
  maxChars?: number;
}

/**
 * Parse a document buffer into Markdown.
 *
 * `kind` is auto-detected but can be overridden by the caller. Unknown binary
 * payloads produce an explanatory message rather than an exception, because a
 * model asking to read a `.doc` file should be told *why* it cannot.
 */
export async function parseDocument(
  bytes: Uint8Array,
  options: ParseDocumentOptions = {},
): Promise<ParsedDocument> {
  const maxChars = options.maxChars ?? 200_000;
  const name = options.name ?? '';
  let kind = detectDocumentKind(options.contentType ?? '', name);

  // Sniff the ZIP magic: office files are routinely served as octet-stream.
  if (kind === 'unknown' && bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    kind = await sniffZipKind(bytes);
  }

  switch (kind) {
    case 'pdf':
      return finish(await parsePdf(bytes), { kind: 'pdf' }, maxChars);
    case 'docx':
      return finish(parseDocx(bytes), { kind: 'docx' }, maxChars);
    case 'xlsx':
      return finish(parseXlsx(bytes), { kind: 'xlsx' }, maxChars);
    case 'pptx':
      return finish(parsePptx(bytes), { kind: 'pptx' }, maxChars);
    case 'epub':
      return finish(await parseEpub(bytes), { kind: 'epub' }, maxChars);
    case 'odt':
      return finish(parseOdt(bytes), { kind: 'odt' }, maxChars);
    case 'csv':
      return finish(csvToMarkdown(str(bytes)), { kind: 'csv' }, maxChars);
    case 'json':
      return finish(jsonToMarkdown(str(bytes)), { kind: 'json' }, maxChars);
    case 'html':
      return finish(htmlToMarkdown(str(bytes), { url: name }).markdown, { kind: 'html' }, maxChars);
    case 'text':
      return finish(str(bytes), { kind: 'text' }, maxChars);
    default: {
      const text = str(bytes);
      // Mostly-printable bytes are probably text with a wrong content type.
      const printable = (text.match(/[\t\n\r\x20-\x7e\u00a0-\uffff]/g) ?? []).length;
      if (text.length > 0 && printable / text.length > 0.9) {
        return finish(text, { kind: 'text' }, maxChars);
      }
      return finish(
        `_Unsupported binary document${name ? `: ${name}` : ''} (${bytes.length} bytes, detected type "${options.contentType || 'unknown'}"). ` +
          'Supported formats: PDF, DOCX, XLSX, PPTX, EPUB, ODT, CSV, JSON, HTML and plain text._',
        { kind: 'unknown' },
        maxChars,
      );
    }
  }
}

function finish(markdown: string, partial: Partial<DocumentInfo>, maxChars: number): ParsedDocument {
  const cleaned = tidyMarkdown(markdown);
  const info: DocumentInfo = { kind: partial.kind ?? 'unknown', chars: cleaned.length, ...partial };
  const body = cleaned.length > maxChars ? truncate(cleaned, maxChars) : cleaned;
  const title = firstHeading(body);
  return title ? { markdown: body, info, title } : { markdown: body, info };
}

function firstHeading(markdown: string): string | undefined {
  const m = /^#{1,3}\s+(.{3,160})$/m.exec(markdown);
  return m?.[1]?.trim();
}

function str(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/* ------------------------------------------------------------------ *
 * ZIP container sniffing
 * ------------------------------------------------------------------ */

async function sniffZipKind(bytes: Uint8Array): Promise<DocumentKind> {
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name.endsWith('.xml') || f.name.endsWith('.opf') });
    if (files['word/document.xml']) return 'docx';
    if (Object.keys(files).some((n) => n.startsWith('xl/worksheets/'))) return 'xlsx';
    if (Object.keys(files).some((n) => n.startsWith('ppt/slides/'))) return 'pptx';
    if (files['content.xml']) return 'odt';
    if (files['META-INF/container.xml'] || Object.keys(files).some((n) => n.endsWith('.opf'))) return 'epub';
  } catch (err) {
    log.debug(`zip sniff failed: ${(err as Error).message}`);
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ *
 * XML helpers
 * ------------------------------------------------------------------ */

/** Extract the text of every `<tag>` occurrence, XML-unescaping the content. */
function xmlTexts(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  for (const m of xml.matchAll(re)) out.push(decodeEntities(m[1] ?? ''));
  return out;
}

/** Collapse Word's run-splitting: `<w:t>Hel</w:t><w:t>lo</w:t>` is one word. */
function paragraphText(paragraphXml: string): string {
  const runs: string[] = [];
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/gi;
  for (const m of paragraphXml.matchAll(re)) {
    if (m[0].startsWith('<w:tab')) runs.push('\t');
    else if (m[0].startsWith('<w:br')) runs.push('\n');
    else runs.push(decodeEntities(m[1] ?? ''));
  }
  return runs.join('');
}

function headingLevel(paragraphXml: string): number | undefined {
  const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/i.exec(paragraphXml)?.[1];
  if (!style) {
    // Fall back to the outline level some generators use.
    const outline = /<w:outlineLvl\b[^>]*w:val="(\d)"/i.exec(paragraphXml)?.[1];
    if (outline) return Math.min(6, Number(outline) + 1);
    return undefined;
  }
  if (/^(?:Title|Heading1|Heading 1)$/i.test(style)) return 1;
  const m = /^Heading\s*(\d)$/i.exec(style);
  if (m) return Math.min(6, Number(m[1]));
  if (/^Title$/i.test(style)) return 1;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * DOCX
 * ------------------------------------------------------------------ */

export function parseDocx(bytes: Uint8Array): string {
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    return `_Could not read DOCX archive: ${(err as Error).message}_`;
  }
  const documentXml = files['word/document.xml'];
  if (!documentXml) return '_DOCX archive has no word/document.xml._';
  const xml = strFromU8(documentXml);

  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/i.exec(xml)?.[1] ?? xml;
  const blocks: string[] = [];

  // Walk paragraphs and tables in document order.
  const blockRe = /<w:(p|tbl)\b[^>]*(?:\/>|>([\s\S]*?)<\/w:\1>)/gi;
  for (const match of body.matchAll(blockRe)) {
    const tag = match[1]!.toLowerCase();
    const inner = match[2] ?? '';
    if (tag === 'tbl') {
      const rows: string[][] = [];
      const rowRe = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi;
      for (const rowMatch of inner.matchAll(rowRe)) {
        const cells: string[] = [];
        const cellRe = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi;
        for (const cellMatch of rowMatch[1]!.matchAll(cellRe)) {
          const cellXml = cellMatch[1]!;
          // Paragraph text joined with spaces is more readable inside a table
          // cell than the run-merged version, so prefer it.
          const paragraphs = xmlTexts(cellXml, 'w:p')
            .map((p) => paragraphText(p).replace(/\n+/g, ' ').trim())
            .filter(Boolean);
          cells.push(paragraphs.length ? paragraphs.join(' ') : paragraphText(cellXml).trim());
        }
        if (cells.length) rows.push(cells);
      }
      const table = rowsToMarkdownTable(rows);
      if (table) blocks.push(table);
      continue;
    }

    const text = paragraphText(inner).replace(/\n+/g, ' ').trim();
    if (!text) continue;
    const level = headingLevel(inner);
    const isList = /<w:numPr\b/i.test(inner);
    if (level) blocks.push(`${'#'.repeat(level)} ${text}`);
    else if (isList) blocks.push(`- ${text}`);
    else blocks.push(text);
  }

  // Headers/footers carry the document title surprisingly often.
  const coreXml = files['docProps/core.xml'];
  if (coreXml) {
    const title = xmlTexts(strFromU8(coreXml), 'dc:title')[0]?.trim();
    if (title && !blocks.some((b) => b.includes(title))) blocks.unshift(`# ${title}`);
  }

  return blocks.join('\n\n');
}

function rowsToMarkdownTable(rows: string[][]): string {
  const filtered = rows.filter((r) => r.some((c) => c.trim()));
  if (filtered.length === 0) return '';
  const width = Math.max(...filtered.map((r) => r.length));
  const normalised = filtered.map((r) => [...r, ...Array<string>(width - r.length).fill('')]);
  const escape = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
  const header = normalised[0]!;
  const lines = [
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...normalised.slice(1).map((r) => `| ${r.map(escape).join(' | ')} |`),
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * XLSX
 * ------------------------------------------------------------------ */

export function parseXlsx(bytes: Uint8Array, options: { maxRows?: number; maxCols?: number } = {}): string {
  const maxRows = options.maxRows ?? 200;
  const maxCols = options.maxCols ?? 30;
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    return `_Could not read XLSX archive: ${(err as Error).message}_`;
  }

  const shared: string[] = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of xmlTexts(strFromU8(files['xl/sharedStrings.xml']), 'si')) {
      // A shared string can be split across runs.
      shared.push(xmlTexts(si, 't').join(''));
    }
  }

  // Sheet name -> sheet file, via workbook.xml + relationships.
  const sheetNames = new Map<string, string>();
  if (files['xl/workbook.xml']) {
    const wb = strFromU8(files['xl/workbook.xml']);
    const rels = files['xl/_rels/workbook.xml.rels'] ? strFromU8(files['xl/_rels/workbook.xml.rels']) : '';
    const relMap = new Map<string, string>();
    for (const m of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/gi)) {
      relMap.set(m[1]!, m[2]!);
    }
    let index = 0;
    for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/gi)) {
      const tag = m[0];
      const name = /name="([^"]*)"/i.exec(tag)?.[1] ?? `Sheet${index + 1}`;
      const rid = /r:id="([^"]+)"/i.exec(tag)?.[1];
      const target = rid ? relMap.get(rid) : undefined;
      const path = target
        ? `xl/${target.replace(/^\/?xl\//, '').replace(/^\//, '')}`
        : `xl/worksheets/sheet${index + 1}.xml`;
      sheetNames.set(path, decodeEntities(name));
      index++;
    }
  }

  const sections: string[] = [];
  const sheetPaths = Object.keys(files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => {
      const na = Number(/(\d+)/.exec(a)?.[1] ?? 0);
      const nb = Number(/(\d+)/.exec(b)?.[1] ?? 0);
      return na - nb;
    });

  const sheetsInfo: { name: string; rows: number; cols: number }[] = [];

  for (const path of sheetPaths) {
    const xml = strFromU8(files[path]!);
    const name = sheetNames.get(path) ?? path.replace(/^xl\/worksheets\//, '').replace(/\.xml$/, '');
    const rows: string[][] = [];
    const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
    for (const rowMatch of xml.matchAll(rowRe)) {
      if (rows.length >= maxRows) break;
      const cells: string[] = [];
      const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/gi;
      for (const cellMatch of rowMatch[1]!.matchAll(cellRe)) {
        const attrs = cellMatch[1] ?? '';
        const inner = cellMatch[2] ?? '';
        const type = /t="([^"]+)"/i.exec(attrs)?.[1];
        const column = /r="([A-Z]+)\d+"/i.exec(attrs)?.[1];
        const colIndex = column ? columnToIndex(column) : cells.length;
        // Pad for skipped empty cells so columns stay aligned.
        while (cells.length < colIndex && cells.length < maxCols) cells.push('');
        if (cells.length >= maxCols) continue;
        let value = '';
        if (type === 's') {
          const idx = Number(xmlTexts(inner, 'v')[0] ?? '-1');
          value = shared[idx] ?? '';
        } else if (type === 'inlineStr') {
          value = xmlTexts(inner, 't').join('');
        } else if (type === 'str') {
          value = xmlTexts(inner, 'v')[0] ?? '';
        } else {
          value = xmlTexts(inner, 'v')[0] ?? '';
        }
        cells.push(collapseWhitespace(value));
      }
      rows.push(cells);
    }
    if (rows.length === 0) continue;
    const width = Math.max(...rows.map((r) => r.length));
    sheetsInfo.push({ name, rows: rows.length, cols: width });
    sections.push(`## ${name}\n\n${rowsToMarkdownTable(rows)}`);
    if (rows.length >= maxRows) sections.push(`_…truncated at ${maxRows} rows._`);
  }

  if (sections.length === 0) return '_XLSX archive contained no readable worksheets._';
  const summary = sheetsInfo.map((s) => `${s.name} (${s.rows}×${s.cols})`).join(', ');
  return `# Spreadsheet\n\n_Sheets: ${summary}_\n\n${sections.join('\n\n')}`;
}

function columnToIndex(column: string): number {
  let index = 0;
  for (const ch of column.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/* ------------------------------------------------------------------ *
 * PPTX
 * ------------------------------------------------------------------ */

export function parsePptx(bytes: Uint8Array): string {
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    return `_Could not read PPTX archive: ${(err as Error).message}_`;
  }
  const slidePaths = Object.keys(files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)?.[1] ?? 0) - Number(/(\d+)/.exec(b)?.[1] ?? 0));
  if (slidePaths.length === 0) return '_PPTX archive contained no slides._';

  const sections: string[] = [];
  slidePaths.forEach((path, index) => {
    const xml = strFromU8(files[path]!);
    const paragraphs = xmlTexts(xml, 'a:p');
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
      const text = xmlTexts(paragraph, 'a:t').join('').trim();
      if (text) lines.push(text);
    }
    const heading = lines[0] ?? `Slide ${index + 1}`;
    const rest = lines.slice(1);
    sections.push(`## ${index + 1}. ${heading}${rest.length ? `\n\n${rest.map((l) => `- ${l}`).join('\n')}` : ''}`);
  });

  return `# Presentation (${slidePaths.length} slides)\n\n${sections.join('\n\n')}`;
}

/* ------------------------------------------------------------------ *
 * EPUB / ODT
 * ------------------------------------------------------------------ */

export async function parseEpub(bytes: Uint8Array): Promise<string> {
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    return `_Could not read EPUB archive: ${(err as Error).message}_`;
  }

  // Locate the OPF package document.
  let opfPath = Object.keys(files).find((n) => n.endsWith('.opf'));
  const container = files['META-INF/container.xml'];
  if (container) {
    const rootfile = /full-path="([^"]+)"/i.exec(strFromU8(container))?.[1];
    if (rootfile && files[rootfile]) opfPath = rootfile;
  }

  let spineHrefs: string[] = [];
  let title: string | undefined;
  const baseDir = opfPath ? opfPath.replace(/[^/]+$/, '') : '';

  if (opfPath && files[opfPath]) {
    const opf = strFromU8(files[opfPath]!);
    title = xmlTexts(opf, 'dc:title')[0]?.trim();
    const manifest = new Map<string, string>();
    for (const m of opf.matchAll(/<item\b[^>]*\/?>/gi)) {
      const id = /id="([^"]+)"/i.exec(m[0])?.[1];
      const href = /href="([^"]+)"/i.exec(m[0])?.[1];
      if (id && href) manifest.set(id, href);
    }
    for (const m of opf.matchAll(/<itemref\b[^>]*\/?>/gi)) {
      const idref = /idref="([^"]+)"/i.exec(m[0])?.[1];
      const href = idref ? manifest.get(idref) : undefined;
      if (href) spineHrefs.push(href);
    }
  }

  // Fall back to document order when there is no usable spine.
  if (spineHrefs.length === 0) {
    spineHrefs = Object.keys(files)
      .filter((n) => /\.x?html?$/i.test(n))
      .sort();
  }

  const chapters: string[] = [];
  for (const href of spineHrefs) {
    const clean = href.split('#')[0]!;
    const candidates = [`${baseDir}${clean}`, clean];
    const path = candidates.find((c) => files[c]);
    if (!path) continue;
    const html = strFromU8(files[path]!);
    const article = htmlToMarkdown(html, { url: `epub://${path}` });
    const body = article.markdown.trim();
    if (body.length < 40) continue; // skip cover/nav pages
    chapters.push(body);
    if (chapters.join('\n\n').length > 150_000) break;
  }

  if (chapters.length === 0) return '_EPUB archive contained no readable chapters._';
  const heading = title ? `# ${title}\n\n` : '';
  return `${heading}${chapters.join('\n\n---\n\n')}`;
}

export function parseOdt(bytes: Uint8Array): string {
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch (err) {
    return `_Could not read ODT archive: ${(err as Error).message}_`;
  }
  const content = files['content.xml'];
  if (!content) return '_ODT archive has no content.xml._';
  const xml = strFromU8(content);
  const blocks: string[] = [];
  for (const m of xml.matchAll(/<text:(h|p)\b[^>]*>([\s\S]*?)<\/text:\1>/gi)) {
    const tag = m[1]!.toLowerCase();
    const text = xmlTexts(m[2]!, 'text:span').length
      ? xmlTexts(m[2]!, 'text:span').join('')
      : collapseWhitespace(decodeEntities((m[2] ?? '').replace(/<[^>]+>/g, '')));
    const value = text.trim();
    if (!value) continue;
    if (tag === 'h') {
      const level = Number(/<text:h\b[^>]*text:outline-level="(\d)"/i.exec(m[0])?.[1] ?? 1);
      blocks.push(`${'#'.repeat(Math.min(6, Math.max(1, level)))} ${value}`);
    } else {
      blocks.push(value);
    }
  }
  return blocks.join('\n\n');
}

/* ------------------------------------------------------------------ *
 * CSV / JSON
 * ------------------------------------------------------------------ */

/** RFC 4180-ish CSV/TSV parser: quoted fields, escaped quotes, CRLF. */
export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'));
  const delim =
    delimiter ??
    (() => {
      const counts: [string, number][] = [',', '\t', ';', '|'].map((d) => [d, firstLine.split(d).length]);
      counts.sort((a, b) => b[1] - a[1]);
      return counts[0]![1] > 1 ? counts[0]![0] : ',';
    })();

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function csvToMarkdown(text: string, options: { maxRows?: number; maxCols?: number } = {}): string {
  const rows = parseDelimited(text);
  if (rows.length === 0) return '_Empty CSV._';
  const maxRows = options.maxRows ?? 500;
  const maxCols = options.maxCols ?? 30;
  const trimmed = rows.slice(0, maxRows).map((r) => r.slice(0, maxCols));
  const table = rowsToMarkdownTable(trimmed);
  const note = rows.length > maxRows ? `\n\n_…${rows.length - maxRows} more rows omitted._` : '';
  return `${table}${note}`;
}

export function jsonToMarkdown(text: string, maxChars = 100_000): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return `_Invalid JSON: ${(err as Error).message}_\n\n\`\`\`\n${truncate(text, 4000)}\n\`\`\``;
  }
  const pretty = JSON.stringify(parsed, null, 2);
  if (pretty.length <= maxChars) return `\`\`\`json\n${pretty}\n\`\`\``;

  // Large payloads: describe the shape, then show a bounded sample. A model
  // reading a 5 MB API dump needs the schema far more than the whole body.
  const summary = describeJsonShape(parsed);
  return `_JSON payload is ${pretty.length} characters; showing its shape and the first ${maxChars} characters._\n\n${summary}\n\n\`\`\`json\n${truncate(pretty, maxChars)}\n\`\`\``;
}

/** One-line-per-key description of a JSON value's structure. */
export function describeJsonShape(value: unknown, depth = 0, maxDepth = 3): string {
  const indent = '  '.repeat(depth);
  if (value === null) return `${indent}null`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}[] (empty array)`;
    if (depth >= maxDepth) return `${indent}array[${value.length}]`;
    return `${indent}array[${value.length}] of:\n${describeJsonShape(value[0], depth + 1, maxDepth)}`;
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return `${indent}object`;
    const entries = Object.entries(value as Record<string, unknown>);
    return entries
      .slice(0, 60)
      .map(([k, v]) => `${indent}${k}: ${typeof v === 'object' && v !== null ? `\n${describeJsonShape(v, depth + 1, maxDepth)}` : `${typeof v}`}`)
      .join('\n');
  }
  return `${indent}${typeof value}`;
}

/* ------------------------------------------------------------------ *
 * PDF
 * ------------------------------------------------------------------ */

/**
 * Extract text from a PDF.
 *
 * `unpdf` (a packaged pdf.js) is imported lazily: it is the largest dependency
 * in the tree and most sessions never open a PDF.
 */
export async function parsePdf(bytes: Uint8Array): Promise<string> {
  try {
    const unpdf = (await import('unpdf')) as {
      extractText: (data: Uint8Array, options?: { mergePages?: boolean }) => Promise<{ totalPages: number; text: string | string[] }>;
    };
    const result = await unpdf.extractText(bytes, { mergePages: true });
    const text = typeof result.text === 'string' ? result.text : result.text.join('\n\n');
    const cleaned = cleanPdfText(text);
    if (!cleaned) {
      return `_PDF contained ${result.totalPages} page(s) but no extractable text — it is probably a scanned image. OCR is not available locally._`;
    }
    return `# PDF document (${result.totalPages} pages)\n\n${cleaned}`;
  } catch (err) {
    log.debug(`pdf extraction failed: ${(err as Error).message}`);
    return `_Could not extract text from PDF: ${(err as Error).message}_`;
  }
}

/** Repair the hyphenation and column artefacts pdf.js tends to emit. */
export function cleanPdfText(text: string): string {
  return tidyMarkdown(
    (text || '')
      .replace(/\r\n?/g, '\n')
      // Re-join words split across a line break: "hyphen-\nation" -> "hyphenation"
      .replace(/([a-z])-\n([a-z])/g, '$1$2')
      // A single newline inside a sentence is usually a wrapped line, not a break.
      .replace(/([^\n.!?:;])\n(?=[a-z(])/g, '$1 ')
      // Page-number-only lines.
      .split('\n')
      .filter((line) => !/^\s*\d{1,4}\s*$/.test(line))
      .join('\n'),
  );
}

/** Best-effort page count without a full parse; undefined when unknown. */
export function estimatePdfPages(bytes: Uint8Array): number | undefined {
  try {
    const head = str(bytes.subarray(0, Math.min(bytes.length, 2_000_000)));
    const counts = [...head.matchAll(/\/Type\s*\/Page[^s]/g)].length;
    return counts > 0 ? counts : undefined;
  } catch {
    return undefined;
  }
}
