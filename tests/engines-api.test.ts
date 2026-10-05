/**
 * Tests for the API-backed engines.
 *
 * The keyless engines are exercised through their exported `map*Response` /
 * `parse*Feed` helpers against captured payloads. The keyed engines get the same
 * mapper coverage plus the two failure modes that actually matter to a user: a
 * missing key (which must name the env var and must not spend a request) and an
 * exhausted quota (which must be reported as a *block*, not as "0 results").
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { EngineError } from '../src/engines/kit.js';
import { mapWikipediaResponse } from '../src/engines/wikipedia.js';
import { mapHackerNewsResponse } from '../src/engines/hackernews.js';
import { mapGitHubResponse } from '../src/engines/github.js';
import { mapStackExchangeResponse } from '../src/engines/stackexchange.js';
import { parseArxivFeed, stripAbstractPrefix } from '../src/engines/arxiv.js';
import { mapOpenAlexResponse, reconstructAbstract } from '../src/engines/openalex.js';
import { mapCrossrefResponse, authorNames, datePartsOf, isoFromDateParts, yearFromDateParts } from '../src/engines/crossref.js';
import { mapNpmResponse } from '../src/engines/npm.js';
import { mapCratesResponse } from '../src/engines/crates.js';
import { mapBraveResponse } from '../src/engines/brave-api.js';
import { mapSerperResponse } from '../src/engines/serper.js';
import { mapTavilyResponse } from '../src/engines/tavily.js';
import { mapExaResponse } from '../src/engines/exa.js';
import { mapGoogleCseResponse } from '../src/engines/google-cse.js';
import { createEngine, getDefinition } from '../src/engines/registry.js';
import type { HttpClient, HttpRequestOptions, HttpResponse } from '../src/http.js';
import type { EngineKind, RawResult } from '../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const jsonFixture = (name: string): unknown => JSON.parse(fixture(name));

/* ------------------------------------------------------------------ *
 * Stub HTTP client (records what was requested, never opens a socket)
 * ------------------------------------------------------------------ */

interface RecordedRequest {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

interface StubClient extends HttpClient {
  requests: RecordedRequest[];
}

function createStub(body: string, status = 200): StubClient {
  const requests: RecordedRequest[] = [];
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
      return {
        status,
        ok: status >= 200 && status < 300,
        url,
        headers: new Headers({ 'content-type': 'application/json' }),
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
    respectRobots: false,
    allowPrivateHosts: false,
    keys: {},
    ...overrides,
  } as unknown as Config;
}

/** Every result any mapper produces has to satisfy this contract. */
function expectWellFormed(results: RawResult[], expected: number): void {
  expect(results).toHaveLength(expected);
  for (const result of results) {
    expect(result.title.trim().length).toBeGreaterThan(0);
    expect(result.url).toMatch(/^https?:\/\/\S+$/);
    expect((result.snippet ?? '').trim().length).toBeGreaterThan(0);
  }
}

/** Await a call that must fail, asserting it failed with an `EngineError`. */
async function expectEngineError(promise: Promise<unknown>): Promise<EngineError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error, 'the call should have rejected').toBeInstanceOf(EngineError);
  return error as EngineError;
}

/* ------------------------------------------------------------------ *
 * Keyless API engines
 * ------------------------------------------------------------------ */

interface MapperCase {
  id: string;
  kind: EngineKind;
  /** Fixture the mapper is fed. */
  file: string;
  /** True for the one XML fixture. */
  xml?: boolean;
  map: (text: string, limit: number) => RawResult[];
  expected: number;
}

const keylessCases: MapperCase[] = [
  { id: 'wikipedia', kind: 'api', file: 'wikipedia.json', map: (t, l) => mapWikipediaResponse(JSON.parse(t), l), expected: 3 },
  { id: 'hackernews', kind: 'api', file: 'hackernews.json', map: (t, l) => mapHackerNewsResponse(JSON.parse(t), l), expected: 10 },
  { id: 'github', kind: 'api', file: 'github.json', map: (t, l) => mapGitHubResponse(JSON.parse(t), l), expected: 10 },
  { id: 'stackexchange', kind: 'api', file: 'stackexchange.json', map: (t, l) => mapStackExchangeResponse(JSON.parse(t), l), expected: 10 },
  { id: 'arxiv', kind: 'api', file: 'arxiv.xml', xml: true, map: (t, l) => parseArxivFeed(t, l), expected: 10 },
  { id: 'openalex', kind: 'api', file: 'openalex.json', map: (t, l) => mapOpenAlexResponse(JSON.parse(t), l), expected: 5 },
  { id: 'crossref', kind: 'api', file: 'crossref.json', map: (t, l) => mapCrossrefResponse(JSON.parse(t), l), expected: 5 },
  { id: 'npm', kind: 'api', file: 'npm.json', map: (t, l) => mapNpmResponse(JSON.parse(t), l), expected: 5 },
  { id: 'crates', kind: 'api', file: 'crates.json', map: (t, l) => mapCratesResponse(JSON.parse(t), l), expected: 5 },
];

