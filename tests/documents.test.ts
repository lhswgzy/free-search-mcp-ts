/**
 * Unit tests for `src/fetch/documents.ts`.
 *
 * The office fixtures are *built here* with `fflate.zipSync` rather than checked
 * in as binary blobs: a hand-written three-cell table states exactly which
 * behaviour is under test, and the file stays reviewable in a diff.
 */

import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  cleanPdfText,
  csvToMarkdown,
  describeJsonShape,
  detectDocumentKind,
  jsonToMarkdown,
  parseDelimited,
  parseDocx,
  parseDocument,
  parseEpub,
  parseOdt,
  parsePptx,
  parseXlsx,
} from '../src/fetch/documents.js';
import type { DocumentKind } from '../src/fetch/documents.js';

/** Zip a set of XML members into an office container. */
function zip(files: Record<string, string>): Uint8Array {
  const members: Record<string, Uint8Array> = {};
  for (const [name, body] of Object.entries(files)) members[name] = strToU8(body);
  return zipSync(members);
}

const DOCX = zip({
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue grew across every region this quarter.</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet point</w:t></w:r></w:p>
<w:p><w:r><w:t>Split ru</w:t></w:r><w:r><w:t>ns rejoin</w:t></w:r><w:r><w:t> correctly.</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Revenue</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>EMEA</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>APAC</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>95|9</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>`,
  'docProps/core.xml': `<cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly Report</dc:title></cp:coreProperties>`,
});

const XLSX = zip({
  'xl/workbook.xml': `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Totals" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  'xl/sharedStrings.xml': `<sst><si><t>Product</t></si><si><t>Units</t></si><si><t>Notes</t></si><si><t>Widget</t></si><si><t>Gadget</t></si></sst>`,
  'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2"><v>42</v></c></row>
<row r="3"><c r="A3" t="s"><v>4</v></c><c r="C3"><v>7</v></c></row>
</sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>3</v></c></row>
</sheetData></worksheet>`,
});

/** One `<a:p>` per line: the first paragraph is the slide heading. */
function slide(title: string, ...bullets: string[]): string {
  const paragraphs = [title, ...bullets]
    .map((text) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r></a:p>`)
    .join('');
  return `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${paragraphs}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}

const PPTX = zip({
  'ppt/slides/slide1.xml': slide('Welcome to the deck', 'First bullet', 'Second bullet'),
  'ppt/slides/slide2.xml': slide('Roadmap', 'Ship v1'),
  'ppt/slides/slide10.xml': slide('Appendix', 'Extra detail'),
});

describe('parseDocx', () => {
  const markdown = parseDocx(DOCX);

  it('produces an ATX heading from a paragraph style', () => {
    expect(markdown).toContain('# Quarterly Report');
  });

  it('produces a Markdown list item from a numbering paragraph', () => {
    expect(markdown).toContain('- First bullet point');
  });

  it('rejoins text runs that Word split mid-word', () => {
    expect(markdown).toContain('Split runs rejoin correctly.');
  });

  it('renders the 3x2 table with a header row and escaped pipes', () => {
    expect(markdown).toContain('| Region | Revenue |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| EMEA | 120 |');
    expect(markdown).toContain('| APAC | 95\\|9 |');
  });

  it('keeps document order: heading, prose, list, table', () => {
    const index = (needle: string) => markdown.indexOf(needle);
    expect(index('# Quarterly Report')).toBeLessThan(index('Revenue grew across every region'));
    expect(index('Revenue grew across every region')).toBeLessThan(index('- First bullet point'));
    expect(index('- First bullet point')).toBeLessThan(index('| Region | Revenue |'));
  });

  it('explains itself instead of throwing on a corrupt archive', () => {
    expect(parseDocx(new Uint8Array([1, 2, 3, 4]))).toMatch(/^_Could not read DOCX archive:/);
  });
});

describe('parseXlsx', () => {
  const markdown = parseXlsx(XLSX);

  it('emits one section per worksheet in sheet order', () => {
    expect(markdown).toContain('# Spreadsheet');
    expect(markdown).toContain('## Data');
    expect(markdown).toContain('## Totals');
    expect(markdown.indexOf('## Data')).toBeLessThan(markdown.indexOf('## Totals'));
  });

  it('summarises the sheet dimensions', () => {
    expect(markdown).toContain('_Sheets: Data (3×3), Totals (1×2)_');
  });

  it('includes the header row and resolves shared strings', () => {
    expect(markdown).toContain('| Product | Units | Notes |');
    expect(markdown).toContain('| --- | --- | --- |');
    expect(markdown).toContain('| Widget | 42 |  |');
  });

  it('keeps columns aligned when a cell is skipped in the XML', () => {
    expect(markdown).toContain('| Gadget |  | 7 |');
  });

  it('explains itself instead of throwing on a corrupt archive', () => {
    expect(parseXlsx(new Uint8Array([9, 9, 9]))).toMatch(/^_Could not read XLSX archive:/);
  });
});

describe('parsePptx', () => {
  const markdown = parsePptx(PPTX);

  it('emits one section per slide, headed by the slide title', () => {
    expect(markdown).toContain('# Presentation (3 slides)');
    expect(markdown).toContain('## 1. Welcome to the deck');
    expect(markdown).toContain('## 2. Roadmap');
  });

  it('turns the remaining paragraphs into list items', () => {
    expect(markdown).toContain('- First bullet');
    expect(markdown).toContain('- Second bullet');
    expect(markdown).toContain('- Ship v1');
  });

  it('orders slide10 after slide2, not lexicographically', () => {
    expect(markdown).toContain('## 3. Appendix');
    expect(markdown.indexOf('## 2. Roadmap')).toBeLessThan(markdown.indexOf('## 3. Appendix'));
  });

  it('explains an archive with no slides', () => {
    expect(parsePptx(zip({ 'ppt/presentation.xml': '<p:presentation/>' }))).toBe('_PPTX archive contained no slides._');
  });
});

describe('parseOdt and parseEpub', () => {
  it('renders ODT headings and paragraphs', () => {
    const odt = zip({
      'content.xml': `<office:document-content><office:body><text:h text:outline-level="1">Release notes</text:h><text:p>Two things changed this week.</text:p></office:body></office:document-content>`,
    });
    const markdown = parseOdt(odt);
    expect(markdown).toContain('# Release notes');
    expect(markdown).toContain('Two things changed this week.');
  });

  it('reads an EPUB spine in order and keeps the book title', async () => {
    const epub = zip({
      'META-INF/container.xml': `<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>`,
      'OEBPS/content.opf': `<package><metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">A Small Book</dc:title></metadata><manifest><item id="c1" href="chapter1.xhtml"/><item id="c2" href="chapter2.xhtml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`,
      'OEBPS/chapter1.xhtml': `<html><body><article><h1>Chapter One</h1><p>This chapter has enough prose to survive the length filter that skips covers and navigation pages.</p></article></body></html>`,
      'OEBPS/chapter2.xhtml': `<html><body><article><h1>Chapter Two</h1><p>The second chapter also carries a reasonable amount of text so that it is kept in the output.</p></article></body></html>`,
    });
    const markdown = await parseEpub(epub);
    expect(markdown).toContain('# A Small Book');
    expect(markdown).toContain('Chapter One');
    expect(markdown).toContain('Chapter Two');
    expect(markdown.indexOf('Chapter One')).toBeLessThan(markdown.indexOf('Chapter Two'));
  });
});

describe('parseDelimited and csvToMarkdown', () => {
  it('keeps a comma inside a quoted field', () => {
    expect(parseDelimited('name,role\n"Lovelace, Ada",Engineer')).toEqual([
      ['name', 'role'],
      ['Lovelace, Ada', 'Engineer'],
    ]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseDelimited('quote,ok\n"He said ""hi""",yes')).toEqual([
      ['quote', 'ok'],
      ['He said "hi"', 'yes'],
    ]);
  });

  it('handles CRLF line endings and a trailing newline', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('sniffs a semicolon delimiter', () => {
    expect(parseDelimited('a;b;c\n1;2;3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('sniffs a tab delimiter for TSV', () => {
    expect(parseDelimited('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('strips a UTF-8 BOM from the first header cell', () => {
    expect(parseDelimited('\ufeffa,b\n1,2')[0]).toEqual(['a', 'b']);
  });

  it('renders a Markdown table and escapes pipes inside cells', () => {
    const markdown = csvToMarkdown('name,note\nAda,"a|b"');
    expect(markdown).toContain('| name | note |');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| Ada | a\\|b |');
  });

  it('says so when there is nothing to render', () => {
    expect(csvToMarkdown('')).toBe('_Empty CSV._');
  });
});

describe('jsonToMarkdown and describeJsonShape', () => {
  it('fences a small payload as pretty-printed JSON', () => {
    const markdown = jsonToMarkdown('{"count":2,"items":["a","b"]}');
    expect(markdown.startsWith('```json')).toBe(true);
    expect(markdown).toContain('"count": 2');
    expect(markdown.trimEnd().endsWith('```')).toBe(true);
  });

  it('summarises the shape of a payload that is too large to inline', () => {
    const large = JSON.stringify({ users: [{ name: 'Ada', age: 36 }], meta: { total: 1 } });
    const markdown = jsonToMarkdown(large, 40);
    expect(markdown).toContain('showing its shape');
    expect(markdown).toContain('users:');
    expect(markdown).toContain('array[1] of:');
    expect(markdown).toContain('name: string');
    expect(markdown).toContain('age: number');
    expect(markdown).toContain('total: number');
  });

  it('reports invalid JSON rather than throwing', () => {
    expect(jsonToMarkdown('{not json')).toMatch(/^_Invalid JSON:/);
  });

  it('describes nested objects and arrays one level at a time', () => {
    const shape = describeJsonShape({ a: 1, b: 'x', c: true, d: null, e: [1, 2], f: { g: 1 } });
    expect(shape).toContain('a: number');
    expect(shape).toContain('b: string');
    expect(shape).toContain('c: boolean');
    expect(shape).toContain('d: object');
    expect(shape).toContain('array[2] of:');
    expect(shape).toContain('g: number');
  });

  it('stops recursing at maxDepth and handles the empty cases', () => {
    expect(describeJsonShape([])).toBe('[] (empty array)');
    expect(describeJsonShape({})).toBe('');
    // At the depth limit the value is described, not descended into.
    expect(describeJsonShape([1, 2, 3], 3, 3).trim()).toBe('array[3]');
    expect(describeJsonShape({ a: { b: 1 } }, 3, 3).trim()).toBe('object');
  });
});

