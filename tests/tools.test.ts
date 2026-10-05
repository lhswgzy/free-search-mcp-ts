/**
 * Behavioural tests for the tool registry and its handlers (`src/tools/*`).
 *
 * Every handler is called directly with a stub-backed `Services` object, which
 * is exactly how the CLI calls them — so these tests cover the same code path a
 * model reaches through MCP, minus the JSON-RPC framing (that is
 * `tests/server.test.ts`).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { closeCache, getCache } from '../src/cache.js';
import { HttpError, assertFetchable, type HttpClient, type HttpRequestOptions, type HttpResponse } from '../src/http.js';
import { TOOLS, createServices, getTool, type Services, type ToolResponse } from '../src/tools/index.js';
import { ENGINE_IDS } from '../src/engines/registry.js';
import {
  formatBytes,
  formatDate,
  renderCacheStats,
  renderEngineTable,
  renderFetchedPage,
  renderIndexHits,
  renderResearchBrief,
  renderSearchResults,
} from '../src/tools/format.js';
import type { FetchedPage, ResearchReport, SearchResult } from '../src/types.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function testConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig({
    dataDir: tempDir('fsmcp-tools-'),
    skipDotEnv: true,
    overrides: { engines: [], autoEngines: true, respectRobots: false, ...overrides },
  });
}

afterEach(() => {
  closeCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function response(url: string, body: string, contentType = 'text/html; charset=utf-8', status = 200): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers({ 'content-type': contentType }),
    body,
    bytes,
    elapsedMs: 1,
    attempts: 1,
  };
}

type StubHandler = (url: string, options: HttpRequestOptions) => HttpResponse | Promise<HttpResponse>;

function stubHttp(config: Config, handler: StubHandler, calls: string[] = []): HttpClient {
  const client: HttpClient = {
    config,
    async request(url, options = {}) {
      calls.push(url);
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

const PAGE_URL = 'https://docs.example.com/widget-guide';
const SECOND_URL = 'https://docs.example.com/gadget-guide';
const MISSING_URL = 'https://docs.example.com/missing';

const WIDGET_PAGE = `<!doctype html><html><head><title>Widget Guide</title></head><body>
<nav>Home | About | Contact</nav>
<article>
<h1>Widget Guide</h1>
<p>The widget pipeline resolves upstream tokens into local artefacts and caches every one of them.</p>
<p>Configuration lives in the widget settings file, which the pipeline reads once at start-up.</p>
</article>
<footer>Copyright nobody</footer>
</body></html>`;

const LONG_PAGE = `<!doctype html><html><head><title>Long Widget Manual</title></head><body><article>
<h1>Long Widget Manual</h1>
${Array.from({ length: 12 }, (_, i) => `<p>Section ${i + 1}: the widget pipeline keeps a sovereign record of every artefact it resolves, so that a repeated lookup against the same widget identifier never has to touch the network again.</p>`).join('\n')}
</article></body></html>`;

function bingHtml(): string {
  const rows = [
    { url: 'https://alpha.example.com/one', title: 'Alpha page about widgets', snippet: 'Alpha snippet describing the widget pipeline in enough detail to be useful.' },
    { url: 'https://beta.example.com/two', title: 'Beta page about gadgets', snippet: 'Beta snippet describing the gadget pipeline in enough detail to be useful.' },
  ]
    .map(
      (r) =>
        `<li class="b_algo"><h2><a href="${r.url}">${r.title}</a></h2><div class="b_caption"><p>${r.snippet}</p></div></li>`,
    )
    .join('\n');
  return `<!doctype html><html><head><title>widgets</title></head><body><ol id="b_results">\n${rows}\n</ol></body></html>`;
}

/** Serves robots.txt, a Bing page, the fixture pages, and a generic page for anything else. */
function fullHandler(url: string): HttpResponse {
  if (/\/robots\.txt$/.test(url)) return response(url, '', 'text/plain');
  if (/bing\.com\/search/.test(url)) return response(url, bingHtml());
  if (url.startsWith('https://docs.example.com/long')) return response(url, LONG_PAGE);
  if (url.startsWith(PAGE_URL)) return response(url, WIDGET_PAGE);
  if (url === SECOND_URL) return response(url, WIDGET_PAGE.replace(/Widget/g, 'Gadget'));
  if (url.startsWith(MISSING_URL)) throw new HttpError(`HTTP 404 for ${url}`, { status: 404, url, retryable: false });
  if (url.startsWith('http://127.0.0.1')) throw new Error('the SSRF guard should have refused this URL');
  return response(url, WIDGET_PAGE);
}

