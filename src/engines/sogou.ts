/**
 * Sogou — keyless HTML endpoint (`https://www.sogou.com/web`).
 *
 * Request shape: `query=<query>` and `page=<n>` (1-based).
 *
 * Redirect-wrapper quirk: the `<h3><a href>` of every organic result is a
 * relative `/link?url=hedJja...` click-tracking wrapper, and the wrapper payload
 * is opaque (no readable destination). The real destination is published
 * alongside it in a descendant element's `data-url` attribute, so that is the
 * URL we return. When `data-url` is missing we fall back to the resolved
 * wrapper and flag it with `meta.redirect: true`: the fetch tool follows
 * redirects, so the result is still usable, and dropping it would silently
 * shrink the result set.
 *
 * This engine exists in this project because Sogou is reachable on networks
 * where DuckDuckGo and Google are blocked. That is a verified condition, not an
 * assumption: the sample this parser is written against was captured from such
 * a network, where the global engines fail and the CJK tier carries the search.
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

/** Container for one organic result on the current Sogou SERP. */
const CONTAINER_SELECTOR = '.vrwrap';

/**
 * Snippet selectors, most specific first. `.space-txt`/`.fz-mid` cover the
 * standard web result, `[class*=text-layout]` the "more from this site" card.
 */
const SNIPPET_SELECTORS = ['.str_info', '.space-txt', '.fz-mid', '[class*=text-layout]', '[class*=str-text]', '.s-p'];

/** Date selectors; Sogou prints "4天前" / "2025-04-16" inside its cite line. */
const DATE_SELECTORS = ['[class*=cite]', '.s2', '[class*=time]'];

/** `hintBox` wrappers are "related searches" or inline hints, never results. */
const HINT_CLASS_RE = /hintBox/i;

/** Ids Sogou gives its own injected boxes, e.g. `sogou_vr_30010467_2`. */
const VR_ID_RE = /^sogou_vr_/;

/** Sogou's own hosts, used to keep the structural fallback off its chrome. */
const SELF_HOSTS = ['sogou.com', 'weixin.sogou.com', 'sogoucdn.com', 'sogou.com.cn'];

/**
 * Explicit selector sets for the shared extraction pipeline: used when the
 * `data-url`-aware pass collapses because Sogou served a different template.
 */
const SELECTOR_SETS: SelectorSet[] = [
  {
    container: '.vrwrap',
    link: 'h3 a[href]',
    title: 'h3',
    snippet: '.str_info, .space-txt, .fz-mid, [class*=text-layout], [class*=str-text], .s-p',
    date: '[class*=cite], .s2, [class*=time]',
  },
  {
    container: '.rb, .results .vrwrap',
    link: 'h3 a[href]',
    title: 'h3',
    snippet: '.space-txt, [class*=text-layout]',
  },
];

export function createSogouEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'sogou',
    label: 'Sogou',
    kind: 'html',
    requiresKey: false,
    homepage: 'https://www.sogou.com/',
    regions: ['cn'],
    transport: 'http',
    note: 'Keyless HTML endpoint; Chinese-language coverage on networks where DuckDuckGo and Google are blocked.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        query,
        // Sogou expects a 1-based page number; a single page yields ~10 results.
        page: '1',
      });

      const { html, finalUrl, status } = await fetchHtml({ http, config }, `https://www.sogou.com/web?${params}`, {
        referer: 'https://www.sogou.com/',
        headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        timeoutMs: options.timeoutMs,
      });
      detectBlock(status, html, 'sogou');

      // `freshness` and `safeSearch` need a parameter Sogou only honours with a
      // session cookie; leaving them out keeps the request key-free and stable.
      const results = parseSogouResults(html, finalUrl, options.limit * 2);
      return cap(results, options.limit);
    },
  };
}

/**
 * Parse a Sogou results page without touching the network.
 *
 * The `data-url`-aware pass runs first; when it collapses, the shared
 * explicit-selector + structural pipeline takes over.
 */
