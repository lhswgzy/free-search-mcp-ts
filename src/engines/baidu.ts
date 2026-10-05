/**
 * Baidu — keyless HTML endpoint (`https://www.baidu.com/s`).
 *
 * Request shape: `wd=<query>`, `rn=<limit * 2>` (page size) and `pn=<offset>`
 * (0-based offset of the first result), plus `ie=utf-8` to force a UTF-8
 * response instead of the GBK the endpoint still serves some clients.
 *
 * Redirect-wrapper quirk: every organic `<h3><a href>` points at
 * `http://www.baidu.com/link?url=...`, a click-tracking redirector. The real
 * destination is only exposed as an attribute on the result *container*
 * (`mu`, then `data-landurl`/`data-url`), so we read the attribute first. When
 * no attribute is usable we keep the wrapper and flag it with
 * `meta.redirect: true` rather than dropping the result: the fetch tool
 * follows redirects, so a wrapped result is still usable. The one value we do
 * reject is `http://nourl.ubs.baidu.com/...`, Baidu's placeholder for onebox
 * and ad units that have no destination at all.
 *
 * This engine exists in this project because Baidu is reachable on networks
 * where DuckDuckGo and Google are blocked. That is a verified condition, not an
 * assumption: the samples this parser is written against were captured from
 * such a network, where the global engines fail and the CJK tier carries the
 * whole search.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import {
  absoluteUrl,
  attrOf,
  cap,
  cleanSnippet,
  detectBlock,
  extractResults,
  fetchHtml,
  isUselessSnippet,
  parse,
  parseDateLoose,
  queryAll,
  queryOne,
  textOf,
  type EngineDeps,
  type SelectorSet,
} from './kit.js';
import { normalizeUrl } from '../util/url.js';

/** Container selectors, most specific first (all verified on a real capture). */
const CONTAINER_SELECTORS = ['#content_left .result', '.result.c-container', '#content_left .c-container'];

/**
 * Snippet selectors. Baidu obfuscates class suffixes, so attribute-substring
 * selectors survive template churn far better than exact class names.
 * `[class*=summary-text]` is the current PC card layout; the rest are the
 * legacy result block.
 */
const SNIPPET_SELECTORS = [
  '[class*=summary-text]',
  '[class*=content-right]',
  '.c-abstract',
  '[class*=abstract]',
  'span[class*=content-right]',
  'div[class*=c-abstract]',
];

/** Date selectors: `prefix-time` is the current card layout. */
const DATE_SELECTORS = ['[class*=prefix-time]', '[class*=c-color-gray]', '[class*=c-color-gray2]', '[class*=c-gap-top] span'];

/** Where Baidu prints the destination host for wrapped results. */
const DISPLAY_URL_SELECTORS = ['cite', '[class*=c-showurl]'];

/** Baidu's "this unit has no destination" placeholder (onebox/ad units). */
const NOURL_RE = /nourl\.ubs\.baidu\.com/i;

/** Attribute values Baidu writes when it means "nothing". */
const NULLISH = new Set(['null', 'undefined', 'none', 'false']);

/** Baidu's own hosts, used to keep the structural fallback off its chrome. */
const SELF_HOSTS = [
  'baidu.com',
  'm.baidu.com',
  'nourl.ubs.baidu.com',
  'baiducontent.com',
  'bdstatic.com',
  'bdimg.com',
  'bcebos.com',
];

/**
 * Explicit selector sets for the shared extraction pipeline. They are the
 * second line of defence: when the attribute-aware pass below finds nothing
 * (Baidu served a different template), `extractResults` tries these and then
 * degrades to structural extraction.
 */
const SELECTOR_SETS: SelectorSet[] = [
  {
    container: '#content_left .result',
    link: 'h3 a[href]',
    title: 'h3',
    snippet: '[class*=summary-text], [class*=content-right], .c-abstract, [class*=abstract]',
    date: '[class*=prefix-time], [class*=c-color-gray], [class*=c-gap-top] span',
  },
  {
    container: '.result.c-container, #content_left .c-container',
    link: 'h3 a[href]',
    title: 'h3',
    snippet: '[class*=content-right], .c-abstract, [class*=abstract]',
    date: '[class*=c-color-gray], [class*=c-gap-top] span',
  },
];

export function createBaiduEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'baidu',
    label: 'Baidu',
    kind: 'html',
    requiresKey: false,
    homepage: 'https://www.baidu.com/',
    regions: ['cn'],
    transport: 'http',
    note: 'Keyless HTML endpoint; strong Chinese-language coverage on networks where DuckDuckGo and Google are blocked.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        wd: query,
        // Baidu serves ~10 organic results per page; ask for headroom so the
        // de-duplicating pass still has `limit` survivors.
        rn: String(Math.min(Math.max(options.limit * 2, 10), 50)),
        pn: '0',
        ie: 'utf-8',
      });

      const { html, finalUrl, status } = await fetchHtml({ http, config }, `https://www.baidu.com/s?${params}`, {
        referer: 'https://www.baidu.com/',
        headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        timeoutMs: options.timeoutMs,
      });
      detectBlock(status, html, 'baidu');

      // `freshness`/`safeSearch` have no documented keyless equivalents here;
      // ignoring them is better than sending a parameter Baidu misreads.
      const results = parseBaiduResults(html, finalUrl, options.limit * 2);
      return cap(results, options.limit);
    },
  };
}

