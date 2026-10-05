/**
 * Tests for robots.txt handling, the SSRF guard, the concurrency helpers and the
 * page fetcher.
 *
 * No socket is ever opened: `FetchService` is always handed a stub `HttpClient`
 * whose responses are declared inline, including the `robots.txt` body that
 * drives the disallow path.
 */

import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { FetchService, ensureTitle, pageToText } from '../src/fetch/page.js';
import { BlockedUrlError, HttpError, assertFetchable, mapConcurrent, sleep } from '../src/http.js';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../src/http.js';
import { RobotsCache, isPathAllowed, parseRobotsTxt } from '../src/robots.js';
import type { FetchedPage } from '../src/types.js';

/* ------------------------------------------------------------------ *
 * Config / client stubs
 * ------------------------------------------------------------------ */

function stubConfig(overrides: Partial<Config> = {}): Config {
  return {
    timeoutMs: 15_000,
    retries: 1,
    concurrency: 6,
    maxFetchBytes: 5 * 1024 * 1024,
    maxMarkdownChars: 12_000,
    userAgent: 'free-search-mcp-test/0.0.0',
    rotateUserAgent: false,
    proxy: undefined,
    cacheEnabled: false,
    cachePath: ':memory:',
    cacheTtlMs: 60_000,
    respectRobots: false,
    allowPrivateHosts: false,
    keys: {},
    ...overrides,
  } as unknown as Config;
}

interface FixtureRoute {
  match: string;
  body?: string;
  status?: number;
  contentType?: string;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  allowPrivate?: boolean;
  accept?: string;
}

interface StubClient extends HttpClient {
  requests: RecordedRequest[];
}

function createStub(routes: FixtureRoute[], fallbackStatus = 404): StubClient {
  const requests: RecordedRequest[] = [];

  const client: StubClient = {
    requests,
    config: undefined as unknown as Config,
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      requests.push({
        url,
        method: options.method ?? 'GET',
        headers: { ...(options.headers ?? {}) },
        ...(options.allowPrivate !== undefined ? { allowPrivate: options.allowPrivate } : {}),
        ...(options.accept ? { accept: options.accept } : {}),
      });
      const route = routes.find((candidate) => url.includes(candidate.match));
      const status = route?.status ?? (route ? 200 : fallbackStatus);
      const body = route?.body ?? `<html><body><h1>${fallbackStatus}</h1></body></html>`;
      return {
        status,
        ok: status >= 200 && status < 300,
        url,
        headers: new Headers({ 'content-type': route?.contentType ?? 'text/html' }),
        body,
        bytes: new TextEncoder().encode(body),
        elapsedMs: 1,
        attempts: 1,
      };
    },
    async getText(url, options) {
      return (await this.request(url, options)).body;
    },
    async getJson<T>(url: string, options?: HttpRequestOptions): Promise<T> {
      return JSON.parse((await this.request(url, { accept: 'application/json', ...options })).body) as T;
    },
    async postForm(url, form, options) {
      return this.request(url, { ...options, method: 'POST', body: new URLSearchParams(form).toString() });
    },
  };

  return client;
}

/* ------------------------------------------------------------------ *
 * robots.txt parsing
 * ------------------------------------------------------------------ */

