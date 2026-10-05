/**
 * GitHub — repository search API.
 *
 * What this indexes: GitHub repositories only (`/search/repositories`). It is a
 * *code-hosting* index: you get project pages with stars, forks, language and
 * topics, not READMEs, issues, blog posts or documentation prose. Use it for
 * "which library does X", "most popular Y client", and never for general facts.
 *
 * Auth / limits: keyless, but unauthenticated search is limited to roughly
 * **10 requests per minute** per IP (and 60/hour core). The local search cache
 * absorbs repeat queries, and the shared HTTP client retries a 429 with
 * backoff, but a cold burst of GitHub queries can still be throttled — that is
 * reported as a block rather than as "0 results". Supplying a token through the
 * usual GitHub env vars is not supported by this engine, on purpose: it stays
 * key-free.
 *
 * Quirks:
 *   - `sort=stars&order=desc` makes the ranking popularity-based rather than
 *     relevance-based; that is deliberate, because a zero-star exact match is
 *     rarely what an agent wants.
 *   - `description` may be null, and `pushed_at` (last commit) is a far better
 *     freshness signal than `updated_at` (any metadata write).
 *   - Errors come back as `{ message: "API rate limit exceeded..." }` with a
 *     403/429 status. `fetchJson` already throws on a 403/429, so the body
 *     check below only matters when GitHub returns a 200 with an error object.
 *   - No freshness or safe-search parameter; `pushed_at` is the only date we
 *     report and freshness windows are ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { EngineError, cap, fetchJson, parseDateLoose, type EngineDeps } from './kit.js';

/** Only the repository fields this engine reads. */
interface GitHubSearchResponse {
  total_count?: unknown;
  message?: unknown;
  items?: GitHubRepo[];
}

interface GitHubRepo {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  stargazers_count?: unknown;
  forks_count?: unknown;
  language?: unknown;
  updated_at?: unknown;
  pushed_at?: unknown;
  owner?: { login?: unknown } | null;
  topics?: unknown;
  license?: { spdx_id?: unknown } | null;
}

export function createGitHubEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'github',
    label: 'GitHub',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://github.com/',
    regions: ['global'],
    transport: 'http',
    note: 'Repository search (stars/forks/language). Keyless, ~10 requests/minute unauthenticated.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        q: query,
        per_page: String(Math.min(Math.max(options.limit, 1), 100)),
        sort: 'stars',
        order: 'desc',
      });

      const json = await fetchJson<unknown>({ http, config }, `https://api.github.com/search/repositories?${params}`, {
        accept: 'application/vnd.github+json',
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        timeoutMs: options.timeoutMs,
      });

      // GitHub reports throttling in the body on some plans/paths instead of
      // (or in addition to) a non-2xx status.
      const message = typeof (json as GitHubSearchResponse | null)?.message === 'string'
        ? (json as GitHubSearchResponse).message as string
        : '';
      if (message && /rate limit|abuse|secondary rate/i.test(message)) {
        throw new EngineError('github: rate limited by the GitHub API', { engine: 'github', blocked: true });
      }
      if (message && !Array.isArray((json as GitHubSearchResponse | null)?.items)) {
        throw new EngineError(`github: API error: ${message}`, { engine: 'github' });
      }

      return mapGitHubResponse(json, options.limit);
    },
  };
}

/** Map a raw `/search/repositories` response onto `RawResult`s. Never throws. */
export function mapGitHubResponse(json: unknown, limit: number): RawResult[] {
  const items = (json as GitHubSearchResponse | null | undefined)?.items;
  if (!Array.isArray(items)) return [];

  const out: RawResult[] = [];
  for (const repo of items) {
    if (!repo || typeof repo !== 'object') continue;
    const fullName = typeof repo.full_name === 'string' ? repo.full_name.trim() : '';
    const url = typeof repo.html_url === 'string' && repo.html_url.trim()
      ? repo.html_url.trim()
      : fullName
        ? `https://github.com/${fullName}`
        : '';
    if (!fullName || !url) continue;

    const description = typeof repo.description === 'string' ? repo.description.trim() : '';
    const stars = typeof repo.stargazers_count === 'number' ? repo.stargazers_count : undefined;
    const forks = typeof repo.forks_count === 'number' ? repo.forks_count : undefined;
    const language = typeof repo.language === 'string' ? repo.language.trim() : '';
    const owner = typeof repo.owner?.login === 'string' ? repo.owner.login : '';
    const license = typeof repo.license?.spdx_id === 'string' ? repo.license.spdx_id : '';
    const pushedAt = typeof repo.pushed_at === 'string' ? repo.pushed_at : '';
    const updatedAt = typeof repo.updated_at === 'string' ? repo.updated_at : '';
    const snippet = buildSnippet(description, stars, language, updatedAt);
    const publishedAt = parseDateLoose(pushedAt);

    out.push({
      title: fullName,
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(stars !== undefined ? { stars } : {}),
        ...(forks !== undefined ? { forks } : {}),
        ...(language ? { language } : {}),
        ...(owner ? { owner } : {}),
        ...(license ? { license } : {}),
      },
    });
  }
  return cap(out, limit);
}

/**
 * `"<description> · ★1234 · TypeScript · updated 2024-05-01"`, dropping the
 * parts the repository does not have.
 */
export function buildSnippet(
  description: string,
  stars: number | undefined,
  language: string,
  updatedAt: string,
): string {
  const parts: string[] = [];
  if (description) parts.push(description);
  if (stars !== undefined) parts.push(`★${stars}`);
  if (language) parts.push(language);
  if (updatedAt) parts.push(`updated ${updatedAt.slice(0, 10)}`);
  return parts.join(' · ');
}
