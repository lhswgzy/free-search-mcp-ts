/**
 * Behavioural tests for the search orchestrator (`src/search.ts`).
 *
 * Nothing here touches the network. A stub `HttpClient` serves a small
 * Bing-shaped HTML body for `bing.com` URLs and raises a connect-timeout
 * `HttpError` for `duckduckgo.com` / `mojeek.com` URLs, which is exactly the
 * shape of a censored network — so tiered escalation, the circuit breaker and
 * RRF are all exercised for real rather than mocked out.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { closeCache } from '../src/cache.js';
import { HttpError, assertFetchable, type HttpClient, type HttpRequestOptions, type HttpResponse } from '../src/http.js';
import { SearchService, isWrapperUrl } from '../src/search.js';
import { EngineHealthTracker, classifyFailure } from '../src/engines/health.js';
import { ENGINE_IDS, KEYLESS_ENGINE_IDS, isConfigured } from '../src/engines/registry.js';

/* ------------------------------------------------------------------ *
 * Fixtures and helpers
 * ------------------------------------------------------------------ */

interface StubResult {
  url: string;
  title: string;
  snippet: string;
}

const DEFAULT_RESULTS: StubResult[] = [
  {
    url: 'https://alpha.example.com/one',
    title: 'Alpha page about widgets and gadgets',
    snippet: 'Alpha snippet describing the widget pipeline in enough detail to be useful.',
  },
  {
    url: 'https://beta.example.com/two',
    title: 'Beta page about gadgets and sprockets',
    snippet: 'Beta snippet describing the gadget pipeline in enough detail to be useful.',
  },
  {
    url: 'https://gamma.example.com/three',
    title: 'Gamma page about sprockets and widgets',
    snippet: 'Gamma snippet describing the sprocket pipeline in enough detail to be useful.',
  },
];

/** A minimal but structurally accurate Bing results page. */
function bingHtml(results: StubResult[] = DEFAULT_RESULTS): string {
  const items = results
    .map(
      (r) =>
        `  <li class="b_algo"><h2><a href="${r.url}">${r.title}</a></h2>` +
        `<div class="b_caption"><p>${r.snippet}</p></div></li>`,
    )
    .join('\n');
  return (
    '<!doctype html><html><head><title>widgets - Bing</title></head><body><main>' +
    `<ol id="b_results">\n${items}\n</ol></main></body></html>`
  );
}

function htmlResponse(url: string, body: string, status = 200): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
    body,
    bytes,
    elapsedMs: 1,
    attempts: 1,
  };
}

type StubHandler = (url: string, options: HttpRequestOptions) => HttpResponse | Promise<HttpResponse>;

interface StubCall {
  method: string;
  url: string;
}

/**
 * Build an `HttpClient` whose transport is fully under the test's control.
 *
 * The SSRF guard is reproduced here on purpose: `assertFetchable` normally runs
 * inside `createHttpClient`, so without it a stub would silently allow loopback
 * targets that the real client refuses.
 */
function stubHttp(config: Config, handler: StubHandler, calls: StubCall[] = []): HttpClient {
  const client: HttpClient = {
    config,
    async request(url, options = {}) {
      calls.push({ method: options.method ?? 'GET', url });
      assertFetchable(url, config, options.allowPrivate);
      return handler(url, options);
    },
    async getText(url, options) {
      return (await client.request(url, options)).body;
    },
    async getJson<T>(url: string, options?: HttpRequestOptions): Promise<T> {
      return JSON.parse((await client.request(url, options)).body) as T;
    },
    async postForm(url, _form, options) {
      return client.request(url, { ...options, method: 'POST' });
    },
  };
  return client;
}

function connectTimeout(url: string): HttpError {
  return new HttpError(`Request failed for ${url}: connect timeout (UND_ERR_CONNECT_TIMEOUT)`, {
    url,
    retryable: false,
  });
}

const tempDirs: string[] = [];

/** A fresh `Config` (and therefore a fresh SQLite index) per call. */
function testConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = mkdtempSync(join(tmpdir(), 'fsmcp-search-'));
  tempDirs.push(dataDir);
  return loadConfig({
    dataDir,
    skipDotEnv: true,
    overrides: {
      // Pin the auto-tiering policy so an ambient FREE_SEARCH_ENGINES cannot
      // change what these tests exercise.
      engines: [],
      autoEngines: true,
      respectRobots: false,
      primaryEngines: ['duckduckgo', 'mojeek', 'googlenews'],
      fallbackEngines: ['bing'],
      ...overrides,
    },
  });
}

