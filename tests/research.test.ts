/**
 * Behavioural tests for the research pipeline (`src/research.ts`).
 *
 * `ResearchService` takes its search and fetch collaborators by injection, so
 * both are stubbed here: search returns a hand-built result set and fetch
 * returns hand-built pages. That keeps the tests offline while still running the
 * real query-expansion, source-selection, passage-scoring and Markdown code.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { closeCache } from '../src/cache.js';
import { chooseSources, deriveExpansionQueries, ResearchService } from '../src/research.js';
import type { FetchedPage, SearchResult } from '../src/types.js';
import type { SearchOutcome, SearchService } from '../src/search.js';
import type { FetchService, FetchPageOptions } from '../src/fetch/page.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function testConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = mkdtempSync(join(tmpdir(), 'fsmcp-research-'));
  tempDirs.push(dataDir);
  return loadConfig({
    dataDir,
    skipDotEnv: true,
    overrides: { engines: [], autoEngines: true, respectRobots: false, ...overrides },
  });
}

afterEach(() => {
  closeCache();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fused result with sensible defaults so each test states only what matters. */
function result(partial: Partial<SearchResult> & { url: string }): SearchResult {
  return {
    title: 'Untitled page',
    snippet: '',
    source: 'example.com',
    engines: ['bing'],
    bestRank: 1,
    score: 0.5,
    ...partial,
  };
}

/** Minimal `SearchService` stand-in that records the queries it was asked for. */
function stubSearch(calls: string[], results: SearchResult[]): SearchService {
  const build = (query: string): SearchOutcome => ({
    query,
    results,
    enginesUsed: ['bing'],
    enginesEmpty: [],
    enginesFailed: [],
    enginesSkipped: [],
    enginesNotUsed: [],
    engineCounts: { bing: results.length },
    tiersRun: ['explicit'],
    elapsedMs: 1,
    cached: false,
    health: [],
  });
  return {
    async search(query: string): Promise<SearchOutcome> {
      calls.push(query);
      return build(query);
    },
  } as unknown as SearchService;
}

/** Minimal `FetchService` stand-in. URLs in `failing` reject. */
function stubFetch(pages: Record<string, string>, calls: string[], failing: string[] = []): FetchService {
  const broken = new Set(failing);
  return {
    async fetchPage(url: string, _options: FetchPageOptions = {}): Promise<FetchedPage> {
      calls.push(url);
      if (broken.has(url)) throw new Error(`robots.txt disallows ${new URL(url).pathname}`);
      const content = pages[url] ?? '# Empty\n\nThis page has nothing relevant in it whatsoever.';
      return {
        url,
        finalUrl: url,
        title: `Title for ${new URL(url).hostname}`,
        content,
        contentFormat: 'markdown',
        contentType: 'text/html',
        status: 200,
        fetchedAt: '2024-05-06T07:08:09.000Z',
        wordCount: content.split(/\s+/).length,
        cached: false,
      };
    },
  } as unknown as FetchService;
}

/* ------------------------------------------------------------------ *
 * Query expansion
 * ------------------------------------------------------------------ */

