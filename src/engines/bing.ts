/**
 * Bing — keyless HTML endpoint.
 *
 * This is the reference implementation for an HTML engine, and the one engine
 * whose selectors are verified against a live response. It shows the pattern
 * every scraper in this directory follows:
 *
 *   1. build the request (region/safe-search/freshness params),
 *   2. fetch through the shared HTTP client,
 *   3. run `detectBlock` so an anti-bot interstitial is reported as a block
 *      rather than as "zero results",
 *   4. extract with explicit selectors, falling back to structural extraction,
 *   5. `cap` to the requested limit.
 *
 * Bing is also a genuinely useful engine here: it is reachable from networks
 * where DuckDuckGo and Google are not, which is why it forms the global
 * fallback tier alongside the CJK engines.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, detectBlock, extractResults, fetchHtml, parse, parseDateLoose, queryAll, queryOne, textOf, attrOf, cleanSnippet, absoluteUrl, type EngineDeps } from './kit.js';
import { normalizeUrl, extractWrapperTarget } from '../util/url.js';

/** Bing's own hosts plus the syndication hosts it links to internally. */
const SELF_HOSTS = ['bing.com', 'www.bing.com', 'cn.bing.com', 'go.microsoft.com', 'microsofttranslator.com', 'msn.com'];

/**
 * Hosts whose hrefs may be Bing's own click tracker rather than the target.
 * Unwrapping is gated on these so a legitimate `?u=` or `?q=` parameter on a
 * third-party result URL is never mistaken for a redirect wrapper.
 */
const WRAPPER_HOSTS = new Set(['bing.com', 'www.bing.com', 'cn.bing.com']);

const FRESHNESS: Record<string, string> = {
  day: 'ex1:"ez1"',
  week: 'ex1:"ez2"',
  month: 'ex1:"ez3"',
  year: 'ex1:"ez5"',
};

const SAFE_SEARCH: Record<string, string> = { off: 'off', moderate: 'moderate', strict: 'strict' };