describe('parseRobotsTxt and isPathAllowed', () => {
  it('applies longest-match precedence between Disallow and Allow', () => {
    const entry = parseRobotsTxt('User-agent: *\nDisallow: /docs\nAllow: /docs/public');
    expect(isPathAllowed(entry, '/docs/private')).toBe(false);
    expect(isPathAllowed(entry, '/docs/public/page')).toBe(true);
    expect(isPathAllowed(entry, '/other')).toBe(true);
  });

  it('lets Allow win an equal-length tie, in either order', () => {
    expect(isPathAllowed(parseRobotsTxt('User-agent: *\nDisallow: /same\nAllow: /same'), '/same')).toBe(true);
    expect(isPathAllowed(parseRobotsTxt('User-agent: *\nAllow: /same\nDisallow: /same'), '/same')).toBe(true);
  });

  it('treats an empty Disallow as allow-everything', () => {
    const entry = parseRobotsTxt('User-agent: *\nDisallow:');
    expect(entry.missing).toBe(false);
    expect(entry.rules).toHaveLength(1);
    expect(isPathAllowed(entry, '/anything/at/all')).toBe(true);
  });

  it('honours * wildcards and the $ end anchor', () => {
    const pdf = parseRobotsTxt('User-agent: *\nDisallow: /*.pdf$');
    expect(isPathAllowed(pdf, '/files/report.pdf')).toBe(false);
    expect(isPathAllowed(pdf, '/files/report.pdf?download=1')).toBe(true);
    expect(isPathAllowed(pdf, '/files/report.html')).toBe(true);

    const mid = parseRobotsTxt('User-agent: *\nDisallow: /a/*/b');
    expect(isPathAllowed(mid, '/a/x/b')).toBe(false);
    expect(isPathAllowed(mid, '/a/b')).toBe(true);
  });

  it('anchors only when the pattern ends with $', () => {
    const exact = parseRobotsTxt('User-agent: *\nDisallow: /exact$');
    expect(isPathAllowed(exact, '/exact')).toBe(false);
    expect(isPathAllowed(exact, '/exactmore')).toBe(true);
  });

  it('selects a specific user-agent group over the wildcard group', () => {
    const text = ['User-agent: *', 'Disallow: /', '', 'User-agent: free-search-mcp', 'Disallow: /blocked'].join('\n');
    const ours = parseRobotsTxt(text, 'free-search-mcp/0.1.0');
    expect(ours.rules).toHaveLength(1);
    expect(isPathAllowed(ours, '/anywhere')).toBe(true);
    expect(isPathAllowed(ours, '/blocked')).toBe(false);

    const other = parseRobotsTxt(text, 'Googlebot/2.1');
    expect(isPathAllowed(other, '/anywhere')).toBe(false);
  });

  it('treats several User-agent lines as one group', () => {
    const entry = parseRobotsTxt('User-agent: alpha\nUser-agent: beta\nDisallow: /x', 'beta');
    expect(entry.rules).toHaveLength(1);
    expect(isPathAllowed(entry, '/x')).toBe(false);
  });

  it('captures Crawl-delay in milliseconds and caps it at 30 seconds', () => {
    expect(parseRobotsTxt('User-agent: *\nCrawl-delay: 2.5').crawlDelayMs).toBe(2500);
    expect(parseRobotsTxt('User-agent: *\nCrawl-delay: 45').crawlDelayMs).toBe(30_000);
    expect(parseRobotsTxt('User-agent: *\nDisallow: /x').crawlDelayMs).toBeUndefined();
    expect(parseRobotsTxt('User-agent: *\nCrawl-delay: soon').crawlDelayMs).toBeUndefined();
  });

  it('ignores comments, blank lines and unknown fields, and is case-insensitive', () => {
    const entry = parseRobotsTxt('  # a comment\nUSER-AGENT: *\nSITEMAP: https://example.com/sitemap.xml\nDISALLOW: /Secret  # trailing note\nALLOW: /Secret/Public');
    expect(isPathAllowed(entry, '/Secret/page')).toBe(false);
    expect(isPathAllowed(entry, '/Secret/Public/page')).toBe(true);
  });

  it('reports a missing file and allows everything', () => {
    const empty = parseRobotsTxt('');
    expect(empty.missing).toBe(true);
    expect(empty.rules).toEqual([]);
    expect(isPathAllowed(empty, '/anything')).toBe(true);
    expect(typeof empty.fetchedAt).toBe('number');

    // An HTML error page served in place of robots.txt parses to "no rules".
    const html = parseRobotsTxt('<!doctype html><html><body>Not found</body></html>');
    expect(html.missing).toBe(true);
    expect(isPathAllowed(html, '/anything')).toBe(true);
  });
});

