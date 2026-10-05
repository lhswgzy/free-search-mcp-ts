/**
 * The search orchestrator.
 *
 * This is where the "multiple engines" promise is actually kept:
 *
 *   - **Tiered escalation.** The documented keyless defaults (DuckDuckGo,
 *     Mojeek, Google News) run first. Only if they return too little do the
 *     fallback engines run, then the subject indexes that match the query.
 *     A query that the primary tier answers costs two or three requests; a
 *     query on a network that blocks those providers still succeeds.
 *   - **Circuit breaking.** Engines that fail or get blocked are benched, so a
 *     censored or unavailable provider is not re-tried on every call.
 *   - **RRF fusion.** Every engine's list is fused with reciprocal rank fusion
 *     at `src/rrf.ts`, which needs no score calibration between providers.
 *   - **Redirect unwrapping.** Baidu, Sogou and 360 return `/link?url=`
 *     wrappers; those are resolved to the real destination so that dedupe
 *     works across engines and the model gets a URL it can cite.
 *   - **Two caches.** Raw engine responses (short TTL) and fetched pages
 *     (longer TTL) both live in the local SQLite index.
 */

import type { Config } from './config.js';
import type { HttpClient } from './http.js';
import { mapConcurrent } from './http.js';
import type { EngineHealth, EngineSearchOptions, Freshness, RawResult, SafeSearchLevel, SearchResult } from './types.js';
import { createHttpClient, BlockedUrlError } from './http.js';
import { getCache, searchCacheKey } from './cache.js';
import { EngineHealthTracker } from './engines/health.js';
import {
  ENGINE_IDS,
  getDefinition,
  isConfigured,
  resolveEngines,
  suggestApiEngines,
  type EngineContext,
  type ResolvedEngine,
} from './engines/registry.js';
import { fuseResults, contributionsByEngine } from './rrf.js';
import { normalizeUrl, hostMatches, extractWrapperTarget } from './util/url.js';
import { hasCJK } from './util/text.js';
import { createLogger } from './util/logger.js';

const log = createLogger('search');

export interface SearchOptions {
  /** Explicit engine ids. When omitted, tiered auto-selection is used. */
  engines?: string[];
  /** Use every configured engine (same as `engines: 'all'`). */
  all?: boolean;
  limit?: number;
  language?: string;
  region?: string;
  freshness?: Freshness;
  safeSearch?: SafeSearchLevel;
  /** Restrict results to these domains (host suffix match). */
  includeDomains?: string[];
  /** Drop results from these domains. */
  excludeDomains?: string[];
  /** Convenience alias for `includeDomains`. */
  site?: string;
  /** Maximum results per engine before fusion. */
  perEngine?: number;
  /** Bypass the raw-response cache. */
  noCache?: boolean;
  /** Resolve Baidu/Sogou/360 style redirect wrappers (default true). */
  expandRedirects?: boolean;
  /** Cap on wrapper resolutions per call. */
  maxRedirectExpansions?: number;
  signal?: AbortSignal;
  /** Overall wall-clock budget for the whole call. */
  timeoutMs?: number;
}

export interface SearchOutcome {
  query: string;
  results: SearchResult[];
  /** Engine ids that produced at least one result. */
  enginesUsed: string[];
  /** Engine ids that ran but returned nothing usable. */
  enginesEmpty: string[];
  enginesFailed: { engine: string; error: string }[];
  /** Engine ids skipped because the circuit breaker had them benched. */
  enginesSkipped: string[];
  /** Engine ids that were eligible but not run (tier not reached, no key). */
  enginesNotUsed: string[];
  /** Per-engine result counts, for transparency in the output. */
  engineCounts: Record<string, number>;
  /** Which tiers actually ran. */
  tiersRun: string[];
  elapsedMs: number;
  cached: boolean;
  health: EngineHealth[];
}

const DEFAULT_LIMIT = 12;
const PRIMARY_MIN_RESULTS = 5;

interface EngineAttempt {
  id: string;
  weight: number;
  results: RawResult[];
  error?: string;
  elapsedMs: number;
  fromCache: boolean;
}

export class SearchService {
  private readonly ctx: EngineContext;
  private readonly tracker: EngineHealthTracker;

