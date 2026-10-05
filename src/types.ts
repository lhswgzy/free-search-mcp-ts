/**
 * Shared type definitions for free-search-mcp-ts.
 *
 * Everything here is transport-agnostic: engines, the fusion layer, the cache
 * and the tool handlers all speak these shapes so that any of them can be
 * swapped or unit-tested in isolation.
 */

/** A single raw result as returned by one engine, before fusion. */
export interface RawResult {
  title: string;
  url: string;
  snippet?: string;
  /** ISO-8601 date when the engine reports one (news engines mostly). */
  publishedAt?: string;
  /** Engine-specific extras that survive fusion (e.g. stars, points, authors). */
  meta?: Record<string, unknown>;
}

/** A fused result after RRF merge + dedupe. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Registrable-ish domain used for display and diversity scoring. */
  source: string;
  /** Every engine that surfaced this URL, in descending contribution order. */
  engines: string[];
  /** Best (lowest) 1-based rank this URL achieved within any single engine. */
  bestRank: number;
  /** Fused RRF score; higher is better. */
  score: number;
  publishedAt?: string;
  meta?: Record<string, unknown>;
}

/** Per-engine fused contribution, useful for debugging and for `json` output. */
export interface EngineContribution {
  engine: string;
  rank: number;
  score: number;
}

export type EngineKind = 'html' | 'api' | 'news';

export interface EngineSearchOptions {
  /** Requested max results from this engine (engines may return fewer). */
  limit: number;
  /** BCP-47-ish language hint, e.g. `en`, `zh`. */
  language?: string;
  /** Region hint, e.g. `us`, `cn`, `global`. */
  region?: string;
  /** Freshness window. Engines that cannot express it ignore it. */
  freshness?: Freshness;
  /** Safe-search level. */
  safeSearch?: SafeSearchLevel;
  /** Per-request timeout budget, already clipped to the overall deadline. */
  timeoutMs?: number;
  /** Unix-ms deadline shared by the whole search call. */
  deadline?: number;
  signal?: AbortSignal;
}

export type Freshness = 'day' | 'week' | 'month' | 'year';
export type SafeSearchLevel = 'off' | 'moderate' | 'strict';

export interface SearchEngine {
  /** Stable id used in config, CLI and tool arguments, e.g. `duckduckgo`. */
  readonly id: string;
  /** Human label for `list_engines` and Markdown output. */
  readonly label: string;
  readonly kind: EngineKind;
  /** True when the engine needs an API key to work. */
  readonly requiresKey: boolean;
  /** Env var that supplies the key, when `requiresKey` is true. */
  readonly keyEnv?: string;
  /** Where a user can obtain a key. */
  readonly keyUrl?: string;
  readonly homepage?: string;
  /** Regions this engine is especially good at: `global`, `cn`, `en`, ... */
  readonly regions?: string[];
  /** Transport layer this engine talks to; used only for docs/doctor output. */
  readonly transport?: 'http' | 'browser';
  /** Short explanation shown by `list_engines`. */
  readonly note?: string;
  search(query: string, options: EngineSearchOptions): Promise<RawResult[]>;
}

/** Shape of a fetched + converted page. */
export interface FetchedPage {
  /** URL that was requested. */
  url: string;
  /** URL after redirects. */
  finalUrl: string;
  title: string;
  /** Markdown (default) or plain text body. */
  content: string;
  /** `markdown` | `text` | `html` | `json` */
  contentFormat: 'markdown' | 'text' | 'html' | 'json';
  contentType: string;
  status: number;
  /** ISO-8601 fetch time (of the original fetch when served from cache). */
  fetchedAt: string;
  wordCount: number;
  /** True when served from the local SQLite index. */
  cached: boolean;
  /** True when the stored copy was older than the TTL and refreshed. */
  stale?: boolean;
  byline?: string;
  publishedAt?: string;
  excerpt?: string;
  language?: string;
  siteName?: string;
  /** Outgoing links found in the body (useful for agentic crawling). */
  links?: { text: string; url: string }[];
  /** Document metadata for non-HTML payloads (pages, sheets, slides...). */
  document?: DocumentInfo;
  /** Set when the payload was truncated to honour `maxChars`. */
  truncated?: boolean;
  /** Next offset to pass to fetch when `truncated` is true. */
  nextOffset?: number;
  /** Non-fatal problems (robots skipped, conversion degraded, ...). */
  warnings?: string[];
}

export interface DocumentInfo {
  kind: 'pdf' | 'docx' | 'xlsx' | 'pptx' | 'epub' | 'odt' | 'csv' | 'text' | 'json' | 'html' | 'unknown';
  pages?: number;
  sheets?: { name: string; rows: number; cols: number }[];
  slides?: number;
  /** Total characters of extracted text before truncation. */
  chars: number;
}

/** A passage chosen from a fetched page to support a research brief. */
export interface ScoredPassage {
  text: string;
  score: number;
  /** 1-based character offset of the passage in the source content. */
  offset: number;
}

export interface ResearchSource {
  index: number;
  title: string;
  url: string;
  source: string;
  engines: string[];
  score: number;
  wordCount: number;
  cached: boolean;
  passages: ScoredPassage[];
  error?: string;
  publishedAt?: string;
}

export interface ResearchReport {
  query: string;
  generatedAt: string;
  depth: number;
  /** Queries actually executed (the original plus any expansions). */
  queries: string[];
  enginesUsed: string[];
  enginesFailed: { engine: string; error: string }[];
  sources: ResearchSource[];
  /** Markdown brief with numbered citations. */
  markdown: string;
  elapsedMs: number;
}

export interface CachePageRow {
  url: string;
  title: string;
  markdown: string;
  content_type: string;
  status: number;
  word_count: number;
  fetched_at: number;
  etag: string | null;
  last_modified: string | null;
  byline: string | null;
  published_at: string | null;
  site_name: string | null;
  language: string | null;
  /**
   * Stored JSON blob with the rest of the FetchedPage fields, so a cache hit
   * can be rehydrated exactly as it was first returned.
   */
  payload: string | null;
}

export interface CacheStats {
  enabled: boolean;
  path: string | null;
  pages: number;
  searchCacheEntries: number;
  bytes: number;
  oldestFetchedAt: string | null;
  newestFetchedAt: string | null;
  fts5: boolean;
}

export interface EngineHealth {
  engine: string;
  ok: boolean;
  latencyMs: number;
  results: number;
  error?: string;
  /** True when the engine was skipped because of an open circuit breaker. */
  skipped?: boolean;
}
