/**
 * DuckDuckGo — keyless HTML endpoints.
 *
 * Two endpoints are used, in this order:
 *
 *   1. `https://html.duckduckgo.com/html/` — the no-JS search page. A POST with
 *      a form body (`q=…&b=&kl=…`) is the most reliable shape; the same body is
 *      reused for the lite endpoint below.
 *   2. `https://lite.duckduckgo.com/lite/` — an even smaller table-based page,
 *      tried only when the html endpoint answers with an anti-bot block.
 *
 * Result hrefs on both endpoints are frequently protocol-relative redirect
 * wrappers (`//duckduckgo.com/l/?uddg=<urlencoded target>`), so every URL goes
 * through `unwrapRedirect` before it is resolved with `absoluteUrl`.
 *
 * Honoured options: `limit`, `timeoutMs`, `region` (`kl`, e.g. `us-en`),
 * `language` (folded into the `kl` locale), `freshness` (`df=d|w|m|y`) and
 * `safeSearch` (`kp=1|-1|-2`). An unknown region is silently widened to
 * `wt-wt` (no region).
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import {
  cap,
  cleanSnippet,
  detectBlock,
  extractResults,
  fetchHtml,
  mergeResults,
  parse,
  queryAll,
  queryOne,
  textOf,
  attrOf,
  absoluteUrl,
  warnEmptyResults,
  type EngineDeps,
  type HtmlDocument,
  type SelectorSet,
} from './kit.js';
import { normalizeUrl, unwrapRedirect } from '../util/url.js';

const HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
const LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
const HOME = 'https://duckduckgo.com/';

/** DuckDuckGo's own hosts, which appear as redirect wrappers and site chrome. */
const SELF_HOSTS = ['duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com', 'external-content.duckduckgo.com', 'duck.co'];

/** Region hint -> DuckDuckGo `kl` locale. Unknown regions fall back to `wt-wt`. */
const REGIONS: Record<string, string> = {
  global: 'wt-wt',
  none: 'wt-wt',
  all: 'wt-wt',
  us: 'us-en',
  uk: 'uk-en',
  gb: 'uk-en',
  cn: 'cn-zh',
  zh: 'cn-zh',
  tw: 'tw-tzh',
  hk: 'hk-tzh',
  jp: 'jp-jp',
  kr: 'kr-kr',
  de: 'de-de',
  fr: 'fr-fr',
  es: 'es-es',
  it: 'it-it',
  nl: 'nl-nl',
  pl: 'pl-pl',
  ru: 'ru-ru',
  br: 'br-pt',
  pt: 'pt-pt',
  in: 'in-en',
  id: 'id-id',
  tr: 'tr-tr',
};

const FRESHNESS: Record<string, string> = { day: 'd', week: 'w', month: 'm', year: 'y' };

/** DuckDuckGo's `kp` values: 1 = strict, -1 = off, -2 = moderate. */
const SAFE_SEARCH: Record<string, string> = { off: '-1', moderate: '-2', strict: '1' };

const HTML_SETS: SelectorSet[] = [
  {
    container: 'div.result',
    link: 'a.result__a',
    title: 'a.result__a',
    snippet: '.result__snippet',
  },
  {
    container: 'div.result.results_links',
    link: 'a.result__a',
    snippet: '.result__snippet',
  },
];

const LITE_SETS: SelectorSet[] = [
  {
    container: 'a.result-link',
    link: 'a.result-link',
    title: 'a.result-link',
    snippet: '.result-snippet',
  },
  {
    container: 'tr',
    link: 'a.result-link',
    title: 'a.result-link',
    snippet: '.result-snippet',
  },
];

export function createDuckDuckGoEngine({ http, config }: EngineDeps): SearchEngine {
  const deps: EngineDeps = { http, config };

  return {
    id: 'duckduckgo',
    label: 'DuckDuckGo',
    kind: 'html',
    requiresKey: false,
    homepage: HOME,
    regions: ['global'],
    transport: 'http',
    note: 'Keyless HTML endpoints (html + lite fallback) with region, freshness and safe-search parameters.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = buildParams(query, options);

      try {
        const { html, finalUrl, status } = await fetchHtml(deps, HTML_ENDPOINT, {
          method: 'POST',
          body: params.toString(),
          referer: HOME,
          timeoutMs: options.timeoutMs,
        });
        detectBlock(status, html, 'duckduckgo');
        return parseHtmlResults(html, finalUrl, options);
      } catch (err) {
        // A blocked html endpoint is exactly the case the lite endpoint exists
        // for; anything else (network error, 500) is not worth a second host.
        if (!isBlocked(err)) throw err;
      }

      const { html, finalUrl, status } = await fetchHtml(deps, LITE_ENDPOINT, {
        method: 'POST',
        body: params.toString(),
        referer: HOME,
        timeoutMs: options.timeoutMs,
      });
      detectBlock(status, html, 'duckduckgo');
      return parseHtmlResults(html, finalUrl, options, true);
    },
  };
}

