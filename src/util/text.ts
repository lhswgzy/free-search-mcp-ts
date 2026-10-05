/**
 * Text utilities: tokenisation, snippet shaping, passage scoring.
 *
 * The passage scorer powers `research()`: it decides which slices of a fetched
 * page are worth showing the model, which is the difference between a brief
 * that fits in 2 kB of token budget and a 40 kB dump.
 */

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could',
  'did', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if',
  'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'no', 'not', 'of', 'on',
  'or', 'our', 'out', 'should', 'so', 'than', 'that', 'the', 'their', 'them',
  'then', 'there', 'these', 'they', 'this', 'to', 'too', 'up', 'us', 'was',
  'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your', 'about', 'over', 'also', 'more', 'most', 'some',
  'such', 'only', 'other', 'any', 'all', 'each', 'very', 'may', 'might',
]);

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export function hasCJK(s: string): boolean {
  return CJK_RE.test(s);
}

/**
 * Split text into search terms.
 *
 * Latin text is lowercased and split on non-alphanumerics; CJK runs are split
 * into bigrams (a decent poor-man's segmentation that works with FTS5 and with
 * naive substring scoring alike).
 */
export function tokenize(text: string, opts: { keepStopwords?: boolean } = {}): string[] {
  const out: string[] = [];
  const normalized = (text || '').toLowerCase().normalize('NFKC');

  // Latin / digits.
  for (const m of normalized.matchAll(/[a-z0-9][a-z0-9'+._-]*/g)) {
    const tok = m[0].replace(/^[._'-]+|[._'-]+$/g, '');
    if (!tok) continue;
    if (!opts.keepStopwords && tok.length <= 2 && !/^\d+$/.test(tok)) continue;
    if (!opts.keepStopwords && STOPWORDS.has(tok)) continue;
    out.push(tok);
  }

  // CJK: unigrams are noisy, bigrams hit a good precision/recall balance.
  for (const m of normalized.matchAll(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g)) {
    const run = m[0];
    if (!opts.keepStopwords && run.length === 1) {
      out.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
    if (run.length === 1) out.push(run);
  }

  return out;
}

/** Distinct terms, order preserved. */
export function uniqueTerms(text: string): string[] {
  return [...new Set(tokenize(text))];
}

export function collapseWhitespace(s: string): string {
  return (s || '').replace(/\r\n?/g, '\n').replace(/[ \t\u00a0\u3000]+/g, ' ').trim();
}

/** Collapse runs of >2 blank lines, which HTML conversion produces a lot of. */
export function tidyMarkdown(md: string): string {
  return (md || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (!text) return '';
  if (text.length <= max) return text;
  const cut = text.slice(0, Math.max(0, max - ellipsis.length));
  // Prefer to cut at a paragraph or sentence boundary.
  const boundary = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '), cut.lastIndexOf('。'));
  if (boundary > max * 0.6) return cut.slice(0, boundary + 1).trimEnd() + ellipsis;
  return cut.trimEnd() + ellipsis;
}

/** Cheap token estimate: ~4 chars/token for latin, ~1.5 for CJK. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

/**
 * Split into sentences, keeping CJK terminators and avoiding the worst
 * abbreviation false-positives.
 */
export function splitSentences(text: string): string[] {
  const src = (text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  const parts = src
    .split(/(?<=[.!?。！？；;])\s+(?=[^\s])|(?<=[\u4e00-\u9fff])(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const merged: string[] = [];
  for (const p of parts) {
    const prev = merged[merged.length - 1];
    // Re-join splits caused by "e.g." / "i.e." / "vs." style abbreviations.
    if (prev && /\b(e\.g|i\.e|vs|etc|Mr|Ms|Dr|Fig|No|al)\.$/i.test(prev)) {
      merged[merged.length - 1] = `${prev} ${p}`;
    } else {
      merged.push(p);
    }
  }
  return merged;
}

/** Split markdown into paragraph-ish blocks, dropping code fences and nav crumbs. */
export function splitBlocks(markdown: string): { text: string; offset: number }[] {
  const blocks: { text: string; offset: number }[] = [];
  const lines = (markdown || '').split('\n');
  let buf: string[] = [];
  let offset = 0;
  let bufStart = 0;
  let inFence = false;

  const flush = () => {
    const text = buf.join('\n').trim();
    if (text) blocks.push({ text, offset: bufStart });
    buf = [];
  };

  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      // Keep code blocks out of the passage pool: they rarely answer a question.
      if (inFence) flush();
      continue;
    }
    if (inFence) continue;
    if (!line.trim()) {
      flush();
      bufStart = offset;
      continue;
    }
    if (buf.length === 0) bufStart = lineStart;
    buf.push(line);
  }
  flush();
  return blocks;
}

/**
 * Score how well a block answers a query.
 *
 * Combines: distinct query-term coverage (the dominant signal), term frequency
 * with saturation, a small bonus for numbers/dates (often the actual answer),
 * and a length prior that favours informative paragraphs over one-liners.
 */
export function scoreBlock(block: string, terms: string[], opts: { preferRecent?: boolean } = {}): number {
  if (!block || terms.length === 0) return 0;
  const lower = block.toLowerCase();
  const words = Math.max(1, lower.split(/\s+/).length);

  let coverage = 0;
  let hits = 0;
  for (const term of terms) {
    const occurrences = countOccurrences(lower, term);
    if (occurrences > 0) {
      coverage += 1;
      hits += Math.min(occurrences, 6);
    }
  }
  const coverageRatio = coverage / terms.length;
  const tf = hits / Math.sqrt(words);

  // Heading lines are strong signals; lists are usually answers too.
  const isHeading = /^#{1,6}\s/.test(block);
  const isList = /^(\s*[-*+]|\s*\d+\.)\s/m.test(block);
  const hasNumber = /\d/.test(block);

  const lengthPrior = Math.min(1, words / 25) * (words > 400 ? 0.6 : 1);

  let score =
    coverageRatio * 3.2 +
    Math.min(tf, 3) * 0.5 +
    (isHeading ? 0.7 : 0) +
    (isList ? 0.25 : 0) +
    (hasNumber ? 0.15 : 0);
  score *= lengthPrior;
  if (opts.preferRecent && /\b(20\d\d|19\d\d)\b/.test(block)) score += 0.1;

  // Exact phrase match is a very strong signal.
  const phrase = terms.join(' ');
  if (phrase.length > 8 && lower.includes(phrase)) score += 1.6;

  return score;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
    if (count > 50) break;
  }
  return count;
}

/**
 * Pick the best passages from a document for a query, without overlap.
 * Returns markdown-ready strings in document order.
 */
export function selectPassages(
  markdown: string,
  query: string,
  opts: { maxPassages?: number; maxCharsPerPassage?: number; maxTotalChars?: number } = {},
): { text: string; score: number; offset: number }[] {
  const maxPassages = opts.maxPassages ?? 4;
  const maxCharsPerPassage = opts.maxCharsPerPassage ?? 900;
  const maxTotalChars = opts.maxTotalChars ?? 2400;

  const terms = uniqueTerms(query);
  const blocks = splitBlocks(markdown);
  const scored = blocks
    .map((b) => ({ ...b, score: scoreBlock(b.text, terms) }))
    .filter((b) => b.score > 0.35)
    .sort((a, b) => b.score - a.score);

  const chosen: { text: string; score: number; offset: number }[] = [];
  let total = 0;
  const usedOffsets: { start: number; end: number }[] = [];

  for (const block of scored) {
    if (chosen.length >= maxPassages) break;
    if (total >= maxTotalChars) break;
    const start = block.offset;
    const end = start + block.text.length;
    const overlaps = usedOffsets.some((r) => start < r.end + 120 && end > r.start - 120);
    if (overlaps) continue;
    let text = block.text;
    if (text.length > maxCharsPerPassage) text = truncate(text, maxCharsPerPassage);
    // Small bonus for the very first block: it is usually the intro/summary.
    const isLead = blocks.length > 0 && block.offset === blocks[0]!.offset;
    chosen.push({ text, score: block.score + (isLead ? 0.2 : 0), offset: start });
    usedOffsets.push({ start, end });
    total += text.length;
  }

  // Fall back to the document lead when nothing scored (e.g. a one-word query).
  if (chosen.length === 0 && markdown.trim()) {
    const lead = truncate(markdown.trim(), maxCharsPerPassage);
    chosen.push({ text: lead, score: 0, offset: 0 });
  }

  return chosen.sort((a, b) => a.offset - b.offset);
}

/** Build a compact snippet from a longer body around the first query hit. */
export function makeSnippet(body: string, query: string, max = 320): string {
  const clean = collapseWhitespace(body.replace(/<[^>]+>/g, ' '));
  if (clean.length <= max) return clean;
  const terms = uniqueTerms(query);
  const lower = clean.toLowerCase();
  let best = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  if (best === -1) return truncate(clean, max);
  const start = Math.max(0, best - Math.floor(max * 0.35));
  const slice = clean.slice(start, start + max);
  return (start > 0 ? '…' : '') + slice.trim() + (start + max < clean.length ? '…' : '');
}

/** Escape text for safe inclusion in a Markdown table cell. */
export function mdCell(s: string): string {
  return (s || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim();
}

/** Escape Markdown link text. */
export function mdLinkText(s: string): string {
  return (s || '').replace(/[[\]]/g, '').replace(/\n+/g, ' ').trim();
}

/** Jaccard similarity over word shingles; used to drop near-duplicate titles. */
export function shingleSimilarity(a: string, b: string, size = 3): number {
  const sa = shingles(a, size);
  const sb = shingles(b, size);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function shingles(s: string, size: number): Set<string> {
  const words = tokenize(s, { keepStopwords: true });
  const set = new Set<string>();
  if (words.length <= size) {
    if (words.length) set.add(words.join(' '));
    return set;
  }
  for (let i = 0; i <= words.length - size; i++) set.add(words.slice(i, i + size).join(' '));
  return set;
}