/**
 * Parse a Baidu results page without touching the network.
 *
 * The attribute-aware container pass runs first because it recovers the real
 * destination URL; when it collapses (markup change, different template) the
 * shared explicit-selector + structural pipeline takes over.
 */
export function parseBaiduResults(html: string, baseUrl: string, limit: number): RawResult[] {
  const explicit = extractBaiduContainers(html, baseUrl, limit);
  if (explicit.length >= 3) return cap(explicit, limit);

  const { results: fallback } = extractResults(html, {
    baseUrl,
    selfHosts: SELF_HOSTS,
    limit,
    sets: SELECTOR_SETS,
  });
  return cap(fallback.length > explicit.length ? fallback : explicit, limit);
}

/** Attribute-aware pass over the result containers. */
function extractBaiduContainers(html: string, baseUrl: string, limit: number): RawResult[] {
  const { doc } = parse(html, baseUrl);
  const containers = pickContainers(doc);
  const results: RawResult[] = [];
  const seen = new Set<string>();

  for (const container of containers) {
    if (limit > 0 && results.length >= limit) break;

    const titleLink = queryOne(container, 'h3 a[href]') ?? queryOne(container, 'h3 a');
    const title = textOf(titleLink) || textOf(queryOne(container, 'h3'));
    if (!title) continue;

    const destination = resolveDestination(container, baseUrl);
    if (!destination) continue;

    const normalized = normalizeUrl(destination.url);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);

    const snippet = cleanSnippet(pickText(container, SNIPPET_SELECTORS, title));
    const publishedAt = parseEngineDate(pickText(container, DATE_SELECTORS, ''));
    const displayUrl = destination.redirect ? pickText(container, DISPLAY_URL_SELECTORS, '') : '';

    results.push({
      title,
      url: normalized.url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(destination.redirect || displayUrl
        ? {
            meta: {
              ...(destination.redirect ? { redirect: true } : {}),
              ...(displayUrl ? { displayUrl } : {}),
            },
          }
        : {}),
    });
  }

  return results;
}

/** First container selector that matches anything. */
function pickContainers(doc: ReturnType<typeof parse>['doc']): DomNode[] {
  for (const selector of CONTAINER_SELECTORS) {
    const nodes = queryAll(doc, selector);
    if (nodes.length) return nodes;
  }
  return [];
}

/**
 * The real destination for a result container.
 *
 * Order: `mu` (carries the plain target), then `data-landurl`/`data-url`
 * (used by some card templates), then the `/link?url=` wrapper. A `nourl`
 * placeholder means the unit has no destination at all, so the container is
 * dropped instead of being reported as a bare redirect.
 */
function resolveDestination(container: DomNode, baseUrl: string): { url: string; redirect: boolean } | null {
  const mu = attrOf(container, 'mu');
  if (mu && NOURL_RE.test(mu)) return null;

  for (const attribute of ['mu', 'data-landurl', 'data-url']) {
    const raw = attrOf(container, attribute);
    if (!raw || NULLISH.has(raw.toLowerCase())) continue;
    if (NOURL_RE.test(raw)) continue;
    const normalized = normalizeUrl(raw);
    // A wrapper stored in an attribute is still a wrapper; mark it so callers
    // know the URL needs following.
    if (normalized) return { url: normalized.url, redirect: isWrapper(normalized.host, normalized.path) };
  }

  const href = attrOf(queryOne(container, 'h3 a[href]'), 'href');
  const wrapper = absoluteUrl(href, baseUrl);
  if (!wrapper) return null;
  const normalized = normalizeUrl(wrapper);
  if (!normalized) return null;
  return { url: normalized.url, redirect: true };
}

/** True for Baidu's own `/link?url=` click-tracking wrapper. */
function isWrapper(host: string, path: string): boolean {
  return host === 'baidu.com' && path.startsWith('/link');
}

/** Text of the first selector that yields a snippet worth keeping. */
function pickText(root: DomNode, selectors: string[], title: string): string {
  for (const selector of selectors) {
    // Snippets are rendered as one line everywhere downstream, so fold the
    // engine's layout newlines into spaces here.
    const text = textOf(queryOne(root, selector)).replace(/\s*\n+\s*/g, ' ');
    if (!text) continue;
    if (title && isUselessSnippet(text, title)) continue;
    return text;
  }
  return '';
}

/** Match the date-ish token inside engine chrome, then hand it to the parser. */
const DATE_TOKEN_RE =
  /(\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}\s*(?:秒|分钟|分|小时|天|日|周|个?月|年)\s*(?:前|以前)|\d{1,2}\s*(?:hours?|minutes?|days?|weeks?|months?|years?)\s*ago)/i;

function parseEngineDate(text: string): string | undefined {
  if (!text) return undefined;
  const token = DATE_TOKEN_RE.exec(text);
  return parseDateLoose(token?.[1] ?? text);
}

/** Structural element type as produced by the kit's DOM helpers. */
type DomNode = NonNullable<ReturnType<typeof queryOne>>;
