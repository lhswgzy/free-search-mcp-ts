/**
 * Reciprocal Rank Fusion (RRF) and result de-duplication.
 *
 * RRF comes from Cormack, Clarke & Buettcher (2009): for each ranked list,
 * a document at rank `r` contributes `1 / (k + r)`. Summing those contributions
 * across engines needs no score calibration between engines — which is exactly
 * why it is the right choice here, since BM25-ish scores from Mojeek, a Bing
 * relevance number and a Google News publish order are not comparable.
 *
 * On top of the textbook formula we add:
 *   - per-engine weights, so a high-precision API can outvote a scraper;
 *   - a small consensus bonus, rewarding documents several engines agree on;
 *   - title-similarity de-duplication, because the same story is often served
 *     from syndicated URLs that normalisation alone will not collapse;
 *   - domain diversity, so one prolific host cannot fill the whole page.
 */

import type { Config } from './config.js';
import type { EngineContribution, RawResult, SearchResult } from './types.js';
import { normalizeUrl, registrableDomain, sameUrl } from './util/url.js';
import { shingleSimilarity } from './util/text.js';

export interface EngineRanking {
  engine: string;
  results: RawResult[];
  /** Multiplier applied to this engine's RRF contribution. Defaults to 1. */
  weight?: number;
}

export interface FuseOptions {
  /** RRF damping constant; larger flattens the influence of top ranks. */
  k?: number;
  limit?: number;
  /** Bonus added once per extra engine beyond the first that agrees. */
  consensusBonus?: number;
  /** Hard cap on results from a single registrable domain. */
  maxPerDomain?: number;
  /** Drop near-duplicate titles above this Jaccard similarity. 0 disables. */
  dedupeTitleThreshold?: number;
  /** Multiplier applied to results published within `recencyWindowMs`. */
  recencyBoost?: number;
  recencyWindowMs?: number;
  /** Domains to demote (content farms, scrapers). */
  demoteDomains?: string[];
  /** Domains to promote (docs, official sources). */
  promoteDomains?: string[];
}

export const DEFAULT_FUSE_OPTIONS: Required<Omit<FuseOptions, 'demoteDomains' | 'promoteDomains'>> = {
  k: 60,
  limit: 12,
  consensusBonus: 0.12,
  maxPerDomain: 3,
  dedupeTitleThreshold: 0.82,
  recencyBoost: 1.0,
  recencyWindowMs: 0,
};

interface Working {
  key: string;
  title: string;
  url: string;
  snippet: string;
  domain: string;
  contributions: EngineContribution[];
  bestRank: number;
  publishedAt?: string;
  meta?: Record<string, unknown>;
}

/**
 * Fuse several ranked engine result lists into one.
 *
 * The output is ordered by fused score, de-duplicated by normalised URL and by
 * near-identical title, and (by default) limited to `maxPerDomain` hits per
 * site so the top of the list is not all one host.
 */
