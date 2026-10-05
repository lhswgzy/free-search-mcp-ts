/**
 * Shared building blocks for search engines.
 *
 * Engine scrapers break. Rather than hand-writing a brittle selector for every
 * provider, each engine declares whatever specific selectors it knows and then
 * falls back to `extractGenericResults`, which finds result-looking anchors
 * structurally. That is what lets a provider silently change its markup (or
 * serve a different layout to a different region) without zeroing out the
 * whole search.
 */

import { parseHTML } from 'linkedom';
import type { RawResult } from '../types.js';
import type { HttpClient, HttpRequestOptions } from '../http.js';
import type { Config } from '../config.js';
import { htmlToText, decodeEntities } from '../html/markdown.js';
import { collapseWhitespace, hasCJK, truncate } from '../util/text.js';
import { normalizeUrl } from '../util/url.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('engine');

/** An engine failure that is worth surfacing distinctly (blocked, captcha). */
export class EngineError extends Error {
  constructor(
    message: string,
    readonly options: { engine: string; blocked?: boolean; status?: number; cause?: unknown } = { engine: 'unknown' },
  ) {
    super(message, { cause: options.cause });
    this.name = 'EngineError';
  }

  get blocked(): boolean {
    return this.options.blocked ?? false;
  }
}

/* ------------------------------------------------------------------ *
 * DOM helpers (structural, so they survive markup changes)
 * ------------------------------------------------------------------ */

interface El {
  getAttribute(name: string): string | null;
  textContent?: string | null;
  innerHTML?: string;
  nodeName?: string;
  parentElement?: El | null;
  children?: Iterable<El>;
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
  closest?(sel: string): El | null;
  remove?(): void;
}

interface Doc {
  querySelector(sel: string): El | null;
  querySelectorAll(sel: string): Iterable<El>;
}

export interface HtmlDocument {
  doc: Doc;
  /** Serialised HTML, useful for debugging a failed parse. */
  raw: string;
}

/** Parse HTML with linkedom, returning a structural document wrapper. */
export function parse(html: string, baseUrl?: string): HtmlDocument {
  const parsed = parseHTML(
    html,
    (baseUrl ? { url: baseUrl } : undefined) as unknown as Parameters<typeof parseHTML>[1],
  ) as unknown as { document: Doc };
  return { doc: parsed.document, raw: html };
}

export function textOf(el: El | null | undefined): string {
  if (!el) return '';
  return collapseWhitespace(decodeEntities(el.textContent ?? ''));
}

export function attrOf(el: El | null | undefined, name: string): string {
  if (!el) return '';
  return (el.getAttribute(name) ?? '').trim();
}

