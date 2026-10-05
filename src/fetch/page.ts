/**
 * The page fetcher.
 *
 * One entry point, `fetchPage`, that turns any http(s) URL into Markdown plus
 * metadata, honouring robots.txt, the SSRF guard, the local SQLite cache and
 * the byte/character budgets.
 *
 * Design notes:
 *   - Content type is decided from the response header *and* the URL extension,
 *     because a surprising number of servers serve PDFs as octet-stream.
 *   - Long pages are truncated rather than rejected, and the returned
 *     `nextOffset` lets a model read the rest in a follow-up call. That keeps
 *     one tool call from blowing the context window.
 *   - Conditional requests (ETag / Last-Modified) are stored, so a refresh of
 *     an unchanged page costs a 304 rather than a full body.
 */

import type { Config } from '../config.js';
import type { FetchedPage } from '../types.js';
import { createHttpClient, HttpError, BlockedUrlError, type HttpClient } from '../http.js';
import { getCache } from '../cache.js';
import { RobotsCache } from '../robots.js';
import { htmlToMarkdown, extractLinks, htmlToText } from '../html/markdown.js';
import { detectDocumentKind, parseDocument } from './documents.js';
import { normalizeUrl } from '../util/url.js';
import { collapseWhitespace, estimateTokens, tidyMarkdown, truncate } from '../util/text.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('fetch');

export interface FetchPageOptions {
  /** Read from the cache when it is fresher than the TTL (default true). */
  useCache?: boolean;
  /** Ignore any cached copy and refetch (default false). */
  refresh?: boolean;
  /** Maximum characters returned (default from config). */
  maxChars?: number;
  /** Skip this many characters into the content, for paginating long pages. */
  offset?: number;
  /** Honour robots.txt (default from config). */
  respectRobots?: boolean;
  /** Collect outgoing links from the body (default true). */
  includeLinks?: boolean;
  /** Request timeout in ms. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Allow private/loopback hosts (tests, local fixtures). */
  allowPrivateHosts?: boolean;
}

const HTML_TYPES = /^(?:text\/html|application\/xhtml\+xml|application\/xml|text\/xml)$/;

export class FetchService {
  private readonly robots: RobotsCache;

  constructor(
    private readonly config: Config,
    private readonly http: HttpClient = createHttpClient(config),
  ) {
    this.robots = new RobotsCache(this.http, config, config.userAgent ?? 'free-search-mcp/0.1.0');
  }

  /**
   * Fetch a URL and convert it to Markdown (or text, for non-HTML documents).
   *
   * Throws only for genuinely unusable input: a blocked/private URL, a robots
   * disallow, or an HTTP failure. A page that cannot be converted still returns
   * a `FetchedPage` with an explanatory body.
   */
  async fetchPage(rawUrl: string, options: FetchPageOptions = {}): Promise<FetchedPage> {
    const normalized = normalizeUrl(rawUrl);
    if (!normalized) {
      throw new BlockedUrlError(rawUrl, 'not a valid absolute http(s) URL');
    }
    const url = normalized.url;
    const cache = getCache(this.config);
    const maxChars = options.maxChars ?? this.config.maxMarkdownChars;
    const offset = Math.max(0, options.offset ?? 0);
    const warnings: string[] = [];

    // 1. Cache.
    if (this.config.cacheEnabled && options.useCache !== false && !options.refresh) {
      const hit = cache.getPage(url, this.config.cacheTtlMs);
      if (hit) {
        log.debug(`cache hit for ${url}`);
        return this.slicePage({ ...hit, cached: true }, offset, maxChars);
      }
    }

    // 2. robots.txt.
    const robotsCheck = await this.robots.check(url, { respect: options.respectRobots ?? this.config.respectRobots });
    if (!robotsCheck.allowed) {
      warnings.push(`robots.txt disallow honoured: ${robotsCheck.reason}. Set FREE_SEARCH_RESPECT_ROBOTS=0 to override.`);
      throw new HttpError(`Blocked by robots.txt: ${robotsCheck.reason}`, { url, status: 0, retryable: false });
    }

    // 3. Network.
    const accept =
      'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.6';
    const res = await this.http.request(url, {
      accept,
      maxBytes: this.config.maxFetchBytes,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.allowPrivateHosts ? { allowPrivate: true } : {}),
      binary: true,
    });