export function fuseResults(rankings: readonly EngineRanking[], options: FuseOptions = {}): SearchResult[] {
  const opts = { ...DEFAULT_FUSE_OPTIONS, ...options };
  const k = opts.k > 0 ? opts.k : 60;
  const now = Date.now();

  /** Normalised-URL key -> accumulated document. */
  const byKey = new Map<string, Working>();
  /** Ordered list of keys so ties fall back to first-seen order. */
  const order: string[] = [];

  for (const ranking of rankings) {
    const weight = ranking.weight ?? 1;
    if (weight <= 0) continue;
    const seenInThisEngine = new Set<string>();

    ranking.results.forEach((raw, index) => {
      if (!raw?.url) return;
      const normalized = normalizeUrl(raw.url);
      if (!normalized) return;
      const key = normalized.key;

      // An engine listing the same URL twice contributes only once.
      if (seenInThisEngine.has(key)) return;
      seenInThisEngine.add(key);

      const rank = index + 1;
      const contribution = weight / (k + rank);

      let doc = byKey.get(key);
      if (!doc) {
        doc = {
          key,
          title: (raw.title || '').trim() || normalized.path,
          url: normalized.url,
          snippet: (raw.snippet || '').trim(),
          domain: registrableDomain(normalized.host),
          contributions: [],
          bestRank: rank,
          ...(raw.publishedAt ? { publishedAt: raw.publishedAt } : {}),
          ...(raw.meta ? { meta: raw.meta } : {}),
        };
        byKey.set(key, doc);
        order.push(key);
      } else {
        // Keep the richest title and the longest snippet across engines.
        if ((raw.title || '').length > doc.title.length) doc.title = raw.title.trim();
        if ((raw.snippet ?? '').length > doc.snippet.length) doc.snippet = (raw.snippet ?? '').trim();
        if (raw.publishedAt && !doc.publishedAt) doc.publishedAt = raw.publishedAt;
        if (raw.meta) doc.meta = { ...doc.meta, ...raw.meta };
      }

      doc.contributions.push({ engine: ranking.engine, rank, score: contribution });
      if (rank < doc.bestRank) doc.bestRank = rank;
    });
  }

  const promote = new Set((opts.promoteDomains ?? []).map((d) => d.toLowerCase()));
  const demote = new Set((opts.demoteDomains ?? []).map((d) => d.toLowerCase()));

  const scored: SearchResult[] = [];
  for (const key of order) {
    const doc = byKey.get(key)!;
    const contributions = [...doc.contributions].sort((a, b) => b.score - a.score);
    let score = contributions.reduce((sum, c) => sum + c.score, 0);

    // Consensus: independent engines agreeing is a strong quality signal.
    const distinctEngines = new Set(contributions.map((c) => c.engine));
    if (distinctEngines.size > 1) score += opts.consensusBonus * (distinctEngines.size - 1);

    if (opts.recencyBoost !== 1 && opts.recencyWindowMs > 0 && doc.publishedAt) {
      const published = Date.parse(doc.publishedAt);
      if (Number.isFinite(published) && now - published <= opts.recencyWindowMs) score *= opts.recencyBoost;
    }

    if (promote.has(doc.domain)) score *= 1.15;
    if (demote.has(doc.domain)) score *= 0.5;

    scored.push({
      title: doc.title,
      url: doc.url,
      snippet: doc.snippet,
      source: doc.domain,
      engines: [...new Set(contributions.sort((a, b) => b.score - a.score).map((c) => c.engine))],
      bestRank: doc.bestRank,
      score: Number(score.toFixed(6)),
      ...(doc.publishedAt ? { publishedAt: doc.publishedAt } : {}),
      ...(doc.meta ? { meta: doc.meta } : {}),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.bestRank - b.bestRank || a.title.localeCompare(b.title));

  const deduped = dedupeByTitle(scored, opts.dedupeTitleThreshold);
  const diversified = enforceDomainCap(deduped, opts.maxPerDomain);

  return opts.limit > 0 ? diversified.slice(0, opts.limit) : diversified;
}

/**
 * Collapse near-identical titles, keeping the highest-scoring instance and
 * merging the engine attribution of the dropped duplicates.
 */
export function dedupeByTitle(results: SearchResult[], threshold: number): SearchResult[] {
  if (threshold <= 0) return results;
  const kept: SearchResult[] = [];
  for (const candidate of results) {
    const duplicateOf = kept.find(
      (existing) =>
        (existing.source === candidate.source || sameHost(existing.url, candidate.url)) &&
        shingleSimilarity(existing.title, candidate.title) >= threshold,
    );
    if (duplicateOf) {
      duplicateOf.engines = [...new Set([...duplicateOf.engines, ...candidate.engines])];
      duplicateOf.score = Number((duplicateOf.score + candidate.score * 0.25).toFixed(6));
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

function sameHost(a: string, b: string): boolean {
  const na = normalizeUrl(a);
  const nb = normalizeUrl(b);
  return !!na && !!nb && na.host === nb.host;
}

/**
 * Cap results per registrable domain while preserving relative order: the
 * overflow is pushed to the back rather than dropped, so a narrow query can
 * still return everything it found.
 */
export function enforceDomainCap(results: SearchResult[], maxPerDomain: number): SearchResult[] {
  if (maxPerDomain <= 0) return results;
  const counts = new Map<string, number>();
  const primary: SearchResult[] = [];
  const overflow: SearchResult[] = [];
  for (const r of results) {
    const n = (counts.get(r.source) ?? 0) + 1;
    counts.set(r.source, n);
    if (n <= maxPerDomain) primary.push(r);
    else overflow.push(r);
  }
  return [...primary, ...overflow];
}

/**
 * Interleave results by domain so consecutive entries come from different
 * sites. Used by the `research` brief to avoid three quotes from one article.
 */
export function diversify(results: SearchResult[], windowSize = 3): SearchResult[] {
  const out: SearchResult[] = [];
  const pool = [...results];
  const recent: string[] = [];
  while (pool.length) {
    let pickedIndex = 0;
    for (let i = 0; i < pool.length; i++) {
      const candidate = pool[i]!;
      if (!recent.includes(candidate.source)) {
        pickedIndex = i;
        break;
      }
    }
    const [picked] = pool.splice(pickedIndex, 1);
    if (!picked) break;
    out.push(picked);
    recent.push(picked.source);
    if (recent.length > windowSize) recent.shift();
  }
  return out;
}

/** Group fused results by engine so a caller can explain "who found what". */
export function contributionsByEngine(results: SearchResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of results) for (const e of r.engines) counts[e] = (counts[e] ?? 0) + 1;
  return counts;
}