describe('detectDocumentKind', () => {
  const cases: [string, string, DocumentKind][] = [
    ['application/pdf', 'report.pdf', 'pdf'],
    ['', 'https://example.com/files/paper.pdf?token=1#p2', 'pdf'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '', 'docx'],
    ['application/msword', 'old.doc', 'docx'],
    ['', 'notes.docx', 'docx'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '', 'xlsx'],
    ['application/vnd.ms-excel', 'legacy.xls.xlsx', 'xlsx'],
    ['', 'book.xlsx', 'xlsx'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '', 'pptx'],
    ['', 'deck.pptx', 'pptx'],
    ['application/epub+zip', '', 'epub'],
    ['', 'novel.epub', 'epub'],
    ['application/vnd.oasis.opendocument.text', '', 'odt'],
    ['', 'letter.odt', 'odt'],
    ['text/csv', '', 'csv'],
    ['', 'export.csv', 'csv'],
    ['application/json', '', 'json'],
    ['application/ld+json', '', 'json'],
    ['', 'payload.json', 'json'],
    ['text/html', '', 'html'],
    ['application/xhtml+xml', '', 'html'],
    ['text/html; charset=utf-8', '', 'html'],
    ['', 'index.htm', 'html'],
    ['', 'page.xhtml', 'html'],
    ['text/plain', '', 'text'],
    ['', 'README.md', 'text'],
    ['', 'server.log', 'text'],
    ['application/octet-stream', '', 'unknown'],
    ['application/octet-stream', 'blob.zip', 'unknown'],
    ['application/zip', '', 'unknown'],
    ['', '', 'unknown'],
  ];

  it.each(cases)('maps %j / %j to %s', (contentType, name, expected) => {
    expect(detectDocumentKind(contentType, name)).toBe(expected);
  });
});

