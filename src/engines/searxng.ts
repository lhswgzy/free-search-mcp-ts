/**
 * SearXNG — keyless JSON API against user-supplied instances.
 *
 * SearXNG is a self-hostable metasearch front end. There is no canonical public
 * instance, so the base URL comes from configuration: `config.keys.searxng`,
 * which `loadConfig` fills from `SEARXNG_URL` or `FREE_SEARCH_SEARXNG_URL`.
 * A comma- or whitespace-separated list is accepted and every instance is tried
 * in order until one returns usable JSON.
 *
 * Most public instances disable the JSON output for abuse reasons and answer
 * `403` with an HTML error page. That is an instance failure, not an engine
 * failure: the next instance is tried, and only when all of them fail does the
 * engine throw. The error message names the setting the operator has to change.
 *
 * Honoured options: `limit`, `timeoutMs`, `language` (`language`),
 * `safeSearch` (`safesearch=0|1|2`) and `freshness` (`time_range`). `region` is
 * silently ignored: SearXNG's own region selection is not exposed through the
 * search API.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import {
  EngineError,
  cap,
  cleanSnippet,
  fetchJson,
  parseDateLoose,
  stripHtml,
  type EngineDeps,
} from './kit.js';
import { normalizeUrl } from '../util/url.js';

const HOME = 'https://docs.searxng.org/';

const SAFE_SEARCH: Record<string, string> = { off: '0', moderate: '1', strict: '2' };
const FRESHNESS: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };

/** One entry of the `results` array in a SearXNG JSON response. */
interface SearxngResult {
  url?: string;
  title?: string;
  content?: string;
  engine?: string;
  category?: string;
  score?: number;
  publishedDate?: string | null;
}

/** The subset of the SearXNG response this engine reads. */
interface SearxngResponse {
  results?: SearxngResult[];
  number_of_results?: number;
  suggestions?: string[];
  unresponsive_engines?: unknown[];
}

export function createSearxngEngine({ http, config }: EngineDeps): SearchEngine {
  const deps: EngineDeps = { http, config };

  return {
    id: 'searxng',
    label: 'SearXNG',
    kind: 'api',
    requiresKey: false,
    keyEnv: 'SEARXNG_URL',
    homepage: HOME,
    regions: ['global'],
    transport: 'http',
    note: 'Needs an instance URL (SEARXNG_URL); JSON output must be enabled on the instance.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const instances = parseInstances(config.keys.searxng);
      if (instances.length === 0) {
        throw new EngineError('searxng: set SEARXNG_URL (or FREE_SEARCH_SEARXNG_URL) to your instance URL', {
          engine: 'searxng',
        });
      }

      const results = await searchInstances(deps, instances, query, options);
      return cap(results, options.limit);
    },
  };
}

/** Split a configured instance list into normalised `https://host` bases. */
function parseInstances(value: string | undefined): string[] {
  const raw = (value ?? '').trim();
  if (!raw) return [];
  const out: string[] = [];
  for (const token of raw.split(/[,\s]+/)) {
    const instance = normalizeInstance(token);
    if (instance && !out.includes(instance)) out.push(instance);
  }
  return out;
}

/** Add a scheme when missing and drop any trailing slash or `/search` suffix. */
function normalizeInstance(token: string): string | null {
  const trimmed = token.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname.replace(/\/+$/, '').replace(/\/search$/i, '');
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

/** Build the JSON search URL for one instance. */
function buildUrl(base: string, query: string, options: EngineSearchOptions): string {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    categories: 'general',
    pageno: '1',
  });
  const language = (options.language ?? '').trim();
  if (language) params.set('language', language);
  if (options.safeSearch && SAFE_SEARCH[options.safeSearch]) {
    params.set('safesearch', SAFE_SEARCH[options.safeSearch]!);
  }
  if (options.freshness && FRESHNESS[options.freshness]) {
    params.set('time_range', FRESHNESS[options.freshness]!);
  }
  return `${base}/search?${params.toString()}`;
}

/**
 * Walk the instance list until one answers with JSON.
 *
 * A per-instance failure (network error, HTML 403 page, malformed payload) is
 * recorded and the next instance is tried; only an exhausted list is fatal.
 */
async function searchInstances(
  deps: EngineDeps,
  instances: string[],
  query: string,
  options: EngineSearchOptions,
): Promise<RawResult[]> {
  const failures: string[] = [];

  for (const instance of instances) {
    try {
      const payload = await fetchJson<SearxngResponse>(deps, buildUrl(instance, query, options), {
        timeoutMs: options.timeoutMs,
      });
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        failures.push(`${instance}: unexpected JSON shape`);
        continue;
      }
      const results = mapResults(payload.results ?? [], instance);
      if (results.length === 0) {
        // A JSON answer with no rows is a legitimate empty result set *only* if
        // the instance really answered the query; an empty `results` key plus no
        // `number_of_results` is what a disabled API returns instead of a 403.
        if (payload.results === undefined && payload.number_of_results === undefined) {
          failures.push(`${instance}: JSON without a "results" key (JSON API likely disabled)`);
          continue;
        }
        return [];
      }
      return results;
    } catch (err) {
      failures.push(`${instance}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new EngineError(
    `searxng: no instance returned JSON — enable \`format: json\` in your instance settings (tried ${failures.join('; ')})`,
    { engine: 'searxng' },
  );
}

/** Map the SearXNG result array onto `RawResult`. */
function mapResults(results: SearxngResult[], instance: string): RawResult[] {
  const out: RawResult[] = [];
  const seen = new Set<string>();

  for (const item of results) {
    const rawUrl = (item.url ?? '').trim();
    if (!rawUrl) continue;
    const normalized = normalizeUrl(rawUrl.startsWith('http') ? rawUrl : `${instance}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`);
    if (!normalized || seen.has(normalized.key)) continue;

    const title = stripHtml(item.title ?? '');
    if (!title) continue;

    const snippet = cleanSnippet(stripHtml(item.content ?? ''));
    const publishedAt = parseDateLoose(item.publishedDate ?? undefined);
    const meta: Record<string, unknown> = {};
    if (item.engine) meta.sourceEngine = item.engine;
    if (typeof item.score === 'number' && Number.isFinite(item.score)) meta.score = item.score;
    if (item.category) meta.category = item.category;

    seen.add(normalized.key);
    out.push({
      title,
      url: normalized.url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    });
  }

  return out;
}