export function queryAll(root: Doc | El, selector: string): El[] {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

export function queryOne(root: Doc | El, selector: string): El | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

/** Resolve a possibly relative href against the page URL. */
export function absoluteUrl(href: string, base: string): string | null {
  const h = (href || '').trim();
  if (!h) return null;
  if (/^(?:javascript|mailto|tel|data|blob):/i.test(h)) return null;
  if (h.startsWith('#')) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Snippet and date clean-up
 * ------------------------------------------------------------------ */

const SNIPPET_NOISE: RegExp[] = [
  /^\s*(?:web\s*)?(?:result|results?)\s*[:.]?\s*/i,
  /^\s*·\s*/,
  /^\s*[-–—|]\s*/,
  /^\s*(?:read more|learn more|more)\s*$/i,
  /\s*(?:read more|learn more|view more)\s*$/i,
  /\s*\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s*[-–—]\s*/i,
];

/** Normalise an engine-provided snippet. */
export function cleanSnippet(input: string, max = 480): string {
  let s = collapseWhitespace(decodeEntities((input || '').replace(/<[^>]*>/g, ' ')));
  for (const re of SNIPPET_NOISE) s = s.replace(re, '');
  s = s.replace(/^[\s\-–—:|·]+/, '').replace(/[\s\-–—:|·]+$/, '');
  if (s.length > max) s = truncate(s, max);
  return s;
}

/** True when a snippet is just the title repeated, or otherwise useless. */
export function isUselessSnippet(snippet: string, title: string): boolean {
  const s = snippet.trim().toLowerCase();
  if (s.length < 12 && !hasCJK(s)) return true;
  const t = title.trim().toLowerCase();
  if (!s || !t) return false;
  if (s === t) return true;
  if (t.length > 12 && (s.startsWith(t) || t.startsWith(s)) && Math.abs(s.length - t.length) < 8) return true;
  if (/^(?:click here|no description|untitled|n\/a|skip to content)/i.test(s)) return true;
  return false;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Best-effort date parsing across the formats engines actually emit.
 * Returns an ISO-8601 string, or undefined when nothing recognisable is found.
 */
export function parseDateLoose(input: string | undefined | null, now = Date.now()): string | undefined {
  const s = (input ?? '').toString().trim();
  if (!s) return undefined;

  // Already ISO-ish. Fractional seconds are accepted and dropped, because
  // several APIs emit them (crates.io `updated_at`, GitHub `pushed_at`).
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?/.exec(s);
  if (iso) {
    const [, y, mo, d, hh = '00', mm = '00', ss = '00'] = iso;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }

  // Unix seconds / milliseconds.
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();

  // Relative: "3 hours ago", "2 days ago", "5 分钟前", "昨天".
  const rel = /(\d+)\s*(second|sec|minute|min|hour|hr|day|week|month|year|s|m|h|d|w|y)s?\s*ago/i.exec(s);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms =
      unit.startsWith('sec') || unit === 's' ? 1000 :
      unit.startsWith('min') || unit === 'm' ? 60_000 :
      unit.startsWith('h') ? 3_600_000 :
      unit.startsWith('d') ? 86_400_000 :
      unit.startsWith('w') ? 604_800_000 :
      unit.startsWith('mo') ? 2_592_000_000 :
      31_536_000_000;
    return new Date(now - amount * ms).toISOString();
  }
  const relCjk = /(\d+)\s*(秒|分钟|分|小时|天|日|周|个?月|年)\s*(?:前|以前)/.exec(s);
  if (relCjk) {
    const amount = Number(relCjk[1]);
    const unit = relCjk[2]!;
    const ms =
      unit === '秒' ? 1000 :
      unit === '分钟' || unit === '分' ? 60_000 :
      unit === '小时' ? 3_600_000 :
      unit === '天' || unit === '日' ? 86_400_000 :
      unit === '周' ? 604_800_000 :
      unit.includes('月') ? 2_592_000_000 :
      31_536_000_000;
    return new Date(now - amount * ms).toISOString();
  }
  if (/昨天/.test(s)) return new Date(now - 86_400_000).toISOString();
  if (/今天|刚刚|just now|moments? ago/i.test(s)) return new Date(now).toISOString();

  // "Jan 5, 2024" / "5 January 2024" / "January 5 2024".
  const mdy = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/.exec(s);
  if (mdy && MONTHS[mdy[1]!.toLowerCase()]) {
    return new Date(Date.UTC(Number(mdy[3]), MONTHS[mdy[1]!.toLowerCase()]! - 1, Number(mdy[2]))).toISOString();
  }
  const dmy = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/.exec(s);
  if (dmy && MONTHS[dmy[2]!.toLowerCase()]) {
    return new Date(Date.UTC(Number(dmy[3]), MONTHS[dmy[2]!.toLowerCase()]! - 1, Number(dmy[1]))).toISOString();
  }
  // Chinese: 2024年1月5日
  const cjkDate = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/.exec(s);
  if (cjkDate) {
    return new Date(Date.UTC(Number(cjkDate[1]), Number(cjkDate[2]) - 1, Number(cjkDate[3]))).toISOString();
  }

  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) {
    // Guard against engines emitting nonsense like "1970-01-01" defaults.
    if (parsed > Date.UTC(1990, 0, 1) && parsed < now + 400 * 86_400_000) return new Date(parsed).toISOString();
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Generic result extraction
 * ------------------------------------------------------------------ */

/** Anchor texts that are site chrome rather than results. */
const CHROME_TEXT = /^(?:home|about|contact|privacy|policy|terms|login|sign in|sign up|register|help|faq|blog|news|next|previous|next page|prev|more|settings|menu|search|english|中文|日本語|deutsch|français|español|top|back to top|skip to (?:main )?content|advertis(?:e|ing)|careers|jobs|sitemap|rss|feedback|download|docs?|api|status|legal|cookies?)$/i;

export interface GenericExtractOptions {
  /** Absolute page URL, used to resolve hrefs. */
  baseUrl: string;
  /** Hosts that are the engine itself (or its CDN) and must be skipped. */
  selfHosts?: string[];
  /** Minimum anchor text length. Default 12 (8 for CJK). */
  minTitleLength?: number;
  /** Minimum snippet length to accept a candidate. Default 24. */
  minSnippetLength?: number;
  /** How far up the tree to look for a container that also holds a snippet. */
  maxContainerDepth?: number;
  /** Extra selector whose matches become candidate result roots. */
  containerSelector?: string;
  limit?: number;
}

interface Candidate {
  url: string;
  title: string;
  snippet: string;
  order: number;
  depth: number;
}

/**
 * Extract search results structurally: every link that looks like a result,
 * paired with the nearest surrounding text that looks like a snippet.
 *
 * Deliberately not selector-driven. It costs a little precision on exotic
 * layouts but means a markup change degrades result quality instead of
 * producing an empty list.
 */
export function extractGenericResults(html: string, options: GenericExtractOptions): RawResult[] {
  const { baseUrl } = options;
  const selfHosts = new Set((options.selfHosts ?? []).map((h) => h.toLowerCase()));
  const minTitle = options.minTitleLength ?? 12;
  const minSnippet = options.minSnippetLength ?? 24;
  const maxDepth = options.maxContainerDepth ?? 4;

  const { doc } = parse(html, baseUrl);
  const anchors = queryAll(doc, 'a[href]');
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  let order = 0;

  for (const anchor of anchors) {
    order++;
    const href = attrOf(anchor, 'href');
    const url = absoluteUrl(href, baseUrl);
    if (!url) continue;

    const normalized = normalizeUrl(url);
    if (!normalized) continue;
    if (selfHosts.has(normalized.host)) continue;

    const title = textOf(anchor);
    const titleIsShort = hasCJK(title) ? title.length < 4 : title.length < minTitle;
    if (!title || titleIsShort) continue;
    if (CHROME_TEXT.test(title)) continue;
    if (seen.has(normalized.key)) continue;

    // Walk up looking for the smallest container that adds snippet text.
    let snippet = '';
    let depth = 0;
    let node: El | null | undefined = anchor;
    let bestContainer: El | null = null;
    while (node && depth < maxDepth) {
      node = node.parentElement ?? null;
      if (!node) break;
      depth++;
      const containerText = textOf(node);
      // Remove the title from the container text to isolate the snippet.
      const remainder = collapseWhitespace(containerText.replace(title, ' ')).replace(/\s+/g, ' ').trim();
      if (remainder.length >= minSnippet) {
        bestContainer = node;
        snippet = remainder;
        break;
      }
    }

    // A link with no surrounding text is still a valid result, just without a
    // snippet; keep it, because a bare title beats a missing source.
    if (!bestContainer) snippet = '';

    // If the container is enormous, the "snippet" is really the whole page.
    if (snippet.length > 1200) snippet = truncate(snippet, 480);

    seen.add(normalized.key);
    candidates.push({
      url: normalized.url,
      title: collapseWhitespace(title),
      snippet: cleanSnippet(snippet),
      order,
      depth,
    });
  }

  // Prefer candidates that have a snippet and were found at a shallower depth
  // (deep matches are usually nested links inside a result, e.g. breadcrumbs).
  const ranked = candidates
    .map((c) => ({
      ...c,
      score: (c.snippet ? 2 : 0) + (c.depth > 0 && c.depth <= 3 ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const results: RawResult[] = [];
  for (const c of ranked) {
    results.push({
      title: c.title,
      url: c.url,
      ...(c.snippet ? { snippet: c.snippet } : {}),
    });
    if (options.limit && results.length >= options.limit) break;
  }
  return results;
}

/**
 * Extract results using an explicit list of container selectors, each with its
 * own link/title/snippet selectors. Falls through to the next selector set when
 * a set produces nothing, and to `extractGenericResults` when all of them fail.
 */
export interface SelectorSet {
  /** Container for one result. */
  container: string;
  /** Link selector relative to the container (default `a[href]`). */
  link?: string;
  /** Title selector relative to the container, when the title is not the link. */
  title?: string;
  /** Snippet selector relative to the container. */
  snippet?: string;
  /** Date selector relative to the container. */
  date?: string;
}

export function extractWithSelectors(html: string, baseUrl: string, sets: SelectorSet[], limit = 20): RawResult[] {
  const { doc } = parse(html, baseUrl);
  for (const set of sets) {
    const containers = queryAll(doc, set.container);
    if (containers.length === 0) continue;
    const out: RawResult[] = [];
    const seen = new Set<string>();
    for (const container of containers) {
      const link = queryOne(container, set.link ?? 'a[href]');
      if (!link) continue;
      const url = absoluteUrl(attrOf(link, 'href'), baseUrl);
      if (!url) continue;
      const normalized = normalizeUrl(url);
      if (!normalized || seen.has(normalized.key)) continue;

      const titleEl = set.title ? queryOne(container, set.title) : link;
      const title = textOf(titleEl ?? link);
      if (!title) continue;

      const snippet = set.snippet ? cleanSnippet(textOf(queryOne(container, set.snippet))) : '';
      const rawDate = set.date ? textOf(queryOne(container, set.date)) : '';
      const publishedAt = rawDate ? parseDateLoose(rawDate) : undefined;

      seen.add(normalized.key);
      out.push({
        title,
        url: normalized.url,
        ...(snippet ? { snippet } : {}),
        ...(publishedAt ? { publishedAt } : {}),
      });
      if (out.length >= limit) break;
    }
    if (out.length > 0) return out;
  }
  return [];
}

/**
 * Combine an explicit selector pass with the generic fallback.
 *
 * Explicit selectors win when they produce a healthy list; the generic pass
 * fills in when they do not.
 */
export function extractResults(
  html: string,
  options: GenericExtractOptions & { sets?: SelectorSet[]; limit?: number },
): { results: RawResult[]; strategy: 'selectors' | 'generic' } {
  const limit = options.limit ?? 20;
  if (options.sets?.length) {
    const specific = extractWithSelectors(html, options.baseUrl, options.sets, limit);
    const generic = extractGenericResults(html, { ...options, limit: Math.max(limit, specific.length) });
    // Two results from a layout-specific selector can be a partial match; the
    // generic pass is usually better in that case.
    if (specific.length >= 3) {
      return { results: specific, strategy: 'selectors' };
    }
    if (generic.length > specific.length) return { results: generic, strategy: 'generic' };
    return { results: specific, strategy: 'selectors' };
  }
  return { results: extractGenericResults(html, { ...options, limit }), strategy: 'generic' };
}

/**
 * Merge two extraction passes without losing what either one found.
 *
 * `extractResults` picks one pass wholesale, which is the right call for a
 * single result list but loses rows on layouts where the selector pass cannot
 * pair a link with its snippet (DuckDuckGo lite keeps them in sibling table
 * rows). Here the first list defines the ranking and the second only fills in
 * fields it has and the first one lacks.
 */
export function mergeResults(primary: RawResult[], secondary: RawResult[], limit?: number): RawResult[] {
  const out: RawResult[] = [];
  const index = new Map<string, number>();

  const push = (result: RawResult): void => {
    const key = normalizeUrl(result.url)?.key ?? result.url;
    const existing = index.get(key);
    if (existing === undefined) {
      index.set(key, out.length);
      out.push({ ...result, meta: result.meta ? { ...result.meta } : undefined });
      return;
    }
    const kept = out[existing]!;
    if (!kept.snippet && result.snippet) kept.snippet = result.snippet;
    if (!kept.publishedAt && result.publishedAt) kept.publishedAt = result.publishedAt;
    if (result.meta) kept.meta = { ...(result.meta ?? {}), ...(kept.meta ?? {}) };
  };

  for (const result of primary) push(result);
  for (const result of secondary) push(result);
  return limit && limit > 0 ? out.slice(0, limit) : out;
}

/* ------------------------------------------------------------------ *
 * Blocking / captcha detection
 * ------------------------------------------------------------------ */

const BLOCK_SIGNALS: { re: RegExp; reason: string }[] = [
  { re: /captcha|recaptcha|hcaptcha|turnstile/i, reason: 'captcha challenge' },
  { re: /unusual traffic|automated queries|automated access/i, reason: 'automated-query block' },
  { re: /access denied|forbidden|not authorised|not authorized/i, reason: 'access denied' },
  { re: /rate ?limit|too many requests|try again later/i, reason: 'rate limited' },
  { re: /enable javascript and cookies to continue|please enable js/i, reason: 'javascript required' },
  { re: /consent\.google|before you continue|accept all cookies/i, reason: 'consent interstitial' },
];

/**
 * Detect an anti-bot interstitial so the engine can be benched instead of
 * being reported as "0 results".
 */
export function detectBlock(status: number, body: string, engine: string): void {
  if (status === 429) throw new EngineError(`${engine}: HTTP 429 (rate limited)`, { engine, blocked: true, status });
  if (status === 403) throw new EngineError(`${engine}: HTTP 403 (blocked)`, { engine, blocked: true, status });
  if (status === 503 && /captcha|challenge/i.test(body)) {
    throw new EngineError(`${engine}: HTTP 503 (challenge)`, { engine, blocked: true, status });
  }
  if (status >= 400) throw new EngineError(`${engine}: HTTP ${status}`, { engine, status });
  if (body.length < 512) {
    const head = body.slice(0, 600);
    for (const signal of BLOCK_SIGNALS) {
      if (signal.re.test(head)) {
        throw new EngineError(`${engine}: ${signal.reason}`, { engine, blocked: true, status });
      }
    }
    // A tiny body with no result-looking anchors is a soft block.
    if (!/<a\s[^>]*href=/i.test(body)) {
      throw new EngineError(`${engine}: empty response body (likely blocked)`, { engine, blocked: true, status });
    }
  }
}

/* ------------------------------------------------------------------ *
 * Engine convenience wrappers
 * ------------------------------------------------------------------ */

/**
 * What every engine receives at construction time. Engines are pure factories
 * over this so they can be swapped, stubbed and unit-tested without touching
 * the network.
 */
export interface EngineDeps {
  http: HttpClient;
  config: Config;
}

export interface HtmlFetchOptions extends Omit<HttpRequestOptions, 'signal'> {
  /** Human page URL used as the Referer, when the engine cares. */
  referer?: string;
}

/** Fetch an HTML page with engine-appropriate defaults. */
export async function fetchHtml(
  deps: EngineDeps,
  url: string,
  options: HtmlFetchOptions = {},
): Promise<{ html: string; finalUrl: string; status: number }> {
  const res = await deps.http.request(url, {
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    retries: 1,
    ...options,
  });
  return { html: res.body, finalUrl: res.url, status: res.status };
}

/** Fetch JSON with engine-appropriate defaults. */
export async function fetchJson<T>(deps: EngineDeps, url: string, options: HttpRequestOptions = {}): Promise<T> {
  return deps.http.getJson<T>(url, { retries: 1, ...options });
}

/** Trim an engine's result list to the requested limit. */
export function cap(results: RawResult[], limit: number): RawResult[] {
  return limit > 0 ? results.slice(0, limit) : results;
}

/** Strip HTML from a JSON API field (Wikipedia's search API returns `<span>`). */
export function stripHtml(input: string): string {
  if (!input) return '';
  return /<[a-z][\s\S]*>/i.test(input) ? collapseWhitespace(htmlToText(input)) : collapseWhitespace(decodeEntities(input));
}

/** Log a parse that produced nothing, with a hint for later debugging. */
export function warnEmptyResults(engine: string, html: string, strategy: string): void {
  log.debug(`${engine}: ${strategy} extraction produced 0 results (${html.length} bytes)`);
}