export function createBingEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'bing',
    label: 'Bing',
    kind: 'html',
    requiresKey: false,
    homepage: 'https://www.bing.com/',
    regions: ['global', 'cn'],
    transport: 'http',
    note: 'Keyless HTML endpoint; strong coverage in regions where DuckDuckGo and Google are blocked.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const language = options.language === 'zh' ? 'zh-hans' : (options.language ?? 'en');
      const region = (options.region ?? (options.language === 'zh' ? 'cn' : 'us')).toUpperCase();
      const market = language === 'zh-hans' ? 'zh-CN' : `${language}-${region}`;
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(Math.max(options.limit * 2, 10), 30)),
        mkt: market,
        setmkt: market,
        setlang: language,
        cc: region,
      });

      // Bing geolocates by IP and redirects to a country front end (cn.bing.com
      // from a Chinese IP), after which `mkt`/`setlang`/`cc` are all ignored —
      // measured: an English query still returned 7/10 Chinese titles. The only
      // parameter that reliably forces an English result set is `ensearch=1`
      // (0/10 Chinese titles with it, 7/10 without).
      if (language === 'en') params.set('ensearch', '1');

      if (options.freshness && FRESHNESS[options.freshness]) params.set('filters', FRESHNESS[options.freshness]!);
      if (options.safeSearch && options.safeSearch !== 'off') {
        params.set('safeSearch', SAFE_SEARCH[options.safeSearch] ?? 'moderate');
      }

      const { html, finalUrl, status } = await fetchHtml({ http, config }, `https://www.bing.com/search?${params}`, {
        referer: 'https://www.bing.com/',
        timeoutMs: options.timeoutMs,
      });
      detectBlock(status, html, 'bing');

      const { results, strategy } = extractResults(html, {
        baseUrl: finalUrl,
        selfHosts: SELF_HOSTS,
        limit: options.limit * 2,
        // Bing puts the *display* URL inside the same anchor as the title, so
        // `h2 > a` is required to get a clean title. The generic fallback will
        // otherwise return "zhihu.comhttps://zhuanlan.zhihu.com" as the title.
        sets: [
          {
            container: '#b_results > li.b_algo',
            link: 'h2 a[href]',
            title: 'h2',
            snippet: '.b_caption p, .b_algoSlug, .b_lineclamp2, .b_lineclamp3, .b_lineclamp4, p',
            date: '.news_dt, .b_attribution > span:first-child',
          },
          {
            container: 'li.b_algo',
            link: 'h2 a[href]',
            title: 'h2',
            snippet: '.b_caption p, p',
          },
        ],
      });

      if (strategy === 'generic') {
        // Generic extraction cannot separate Bing's display-URL prefix from the
        // title; strip the leading host/crumb when it is obviously duplicated.
        for (const r of results) r.title = stripBingTitleNoise(r.title);
      }

      // Bing marks dates in `.news_dt` but the selector set above only covers a
      // few shapes; sweep the containers for a parseable date as a backstop.
      const { doc } = parse(html, finalUrl);
      const containers = queryAll(doc, '#b_results > li.b_algo');
      const dated = new Map<string, string>();
      for (const container of containers) {
        const link = queryOne(container, 'h2 a[href]');
        const href = absoluteUrl(attrOf(link, 'href'), finalUrl);
        if (!href) continue;
        const key = normalizeUrl(href)?.key;
        if (!key) continue;
        const candidates = [
          textOf(queryOne(container, '.news_dt')),
          textOf(queryOne(container, '.b_attribution')),
        ];
        for (const candidate of candidates) {
          const iso = candidate ? parseDateLoose(candidate) : undefined;
          if (iso) {
            dated.set(key, iso);
            break;
          }
        }
      }
      for (const r of results) {
        if (r.publishedAt) continue;
        const key = normalizeUrl(r.url)?.key;
        const iso = key ? dated.get(key) : undefined;
        if (iso) r.publishedAt = iso;
      }

      // Some responses hand back `https://www.bing.com/ck/a?!&…&u=a1<base64>`
      // click trackers instead of the destination. Resolve them last, so the
      // date sweep above can still match the href Bing actually printed, and the
      // URL the caller sees (and the dedupe key and cache entry are built from)
      // is the real page rather than a redirect that hides it.
      for (const r of results) {
        const unwrapped = unwrapBingWrapper(r.url);
        if (unwrapped) r.url = unwrapped;
      }

      return cap(results, options.limit);
    },
  };
}

/**
 * Decode Bing's `ck/a?u=a1<base64>` click tracker into its real destination.
 *
 * Returns the normalised target URL, or undefined when the href is not a Bing
 * wrapper we understand — in which case the caller keeps the original URL,
 * because the fetch tool follows redirects anyway.
 */
function unwrapBingWrapper(url: string): string | undefined {
  const normalized = normalizeUrl(url);
  if (!normalized || !WRAPPER_HOSTS.has(normalized.host)) return undefined;
  const target = extractWrapperTarget(url);
  if (!target) return undefined;
  return normalizeUrl(target)?.url;
}

/**
 * Bing's anchor text is `"<display host><breadcrumb path>"` followed by the
 * real title in the generic path. Drop the duplicated URL-ish prefix.
 */
export function stripBingTitleNoise(title: string): string {
  let t = title.trim();
  t = t.replace(/^[a-z0-9.-]+\.[a-z]{2,}(?:\.[a-z]{2,})?(?:https?:\/\/[^\s]+)?/i, '');
  t = t.replace(/^https?:\/\/\S+/i, '');
  // The host-prefix rule above consumes the host and the scheme's last letter
  // (`host.comhttps:` survives as `://host.com/path Title`), so without this the
  // "title" is a bare URL fragment with the real title stuck behind it.
  t = t.replace(/^:?\/\/\S+/, '');
  return cleanSnippet(t, 300) || title.trim();
}
