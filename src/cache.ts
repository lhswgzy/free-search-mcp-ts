/**
 * Local SQLite FTS5 index.
 *
 * Two things are cached, both locally and both only on this machine:
 *
 *   1. Fetched pages — so re-reading a source costs nothing and so the model
 *      can `search_index` across everything it has already read this week.
 *   2. Raw engine responses — a short-TTL cache that makes repeated queries
 *      instant and, more importantly, stops us hammering providers.
 *
 * `node:sqlite` is used rather than `better-sqlite3` on purpose: it ships with
 * Node, so the whole package stays pure JavaScript and `npx free-search-mcp`
 * never has to compile a native addon. When `node:sqlite` is unavailable the
 * cache silently degrades to an in-process LRU — nothing else changes.
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CachePageRow, CacheStats, FetchedPage, RawResult } from './types.js';
import type { Config } from './config.js';
import { createLogger } from './util/logger.js';
import { tokenize } from './util/text.js';

const log = createLogger('cache');
const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ *
 * Raw result (search) cache helpers
 * ------------------------------------------------------------------ */

/** Stable cache key for an engine+query+options tuple. */
export function searchCacheKey(engine: string, query: string, extra: Record<string, unknown> = {}): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, ' ');
  const sorted = Object.keys(extra)
    .filter((k) => extra[k] !== undefined && extra[k] !== null && extra[k] !== '')
    .sort()
    .map((k) => `${k}=${String(extra[k])}`)
    .join('&');
  return `${engine}::${normalized}${sorted ? `::${sorted}` : ''}`;
}

/**
 * Expand text for the FTS index.
 *
 * `unicode61` treats a whole CJK run as one token, which would make Chinese and
 * Japanese content unsearchable. Expanding every CJK run into its characters
 * plus overlapping bigrams fixes that while leaving Latin text untouched
 * (the `porter` stemmer then handles English morphology).
 */
export function expandForIndex(text: string): string {
  if (!text) return '';
  return text.replace(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g, (run) => {
    if (run.length === 1) return run;
    const bigrams: string[] = [run];
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2));
    return bigrams.join(' ');
  });
}

/**
 * Build an FTS5 MATCH expression from a natural-language query.
 *
 * Latin terms become prefix queries (`"proto"*` matches `protocol`); CJK runs
 * become phrases of their bigrams, which is what makes `上下文` match text
 * indexed as `上下 下文`.
 */
