/**
 * 360 Search (so.com) — keyless HTML endpoint (`https://www.so.com/s`).
 *
 * Request shape: `q=<query>` and `pn=<n>` (1-based page).
 *
 * Redirect-wrapper quirk: the `<h3><a href>` of every organic result is a
 * `https://www.so.com/link?m=...` click-tracking wrapper. The real destination
 * travels in a `data-mdurl` attribute on that same anchor (with `data-url` /
 * `data-landurl` as older spellings), which is also where the displayed domain
 * — published separately in `<cite>` — can be checked against. We return the
 * attribute URL and only keep the wrapper, flagged `meta.redirect: true`, when
 * no attribute exists, because the fetch tool follows redirects.
 *
 * The SERP also mixes in 360's own translation and AI-answer oneboxes. Those
 * are dropped by the rules below (translator titles, `fanyi.so.com`
 * citations, untitled header rows); the AI-answer card is kept because it is a
 * real titled, reachable page, which is better than a silently short result
 * list.
 *
 * This engine exists in this project because so.com is reachable on networks
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

/** Container for one organic result on the current so.com SERP. */
const CONTAINER_SELECTOR = 'li.res-list';

/** Attributes that carry the unwrapped destination, most reliable first. */
const DESTINATION_ATTRIBUTES = ['data-mdurl', 'data-url', 'data-landurl'];

/** Snippet selectors, most specific first. */
const SNIPPET_SELECTORS = ['.res-desc', '.res-rich', '[class*=desc]', '.res-comm-con'];

/** Date selectors; so.com prints relative ages in its link-info line. */
const DATE_SELECTORS = ['[class*=time]', '.res-linkinfo'];

/** 360's inline translator onebox. */
const TRANSLATOR_TITLE_RE = /360翻译/;

/** 360's own hosts, used to keep the structural fallback off its chrome. */
const SELF_HOSTS = ['so.com', 'fanyi.so.com', 'ai.so.com', '360.cn', '360kan.com', 'haosou.com', 'baidu.com', 'bing.com'];

/**
 * Explicit selector sets for the shared extraction pipeline: used when the
 * attribute-aware pass collapses because so.com served a different template.
 */
const SELECTOR_SETS: SelectorSet[] = [
  {
    container: 'li.res-list',
    link: 'h3 a[href]',
    title: 'h3',
    snippet: '.res-desc, .res-rich, [class*=desc], .res-comm-con',
    date: '[class*=time], .res-linkinfo',
  },
  {
    container: '.res-list, #main .result',
    link: 'h3 a[href]',
    title: 'h3',
    snippet: '.res-desc, [class*=desc]',
  },
];

export function createSo360Engine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'so360',
    label: '360 Search',
    kind: 'html',
    requiresKey: false,
    homepage: 'https://www.so.com/',
    regions: ['cn'],
    transport: 'http',
    note: 'Keyless HTML endpoint; Chinese-language coverage on networks where DuckDuckGo and Google are blocked.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        q: query,
        // so.com expects a 1-based page number; one page yields ~10 results.
        pn: '1',
      });

      const { html, finalUrl, status } = await fetchHtml({ http, config }, `https://www.so.com/s?${params}`, {
        referer: 'https://www.so.com/',
        headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
        timeoutMs: options.timeoutMs,
      });
      detectBlock(status, html, 'so360');

      // `freshness`/`safeSearch` have no key-free equivalent on this endpoint.
      const results = parseSo360Results(html, finalUrl, options.limit * 2);
      return cap(results, options.limit);
    },
  };
}

/**
 * Parse a so.com results page without touching the network.
 *
 * The attribute-aware pass runs first; when it collapses, the shared
 * explicit-selector + structural pipeline takes over.
 */
export function parseSo360Results(html: string, baseUrl: string, limit: number): RawResult[] {
  const explicit = extractSo360Containers(html, baseUrl, limit);
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
function extractSo360Containers(html: string, baseUrl: string, limit: number): RawResult[] {
  const { doc } = parse(html, baseUrl);
  const containers = queryAll(doc, CONTAINER_SELECTOR);
  const results: RawResult[] = [];
  const seen = new Set<string>();

  for (const container of containers) {
    if (limit > 0 && results.length >= limit) break;

    const titleLink = queryOne(container, 'h3 a[href]') ?? queryOne(container, 'h3 a');
    const title = textOf(titleLink) || textOf(queryOne(container, 'h3'));
    // The first `li.res-list` is a header/onebox row with no title at all.
    if (!title) continue;
    if (TRANSLATOR_TITLE_RE.test(title)) continue;

    const cite = textOf(queryOne(container, 'cite'));
    if (isTranslatorHost(cite)) continue;

    const destination = resolveDestination(container, baseUrl);
    if (!destination) continue;
    if (isTranslatorHost(destination.host)) continue;

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
      ...(destination.redirect || cite ? { meta: { ...(destination.redirect ? { redirect: true } : {}), ...(cite ? { displayUrl: cite } : {}) } } : {}),
    });
  }

  return results;
}

/**
 * The real destination for a result container.
 *
 * `data-mdurl` first (so.com duplicates it across the title link and the
 * thumbnail wrapper, and the first occurrence is the title's), then the older
 * `data-url`/`data-landurl`, then the `/link?m=` wrapper itself. A bare
 * `so.com` URL that is not a tracking wrapper is a self-link and rejected;
 * `ai.so.com` is deliberately *not* rejected, because 360's AI-answer card is
 * the only titled, reachable unit the AI tier contributes and it is a distinct
 * host from the translator onebox we drop.
 */
function resolveDestination(container: DomNode, baseUrl: string): { url: string; redirect: boolean; host: string } | null {
  for (const attribute of DESTINATION_ATTRIBUTES) {
    for (const node of queryAll(container, `[${attribute}]`)) {
      const raw = attrOf(node, attribute);
      if (!raw) continue;
      const resolved = absoluteUrl(raw, baseUrl);
      const normalized = resolved ? normalizeUrl(resolved) : null;
      if (!normalized) continue;
      return { url: normalized.url, redirect: isWrapper(normalized.host, normalized.path), host: normalized.host };
    }
  }

  const href = attrOf(queryOne(container, 'h3 a[href]'), 'href') || attrOf(queryOne(container, 'a[href]'), 'href');
  const resolved = absoluteUrl(href, baseUrl);
  const normalized = resolved ? normalizeUrl(resolved) : null;
  if (!normalized) return null;
  const wrapper = isWrapper(normalized.host, normalized.path);
  // A non-wrapper link on so.com itself points back into 360's own SERP
  // services, which is never an organic third-party result.
  if (!wrapper && normalized.host === 'so.com') return null;
  return { url: normalized.url, redirect: wrapper, host: normalized.host };
}

/** True for so.com's own `/link?m=` click-tracking wrapper. */
function isWrapper(host: string, path: string): boolean {
  return host === 'so.com' && path.startsWith('/link');
}

/** `fanyi.so.com` and its sub-domains host the translator onebox only. */
function isTranslatorHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return h === 'fanyi.so.com' || h.endsWith('.fanyi.so.com');
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
