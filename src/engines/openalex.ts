/**
 * OpenAlex — scholarly works API (`api.openalex.org/works`).
 *
 * What this indexes: the OpenAlex catalogue of scholarly *works* — journal
 * articles, books, chapters, datasets, software and preprints, with authors,
 * host venues, open-access status and citation counts. It is a bibliographic
 * index, not a web index: you will not find blog posts, docs or news, and the
 * abstracts it carries are often reconstructed from an inverted index rather
 * than stored verbatim.
 *
 * Auth / limits: keyless. There is a shared "polite pool" for anonymous traffic
 * (100k calls/day, 10/second) and a faster pool for callers that send a
 * `mailto`; this engine therefore appends a generic `mailto` so it lands in the
 * polite pool, and the local search cache absorbs repeat queries.
 *
 * Quirks:
 *   - `abstract_inverted_index` is `{ word: [positions...] }`, not text. The
 *     abstract has to be reconstructed by placing each word at its recorded
 *     positions and joining the slots in order — see `reconstructAbstract`.
 *     It is `null` for a large share of records, so the metadata fallback
 *     snippet (venue · year · citations) matters.
 *   - `doi` and `id` are already full URLs. They stay the canonical result URL;
 *     `open_access.oa_url` is only exposed in `meta`, because it frequently
 *     points at the same DOI landing page or at a bare repository PDF.
 *   - `title` is null for some records; `display_name` is the fallback.
 *   - `filter=from_publication_date:YYYY-MM-DD` is the only freshness
 *     mechanism, and there is no safe-search parameter.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, fetchJson, parseDateLoose, type EngineDeps } from './kit.js';
import { truncate } from '../util/text.js';

/** How much of a reconstructed abstract fits in a search-result snippet. */
const ABSTRACT_SNIPPET_CHARS = 400;

/** How many author names are worth carrying in `meta`. */
const META_AUTHORS = 3;

interface OpenAlexResponse {
  meta?: { count?: unknown };
  results?: OpenAlexWork[];
}

interface OpenAlexWork {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  display_name?: unknown;
  publication_year?: unknown;
  publication_date?: unknown;
  cited_by_count?: unknown;
  type?: unknown;
  authorships?: { author?: { display_name?: unknown } | null }[];
  primary_location?: { source?: { display_name?: unknown } | null } | null;
  abstract_inverted_index?: unknown;
  open_access?: { oa_url?: unknown } | null;
}

/**
 * Rebuild an abstract from OpenAlex's inverted index.
 *
 * The index maps every distinct word to the list of word positions it occupies,
 * e.g. `{ "Model": [0], "context": [1, 7] }` for the text beginning
 * "Model context ... context ...". We walk the words in position order and drop
 * each one into a sparse array, then join the slots.
 *
 * Returns `undefined` when the index is missing or malformed, so callers can
 * fall back to the metadata snippet.
 */
export function reconstructAbstract(index: unknown): string | undefined {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return undefined;

  const slots: string[] = [];
  let placed = 0;

  for (const [word, positions] of Object.entries(index as Record<string, unknown>)) {
    const list = Array.isArray(positions) ? positions : [positions];
    for (const raw of list) {
      const position = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isInteger(position) || position < 0 || position > 100_000) continue;
      // Empty strings are legitimate slots; join() below keeps the spacing.
      if (slots[position] === undefined) slots[position] = word;
      placed++;
    }
  }

  if (placed === 0 || slots.length === 0) return undefined;
  const text = slots.map((slot) => slot ?? '').join(' ').replace(/\s+/g, ' ').trim();
  return text.length ? text : undefined;
}

export function createOpenAlexEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'openalex',
    label: 'OpenAlex',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://openalex.org/',
    regions: ['global'],
    transport: 'http',
    note: 'Scholarly works with authors, venues, citation counts and reconstructed abstracts.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        search: query,
        'per-page': String(Math.min(Math.max(options.limit, 1), 200)),
        // Joins OpenAlex's polite pool; not a key and not required.
        mailto: 'lhswgzy@users.noreply.github.com',
      });
      const fromDate = freshnessCutoff(options.freshness);
      if (fromDate) params.set('filter', `from_publication_date:${fromDate}`);

      const json = await fetchJson<unknown>({ http, config }, `https://api.openalex.org/works?${params}`, {
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
      });
      return mapOpenAlexResponse(json, options.limit);
    },
  };
}

/** `YYYY-MM-DD` cutoff for a freshness window, or undefined when unset. */
export function freshnessCutoff(freshness: string | undefined, now = Date.now()): string | undefined {
  const days: Record<string, number> = { day: 1, week: 7, month: 31, year: 366 };
  if (!freshness) return undefined;
  const window = days[freshness];
  if (!window) return undefined;
  return new Date(now - window * 86_400_000).toISOString().slice(0, 10);
}

/** Map a raw OpenAlex `/works` response onto `RawResult`s. Never throws. */
export function mapOpenAlexResponse(json: unknown, limit: number): RawResult[] {
  const results = (json as OpenAlexResponse | null | undefined)?.results;
  if (!Array.isArray(results)) return [];
  const total = typeof (json as OpenAlexResponse).meta?.count === 'number'
    ? (json as OpenAlexResponse).meta!.count
    : undefined;

  const out: RawResult[] = [];
  for (const work of results) {
    if (!work || typeof work !== 'object') continue;

    const title = firstString(work.title, work.display_name);
    const doi = typeof work.doi === 'string' ? work.doi.trim() : '';
    const id = typeof work.id === 'string' ? work.id.trim() : '';
    const url = doi || id;
    if (!title || !url) continue;

    const year = typeof work.publication_year === 'number' ? work.publication_year : undefined;
    const citedBy = typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined;
    const type = typeof work.type === 'string' ? work.type : '';
    const journal = typeof work.primary_location?.source?.display_name === 'string'
      ? work.primary_location.source.display_name
      : '';
    const oaUrl = typeof work.open_access?.oa_url === 'string' ? work.open_access.oa_url : '';
    const publicationDate = typeof work.publication_date === 'string' ? work.publication_date : '';

    const authors = Array.isArray(work.authorships)
      ? work.authorships
          .map((a) => (typeof a?.author?.display_name === 'string' ? a.author.display_name.trim() : ''))
          .filter(Boolean)
      : [];

    const abstract = reconstructAbstract(work.abstract_inverted_index);
    const snippet = abstract
      ? truncate(abstract, ABSTRACT_SNIPPET_CHARS)
      : composeSnippet(journal, year, citedBy);
    const publishedAt = parseDateLoose(publicationDate);

    out.push({
      title: title.trim(),
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(year !== undefined ? { year } : {}),
        ...(citedBy !== undefined ? { citedBy } : {}),
        ...(authors.length ? { authors: authors.slice(0, META_AUTHORS) } : {}),
        ...(journal ? { journal } : {}),
        ...(type ? { type } : {}),
        ...(oaUrl ? { oaUrl } : {}),
        ...(abstract ? { abstract } : {}),
        ...(total !== undefined ? { total } : {}),
      },
    });
  }
  return cap(out, limit);
}

/** `"Nature · 2021 · cited by 214"`, dropping missing parts. */
export function composeSnippet(journal: string, year?: number, citedBy?: number): string {
  const parts: string[] = [];
  if (journal) parts.push(journal);
  if (year !== undefined) parts.push(String(year));
  if (citedBy !== undefined) parts.push(`cited by ${citedBy}`);
  return parts.join(' · ');
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