export function buildFtsQuery(query: string): string {
  const terms = tokenize(query);
  if (terms.length === 0) return '';
  const clauses: string[] = [];
  const cjkRun = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

  // Rebuild CJK runs from the original string so we can emit bigram phrases.
  const cjkChunks = query.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]{2,}/g) ?? [];
  for (const chunk of cjkChunks) {
    const bigrams: string[] = [];
    for (let i = 0; i < chunk.length - 1; i++) bigrams.push(chunk.slice(i, i + 2));
    if (bigrams.length) clauses.push(`"${bigrams.join(' ')}"`);
  }

  for (const term of terms) {
    if (cjkRun.test(term)) continue; // already covered by the phrase clauses
    // Escape embedded double quotes per FTS5 rules.
    const safe = term.replace(/"/g, '""');
    clauses.push(`"${safe}"*`);
  }

  return [...new Set(clauses)].join(' AND ');
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/* ------------------------------------------------------------------ *
 * In-memory fallback
 * ------------------------------------------------------------------ */

interface MemoryEntry {
  page: FetchedPage;
  fetchedAtMs: number;
}

class MemoryFallback {
  private pages = new Map<string, MemoryEntry>();
  private search = new Map<string, { payload: string; createdAt: number }>();
  private readonly maxPages = 200;

  getPage(url: string, maxAgeMs: number): FetchedPage | undefined {
    const hit = this.pages.get(url);
    if (!hit) return undefined;
    if (maxAgeMs >= 0 && Date.now() - hit.fetchedAtMs > maxAgeMs) return undefined;
    return hit.page;
  }

  putPage(page: FetchedPage): void {
    this.pages.delete(page.url);
    this.pages.set(page.url, { page, fetchedAtMs: Date.now() });
    while (this.pages.size > this.maxPages) {
      const oldest = this.pages.keys().next().value;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
  }

  getSearch(key: string, ttlMs: number): RawResult[] | undefined {
    const hit = this.search.get(key);
    if (!hit) return undefined;
    if (ttlMs >= 0 && Date.now() - hit.createdAt > ttlMs) return undefined;
    try {
      return JSON.parse(hit.payload) as RawResult[];
    } catch {
      return undefined;
    }
  }

  putSearch(key: string, results: RawResult[]): void {
    this.search.set(key, { payload: JSON.stringify(results), createdAt: Date.now() });
  }

  stats(): Pick<CacheStats, 'pages' | 'searchCacheEntries' | 'bytes' | 'oldestFetchedAt' | 'newestFetchedAt'> {
    let oldest = 0;
    let newest = 0;
    let bytes = 0;
    for (const entry of this.pages.values()) {
      if (!oldest || entry.fetchedAtMs < oldest) oldest = entry.fetchedAtMs;
      if (entry.fetchedAtMs > newest) newest = entry.fetchedAtMs;
      bytes += entry.page.content.length;
    }
    return {
      pages: this.pages.size,
      searchCacheEntries: this.search.size,
      bytes,
      oldestFetchedAt: oldest ? new Date(oldest).toISOString() : null,
      newestFetchedAt: newest ? new Date(newest).toISOString() : null,
    };
  }

  clear(kind: 'pages' | 'search' | 'all'): number {
    const n = kind === 'search' ? this.search.size : kind === 'pages' ? this.pages.size : this.pages.size + this.search.size;
    if (kind !== 'search') this.pages.clear();
    if (kind !== 'pages') this.search.clear();
    return n;
  }

  searchPages(query: string, limit: number): IndexSearchHit[] {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const out: { url: string; title: string; snippet: string; fetchedAt: string; score: number }[] = [];
    for (const entry of this.pages.values()) {
      const haystack = `${entry.page.title}\n${entry.page.content}`.toLowerCase();
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score++;
      if (!score) continue;
      const idx = haystack.indexOf(terms[0]!);
      out.push({
        url: entry.page.url,
        title: entry.page.title,
        snippet: haystack.slice(Math.max(0, idx - 80), idx + 240).replace(/\s+/g, ' ').trim(),
        fetchedAt: entry.page.fetchedAt,
        score,
      });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

/* ------------------------------------------------------------------ *
 * SQLite-backed cache
 * ------------------------------------------------------------------ */

interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteCtor = new (path: string, options?: Record<string, unknown>) => SqliteDatabase;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pages (
  url            TEXT PRIMARY KEY,
  title          TEXT NOT NULL DEFAULT '',
  markdown       TEXT NOT NULL DEFAULT '',
  search_text    TEXT NOT NULL DEFAULT '',
  content_type   TEXT NOT NULL DEFAULT '',
  status         INTEGER NOT NULL DEFAULT 200,
  word_count     INTEGER NOT NULL DEFAULT 0,
  fetched_at     INTEGER NOT NULL,
  etag           TEXT,
  last_modified  TEXT,
  byline         TEXT,
  published_at   TEXT,
  site_name      TEXT,
  language       TEXT,
  payload        TEXT
);
CREATE INDEX IF NOT EXISTS idx_pages_fetched_at ON pages(fetched_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  search_text,
  url UNINDEXED,
  content='pages',
  content_rowid='rowid',
  tokenize='porter unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, search_text, url)
  VALUES (new.rowid, new.title, new.search_text, new.url);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, search_text, url)
  VALUES ('delete', old.rowid, old.title, old.search_text, old.url);
END;
CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, search_text, url)
  VALUES ('delete', old.rowid, old.title, old.search_text, old.url);
  INSERT INTO pages_fts(rowid, title, search_text, url)
  VALUES (new.rowid, new.title, new.search_text, new.url);
END;

CREATE TABLE IF NOT EXISTS search_cache (
  cache_key  TEXT PRIMARY KEY,
  engine     TEXT NOT NULL,
  query      TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_search_cache_created ON search_cache(created_at DESC);

-- Circuit-breaker state. Persisted so that a blocked provider is remembered
-- across process restarts: an MCP server restarted by a client, or a second
-- CLI search, does not re-pay the timeout.
CREATE TABLE IF NOT EXISTS engine_health (
  engine                TEXT PRIMARY KEY,
  consecutive_failures  INTEGER NOT NULL DEFAULT 0,
  benched_until         INTEGER NOT NULL DEFAULT 0,
  last_error            TEXT,
  total_calls           INTEGER NOT NULL DEFAULT 0,
  total_failures        INTEGER NOT NULL DEFAULT 0,
  total_results         INTEGER NOT NULL DEFAULT 0,
  last_latency_ms       INTEGER,
  updated_at            INTEGER NOT NULL
);
`;

export interface IndexSearchHit {
  url: string;
  title: string;
  snippet: string;
  fetchedAt: string;
  score: number;
}

/** Shape of one persisted circuit-breaker row. */
export interface PersistedEngineHealth {
  engine: string;
  consecutiveFailures: number;
  benchedUntil: number;
  totalCalls: number;
  totalFailures: number;
  totalResults: number;
  lastError?: string;
  lastLatencyMs?: number;
}

export class PageCache {
  private db?: SqliteDatabase;
  private memory = new MemoryFallback();
  private initialized = false;
  private ftsAvailable = false;
  /** Why the SQLite backend is unavailable, surfaced by `cache_stats`/`doctor`. */
  degradedReason?: string;

  constructor(private readonly config: Config) {}

  get enabled(): boolean {
    return this.config.cacheEnabled;
  }

  get path(): string | null {
    return this.config.cacheEnabled ? this.config.cachePath : null;
  }

  /** True when the FTS5 index is live (as opposed to the LRU fallback). */
  get usingFts(): boolean {
    return this.ftsAvailable;
  }

  private init(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.config.cacheEnabled) {
      this.degradedReason = 'cache disabled by configuration';
      return;
    }
    try {
      const mod = require('node:sqlite') as { DatabaseSync: SqliteCtor };
      const dir = dirname(this.config.cachePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const db = new mod.DatabaseSync(this.config.cachePath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
      db.exec('PRAGMA busy_timeout = 4000');
      db.exec(SCHEMA);
      this.db = db;
      this.ftsAvailable = true;
    } catch (err) {
      const message = (err as Error).message || String(err);
      this.degradedReason =
        /Cannot find module|not supported|ERR_UNKNOWN_BUILTIN_MODULE/i.test(message)
          ? `node:sqlite unavailable on Node ${process.version} (needs Node >= 22.5; 24+ recommended) — falling back to an in-memory index`
          : `SQLite initialisation failed: ${message} — falling back to an in-memory index`;
      log.warn(this.degradedReason);
      this.db = undefined;
      this.ftsAvailable = false;
    }
  }

  /** Page from the index, or undefined when missing/expired. */
  getPage(url: string, maxAgeMs: number): FetchedPage | undefined {
    this.init();
    if (!this.db) return this.memory.getPage(url, maxAgeMs);
    try {
      const row = this.db
        .prepare('SELECT url, title, markdown, content_type, status, word_count, fetched_at, byline, published_at, site_name, language, payload FROM pages WHERE url = ?')
        .get(url) as CachePageRow | undefined;
      if (!row) return undefined;
      if (maxAgeMs >= 0 && Date.now() - Number(row.fetched_at) > maxAgeMs) return undefined;
      return rowToPage(row);
    } catch (err) {
      log.debug(`getPage failed: ${(err as Error).message}`);
      return this.memory.getPage(url, maxAgeMs);
    }
  }

  /** Insert or replace a page, keeping the FTS index in sync via triggers. */
  putPage(page: FetchedPage, extra: { etag?: string; lastModified?: string } = {}): void {
    this.init();
    if (!this.config.cacheEnabled) return;
    this.memory.putPage(page);
    if (!this.db) return;
    const fetchedAtMs = Date.parse(page.fetchedAt) || Date.now();
    const searchText = `${expandForIndex(page.title)}\n${expandForIndex(page.content)}`;
    const payload = JSON.stringify({
      finalUrl: page.finalUrl,
      contentFormat: page.contentFormat,
      byline: page.byline,
      publishedAt: page.publishedAt,
      excerpt: page.excerpt,
      language: page.language,
      siteName: page.siteName,
      document: page.document,
      links: page.links?.slice(0, 200),
      warnings: page.warnings,
    });
    try {
      this.db
        .prepare(
          `INSERT INTO pages (url, title, markdown, search_text, content_type, status, word_count, fetched_at, etag, last_modified, byline, published_at, site_name, language, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(url) DO UPDATE SET
             title = excluded.title,
             markdown = excluded.markdown,
             search_text = excluded.search_text,
             content_type = excluded.content_type,
             status = excluded.status,
             word_count = excluded.word_count,
             fetched_at = excluded.fetched_at,
             etag = excluded.etag,
             last_modified = excluded.last_modified,
             byline = excluded.byline,
             published_at = excluded.published_at,
             site_name = excluded.site_name,
             language = excluded.language,
             payload = excluded.payload`,
        )
        .run(
          page.url,
          page.title ?? '',
          page.content ?? '',
          searchText,
          page.contentType ?? '',
          page.status ?? 200,
          page.wordCount ?? 0,
          fetchedAtMs,
          extra.etag ?? null,
          extra.lastModified ?? null,
          page.byline ?? null,
          page.publishedAt ?? null,
          page.siteName ?? null,
          page.language ?? null,
          payload,
        );
    } catch (err) {
      log.debug(`putPage failed: ${(err as Error).message}`);
    }
  }

  /** Full-text search across every page read so far. */
  searchPages(query: string, limit = 10): IndexSearchHit[] {
    this.init();
    const match = buildFtsQuery(query);
    if (!this.db || !match) return this.memory.searchPages(query, limit);
    try {
      const rows = this.db
        .prepare(
          `SELECT p.url AS url,
                  p.title AS title,
                  p.fetched_at AS fetched_at,
                  bm25(pages_fts, 4.0, 1.0) AS score,
                  snippet(pages_fts, 1, '«', '»', ' … ', 18) AS snippet
             FROM pages_fts
             JOIN pages p ON p.rowid = pages_fts.rowid
            WHERE pages_fts MATCH ?
            ORDER BY score
            LIMIT ?`,
        )
        .all(match, limit) as { url: string; title: string; fetched_at: number; score: number; snippet: string }[];
      return rows.map((r) => ({
        url: r.url,
        title: r.title,
        snippet: (r.snippet || '').replace(/\s+/g, ' ').trim(),
        // bm25() returns a negative number where more negative is better.
        score: Number((-Number(r.score)).toFixed(4)),
        fetchedAt: new Date(Number(r.fetched_at)).toISOString(),
      }));
    } catch (err) {
      log.debug(`searchPages failed: ${(err as Error).message}`);
      return this.memory.searchPages(query, limit);
    }
  }

  getSearchResults(key: string, ttlMs: number): RawResult[] | undefined {
    this.init();
    if (!this.config.cacheEnabled || ttlMs <= 0) return undefined;
    if (!this.db) return this.memory.getSearch(key, ttlMs);
    try {
      const row = this.db.prepare('SELECT payload, created_at FROM search_cache WHERE cache_key = ?').get(key) as
        | { payload: string; created_at: number }
        | undefined;
      if (!row) return undefined;
      if (Date.now() - Number(row.created_at) > ttlMs) return undefined;
      return JSON.parse(row.payload) as RawResult[];
    } catch {
      return undefined;
    }
  }

  putSearchResults(key: string, engine: string, query: string, results: RawResult[]): void {
    this.init();
    if (!this.config.cacheEnabled || this.config.searchCacheTtlMs <= 0) return;
    this.memory.putSearch(key, results);
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO search_cache (cache_key, engine, query, payload, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
        )
        .run(key, engine, query, JSON.stringify(results), Date.now());
    } catch (err) {
      log.debug(`putSearchResults failed: ${(err as Error).message}`);
    }
  }

  stats(): CacheStats {
    this.init();
    if (!this.db) {
      return {
        enabled: this.config.cacheEnabled,
        path: this.path,
        fts5: false,
        ...this.memory.stats(),
      };
    }
    try {
      const pages = Number((this.db.prepare('SELECT COUNT(*) AS n FROM pages').get() as { n: number }).n);
      const search = Number((this.db.prepare('SELECT COUNT(*) AS n FROM search_cache').get() as { n: number }).n);
      const range = this.db.prepare('SELECT MIN(fetched_at) AS lo, MAX(fetched_at) AS hi FROM pages').get() as {
        lo: number | null;
        hi: number | null;
      };
      let bytes = 0;
      try {
        bytes = statSync(this.config.cachePath).size;
      } catch {
        bytes = 0;
      }
      return {
        enabled: this.config.cacheEnabled,
        path: this.path,
        pages,
        searchCacheEntries: search,
        bytes,
        oldestFetchedAt: range.lo ? new Date(Number(range.lo)).toISOString() : null,
        newestFetchedAt: range.hi ? new Date(Number(range.hi)).toISOString() : null,
        fts5: true,
      };
    } catch (err) {
      log.debug(`stats failed: ${(err as Error).message}`);
      return { enabled: this.config.cacheEnabled, path: this.path, fts5: false, ...this.memory.stats() };
    }
  }

  /** Delete cached rows. Returns the number of rows removed. */
  clear(kind: 'pages' | 'search' | 'all' = 'all'): number {
    this.init();
    const memoryCleared = this.memory.clear(kind);
    if (!this.db) return memoryCleared;
    let removed = 0;
    try {
      if (kind === 'pages' || kind === 'all') {
        removed += Number(this.db.prepare('DELETE FROM pages').run().changes);
      }
      if (kind === 'search' || kind === 'all') {
        removed += Number(this.db.prepare('DELETE FROM search_cache').run().changes);
      }
      if (kind === 'pages' || kind === 'all') {
        // External-content FTS tables need an explicit rebuild after bulk deletes.
        this.db.exec("INSERT INTO pages_fts(pages_fts) VALUES('rebuild')");
      }
    } catch (err) {
      log.debug(`clear failed: ${(err as Error).message}`);
    }
    return removed;
  }

  /** Drop pages older than `maxAgeMs`, then trim to `maxRows` newest rows. */
  prune(options: { maxAgeMs?: number; maxRows?: number } = {}): number {
    this.init();
    if (!this.db) return 0;
    let removed = 0;
    try {
      if (options.maxAgeMs && options.maxAgeMs > 0) {
        const cutoff = Date.now() - options.maxAgeMs;
        removed += Number(this.db.prepare('DELETE FROM pages WHERE fetched_at < ?').run(cutoff).changes);
      }
      if (options.maxRows && options.maxRows > 0) {
        removed += Number(
          this.db
            .prepare(
              `DELETE FROM pages WHERE rowid NOT IN (
                 SELECT rowid FROM pages ORDER BY fetched_at DESC LIMIT ?
               )`,
            )
            .run(options.maxRows).changes,
        );
      }
      const searchCutoff = Date.now() - Math.max(this.config.searchCacheTtlMs, 3_600_000);
      this.db.prepare('DELETE FROM search_cache WHERE created_at < ?').run(searchCutoff);
    } catch (err) {
      log.debug(`prune failed: ${(err as Error).message}`);
    }
    return removed;
  }

  vacuum(): void {
    this.init();
    if (!this.db) return;
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      log.debug(`vacuum failed: ${(err as Error).message}`);
    }
  }

  /**
   * Read the persisted circuit-breaker state.
   *
   * Rows whose bench window has already expired are returned with
   * `consecutiveFailures` reset, so the engine is retried once rather than
   * staying benched forever on the strength of an old failure.
   */
  loadEngineHealth(): PersistedEngineHealth[] {
    this.init();
    if (!this.db) return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT engine, consecutive_failures, benched_until, last_error, total_calls,
                  total_failures, total_results, last_latency_ms
             FROM engine_health`,
        )
        .all() as {
        engine: string;
        consecutive_failures: number;
        benched_until: number;
        last_error: string | null;
        total_calls: number;
        total_failures: number;
        total_results: number;
        last_latency_ms: number | null;
      }[];
      const now = Date.now();
      return rows.map((row) => {
        const benchedUntil = Number(row.benched_until) || 0;
        const expired = benchedUntil <= now;
        return {
          engine: row.engine,
          consecutiveFailures: expired ? 0 : Number(row.consecutive_failures) || 0,
          benchedUntil: expired ? 0 : benchedUntil,
          totalCalls: Number(row.total_calls) || 0,
          totalFailures: Number(row.total_failures) || 0,
          totalResults: Number(row.total_results) || 0,
          ...(row.last_error ? { lastError: row.last_error } : {}),
          ...(row.last_latency_ms !== null ? { lastLatencyMs: Number(row.last_latency_ms) } : {}),
        };
      });
    } catch (err) {
      log.debug(`loadEngineHealth failed: ${(err as Error).message}`);
      return [];
    }
  }

  /** Persist circuit-breaker state. Written on every change; rows are tiny. */
  saveEngineHealth(records: readonly PersistedEngineHealth[]): void {
    this.init();
    if (!this.db || records.length === 0) return;
    try {
      const statement = this.db.prepare(
        `INSERT INTO engine_health (engine, consecutive_failures, benched_until, last_error, total_calls, total_failures, total_results, last_latency_ms, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(engine) DO UPDATE SET
           consecutive_failures = excluded.consecutive_failures,
           benched_until        = excluded.benched_until,
           last_error           = excluded.last_error,
           total_calls          = excluded.total_calls,
           total_failures       = excluded.total_failures,
           total_results        = excluded.total_results,
           last_latency_ms      = excluded.last_latency_ms,
           updated_at           = excluded.updated_at`,
      );
      const now = Date.now();
      for (const record of records) {
        statement.run(
          record.engine,
          record.consecutiveFailures,
          record.benchedUntil,
          record.lastError ?? null,
          record.totalCalls,
          record.totalFailures,
          record.totalResults,
          record.lastLatencyMs ?? null,
          now,
        );
      }
    } catch (err) {
      log.debug(`saveEngineHealth failed: ${(err as Error).message}`);
    }
  }

  /** Forget breaker state, so the next search retries every engine. */
  clearEngineHealth(): void {
    this.init();
    if (!this.db) return;
    try {
      this.db.prepare('DELETE FROM engine_health').run();
    } catch (err) {
      log.debug(`clearEngineHealth failed: ${(err as Error).message}`);
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      /* ignore */
    }
    this.db = undefined;
    this.initialized = false;
    this.ftsAvailable = false;
  }
}

function rowToPage(row: CachePageRow): FetchedPage {
  let payload: Record<string, unknown> = {};
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }
  return {
    url: row.url,
    finalUrl: (payload.finalUrl as string) || row.url,
    title: row.title,
    content: row.markdown,
    contentFormat: (payload.contentFormat as FetchedPage['contentFormat']) || 'markdown',
    contentType: row.content_type,
    status: Number(row.status),
    fetchedAt: new Date(Number(row.fetched_at)).toISOString(),
    wordCount: Number(row.word_count),
    cached: true,
    ...(row.byline ? { byline: row.byline } : {}),
    ...(row.published_at ? { publishedAt: row.published_at } : {}),
    ...(row.site_name ? { siteName: row.site_name } : {}),
    ...(row.language ? { language: row.language } : {}),
    ...(payload.excerpt ? { excerpt: payload.excerpt as string } : {}),
    ...(payload.document ? { document: payload.document as FetchedPage['document'] } : {}),
    ...(payload.links ? { links: payload.links as FetchedPage['links'] } : {}),
    ...(payload.warnings ? { warnings: payload.warnings as string[] } : {}),
  };
}

let sharedCache: PageCache | undefined;
let sharedCachePath: string | undefined;

/** Process-wide cache instance (one SQLite handle per process is plenty). */
export function getCache(config: Config): PageCache {
  if (!sharedCache || sharedCachePath !== config.cachePath) {
    sharedCache?.close();
    sharedCache = new PageCache(config);
    sharedCachePath = config.cachePath;
  }
  return sharedCache;
}

export function closeCache(): void {
  sharedCache?.close();
  sharedCache = undefined;
  sharedCachePath = undefined;
}

export { escapeLike };