  constructor(
    private readonly config: Config,
    private readonly http: HttpClient = createHttpClient(config),
  ) {
    this.ctx = { http, config };
    const cache = getCache(config);
    this.tracker = new EngineHealthTracker({
      failureThreshold: config.engineFailureThreshold,
      cooldownMs: config.engineCooldownMs,
      // Persist breaker state so a restarted server (or the next CLI run) does
      // not re-pay the timeout on a provider that is blocked on this network.
      persistence: {
        load: () => cache.loadEngineHealth(),
        save: (records) => cache.saveEngineHealth(records),
      },
    });
  }

  get health(): EngineHealthTracker {
    return this.tracker;
  }

  /** Engine ids that are configured and not currently benched. */
  private availableIds(requested?: string[]): { usable: string[]; skipped: string[]; unconfigured: string[] } {
    const pool = requested && requested.length > 0 ? requested : [...ENGINE_IDS];
    const usable: string[] = [];
    const skipped: string[] = [];
    const unconfigured: string[] = [];
    for (const id of pool) {
      if (!getDefinition(id)) continue;
      if (!isConfigured(id, this.config)) {
        unconfigured.push(id);
        continue;
      }
      if (this.tracker.isBenched(id)) {
        skipped.push(id);
        continue;
      }
      usable.push(id);
    }
    return { usable, skipped, unconfigured };
  }

  /**
   * Decide which engines to run, in which order.
   *
   * Returns tiers so the caller can stop early. Engines named explicitly by the
   * user are always honoured, in the order given, with no tiering.
   */
  private planTiers(options: SearchOptions, query: string): { tier: string; ids: string[] }[] {
    const explicit = options.engines?.filter((e) => e && e !== 'auto') ?? [];
    if (options.all) {
      return [{ tier: 'all', ids: [...ENGINE_IDS] }];
    }
    if (explicit.length > 0) {
      return [{ tier: 'explicit', ids: explicit }];
    }
    if (!this.config.autoEngines) {
      return [{ tier: 'configured', ids: [...this.config.engines] }];
    }

    const tiers: { tier: string; ids: string[] }[] = [];
    const primary = this.config.primaryEngines;
    tiers.push({ tier: 'primary', ids: primary });

    // Region/language-aware fallback: CJK queries reach for the engines that
    // index Chinese content well; everything else gets Bing.
    const cjk = hasCJK(query) || options.region === 'cn' || options.language === 'zh';
    const fallback = this.config.fallbackEngines.filter((id) => {
      const affinity = getDefinition(id)?.affinity;
      if (affinity === 'cn') return cjk;
      return true;
    });
    if (fallback.length) tiers.push({ tier: 'fallback', ids: fallback });

    // Subject indexes: only when the query looks like it belongs there.
    const suggested = suggestApiEngines(query);
    if (suggested.length) tiers.push({ tier: 'api', ids: suggested });

    // Keyed engines outrank scrapers in result quality, so when the user has
    // configured one it is added to the first tier rather than used as a last
    // resort. They are expensive, so only the first configured one is added.
    const keyed = ENGINE_IDS.filter((id) => getDefinition(id)?.tier === 'keyed' && isConfigured(id, this.config));
    if (keyed.length) tiers.unshift({ tier: 'keyed', ids: keyed.slice(0, 2) });

    return tiers;
  }

  /** Run one engine, with the raw-response cache in front of it. */
  private async runEngine(
    resolved: ResolvedEngine,
    query: string,
    options: EngineSearchOptions,
    engineOptions: SearchOptions,
  ): Promise<EngineAttempt> {
    const { engine, weight } = resolved;
    const id = engine.id;
    const cache = getCache(this.config);
    const cacheKey = searchCacheKey(id, query, {
      limit: options.limit,
      language: options.language,
      region: options.region,
      freshness: options.freshness,
      safe: options.safeSearch,
    });

    if (!engineOptions.noCache) {
      const cached = cache.getSearchResults(cacheKey, this.config.searchCacheTtlMs);
      if (cached) {
        log.debug(`${id}: ${cached.length} results from cache`);
        return { id, weight, results: cached, elapsedMs: 0, fromCache: true };
      }
    }

    const started = Date.now();
    try {
      const results = await engine.search(query, options);
      const elapsed = Date.now() - started;
      const cleaned = sanitiseResults(results, engine.id);
      if (cleaned.length > 0) {
        this.tracker.recordSuccess(id, cleaned.length, elapsed);
        cache.putSearchResults(cacheKey, id, query, cleaned);
        return { id, weight, results: cleaned, elapsedMs: elapsed, fromCache: false };
      }
      // Zero results is not a failure (the query may simply have no hits), but
      // it is worth remembering so the tier logic can escalate.
      this.tracker.recordSuccess(id, 0, elapsed);
      cache.putSearchResults(cacheKey, id, query, []);
      return { id, weight, results: [], elapsedMs: elapsed, fromCache: false };
    } catch (err) {
      const elapsed = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      this.tracker.recordFailure(id, err, elapsed);
      log.debug(`${id} failed in ${elapsed}ms: ${message}`);
      return { id, weight, results: [], error: message, elapsedMs: elapsed, fromCache: false };
    }
  }

