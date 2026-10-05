/**
 * crates.io — Rust package registry search API.
 *
 * What this indexes: published crates from the official Rust registry, with
 * version, description, total and recent download counts and repository link.
 * It is a *package registry* index: it answers "does a crate exist for X and is
 * it maintained", not "how do I use it" — docs live on docs.rs and the
 * repository.
 *
 * Auth / limits: keyless for search. crates.io **requires a descriptive
 * `User-Agent`** and returns 403 to clients that send a generic one, so this
 * engine overrides the default UA with a project-specific string including a
 * contact URL. There is no published numeric rate limit for search, but the
 * registry asks clients to be modest; the local search cache absorbs repeat
 * queries.
 *
 * Quirks:
 *   - `per_page` is capped at 100 by the API; larger values are rejected.
 *   - `max_version` is the highest semver published, which can be a prerelease,
 *     while `newest_version` is the newest upload — `max_version` is what is
 *     shown because it is what `cargo add` resolves to.
 *   - `recent_downloads` is a 90-day count and is `null` for very new crates.
 *   - `updated_at` carries nanosecond precision (`...:35.828655Z`); the shared
 *     `parseDateLoose` helper only reads ISO strings down to whole seconds, so
 *     `publishedAt` is accurate to the second — which is all a search result
 *     needs.
 *   - There is no freshness or safe-search parameter; `updated_at` is reported
 *     as `publishedAt` and freshness windows are ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, fetchJson, parseDateLoose, type EngineDeps } from './kit.js';

/**
 * crates.io blocks generic user agents; this identifies the tool and links to
 * its repository so the registry can contact us instead of blackholing us.
 */
export const CRATES_USER_AGENT = 'free-search-mcp/0.1.0 (+https://github.com/sweetcornna/free-search-mcp)';

interface CratesResponse {
  crates?: CrateRecord[];
  meta?: { total?: unknown };
}

interface CrateRecord {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  max_version?: unknown;
  newest_version?: unknown;
  downloads?: unknown;
  recent_downloads?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  homepage?: unknown;
  repository?: unknown;
  documentation?: unknown;
}

export function createCratesEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'crates',
    label: 'crates.io',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://crates.io/',
    regions: ['global'],
    transport: 'http',
    note: 'Rust crate registry search: versions, download counts and repository links.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        q: query,
        per_page: String(Math.min(Math.max(options.limit, 1), 100)),
      });

      const json = await fetchJson<unknown>({ http, config }, `https://crates.io/api/v1/crates?${params}`, {
        accept: 'application/json',
        timeoutMs: options.timeoutMs,
        userAgent: CRATES_USER_AGENT,
      });
      return mapCratesResponse(json, options.limit);
    },
  };
}

/** Map a raw crates.io search response onto `RawResult`s. Never throws. */
export function mapCratesResponse(json: unknown, limit: number): RawResult[] {
  const crates = (json as CratesResponse | null | undefined)?.crates;
  if (!Array.isArray(crates)) return [];
  const total = typeof (json as CratesResponse).meta?.total === 'number' ? (json as CratesResponse).meta!.total : undefined;

  const out: RawResult[] = [];
  for (const crate of crates) {
    if (!crate || typeof crate !== 'object') continue;
    const name = firstString(crate.name) || firstString(crate.id);
    if (!name) continue;

    const version = firstString(crate.max_version) || firstString(crate.newest_version);
    const description = firstString(crate.description);
    const downloads = typeof crate.downloads === 'number' ? crate.downloads : undefined;
    const recentDownloads = typeof crate.recent_downloads === 'number' ? crate.recent_downloads : undefined;
    const repository = firstString(crate.repository);
    const homepage = firstString(crate.homepage);
    const documentation = firstString(crate.documentation);

    const publishedAt = parseDateLoose(firstString(crate.updated_at));
    const snippet = buildSnippet(description, version, recentDownloads);

    out.push({
      title: name,
      url: `https://crates.io/crates/${name}`,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        ...(version ? { version } : {}),
        ...(downloads !== undefined ? { downloads } : {}),
        ...(recentDownloads !== undefined ? { recentDownloads } : {}),
        ...(repository ? { repository } : {}),
        ...(homepage ? { homepage } : {}),
        ...(documentation ? { documentation } : {}),
        ...(total !== undefined ? { total } : {}),
      },
    });
  }
  return cap(out, limit);
}

/** `"<description> · v0.2.2 · 1978 recent downloads"`, dropping missing parts. */
export function buildSnippet(description: string, version: string, recentDownloads?: number): string {
  const parts: string[] = [];
  if (description) parts.push(description);
  if (version) parts.push(`v${version}`);
  if (recentDownloads !== undefined) parts.push(`${recentDownloads} recent downloads`);
  return parts.join(' · ');
}

function firstString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
