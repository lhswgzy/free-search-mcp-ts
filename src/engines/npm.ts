/**
 * npm — registry search API (`registry.npmjs.org/-/v1/search`).
 *
 * What this indexes: published npm packages only, ranked by npm's own search
 * score (popularity, quality, maintenance). It is a *package registry* index:
 * a hit tells you a library exists and how healthy it looks, not how to use it.
 * READMEs, changelogs and docs are not in the index and need a follow-up fetch
 * of the package page or repository.
 *
 * Auth / limits: keyless and unmetered in practice. The registry asks that
 * clients identify themselves; the shared HTTP layer sends a normal
 * `User-Agent`. The local search cache absorbs repeat queries.
 *
 * Quirks:
 *   - `score.final` is a relative ranking weight, not a rating percentage — it
 *     is only meaningful when comparing results from the same query.
 *   - `downloads` is optional and can lag behind the published version; both
 *     weekly and monthly counts are carried in `meta`.
 *   - `links.npm` can be missing for a few old packages, so the canonical
 *     `https://www.npmjs.com/package/<name>` URL is used as a fallback.
 *   - There is no freshness or safe-search parameter; `date` (last publish) is
 *     reported as `publishedAt` and freshness windows are ignored.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, fetchJson, parseDateLoose, type EngineDeps } from './kit.js';

interface NpmSearchResponse {
  objects?: NpmSearchObject[];
  total?: unknown;
}

interface NpmSearchObject {
  package?: NpmPackage | null;
  score?: { final?: unknown; detail?: { popularity?: unknown; quality?: unknown; maintenance?: unknown } } | null;
  downloads?: { weekly?: unknown; monthly?: unknown } | null;
  updated?: unknown;
}

interface NpmPackage {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  date?: unknown;
  keywords?: unknown;
  publisher?: { username?: unknown } | null;
  links?: { npm?: unknown; homepage?: unknown; repository?: unknown } | null;
}

export function createNpmEngine({ http, config }: EngineDeps): SearchEngine {
  return {
    id: 'npm',
    label: 'npm',
    kind: 'api',
    requiresKey: false,
    homepage: 'https://www.npmjs.com/',
    regions: ['global'],
    transport: 'http',
    note: 'npm registry search: JavaScript/TypeScript packages with versions, download counts and quality scores.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const params = new URLSearchParams({
        text: query,
        size: String(Math.min(Math.max(options.limit, 1), 250)),
      });

      const json = await fetchJson<unknown>(
        { http, config },
        `https://registry.npmjs.org/-/v1/search?${params}`,
        { accept: 'application/json', timeoutMs: options.timeoutMs },
      );
      return mapNpmResponse(json, options.limit);
    },
  };
}

/** Map a raw npm search response onto `RawResult`s. Never throws. */
export function mapNpmResponse(json: unknown, limit: number): RawResult[] {
  const objects = (json as NpmSearchResponse | null | undefined)?.objects;
  if (!Array.isArray(objects)) return [];
  const total = typeof (json as NpmSearchResponse).total === 'number' ? (json as NpmSearchResponse).total : undefined;

  const out: RawResult[] = [];
  for (const object of objects) {
    if (!object || typeof object !== 'object') continue;
    const pkg = object.package;
    if (!pkg || typeof pkg !== 'object') continue;

    const name = typeof pkg.name === 'string' ? pkg.name.trim() : '';
    if (!name) continue;
    const version = typeof pkg.version === 'string' ? pkg.version.trim() : '';

    const url = (typeof pkg.links?.npm === 'string' && pkg.links.npm.trim())
      || `https://www.npmjs.com/package/${encodeURIComponent(name)}`;

    const description = typeof pkg.description === 'string' ? pkg.description.trim() : '';
    const weekly = typeof object.downloads?.weekly === 'number' ? object.downloads.weekly : undefined;
    const monthly = typeof object.downloads?.monthly === 'number' ? object.downloads.monthly : undefined;
    const score = typeof object.score?.final === 'number' ? object.score.final : undefined;
    const publisher = typeof pkg.publisher?.username === 'string' ? pkg.publisher.username : '';
    const homepage = typeof pkg.links?.homepage === 'string' ? pkg.links.homepage.trim() : '';
    const repository = typeof pkg.links?.repository === 'string' ? pkg.links.repository.trim() : '';
    const keywords = Array.isArray(pkg.keywords)
      ? pkg.keywords.filter((k): k is string => typeof k === 'string').slice(0, 8)
      : [];

    const publishedAt = parseDateLoose(typeof pkg.date === 'string' ? pkg.date : '');
    const snippet = buildSnippet(description, weekly);

    out.push({
      title: version ? `${name}@${version}` : name,
      url,
      ...(snippet ? { snippet } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      meta: {
        name,
        ...(version ? { version } : {}),
        ...(weekly !== undefined ? { weeklyDownloads: weekly } : {}),
        ...(monthly !== undefined ? { monthlyDownloads: monthly } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(publisher ? { publisher } : {}),
        ...(homepage ? { homepage } : {}),
        ...(repository ? { repository } : {}),
        ...(keywords.length ? { keywords } : {}),
        ...(total !== undefined ? { total } : {}),
      },
    });
  }
  return cap(out, limit);
}

/** `"<description> · 76226448 weekly downloads"`, dropping missing parts. */
export function buildSnippet(description: string, weekly?: number): string {
  const parts: string[] = [];
  if (description) parts.push(description);
  if (weekly !== undefined) parts.push(`${weekly} weekly downloads`);
  return parts.join(' · ');
}
