/**
 * Hacker News — Algolia search API.
 *
 * What this indexes: the full Hacker News item corpus (stories, comments,
 * polls, jobs) as mirrored by Algolia. It is a *tech-news and discussion*
 * index, not a web index: the useful signal here is community reception
 * (points, comment counts, discussion URL) rather than page content. Good for
 * "what did developers think about X", bad for anything non-technical or for
 * results published by a specific publisher site.
 *
 * Auth / limits: keyless. Algolia's public HN index is rate limited per IP
 * (a few thousand requests/hour in practice) and the local search cache
 * absorbs repeat queries. No key, no account, no `User-Agent` requirement.
 *
 * Quirks:
 *   - `tags=story` keeps comments out of the result list. Ask/poll/job items
 *     do appear because they are all `story`-tagged.
 *   - `story_text` is only populated for Ask HN / Show HN style self-posts.
 *     Link posts have it empty, so the snippet falls back to a composed
 *     points/comments line.
 *   - `url` is empty for self-posts; those must link to the HN item page.
 *   - Freshness is expressed as a numeric filter on `created_at_i` (unix
 *     seconds). Safe search has no equivalent and is ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, fetchJson, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';

/** Algolia HN search response (only the fields this engine reads). */
interface HnSearchResponse {
  hits?: HnHit[];
  nbHits?: unknown;
}

interface HnHit {
  objectID?: unknown;
  title?: unknown;
  url?: unknown;
  story_text?: unknown;
  points?: unknown;
  num_comments?: unknown;
  author?: unknown;
  created_at?: unknown;
  created_at_i?: unknown;
}

/** Seconds per freshness window, for the `created_at_i` numeric filter. */
const FRESHNESS_SECONDS: Record<string, number> = {
  day: 86_400,
  week: 604_800,
  month: 2_592_000,
  year: 31_536_000,
};

/**
 * Build the Algolia `numericFilters` value for a freshness window, or
 * undefined when the window is unknown (the engine then searches all time).
 */
export function hnNumericFilters(freshness: string | undefined, now = Date.now()): string | undefined {
  if (!freshness) return undefined;
  const seconds = FRESHNESS_SECONDS[freshness];
  if (!seconds) return undefined;
  return `created_at_i>${Math.floor(now / 1000) - seconds}`;
}

/** Map a raw Algolia response onto `RawResult`s. Never throws. */
export function mapHackerNewsResponse(json: unknown, limit: number): RawResult[] {
  const hits = (json as HnSearchResponse | null | undefined)?.hits;
  if (!Array.isArray(hits)) return [];

  const out: RawResult[] = [];
  for (const hit of hits) {
    if (!hit || typeof hit !== 'object') continue;

    const objectID = typeof hit.objectID === 'string' ? hit.objectID.trim() : '';
    const title = typeof hit.title === 'string' ? hit.title.trim() : '';
    // A hit without both an id and a title is not addressable or displayable.
    if (!title || !objectID) continue;

    const externalUrl = typeof hit.url === 'string' ? hit.url.trim() : '';
    const url = externalUrl || `https://news.ycombinator.com/item?id=${encodeURIComponent(objectID)}`;

    const points = typeof hit.points === 'number' ? hit.points : undefined;
    const comments = typeof hit.num_comments === 'number' ? hit.num_comments : undefined;
    const author = typeof hit.author === 'string' ? hit.author.trim() : '';

    const storyText = typeof hit.story_text === 'string' ? stripHtml(hit.story_text) : '';
    const snippet = storyText || composeSnippet(points, comments, author);

    const publishedAt = typeof hit.created_at === 'string' ? parseDateLoose(hit.created_at) : undefined;

    out.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(points !== undefined ? { points } : {}),
        ...(comments !== undefined ? { comments } : {}),
        ...(author ? { author } : {}),
        objectID,
      },
    });
  }
  return cap(out, limit);
}

/** `"412 points · 88 comments · by simonw"`, dropping missing parts. */
export function composeSnippet(points?: number, comments?: number, author?: string): string {
  const parts: string[] = [];
  if (points !== undefined) parts.push(`${points} points`);
  if (comments !== undefined) parts.push(`${comments} comments`);
  if (author) parts.push(`by ${author}`);
  return parts.join(' · ');
}

export function createHackerNewsEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'hackernews',
    label: 'Hacker News',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://news.ycombinator.com/',
    regions: ['global'],
    transport: 'http',
    note: 'Algolia HN index: tech stories and discussion threads, with points and comment counts.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        query,
        hitsPerPage: String(Math.min(Math.max(options.limit, 1), 100)),
        page: '0',
        tags: 'story',
      });
      const numericFilters = hnNumericFilters(options.freshness);
      if (numericFilters) params.set('numericFilters', numericFilters);

      const json = await fetchJson<unknown>(
        { http, config },
        `https://hn.algolia.com/api/v1/search?${params}`,
        { accept: 'application/json', timeoutMs: options.timeoutMs },
      );
      return mapHackerNewsResponse(json, options.limit);
    },
  };
}
