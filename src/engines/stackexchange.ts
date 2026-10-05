/**
 * Stack Exchange — `search/advanced` API (Stack Overflow by default).
 *
 * What this indexes: questions on the Stack Exchange network, including their
 * answers when a filter asks for the body. This is a *programming Q&A* index:
 * excellent for error messages, API usage and "how do I" questions, useless for
 * news, opinions or non-technical topics.
 *
 * Auth / limits: keyless. Anonymous callers get a 300-request/day quota per IP
 * (`quota_remaining` in every response, exposed here in `meta`); `backoff` in
 * the response means "you were throttled, stop for N seconds". The local search
 * cache absorbs repeat queries. No `User-Agent` requirement.
 *
 * Quirks:
 *   - The transport is gzip and undici decompresses it transparently; do not
 *     add a manual gunzip step, it would corrupt the body.
 *   - The `default` filter deliberately omits `body`, so most responses only
 *     carry metadata and the composed score/answers/tags fallback is what the
 *     user actually sees. A filter that includes `body` makes the richer
 *     snippet path work.
 *   - `creation_date` is unix *seconds* (10 digits); `parseDateLoose` handles it.
 *   - Requested `site` defaults to `stackoverflow`; there is no way to express
 *     freshness or safe search, so both are ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, fetchJson, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';
import { truncate } from '../util/text.js';

/** Stack Exchange `search/advanced` response (only the fields we read). */
interface StackExchangeResponse {
  items?: StackExchangeItem[];
  quota_remaining?: unknown;
  backoff?: unknown;
  error_message?: unknown;
}

interface StackExchangeItem {
  title?: unknown;
  link?: unknown;
  body?: unknown;
  score?: unknown;
  is_answered?: unknown;
  answer_count?: unknown;
  view_count?: unknown;
  creation_date?: unknown;
  tags?: unknown;
  owner?: { display_name?: unknown } | null;
}

/** How much of an answer/question body is worth showing in a search result. */
const BODY_SNIPPET_CHARS = 400;

export function createStackExchangeEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'stackexchange',
    label: 'Stack Exchange',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://stackoverflow.com/',
    regions: ['global'],
    transport: 'http',
    note: 'Stack Overflow / Stack Exchange Q&A search: error messages, API usage, how-to questions.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      // Fixed to Stack Overflow: it is the only site on the network with broad
      // enough coverage to be a useful general-purpose engine.
      const site = 'stackoverflow';
      const params = new URLSearchParams({
        order: 'desc',
        sort: 'relevance',
        q: query,
        site,
        pagesize: String(Math.min(Math.max(options.limit, 1), 100)),
        filter: 'default',
      });

      const json = await fetchJson<unknown>(
        { http, config },
        `https://api.stackexchange.com/2.3/search/advanced?${params}`,
        { accept: 'application/json', timeoutMs: options.timeoutMs },
      );
      return mapStackExchangeResponse(json, options.limit, site);
    },
  };
}

/** Map a raw Stack Exchange response onto `RawResult`s. Never throws. */
export function mapStackExchangeResponse(json: unknown, limit: number, site = 'stackoverflow'): RawResult[] {
  const response = json as StackExchangeResponse | null | undefined;
  const items = response?.items;
  if (!Array.isArray(items)) return [];

  const quota = typeof response?.quota_remaining === 'number' ? response.quota_remaining : undefined;

  const out: RawResult[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const link = typeof item.link === 'string' ? item.link.trim() : '';
    if (!title || !link) continue;

    const score = typeof item.score === 'number' ? item.score : undefined;
    const answers = typeof item.answer_count === 'number' ? item.answer_count : undefined;
    const answered = typeof item.is_answered === 'boolean' ? item.is_answered : undefined;
    const views = typeof item.view_count === 'number' ? item.view_count : undefined;
    const tags = Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === 'string') : [];
    const author = typeof item.owner?.display_name === 'string' ? item.owner.display_name : '';

    const body = typeof item.body === 'string' ? stripHtml(item.body) : '';
    const snippet = body
      ? truncate(body, BODY_SNIPPET_CHARS)
      : composeSnippet(score, answers, tags);

    const publishedAt = item.creation_date !== undefined ? parseDateLoose(String(item.creation_date)) : undefined;

    out.push({
      title,
      url: link,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(score !== undefined ? { score } : {}),
        ...(answers !== undefined ? { answers } : {}),
        ...(answered !== undefined ? { answered } : {}),
        ...(views !== undefined ? { views } : {}),
        ...(tags.length ? { tags } : {}),
        site,
        ...(author ? { author } : {}),
        ...(quota !== undefined ? { quotaRemaining: quota } : {}),
      },
    });
  }
  return cap(out, limit);
}

/** `"score 12 · 3 answers · python, numpy"` — used when the filter has no body. */
export function composeSnippet(score?: number, answers?: number, tags: string[] = []): string {
  const parts: string[] = [];
  if (score !== undefined) parts.push(`score ${score}`);
  if (answers !== undefined) parts.push(`${answers} answer${answers === 1 ? '' : 's'}`);
  if (tags.length) parts.push(tags.join(', '));
  return parts.join(' · ');
}
