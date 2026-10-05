/**
 * Google Programmable Search (Custom Search JSON API) — keyed Google results.
 *
 * What it buys over the keyless defaults: Google's own index over a documented
 * JSON contract, so no consent interstitial, no `sorry/` block page and no
 * selector drift — just `items[]` with titles, links, snippets and the page's
 * `pagemap` metadata (publication time, site name). Search the entire web by
 * pointing the engine at a "search the entire web" programmable engine.
 *
 * Env vars: `GOOGLE_CSE_KEY` (the API key) and `GOOGLE_CSE_CX` (the search
 * engine id); both are required. Create the key in the Google Cloud console and
 * the engine id at https://programmablesearchengine.google.com/ (the docs live
 * at https://developers.google.com/custom-search/v1/overview).
 *
 * Pricing caveat: the free tier is 100 queries per day for the whole project
 * and paid queries cost about $5 per 1000 on top of that, so a 429 body here
 * means the daily allowance is gone until midnight Pacific.
 *
 * Note on `num`: the JSON API returns at most 10 items per request (only the
 * paid "site-restricted" XML API goes higher), so the requested limit is
 * clamped to 10 and the remainder is left to the fusion layer to fill from
 * other engines. Deeper paging would need `start` plus an extra round trip,
 * which is not worth the quota here.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { EngineError, cap, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';

const ID = 'google-cse';
const KEY_ENV = 'GOOGLE_CSE_KEY';
const CX_ENV = 'GOOGLE_CSE_CX';
const KEY_URL = 'https://developers.google.com/custom-search/v1/overview';
const ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

/** Hard per-request ceiling of the JSON API. */
const MAX_NUM = 10;

/** Google's only two safe-search values; `strict` and `moderate` both map to `active`. */
const SAFE_SEARCH: Record<string, string> = { off: 'off', moderate: 'active', strict: 'active' };

/** Google's `dateRestrict` buckets: d1/w1/m1/y1. */
const DATE_RESTRICT: Record<string, string> = { day: 'd1', week: 'w1', month: 'm1', year: 'y1' };

/**
 * Google answers errors (bad key, disabled API, exhausted quota) with a JSON
 * body and a 4xx status. The HTTP client would normally throw before we could
 * read it, so these statuses are accepted and inspected below.
 */
const ERROR_STATUSES = [400, 403, 429];

export function createGoogleCseEngine(deps: EngineDeps): SearchEngine {
  const { http, config } = deps;

  return {
    id: ID,
    label: 'Google Programmable Search',
    kind: 'api',
    requiresKey: true,
    keyEnv: KEY_ENV,
    keyUrl: KEY_URL,
    homepage: 'https://programmablesearchengine.google.com/',
    regions: ['global'],
    transport: 'http',
    note: 'Google results as JSON via a Programmable Search engine; needs both an API key and an engine id (cx), and 10 results per call.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const { key, cx } = requireCredentials(config);

      const params = new URLSearchParams({
        key,
        cx,
        q: query,
        num: String(numFor(options.limit)),
        start: '1',
        hl: options.language ?? 'en',
        gl: countryCode(options.region),
      });

      const safe = options.safeSearch ? SAFE_SEARCH[options.safeSearch] : undefined;
      if (safe) params.set('safe', safe);

      const dateRestrict = options.freshness ? DATE_RESTRICT[options.freshness] : undefined;
      if (dateRestrict) params.set('dateRestrict', dateRestrict);

      const res = await http.request(`${ENDPOINT}?${params}`, {
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
        // Read Google's own error payload instead of a bare `HTTP 400`.
        acceptStatuses: ERROR_STATUSES,
      });

      const json = parseBody(res.body, res.status);
      throwGoogleError(json, res.status);
      return mapGoogleCseResponse(json, options.limit);
    },
  };
}

/**
 * Map a `customsearch/v1` payload onto `RawResult`s.
 *
 * Dates come from `pagemap.metatags[0]['article:published_time']` (the only
 * place Google exposes one) and are normalised with `parseDateLoose`;
 * `displayLink` and `og:site_name` are kept in `meta` so the formatter can show
 * a breadcrumb and a site name instead of guessing from the URL. The
 * `searchInformation` totals are attached to the FIRST result only, which lets
 * the orchestrator distinguish "no results exist" from "the key is broken".
 */
export function mapGoogleCseResponse(json: unknown, limit: number): RawResult[] {
  const root = asRecord(json);
  const rows = asArray(root?.items);
  const info = asRecord(root?.searchInformation);
  const totalResults = info ? str(info.totalResults) : '';
  const formattedTotalResults = info ? str(info.formattedTotalResults) : '';

  const out: RawResult[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;

    const url = str(item.link);
    const title = stripHtml(str(item.title));
    if (!url || !title) continue;

    const snippet = stripHtml(str(item.snippet));
    const displayLink = str(item.displayLink);
    const siteName = metaTag(item.pagemap, 'og:site_name');
    const publishedAt = parseDateLoose(metaTag(item.pagemap, 'article:published_time'));

    const meta: Record<string, unknown> = {};
    if (displayLink) meta.displayLink = displayLink;
    if (siteName) meta.siteName = siteName;
    if (out.length === 0) {
      if (totalResults) meta.totalResults = totalResults;
      if (formattedTotalResults) meta.formattedTotalResults = formattedTotalResults;
    }

    out.push({
      title,
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    });
  }

  return cap(out, limit);
}

/* ------------------------------------------------------------------ *
 * Internals
 * ------------------------------------------------------------------ */

/**
 * Both halves of the credential are mandatory: a key without a `cx` cannot
 * search, and the error has to name whichever half is missing.
 */
function requireCredentials(config: EngineDeps['config']): { key: string; cx: string } {
  const key = config.keys.googleCse?.key;
  const cx = config.keys.googleCse?.cx;
  if (!key || !cx) {
    const missing = [!key ? KEY_ENV : '', !cx ? CX_ENV : ''].filter(Boolean).join(' and ');
    throw new EngineError(`${ID}: missing API key \u2014 set ${missing} (get one at ${KEY_URL})`, { engine: ID });
  }
  return { key, cx };
}

/** The JSON API's per-request ceiling, applied before the URL is built. */
function numFor(limit: number): number {
  if (!(limit > 0)) return MAX_NUM;
  return Math.min(limit, MAX_NUM);
}

/** Google wants a lowercase ISO-3166 `gl`; unknown hints fall back to the US. */
function countryCode(region: string | undefined): string {
  const value = (region ?? '').trim();
  return /^[a-z]{2}$/i.test(value) ? value.toLowerCase() : 'us';
}

/**
 * Read one `pagemap.metatags` key. Google normally sends an array with a single
 * object, but a bare object shows up for some engines, so both shapes are read.
 */
function metaTag(pagemap: unknown, name: string): string {
  const tags = asRecord(pagemap)?.metatags;
  const first = Array.isArray(tags) ? asRecord(tags[0]) : asRecord(tags);
  return str(first?.[name]);
}

/** Turn Google's JSON error body into a clear engine error. */
function throwGoogleError(json: unknown, status: number): void {
  const error = asRecord(asRecord(json)?.error);
  if (!error) {
    if (status >= 400) throw new EngineError(`${ID}: HTTP ${status}`, { engine: ID, status });
    return;
  }

  const code = num(error.code) ?? status;
  const message = str(error.message) || `HTTP ${code}`;
  if (code === 429 || status === 429) {
    throw new EngineError(`${ID}: quota exceeded`, { engine: ID, blocked: true, status: 429 });
  }
  throw new EngineError(`${ID}: ${message} (HTTP ${code})`, { engine: ID, status: code });
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
