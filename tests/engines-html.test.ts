/**
 * Tests for the keyless HTML engines.
 *
 * Nothing here touches the network: each engine is built through the registry
 * and driven with a stub `HttpClient` that answers from a captured fixture (or,
 * for the Bing click-tracker case, a small hand-written page whose hrefs encode
 * real destinations). That exercises request building *and* parsing, which is
 * the pair that actually breaks when a provider changes its markup.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { EngineError } from '../src/engines/kit.js';
import { getDefinition, createEngine, isConfigured } from '../src/engines/registry.js';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../src/http.js';
import type { EngineKind, RawResult, SearchEngine } from '../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/* ------------------------------------------------------------------ *
 * Stub HTTP client
 * ------------------------------------------------------------------ */

interface FixtureRoute {
  /** Substring of the request URL that selects this route. */
  match: string;
  /** Fixture path relative to `tests/fixtures`. */
  file?: string;
  /** Inline body instead of `file`. */
  body?: string;
  status?: number;
  contentType?: string;
}

interface RecordedRequest {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

interface StubClient extends HttpClient {
  requests: RecordedRequest[];
}

function createStub(routes: FixtureRoute[], fallbackStatus = 404): StubClient {
  const requests: RecordedRequest[] = [];

  const respond = (url: string, route: FixtureRoute): HttpResponse => {
    const status = route.status ?? 200;
    const body = route.body ?? fixture(route.file ?? '');
    return {
      status,
      ok: status >= 200 && status < 300,
      url,
      headers: new Headers({ 'content-type': route.contentType ?? 'text/html' }),
      body,
      bytes: new TextEncoder().encode(body),
      elapsedMs: 1,
      attempts: 1,
    };
  };

  const client: StubClient = {
    requests,
    config: undefined as unknown as Config,
    async request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
      requests.push({
        url,
        method: options.method ?? 'GET',
        ...(options.body ? { body: options.body } : {}),
        headers: { ...(options.headers ?? {}) },
      });
      const route = routes.find((candidate) => url.includes(candidate.match));
      if (!route) {
        const body = `<html><body><h1>${fallbackStatus}</h1></body></html>`;
        return {
          status: fallbackStatus,
          ok: false,
          url,
          headers: new Headers({ 'content-type': 'text/html' }),
          body,
          bytes: new TextEncoder().encode(body),
          elapsedMs: 1,
          attempts: 1,
        };
      }
      return respond(url, route);
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

/** Only the fields the engines read; cast because `Config` has many more. */
function stubConfig(overrides: Partial<Config> = {}): Config {
  return {
    timeoutMs: 15_000,
    retries: 1,
    concurrency: 6,
    maxFetchBytes: 5 * 1024 * 1024,
    maxMarkdownChars: 120_000,
    userAgent: undefined,
    rotateUserAgent: false,
    proxy: undefined,
    cacheEnabled: false,
    cachePath: ':memory:',
    respectRobots: false,
    allowPrivateHosts: false,
    keys: {},
    ...overrides,
  } as unknown as Config;
}

/** Build an engine through the registry, which is how the orchestrator does it. */
function engineFor(id: string, http: HttpClient, config = stubConfig()): SearchEngine {
  const engine = createEngine(id, { http, config });
  expect(engine, `registry should construct "${id}"`).toBeDefined();
  return engine!;
}

/**
 * Every engine has to agree with its registry entry: the id must be the one the
 * orchestrator asked for, the kind decides how the result is rendered, and the
 * key flag must match the registry tier (a keyless engine that claims to need a
 * key silently disappears from every default search).
 */
function expectMetadata(engine: SearchEngine, kind: EngineKind): void {
  const definition = getDefinition(engine.id);
  expect(definition, `registry definition for "${engine.id}"`).toBeDefined();
  expect(engine.id).toBe(definition!.id);
  expect(engine.kind).toBe(kind);
  expect(engine.requiresKey).toBe(definition!.tier === 'keyed');
  expect(engine.label.length).toBeGreaterThan(0);
}

const urls = (results: RawResult[]): string[] => results.map((r) => r.url);

describe('bing', () => {
  it('extracts a full result list from a real capture', async () => {
    const http = createStub([{ match: 'bing.com/search', file: 'bing.html' }]);
    const engine = engineFor('bing', http);
    expectMetadata(engine, 'html');

    const results = await engine.search('model context protocol', { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(8);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.title.length).toBeGreaterThan(8);
      expect(result.snippet ?? '').not.toBe('');
      // Every organic result must point off-Bing.
      expect(new URL(result.url).hostname).not.toMatch(/(^|\.)bing\.com$/);
    }
  });

  it('keeps the display-URL prefix out of the titles', async () => {
    const http = createStub([{ match: 'bing.com/search', file: 'bing.html' }]);
    const engine = engineFor('bing', http);
    const results = await engine.search('model context protocol', { limit: 10 });
    for (const result of results) {
      expect(result.title).not.toMatch(/^https?:\/\//);
      expect(result.title).not.toMatch(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.(?:com|org|net|io|cn|dev)\b/i);
    }
  });

  it('builds the request with the market, language and English-forcing flag', async () => {
    const http = createStub([{ match: 'bing.com/search', file: 'bing.html' }]);
    const engine = engineFor('bing', http);
    await engine.search('mcp', { limit: 5, language: 'en', region: 'us', freshness: 'week' });

    const requested = decodeURIComponent(http.requests[0]!.url);
    expect(requested).toContain('q=mcp');
    expect(requested).toContain('mkt=en-US');
    expect(requested).toContain('ensearch=1');
    expect(requested).toContain('cc=US');
    expect(requested).toContain('filters=ex1:"ez2"');
    expect(Number(new URL(http.requests[0]!.url).searchParams.get('count'))).toBeGreaterThanOrEqual(10);
  });

  it('switches market and drops the English flag for a Chinese request', async () => {
    const http = createStub([{ match: 'bing.com/search', file: 'bing.html' }]);
    const engine = engineFor('bing', http);
    await engine.search('模型上下文协议', { limit: 5, language: 'zh', region: 'cn' });

    const requested = decodeURIComponent(http.requests[0]!.url);
    expect(requested).toContain('mkt=zh-CN');
    expect(requested).not.toContain('ensearch=1');
  });

  it('decodes a bing.com/ck/a?u=a1<base64> click tracker to its destination', async () => {
    const http = createStub([{ match: 'bing.com/search', file: 'bing-ck-wrapper.html' }]);
    const engine = engineFor('bing', http);
    const results = await engine.search('state', { limit: 10 });

    expect(results).toHaveLength(4);
    expect(urls(results)).toEqual([
      'https://britannica.com/topic/state-sovereign-political-entity',
      'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API',
      'https://modelcontextprotocol.io/docs/getting-started/intro',
      'https://en.wikipedia.org/wiki/Model_Context_Protocol',
    ]);
    // No click-tracker URL may survive into the result list.
    expect(urls(results).some((url) => url.includes('/ck/a'))).toBe(false);
  });

  it('strips the duplicated display-URL prefix from a structural-extraction title', async () => {
    const { stripBingTitleNoise } = await import('../src/engines/bing.js');
    expect(stripBingTitleNoise('https://example.com/page Some Real Title')).toBe('Some Real Title');
    expect(stripBingTitleNoise('modelcontextprotocol.iohttps://modelcontextprotocol.io/docs/intro What is MCP?')).toBe(
      'What is MCP?',
    );
    expect(stripBingTitleNoise('Model Context Protocol - Wikipedia')).toBe('Model Context Protocol - Wikipedia');
  });
});

describe('duckduckgo', () => {
  it('unwraps uddg redirects and never returns a duckduckgo.com result URL', async () => {
    const http = createStub([{ match: 'html.duckduckgo.com', file: 'duckduckgo.html' }]);
    const engine = engineFor('duckduckgo', http);
    expectMetadata(engine, 'html');

    const results = await engine.search('model context protocol', { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const result of results) {
      expect(result.url).not.toContain('duckduckgo.com');
      expect(result.url).not.toContain('uddg=');
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.snippet ?? '').not.toBe('');
    }
  });

  it('sends the query as a POST form with the region and freshness keys', async () => {
    const http = createStub([{ match: 'html.duckduckgo.com', file: 'duckduckgo.html' }]);
    const engine = engineFor('duckduckgo', http);
    await engine.search('mcp', { limit: 5, region: 'de', freshness: 'week', safeSearch: 'strict' });

    const request = http.requests[0]!;
    expect(request.method).toBe('POST');
    const body = new URLSearchParams(request.body ?? '');
    expect(body.get('q')).toBe('mcp');
    expect(body.get('kl')).toBe('de-de');
    expect(body.get('df')).toBe('w');
    expect(body.get('kp')).toBe('1');
  });

  it('falls back to the lite endpoint when the html endpoint is blocked', async () => {
    const http = createStub([
      { match: 'html.duckduckgo.com', status: 403, body: '<html><body><h1>403</h1><p>Unfortunately, bots use DuckDuckGo too.</p></body></html>' },
      { match: 'lite.duckduckgo.com', file: 'duckduckgo-lite.html' },
    ]);
    const engine = engineFor('duckduckgo', http);
    const results = await engine.search('model context protocol', { limit: 10 });

    expect(http.requests.map((r) => new URL(r.url).hostname)).toEqual(['html.duckduckgo.com', 'lite.duckduckgo.com']);
    expect(results.length).toBeGreaterThanOrEqual(5);
    // The lite layout keeps each snippet in a sibling table row; the engine has
    // to pair it back up or the results read as bare links.
    for (const result of results) {
      expect(result.snippet ?? '').not.toBe('');
      expect(result.url).not.toContain('duckduckgo.com');
    }
  });

  it('reports a hard block when both endpoints are blocked', async () => {
    const http = createStub([
      { match: 'duckduckgo.com', status: 403, body: '<html><body><h1>403 Forbidden</h1><p>blocked</p></body></html>' },
    ]);
    const engine = engineFor('duckduckgo', http);
    await expect(engine.search('mcp', { limit: 5 })).rejects.toThrow(EngineError);
  });
});

describe('mojeek', () => {
  it('parses the results and their <time datetime> dates', async () => {
    const http = createStub([
      { match: 's=10', file: 'mojeek-page2.html' },
      { match: 'mojeek.com/search', file: 'mojeek.html' },
    ]);
    const engine = engineFor('mojeek', http);
    expectMetadata(engine, 'html');

    const results = await engine.search('model context protocol', { limit: 20 });
    expect(results.length).toBeGreaterThanOrEqual(10);
    expect(results[0]!.publishedAt).toBe('2025-11-04T00:00:00.000Z');
    expect(results.filter((r) => r.publishedAt).length).toBeGreaterThanOrEqual(5);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(new URL(result.url).hostname).not.toMatch(/(^|\.)mojeek\.com$/);
    }
  });

  it('requests the second page with s=10 when one page cannot fill the limit', async () => {
    const http = createStub([
      { match: 's=10', file: 'mojeek-page2.html' },
      { match: 'mojeek.com/search', file: 'mojeek.html' },
    ]);
    const engine = engineFor('mojeek', http);
    await engine.search('model context protocol', { limit: 15 });

    expect(http.requests).toHaveLength(2);
    expect(http.requests[0]!.url).not.toContain('s=');
    expect(http.requests[1]!.url).toContain('s=10');
  });

  it('asks for a single page when the limit fits in one', async () => {
    const http = createStub([{ match: 'mojeek.com/search', file: 'mojeek.html' }]);
    const engine = engineFor('mojeek', http);
    const results = await engine.search('model context protocol', { limit: 5 });
    expect(http.requests).toHaveLength(1);
    expect(results).toHaveLength(5);
  });
});

describe('startpage', () => {
  it('posts the search form and returns the merged result list', async () => {
    const http = createStub([{ match: 'startpage.com', file: 'startpage.html' }]);
    const engine = engineFor('startpage', http);
    expectMetadata(engine, 'html');

    const results = await engine.search('model context protocol', { limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(5);
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]!.method).toBe('POST');
    expect(new URLSearchParams(http.requests[0]!.body ?? '').get('query')).toBe('model context protocol');
    expect(results[0]!.publishedAt).toBe('2025-11-04T00:00:00.000Z');
  });

  it('retries with a GET when the POST path is refused', async () => {
    const http = createStub([
      { match: 'startpage.com/sp/search?', file: 'startpage.html' },
      { match: 'startpage.com', status: 405, body: '<html><body><h1>405 Method Not Allowed</h1></body></html>' },
    ]);
    const engine = engineFor('startpage', http);
    const results = await engine.search('model context protocol', { limit: 5 });
    expect(http.requests).toHaveLength(2);
    expect(http.requests[1]!.method).toBe('GET');
    expect(results.length).toBeGreaterThan(0);
  });
});

describe('brave (keyless HTML)', () => {
  it('passes freshness and safe search through and parses the results', async () => {
    const http = createStub([{ match: 'search.brave.com', file: 'brave.html' }]);
    const engine = engineFor('brave', http);
    expectMetadata(engine, 'html');

    const results = await engine.search('model context protocol', { limit: 10, freshness: 'week', safeSearch: 'moderate' });
    const requested = decodeURIComponent(http.requests[0]!.url);
    expect(requested).toContain('tf=pw');
    expect(requested).toContain('safesearch=moderate');
    expect(requested).toContain('source=web');
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const result of results) {
      expect(result.url).not.toContain('brave.com');
      expect(result.snippet ?? '').not.toBe('');
    }
  });
});

describe('googlenews', () => {
  it('splits the publisher off the headline', async () => {
    const http = createStub([{ match: 'news.google.com', file: 'googlenews.xml', contentType: 'application/xml' }]);
    const engine = engineFor('googlenews', http);
    expectMetadata(engine, 'news');

    const results = await engine.search('model context protocol', { limit: 10 });
    expect(results).toHaveLength(4);
    expect(results[0]!.title).toBe('Anthropic expands the Model Context Protocol with a registry for tool servers');
    expect(results[0]!.title).not.toContain('The Verge');
    expect(results[0]!.meta?.publisher).toBe('The Verge');
    for (const result of results) {
      expect(result.title).not.toMatch(/ - (?:The Verge|Ars Technica|BleepingComputer)$/);
      expect(result.snippet ?? '').not.toBe('');
      expect(result.publishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('expresses freshness with the when: operator', async () => {
    const http = createStub([{ match: 'news.google.com', file: 'googlenews.xml', contentType: 'application/xml' }]);
    const engine = engineFor('googlenews', http);
    await engine.search('mcp', { limit: 5, freshness: 'day' });
    // `when:1d` is Google News' own recency operator, appended to the query.
    expect(new URL(http.requests[0]!.url).searchParams.get('q')).toBe('mcp when:1d');
  });

  it('maps region and language onto hl/gl/ceid', async () => {
    const http = createStub([{ match: 'news.google.com', file: 'googlenews.xml', contentType: 'application/xml' }]);
    const engine = engineFor('googlenews', http);
    await engine.search('mcp', { limit: 5, language: 'zh', region: 'cn' });

    const params = new URL(http.requests[0]!.url).searchParams;
    expect(params.get('hl')).toBe('zh-CN');
    expect(params.get('gl')).toBe('CN');
    expect(params.get('ceid')).toBe('CN:zh');
  });

  it('defaults to the US English feed without hints', async () => {
    const http = createStub([{ match: 'news.google.com', file: 'googlenews.xml', contentType: 'application/xml' }]);
    const engine = engineFor('googlenews', http);
    await engine.search('mcp', { limit: 5 });
    const params = new URL(http.requests[0]!.url).searchParams;
    expect(params.get('hl')).toBe('en-US');
    expect(params.get('gl')).toBe('US');
    expect(params.get('ceid')).toBe('US:en');
  });

  it('returns no results for a body that is not a feed', async () => {
    const http = createStub([{ match: 'news.google.com', body: '<html><body>Sorry, something went wrong.</body></html>' }]);
    const engine = engineFor('googlenews', http);
    expect(await engine.search('mcp', { limit: 5 })).toEqual([]);
  });
});

describe('parseDateLoose (fixed clock)', () => {
  // 2025-06-15T12:00:00Z, so relative dates are asserted without reading the wall
  // clock: the helper takes `now` precisely so callers can pin it.
  const NOW = Date.UTC(2025, 5, 15, 12, 0, 0);

  it('parses ISO dates with and without a time', async () => {
    const { parseDateLoose } = await import('../src/engines/kit.js');
    expect(parseDateLoose('2024-05-06T07:08:09Z')).toBe('2024-05-06T07:08:09.000Z');
    expect(parseDateLoose('2024-05-06')).toBe('2024-05-06T00:00:00.000Z');
    // Fractional seconds (`crates.io updated_at`) are dropped, not rejected.
    expect(parseDateLoose('2026-02-09T22:22:35.828655Z')).toBe('2026-02-09T22:22:35.000Z');
  });

  it('parses unix seconds and milliseconds', async () => {
    const { parseDateLoose } = await import('../src/engines/kit.js');
    expect(parseDateLoose('1735689600')).toBe('2025-01-01T00:00:00.000Z');
    expect(parseDateLoose('1735689600000')).toBe('2025-01-01T00:00:00.000Z');
  });

  it('resolves relative English and Chinese expressions against the fixed now', async () => {
    const { parseDateLoose } = await import('../src/engines/kit.js');
    expect(parseDateLoose('2 days ago', NOW)).toBe('2025-06-13T12:00:00.000Z');
    expect(parseDateLoose('3 hours ago', NOW)).toBe('2025-06-15T09:00:00.000Z');
    expect(parseDateLoose('昨天', NOW)).toBe('2025-06-14T12:00:00.000Z');
    expect(parseDateLoose('5 分钟前', NOW)).toBe('2025-06-15T11:55:00.000Z');
  });

  it('parses the written month formats and the Chinese date format', async () => {
    const { parseDateLoose } = await import('../src/engines/kit.js');
    expect(parseDateLoose('January 5, 2024')).toBe('2024-01-05T00:00:00.000Z');
    expect(parseDateLoose('5 January 2024')).toBe('2024-01-05T00:00:00.000Z');
    expect(parseDateLoose('2024年1月5日')).toBe('2024-01-05T00:00:00.000Z');
  });

  it('returns undefined for empty or unrecognisable input', async () => {
    const { parseDateLoose } = await import('../src/engines/kit.js');
    expect(parseDateLoose('')).toBeUndefined();
    expect(parseDateLoose(undefined)).toBeUndefined();
    expect(parseDateLoose('not a date at all')).toBeUndefined();
  });
});

describe('searxng', () => {
  const instances = 'https://inst-one.example, https://inst-two.example';

  it('fails over from an instance that answers 403 HTML to one that returns JSON', async () => {
    const http = createStub([
      { match: 'inst-one.example', status: 403, body: '<html><body><h1>403 Forbidden</h1><p>JSON output is disabled.</p></body></html>' },
      { match: 'inst-two.example', file: 'searxng.json', contentType: 'application/json' },
    ]);
    const config = stubConfig({ keys: { searxng: instances } });
    const engine = engineFor('searxng', http, config);
    expectMetadata(engine, 'api');
    expect(isConfigured('searxng', config)).toBe(true);

    const results = await engine.search('model context protocol', { limit: 10 });
    expect(http.requests.map((r) => new URL(r.url).hostname)).toEqual(['inst-one.example', 'inst-two.example']);
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.snippet ?? '').not.toBe('');
    }
  });

  it('throws the documented EngineError when every instance fails', async () => {
    const http = createStub([
      { match: 'inst-one.example', status: 403, body: '<html><body>403</body></html>' },
      { match: 'inst-two.example', status: 403, body: '<html><body>403</body></html>' },
    ]);
    const engine = engineFor('searxng', http, stubConfig({ keys: { searxng: instances } }));

    await expect(engine.search('mcp', { limit: 5 })).rejects.toThrowError(
      /no instance returned JSON — enable `format: json` in your instance settings/,
    );
    expect(http.requests).toHaveLength(2);
  });

  it('names the setting to change when no instance is configured, without requesting', async () => {
    const http = createStub([]);
    const engine = engineFor('searxng', http);
    expect(isConfigured('searxng', stubConfig())).toBe(false);

    await expect(engine.search('mcp', { limit: 5 })).rejects.toThrowError(/set SEARXNG_URL/);
    expect(http.requests).toHaveLength(0);
  });
});