  /**
   * Search the web across several engines and return RRF-fused results.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchOutcome> {
    const started = Date.now();
    const trimmed = query.trim();
    const limit = Math.max(1, Math.min(options.limit ?? this.config.maxResults, 100));
    const perEngine = Math.max(3, Math.min(options.perEngine ?? this.config.perEngineResults, 30));
    const overallTimeout = options.timeoutMs ?? Math.max(this.config.timeoutMs * 2, 20_000);
    const deadline = Date.now() + overallTimeout;

    if (!trimmed) {
      return emptyOutcome(query, ['empty query']);
    }

    const searchOptions = this.buildEngineOptions(query, { ...options, limit: perEngine }, deadline);
    const tiers = this.planTiers(options, trimmed);
    const cached = getCache(this.config);

    const enginesUsed: string[] = [];
    const enginesEmpty: string[] = [];
    const enginesFailed: { engine: string; error: string }[] = [];
    const enginesSkipped: string[] = [];
    const enginesNotUsed: string[] = [];
    const engineCounts: Record<string, number> = {};
    const tiersRun: string[] = [];
    const attempts: EngineAttempt[] = [];
    let fused: SearchResult[] = [];
    let anyCacheHit = false;

    const fuseOptions = {
      k: this.config.rrfK,
      limit: limit * 2,
      maxPerDomain: 3,
      dedupeTitleThreshold: 0.82,
    };

    for (const tier of tiers) {
      if (Date.now() >= deadline) {
        enginesNotUsed.push(...tier.ids);
        continue;
      }
      const { usable, skipped, unconfigured } = this.availableIds(tier.ids);
      enginesSkipped.push(...skipped);
      enginesNotUsed.push(...unconfigured);
      if (usable.length === 0) continue;
      tiersRun.push(tier.tier);

      const resolved = resolveEngines(usable, this.ctx);
      const resolvedIds = new Set(resolved.map((r) => r.engine.id));
      enginesNotUsed.push(...usable.filter((id) => !resolvedIds.has(id)));

      const budget = Math.max(2000, deadline - Date.now());
      const tierAttempts = await mapConcurrent(resolved, this.config.concurrency, (r) =>
        this.runEngine(r, trimmed, { ...searchOptions, timeoutMs: Math.min(searchOptions.timeoutMs ?? this.config.timeoutMs, budget) }, options),
      );

      attempts.push(...tierAttempts);
      for (const attempt of tierAttempts) {
        if (attempt.fromCache) anyCacheHit = true;
        if (attempt.error) enginesFailed.push({ engine: attempt.id, error: attempt.error });
        else if (attempt.results.length === 0) enginesEmpty.push(attempt.id);
        else {
          enginesUsed.push(attempt.id);
          engineCounts[attempt.id] = attempt.results.length;
        }
      }

      fused = fuseResults(
        attempts.filter((a) => a.results.length > 0).map((a) => ({ engine: a.id, results: a.results, weight: a.weight })),
        fuseOptions,
      );

      // Enough material: stop escalating.
      if (options.engines?.length || options.all || !this.config.autoEngines || fused.length >= Math.max(limit, PRIMARY_MIN_RESULTS)) {
        break;
      }
      log.debug(`tier "${tier.tier}" yielded ${fused.length}/${limit}; escalating`);
    }

    // Resolve redirect wrappers so dedupe works and citations are usable.
    //
    // Candidates are chosen from the *fused* order (so only the results the
    // model will actually see cost a request), but the rewrites are applied to
    // the per-engine attempts and the list is fused again from scratch. That
    // keeps every engine's original rank information intact — re-fusing from
    // the fused output would flatten it.
    const expandRedirects = options.expandRedirects ?? true;
    if (expandRedirects) {
      const budget = options.maxRedirectExpansions ?? 8;
      const candidates: string[] = [];
      for (const result of fused) {
        if (candidates.length >= budget) break;
        if (isWrapperUrl(result.url)) candidates.push(result.url);
      }
      if (candidates.length > 0) {
        const updates = await this.resolveWrappers(candidates, deadline, options.signal);
        if (updates.size > 0) {
          for (const attempt of attempts) {
            attempt.results = attempt.results.map((r) => {
              const unwrapped = updates.get(r.url);
              if (!unwrapped) return r;
              return {
                ...r,
                url: unwrapped,
                meta: { ...(r.meta ?? {}), wrapperUrl: r.url, unwrapped: true },
              };
            });
          }
          fused = fuseResults(
            attempts.filter((a) => a.results.length > 0).map((a) => ({ engine: a.id, results: a.results, weight: a.weight })),
            fuseOptions,
          );
        }
      }
    }

    const filtered = applyDomainFilters(fused, options);
    const results = filtered.slice(0, limit);

    return {
      query: trimmed,
      results,
      enginesUsed: [...new Set(enginesUsed)],
      enginesEmpty: [...new Set(enginesEmpty)],
      enginesFailed,
      enginesSkipped: [...new Set(enginesSkipped)],
      enginesNotUsed: [...new Set(enginesNotUsed)],
      engineCounts,
      tiersRun,
      elapsedMs: Date.now() - started,
      cached: anyCacheHit,
      health: this.tracker.snapshot(tiers.flatMap((t) => t.ids)),
    };
  }

  private buildEngineOptions(query: string, options: SearchOptions, deadline: number): EngineSearchOptions {
    const language = options.language ?? this.config.language ?? guessLanguage(query);
    const region = options.region ?? this.config.region;
    const safeSearch = options.safeSearch ?? this.config.safeSearch;
    const budget = options.timeoutMs ?? this.config.timeoutMs;
    return {
      limit: options.perEngine ?? this.config.perEngineResults,
      language,
      ...(region ? { region } : {}),
      ...(options.freshness ? { freshness: options.freshness } : {}),
      safeSearch,
      timeoutMs: Math.max(1500, Math.min(budget, this.config.timeoutMs, deadline - Date.now())),
      deadline,
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }

  /**
   * Resolve engine redirect wrappers to their real destinations.
   *
   * Baidu, Sogou, 360, DuckDuckGo and Google all hand back `/link?url=` or
   * `/url?q=` style URLs. A HEAD request that follows redirects reveals the
   * destination cheaply, which matters twice: dedupe across engines only works
   * on real URLs, and a model cannot cite a wrapped one.
   */
  private async resolveWrappers(
    urls: readonly string[],
    deadline: number,
    signal?: AbortSignal,
  ): Promise<Map<string, string>> {
    const updates = new Map<string, string>();
    await mapConcurrent(urls, Math.min(4, this.config.concurrency), async (url) => {
      if (Date.now() >= deadline) return;

      // Most wrappers carry the destination in an encoded parameter, so try to
      // decode it before spending a request. Bing's `ck/a?u=a1aHR0…` and
      // DuckDuckGo's `l/?uddg=…` both resolve with zero network cost this way.
      const decoded = extractWrapperTarget(url);
      if (decoded) {
        record(url, decoded);
        return;
      }

      const timeoutMs = Math.min(6000, Math.max(1000, deadline - Date.now()));
      try {
        const res = await this.http.request(url, {
          method: 'HEAD',
          retries: 0,
          maxBytes: 0,
          timeoutMs,
          ...(signal ? { signal } : {}),
        });
        record(url, res.url);
      } catch (err) {
        if (err instanceof BlockedUrlError) return;
        // Some wrappers reject HEAD; retry with a tiny GET before giving up.
        try {
          const res = await this.http.request(url, {
            method: 'GET',
            retries: 0,
            maxBytes: 8192,
            timeoutMs,
            ...(signal ? { signal } : {}),
          });
          record(url, res.url);
        } catch (err2) {
          log.debug(`wrapper resolution failed for ${url.slice(0, 60)}: ${(err2 as Error).message}`);
        }
      }
    });
    return updates;

    function record(original: string, finalUrl: string | undefined): void {
      if (!finalUrl || finalUrl === original) return;
      const normalized = normalizeUrl(finalUrl);
      if (!normalized || isWrapperUrl(normalized.url)) return;
      updates.set(original, normalized.url);
    }
  }