describe('RobotsCache', () => {
  it('fetches robots.txt once and answers per-path questions from it', async () => {
    const http = createStub([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /hidden\nCrawl-delay: 5', contentType: 'text/plain' },
    ]);
    const cache = new RobotsCache(http, stubConfig(), 'free-search-mcp/0.1.0');

    const blocked = await cache.check('https://example.com/hidden/page', { respect: true });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('/hidden/page');
    expect(blocked.crawlDelayMs).toBe(5000);

    const allowed = await cache.check('https://example.com/open', { respect: true });
    expect(allowed.allowed).toBe(true);
    expect(allowed.reason).toBeUndefined();
    expect(allowed.crawlDelayMs).toBe(5000);

    // Second question cost no extra request.
    expect(http.requests).toHaveLength(1);
  });

  it('short-circuits when respect is off', async () => {
    const http = createStub([]);
    const cache = new RobotsCache(http, stubConfig(), 'ua');
    expect(await cache.check('https://example.com/hidden', { respect: false })).toEqual({ allowed: true });
    expect(http.requests).toHaveLength(0);
  });

  it('treats an unavailable robots.txt as "allowed"', async () => {
    const http = createStub([], 404);
    const cache = new RobotsCache(http, stubConfig(), 'ua');
    const verdict = await cache.check('https://example.com/x', { respect: true });
    expect(verdict.allowed).toBe(true);
    expect(http.requests).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * SSRF guard
 * ------------------------------------------------------------------ */

describe('assertFetchable', () => {
  const config = stubConfig();

  const blocked = [
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://127.9.9.9/',
    'http://10.1.2.3/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://printer.local/',
    'http://wiki.internal/',
    'file:///etc/passwd',
    'ftp://example.com/',
  ];

  it.each(blocked)('refuses %s', (url) => {
    expect(() => assertFetchable(url, config)).toThrow(BlockedUrlError);
  });

  it('explains why a private address is refused', () => {
    expect(() => assertFetchable('http://10.0.0.1/', config)).toThrow(/private\/loopback address/);
    expect(() => assertFetchable('ftp://example.com/', config)).toThrow(/unsupported scheme "ftp:"/);
    expect(() => assertFetchable('not a url', config)).toThrow(/not a valid absolute URL/);
  });

  it('accepts public hosts, including ones just outside the private ranges', () => {
    for (const url of ['https://example.com/page', 'http://172.32.0.1/', 'https://8.8.8.8/', 'http://x10.0.0.1.example.com/']) {
      expect(() => assertFetchable(url, config)).not.toThrow();
    }
  });

  it('accepts private hosts when the caller opts in', () => {
    for (const url of ['http://127.0.0.1:8080/x', 'http://10.0.0.1/', 'http://[::1]/', 'http://localhost/']) {
      expect(() => assertFetchable(url, config, true)).not.toThrow();
    }
  });

  it('accepts private hosts when the config opts in', () => {
    const permissive = stubConfig({ allowPrivateHosts: true });
    expect(() => assertFetchable('http://192.168.0.10/', permissive)).not.toThrow();
    expect(() => assertFetchable('http://169.254.1.1/', permissive)).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Concurrency helpers
 * ------------------------------------------------------------------ */

describe('mapConcurrent', () => {
  it('preserves input order even when tasks finish out of order', async () => {
    const out = await mapConcurrent([1, 2, 3, 4, 5], 2, async (item) => {
      await sleep(item % 2 === 0 ? 5 : 1);
      return item * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('never exceeds the concurrency limit and does reach it', async () => {
    let active = 0;
    let peak = 0;
    const items = [...Array(12).keys()];
    const out = await mapConcurrent(items, 3, async (item) => {
      active++;
      peak = Math.max(peak, active);
      await sleep(2);
      active--;
      return item;
    });
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(out).toEqual(items);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    expect(await mapConcurrent([], 4, async (item: number) => item)).toEqual([]);
    const seen: number[] = [];
    const out = await mapConcurrent([1, 2, 3], 10, async (item) => {
      seen.push(item);
      return item;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('passes the index through to the worker', async () => {
    const out = await mapConcurrent(['a', 'b', 'c'], 2, async (item, index) => `${index}:${item}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });
});

describe('sleep', () => {
  it('resolves when it is not aborted', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before start'));
    await expect(sleep(50, controller.signal)).rejects.toThrow('cancelled before start');
  });

  it('rejects when it is aborted mid-flight', async () => {
    const controller = new AbortController();
    const pending = sleep(1000, controller.signal);
    controller.abort(new Error('cancelled mid-flight'));
    await expect(pending).rejects.toThrow('cancelled mid-flight');
  });

  it('rejects with an abort error when no reason was given', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(50, controller.signal)).rejects.toThrow(/abort/i);
  });
});

/* ------------------------------------------------------------------ *
 * FetchService (page.ts)
 * ------------------------------------------------------------------ */

const ARTICLE_HTML = `<html><head><title>Server guide</title><meta property="og:site_name" content="Example Docs"></head><body>
<nav><a href="/">Home</a></nav>
<article><h1>Server guide</h1>
<p>${'A long sentence about servers and clients. '.repeat(8)}</p>
<p>See <a href="/docs/next">the next page</a> for the follow-up.</p>
</article>
<footer><p>© 2024 Example</p></footer>
</body></html>`;

describe('FetchService.fetchPage', () => {
  const articleRoute: FixtureRoute = { match: 'example.com/post', body: ARTICLE_HTML };

  it('converts an HTML page to titled Markdown with its links', async () => {
    const http = createStub([articleRoute]);
    const service = new FetchService(stubConfig(), http);
    const page = await service.fetchPage('https://example.com/post');

    expect(page.status).toBe(200);
    expect(page.url).toBe('https://example.com/post');
    expect(page.finalUrl).toBe('https://example.com/post');
    expect(page.contentFormat).toBe('markdown');
    expect(page.content).toContain('Server guide');
    expect(page.content).toContain('A long sentence about servers and clients.');
    expect(page.title).toBe('Server guide');
    expect(page.siteName).toBe('Example Docs');
    expect(page.wordCount).toBeGreaterThan(20);
    expect(page.cached).toBe(false);
    expect(page.truncated).toBeUndefined();
    expect(page.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(page.links?.some((link) => link.url === 'https://example.com/docs/next')).toBe(true);
    // Chrome that Readability or the fallback has to remove.
    expect(page.content).not.toContain('© 2024 Example');
    expect(http.requests[0]!.accept).toContain('text/html');
  });

  it('refuses anything that is not an absolute http(s) URL', async () => {
    const service = new FetchService(stubConfig(), createStub([]));
    await expect(service.fetchPage('not a url')).rejects.toThrow(BlockedUrlError);
    await expect(service.fetchPage('file:///etc/passwd')).rejects.toThrow(/not a valid absolute http\(s\) URL/);
  });

  it('passes the private-host opt-in through to the HTTP client', async () => {
    const http = createStub([{ match: '127.0.0.1', body: ARTICLE_HTML }]);
    const service = new FetchService(stubConfig(), http);

    await service.fetchPage('http://127.0.0.1:8080/post', { allowPrivateHosts: true });
    expect(http.requests[0]!.allowPrivate).toBe(true);

    await service.fetchPage('http://127.0.0.1:8080/other', { allowPrivateHosts: false });
    expect(http.requests[1]!.allowPrivate).toBeUndefined();
  });

  it('upgrades a text/plain body that is really HTML', async () => {
    const http = createStub([{ match: 'example.com/legacy', body: ARTICLE_HTML, contentType: 'text/plain' }]);
    const service = new FetchService(stubConfig(), http);
    const page = await service.fetchPage('https://example.com/legacy');

    expect(page.contentFormat).toBe('markdown');
    expect(page.warnings).toContain('served as text/plain but looked like HTML');
    expect(page.content).toContain('A long sentence about servers');
  });

  it('keeps a genuine text/plain response as text', async () => {
    const http = createStub([{ match: 'example.com/notes.txt', body: 'line one\nline two', contentType: 'text/plain' }]);
    const service = new FetchService(stubConfig(), http);
    const page = await service.fetchPage('https://example.com/notes.txt');

    expect(page.contentFormat).toBe('text');
    expect(page.content).toBe('line one\nline two');
    expect(page.title).toBe('notes.txt');
  });

  it('explains an unsupported binary content type instead of dumping bytes', async () => {
    const http = createStub([{ match: 'example.com/blob.bin', body: '\u0000\u0001\u0002\u0003', contentType: 'application/octet-stream' }]);
    const service = new FetchService(stubConfig(), http);
    const page = await service.fetchPage('https://example.com/blob.bin');

    expect(page.content).toContain('Unsupported content type "application/octet-stream"');
    expect(page.contentFormat).toBe('text');
    expect(page.warnings?.some((warning) => warning.startsWith('unsupported content type'))).toBe(true);
    expect(page.title).toBe('blob.bin');
  });

  it('routes JSON through the document parser', async () => {
    const http = createStub([{ match: 'example.com/data.json', body: '{"ok":true,"items":[1,2]}', contentType: 'application/json' }]);
    const service = new FetchService(stubConfig(), http);
    const page = await service.fetchPage('https://example.com/data.json');

    expect(page.contentFormat).toBe('json');
    expect(page.document?.kind).toBe('json');
    expect(page.content).toContain('```json');
  });

  it('paginates with offset and maxChars and reports the next offset', async () => {
    const body = 'x'.repeat(3000);
    const http = createStub([{ match: 'example.com/long.txt', body, contentType: 'text/plain' }]);
    const service = new FetchService(stubConfig(), http);

    const first = await service.fetchPage('https://example.com/long.txt', { maxChars: 1000 });
    expect(first.content).toHaveLength(1000);
    expect(first.truncated).toBe(true);
    expect(first.nextOffset).toBe(1000);

    const second = await service.fetchPage('https://example.com/long.txt', { maxChars: 1000, offset: 1000 });
    expect(second.content).toHaveLength(1000);
    expect(second.nextOffset).toBe(2000);
    expect(second.warnings?.some((warning) => warning.includes('characters 1000–2000 of 3000'))).toBe(true);

    const last = await service.fetchPage('https://example.com/long.txt', { maxChars: 1000, offset: 2000 });
    expect(last.content).toHaveLength(1000);
    expect(last.truncated).toBeUndefined();
    expect(last.nextOffset).toBeUndefined();
  });

  it('honours a robots.txt disallow with an HttpError', async () => {
    const http = createStub([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /private', contentType: 'text/plain' },
      { match: 'example.com', body: ARTICLE_HTML },
    ]);
    const service = new FetchService(stubConfig({ respectRobots: true }), http);

    await expect(service.fetchPage('https://example.com/private/page')).rejects.toThrow(HttpError);
    await expect(service.fetchPage('https://example.com/private/page')).rejects.toThrow(/Blocked by robots.txt/);

    const allowed = await service.fetchPage('https://example.com/public');
    expect(allowed.content).toContain('Server guide');
  });

  it('fetches many URLs with a bounded fan-out and never throws', async () => {
    const http = createStub([
      { match: '/robots.txt', body: 'User-agent: *\nDisallow: /private', contentType: 'text/plain' },
      { match: 'good.example', body: ARTICLE_HTML },
    ]);
    const service = new FetchService(stubConfig({ respectRobots: true }), http);
    const outcome = await service.fetchMany(['https://good.example/a', 'https://good.example/private/x'], { concurrency: 2 });

    expect(outcome).toHaveLength(2);
    expect(outcome[0]!.url).toBe('https://good.example/a');
    expect(outcome[0]!.page?.title).toBe('Server guide');
    expect(outcome[0]!.error).toBeUndefined();
    expect(outcome[1]!.page).toBeUndefined();
    expect(outcome[1]!.error).toMatch(/Blocked by robots\.txt/);
  });
});

describe('page helpers', () => {
  it('prepends the title only when the body does not already start with it', () => {
    expect(ensureTitle('Server guide', 'Body text')).toBe('# Server guide\n\nBody text');
    expect(ensureTitle('Server guide', '# Server guide\n\nBody text')).toBe('# Server guide\n\nBody text');
    expect(ensureTitle('', 'Body text')).toBe('Body text');
  });

  it('renders Markdown as readable plain text', () => {
    const page = {
      contentFormat: 'markdown',
      content: '# Title\n\nSee [docs](https://docs.example/x) for **details**.',
    } as unknown as FetchedPage;
    const text = pageToText(page);
    expect(text).toContain('docs (https://docs.example/x)');
    expect(text).toContain('details');
    expect(text).not.toContain('#');
    expect(text).not.toContain('**');
  });

  it('returns plain text unchanged', () => {
    const page = { contentFormat: 'text', content: 'raw text' } as unknown as FetchedPage;
    expect(pageToText(page)).toBe('raw text');
  });
});
