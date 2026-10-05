/**
 * arXiv — Atom export API (`export.arxiv.org/api/query`).
 *
 * What this indexes: arXiv preprint metadata — title, abstract, authors,
 * primary category and dates. It is a *scientific preprint* index with no
 * peer review and no general web content. Use it for "is there a paper about
 * X", "who worked on Y" and "what does Z claim", not for citation counts
 * (arXiv does not expose them) or for published-journal metadata.
 *
 * Auth / limits: keyless, but arXiv explicitly asks that clients
 * **wait about 3 seconds between requests** and issues a temporary IP ban to
 * clients that hammer the API. There is also a hard cap of 2000 results per
 * query and 30000 per day, neither of which this engine approaches. Because of
 * the politeness requirement this engine is intentionally left out of the
 * default engine tier and is meant to be selected explicitly (or scheduled
 * sparsely); the shared retry logic does not shorten the wait.
 *
 * Quirks:
 *   - The response is Atom XML, not JSON, so it is fetched as text and parsed
 *     with a small regex parser rather than a full XML library. The document is
 *     regular and machine-generated, which makes that safe in practice.
 *   - `<id>` is an `http://arxiv.org/abs/...` URL even though the API is served
 *     over HTTPS; it is normalised to `https://`.
 *   - A query that already carries an arXiv field prefix (`ti:`, `au:`, `abs:`,
 *     `cat:`, `all:`) is passed through verbatim so power users can write
 *     `au:hinton` instead of having it wrapped in `all:`.
 *   - There is no freshness or safe-search parameter; `published` is reported
 *     and freshness windows are ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, detectBlock, fetchHtml, parseDateLoose, type EngineDeps } from './kit.js';
import { collapseWhitespace, truncate } from '../util/text.js';
import { decodeEntities, htmlToText } from '../html/markdown.js';

/** Max characters of the abstract placed in `snippet`. */
const SUMMARY_SNIPPET_CHARS = 500;

/** arXiv field prefixes that mean "the caller already wrote a real query". */
const FIELD_PREFIX = /^(?:ti|au|abs|cat|all|co|jr|rn|id):/i;

/** Normalise a bare query, leaving already-prefixed queries untouched. */
export function buildArxivQuery(query: string): string {
  const q = query.trim();
  if (!q) return 'all:';
  return FIELD_PREFIX.test(q) ? q : `all:${q}`;
}

/** Extract the text of the first `<tag>...</tag>` inside `block`. */
function tagText(block: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  return decodeEntities(re.exec(block)?.[1] ?? '').trim();
}

/** Extract every `<tag>...</tag>` inside `block`, in document order. */
function tagTexts(block: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  for (const match of block.matchAll(re)) out.push(decodeEntities(match[1] ?? '').trim());
  return out;
}

/** Extract one attribute from a self-closing/opening tag. */
function tagAttr(block: string, tag: string, attr: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${attr}=["']([^"']*)["']`, 'i');
  return decodeEntities(re.exec(block)?.[1] ?? '').trim();
}

/** Turn an Atom `<id>` into a canonical https URL. */
function canonicalUrl(id: string): string {
  const value = id.trim();
  if (!value) return '';
  return value.replace(/^http:\/\//i, 'https://');
}

/**
 * Parse an arXiv Atom feed into `RawResult`s. Never throws: anything that does
 * not look like an entry is skipped.
 */
export function parseArxivFeed(xml: string, limit: number): RawResult[] {
  if (typeof xml !== 'string' || !xml) return [];

  const out: RawResult[] = [];
  for (const match of xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)) {
    const entry = match[0] ?? '';
    const title = collapseWhitespace(tagText(entry, 'title').replace(/\s+/g, ' '));
    const id = canonicalUrl(tagText(entry, 'id'));
    if (!title || !id) continue;

    // `<summary>` is plain text in Atom, but a few records embed markup, so it
    // goes through the shared HTML-to-text path before being collapsed.
    const summary = stripAbstractPrefix(collapseWhitespace(htmlToText(tagText(entry, 'summary'))));

    const authors = tagTexts(entry, 'name')
      .map((name) => collapseWhitespace(name))
      .filter(Boolean);
    const categories = [...entry.matchAll(/<category\b[^>]*\bterm=["']([^"']*)["']/gi)]
      .map((m) => decodeEntities(m[1] ?? '').trim())
      .filter(Boolean);
    const primaryCategory = tagAttr(entry, 'arxiv:primary_category', 'term') || categories[0] || '';
    const published = tagText(entry, 'published');
    const updated = tagText(entry, 'updated');
    const publishedAt = parseDateLoose(published);

    out.push({
      title,
      url: id,
      ...(summary ? { snippet: truncate(summary, SUMMARY_SNIPPET_CHARS) } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(authors.length ? { authors } : {}),
        ...(primaryCategory ? { primaryCategory } : {}),
        ...(categories.length ? { categories } : {}),
        ...(updated ? { updated } : {}),
      },
    });
  }
  return cap(out, limit);
}

/** arXiv abstracts are sometimes prefixed with a literal `Abstract:` label. */
export function stripAbstractPrefix(summary: string): string {
  return summary.replace(/^\s*abstract\s*[:\u2014-]\s*/i, '').trim();
}

export function createArxivEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'arxiv',
    label: 'arXiv',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://arxiv.org/',
    regions: ['global'],
    transport: 'http',
    note: 'Preprint metadata (title/abstract/authors). arXiv asks for ~3s between requests, so it is not in the default tier.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        search_query: buildArxivQuery(query),
        start: '0',
        max_results: String(Math.min(Math.max(options.limit, 1), 100)),
        sortBy: 'relevance',
        sortOrder: 'descending',
      });

      // Atom XML, so the HTML fetch helper is reused for transport/timeout and
      // the body is parsed as text rather than through the JSON path.
      const { html, status } = await fetchHtml({ http, config }, `https://export.arxiv.org/api/query?${params}`, {
        accept: 'application/atom+xml,application/xml;q=0.9,*/*;q=0.8',
        timeoutMs: options.timeoutMs,
      });
      detectBlock(status, html, 'arxiv');
      return parseArxivFeed(html, options.limit);
    },
  };
}