  /** Search only the local FTS5 index of pages fetched earlier. */
  searchLocal(query: string, limit = 10): { url: string; title: string; snippet: string; score: number; fetchedAt: string }[] {
    return getCache(this.config).searchPages(query, limit);
  }

  /** Per-engine contribution counts for a result set, for `json` output. */
  static contributions(results: SearchResult[]): Record<string, number> {
    return contributionsByEngine(results);
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Drop junk that engines occasionally emit: non-http URLs, empty titles. */
function sanitiseResults(results: RawResult[], engineId: string): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (!r || typeof r.url !== 'string' || typeof r.title !== 'string') continue;
    const title = r.title.trim();
    if (!title || title.length < 2) continue;
    const normalized = normalizeUrl(r.url);
    if (!normalized) continue;
    if (seen.has(normalized.key)) continue;
    seen.add(normalized.key);
    out.push({
      title,
      url: normalized.url,
      ...(r.snippet ? { snippet: r.snippet } : {}),
      ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
      ...(r.meta ? { meta: { ...r.meta, engine: engineId } } : { meta: { engine: engineId } }),
    });
  }
  return out;
}

/** Wrapper hosts/paths that hide the real destination behind a redirect. */
const WRAPPER_HOSTS = new Set([
  'baidu.com', 'www.baidu.com',
  'sogou.com', 'www.sogou.com',
  'so.com', 'www.so.com',
  'google.com', 'www.google.com',
  'bing.com', 'www.bing.com', 'cn.bing.com',
  'duckduckgo.com', 'html.duckduckgo.com', 'lite.duckduckgo.com',
  'yandex.com', 'yandex.ru',
]);

