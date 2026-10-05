/**
 * Exa — keyed neural/keyword search over an embeddings index.
 *
 * What it buys over the keyless defaults: results are ranked by meaning rather
 * than by term overlap, which is exactly what a long natural-language question
 * needs, and each hit arrives with up to 800 characters of the page body, an
 * author and a publication date. That makes it strong for "find me the page
 * that is about X" queries where keyword engines return SEO listicles.
 *
 * Env var: `EXA_API_KEY`. Create one at
 * https://dashboard.exa.ai/api-keys.
 *
 * Pricing caveat: Exa bills per search plus a separate per-page charge for
 * fetched contents, with a small monthly free credit grant, so requesting a
 * large `numResults` with contents enabled burns credit quickly.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { EngineError, cap, cleanSnippet, parseDateLoose, stripHtml, type EngineDeps } from './kit.js';

const ID = 'exa';
const KEY_ENV = 'EXA_API_KEY';
const KEY_URL = 'https://dashboard.exa.ai/api-keys';
const ENDPOINT = 'https://api.exa.ai/search';

/** Exa accepts up to 100 results per request. */
const MAX_RESULTS = 100;

/** Characters of page text requested per result; keeps the payload small. */
const MAX_CHARACTERS = 800;

export function createExaEngine(deps: EngineDeps): SearchEngine {
  const { http } = deps;

  return {
    id: ID,
    label: 'Exa',
    kind: 'api',
    requiresKey: true,
    keyEnv: KEY_ENV,
    keyUrl: KEY_URL,
    homepage: 'https://exa.ai/',
    regions: ['global'],
    transport: 'http',
    note: 'Semantic index: best for natural-language questions, and it returns page text, authors and dates with every hit.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const key = requireKey(deps);

      const payload = {
        query,
        numResults: numResultsFor(options.limit),
        // `auto` lets Exa pick neural vs keyword ranking per query.
        type: 'auto',
        contents: { text: { maxCharacters: MAX_CHARACTERS } },
      };

      const res = await http.request(ENDPOINT, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'content-type': 'application/json', 'x-api-key': key },
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
      });

      return mapExaResponse(parseBody(res.body, res.status), options.limit);
    },
  };
}

/**
 * Map a `/search` payload onto `RawResult`s.
 *
 * The requested page text (`text`) is preferred as the snippet and falls back
 * to Exa's one-line `summary`, then to the plain `title`/`url` pair when
 * neither is present. `publishedDate` becomes `publishedAt`, and `author` plus
 * Exa's relevance `score` survive in `meta`.
 */
export function mapExaResponse(json: unknown, limit: number): RawResult[] {
  const rows = asArray(asRecord(json)?.results);
  const out: RawResult[] = [];

  for (const row of rows) {
    const item = asRecord(row);
    if (!item) continue;

    const url = str(item.url);
    if (!url) continue;
    // Exa leaves `title` null for some pages; the URL beats dropping the hit.
    const title = stripHtml(str(item.title)) || url;

    const text = cleanSnippet(stripHtml(str(item.text)));
    const summary = text ? '' : cleanSnippet(stripHtml(str(item.summary)));
    const snippet = text || summary;
    const publishedAt = parseDateLoose(str(item.publishedDate));
    const author = str(item.author).trim();
    const score = num(item.score);

    const meta: Record<string, unknown> = {};
    if (author) meta.author = author;
    if (score !== undefined) meta.score = score;

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
  const key = deps.config.keys.exa;
  if (!key) {
    throw new EngineError(`${ID}: missing API key \u2014 set ${KEY_ENV} (get one at ${KEY_URL})`, { engine: ID });
  }
  return key;
}

/** Exa's per-request ceiling, applied before the body is built. */
function numResultsFor(limit: number): number {
  if (!(limit > 0)) return 10;
  return Math.min(limit, MAX_RESULTS);
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
