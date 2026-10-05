/**
 * `research()` — search, fetch and organise in one call.
 *
 * What this does *not* do is write prose: the server has no language model of
 * its own, so it would be dishonest to call the output a summary. What it does
 * is the expensive, mechanical part of research:
 *
 *   1. run the query, then derive extra queries from the vocabulary the first
 *      page of results actually uses (so depth 2 sees more than one phrasing);
 *   2. pick the most promising, most diverse sources;
 *   3. fetch them concurrently, through the cache;
 *   4. score every paragraph in each source against the query and keep only the
 *      passages that carry the answer;
 *   5. emit a Markdown brief with numbered, citable sources.
 *
 * The calling model then writes the synthesis. That split is why the output is
 * small enough to fit in a context window.
 */

import type { Config } from './config.js';
import type { ResearchReport, ResearchSource, SearchResult } from './types.js';
import { SearchService, type SearchOptions } from './search.js';
import { FetchService } from './fetch/page.js';
import { selectPassages, uniqueTerms, tokenize, truncate } from './util/text.js';
import { renderResearchBrief } from './tools/format.js';
import { normalizeUrl, registrableDomain } from './util/url.js';
import { mapConcurrent } from './http.js';
import { createLogger } from './util/logger.js';

const log = createLogger('research');

export interface ResearchOptions {
  /** 1 = one query, 2 = expand queries (default), 3 = expand twice. */
  depth?: number;
  /** Maximum sources to fetch and quote. */
  maxSources?: number;
  /** Results to consider per query before choosing sources. */
  resultsPerQuery?: number;
  /** Passages kept per source. */
  passagesPerSource?: number;
  /** Character budget for the whole brief; sources are dropped past it. */
  maxBriefChars?: number;
  /** Forwarded to the search layer. */
  engines?: string[];
  language?: string;
  region?: string;
  freshness?: SearchOptions['freshness'];
  safeSearch?: SearchOptions['safeSearch'];
  includeDomains?: string[];
  excludeDomains?: string[];
  /** Skip the local page cache when fetching. */
  refresh?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Receives progress notes; the CLI prints them, the MCP server logs them. */
  onProgress?: (message: string) => void;
}

export interface ResearchServiceOptions {
  config: Config;
  search?: SearchService;
  fetch?: FetchService;
}

export class ResearchService {
  private readonly config: Config;
  private readonly search: SearchService;
  private readonly fetch: FetchService;

  constructor(options: ResearchServiceOptions) {
    this.config = options.config;
    this.search = options.search ?? new SearchService(options.config);
    this.fetch = options.fetch ?? new FetchService(options.config);
  }