/** Build the shared `kl`/`kp`/`df` query parameters for either endpoint. */
function buildParams(query: string, options: EngineSearchOptions): URLSearchParams {
  const params = new URLSearchParams();
  params.set('q', query);
  // `b` is the "no ads / basic" switch the html endpoint expects on POST.
  params.set('b', '');
  params.set('kl', regionParam(options));
  if (options.freshness && FRESHNESS[options.freshness]) params.set('df', FRESHNESS[options.freshness]!);
  if (options.safeSearch) params.set('kp', SAFE_SEARCH[options.safeSearch] ?? '-2');
  return params;
}

/**
 * `kl` for the requested region. `cn-zh` is used when only a language is known,
 * and an unknown region is silently ignored (DuckDuckGo then picks by GeoIP).
 */
function regionParam(options: EngineSearchOptions): string {
  const region = (options.region ?? '').toLowerCase();
  if (region && REGIONS[region]) return REGIONS[region]!;
  const language = (options.language ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  if (language === 'zh') return 'cn-zh';
  if (language === 'ja') return 'jp-jp';
  if (language === 'ko') return 'kr-kr';
  return 'wt-wt';
}

/** Run the selector + generic extraction and clean up the redirect wrappers. */
function parseHtmlResults(
  html: string,
  baseUrl: string,
  options: EngineSearchOptions,
  lite = false,
): RawResult[] {
  const limit = Math.max(options.limit, 1);
  const extracted = extractResults(html, {
    baseUrl,
    selfHosts: SELF_HOSTS,
    limit,
    sets: lite ? LITE_SETS : HTML_SETS,
  });
  const { results, strategy } = extracted;
  if (results.length === 0) warnEmptyResults('duckduckgo', html, strategy);

  // The lite table keeps each snippet in a sibling row that neither pass can
  // reach from the anchor, so map it by raw href and merge it back in (missing
  // snippets are simply left to the structured pass).
  const { doc } = parse(html, baseUrl);
  const snippets = lite ? liteSnippetMap(doc, baseUrl) : new Map<string, string>();
  const enriched = results.map((r) => {
    const snippet = snippets.get(r.url);
    return snippet ? { ...r, snippet } : r;
  });
  const unwrapped = mergeResults(results, enriched, limit)
    .map((r) => unwrapResult(r, baseUrl, strategy === 'generic'))
    .filter((r): r is RawResult => r !== null);

  return cap(unwrapped, options.limit);
}

/**
 * Resolve one extracted result to its real target URL.
 *
 * `result.url` is still the raw href at this point (extraction keeps the
 * attribute verbatim), so relative `/l/?uddg=…` wrappers resolve against the
 * page URL exactly as a browser would resolve them.
 */
function unwrapResult(result: RawResult, baseUrl: string, stripTitleNoise: boolean): RawResult | null {
  const url = absoluteUrl(unwrapRedirect(result.url), baseUrl);
  if (!url) return null;
  const normalized = normalizeUrl(url);
  if (!normalized) return null;

  const snippet = cleanSnippet(result.snippet ?? '');
  return {
    // Only the structural pass folds a display URL into the title; the selector
    // pass already has the clean anchor text and must be left alone (its titles
    // can legitimately start with a host-like word, e.g. "modelcontextprotocol/servers").
    title: stripTitleNoise ? cleanDuckTitle(result.title) : result.title,
    url: normalized.url,
    ...(snippet ? { snippet } : {}),
  };
}

/**
 * Map the lite endpoint's rows: `<a class="result-link" href="…">` sits in one
 * `<tr>`, the `.result-snippet` in the next one and the `.link-text` (display
 * URL) in the one after that. Walking the sibling rows is what pairs a link
 * with the snippet neither extraction pass can reach from the anchor.
 *
 * Keys are normalised URLs because the extraction passes report normalised
 * `result.url` values (`www.` and trailing slashes already stripped).
 */
function liteSnippetMap(doc: HtmlDocument['doc'], baseUrl: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const link of queryAll(doc, 'a.result-link[href]')) {
    const key = normalizeUrl(absoluteUrl(attrOf(link, 'href'), baseUrl) ?? '')?.url;
    if (!key) continue;
    const row = link.closest?.('tr') ?? link.parentElement ?? null;
    const rows = row ? [...(row.parentElement?.children ?? [])] : [];
    const start = row ? rows.indexOf(row) : -1;
    let snippet = '';
    for (let i = start + 1; start >= 0 && i < rows.length && i <= start + 3; i++) {
      const text = textOf(queryOne(rows[i]!, '.result-snippet'));
      if (text) {
        snippet = text;
        break;
      }
    }
    const cleaned = cleanSnippet(snippet);
    if (cleaned) map.set(key, cleaned);
  }
  return map;
}

/** DuckDuckGo sometimes prefixes the generic title with its display URL. */
function cleanDuckTitle(title: string): string {
  const cleaned = title
    .replace(/^https?:\/\/\S+/i, '')
    .replace(/^[a-z0-9.-]+\.[a-z]{2,}(?:\.[a-z]{2,})?(?:\s*›\s*[^\s]*)*/i, '');
  return cleanSnippet(cleaned, 300) || title.trim();
}

/** True for an anti-bot block raised by `detectBlock` (and only that). */
function isBlocked(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { blocked?: boolean }).blocked === true;
}