const WRAPPER_PATHS = [/^\/link$/i, /^\/l\/?$/i, /^\/url$/i, /^\/ck\/a$/i, /^\/interstitial$/i, /^\/redirect$/i];

export function isWrapperUrl(url: string): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized) return false;
  if (!WRAPPER_HOSTS.has(normalized.host)) return false;
  if (WRAPPER_PATHS.some((re) => re.test(normalized.path))) return true;
  // Some wrappers are on a normal path but carry the target in a parameter.
  return /[?&](?:uddg|url|u|q|target|m)=/i.test(url) && /\/link|\/l\/|\/url|\/ck\/a/i.test(normalized.path);
}

function applyDomainFilters(results: SearchResult[], options: SearchOptions): SearchResult[] {
  const include = [...(options.includeDomains ?? []), ...(options.site ? [options.site] : [])]
    .map((d) => d.trim())
    .filter(Boolean);
  const exclude = (options.excludeDomains ?? []).map((d) => d.trim()).filter(Boolean);
  if (!include.length && !exclude.length) return results;
  return results.filter((r) => {
    const host = (() => {
      try {
        return new URL(r.url).hostname;
      } catch {
        return r.source;
      }
    })();
    if (exclude.some((d) => hostMatches(host, d))) return false;
    if (include.length && !include.some((d) => hostMatches(host, d))) return false;
    return true;
  });
}

/** Very cheap language guess used only to pick engine defaults. */
export function guessLanguage(query: string): string {
  if (hasCJK(query)) {
    if (/[\u3040-\u30ff]/.test(query)) return 'ja';
    if (/[\uac00-\ud7af]/.test(query)) return 'ko';
    return 'zh';
  }
  if (/[àâçéèêëîïôûùüÿœ]/i.test(query)) return 'fr';
  if (/[äöüß]/i.test(query)) return 'de';
  if (/[áéíóúñ¿¡]/i.test(query)) return 'es';
  if (/[а-яё]/i.test(query)) return 'ru';
  return 'en';
}

function emptyOutcome(query: string, errors: string[]): SearchOutcome {
  return {
    query,
    results: [],
    enginesUsed: [],
    enginesEmpty: [],
    enginesFailed: errors.map((error) => ({ engine: 'none', error })),
    enginesSkipped: [],
    enginesNotUsed: [],
    engineCounts: {},
    tiersRun: [],
    elapsedMs: 0,
    cached: false,
    health: [],
  };
}