describe('deriveExpansionQueries', () => {
  /** Five results in which "sprocket" recurs four times and "gasket" three. */
  const RESULTS: SearchResult[] = [
    result({ url: 'https://one.example.com/a', title: 'Sprocket gasket maintenance guide', snippet: 'The sprocket and gasket are serviced together each season of the year.' }),
    result({ url: 'https://two.example.com/b', title: 'Sprocket alignment tolerances', snippet: 'Sprocket alignment is measured with a gasket fitted in place at all times.' }),
    result({ url: 'https://three.example.com/c', title: 'Gasket replacement notes', snippet: 'A worn gasket shows up as sprocket chatter long before any visible damage.' }),
    result({ url: 'https://four.example.com/d', title: 'Sprocket inspection checklist', snippet: 'Inspect the sprocket teeth and note any play around the housing.' }),
    result({ url: 'https://five.example.com/e', title: 'Seasonal service schedule', snippet: 'The schedule covers lubrication and inspection on a fixed cadence.' }),
  ];

  it('adds terms that recur across several results but are absent from the query', () => {
    const expansions = deriveExpansionQueries('widget pipeline', RESULTS, 2);

    expect(expansions.length).toBeGreaterThan(0);
    expect(expansions.every((q) => q.startsWith('widget pipeline '))).toBe(true);
    expect(expansions.join(' ').toLowerCase()).toContain('sprocket');
    // The term keeps the casing it had in the source document.
    expect(expansions[0]).toContain('Sprocket');
    expect(expansions.length).toBe(2);
    // A term already in the query must never be re-added as a "new" term.
    expect(expansions.every((q) => q !== 'widget pipeline')).toBe(true);
  });

  it('returns at most `count` queries', () => {
    expect(deriveExpansionQueries('widget pipeline', RESULTS, 1).length).toBeLessThanOrEqual(1);
    expect(deriveExpansionQueries('widget pipeline', RESULTS, 2).length).toBeLessThanOrEqual(2);
    expect(deriveExpansionQueries('widget pipeline', RESULTS, 0)).toEqual([]);
  });

  it('produces nothing when no term recurs', () => {
    expect(deriveExpansionQueries('widget pipeline', [RESULTS[0]!], 2)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Source selection
 * ------------------------------------------------------------------ */

describe('chooseSources', () => {
  it('caps how many pages one domain contributes', () => {
    const a1 = result({ url: 'https://a.com/1', source: 'a.com', score: 0.9 });
    const a2 = result({ url: 'https://a.com/2', source: 'a.com', score: 0.8 });
    const a3 = result({ url: 'https://a.com/3', source: 'a.com', score: 0.7 });
    const b1 = result({ url: 'https://b.com/1', source: 'b.com', score: 0.6 });

    const chosen = chooseSources([a1, a2, a3, b1], 2);
    expect(chosen.map((r) => r.url)).toEqual(['https://a.com/1', 'https://b.com/1']);
    expect(chosen.filter((r) => r.source === 'a.com')).toHaveLength(1);
  });

  it('allows two pages per domain once it needs eight or more sources', () => {
    const a1 = result({ url: 'https://a.com/1', source: 'a.com', score: 0.9 });
    const a2 = result({ url: 'https://a.com/2', source: 'a.com', score: 0.8 });
    const a3 = result({ url: 'https://a.com/3', source: 'a.com', score: 0.7 });
    const b1 = result({ url: 'https://b.com/1', source: 'b.com', score: 0.6 });

    const chosen = chooseSources([a1, a2, a3, b1], 8);
    expect(chosen).toHaveLength(4);
    // The overflow from a.com only appears after the domain cap is relaxed.
    expect(chosen.indexOf(a3)).toBeGreaterThan(chosen.indexOf(b1));
  });

  it('drops video/social hosts and binary file extensions', () => {
    const candidates = [
      result({ url: 'https://www.youtube.com/watch?v=abc123', source: 'youtube.com', score: 9 }),
      result({ url: 'https://twitter.com/someone/status/1', source: 'twitter.com', score: 8 }),
      result({ url: 'https://files.example.com/release.zip', source: 'example.com', score: 7 }),
      result({ url: 'https://media.example.com/clip.mp4', source: 'example.com', score: 6 }),
      result({ url: 'https://docs.example.com/guide', source: 'docs.example.com', score: 5 }),
    ];

    const chosen = chooseSources(candidates, 10);
    expect(chosen.map((r) => r.url)).toEqual(['https://docs.example.com/guide']);
  });

  it('prefers a page several engines agree on over a single-engine page', () => {
    const solo = result({ url: 'https://solo.example.com/x', source: 'solo.example.com', score: 1 });
    const agreed = result({
      url: 'https://agreed.example.com/y',
      source: 'agreed.example.com',
      score: 1,
      engines: ['bing', 'mojeek'],
    });

    const chosen = chooseSources([solo, agreed], 2);
    expect(chosen[0]!.url).toBe('https://agreed.example.com/y');
    expect(chosen).toHaveLength(2);
  });

  it('never returns more than maxSources', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      result({ url: `https://host${i}.example.com/p`, source: `host${i}.example.com`, score: 1 - i / 100 }),
    );
    expect(chooseSources(many, 3)).toHaveLength(3);
  });
});

/* ------------------------------------------------------------------ *
 * ResearchService.research end to end (stubbed collaborators)
 * ------------------------------------------------------------------ */

describe('ResearchService.research', () => {
  const BODY_A =
    '# Widget pipeline\n\n' +
    'The widget pipeline resolves sovereign state questions by consulting the local registry first.\n\n' +
    'A sovereign widget is registered once and the pipeline caches its resolved artefacts.\n';
  const BODY_B =
    '# Widget caching\n\n' +
    'Widget caching keeps the pipeline warm and avoids re-resolving a sovereign entry repeatedly.\n\n' +
    'The cache is keyed by the sovereign widget identifier and expires after a fixed window.\n';
  const BODY_C =
    '# Unrelated page\n\n' +
    'This page discusses gardening and has nothing at all to do with the researched subject.\n';

  const PAGES: Record<string, string> = {
    'https://one.example.com/a': BODY_A,
    'https://two.example.com/b': BODY_B,
    'https://three.example.com/c': BODY_C,
  };

  const SEARCH_RESULTS: SearchResult[] = [
    result({ url: 'https://one.example.com/a', source: 'one.example.com', score: 0.9, engines: ['bing', 'mojeek'] }),
    result({ url: 'https://two.example.com/b', source: 'two.example.com', score: 0.8 }),
    result({ url: 'https://three.example.com/c', source: 'three.example.com', score: 0.7 }),
  ];

  it('returns a numbered, quoted brief built from the fetched bodies', async () => {
    const config = testConfig();
    const searchCalls: string[] = [];
    const fetchCalls: string[] = [];
    const service = new ResearchService({
      config,
      search: stubSearch(searchCalls, SEARCH_RESULTS),
      fetch: stubFetch(PAGES, fetchCalls),
    });

    const report = await service.research('sovereign widget pipeline', { depth: 1 });

    expect(report.query).toBe('sovereign widget pipeline');
    expect(report.depth).toBe(1);
    expect(report.sources.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(report.sources.length).toBeGreaterThanOrEqual(3);
    expect(report.enginesUsed).toContain('bing');

    const first = report.sources[0]!;
    expect(first.passages.length).toBeGreaterThan(0);
    expect(first.passages[0]!.text.length).toBeGreaterThan(0);
    // The quoted passage is verbatim from the fetched body, not invented.
    expect(BODY_A).toContain(first.passages[0]!.text);
    expect(first.wordCount).toBeGreaterThan(0);

    expect(report.markdown).toContain('## 1. ');
    expect(report.markdown).toContain('> ');
    expect(report.markdown).toContain('Extractive brief');
    expect(report.markdown).toContain('## Sources at a glance');
    expect(report.markdown).toContain('sovereign');
    expect(Number.isFinite(Date.parse(report.generatedAt))).toBe(true);
  });

  it('records a per-source error instead of throwing when one fetch fails', async () => {
    const config = testConfig();
    const service = new ResearchService({
      config,
      search: stubSearch([], SEARCH_RESULTS),
      fetch: stubFetch(PAGES, [], ['https://two.example.com/b']),
    });

    const report = await service.research('sovereign widget pipeline', { depth: 1 });

    const failed = report.sources.find((s) => s.url === 'https://two.example.com/b');
    expect(failed).toBeDefined();
    expect(failed!.error).toMatch(/robots\.txt disallows/);
    expect(failed!.passages).toEqual([]);
    expect(report.sources.filter((s) => !s.error)).toHaveLength(2);
    expect(report.markdown).toContain('Could not fetch this source');
    expect(report.markdown).toContain('Sources that could not be fetched');
  });

  it('runs exactly one query at depth 1 and several at depth 2', async () => {
    const config = testConfig();
    const deepCalls: string[] = [];
    const deep = new ResearchService({
      config,
      search: stubSearch(deepCalls, SEARCH_RESULTS),
      fetch: stubFetch(PAGES, []),
    });
    const report = await deep.research('sovereign widget pipeline', { depth: 2 });

    expect(deepCalls.length).toBeGreaterThan(1);
    expect(report.queries.length).toBe(deepCalls.length);
    expect(report.queries[0]).toBe('sovereign widget pipeline');

    const shallowCalls: string[] = [];
    const shallow = new ResearchService({
      config,
      search: stubSearch(shallowCalls, SEARCH_RESULTS),
      fetch: stubFetch(PAGES, []),
    });
    const shallowReport = await shallow.research('sovereign widget pipeline', { depth: 1 });

    expect(shallowCalls).toHaveLength(1);
    expect(shallowReport.queries).toEqual(['sovereign widget pipeline']);
  });

  it('never fetches more sources than maxSources allows', async () => {
    const config = testConfig();
    const fetchCalls: string[] = [];
    const service = new ResearchService({
      config,
      search: stubSearch([], SEARCH_RESULTS),
      fetch: stubFetch(PAGES, fetchCalls),
    });

    const report = await service.research('sovereign widget pipeline', { depth: 1, maxSources: 2 });

    expect(fetchCalls).toHaveLength(2);
    expect(report.sources).toHaveLength(2);
    expect(report.sources.map((s) => s.index)).toEqual([1, 2]);
  });
});
