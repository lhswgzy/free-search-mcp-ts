/**
 * Brave Search — keyless HTML front end.
 *
 * `https://search.brave.com/search?q=…&source=web` returns a server-rendered
 * result list, with the web organic results living in
 * `#results .snippet[data-type="web"]`. The HTML list is capped server-side
 * (roughly twenty organic results), which is plenty for a fusion input.
 *
 * Honoured options: `limit`, `timeoutMs`, `freshness` (`tf=pd|pw|pm|py`, where
 * Brave's "past day/week/month/year" map one-to-one onto our levels) and
 * `safeSearch` (`safesearch=strict|moderate|off`). `options.region` and
 * `options.language` are silently ignored: Brave keys the market off its own
 * `country`/`ui_lang` parameters and a session cookie, and guessing them
 * produces worse results than letting the endpoint pick by GeoIP.
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

const ENDPOINT = 'https://search.brave.com/search';
const HOME = 'https://search.brave.com/';

/** Brave's own hosts, which appear as redirects and site chrome. */
const SELF_HOSTS = ['search.brave.com', 'brave.com'];

/** Our freshness levels -> Brave's `tf` (time filter) values. */
const FRESHNESS: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

const SAFE_SEARCH: Record<string, string> = { off: 'off', moderate: 'moderate', strict: 'strict' };

const SETS: SelectorSet[] = [
  {
    container: '#results .snippet[data-type="web"]',
    link: 'a.heading-serpresult',
    title: 'a.heading-serpresult',
    snippet: '.snippet-description',
    date: '.snippet-date',
  },
  {
    container: 'div.snippet',
    link: 'a.heading-serpresult, .title, a',
    title: '.title, a.heading-serpresult',
    snippet: '.snippet-description, .snippet-content, p',
    date: '.snippet-date, time',
  },
  {
    container: '#results .snippet',
    link: 'a[href]',
    snippet: '.snippet-description',
  },
];

export function createBraveEngine({ http, config }: EngineDeps): SearchEngine {
  const deps: EngineDeps = { http, config };

  return {
    id: 'brave',
    label: 'Brave Search (HTML)',
    kind: 'html',
    requiresKey: false,
    homepage: HOME,
    regions: ['global'],
    transport: 'http',
    note: 'Keyless HTML front end with `tf` freshness and `safesearch`; no API key required.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({ q: query, source: 'web' });
      if (options.freshness && FRESHNESS[options.freshness]) params.set('tf', FRESHNESS[options.freshness]!);
      if (options.safeSearch && SAFE_SEARCH[options.safeSearch]) {
        params.set('safesearch', SAFE_SEARCH[options.safeSearch]!);
      }

      const { html, finalUrl, status } = await fetchHtml(deps, `${ENDPOINT}?${params}`, {
        referer: HOME,
        timeoutMs: options.timeoutMs,
      });
      detectBlock(status, html, 'brave');

      const { results, strategy } = extractResults(html, {
        baseUrl: finalUrl,
        selfHosts: SELF_HOSTS,
        limit: options.limit,
        sets: SETS,
      });
      if (results.length === 0) warnEmptyResults('brave', html, strategy);

      const dated = collectDates(html, finalUrl);
      // Union of the selector pass and the structural pass, so a layout that
      // only half-matches the selectors still contributes every result.
      const merged = mergeResults(
        results,
        extractGenericResults(html, { baseUrl: finalUrl, selfHosts: SELF_HOSTS, limit: options.limit }),
        options.limit,
      );
      const cleaned = merged
        .map((result) => resolveResult(result, finalUrl, dated))
        .filter((r): r is RawResult => r !== null);

      return cap(cleaned, options.limit);
    },
  };
}

/** Resolve one result and normalise its URL, dropping anything unusable. */
function resolveResult(
  result: RawResult,
  baseUrl: string,
  dated: Map<string, string>,
): RawResult | null {
  const url = absoluteUrl(unwrapRedirect(result.url), baseUrl);
  if (!url) return null;
  const normalized = normalizeUrl(url);
  if (!normalized) return null;

  const snippet = cleanSnippet(result.snippet ?? '');
  const publishedAt = result.publishedAt ?? dated.get(normalized.key);
  return {
    title: result.title,
    url: normalized.url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

/**
 * URL key -> ISO date. The selector pass can only read one date element, and
 * Brave mixes `<span class="snippet-date">` (text) with `<time datetime>`.
 */
function collectDates(html: string, baseUrl: string): Map<string, string> {
  const dated = new Map<string, string>();
  const { doc } = parse(html, baseUrl);
  const containers = [...queryAll(doc, '#results .snippet'), ...queryAll(doc, 'div.snippet')];
  for (const container of containers) {
    const link = queryOne(container, 'a.heading-serpresult, .title a, a[href]');
    const href = absoluteUrl(unwrapRedirect(attrOf(link, 'href')), baseUrl);
    const key = href ? normalizeUrl(href)?.key : undefined;
    if (!key || dated.has(key)) continue;
    for (const selector of ['.snippet-date', 'time', '.snippet-attributes']) {
      const node = queryOne(container, selector);
      const iso = parseDateLoose(attrOf(node, 'datetime') || textOf(node));
      if (iso) {
        dated.set(key, iso);
        break;
      }
    }
  }
  return dated;
}
