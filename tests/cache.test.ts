import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PageCache, buildFtsQuery, expandForIndex, searchCacheKey } from '../src/cache.js';
import { loadConfig } from '../src/config.js';
import type { Config } from '../src/config.js';
import type { FetchedPage, RawResult } from '../src/types.js';

const require = createRequire(import.meta.url);

/**
 * `node:sqlite` ships with Node, but older runtimes do not have it and the cache
 * then degrades to an in-memory LRU. The SQLite-specific expectations are
 * skipped there; the pure helpers below run everywhere.
 */
const sqliteAvailable = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

/** Fixed timestamps: nothing here may depend on the machine clock. */
const OLD = '2000-01-01T00:00:00.000Z';
const FETCHED_AT = '2024-03-01T10:00:00.000Z';

function page(url: string, title: string, content: string, fetchedAt = OLD): FetchedPage {
  return {
    url,
    finalUrl: url,
    title,
    content,
    contentFormat: 'text',
    contentType: 'text/html; charset=utf-8',
    status: 200,
    fetchedAt,
    wordCount: content.split(/\s+/).length,
    cached: false,
  };
}

let dir: string;
let config: Config;
let cache: PageCache;

/**
 * Unrelated pages used by the ranking tests. bm25 weights a term by how rare it
 * is in the whole corpus, so on a two-document index every score rounds to zero
 * and an ordering assertion would be measuring nothing.
 */
const FILLER: [string, string, string][] = [
  ['https://example.com/f1', 'Cast iron notes', 'Cooking with cast iron requires patience and a good pan.'],
  ['https://example.com/f2', 'Sourdough notes', 'Sourdough needs a starter, flour, water and time to rise.'],
  ['https://example.com/f3', 'Bike notes', 'A bicycle chain needs oil and the brakes need adjusting.'],
];

function seedFillers(): void {
  for (const [url, title, content] of FILLER) cache.putPage(page(url, title, content));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fsmcp-cache-'));
  // A PageCache is built on an explicit Config rather than getCache() so that
  // every test gets its own database file and nothing leaks between tests.
  config = loadConfig({
    dataDir: dir,
    skipDotEnv: true,
    overrides: { proxy: undefined, cacheEnabled: true, searchCacheTtlMs: 15 * 60 * 1000, logLevel: 'silent' },
  });
  cache = new PageCache(config);
});

