/**
 * Wikipedia — MediaWiki search API.
 *
 * What this indexes: Wikipedia article *titles and body text* only. It is an
 * encyclopaedia, not a web index, so it is the right engine for "what is X",
 * "history of Y" and factual lookups, and the wrong one for product pages,
 * forum threads or anything published in the last few days.
 *
 * Auth / limits: no key and no account. The public API allows roughly 500
 * requests/hour per IP for anonymous clients and asks for a descriptive
 * `User-Agent`; this server sets its own UA in the shared HTTP layer and the
 * local search cache absorbs repeat queries. `srlimit` is capped at 50 by the
 * API for anonymous callers, so one page is always enough for our limits.
 *
 * Quirks:
 *   - Results are namespaced. We pin `srnamespace=0` so only articles come
 *     back, never `Talk:`/`User:`/`Category:` pages.
 *   - `snippet` carries `<span class="searchmatch">` highlighting, so it must
 *     be run through `stripHtml` before it is shown.
 *   - `timestamp` is the *last edit* time of the article, not a publication
 *     date. It is the only date the API exposes, so it is what we report.
 *   - There is no freshness or safe-search parameter; both are ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { EngineError, cap, fetchJson, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';
import { decodeEntities } from '../html/markdown.js';

/** MediaWiki search API page (only the fields we ask for via `srprop`). */
interface WikipediaSearchResponse {
  query?: {
    search?: WikipediaSearchHit[];
    searchinfo?: { totalhits?: number };
  };
  error?: { code?: string; info?: string };
}

interface WikipediaSearchHit {
  title?: unknown;
  snippet?: unknown;
  timestamp?: unknown;
  wordcount?: unknown;
  size?: unknown;
}

/** Map a raw `list=search` response onto `RawResult`s. Never throws. */
export function mapWikipediaResponse(json: unknown, limit: number, lang = 'en'): RawResult[] {
  const response = json as WikipediaSearchResponse | null | undefined;
  const hits = response?.query?.search;
  if (!Array.isArray(hits)) return [];
  const totalhits = typeof response?.query?.searchinfo?.totalhits === 'number'
    ? response.query.searchinfo.totalhits
    : undefined;

  const out: RawResult[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue;
    // MediaWiki returns titles HTML-escaped (`&amp;`, `&#39;`), so decode them
    // before they reach the Markdown renderer or the URL builder.
    const title = typeof hit.title === 'string' ? decodeEntities(hit.title).trim() : '';
    if (!title) continue;

    const snippet = typeof hit.snippet === 'string' ? stripHtml(hit.snippet) : '';
    const publishedAt = typeof hit.timestamp === 'string' ? parseDateLoose(hit.timestamp) : undefined;
    const wordcount = typeof hit.wordcount === 'number' ? hit.wordcount : undefined;

    out.push({
      title,
      url: articleUrl(lang, title),
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(wordcount !== undefined ? { wordcount } : {}),
        ...(totalhits !== undefined ? { totalhits } : {}),
      },
    });
  }
  return cap(out, limit);
}

/** `https://<lang>.wikipedia.org/wiki/<Title_With_Underscores>`. */
export function articleUrl(lang: string, title: string): string {
  const path = encodeURIComponent(title.replace(/ /g, '_'));
  return `https://${lang}.wikipedia.org/wiki/${path}`;
}

/** Normalise `options.language` into a Wikipedia sub-domain. */
export function wikiLang(language?: string): string {
  const raw = (language ?? 'en').trim().toLowerCase();
  // Accept `zh`, `zh-CN`, `zh-hans`; Wikipedia wants the base code for the
  // common cases and a full sub-domain for the rest.
  if (!raw) return 'en';
  const base = raw.split(/[-_]/)[0] ?? 'en';
  if (base === 'zh') return 'zh';
  if (/^[a-z]{2,3}$/.test(base)) return base;
  return 'en';
}

export function createWikipediaEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'wikipedia',
    label: 'Wikipedia',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://www.wikipedia.org/',
    regions: ['global'],
    transport: 'http',
    note: 'MediaWiki search API: encyclopaedia articles only, keyless and unmetered for light use.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const lang = wikiLang(options.language);
      const limit = Math.min(Math.max(options.limit, 1), 50);
      const params = new URLSearchParams({
        action: 'query',
        list: 'search',
        srsearch: query,
        format: 'json',
        srlimit: String(limit),
        srnamespace: '0',
        srprop: 'snippet|timestamp|wordcount|size',
      });

      const json = await fetchJson<unknown>({ http, config }, `https://${lang}.wikipedia.org/w/api.php?${params}`, {
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
      });

      const error = (json as WikipediaSearchResponse | null)?.error;
      if (error?.code) {
        // Search is the only failing call we make, so a MediaWiki-level error
        // is a genuine provider failure rather than an empty result set.
        throw new EngineError(`wikipedia: API error ${error.code}`, { engine: 'wikipedia', blocked: true });
      }
      return mapWikipediaResponse(json, limit, lang);
    },
  };
}