  async research(query: string, options: ResearchOptions = {}): Promise<ResearchReport> {
    const started = Date.now();
    const depth = Math.max(1, Math.min(options.depth ?? 2, 3));
    const maxSources = Math.max(1, Math.min(options.maxSources ?? (depth === 1 ? 4 : 8), 15));
    const maxBriefChars = options.maxBriefChars ?? 60_000;
    const progress = options.onProgress ?? ((message: string) => log.debug(message));

    const queries: string[] = [query];
    const resultsByUrl = new Map<string, SearchResult>();
    const enginesUsed = new Set<string>();
    const enginesFailed: { engine: string; error: string }[] = [];

    // --- pass 1 ---------------------------------------------------------
    progress(`searching: ${query}`);
    const first = await this.search.search(query, {
      limit: Math.max(options.resultsPerQuery ?? 10, maxSources * 2),
      ...(options.engines ? { engines: options.engines } : {}),
      ...(options.language ? { language: options.language } : {}),
      ...(options.region ? { region: options.region } : {}),
      ...(options.freshness ? { freshness: options.freshness } : {}),
      ...(options.safeSearch ? { safeSearch: options.safeSearch } : {}),
      ...(options.includeDomains ? { includeDomains: options.includeDomains } : {}),
      ...(options.excludeDomains ? { excludeDomains: options.excludeDomains } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    for (const id of first.enginesUsed) enginesUsed.add(id);
    enginesFailed.push(...first.enginesFailed);
    absorb(resultsByUrl, first.results);

    // --- pass 2+: query expansion --------------------------------------
    if (depth >= 2 && first.results.length > 0) {
      const expansions = deriveExpansionQueries(query, first.results, depth === 3 ? 3 : 2);
      for (const expanded of expansions) {
        if (queries.includes(expanded)) continue;
        queries.push(expanded);
      }
      progress(`expanded to ${queries.length} queries: ${queries.slice(1).join(' | ')}`);

      const extra = await mapConcurrent(queries.slice(1), Math.min(3, this.config.concurrency), async (q) => {
        try {
          return await this.search.search(q, {
            limit: options.resultsPerQuery ?? 10,
            ...(options.engines ? { engines: options.engines } : {}),
            ...(options.language ? { language: options.language } : {}),
            ...(options.region ? { region: options.region } : {}),
            ...(options.freshness ? { freshness: options.freshness } : {}),
            ...(options.safeSearch ? { safeSearch: options.safeSearch } : {}),
            ...(options.signal ? { signal: options.signal } : {}),
            ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
          });
        } catch (err) {
          log.debug(`expansion query "${q}" failed: ${(err as Error).message}`);
          return undefined;
        }
      });
      for (const outcome of extra) {
        if (!outcome) continue;
        for (const id of outcome.enginesUsed) enginesUsed.add(id);
        absorb(resultsByUrl, outcome.results);
      }
    }

    // --- choose sources -------------------------------------------------
    const chosen = chooseSources([...resultsByUrl.values()], maxSources);
    progress(`fetching ${chosen.length} sources`);

    // --- fetch ----------------------------------------------------------
    const fetched = await mapConcurrent(chosen, Math.min(5, this.config.concurrency), async (result, index) => {
      try {
        const page = await this.fetch.fetchPage(result.url, {
          ...(options.refresh ? { refresh: true } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          // The brief only needs the prose; cap per-source size for speed.
          maxChars: 60_000,
          includeLinks: false,
        });
        return { result, page, index };
      } catch (err) {
        return { result, error: err instanceof Error ? err.message : String(err), index };
      }
    });

    // --- assemble -------------------------------------------------------
    const sources: ResearchSource[] = [];
    let briefBudget = maxBriefChars;
    let citation = 0;

    for (const entry of fetched) {
      citation++;
      const { result } = entry;
      if ('error' in entry && entry.error) {
        sources.push({
          index: citation,
          title: result.title,
          url: result.url,
          source: result.source,
          engines: result.engines,
          score: result.score,
          wordCount: 0,
          cached: false,
          passages: [],
          error: entry.error,
        });
        continue;
      }
      const page = entry.page;
      if (!page) continue;

      const passages = selectPassages(page.content, query, {
        maxPassages: options.passagesPerSource ?? 4,
        maxCharsPerPassage: 900,
        maxTotalChars: Math.max(600, Math.min(2600, briefBudget)),
      });
      briefBudget -= passages.reduce((sum, p) => sum + p.text.length, 0);

      sources.push({
        index: citation,
        title: page.title || result.title,
        url: page.finalUrl || result.url,
        source: result.source,
        engines: result.engines,
        score: result.score,
        wordCount: page.wordCount,
        cached: page.cached,
        ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        passages,
      });
    }

    const report: ResearchReport = {
      query,
      generatedAt: new Date().toISOString(),
      depth,
      queries,
      enginesUsed: [...enginesUsed],
      enginesFailed,
      sources,
      markdown: '',
      elapsedMs: Date.now() - started,
    };
    report.markdown = renderResearchBrief(report, {
      passagesPerSource: options.passagesPerSource ?? 4,
      passageChars: 900,
    });
    progress(`brief ready: ${sources.length} sources, ${report.markdown.length} chars`);
    return report;
  }
}

/** Merge results into the accumulator, keeping the highest-scoring instance. */
function absorb(accumulator: Map<string, SearchResult>, results: SearchResult[]): void {
  for (const result of results) {
    const key = normalizeUrl(result.url)?.key ?? result.url;
    const existing = accumulator.get(key);
    if (!existing) {
      accumulator.set(key, result);
      continue;
    }
    // Same page from a second query: keep the better score but merge the
    // engine attribution so the brief can credit every engine that found it.
    accumulator.set(key, {
      ...existing,
      score: Math.max(existing.score, result.score),
      engines: [...new Set([...existing.engines, ...result.engines])],
      snippet: existing.snippet.length >= result.snippet.length ? existing.snippet : result.snippet,
      ...(result.publishedAt && !existing.publishedAt ? { publishedAt: result.publishedAt } : {}),
    });
  }
}

/**
 * Derive follow-up queries from the vocabulary of the first result page.
 *
 * Deliberately simple and deterministic: terms that recur across *different*
 * documents (but are not already in the query) describe the sub-topics the
 * topic actually has. Two shapes are produced — a focused "query + term" and a
 * broader "query + two terms" — which together broaden recall without drifting
 * off-topic the way an unconstrained LLM rewrite can.
 */
export function deriveExpansionQueries(query: string, results: SearchResult[], count = 2): string[] {
  const queryTerms = new Set(uniqueTerms(query));
  const documentFrequency = new Map<string, number>();
  const termDisplay = new Map<string, string>();

  for (const result of results.slice(0, 12)) {
    const seen = new Set<string>();
    const text = `${result.title} ${result.snippet}`;
    for (const term of tokenize(text)) {
      if (queryTerms.has(term)) continue;
      if (term.length < 3 && !/[\u3400-\u9fff]/.test(term)) continue;
      if (/^\d+$/.test(term)) continue;
      if (!seen.has(term)) {
        seen.add(term);
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
      // Keep the original casing for display purposes.
      if (!termDisplay.has(term)) {
        const match = new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').exec(text);
        termDisplay.set(term, match?.[0] ?? term);
      }
    }
  }

  const ranked = [...documentFrequency.entries()]
    // Terms in 2+ documents describe the topic; terms in all 12 are noise
    // ("the", "http"), so cap the upper end too.
    .filter(([, df]) => df >= 2 && df <= Math.max(3, Math.ceil(results.length * 0.8)))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([term]) => termDisplay.get(term) ?? term);

  const out: string[] = [];
  if (ranked[0]) out.push(`${query} ${ranked[0]}`);
  if (ranked[1] && ranked[2]) out.push(`${query} ${ranked[1]} ${ranked[2]}`);
  else if (ranked[1]) out.push(`${query} ${ranked[1]}`);
  return out.slice(0, count);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Choose which results to fetch.
 *
 * Ranking factors: the fused RRF score (dominant), multi-engine agreement, and
 * a per-domain cap so the brief quotes several publications instead of one
 * prolific site. Hosts that never contain prose are skipped outright.
 */
export function chooseSources(results: SearchResult[], maxSources: number): SearchResult[] {
  const NON_PROSE = /(?:youtube\.com|youtu\.be|vimeo\.com|instagram\.com|facebook\.com|tiktok\.com|twitter\.com|x\.com|pinterest\.|play\.google\.com|apps\.apple\.com)/i;
  const BINARY = /\.(?:zip|gz|tgz|rar|7z|exe|msi|dmg|iso|apk|mp4|mp3|avi|mov|wav|torrent|woff2?|ttf|eot)$/i;

  const candidates = results.filter((result) => {
    if (NON_PROSE.test(result.url)) return false;
    if (BINARY.test(result.url)) return false;
    return true;
  });

  const ranked = [...candidates].sort((a, b) => {
    const aScore = a.score + (a.engines.length - 1) * 0.05;
    const bScore = b.score + (b.engines.length - 1) * 0.05;
    return bScore - aScore;
  });

  const domainCounts = new Map<string, number>();
  const chosen: SearchResult[] = [];
  const perDomain = maxSources >= 8 ? 2 : 1;

  for (const candidate of ranked) {
    if (chosen.length >= maxSources) break;
    const domain = candidate.source || registrableDomain(safeHost(candidate.url));
    const used = domainCounts.get(domain) ?? 0;
    if (used >= perDomain) continue;
    domainCounts.set(domain, used + 1);
    chosen.push(candidate);
  }

  // If the domain cap starved the list, fill the remainder ignoring it.
  if (chosen.length < Math.min(maxSources, ranked.length)) {
    for (const candidate of ranked) {
      if (chosen.length >= maxSources) break;
      if (chosen.includes(candidate)) continue;
      chosen.push(candidate);
    }
  }

  return chosen;
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export { truncate };