afterEach(() => {
  // Close before deleting: Windows keeps the SQLite files locked otherwise.
  cache.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('pure cache helpers', () => {
  it('expands a CJK run into its characters plus overlapping bigrams', () => {
    expect(expandForIndex('模型上下文协议')).toBe('模型上下文协议 模型 型上 上下 下文 文协 协议');
    // Latin text is left for the porter stemmer to handle.
    expect(expandForIndex('Hello world')).toBe('Hello world');
    expect(expandForIndex('FTS5 上下文 search')).toBe('FTS5 上下文 上下 下文 search');
    expect(expandForIndex('中')).toBe('中');
    expect(expandForIndex('')).toBe('');
  });

  it('builds an FTS5 MATCH expression with prefixed Latin terms and CJK bigram phrases', () => {
    expect(buildFtsQuery('sqlite fts5')).toBe('"sqlite"* AND "fts5"*');
    // The phrase of bigrams is what lets 上下文 match a page indexed as 模型上下文协议.
    expect(buildFtsQuery('上下文')).toBe('"上下 下文"');
    expect(buildFtsQuery('')).toBe('');
    // A query of nothing but stopwords has no terms at all.
    expect(buildFtsQuery('the and of')).toBe('');
  });

  it('cannot be used to inject FTS5 syntax through a quoted query', () => {
    // Quotes never survive tokenisation, and the injected OR is a stopword, so
    // the expression stays balanced and behaves as a conjunction.
    expect(buildFtsQuery('foo" OR "bar')).toBe('"foo"* AND "bar"*');
    expect((buildFtsQuery('say "hello" world').match(/"/g) ?? []).length % 2).toBe(0);
  });

  it('builds a stable search cache key that ignores option ordering', () => {
    const a = searchCacheKey('brave', ' Rust  vs  Go ', { limit: 10, safeSearch: 'off' });
    expect(a).toBe('brave::rust vs go::limit=10&safeSearch=off');
    expect(searchCacheKey('brave', 'rust vs go', { safeSearch: 'off', limit: 10 })).toBe(a);
    // Unset options must not appear, otherwise the same request gets two keys.
    expect(searchCacheKey('brave', 'q', { a: undefined, b: null, c: '', d: 1 })).toBe('brave::q::d=1');
    expect(searchCacheKey('brave', 'q')).toBe('brave::q');
    expect(searchCacheKey('mojeek', 'q')).not.toBe(searchCacheKey('brave', 'q'));
  });
});

describe('PageCache', () => {
  it('reports FTS5 as live on this machine, so an LRU degradation cannot pass silently', () => {
    const stats = cache.stats();
    expect(stats.enabled).toBe(true);
    expect(stats.path).toBe(config.cachePath);
    expect(cache.usingFts).toBe(true);
    expect(cache.degradedReason).toBeUndefined();
    expect(stats.fts5).toBe(true);
  });

  describe.skipIf(!sqliteAvailable)('SQLite backend', () => {
    it('round-trips a page through putPage/getPage, including the JSON payload fields', () => {
      const stored: FetchedPage = {
        ...page('https://example.com/doc', 'Local full text search', 'The quick brown fox jumps over the lazy dog.', FETCHED_AT),
        finalUrl: 'https://www.example.com/doc',
        byline: 'Ada Lovelace',
        publishedAt: '2024-02-29T00:00:00.000Z',
        excerpt: 'A short excerpt.',
        language: 'en',
        siteName: 'Example Docs',
        links: [{ text: 'Next', url: 'https://example.com/next' }],
        document: { kind: 'pdf', pages: 3, chars: 1234 },
        warnings: ['conversion degraded'],
      };
      cache.putPage(stored, { etag: 'W/"abc"', lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT' });

      // The stored timestamp is in the past, so a huge TTL is how this test says
      // "do not apply the age check"; the check itself is covered below.
      const hit = cache.getPage(stored.url, Number.MAX_SAFE_INTEGER);
      expect(hit).toEqual({ ...stored, cached: true });
      expect(hit!.fetchedAt).toBe(FETCHED_AT);
      expect(cache.getPage('https://example.com/never-stored', Number.MAX_SAFE_INTEGER)).toBeUndefined();

      // TTL expiry: one second of freshness cannot cover a page fetched in 2024.
      expect(cache.getPage(stored.url, 1_000)).toBeUndefined();

      const stats = cache.stats();
      expect(stats.pages).toBe(1);
      expect(stats.searchCacheEntries).toBe(0);
      expect(stats.oldestFetchedAt).toBe(FETCHED_AT);
      expect(stats.newestFetchedAt).toBe(FETCHED_AT);
      expect(stats.bytes).toBeGreaterThan(0); // the database header is on disk
    });

    it('refreshes an existing row in place and keeps the FTS index in sync', () => {
      const url = 'https://example.com/reindex';
      cache.putPage(page(url, 'Kangaroo facts', 'Kangaroo content about marsupials.'));
      expect(cache.searchPages('kangaroo')).toHaveLength(1);

      cache.putPage(page(url, 'Zebra facts', 'Zebra content about stripes.'));
      expect(cache.stats().pages).toBe(1); // an update, not a second row
      expect(cache.getPage(url, Number.MAX_SAFE_INTEGER)!.title).toBe('Zebra facts');
      // The update trigger must remove the old index entries, otherwise a stale
      // page keeps showing up in search results forever.
      expect(cache.searchPages('kangaroo')).toEqual([]);
      expect(cache.searchPages('zebra')).toHaveLength(1);
    });

    it('finds a Latin word by prefix and a CJK phrase through bigrams', () => {
      cache.putPage(page('https://example.com/protocol', 'Protocol notes', 'The protocol for the model context is documented here.'));
      cache.putPage(page('https://example.com/cjk', '模型上下文协议', '模型上下文协议是给模型用的标准。'));
      seedFillers();

      const prefix = cache.searchPages('proto');
      expect(prefix.map((h) => h.url)).toEqual(['https://example.com/protocol']);
      expect(prefix[0]!.fetchedAt).toBe(OLD);
      expect(prefix[0]!.score).toBeGreaterThan(0);

      // The key feature: a Chinese query must find a page whose text was indexed
      // as one long unicode61 token, which only works because the index stores
      // the bigrams and the query is a phrase of them.
      const cjk = cache.searchPages('上下文');
      expect(cjk.map((h) => h.url)).toEqual(['https://example.com/cjk']);
      expect(cjk[0]!.snippet).toContain('«上下 下文»');
      // Snippet markers are what make the match visible in the Markdown output.
      expect(prefix[0]!.snippet.toLowerCase()).toContain('«proto');
      expect(cjk[0]!.snippet).toContain('»');
    });

    it('orders results by bm25, best match first', () => {
      seedFillers();
      cache.putPage(page('https://example.com/a', 'quokka quokka habits', 'quokka'));
      cache.putPage(
        page(
          'https://example.com/b',
          'Unrelated title',
          'The quokka appears once in a long body about many other things that have nothing to do with it, padding padding padding.',
        ),
      );
      const hits = cache.searchPages('quokka');
      expect(hits.map((h) => h.url)).toEqual(['https://example.com/a', 'https://example.com/b']);
      // The title column is weighted 4x in the bm25() call, and the shorter
      // document wins as well; both effects must point the same way here.
      expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
    });

    it('reports a positive score even on a tiny index', () => {
      // Regression: bm25 on a two-document corpus returns roughly -1e-6, and
      // rounding the flipped value with toFixed(4) produced `-0`, so a genuine
      // match reported a score of exactly zero and looked broken. No filler
      // pages here on purpose — that is the whole point of the case.
      cache.putPage(page('https://example.com/tiny', 'Tiny index', 'A single document about quokkas.'));
      const hits = cache.searchPages('quokka');
      expect(hits).toHaveLength(1);
      expect(hits[0]!.score).toBeGreaterThan(0);
      expect(Number.isFinite(hits[0]!.score)).toBe(true);
      // Zero stays zero rather than becoming -0, so callers can compare safely.
      expect(Object.is(hits[0]!.score, -0)).toBe(false);
    });

    it('limits the number of search hits', () => {
      cache.putPage(page('https://example.com/one', 'quokka one', 'quokka'));
      cache.putPage(page('https://example.com/two', 'quokka two', 'quokka'));
      expect(cache.searchPages('quokka', 1)).toHaveLength(1);
    });

    it('returns nothing for a query with no searchable terms instead of throwing', () => {
      cache.putPage(page('https://example.com/doc', 'Doc', 'Body text.'));
      expect(cache.searchPages('the')).toEqual([]);
      expect(cache.searchPages('')).toEqual([]);
      // A quoted query must not escape into FTS5 syntax.
      expect(cache.searchPages('quoted "term"')).toEqual([]);
    });

    it('clears pages, engine responses or both, and stops matching afterwards', () => {
      const results: RawResult[] = [{ title: 'Doc', url: 'https://example.com/doc', snippet: 'hello' }];
      cache.putPage(page('https://example.com/clearme', 'clearme', 'clearme body'));
      cache.putSearchResults(searchCacheKey('brave', 'q'), 'brave', 'q', results);
      expect(cache.searchPages('clearme')).toHaveLength(1);
      expect(cache.getSearchResults(searchCacheKey('brave', 'q'), 60_000)).toEqual(results);

      expect(cache.clear('search')).toBe(1);
      expect(cache.getSearchResults(searchCacheKey('brave', 'q'), 60_000)).toBeUndefined();
      expect(cache.searchPages('clearme')).toHaveLength(1); // pages are untouched

      expect(cache.clear('pages')).toBe(1);
      // The external-content FTS table is rebuilt, so the index no longer
      // matches even though the row is gone.
      expect(cache.searchPages('clearme')).toEqual([]);
      expect(cache.stats().pages).toBe(0);

      cache.putPage(page('https://example.com/again', 'again', 'again body'));
      cache.putSearchResults(searchCacheKey('brave', 'q2'), 'brave', 'q2', results);
      expect(cache.clear('all')).toBe(2);
      expect(cache.stats().pages).toBe(0);
      expect(cache.stats().searchCacheEntries).toBe(0);
    });

    it('prunes pages by age and then trims to the newest maxRows', () => {
      cache.putPage(page('https://example.com/p1', 'one', 'one', '2000-01-01T00:00:00.000Z'));
      cache.putPage(page('https://example.com/p2', 'two', 'two', '2000-01-02T00:00:00.000Z'));
      cache.putPage(page('https://example.com/p3', 'three', 'three', '2000-01-03T00:00:00.000Z'));

      // Anything older than a second is gone; the timestamps are ancient on
      // purpose so this holds whatever the wall clock says.
      expect(cache.prune({ maxAgeMs: 1_000 })).toBe(3);
      expect(cache.stats().pages).toBe(0);
      expect(cache.stats().oldestFetchedAt).toBeNull();

      cache.putPage(page('https://example.com/p1', 'one', 'one', '2000-02-01T00:00:00.000Z'));
      cache.putPage(page('https://example.com/p2', 'two', 'two', '2000-02-02T00:00:00.000Z'));
      cache.putPage(page('https://example.com/p3', 'three', 'three', '2000-02-03T00:00:00.000Z'));
      expect(cache.prune({ maxRows: 2 })).toBe(1);

      const stats = cache.stats();
      expect(stats.pages).toBe(2);
      expect(stats.oldestFetchedAt).toBe('2000-02-02T00:00:00.000Z');
      expect(stats.newestFetchedAt).toBe('2000-02-03T00:00:00.000Z');
    });

    it('stores raw engine responses under a TTL', () => {
      const results: RawResult[] = [{ title: 'Doc', url: 'https://example.com/doc', snippet: 'hello' }];
      cache.putSearchResults(searchCacheKey('brave', 'sqlite cache'), 'brave', 'sqlite cache', results);

      expect(cache.getSearchResults(searchCacheKey('brave', 'sqlite cache'), 60_000)).toEqual(results);
      expect(cache.getSearchResults('never-written', 60_000)).toBeUndefined();
      // A non-positive TTL disables reads entirely.
      expect(cache.getSearchResults(searchCacheKey('brave', 'sqlite cache'), 0)).toBeUndefined();
      expect(cache.stats().searchCacheEntries).toBe(1);
    });

    it('persists circuit-breaker state and retries an engine whose bench window expired', () => {
      expect(cache.loadEngineHealth()).toEqual([]);

      const liveUntil = Date.parse('2100-01-01T00:00:00.000Z'); // fixed, always in the future
      cache.saveEngineHealth([
        { engine: 'mojeek', consecutiveFailures: 5, benchedUntil: 1, totalCalls: 2, totalFailures: 5, totalResults: 0, lastError: 'blocked' },
        {
          engine: 'duckduckgo',
          consecutiveFailures: 3,
          benchedUntil: liveUntil,
          totalCalls: 9,
          totalFailures: 3,
          totalResults: 40,
          lastLatencyMs: 321,
        },
      ]);

      const loaded = cache.loadEngineHealth();
      const mojeek = loaded.find((h) => h.engine === 'mojeek')!;
      const duckduckgo = loaded.find((h) => h.engine === 'duckduckgo')!;

      // An expired bench must come back cleared, otherwise a single old failure
      // keeps an engine out of the pool for the lifetime of the database.
      expect(mojeek.consecutiveFailures).toBe(0);
      expect(mojeek.benchedUntil).toBe(0);
      expect(mojeek.lastError).toBe('blocked'); // the history is kept, only the breaker resets
      expect(mojeek.totalFailures).toBe(5);

      // A live bench is preserved so the next search still skips the engine.
      expect(duckduckgo.consecutiveFailures).toBe(3);
      expect(duckduckgo.benchedUntil).toBe(liveUntil);
      expect(duckduckgo.totalCalls).toBe(9);
      expect(duckduckgo.totalResults).toBe(40);
      expect(duckduckgo.lastLatencyMs).toBe(321);

      // Writing the same engine again updates in place.
      cache.saveEngineHealth([
        { engine: 'mojeek', consecutiveFailures: 1, benchedUntil: 0, totalCalls: 3, totalFailures: 6, totalResults: 2 },
      ]);
      const updated = cache.loadEngineHealth().filter((h) => h.engine === 'mojeek');
      expect(updated).toHaveLength(1);
      expect(updated[0]!.totalCalls).toBe(3);
      // The cleared latency is cleared rather than kept from the previous write.
      expect(updated[0]!.lastLatencyMs).toBeUndefined();

      cache.saveEngineHealth([]); // a no-op, not a crash
      expect(cache.loadEngineHealth()).toHaveLength(2);

      cache.clearEngineHealth();
      expect(cache.loadEngineHealth()).toEqual([]);
    });
  });
});