export function parseSogouResults(html: string, baseUrl: string, limit: number): RawResult[] {
  const explicit = extractSogouContainers(html, baseUrl, limit);
  if (explicit.length >= 3) return cap(explicit, limit);

  const { results: fallback } = extractResults(html, {
    baseUrl,
    selfHosts: SELF_HOSTS,
    limit,
    sets: SELECTOR_SETS,
  });
  return cap(fallback.length > explicit.length ? fallback : explicit, limit);
}

/** `data-url`-aware pass over the result containers. */
function extractSogouContainers(html: string, baseUrl: string, limit: number): RawResult[] {
  const { doc } = parse(html, baseUrl);
  const containers = queryAll(doc, CONTAINER_SELECTOR);
  const results: RawResult[] = [];
  const seen = new Set<string>();

  for (const container of containers) {
    if (limit > 0 && results.length >= limit) break;
    if (HINT_CLASS_RE.test(attrOf(container, 'class'))) continue;

    const titleLink = queryOne(container, 'h3 a[href]') ?? queryOne(container, 'h3 a');
    const title = textOf(titleLink) || textOf(queryOne(container, 'h3'));
    if (!title) continue;
    // Sogou's injected boxes keep the `sogou_vr_` id prefix and carry a stub
    // title (or none); organic wrappers have a real, longer title.
    if (VR_ID_RE.test(attrOf(container, 'id')) && title.length < 4) continue;

    const destination = resolveDestination(container, baseUrl);
    if (!destination) continue;

    const normalized = normalizeUrl(destination.url);
    if (!normalized || seen.has(normalized.key)) continue;
    seen.add(normalized.key);

    const snippet = cleanSnippet(pickText(container, SNIPPET_SELECTORS, title));
    const publishedAt = parseEngineDate(pickText(container, DATE_SELECTORS, ''));

    results.push({
      title,
      url: normalized.url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(destination.redirect ? { meta: { redirect: true } } : {}),
    });
  }

  return results;
}

/**
 * The real destination for a result container.
 *
 * `data-url` first (the plain target Sogou publishes for the click wrapper),
 * then the wrapper href itself. Hint/related-search links are relative
 * `?user_ip=...&hintidx=...` URLs and are rejected rather than returned.
 */
function resolveDestination(container: DomNode, baseUrl: string): { url: string; redirect: boolean } | null {
  const dataUrl = attrOf(queryOne(container, '[data-url]'), 'data-url');
  if (dataUrl && !dataUrl.startsWith('?')) {
    const resolved = absoluteUrl(dataUrl, baseUrl);
    const normalized = resolved ? normalizeUrl(resolved) : null;
    if (normalized && !isSelfSerp(normalized.host, normalized.path)) {
      return { url: normalized.url, redirect: isWrapper(normalized.host, normalized.path) };
    }
  }

  const href = attrOf(queryOne(container, 'h3 a[href]'), 'href') || attrOf(queryOne(container, 'a[href]'), 'href');
  if (!href || href.startsWith('?')) return null;
  const resolved = absoluteUrl(href, baseUrl);
  const normalized = resolved ? normalizeUrl(resolved) : null;
  if (!normalized) return null;
  const wrapper = isWrapper(normalized.host, normalized.path);
  // A Sogou link that is not the `/link` click wrapper is SERP chrome (paging,
  // "related searches"), never a result.
  if (!wrapper && normalized.host === 'sogou.com') return null;
  return { url: normalized.url, redirect: wrapper };
}

/** True for Sogou's own `/link?url=` click-tracking wrapper. */
function isWrapper(host: string, path: string): boolean {
  return host === 'sogou.com' && path.startsWith('/link');
}

/** True when a URL points back at Sogou's own SERP rather than at a result. */
function isSelfSerp(host: string, path: string): boolean {
  return host === 'sogou.com' && (path.startsWith('/web') || path.startsWith('/sogou'));
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
