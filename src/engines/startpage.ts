/**
 * Startpage — keyless HTML proxy.
 *
 * Startpage serves Google's result set through its own front end. Results come
 * back server-rendered, but the host is aggressive about consent walls and
 * anti-bot challenges, so `detectBlock` runs before parsing and a challenge is
 * reported as a block rather than as "zero results".
 *
 * A POST to `/sp/search` with `query`/`cat`/`language` is the primary shape; a
 * GET with the same query string is supported as a fallback (and is what a
 * browser uses for the "search in a new tab" flow).
 *
 * Honoured options: `limit`, `timeoutMs` and `language` (`english` by default,
 * `chinese` for `zh`, plus the handful of UI languages Startpage accepts).
 * `options.freshness`, `options.region` and `options.safeSearch` are silently
 * ignored: Startpage's date filter is tied to a `date_from`/`date_to` pair that
 * this engine cannot derive reliably from a "last week" hint, and the region /
 * safe-search settings live in a session cookie that keyless scraping cannot
 * establish.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import {
  cap,
  cleanSnippet,
  detectBlock,
  extractGenericResults,
  extractResults,
  fetchHtml,
  mergeResults,
  parse,
  parseDateLoose,
  queryAll,
  queryOne,
  textOf,
  attrOf,
  absoluteUrl,
  warnEmptyResults,
  type EngineDeps,
  type SelectorSet,
} from './kit.js';
import { normalizeUrl, unwrapRedirect } from '../util/url.js';

const ENDPOINT = 'https://www.startpage.com/sp/search';
const HOME = 'https://www.startpage.com/';

/** Startpage's own hosts, which show up in the consent and nav markup. */
const SELF_HOSTS = ['startpage.com', 'www.startpage.com'];

/** Language hint -> Startpage's `language` form field. */
const LANGUAGES: Record<string, string> = {
  en: 'english',
  zh: 'chinese',
  de: 'deutsch',
  es: 'espanol',
  fr: 'francais',
  it: 'italiano',
  ja: 'japanese',
  ko: 'korean',
  nl: 'nederlands',
  pl: 'polski',
  pt: 'portugues',
  ru: 'russian',
  tr: 'turkish',
};

const SETS: SelectorSet[] = [
  {
    container: '.w-gl__result',
    link: 'a.w-gl__result-title',
    title: 'a.w-gl__result-title',
    snippet: '.w-gl__description',
    date: '.w-gl__date',
  },
  {
    container: '.result',
    link: 'h3 a, a.w-gl__result-title, a',
    title: 'h3, a.w-gl__result-title',
    snippet: '.w-gl__description, .description, p',
    date: '.w-gl__date, .date',
  },
  {
    // Older "web results" layout.
    container: '.w-gl__result__body, .w-gl__result-title',
    link: 'a[href]',
    snippet: '.w-gl__description',
  },
];

export function createStartpageEngine({ http, config }: EngineDeps): SearchEngine {
  const deps: EngineDeps = { http, config };

  return {
    id: 'startpage',
    label: 'Startpage',
    kind: 'html',
    requiresKey: false,
    homepage: HOME,
    regions: ['global'],
    transport: 'http',
    note: 'Google results through a privacy proxy; frequently serves a consent or anti-bot wall.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const form = {
        query,
        cat: 'web',
        language: languageField(options.language),
      };
      const body = new URLSearchParams(form).toString();

      let response = await fetchHtml(deps, ENDPOINT, {
        method: 'POST',
        body,
        referer: HOME,
        timeoutMs: options.timeoutMs,
        headers: { origin: HOME.replace(/\/$/, '') },
      });

      // A GET is the fallback when the POST path is refused outright.
      if (response.status === 405 || response.status === 403) {
        response = await fetchHtml(deps, `${ENDPOINT}?${body}`, {
          referer: HOME,
          timeoutMs: options.timeoutMs,
        });
      }

      const { html, finalUrl, status } = response;
      detectBlock(status, html, 'startpage');

      const { results, strategy } = extractResults(html, {
        baseUrl: finalUrl,
        selfHosts: SELF_HOSTS,
        limit: options.limit,
        sets: SETS,
      });
      if (results.length === 0) warnEmptyResults('startpage', html, strategy);

      // Union of the selector pass and the structural pass, so a layout that
      // only half-matches the selectors still contributes every result.
      const merged = mergeResults(
        results,
        extractGenericResults(html, { baseUrl: finalUrl, selfHosts: SELF_HOSTS, limit: options.limit }),
        options.limit,
      );
      const dated = collectDates(html, finalUrl);
      const cleaned = merged
        .map((result) => resolveResult(result, finalUrl, dated))
        .filter((r): r is RawResult => r !== null);

      return cap(cleaned, options.limit);
    },
  };
}

/** Map a BCP-47-ish language hint onto Startpage's UI language field. */
function languageField(language?: string): string {
  const base = (language ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return LANGUAGES[base] ?? 'english';
}

/** Resolve Startpage's occasional redirect wrapper and normalise the target. */
function resolveResult(
  result: RawResult,
  baseUrl: string,
  dated: Map<string, string>,
): RawResult | null {
  const url = absoluteUrl(unwrapRedirect(result.url), baseUrl);
  if (!url) return null;
  const normalized = normalizeUrl(url);
  if (!normalized) return null;

  const snippet = cleanSnippet(result.snippet ?? '');
  const publishedAt = result.publishedAt ?? dated.get(normalized.key);
  return {
    title: result.title,
    url: normalized.url,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

/** URL key -> ISO date, swept from every result container in the page. */
function collectDates(html: string, baseUrl: string): Map<string, string> {
  const dated = new Map<string, string>();
  const { doc } = parse(html, baseUrl);
  const containers = [...queryAll(doc, '.w-gl__result'), ...queryAll(doc, '.result')];
  for (const container of containers) {
    const link = queryOne(container, 'a.w-gl__result-title, h3 a, a[href]');
    const href = absoluteUrl(unwrapRedirect(attrOf(link, 'href')), baseUrl);
    const key = href ? normalizeUrl(href)?.key : undefined;
    if (!key || dated.has(key)) continue;
    for (const selector of ['.w-gl__date', 'time', '.date']) {
      const node = queryOne(container, selector);
      const iso = parseDateLoose(attrOf(node, 'datetime') || textOf(node));
      if (iso) {
        dated.set(key, iso);
        break;
      }
    }
  }
  return dated;
}
