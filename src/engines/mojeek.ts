/**
 * Mojeek — keyless HTML endpoint.
 *
 * Mojeek runs its own index (no Google/Bing resale) and answers plain
 * `GET https://www.mojeek.com/search?q=…&s=<offset>` with server-rendered
 * results, which makes it the least brittle of the keyless scrapers.
 *
 * Honoured options: `limit` (extra pages are fetched when a single page cannot
 * satisfy it, since Mojeek returns 10 results per page) and `timeoutMs`.
 * Region, language, freshness and safe search are NOT supported: Mojeek takes
 * no crawl-time freshness parameter at all, and its `fmt=json` output requires
 * a paid API key, so `options.freshness`, `options.region`,
 * `options.language` and `options.safeSearch` are silently ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import {
  cap,
  cleanSnippet,
  detectBlock,
  extractGenericResults,
  extractResults,
  fetchHtml,
  mergeResults,
  parse,
  parseDateLoose,
  queryAll,
  queryOne,
  textOf,
  attrOf,
  absoluteUrl,
  warnEmptyResults,
  type EngineDeps,
  type SelectorSet,
} from './kit.js';
import { normalizeUrl, unwrapRedirect } from '../util/url.js';

const ENDPOINT = 'https://www.mojeek.com/search';
const HOME = 'https://www.mojeek.com/';

/** Mojeek's own hosts, plus the `/goto?url=` redirect host it sometimes uses. */
const SELF_HOSTS = ['mojeek.com', 'www.mojeek.com'];

/** Mojeek paginates in steps of ten. */
const PAGE_SIZE = 10;

/** Never fetch more than this many pages for one query. */
const MAX_PAGES = 3;

const SETS: SelectorSet[] = [
  {
    container: 'ul.results-standard li',
    link: 'a.title',
    title: 'a.title',
    snippet: 'p.s',
  },
  {
    container: 'li.result',
    link: 'a.title, h2 a',
    title: 'a.title, h2 a',
    snippet: 'p.s, .s',
  },
  {
    container: 'ul.results li',
    link: 'a',
    snippet: 'p',
  },
];

export function createMojeekEngine({ http, config }: EngineDeps): SearchEngine {
  const deps: EngineDeps = { http, config };

  return {
    id: 'mojeek',
    label: 'Mojeek',
    kind: 'html',
    requiresKey: false,
    homepage: HOME,
    regions: ['global'],
    transport: 'http',
    note: 'Independent index, keyless HTML endpoint; no freshness or safe-search parameter.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const limit = Math.max(options.limit, 1);
      const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(limit / PAGE_SIZE)));
      const collected: RawResult[] = [];
      const seen = new Set<string>();
      // Dates are resolved per anchor, so the sweep has to survive concatenating
      // several pages: keep the whole markup and parse it once at the end.
      let markup = '';
      let lastUrl = `${ENDPOINT}?q=${encodeURIComponent(query)}`;
      let strategyUsed = 'selectors';

      for (let page = 0; page < pages; page++) {
        const url = `${ENDPOINT}?q=${encodeURIComponent(query)}${page > 0 ? `&s=${page * PAGE_SIZE}` : ''}`;
        const { html, finalUrl, status } = await fetchHtml(deps, url, {
          referer: HOME,
          timeoutMs: options.timeoutMs,
        });
        detectBlock(status, html, 'mojeek');

        const { results, strategy } = extractResults(html, {
          baseUrl: finalUrl,
          selfHosts: SELF_HOSTS,
          limit,
          sets: SETS,
        });
        strategyUsed = strategy;
        markup += `${html}\n<!-- page ${page} -->\n`;
        lastUrl = finalUrl;

        // Union of both passes: the selector pass is the better-ranked list, the
        // structural pass often carries snippets the containers expose oddly.
        const pageResults = mergeResults(
          results,
          extractGenericResults(html, { baseUrl: finalUrl, selfHosts: SELF_HOSTS, limit }),
          limit,
        );

        for (const result of pageResults) {
          const normalized = resolveResult(result, finalUrl);
          if (!normalized || seen.has(normalized.url)) continue;
          seen.add(normalized.url);
          collected.push(normalized);
          if (collected.length >= limit) break;
        }
        // Only stop early when the page was genuinely empty: a short page (fewer
        // than ten rows) can still be a partial one, and the next offset is the
        // only way to find out.
        if (pageResults.length === 0 || collected.length >= limit) break;
      }

      if (collected.length === 0) warnEmptyResults('mojeek', markup, strategyUsed);

      // Mojeek prints a per-result date in `.results-dateinfo` / `<time>`; sweep
      // the containers once and attach it by URL, because the selector pass can
      // only read one date element per container.
      const dated = collectDates(markup, lastUrl);
      for (const result of collected) {
        if (result.publishedAt) continue;
        const key = normalizeUrl(result.url)?.key;
        const iso = key ? dated.get(key) : undefined;
        if (iso) result.publishedAt = iso;
      }

      return cap(collected, options.limit);
    },
  };
}

/** Unwrap Mojeek's optional `/goto?url=` wrapper and normalise the target. */
function resolveResult(result: RawResult, baseUrl: string): RawResult | null {
  const url = absoluteUrl(unwrapRedirect(result.url), baseUrl);
  if (!url) return null;
  const normalized = normalizeUrl(url);
  if (!normalized) return null;
  const snippet = cleanSnippet(result.snippet ?? '');
  return {
    title: result.title,
    url: normalized.url,
    ...(snippet ? { snippet } : {}),
    ...(result.publishedAt ? { publishedAt: result.publishedAt } : {}),
  };
}

/** URL key -> ISO date, from every result container in the markup. */
function collectDates(html: string, baseUrl: string): Map<string, string> {
  const dated = new Map<string, string>();
  if (!html) return dated;
  const { doc } = parse(html, baseUrl);
  const containers = [...queryAll(doc, 'ul.results-standard li'), ...queryAll(doc, 'li.result')];
  for (const container of containers) {
    const link = queryOne(container, 'a.title, h2 a');
    const href = absoluteUrl(unwrapRedirect(attrOf(link, 'href')), baseUrl);
    const key = href ? normalizeUrl(href)?.key : undefined;
    if (!key) continue;
    if (dated.has(key)) continue;
    for (const selector of ['.results-dateinfo', 'time', '.date']) {
      const iso = parseDateLoose(textOf(queryOne(container, selector)));
      if (iso) {
        dated.set(key, iso);
        break;
      }
    }
  }
  return dated;
}
