/**
 * Serper — keyed Google SERP results as JSON.
 *
 * What it buys over the keyless defaults: real Google organic results with
 * positions, sitelinks and dates, plus the answer boxes Google renders above
 * them (`answerBox`, `knowledgeGraph`, `peopleAlsoAsk`, `relatedSearches`).
 * Those oneboxes are the difference between "here are ten links" and a direct
 * answer, and they are far more reliable than scraping Google's HTML.
 *
 * Env var: `SERPER_API_KEY`. Create one at https://serper.dev/api-key.
 *
 * Pricing caveat: Serper is prepaid credits (a small one-off free grant, then
 * pay-as-you-go), each search costs one credit or more for advanced parameters,
 * and an exhausted balance simply returns an error — there is no free tier to
 * fall back on.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { EngineError, cap, cleanSnippet, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';

const ID = 'serper';
const KEY_ENV = 'SERPER_API_KEY';
const KEY_URL = 'https://serper.dev/api-key';
const ENDPOINT = 'https://google.serper.dev/search';

/** Serper accepts up to 100 organic results per request. */
const MAX_NUM = 100;

/** Serper expresses freshness with Google's `tbs=qdr:*` filter. */
const FRESHNESS: Record<string, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };

export function createSerperEngine(deps: EngineDeps): SearchEngine {
  const { http } = deps;

  return {
    id: ID,
    label: 'Serper (Google)',
    kind: 'api',
    requiresKey: true,
    keyEnv: KEY_ENV,
    keyUrl: KEY_URL,
    homepage: 'https://serper.dev/',
    regions: ['global'],
    transport: 'http',
    note: 'Google organic results as JSON, including answer boxes, knowledge panels and people-also-ask.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const key = requireKey(deps);

      // Key order mirrors the documented payload; `tbs` is omitted when no
      // freshness window was requested, which is what Google treats as "any time".
      const freshness = options.freshness ? FRESHNESS[options.freshness] : undefined;
      const payload = {
        q: query,
        num: numFor(options.limit),
        gl: countryCode(options.region),
        hl: options.language ?? 'en',
        ...(freshness ? { tbs: freshness } : {}),
      };

      const res = await http.request(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
      });

      return mapSerperResponse(parseBody(res.body, res.status), options.limit);
    },
  };
}

/**
 * Map a `/search` payload onto `RawResult`s.
 *
 * Every `organic` entry becomes a result (`link` -> url, `snippet` -> snippet,
 * `date` -> publishedAt via `parseDateLoose`, `position` -> `meta.position`).
 * The oneboxes (`answerBox`, `knowledgeGraph`, `peopleAlsoAsk`,
 * `relatedSearches`) sit above the result list rather than inside it, so they
 * are attached to the FIRST result only — that gives the orchestrator one place
 * to look for a direct answer. They are ignored when absent, and the whole
 * mapping degrades to plain organic results when there are none.
 */
export function mapSerperResponse(json: unknown, limit: number): RawResult[] {
  const root = asRecord(json);
  const rows = asArray(root?.organic);
  const answerBox = asRecord(root?.answerBox);
  const knowledgeGraph = asRecord(root?.knowledgeGraph);
  const peopleAlsoAsk = mapPeopleAlsoAsk(root?.peopleAlsoAsk);
  const relatedSearches = mapRelatedSearches(root?.relatedSearches);

  const out: RawResult[] = [];
  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;

    const url = str(item.link);
    const title = stripHtml(str(item.title));
    if (!url || !title) continue;

    const snippet = cleanSnippet(stripHtml(str(item.snippet)));
    const publishedAt = parseDateLoose(str(item.date));
    const position = num(item.position);
    const sitelinks = mapSitelinks(item.sitelinks);

    const meta: Record<string, unknown> = {};
    if (position !== undefined) meta.position = position;
    if (sitelinks.length > 0) meta.sitelinks = sitelinks;

    // Oneboxes belong to the query, not to a page: keep them on result #1.
    if (out.length === 0) {
      if (answerBox) meta.answerBox = answerBox;
      if (knowledgeGraph) meta.knowledgeGraph = knowledgeGraph;
      if (peopleAlsoAsk.length > 0) meta.peopleAlsoAsk = peopleAlsoAsk;
      if (relatedSearches.length > 0) meta.relatedSearches = relatedSearches;
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

/** Fail loudly on a missing key so the orchestrator can name the env var. */
function requireKey(deps: EngineDeps): string {
  const key = deps.config.keys.serper;
  if (!key) {
    throw new EngineError(`${ID}: missing API key \u2014 set ${KEY_ENV} (get one at ${KEY_URL})`, { engine: ID });
  }
  return key;
}

/** Serper's per-request ceiling, applied before the body is built. */
function numFor(limit: number): number {
  if (!(limit > 0)) return MAX_NUM;
  return Math.min(limit, MAX_NUM);
}

/** Google expects an uppercase ISO-3166 `gl`; unknown hints fall back to the US. */
function countryCode(region: string | undefined): string {
  const value = (region ?? '').trim();
  return /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : 'US';
}

interface Sitelink {
  title: string;
  link: string;
}

function mapSitelinks(value: unknown): (string | Sitelink)[] {
  const out: (string | Sitelink)[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    if (!record) {
      const text = str(entry);
      if (text) out.push(text);
      continue;
    }
    const title = str(record.title);
    const link = str(record.link);
    if (title || link) out.push({ title, link });
  }
  return out;
}

function mapPeopleAlsoAsk(value: unknown): { question: string; snippet: string; link: string }[] {
  const out: { question: string; snippet: string; link: string }[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    const question = str(record?.question);
    if (!question) continue;
    out.push({ question, snippet: str(record?.snippet), link: str(record?.link) });
  }
  return out;
}

function mapRelatedSearches(value: unknown): string[] {
  const out: string[] = [];
  for (const entry of asArray(value)) {
    const query = str(asRecord(entry)?.query);
    if (query) out.push(query);
  }
  return out;
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