describe.each(keylessCases)('$id mapper', (testCase) => {
  const text = fixture(testCase.file);
  const results = testCase.map(text, 50);

  it('maps the captured payload into well-formed results', () => {
    expectWellFormed(results, testCase.expected);
  });

  it('honours the requested limit', () => {
    expect(testCase.map(text, 2)).toHaveLength(2);
  });

  it('matches the registry metadata for the engine', () => {
    const definition = getDefinition(testCase.id);
    expect(definition, `registry definition for ${testCase.id}`).toBeDefined();
    const engine = createEngine(testCase.id, { http: createStub('{}'), config: stubConfig() });
    expect(engine).toBeDefined();
    expect(engine!.id).toBe(definition!.id);
    expect(engine!.kind).toBe(testCase.kind);
    expect(engine!.requiresKey).toBe(false);
    expect(engine!.transport).toBe('http');
  });

  it('returns an empty list for a payload of the wrong shape', () => {
    expect(testCase.map('{}', 10)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Keyless engine-specific invariants
 * ------------------------------------------------------------------ */

describe('wikipedia', () => {
  const results = mapWikipediaResponse(jsonFixture('wikipedia.json'), 20);

  it('decodes an HTML-escaped title and strips searchmatch markup', () => {
    expect(results[2]!.title).toBe('Language model & tool use');
    expect(results[2]!.url).toBe('https://en.wikipedia.org/wiki/Language_model_%26_tool_use');
    expect(results[0]!.snippet).toBe(
      'Model Context Protocol (MCP) is an open standard introduced by Anthropic in November 2024 for connecting AI assistants to external data sources and tools.',
    );
    expect(results[0]!.snippet).not.toContain('searchmatch');
  });

  it('builds the article URL on the requested language sub-domain', () => {
    expect(results[0]!.url).toBe('https://en.wikipedia.org/wiki/Model_Context_Protocol');
    expect(mapWikipediaResponse(jsonFixture('wikipedia.json'), 1, 'de')[0]!.url).toContain('https://de.wikipedia.org/wiki/');
  });

  it('carries the word count and total hits in meta', () => {
    expect(results[0]!.meta?.wordcount).toBe(1873);
    expect(results[0]!.meta?.totalhits).toBe(412);
    expect(results[0]!.publishedAt).toBe('2026-09-28T14:22:07.000Z');
  });
});

describe('hackernews', () => {
  const results = mapHackerNewsResponse(jsonFixture('hackernews.json'), 20);

  it('composes a points/comments/author snippet when there is no story text', () => {
    expect(results[0]!.snippet).toBe('872 points · 258 comments · by benocodes');
    expect(results[0]!.meta?.points).toBe(872);
    expect(results[0]!.meta?.comments).toBe(258);
    expect(results[0]!.meta?.author).toBe('benocodes');
  });

  it('links self-posts to the Hacker News item page', () => {
    // One hit in the capture has an empty `url` (an Ask HN style post).
    expect(results.some((r) => r.url.startsWith('https://news.ycombinator.com/item?id='))).toBe(true);
  });

  it('parses created_at into an ISO date', () => {
    expect(results[0]!.publishedAt).toBe('2024-11-25T16:14:22.000Z');
  });
});

describe('github', () => {
  const results = mapGitHubResponse(jsonFixture('github.json'), 20);

  it('titles a result with the repository full name', () => {
    expect(results[0]!.title).toBe('modelcontextprotocol/servers');
    expect(results[0]!.url).toBe('https://github.com/modelcontextprotocol/servers');
  });

  it('includes the star count in the composed snippet and in meta', () => {
    expect(results[0]!.snippet).toContain('★91012');
    expect(results[0]!.snippet).toContain('TypeScript');
    expect(results[0]!.snippet).toContain('updated 2026-10-05');
    expect(results[0]!.meta?.stars).toBe(91012);
    expect(results[0]!.meta?.language).toBe('TypeScript');
  });

  it('reports pushed_at (the last commit), not updated_at', () => {
    expect(results[0]!.publishedAt).toBe('2026-10-05T05:59:16.000Z');
  });
});

describe('stackexchange', () => {
  const results = mapStackExchangeResponse(jsonFixture('stackexchange.json'), 20);

  it('converts unix creation_date seconds into an ISO date', () => {
    expect(results[0]!.publishedAt).toBe('2025-05-31T04:24:26.000Z');
  });

  it('composes a score/answers/tags snippet when the filter has no body', () => {
    expect(results[0]!.snippet).toBe('score 2 · 1 answer · claude, model-context-protocol');
    expect(results[0]!.meta?.tags).toEqual(['claude', 'model-context-protocol']);
    expect(results[0]!.meta?.quotaRemaining).toBe(299);
    expect(results[0]!.meta?.site).toBe('stackoverflow');
  });

  it('builds links on the requested site', () => {
    const serverfault = mapStackExchangeResponse(jsonFixture('stackexchange.json'), 1, 'serverfault');
    expect(serverfault[0]!.meta?.site).toBe('serverfault');
  });
});

describe('arxiv', () => {
  const results = parseArxivFeed(fixture('arxiv.xml'), 20);

  it('parses the Atom feed into titled results', () => {
    expect(results[0]!.title).toContain('MCP4EDA');
    expect(results[0]!.meta?.authors).toContain('Yiting Wang');
    expect(results[0]!.meta?.primaryCategory).toBe('cs.AR');
  });

  it('normalises http:// entry ids to https://', () => {
    for (const result of results) {
      expect(result.url.startsWith('https://arxiv.org/abs/')).toBe(true);
      expect(result.url).not.toContain('http://');
    }
  });

  it('parses the published date and keeps the abstract as the snippet', () => {
    expect(results[0]!.publishedAt).toBe('2025-07-25T17:16:26.000Z');
    expect(results[0]!.snippet).toContain('This paper presents MCP4EDA');
  });

  it('strips a literal "Abstract:" label from the summary', () => {
    expect(stripAbstractPrefix('Abstract: We study tool use.')).toBe('We study tool use.');
    expect(stripAbstractPrefix('ABSTRACT — We study tool use.')).toBe('We study tool use.');
    expect(stripAbstractPrefix('No label here.')).toBe('No label here.');
  });

  it('returns nothing for an empty body', () => {
    expect(parseArxivFeed('', 5)).toEqual([]);
  });
});

describe('openalex', () => {
  const results = mapOpenAlexResponse(jsonFixture('openalex.json'), 20);

  it('reconstructs an abstract from the inverted index in word order', () => {
    expect(reconstructAbstract({ Model: [0], context: [1], protocol: [2], installation: [3] })).toBe(
      'Model context protocol installation',
    );
    // A word that occupies several positions is repeated in every slot.
    expect(reconstructAbstract({ a: [1], b: [0], a2: [2], b2: [3] })).toBe('b a a2 b2');
    expect(results[0]!.meta?.abstract).toBe('Model context protocol installation for AIFARMS data repository');
    expect(results[0]!.snippet).toBe('Model context protocol installation for AIFARMS data repository');
  });

  it('falls back to the venue/year/citations snippet without an abstract', () => {
    const withoutAbstract = results.find((r) => !r.meta?.abstract);
    expect(withoutAbstract, 'the capture contains one work without an abstract').toBeDefined();
    expect(withoutAbstract!.snippet).toBe('Springer eBooks · 2025 · cited by 1');
  });

  it('prefers the DOI as the canonical URL', () => {
    expect(results[0]!.url).toBe('https://doi.org/10.5281/zenodo.21716546');
    expect(results[0]!.meta?.total).toBe(2649976);
  });

  it('returns undefined for a missing or malformed inverted index', () => {
    expect(reconstructAbstract(undefined)).toBeUndefined();
    expect(reconstructAbstract(null)).toBeUndefined();
    expect(reconstructAbstract([1, 2])).toBeUndefined();
    expect(reconstructAbstract({})).toBeUndefined();
    expect(reconstructAbstract({ word: [] })).toBeUndefined();
  });
});

describe('crossref', () => {
  const results = mapCrossrefResponse(jsonFixture('crossref.json'), 20);

  it('builds an ISO date from date-parts, defaulting missing month and day', () => {
    expect(isoFromDateParts([[2026]])).toBe('2026-01-01T00:00:00.000Z');
    expect(isoFromDateParts([[2025, 6, 30]])).toBe('2025-06-30T00:00:00.000Z');
    expect(isoFromDateParts([[2025, 6]])).toBe('2025-06-01T00:00:00.000Z');
    expect(isoFromDateParts([[1200]])).toBeUndefined();
    expect(isoFromDateParts(undefined)).toBeUndefined();
  });

  it('reads the year and the parts in either shape', () => {
    expect(yearFromDateParts([[2025, 6, 30]])).toBe(2025);
    expect(datePartsOf([[2025, 6, 30]])).toEqual([2025, 6, 30]);
    expect(datePartsOf([2025, 6])).toEqual([2025, 6]);
    expect(datePartsOf('nonsense')).toEqual([]);
  });

  it('uses the DOI URL when the publisher landing page is absent', () => {
    expect(results[0]!.url).toBe('https://doi.org/10.1007/979-8-8688-3010-5_1');
    expect(results[0]!.meta?.doi).toBe('10.1007/979-8-8688-3010-5_1');
    expect(results[1]!.publishedAt).toBe('2025-06-30T00:00:00.000Z');
  });

  it('composes author names from given and family', () => {
    expect(authorNames([{ given: 'Gerald', family: 'Versluis' }, { family: 'Lovelace' }, { given: '' }])).toEqual([
      'Gerald Versluis',
      'Lovelace',
    ]);
    expect(results[0]!.meta?.authors).toEqual(['Gerald Versluis']);
  });

  it('strips JATS markup from an abstract', () => {
    expect(results[1]!.snippet).toContain('The Model Context Protocol (MCP) is a standardized open protocol');
    expect(results[1]!.snippet).not.toContain('<jats:');
  });
});

describe('npm', () => {
  const results = mapNpmResponse(jsonFixture('npm.json'), 20);

  it('titles a result as name@version', () => {
    expect(results[0]!.title).toBe('@modelcontextprotocol/sdk@1.32.1');
    expect(results[0]!.meta?.name).toBe('@modelcontextprotocol/sdk');
    expect(results[0]!.meta?.version).toBe('1.32.1');
    expect(results[0]!.url).toBe('https://www.npmjs.com/package/@modelcontextprotocol/sdk');
  });

  it('mentions the weekly download count in the snippet', () => {
    expect(results[0]!.snippet).toContain('76226448 weekly downloads');
    expect(results[0]!.meta?.weeklyDownloads).toBe(76226448);
  });

  it('falls back to the canonical npm URL when links.npm is missing', () => {
    const synthetic = mapNpmResponse({ objects: [{ package: { name: 'left-pad', version: '1.3.0', description: 'x' } }] }, 5);
    expect(synthetic[0]!.url).toBe('https://www.npmjs.com/package/left-pad');
  });
});

describe('crates', () => {
  const results = mapCratesResponse(jsonFixture('crates.json'), 20);

  it('links to the crate page and shows the semver', () => {
    expect(results[0]!.title).toBe('model-context-protocol');
    expect(results[0]!.url).toBe('https://crates.io/crates/model-context-protocol');
    expect(results[0]!.snippet).toContain('v0.2.2');
    expect(results[0]!.meta?.version).toBe('0.2.2');
  });

  it('truncates nanosecond timestamps to whole seconds', () => {
    expect(results[0]!.publishedAt).toBe('2026-02-09T22:22:35.000Z');
    expect(results[1]!.publishedAt).toBe('2026-08-22T16:29:37.000Z');
  });

  it('summarises recent downloads', () => {
    expect(results[0]!.snippet).toContain('1978 recent downloads');
    expect(results[0]!.meta?.recentDownloads).toBe(1978);
  });
});

/* ------------------------------------------------------------------ *
 * Keyed API engines
 * ------------------------------------------------------------------ */

interface KeyedCase {
  id: string;
  keyEnv: string;
  map: (json: unknown, limit: number) => RawResult[];
  file: string;
  expected: number;
}

const keyedCases: KeyedCase[] = [
  { id: 'brave-api', keyEnv: 'BRAVE_API_KEY', file: 'brave-api.json', map: mapBraveResponse, expected: 4 },
  { id: 'serper', keyEnv: 'SERPER_API_KEY', file: 'serper.json', map: mapSerperResponse, expected: 4 },
  { id: 'tavily', keyEnv: 'TAVILY_API_KEY', file: 'tavily.json', map: mapTavilyResponse, expected: 3 },
  { id: 'exa', keyEnv: 'EXA_API_KEY', file: 'exa.json', map: mapExaResponse, expected: 3 },
  { id: 'google-cse', keyEnv: 'GOOGLE_CSE_KEY', file: 'google-cse.json', map: mapGoogleCseResponse, expected: 3 },
];

describe.each(keyedCases)('$id mapper', (testCase) => {
  const results = testCase.map(jsonFixture(testCase.file), 50);

  it('maps the captured payload into well-formed results', () => {
    expectWellFormed(results, testCase.expected);
  });

  it('honours the requested limit', () => {
    expect(testCase.map(jsonFixture(testCase.file), 2)).toHaveLength(2);
  });

  it('matches the registry metadata and requires its key', () => {
    const definition = getDefinition(testCase.id);
    expect(definition, `registry definition for ${testCase.id}`).toBeDefined();
    expect(definition!.tier).toBe('keyed');
    const engine = createEngine(testCase.id, { http: createStub('{}'), config: stubConfig() });
    expect(engine).toBeDefined();
    expect(engine!.id).toBe(definition!.id);
    expect(engine!.kind).toBe('api');
    expect(engine!.requiresKey).toBe(true);
    expect(engine!.keyEnv).toBe(testCase.keyEnv);
  });
});

describe('keyed engines without credentials', () => {
  const missingKeyCases: [string, string][] = [
    ['brave-api', 'BRAVE_API_KEY'],
    ['serper', 'SERPER_API_KEY'],
    ['tavily', 'TAVILY_API_KEY'],
    ['exa', 'EXA_API_KEY'],
  ];

  it.each(missingKeyCases)('%s names %s and makes no request', async (id, envVar) => {
    const http = createStub('{}');
    const engine = createEngine(id, { http, config: stubConfig() })!;
    const error = await expectEngineError(engine.search('mcp', { limit: 5 }));

    expect(error.message).toContain(envVar);
    expect(error.message).toContain('missing API key');
    expect(http.requests).toHaveLength(0);
  });

  it('google-cse demands both GOOGLE_CSE_KEY and GOOGLE_CSE_CX', async () => {
    const noKey = createStub('{}');
    const neither = await expectEngineError(createEngine('google-cse', { http: noKey, config: stubConfig() })!.search('mcp', { limit: 5 }));
    expect(neither.message).toContain('GOOGLE_CSE_KEY');
    expect(neither.message).toContain('GOOGLE_CSE_CX');
    expect(noKey.requests).toHaveLength(0);

    const cxOnly = createStub('{}');
    const missingKey = await expectEngineError(
      createEngine('google-cse', { http: cxOnly, config: stubConfig({ keys: { googleCse: { cx: 'engine-id' } } }) })!.search('mcp', {
        limit: 5,
      }),
    );
    expect(missingKey.message).toContain('GOOGLE_CSE_KEY');
    expect(missingKey.message).not.toContain('GOOGLE_CSE_CX');
    expect(cxOnly.requests).toHaveLength(0);

    const keyOnly = createStub('{}');
    const missingCx = await expectEngineError(
      createEngine('google-cse', { http: keyOnly, config: stubConfig({ keys: { googleCse: { key: 'api-key' } } }) })!.search('mcp', {
        limit: 5,
      }),
    );
    expect(missingCx.message).toContain('GOOGLE_CSE_CX');
    expect(keyOnly.requests).toHaveLength(0);
  });
});

describe('keyed engines with credentials', () => {
  it('brave-api sends the subscription token and parses the HTML-decorated title', async () => {
    const http = createStub(fixture('brave-api.json'));
    const engine = createEngine('brave-api', { http, config: stubConfig({ keys: { brave: 'brave-key' } }) })!;
    const results = await engine.search('mcp', { limit: 5, freshness: 'week', region: 'de' });

    expectWellFormed(results, 4);
    expect(results[0]!.title).toBe('Model Context Protocol — Introduction');
    expect(results[0]!.publishedAt).toBe('2025-03-26T14:21:07.000Z');
    expect(results[0]!.meta?.publisher).toBe('modelcontextprotocol.io');

    const request = http.requests[0]!;
    expect(request.headers['x-subscription-token']).toBe('brave-key');
    const params = new URL(request.url).searchParams;
    expect(params.get('count')).toBe('5');
    expect(params.get('country')).toBe('DE');
    expect(params.get('freshness')).toBe('pw');
  });

  it('serper posts the query and attaches the oneboxes to the first result only', async () => {
    const http = createStub(fixture('serper.json'));
    const engine = createEngine('serper', { http, config: stubConfig({ keys: { serper: 'serper-key' } }) })!;
    const results = await engine.search('mcp', { limit: 5, region: 'gb', freshness: 'day' });

    expectWellFormed(results, 4);
    expect(results[0]!.meta?.answerBox).toBeDefined();
    expect(results[0]!.meta?.knowledgeGraph).toBeDefined();
    expect(results[0]!.meta?.peopleAlsoAsk).toHaveLength(2);
    expect(results[0]!.meta?.relatedSearches).toHaveLength(3);
    expect(results[1]!.meta?.answerBox).toBeUndefined();
    expect(results[0]!.meta?.position).toBe(1);
    expect(results[0]!.meta?.sitelinks as unknown[]).toHaveLength(2);

    const request = http.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.headers['x-api-key']).toBe('serper-key');
    const payload = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    expect(payload.q).toBe('mcp');
    expect(payload.gl).toBe('GB');
    expect(payload.tbs).toBe('qdr:d');
  });

  it('tavily sends a bearer token and keeps the synthesised answer on result one', async () => {
    const http = createStub(fixture('tavily.json'));
    const engine = createEngine('tavily', { http, config: stubConfig({ keys: { tavily: 'tavily-key' } }) })!;
    const results = await engine.search('mcp', { limit: 5, freshness: 'week' });

    expectWellFormed(results, 3);
    expect(results[0]!.meta?.answer).toContain('Model Context Protocol');
    expect(results[1]!.meta?.answer).toBeUndefined();
    expect(results[0]!.meta?.score).toBeCloseTo(0.9614);

    const request = http.requests[0]!;
    expect(request.headers.authorization).toBe('Bearer tavily-key');
    const payload = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
    expect(payload.topic).toBe('news');
    expect(payload.days).toBe(7);
  });

  it('exa sends the api key header and keeps the author in meta', async () => {
    const http = createStub(fixture('exa.json'));
    const engine = createEngine('exa', { http, config: stubConfig({ keys: { exa: 'exa-key' } }) })!;
    const results = await engine.search('mcp', { limit: 5 });

    expectWellFormed(results, 3);
    expect(results[1]!.meta?.author).toBe('Anthropic');
    expect(results[0]!.meta?.author).toBeUndefined();
    expect(http.requests[0]!.headers['x-api-key']).toBe('exa-key');
  });

  it('google-cse sends key and cx and keeps the totals on result one', async () => {
    const http = createStub(fixture('google-cse.json'));
    const engine = createEngine('google-cse', {
      http,
      config: stubConfig({ keys: { googleCse: { key: 'cse-key', cx: 'cse-cx' } } }),
    })!;
    const results = await engine.search('mcp', { limit: 20 });

    expectWellFormed(results, 3);
    expect(results[0]!.meta?.totalResults).toBe('8410000');
    expect(results[0]!.meta?.siteName).toBe('Model Context Protocol');
    expect(results[0]!.meta?.displayLink).toBe('modelcontextprotocol.io');
    expect(results[1]!.meta?.totalResults).toBeUndefined();
    expect(results[0]!.publishedAt).toBe('2025-03-26T14:21:07.000Z');

    const params = new URL(http.requests[0]!.url).searchParams;
    expect(params.get('key')).toBe('cse-key');
    expect(params.get('cx')).toBe('cse-cx');
    // The JSON API returns at most ten items per call, whatever was asked for.
    expect(params.get('num')).toBe('10');
  });

  it('turns the captured quota body into a blocked EngineError', async () => {
    const http = createStub(fixture('google-cse-quota-error.json'), 429);
    const engine = createEngine('google-cse', {
      http,
      config: stubConfig({ keys: { googleCse: { key: 'cse-key', cx: 'cse-cx' } } }),
    })!;
    const error = await expectEngineError(engine.search('mcp', { limit: 5 }));

    expect(error.blocked).toBe(true);
    expect(error.message).toContain('quota exceeded');
    expect(error.options.status).toBe(429);
    // The body had to be read to know why, so exactly one request was spent.
    expect(http.requests).toHaveLength(1);
  });

  it('reports a non-quota Google error without marking it blocked', async () => {
    const http = createStub(JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }), 400);
    const engine = createEngine('google-cse', {
      http,
      config: stubConfig({ keys: { googleCse: { key: 'bad', cx: 'cse-cx' } } }),
    })!;
    const error = await expectEngineError(engine.search('mcp', { limit: 5 }));

    expect(error.blocked).toBe(false);
    expect(error.message).toContain('API key not valid');
  });
});