describe('cleanPdfText', () => {
  it('re-joins a word split across a line break by a hyphen', () => {
    expect(cleanPdfText('The hyphen-\nation rule applies here.')).toContain('hyphenation');
  });

  it('drops lines that are nothing but a page number', () => {
    const cleaned = cleanPdfText('First paragraph.\n\n12\n\nSecond paragraph.');
    expect(cleaned).not.toMatch(/^12$/m);
    expect(cleaned).toContain('First paragraph.');
    expect(cleaned).toContain('Second paragraph.');
  });

  it('normalises CRLF and joins a wrapped sentence', () => {
    expect(cleanPdfText('one\r\ntwo')).toBe('one two');
  });

  it('keeps a genuine paragraph break', () => {
    expect(cleanPdfText('Ends here.\nStarts again.')).toBe('Ends here.\nStarts again.');
  });
});

describe('parseDocument', () => {
  it('describes an unknown binary payload instead of throwing', async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x07]);
    const parsed = await parseDocument(bytes, { name: 'mystery.bin' });
    expect(parsed.info.kind).toBe('unknown');
    expect(parsed.markdown).toContain('Unsupported binary document');
    expect(parsed.markdown).toContain('mystery.bin');
    expect(parsed.markdown).toContain('Supported formats: PDF, DOCX');
  });

  it('sniffs a DOCX served as application/octet-stream', async () => {
    const parsed = await parseDocument(DOCX, { contentType: 'application/octet-stream' });
    expect(parsed.info.kind).toBe('docx');
    expect(parsed.markdown).toContain('# Quarterly Report');
    expect(parsed.title).toBe('Quarterly Report');
  });

  it('routes by content type for CSV, JSON and HTML', async () => {
    const csv = await parseDocument(new TextEncoder().encode('a,b\n1,2'), { contentType: 'text/csv' });
    expect(csv.info.kind).toBe('csv');
    expect(csv.markdown).toContain('| a | b |');

    const json = await parseDocument(new TextEncoder().encode('{"ok":true}'), { contentType: 'application/json' });
    expect(json.info.kind).toBe('json');
    expect(json.markdown).toContain('```json');

    const html = await parseDocument(new TextEncoder().encode('<html><body><h1>Title</h1><p>Body text.</p></body></html>'), {
      contentType: 'text/html',
    });
    expect(html.info.kind).toBe('html');
    expect(html.markdown).toContain('Body text.');
  });

  it('treats unknown-but-printable bytes as plain text', async () => {
    const parsed = await parseDocument(new TextEncoder().encode('just some words'), { contentType: 'application/x-weird' });
    expect(parsed.info.kind).toBe('text');
    expect(parsed.markdown).toBe('just some words');
  });

  it('truncates to maxChars but still reports the full length', async () => {
    const body = 'x'.repeat(500);
    const parsed = await parseDocument(new TextEncoder().encode(body), { contentType: 'text/plain', maxChars: 100 });
    expect(parsed.markdown.length).toBeLessThanOrEqual(100);
    expect(parsed.info.chars).toBe(500);
  });

  it('reports a PDF it cannot read instead of throwing', async () => {
    const parsed = await parseDocument(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x00]), {
      name: 'broken.pdf',
      contentType: 'application/pdf',
    });
    expect(parsed.info.kind).toBe('pdf');
    expect(parsed.markdown).toMatch(/^_(?:Could not extract text from PDF|PDF contained)/);
  });
});
