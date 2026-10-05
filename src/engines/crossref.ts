/**
 * Crossref — scholarly metadata REST API (`api.crossref.org/works`).
 *
 * What this indexes: the Crossref DOI registry — journal articles, conference
 * papers, books and chapters contributed by publishers, with titles, author
 * lists, venues, publication dates and citation counts. It is a *bibliographic*
 * index: there is no full text, no general web content, and coverage of
 * preprints, datasets and grey literature is thinner than OpenAlex's.
 *
 * Auth / limits: keyless. Crossref is free and unmetered for reasonable use;
 * it asks heavy clients to join the "polite pool" with a contact address in the
 * `User-Agent`, which this server's shared UA does. The local search cache
 * absorbs repeat queries.
 *
 * Quirks:
 *   - Every field is optional in practice. `title` and `container-title` are
 *     *arrays*, `abstract` is JATS XML (or missing entirely — publisher
 *     dependent), and `issued['date-parts']` may be `[year]`, `[year, month]`
 *     or `[year, month, day]`, so the date has to be assembled by hand.
 *   - `url` is the publisher's landing page and can be a bare `http://` link;
 *     when it is missing the DOI is rendered as `https://doi.org/<DOI>`.
 *   - There is no freshness or safe-search parameter beyond `from-pub-date`
 *     style filters, which are not used here; freshness windows are ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, fetchJson, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';
import { truncate } from '../util/text.js';

/** How much of a JATS abstract fits in a search-result snippet. */
const ABSTRACT_SNIPPET_CHARS = 400;

/** How many author names are worth carrying in `meta`. */
const META_AUTHORS = 3;

const SELECT_FIELDS = 'DOI,title,abstract,URL,issued,container-title,author,is-referenced-by-count,type';

interface CrossrefResponse {
  message?: {
    items?: CrossrefItem[];
    'total-results'?: unknown;
  };
}

interface CrossrefItem {
  DOI?: unknown;
  title?: unknown;
  abstract?: unknown;
  URL?: unknown;
  issued?: { 'date-parts'?: unknown } | null;
  'container-title'?: unknown;
  author?: unknown;
  'is-referenced-by-count'?: unknown;
  type?: unknown;
}

export function createCrossrefEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'crossref',
    label: 'Crossref',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://www.crossref.org/',
    regions: ['global'],
    transport: 'http',
    note: 'DOI registry: published papers, books and chapters with authors, venues and citation counts.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        query,
        rows: String(Math.min(Math.max(options.limit, 1), 100)),
        select: SELECT_FIELDS,
      });

      const json = await fetchJson<unknown>({ http, config }, `https://api.crossref.org/works?${params}`, {
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
      });
      return mapCrossrefResponse(json, options.limit);
    },
  };
}

/** Map a raw Crossref `/works` response onto `RawResult`s. Never throws. */
export function mapCrossrefResponse(json: unknown, limit: number): RawResult[] {
  const message = (json as CrossrefResponse | null | undefined)?.message;
  const items = message?.items;
  if (!Array.isArray(items)) return [];
  const total = typeof message?.['total-results'] === 'number' ? message['total-results'] : undefined;

  const out: RawResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;

    const doi = typeof item.DOI === 'string' ? item.DOI.trim() : '';
    const title = firstString(Array.isArray(item.title) ? item.title[0] : item.title);
    const url = firstString(item.URL) || (doi ? `https://doi.org/${doi}` : '');
    if (!title || !url) continue;

    const journal = firstString(Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title']);
    const year = yearFromDateParts(item.issued?.['date-parts']);
    const citedBy = typeof item['is-referenced-by-count'] === 'number' ? item['is-referenced-by-count'] : undefined;
    const type = typeof item.type === 'string' ? item.type : '';
    const authors = authorNames(item.author);

    // `abstract` is JATS XML: stripHtml removes the <jats:p> wrapper and any
    // inline markup, leaving readable prose.
    const abstract = typeof item.abstract === 'string' ? stripHtml(item.abstract) : '';
    const snippet = abstract ? truncate(abstract, ABSTRACT_SNIPPET_CHARS) : composeSnippet(journal, year, citedBy);

    const publishedAt = isoFromDateParts(item.issued?.['date-parts']);

    out.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(doi ? { doi } : {}),
        ...(year !== undefined ? { year } : {}),
        ...(citedBy !== undefined ? { citedBy } : {}),
        ...(authors.length ? { authors: authors.slice(0, META_AUTHORS) } : {}),
        ...(journal ? { journal } : {}),
        ...(type ? { type } : {}),
        ...(total !== undefined ? { total } : {}),
      },
    });
  }
  return cap(out, limit);
}

/** `"The Lancet · 2019 · cited by 1204"`, dropping missing parts. */
export function composeSnippet(journal: string, year?: number, citedBy?: number): string {
  const parts: string[] = [];
  if (journal) parts.push(journal);
  if (year !== undefined) parts.push(String(year));
  if (citedBy !== undefined) parts.push(`cited by ${citedBy}`);
  return parts.join(' · ');
}

/** Pull `[[YYYY, M, D]]` out of `issued['date-parts']`, tolerating short forms. */
export function datePartsOf(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const parts = Array.isArray(value[0]) ? value[0] : value;
  return parts.filter((p): p is number => typeof p === 'number' && Number.isFinite(p));
}

/** Calendar year from `date-parts`, or undefined when absent. */
export function yearFromDateParts(value: unknown): number | undefined {
  const year = datePartsOf(value)[0];
  return year !== undefined ? year : undefined;
}

/**
 * Build an ISO date from Crossref's `date-parts`. Missing month/day default to
 * January / the 1st, matching Crossref's own convention for partial dates.
 */
export function isoFromDateParts(value: unknown): string | undefined {
  const [year, month, day] = datePartsOf(value);
  if (year === undefined || year < 1500 || year > 3000) return undefined;
  const mm = month !== undefined && month >= 1 && month <= 12 ? month : 1;
  const dd = day !== undefined && day >= 1 && day <= 31 ? day : 1;
  const iso = `${String(year).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return parseDateLoose(iso);
}

/** `["Gerald Versluis", "Ada Lovelace"]`, skipping nameless entries. */
export function authorNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const given = typeof (entry as { given?: unknown }).given === 'string' ? (entry as { given: string }).given.trim() : '';
    const family = typeof (entry as { family?: unknown }).family === 'string' ? (entry as { family: string }).family.trim() : '';
    const name = [given, family].filter(Boolean).join(' ').trim();
    if (name) out.push(name);
  }
  return out;
}

function firstString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