function services(calls: string[] = [], handler: StubHandler = fullHandler): Services {
  const config = testConfig();
  return createServices(config, stubHttp(config, handler, calls));
}

function tool(name: string) {
  const found = getTool(name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

describe('TOOLS registry', () => {
  it('exposes exactly the eight documented tools', () => {
    expect(TOOLS).toHaveLength(8);
    expect(TOOLS.map((t) => t.name)).toEqual([
      'web_search',
      'research',
      'fetch_url',
      'fetch_urls',
      'parse_document',
      'search_index',
      'local_index',
      'list_engines',
    ]);
  });

  it('gives every tool a title, a description and a schema', () => {
    for (const definition of TOOLS) {
      expect(definition.title.length, `${definition.name} title`).toBeGreaterThan(0);
      expect(definition.description.length, `${definition.name} description`).toBeGreaterThan(40);
      expect(Object.keys(definition.schema).length, `${definition.name} schema`).toBeGreaterThan(0);
      expect(typeof definition.handler, `${definition.name} handler`).toBe('function');
    }
    expect(getTool('web_search')).toBeDefined();
    expect(getTool('not_a_tool')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * web_search
 * ------------------------------------------------------------------ */

describe('web_search handler', () => {
  it('returns structured JSON when asked for it', async () => {
    const result = await tool('web_search').handler(
      { query: 'widgets', format: 'json', engines: ['bing'], max_results: 3 },
      services(),
    );
    const payload = JSON.parse(result.text) as { query: string; count: number; results: unknown[] };

    expect(payload.query).toBe('widgets');
    expect(Array.isArray(payload.results)).toBe(true);
    expect(payload.results.length).toBeGreaterThan(0);
    expect(payload.count).toBe(payload.results.length);
    expect(result.structured).toBeDefined();
    expect(result.structured!.results).toEqual(payload.results);
    expect(result.isError).toBeUndefined();
  });

  it('returns Markdown containing the query by default', async () => {
    const result = await tool('web_search').handler({ query: 'widgets', engines: ['bing'] }, services());
    expect(result.text).toContain('widgets');
    expect(result.text).toContain('# Search results for `widgets`');
    expect(result.structured).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * fetch_url
 * ------------------------------------------------------------------ */

describe('fetch_url handler', () => {
  it('rejects a loopback URL with isError', async () => {
    const result = await tool('fetch_url').handler({ url: 'http://127.0.0.1:8765/admin' }, services());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Could not fetch');
    expect(result.text).toContain('private/loopback address');
  });

  it('renders a stubbed HTML page as Markdown', async () => {
    const result = await tool('fetch_url').handler({ url: PAGE_URL }, services());
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Widget Guide');
    expect(result.text).toContain('docs.example.com');
    expect(result.text).toContain('widget pipeline resolves upstream tokens');
    // Navigation chrome must not survive the readability pass.
    expect(result.text).not.toContain('Home | About | Contact');
  });

  it('honours max_chars by reporting a continuation offset', async () => {
    const result = await tool('fetch_url').handler({ url: 'https://docs.example.com/long', max_chars: 600 }, services());
    expect(result.text).toMatch(/Content truncated\. Continue with `offset: 600`/);

    const second = await tool('fetch_url').handler(
      { url: 'https://docs.example.com/long', max_chars: 600, offset: 600 },
      services(),
    );
    expect(second.text).toContain('characters 600–');
    expect(second.text).not.toBe(result.text);
  });

  it('serves the second identical call from the local page cache', async () => {
    const calls: string[] = [];
    const shared = services(calls);
    const first = await tool('fetch_url').handler({ url: SECOND_URL }, shared);
    const pageRequestsAfterFirst = calls.filter((u) => u === SECOND_URL).length;
    const second = await tool('fetch_url').handler({ url: SECOND_URL }, shared);

    expect(pageRequestsAfterFirst).toBe(1);
    expect(calls.filter((u) => u === SECOND_URL).length).toBe(1);
    expect(second.text).toContain('cached, fetched');
    expect(first.text).not.toContain('cached, fetched');
  });
});

/* ------------------------------------------------------------------ *
 * fetch_urls
 * ------------------------------------------------------------------ */

describe('fetch_urls handler', () => {
  it('reports per-URL failures without failing the whole call', async () => {
    const result = await tool('fetch_urls').handler({ urls: [PAGE_URL, MISSING_URL] }, services());

    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('# Fetched 1 of 2 URLs');
    expect(result.text).toContain('Could not fetch');
    expect(result.text).toContain(MISSING_URL);
    expect(result.text).toContain('Widget Guide');
  });

  it('summarises successes and failures in JSON mode', async () => {
    const result = await tool('fetch_urls').handler(
      { urls: [PAGE_URL, MISSING_URL], format: 'json' },
      services(),
    );
    const payload = result.structured as { requested: number; succeeded: number; failed: number };
    expect(payload.requested).toBe(2);
    expect(payload.succeeded).toBe(1);
    expect(payload.failed).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * research
 * ------------------------------------------------------------------ */

describe('research handler', () => {
  it('returns a cited Markdown brief', async () => {
    const result = await tool('research').handler({ query: 'widgets', depth: 1, max_sources: 2 }, services());
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('# Research brief: `widgets`');
    expect(result.text).toContain('Extractive brief');
    expect(result.text).toContain('## 1. ');
  });

  it('returns structured JSON when asked for it', async () => {
    const result = await tool('research').handler(
      { query: 'widgets', depth: 1, max_sources: 1, format: 'json' },
      services(),
    );
    const payload = result.structured as { query: string; sources: { index: number }[] };
    expect(payload.query).toBe('widgets');
    expect(Array.isArray(payload.sources)).toBe(true);
    expect(payload.sources[0]!.index).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * parse_document
 * ------------------------------------------------------------------ */

describe('parse_document handler', () => {
  it('asks for a path or a url when given neither', async () => {
    const result = await tool('parse_document').handler({}, services());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('path');
    expect(result.text).toContain('url');
  });

  it('errors clearly for a path that does not exist', async () => {
    const missing = join(tempDir('fsmcp-missing-'), 'nope.csv');
    const result = await tool('parse_document').handler({ path: missing }, services());
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Cannot read');
  });

  it('parses a local CSV file into a Markdown table', async () => {
    const file = join(tempDir('fsmcp-csv-'), 'parts.csv');
    writeFileSync(file, 'part,count\nwidget,42\ngadget,7\n', 'utf8');

    const result = await tool('parse_document').handler({ path: file }, services());
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('CSV');
    expect(result.text).toContain('| part | count |');
    expect(result.text).toContain('| widget | 42 |');
    expect(result.text).toContain('| gadget | 7 |');
  });
});

/* ------------------------------------------------------------------ *
 * search_index / local_index
 * ------------------------------------------------------------------ */

function storePage(config: Config, url: string, title: string, content: string): void {
  const page: FetchedPage = {
    url,
    finalUrl: url,
    title,
    content,
    contentFormat: 'markdown',
    contentType: 'text/html',
    status: 200,
    fetchedAt: '2024-05-06T07:08:09.000Z',
    wordCount: 12,
    cached: false,
  };
  getCache(config).putPage(page);
}

describe('search_index handler', () => {
  it('finds a page stored earlier through the cache', async () => {
    const config = testConfig();
    storePage(config, 'https://docs.example.com/widget-guide', 'Widget guide', '# Widget guide\n\nThe widget pipeline resolves sovereign state questions locally.');
    const shared: Services = createServices(config, stubHttp(config, fullHandler));

    const result = await tool('search_index').handler({ query: 'widget' }, shared);
    expect(result.text).toContain('https://docs.example.com/widget-guide');
    expect(result.text).toContain('Widget guide');

    const json = await tool('search_index').handler({ query: 'widget', format: 'json' }, shared);
    expect((json.structured as { count: number }).count).toBe(1);
  });

  it('explains itself when the index holds nothing that matches', async () => {
    const config = testConfig();
    const shared: Services = createServices(config, stubHttp(config, fullHandler));
    const result = await tool('search_index').handler({ query: 'zzzznotpresent' }, shared);
    expect(result.text).toContain('Nothing in the local index matches');
  });
});

describe('local_index handler', () => {
  it('reports stats and a removal count', async () => {
    const config = testConfig();
    storePage(config, 'https://docs.example.com/a', 'A page', '# A page\n\nContains the word sprocket for searching.');
    const shared: Services = createServices(config, stubHttp(config, fullHandler));

    const stats = await tool('local_index').handler({ action: 'stats' }, shared);
    expect(stats.text).toContain('# Local index status');
    expect(stats.text).toContain('Cached pages');

    const jsonStats = await tool('local_index').handler({ action: 'stats', format: 'json' }, shared);
    expect((jsonStats.structured as { action: string }).action).toBe('stats');
    expect((jsonStats.structured as { stats: { pages: number } }).stats.pages).toBe(1);

    const cleared = await tool('local_index').handler({ action: 'clear', scope: 'pages' }, shared);
    expect(cleared.text).toContain('Removed 1 record(s)');

    const after = await tool('local_index').handler({ action: 'stats', format: 'json' }, shared);
    expect((after.structured as { stats: { pages: number } }).stats.pages).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * list_engines
 * ------------------------------------------------------------------ */

describe('list_engines handler', () => {
  it('lists every registry engine and reports key status', async () => {
    const shared = services();
    const result = await tool('list_engines').handler({}, shared);
    for (const id of ENGINE_IDS) {
      expect(result.text, `engine ${id}`).toContain(`\`${id}\``);
    }

    const json = await tool('list_engines').handler({ format: 'json' }, shared);
    const payload = json.structured as {
      engines: { id: string; configured: boolean; requiresKey: boolean }[];
      health: { engine: string }[];
    };
    expect(payload.engines.map((e) => e.id)).toEqual([...ENGINE_IDS]);
    expect(payload.engines.length).toBe(ENGINE_IDS.length);
    expect(payload.engines.find((e) => e.id === 'brave-api')!.configured).toBe(false);
    expect(payload.engines.find((e) => e.id === 'brave-api')!.requiresKey).toBe(true);
    expect(payload.engines.find((e) => e.id === 'bing')!.configured).toBe(true);
    expect(payload.health.length).toBe(ENGINE_IDS.length);
  });
});

/* ------------------------------------------------------------------ *
 * Renderers
 * ------------------------------------------------------------------ */

function searchResult(partial: Partial<SearchResult> = {}): SearchResult {
  return {
    title: 'A result',
    url: 'https://example.com/a',
    snippet: 'A snippet',
    source: 'example.com',
    engines: ['bing'],
    bestRank: 1,
    score: 1,
    ...partial,
  };
}

function fetchedPage(partial: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/a',
    title: 'Example page',
    content: 'Body text',
    contentFormat: 'markdown',
    contentType: 'text/html',
    status: 200,
    fetchedAt: '2020-01-02T03:04:05.000Z',
    wordCount: 2,
    cached: false,
    ...partial,
  };
}

describe('renderers', () => {
  it('explains an empty result list instead of printing nothing', () => {
    const text = renderSearchResults({
      query: 'widgets',
      results: [],
      enginesUsed: [],
      enginesEmpty: ['bing'],
      enginesFailed: [{ engine: 'mojeek', error: 'HTTP 500' }],
      enginesSkipped: [],
      engineCounts: {},
      elapsedMs: 12,
    });
    expect(text).toContain('Search results for `widgets`');
    expect(text).toContain('no results');
    expect(text).toContain('No engine returned a usable result');
    expect(text).toContain('mojeek');
  });

  it('renders a numbered result list with provenance', () => {
    const text = renderSearchResults({
      query: 'widgets',
      results: [searchResult({ source: 'example.com', engines: ['bing', 'mojeek'] })],
      enginesUsed: ['bing', 'mojeek'],
      enginesEmpty: [],
      enginesFailed: [],
      enginesSkipped: ['sogou'],
      engineCounts: { bing: 1 },
      elapsedMs: 1500,
      cached: true,
    });
    expect(text).toContain('1. **[A result](https://example.com/a)**');
    expect(text).toContain('bing +1');
    expect(text).toContain('partly cached');
    expect(text).toContain('Skipped (temporarily benched after repeated failures):** sogou');
    expect(text).toContain('1.5 s');
  });

  it('mentions the next offset for a truncated page', () => {
    const text = renderFetchedPage({
      page: fetchedPage({ truncated: true, nextOffset: 4000, content: 'Partial body' }),
    });
    expect(text).toContain('Continue with `offset: 4000`');
    expect(text).toContain('# Example page');
  });

  it('escapes a pipe inside a table cell', () => {
    const text = renderEngineTable([
      {
        id: 'weird',
        label: 'Weird',
        kind: 'html',
        tier: 'optional',
        weight: 1,
        requiresKey: false,
        configured: true,
        note: 'left | right',
      },
    ]);
    expect(text).toContain('left \\| right');
    expect(text).not.toContain('| left | right |');
  });

  it('reports the cache state including its boundaries', () => {
    const text = renderCacheStats({
      enabled: false,
      path: null,
      pages: 0,
      searchCacheEntries: 0,
      bytes: 0,
      oldestFetchedAt: null,
      newestFetchedAt: null,
      fts5: false,
    });
    expect(text).toContain('| Enabled | no |');
    expect(text).toContain('| Size on disk | 0 B |');
    expect(text).toContain('in-memory LRU (degraded)');
  });

  it('quotes research passages and reports fetch failures', () => {
    const report: ResearchReport = {
      query: 'widgets',
      generatedAt: '2024-05-06T07:08:09.000Z',
      depth: 2,
      queries: ['widgets', 'widgets sprocket'],
      enginesUsed: ['bing'],
      enginesFailed: [{ engine: 'mojeek', error: 'connect timeout' }],
      sources: [
        { index: 1, title: 'Good source', url: 'https://a.example.com/1', source: 'a.example.com', engines: ['bing'], score: 1, wordCount: 10, cached: false, passages: [{ text: 'Quoted evidence here.', score: 1, offset: 0 }] },
        { index: 2, title: 'Broken source', url: 'https://b.example.com/2', source: 'b.example.com', engines: ['bing'], score: 1, wordCount: 0, cached: false, passages: [], error: 'HTTP 404' },
      ],
      markdown: '',
      elapsedMs: 5,
    };
    const text = renderResearchBrief(report);
    expect(text).toContain('# Research brief: `widgets`');
    expect(text).toContain('## 1. [Good source](https://a.example.com/1)');
    expect(text).toContain('> Quoted evidence here.');
    expect(text).toContain('| 2 | `b.example.com` | Broken source');
    expect(text).toContain('Could not fetch this source: HTTP 404');
    expect(text).toContain('Sources that could not be fetched:** [2] b.example.com');
    expect(text).toContain('**Engines that failed:** `mojeek` (connect timeout)');
  });

  it('explains an empty local index result', () => {
    expect(renderIndexHits('widgets', [])).toContain('Nothing in the local index matches');
  });

  it('formats dates at their boundaries', () => {
    expect(formatDate('1999-12-31T23:59:59.000Z')).toBe('1999-12-31');
    expect(formatDate('not a date')).toBe('not a date');
  });

  it('formats byte counts at their boundaries', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
  });
});

/* ------------------------------------------------------------------ *
 * Error surface
 * ------------------------------------------------------------------ */

describe('tool error surface', () => {
  it('surfaces transport failures as isError rather than throwing', async () => {
    const shared = services([], (url) => {
      if (/robots\.txt$/.test(url)) return response(url, '', 'text/plain');
      if (/bing\.com\/search/.test(url)) return response(url, bingHtml());
      throw new HttpError(`HTTP 503 for ${url}`, { status: 503, url, retryable: false });
    });
    const results: ToolResponse[] = [
      await tool('fetch_url').handler({ url: 'https://boom.example.com/x' }, shared),
      await tool('parse_document').handler({ path: '/definitely/not/here.txt' }, shared),
    ];
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.text.length).toBeGreaterThan(0);
    }
    // fetch_urls reports per-URL failures in its body instead of erroring out.
    const many = await tool('fetch_urls').handler({ urls: ['https://boom.example.com/x'] }, shared);
    expect(many.isError).toBeUndefined();
    expect(many.text).toContain('# Fetched 0 of 1 URLs');
  });
});