    const contentType = (res.headers.get?.('content-type') ?? '').toLowerCase();
    const finalUrl = normalizeUrl(res.url)?.url ?? url;
    const fetchedAt = new Date().toISOString();

    // 4. Convert.
    const page = await this.convert(res.bytes, finalUrl, contentType, fetchedAt, warnings, options.includeLinks !== false);

    // 5. Cache the *full* body, so later pagination and local search see it all.
    if (this.config.cacheEnabled && page.status >= 200 && page.status < 300) {
      try {
        cache.putPage(page, {
          ...(res.headers.get?.('etag') ? { etag: res.headers.get('etag')! } : {}),
          ...(res.headers.get?.('last-modified') ? { lastModified: res.headers.get('last-modified')! } : {}),
        });
      } catch (err) {
        log.debug(`cache write failed for ${url}: ${(err as Error).message}`);
      }
    }

    return this.slicePage(page, offset, maxChars);
  }

  /** Convert a raw response body into a `FetchedPage` without truncation. */
  private async convert(
    bytes: Uint8Array,
    finalUrl: string,
    contentType: string,
    fetchedAt: string,
    warnings: string[],
    includeLinks: boolean,
  ): Promise<FetchedPage> {
    const kind = detectDocumentKind(contentType, finalUrl);
    const base: Omit<FetchedPage, 'content' | 'contentFormat' | 'wordCount' | 'title'> = {
      url: finalUrl,
      finalUrl,
      contentType: contentType || 'unknown',
      status: 200,
      fetchedAt,
      cached: false,
      ...(warnings.length ? { warnings } : {}),
    };

    if (HTML_TYPES.test(contentType) || kind === 'html') {
      const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const article = htmlToMarkdown(html, { url: finalUrl });
      const withTitle = ensureTitle(article.title, article.markdown);
      return {
        ...base,
        title: article.title || finalUrl,
        content: withTitle,
        contentFormat: 'markdown',
        wordCount: countWords(article.textContent || withTitle),
        ...(article.byline ? { byline: article.byline } : {}),
        ...(article.publishedAt ? { publishedAt: normaliseDate(article.publishedAt) } : {}),
        ...(article.excerpt ? { excerpt: collapseWhitespace(article.excerpt).slice(0, 400) } : {}),
        ...(article.language ? { language: article.language } : {}),
        ...(article.siteName ? { siteName: article.siteName } : {}),
        ...(includeLinks ? { links: extractLinks(withTitle, 60) } : {}),
      };
    }

    if (kind === 'unknown' && !contentType.startsWith('text/')) {
      // Binary we cannot read: report honestly rather than dumping bytes.
      return {
        ...base,
        title: lastPathSegment(finalUrl),
        content: `_Unsupported content type "${contentType || 'unknown'}". This server can read HTML, PDF, DOCX, XLSX, PPTX, EPUB, ODT, CSV, JSON and plain text._`,
        contentFormat: 'text',
        wordCount: 0,
        warnings: [...warnings, `unsupported content type: ${contentType}`],
      };
    }

    if (kind === 'text') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      // A "text/plain" response that is really HTML is common enough to matter.
      if (/^\s*<(?:!doctype|html)/i.test(text)) {
        const article = htmlToMarkdown(text, { url: finalUrl });
        return {
          ...base,
          title: article.title || lastPathSegment(finalUrl),
          content: ensureTitle(article.title, article.markdown),
          contentFormat: 'markdown',
          wordCount: countWords(article.textContent),
          warnings: [...warnings, 'served as text/plain but looked like HTML'],
        };
      }
      return {
        ...base,
        title: lastPathSegment(finalUrl),
        content: tidyMarkdown(text),
        contentFormat: 'text',
        wordCount: countWords(text),
      };
    }

    const parsed = await parseDocument(bytes, { name: finalUrl, contentType, maxChars: 400_000 });
    const document = parsed.info;
    const links = includeLinks && document.kind === 'html' ? extractLinks(parsed.markdown, 60) : undefined;
    return {
      ...base,
      title: parsed.title ?? lastPathSegment(finalUrl),
      content: parsed.markdown,
      contentFormat: document.kind === 'text' ? 'text' : document.kind === 'json' ? 'json' : 'markdown',
      wordCount: countWords(parsed.markdown),
      document,
      ...(links ? { links } : {}),
    };
  }

  /** Apply `offset`/`maxChars` and populate the pagination hints. */
  private slicePage(page: FetchedPage, offset: number, maxChars: number): FetchedPage {
    const content = page.content ?? '';
    if (offset === 0 && content.length <= maxChars) return page;

    const slice = content.slice(offset, offset + maxChars);
    const truncated = offset + maxChars < content.length;
    const tokenEstimate = estimateTokens(slice);
    const result: FetchedPage = {
      ...page,
      content: slice,
      wordCount: countWords(slice),
      ...(truncated ? { truncated: true, nextOffset: offset + maxChars } : {}),
      ...(offset > 0
        ? { warnings: [...(page.warnings ?? []), `characters ${offset}–${offset + slice.length} of ${content.length} (~${tokenEstimate} tokens)`] }
        : {}),
    };
    return result;
  }

  /** Expose the robots cache so the CLI can report on it. */
  get robotsCache(): RobotsCache {
    return this.robots;
  }

  /** Fetch several URLs with a bounded fan-out, never throwing. */
  async fetchMany(
    urls: readonly string[],
    options: FetchPageOptions & { concurrency?: number } = {},
  ): Promise<{ url: string; page?: FetchedPage; error?: string }[]> {
    const { mapConcurrent } = await import('../http.js');
    const limit = options.concurrency ?? Math.min(6, this.config.concurrency);
    return mapConcurrent(urls, limit, async (url) => {
      try {
        const page = await this.fetchPage(url, options);
        return { url, page };
      } catch (err) {
        return { url, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}

/** Guarantee the Markdown starts with the page title, which readability strips. */
export function ensureTitle(title: string, markdown: string): string {
  const body = (markdown ?? '').trim();
  const cleanTitle = collapseWhitespace(title ?? '');
  if (!cleanTitle) return body;
  // Already has a heading that matches closely.
  const firstHeading = /^#{1,2}\s+(.+)$/m.exec(body.slice(0, 400))?.[1]?.trim();
  if (firstHeading && normaliseForCompare(firstHeading) === normaliseForCompare(cleanTitle)) return body;
  return `# ${cleanTitle}\n\n${body}`;
}

function normaliseForCompare(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
}

function countWords(text: string): number {
  if (!text) return 0;
  const latin = text.match(/[A-Za-z0-9][A-Za-z0-9'-]*/g)?.length ?? 0;
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/g)?.length ?? 0;
  return latin + Math.ceil(cjk / 2);
}

function normaliseDate(input: string): string {
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : input;
}

function lastPathSegment(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    return seg ? decodeURIComponent(seg) : u.hostname;
  } catch {
    return url;
  }
}

/**
 * Plain-text rendering of a page, used by `fetch_url` with `format: text`
 * and by the CLI. Separate from `parseDocument` because it never touches the
 * network — callers pass an already-fetched page.
 */
export function pageToText(page: FetchedPage): string {
  return page.contentFormat === 'markdown' ? htmlToText(markdownToPlain(page.content)) : page.content;
}

/** Strip the lightest Markdown syntax so plain text stays readable. */
function markdownToPlain(markdown: string): string {
  return (markdown ?? '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```[a-z]*\n?/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, '$1')
    .replace(/^[ \t]*[-*+]\s+/gm, '- ');
}

export { truncate };
