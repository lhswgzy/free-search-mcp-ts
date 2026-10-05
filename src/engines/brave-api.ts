/**
 * Brave Search API — the keyed counterpart of the keyless HTML engines.
 *
 * What it buys over the keyless defaults: an independent, documented index
 * reached over a stable JSON contract, so there is no captcha, no consent
 * interstitial and no markup drift to break; it accepts real `count`, `country`
 * and `search_lang` parameters, a `freshness` window and a safe-search level,
 * and it reports a publication date (`page_age`/`age`) on most results.
 *
 * Env var: `BRAVE_API_KEY`. Create one (and see the current quota) at
 * https://api-dashboard.search.brave.com/app/keys.
 *
 * Pricing caveat: the free tier is a small monthly query allowance with a
 * per-second rate cap and a metered paid tier above it, so a 429 here means
 * "quota exhausted" rather than "transient blip" — treat it as a block.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { EngineError, cap, cleanSnippet, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';

const ID = 'brave-api';
const KEY_ENV = 'BRAVE_API_KEY';
const KEY_URL = 'https://api-dashboard.search.brave.com/app/keys';
const ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

/** Brave rejects `count` above 20 on `/res/v1/web/search`; fusion covers the rest. */
const MAX_COUNT = 20;

/** Brave freshness codes: past day / week / month / year. */
const FRESHNESS: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };

/** Brave accepts exactly these three safe-search values. */
const SAFE_SEARCH: Record<string, string> = { off: 'off', moderate: 'moderate', strict: 'strict' };

export function createBraveApiEngine(deps: EngineDeps): SearchEngine {
  const { http } = deps;

  return {
    id: ID,
    label: 'Brave Search API',
    kind: 'api',
    requiresKey: true,
    keyEnv: KEY_ENV,
    keyUrl: KEY_URL,
    homepage: 'https://brave.com/search/api/',
    regions: ['global'],
    transport: 'http',
    note: 'Brave\u2019s own index over a documented API: real freshness and safe-search parameters, no scraping, no captchas.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const key = requireKey(deps);

      // Request parameters live in the path, not a body: Brave is a GET API.
      const params = new URLSearchParams({ q: query, count: String(countFor(options.limit)) });
      // A `global` region hint has no ISO code, in which case Brave picks the market.
      const country = countryCode(options.region);
      if (country) params.set('country', country);
      params.set('search_lang', options.language ?? 'en');

      const safeSearch = options.safeSearch ? SAFE_SEARCH[options.safeSearch] : undefined;
      if (safeSearch) params.set('safesearch', safeSearch);

      const freshness = options.freshness ? FRESHNESS[options.freshness] : undefined;
      if (freshness) params.set('freshness', freshness);

      const res = await http.request(`${ENDPOINT}?${params}`, {
        headers: {
          'x-subscription-token': key,
          // Brave documents gzip as supported and answers much faster with it.
          'accept-encoding': 'gzip',
        },
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
      });

      return mapBraveResponse(parseBody(res.body, res.status), options.limit);
    },
  };
}

/**
 * Map a `/res/v1/web/search` payload onto `RawResult`s.
 *
 * Exported separately from the factory so the mapping can be unit-tested
 * against a recorded response without any network access.
 *
 * Brave decorates `title`/`description` with `<strong>` highlight tags, so both
 * are passed through `stripHtml`. `page_age` is preferred over the human `age`
 * ("2 weeks ago") because it is already absolute.
 */
export function mapBraveResponse(json: unknown, limit: number): RawResult[] {
  const web = asRecord(asRecord(json)?.web);
  const rows = asArray(web?.results);
  const out: RawResult[] = [];

  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;

    const url = str(item.url);
    const title = stripHtml(str(item.title));
    if (!url || !title) continue;

    const snippet = stripHtml(str(item.description));
    const publishedAt = parseDateLoose(str(item.page_age) || str(item.age));
    const publisher = str(asRecord(item.profile)?.long_name);
    const language = str(item.language);

    const meta: Record<string, unknown> = {};
    if (publisher) meta.publisher = publisher;
    if (language) meta.language = language;

    out.push({
      title,
      url,
      ...(snippet ? { snippet: cleanSnippet(snippet) } : {}),
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
  const key = deps.config.keys.brave;
  if (!key) {
    throw new EngineError(`${ID}: missing API key \u2014 set ${KEY_ENV} (get one at ${KEY_URL})`, { engine: ID });
  }
  return key;
}

/** Brave's per-request ceiling, applied before the URL is built. */
function countFor(limit: number): number {
  if (!(limit > 0)) return MAX_COUNT;
  return Math.min(limit, MAX_COUNT);
}

/**
 * Brave wants an uppercase ISO-3166 country code. Anything that is not a
 * two-letter code (for example a `global` hint) is left out so the request is
 * not rejected; the default market is the US.
 */
function countryCode(region: string | undefined): string | undefined {
  const value = (region ?? '').trim();
  if (/^[a-z]{2}$/i.test(value)) return value.toUpperCase();
  return value.toLowerCase() === 'global' ? undefined : 'US';
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