afterEach(() => {
  closeCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The three primary/fallback hosts a censored network cannot reach. */
function censoredNetwork(calls: StubCall[] = [], body = bingHtml()): (config: Config) => HttpClient {
  return (config) =>
    stubHttp(
      config,
      (url) => {
        if (/duckduckgo\.com/.test(url)) throw connectTimeout(url);
        if (/mojeek\.com/.test(url)) throw connectTimeout(url);
        if (/news\.google\.com/.test(url)) throw connectTimeout(url);
        if (/bing\.com\/search/.test(url)) return htmlResponse(url, body);
        throw new Error(`unexpected request in test: ${url}`);
      },
      calls,
    );
}

/* ------------------------------------------------------------------ *
 * Tiered escalation
 * ------------------------------------------------------------------ */

describe('SearchService tiered escalation', () => {
  it('falls through to the fallback engine and reports both tiers and failures', async () => {
    const config = testConfig();
    const calls: StubCall[] = [];
    const outcome = await new SearchService(config, censoredNetwork(calls)(config)).search(
      'sovereign political entity',
      { limit: 5 },
    );

    expect(outcome.tiersRun).toEqual(['primary', 'fallback']);
    expect(outcome.enginesFailed.map((f) => f.engine)).toEqual(['duckduckgo', 'mojeek', 'googlenews']);
    expect(outcome.enginesFailed[0]!.error).toMatch(/connect timeout/i);
    expect(outcome.enginesUsed).toContain('bing');
    expect(outcome.enginesNotUsed).not.toContain('bing');
    expect(outcome.results.length).toBeGreaterThan(0);
    expect(outcome.results[0]!.url).toBe('https://alpha.example.com/one');
    expect(outcome.query).toBe('sovereign political entity');
    expect(calls.some((c) => /bing\.com\/search/.test(c.url))).toBe(true);
  });

  it('does not touch the fallback tier when the primary tier answers the query', async () => {
    const config = testConfig();
    const calls: StubCall[] = [];
    const duckSet: StubResult[] = [
      { url: 'https://one.example.com/a', title: 'First DuckDuckGo page about widgets', snippet: 'A snippet from DuckDuckGo that is easily long enough to be kept.' },
      { url: 'https://two.example.com/b', title: 'Second DuckDuckGo page about widgets', snippet: 'Another snippet from DuckDuckGo that is long enough to be kept.' },
      { url: 'https://three.example.com/c', title: 'Third DuckDuckGo page about gadgets', snippet: 'A third snippet from DuckDuckGo that is long enough to be kept.' },
    ];
    const mojeekSet: StubResult[] = [
      { url: 'https://four.example.com/d', title: 'First Mojeek page about sprockets', snippet: 'A snippet from Mojeek that is comfortably long enough to be kept.' },
      { url: 'https://five.example.com/e', title: 'Second Mojeek page about sprockets', snippet: 'Another snippet from Mojeek that is comfortably long enough.' },
      { url: 'https://six.example.com/f', title: 'Third Mojeek page about cogs', snippet: 'A third snippet from Mojeek that is comfortably long enough.' },
    ];
    // Every primary engine answers well enough that escalation would be waste.
    const http = stubHttp(
      config,
      (url) => {
        if (/news\.google\.com/.test(url)) return htmlResponse(url, '<rss></rss>', 200);
        if (/duckduckgo\.com/.test(url)) return htmlResponse(url, bingHtml(duckSet));
        return htmlResponse(url, bingHtml(mojeekSet));
      },
      calls,
    );
    const outcome = await new SearchService(config, http).search('widgets', { limit: 6 });

    expect(outcome.tiersRun).toEqual(['primary']);
    expect(outcome.enginesFailed).toEqual([]);
    expect(outcome.results.length).toBeGreaterThanOrEqual(5);
    expect(outcome.results.some((r) => r.engines.includes('duckduckgo'))).toBe(true);
    expect(outcome.results.some((r) => r.engines.includes('mojeek'))).toBe(true);
    expect(calls.every((c) => !/bing\.com\/search/.test(c.url))).toBe(true);
  });

  it('runs only the named engine for an explicit engine list', async () => {
    const config = testConfig();
    const calls: StubCall[] = [];
    const http = stubHttp(
      config,
      (url) => {
        if (/bing\.com\/search/.test(url)) return htmlResponse(url, bingHtml());
        throw new Error(`explicit engine list must not reach ${url}`);
      },
      calls,
    );
    const outcome = await new SearchService(config, http).search('widgets', { engines: ['bing'], limit: 5 });

    expect(outcome.tiersRun).toEqual(['explicit']);
    expect(outcome.enginesFailed).toEqual([]);
    expect(outcome.enginesSkipped).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => /bing\.com/.test(c.url))).toBe(true);
    expect(calls.some((c) => /duckduckgo|mojeek|google\.com/.test(c.url))).toBe(false);
  });

  it('runs every configured engine with all: true', async () => {
    const config = testConfig();
    const http = stubHttp(config, (url) => htmlResponse(url, bingHtml()));
    const outcome = await new SearchService(config, http).search('widgets', { all: true, limit: 3 });

    const attempted = new Set([
      ...outcome.enginesUsed,
      ...outcome.enginesEmpty,
      ...outcome.enginesFailed.map((f) => f.engine),
    ]);
    const expected = ENGINE_IDS.filter((id) => isConfigured(id, config));
    expect(outcome.tiersRun).toEqual(['all']);
    expect([...attempted].sort()).toEqual([...expected].sort());
    expect(attempted.size).toBe(KEYLESS_ENGINE_IDS.length);
    // Keyed engines without a key are reported as unused rather than attempted.
    expect(outcome.enginesNotUsed).toContain('serper');
    expect(attempted.has('serper')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Fusion
 * ------------------------------------------------------------------ */

describe('SearchService fusion', () => {
  it('ranks a page both engines returned above engine-unique results', async () => {
    const config = testConfig();
    const shared: StubResult = {
      url: 'https://shared.example.com/reference',
      title: 'Shared reference page about widget sprockets',
      snippet: 'Both engines agree that this reference page answers the widget sprocket question.',
    };
    const bing = bingHtml([DEFAULT_RESULTS[0]!, shared]);
    const mojeek = bingHtml([DEFAULT_RESULTS[1]!, shared]);
    const http = stubHttp(config, (url) => htmlResponse(url, /mojeek\.com/.test(url) ? mojeek : bing));

    const outcome = await new SearchService(config, http).search('widget sprockets', {
      engines: ['bing', 'mojeek'],
      limit: 5,
    });

    expect(outcome.results[0]!.url).toBe('https://shared.example.com/reference');
    expect(outcome.results[0]!.engines).toEqual(expect.arrayContaining(['bing', 'mojeek']));
    expect(outcome.results[0]!.score).toBeGreaterThan(outcome.results[1]!.score);
    expect(outcome.results[0]!.source).toBe('example.com');
    expect(outcome.engineCounts['bing']).toBe(2);
    expect(outcome.engineCounts['mojeek']).toBe(2);
  });

  it('respects the limit', async () => {
    const config = testConfig();
    const http = stubHttp(config, (url) => htmlResponse(url, bingHtml()));
    const outcome = await new SearchService(config, http).search('widgets', { engines: ['bing'], limit: 1 });
    expect(outcome.results).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Domain filters
 * ------------------------------------------------------------------ */

describe('SearchService domain filters', () => {
  const CONFIG_RESULTS: StubResult[] = [
    { url: 'https://a.example.com/x', title: 'Result from host A about widgets', snippet: 'Snippet from host A that is long enough to be kept by the parser.' },
    { url: 'https://b.example.com/y', title: 'Result from host B about widgets', snippet: 'Snippet from host B that is long enough to be kept by the parser.' },
    { url: 'https://c.example.com/z', title: 'Result from host C about widgets', snippet: 'Snippet from host C that is long enough to be kept by the parser.' },
  ];

  function service(): SearchService {
    const config = testConfig();
    return new SearchService(config, stubHttp(config, (url) => htmlResponse(url, bingHtml(CONFIG_RESULTS))));
  }

  it('keeps only included domains', async () => {
    const outcome = await service().search('widgets', { engines: ['bing'], includeDomains: ['b.example.com'] });
    expect(outcome.results.map((r) => r.url)).toEqual(['https://b.example.com/y']);
  });

  it('drops excluded domains', async () => {
    const outcome = await service().search('widgets', { engines: ['bing'], excludeDomains: ['a.example.com'] });
    expect(outcome.results.map((r) => r.url)).toEqual(['https://b.example.com/y', 'https://c.example.com/z']);
  });

  it('treats site: as an include filter applied after fusion', async () => {
    const outcome = await service().search('widgets', { engines: ['bing'], site: 'c.example.com' });
    expect(outcome.results.map((r) => r.url)).toEqual(['https://c.example.com/z']);
  });
});

/* ------------------------------------------------------------------ *
 * Raw-response cache
 * ------------------------------------------------------------------ */

describe('SearchService raw-response cache', () => {
  it('serves a repeated identical query from the cache with no further requests', async () => {
    const config = testConfig();
    const calls: StubCall[] = [];
    const http = stubHttp(config, (url) => htmlResponse(url, bingHtml()), calls);

    const first = await new SearchService(config, http).search('cached widgets', { engines: ['bing'] });
    const requestsAfterFirst = calls.length;
    const second = await new SearchService(config, http).search('cached widgets', { engines: ['bing'] });

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(requestsAfterFirst).toBeGreaterThan(0);
    expect(calls.length).toBe(requestsAfterFirst);
    expect(second.results.map((r) => r.url)).toEqual(first.results.map((r) => r.url));
  });

  it('bypasses the cache with noCache: true', async () => {
    const config = testConfig();
    const calls: StubCall[] = [];
    const http = stubHttp(config, (url) => htmlResponse(url, bingHtml()), calls);

    await new SearchService(config, http).search('uncached widgets', { engines: ['bing'] });
    const requestsAfterFirst = calls.length;
    const second = await new SearchService(config, http).search('uncached widgets', {
      engines: ['bing'],
      noCache: true,
    });

    expect(second.cached).toBe(false);
    expect(calls.length).toBeGreaterThan(requestsAfterFirst);
  });
});

/* ------------------------------------------------------------------ *
 * Redirect-wrapper decoding
 * ------------------------------------------------------------------ */

describe('SearchService redirect wrapper decoding', () => {
  const WRAPPED =
    'https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly93d3cuYnJpdGFubmljYS5jb20vdG9waWMvc3RhdGUtc292ZXJlaWduLXBvbGl0aWNhbC1lbnRpdHk&ver=2';

  it('recognises Bing ck/a wrapper URLs and plain URLs alike', () => {
    expect(isWrapperUrl(WRAPPED)).toBe(true);
    expect(isWrapperUrl('https://britannica.com/topic/state')).toBe(false);
    expect(isWrapperUrl('https://www.bing.com/search?q=state')).toBe(false);
  });

  it('replaces a wrapped result URL with the decoded destination', async () => {
    const config = testConfig();
    const results: StubResult[] = [
      { url: WRAPPED, title: 'Wrapped result about sovereign states', snippet: 'A wrapped snippet that is long enough to satisfy the parser limits.' },
      DEFAULT_RESULTS[1]!,
      DEFAULT_RESULTS[2]!,
    ];
    const http = stubHttp(config, (url) => htmlResponse(url, bingHtml(results)));
    const outcome = await new SearchService(config, http).search('sovereign states', {
      engines: ['bing'],
      limit: 5,
    });

    const decoded = outcome.results.find((r) => r.url.includes('britannica.com'));
    expect(decoded).toBeDefined();
    expect(decoded!.url).toBe('https://britannica.com/topic/state-sovereign-political-entity');
    expect(decoded!.title).toContain('Wrapped result');
    // The wrapper is gone from the output either way it was resolved; what
    // matters is that no result carries a bing.com/ck/a URL and that the three
    // pages were not duplicated by the rewrite.
    expect(outcome.results.some((r) => r.url.includes('/ck/a'))).toBe(false);
    expect(outcome.results).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * Circuit breaker, driven end to end
 * ------------------------------------------------------------------ */

describe('SearchService circuit breaker', () => {
  function failingService(threshold: number, calls: StubCall[]): { service: SearchService; config: Config } {
    const config = testConfig({ engineFailureThreshold: threshold, engineCooldownMs: 600_000 });
    const http = stubHttp(
      config,
      (url) => {
        // A 5xx is an "other" failure: worth retrying, unlike a block.
        throw new HttpError(`HTTP 500 for ${url}`, { status: 500, url, retryable: false });
      },
      calls,
    );
    return { service: new SearchService(config, http), config };
  }

  it('benches an engine after the configured number of hard failures, then skips it', async () => {
    const calls: StubCall[] = [];
    const { service } = failingService(3, calls);

    const first = await service.search('widgets', { engines: ['bing'], limit: 3, noCache: true });
    const second = await service.search('widgets', { engines: ['bing'], limit: 3, noCache: true });
    const third = await service.search('widgets', { engines: ['bing'], limit: 3, noCache: true });
    expect([first, second, third].every((o) => o.enginesFailed.length === 1)).toBe(true);
    expect(third.enginesSkipped).toEqual([]);

    const requestsBefore = calls.length;
    const fourth = await service.search('widgets', { engines: ['bing'], limit: 3, noCache: true });

    expect(fourth.enginesSkipped).toEqual(['bing']);
    expect(fourth.tiersRun).toEqual([]);
    expect(fourth.results).toEqual([]);
    expect(service.health.isBenched('bing')).toBe(true);
    expect(service.health.benchRemainingMs('bing')).toBeGreaterThan(0);
    expect(calls.length).toBe(requestsBefore);
  });

  it('keeps retrying the engine when engineFailureThreshold is raised', async () => {
    const calls: StubCall[] = [];
    const { service } = failingService(999, calls);

    for (let i = 0; i < 3; i++) {
      await service.search('widgets', { engines: ['bing'], limit: 3, noCache: true });
    }
    const requestsBefore = calls.length;
    const fourth = await service.search('widgets', { engines: ['bing'], limit: 3, noCache: true });

    expect(fourth.enginesSkipped).toEqual([]);
    expect(fourth.tiersRun).toEqual(['explicit']);
    expect(fourth.enginesFailed).toHaveLength(1);
    expect(service.health.isBenched('bing')).toBe(false);
    expect(calls.length).toBe(requestsBefore + 1);
  });
});

/* ------------------------------------------------------------------ *
 * Failure classification and the tracker in isolation
 * ------------------------------------------------------------------ */

describe('failure classification', () => {
  it('classifies a connect timeout as unreachable and a 403 as blocked', () => {
    expect(classifyFailure('Request failed for https://x/: connect timeout (UND_ERR_CONNECT_TIMEOUT)')).toBe(
      'unreachable',
    );
    expect(classifyFailure('getaddrinfo ENOTFOUND news.google.com')).toBe('unreachable');
    expect(classifyFailure('bing: HTTP 403 (blocked)')).toBe('blocked');
    expect(classifyFailure('HTTP 429 for https://x/ (rate limited)')).toBe('blocked');
    expect(classifyFailure('bing: HTTP 500')).toBe('other');
  });

  it('benches an unreachable engine on the first failure and un-benches it on success', () => {
    const tracker = new EngineHealthTracker({ failureThreshold: 3, cooldownMs: 60_000 });
    expect(tracker.isBenched('bing')).toBe(false);

    tracker.recordFailure('bing', new Error('connect timeout (UND_ERR_CONNECT_TIMEOUT)'), 12);
    expect(tracker.isBenched('bing')).toBe(true);
    expect(tracker.benchRemainingMs('bing')).toBeGreaterThan(0);
    expect(tracker.snapshot(['bing'])[0]).toMatchObject({ engine: 'bing', ok: false, skipped: true });

    tracker.recordSuccess('bing', 4, 30);
    expect(tracker.isBenched('bing')).toBe(false);
    expect(tracker.snapshot(['bing'])[0]!.ok).toBe(true);
    expect(tracker.detailed()[0]!.totalResults).toBe(4);
  });

  it('benches a blocked engine immediately even at a high threshold', () => {
    const tracker = new EngineHealthTracker({ failureThreshold: 10, cooldownMs: 60_000 });
    tracker.recordFailure('sogou', new Error('sogou: HTTP 403 (blocked)'));
    expect(tracker.isBenched('sogou')).toBe(true);
  });

  it('requires the configured threshold for an ordinary error', () => {
    const tracker = new EngineHealthTracker({ failureThreshold: 3, cooldownMs: 60_000 });
    tracker.recordFailure('npm', new Error('npm: HTTP 500'));
    tracker.recordFailure('npm', new Error('npm: HTTP 500'));
    expect(tracker.isBenched('npm')).toBe(false);
    tracker.recordFailure('npm', new Error('npm: HTTP 500'));
    expect(tracker.isBenched('npm')).toBe(true);
  });
});
