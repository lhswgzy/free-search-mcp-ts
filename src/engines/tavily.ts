/**
 * Tavily — keyed, LLM-oriented search.
 *
 * What it buys over the keyless defaults: every result already carries the
 * extracted page content (not just a SERP snippet), a relevance `score`, a
 * publication date, and Tavily synthesises a direct `answer` for the query —
 * so an agent often does not need to fetch anything at all. Its `news` topic
 * with a `days` window is a genuinely better recency filter than the scraped
 * engines can express.
 *
 * Env var: `TAVILY_API_KEY`. Create one at https://app.tavily.com/home.
 *
 * Pricing caveat: Tavily is credit-metered with a modest monthly free
 * allowance (roughly a thousand basic searches) and `advanced` depth costs more
 * credits per call, which is why this engine stays on `basic` depth.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { EngineError, cap, cleanSnippet, parseDateLoose, type EngineDeps } from './kit.js';

const ID = 'tavily';
const KEY_ENV = 'TAVILY_API_KEY';
const KEY_URL = 'https://app.tavily.com/home';
const ENDPOINT = 'https://api.tavily.com/search';

/** Tavily returns at most 20 results per request. */
const MAX_RESULTS = 20;

/** Snippets are capped before they reach the fusion layer's token budget. */
const SNIPPET_MAX = 600;

/**
 * Tavily's `days` window is only honoured on the `news` topic, so a freshness
 * request switches the topic as well. Values are the documented buckets.
 */
const FRESHNESS_DAYS: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };

export function createTavilyEngine(deps: EngineDeps): SearchEngine {
  const { http } = deps;

  return {
    id: ID,
    label: 'Tavily',
    kind: 'api',
    requiresKey: true,
    keyEnv: KEY_ENV,
    keyUrl: KEY_URL,
    homepage: 'https://tavily.com/',
    regions: ['global'],
    transport: 'http',
    note: 'Returns extracted page content plus a synthesised answer; its news topic gives the best recency filter of any engine here.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const key = requireKey(deps);

      const days = options.freshness ? FRESHNESS_DAYS[options.freshness] : undefined;
      const payload = {
        query,
        max_results: maxResultsFor(options.limit),
        search_depth: 'basic',
        // `general` searches the whole index; `news` is the only topic that
        // accepts `days`, so a freshness request implies it.
        topic: days ? 'news' : 'general',
        ...(days ? { days } : {}),
        include_answer: true,
        // Raw content would bloat the response; the fetcher gets it when needed.
        include_raw_content: false,
      };

      const res = await http.request(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
      });

      return mapTavilyResponse(parseBody(res.body, res.status), options.limit);
    },
  };
}

/**
 * Map a `/search` payload onto `RawResult`s.
 *
 * `content` is already extracted page text, so it is used as the snippet and
 * truncated to {@link SNIPPET_MAX} characters; `score` is preserved in
 * `meta.score` because it is Tavily's own relevance signal. The synthesised
 * `answer` is query-level rather than page-level, so it is attached to the
 * FIRST result only (and dropped when there are no results to attach it to).
 */
export function mapTavilyResponse(json: unknown, limit: number): RawResult[] {
  const root = asRecord(json);
  const rows = asArray(root?.results);
  const answer = str(root?.answer).trim();
  const out: RawResult[] = [];

  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;

    const url = str(item.url);
    const title = stripTags(str(item.title));
    if (!url || !title) continue;

    const content = cleanSnippet(str(item.content), SNIPPET_MAX);
    const publishedAt = parseDateLoose(str(item.published_date));
    const score = num(item.score);

    const meta: Record<string, unknown> = {};
    if (score !== undefined) meta.score = score;
    if (out.length === 0 && answer) meta.answer = answer;

    out.push({
      title,
      url,
      ...(content ? { snippet: content } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }

  return cap(out, limit);
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/** Fail loudly on a missing key so the orchestrator can name the env var. */
function requireKey(deps: EngineDeps): string {
  const key = deps.config.keys.tavily;
  if (!key) {
    throw new EngineError(`${ID}: missing API key \u2014 set ${KEY_ENV} (get one at ${KEY_URL})`, { engine: ID });
  }
  return key;
}

/** Tavily's per-request ceiling, applied before the body is built. */
function maxResultsFor(limit: number): number {
  if (!(limit > 0)) return MAX_RESULTS;
  return Math.min(limit, MAX_RESULTS);
}

/** Tavily titles are plain text today, but the guard is cheap and harmless. */
function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Parse a JSON body, converting a malformed payload into a clear engine error. */
function parseBody(body: string, status: number): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch (err) {
    throw new EngineError(`${ID}: malformed JSON response (HTTP ${status}): ${(err as Error).message}`, {
      engine: ID,
      status,
      cause: err,
    });
  }
}

/* ------------------------------------------------------------------ *
 * Untyped-JSON narrowing helpers
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
