/**
 * Google News — keyless RSS search feed.
 *
 * This is NOT a general web index: it returns news articles matching the query
 * as an RSS document, and every result points at a `news.google.com/rss/articles/…`
 * redirect that resolves to the publisher's article. It is registered as a
 * `news`-kind engine so the fusion layer can weight it accordingly.
 *
 * `hl`/`gl`/`ceid` come from `options.language` + `options.region` (for example
 * `zh` + `cn` → `hl=zh-CN&gl=CN&ceid=CN:zh`); unknown combinations fall back to
 * the `en-US` / `US:en` defaults. Freshness is expressed with Google News' own
 * `when:` query operator (`when:1d|7d|30d|1y`) appended to the query.
 * `options.safeSearch` is ignored: the RSS endpoint has no safe-search knob.
 *
 * The feed is parsed with a small regex scanner because the project ships no
 * XML dependency. `<item>` blocks, CDATA-wrapped values and double-escaped HTML
 * in `<description>` are all handled explicitly.
 */

import type { EngineSearchOptions, RawResult, SearchEngine } from '../types.js';
import { cap, fetchHtml, parseDateLoose, stripHtml, warnEmptyResults, type EngineDeps } from './kit.js';
import { decodeEntities } from '../html/markdown.js';
import { collapseWhitespace } from '../util/text.js';

const ENDPOINT = 'https://news.google.com/rss/search';
const HOME = 'https://news.google.com/';

/**
 * A feed-reader UA: Google serves the same XML to everyone, but RFC-correct
 * clients are less likely to be rate limited on the RSS path.
 */
const FEED_USER_AGENT = 'Mozilla/5.0 (compatible; free-search-mcp-ts/0.1; +https://github.com/lhswgzy/free-search-mcp-ts)';

/** `when:` values understood by Google News, keyed by our freshness levels. */
const FRESHNESS: Record<string, string> = { day: '1d', week: '7d', month: '30d', year: '1y' };

/** Language -> default BCP-47 tag used when the region cannot be resolved. */
const LANGUAGE_TAGS: Record<string, string> = {
  en: 'en', zh: 'zh', ja: 'ja', ko: 'ko', de: 'de', fr: 'fr', es: 'es', it: 'it',
  pt: 'pt', nl: 'nl', pl: 'pl', ru: 'ru', tr: 'tr', ar: 'ar', hi: 'hi', th: 'th',
  vi: 'vi', id: 'id', sv: 'sv', da: 'da', fi: 'fi', no: 'no', cs: 'cs', el: 'el',
  he: 'he', uk: 'uk', ro: 'ro', hu: 'hu',
};

/**
 * Region -> [ISO country, default news language]. `ceid` is `<country>:<lang>`,
 * which is why both halves are needed.
 */
const REGION_INFO: Record<string, { country: string; language: string }> = {
  global: { country: 'US', language: 'en' },
  us: { country: 'US', language: 'en' },
  gb: { country: 'GB', language: 'en' },
  uk: { country: 'GB', language: 'en' },
  ie: { country: 'IE', language: 'en' },
  au: { country: 'AU', language: 'en' },
  ca: { country: 'CA', language: 'en' },
  nz: { country: 'NZ', language: 'en' },
  in: { country: 'IN', language: 'en' },
  sg: { country: 'SG', language: 'en' },
  cn: { country: 'CN', language: 'zh' },
  hk: { country: 'HK', language: 'zh' },
  tw: { country: 'TW', language: 'zh' },
  jp: { country: 'JP', language: 'ja' },
  kr: { country: 'KR', language: 'ko' },
  de: { country: 'DE', language: 'de' },
  at: { country: 'AT', language: 'de' },
  ch: { country: 'CH', language: 'de' },
  fr: { country: 'FR', language: 'fr' },
  be: { country: 'BE', language: 'nl' },
  es: { country: 'ES', language: 'es' },
  mx: { country: 'MX', language: 'es' },
  ar: { country: 'AR', language: 'es' },
  br: { country: 'BR', language: 'pt' },
  pt: { country: 'PT', language: 'pt' },
  it: { country: 'IT', language: 'it' },
  nl: { country: 'NL', language: 'nl' },
  pl: { country: 'PL', language: 'pl' },
  ru: { country: 'RU', language: 'ru' },
  tr: { country: 'TR', language: 'tr' },
  il: { country: 'IL', language: 'he' },
  ae: { country: 'AE', language: 'ar' },
  sa: { country: 'SA', language: 'ar' },
  eg: { country: 'EG', language: 'ar' },
  za: { country: 'ZA', language: 'en' },
  ua: { country: 'UA', language: 'uk' },
};

export function createGoogleNewsEngine({ http, config }: EngineDeps): SearchEngine {
  const deps: EngineDeps = { http, config };

  return {
    id: 'googlenews',
    label: 'Google News',
    kind: 'news',
    requiresKey: false,
    homepage: HOME,
    regions: ['global'],
    transport: 'http',
    note: 'RSS news feed (articles, not a general web index); language/region and `when:` freshness.',

    async search(query: string, options: EngineSearchOptions): Promise<RawResult[]> {
      const feedUrl = buildFeedUrl(query, options);
      const { html: xml, status } = await fetchHtml(deps, feedUrl, {
        accept: 'application/rss+xml,application/xml;q=0.9,text/xml;q=0.8,*/*;q=0.5',
        userAgent: FEED_USER_AGENT,
        fixedUserAgent: true,
        timeoutMs: options.timeoutMs,
      });

      // Google answers a malformed query with an HTML error page rather than a
      // 4xx; anything that is not an `<item>` list simply yields no results.
      if (status >= 400 || !xml.includes('<item')) {
        warnEmptyResults('googlenews', xml, 'rss');
        return [];
      }

      const items = parseItems(xml);
      return cap(items.map(toRawResult).filter((r): r is RawResult => r !== null), options.limit);
    },
  };
}

/** Build the RSS URL, mapping language/region onto `hl`/`gl`/`ceid`. */
function buildFeedUrl(query: string, options: EngineSearchOptions): string {
  const language = (options.language ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  const region = (options.region ?? '').toLowerCase();
  const info = REGION_INFO[region];
  const newsLanguage = language || info?.language || 'en';
  const country = (info?.country ?? (region.length === 2 ? region.toUpperCase() : 'US')).toUpperCase();

  const hl = `${LANGUAGE_TAGS[newsLanguage] ?? newsLanguage}-${country}`;
  const q = withFreshness(query, options.freshness);

  const params = new URLSearchParams({
    q,
    hl,
    gl: country,
    ceid: `${country}:${newsLanguage}`,
  });
  return `${ENDPOINT}?${params.toString()}`;
}

/** Append Google News' `when:` operator for a freshness window. */
function withFreshness(query: string, freshness: EngineSearchOptions['freshness']): string {
  const when = freshness ? FRESHNESS[freshness] : undefined;
  if (!when) return query;
  return `${query} when:${when}`;
}

interface FeedItem {
  title: string;
  link: string;
  pubDate: string;
  sourceName: string;
  description: string;
}

/**
 * Extract `<item>` blocks and their fields with a regex scanner.
 *
 * RSS is regular enough for this to be safe: the feed is machine generated,
 * `<item>` never nests, and CDATA sections are handled before entity decoding.
 */
function parseItems(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const blockRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const match of xml.matchAll(blockRe)) {
    const block = match[1] ?? '';
    const title = field(block, 'title');
    const link = field(block, 'link');
    if (!title && !link) continue;
    const sourceTag = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(block);
    const sourceName = sourceTag ? unwrap(sourceTag[2] ?? '') : '';
    items.push({
      title,
      link,
      pubDate: field(block, 'pubDate'),
      sourceName,
      description: field(block, 'description'),
    });
  }
  return items;
}

/** Read one simple (non-nested) element from an `<item>` block. */
function field(block: string, name: string): string {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const match = re.exec(block);
  return match ? unwrap(match[1] ?? '') : '';
}

/** Strip a CDATA wrapper and entity-decode the value. */
function unwrap(raw: string): string {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const text = cdata ? (cdata[1] ?? '') : raw;
  return collapseWhitespace(decodeEntities(text));
}

/** Keep the trailing " - Publisher" out of the headline. */
function stripPublisherSuffix(title: string, publisher: string): string {
  const suffix = ` - ${publisher}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

/**
 * Google puts `"Headline - Publisher"` in `<title>` and repeats both in
 * `<description>`, usually as `"<a>Headline</a>&nbsp;&nbsp;<font>Publisher</font>"`.
 * Strip the tag soup, then drop the duplicated headline prefix and the trailing
 * publisher — but only when real text is left behind, because for many items the
 * description is nothing *but* that boilerplate.
 */
function cleanDescription(description: string, title: string, publisher: string): string {
  // The feed double-escapes this field, so `<a>`/`<font>` survive `stripHtml` as
  // literal tags after its own entity pass; drop those too.
  let text = collapseWhitespace(stripHtml(description).replace(/<[^>]*>/g, ' '));
  if (!text) return '';

  const titleIndex = title ? text.indexOf(title) : -1;
  if (titleIndex >= 0 && titleIndex <= 1) {
    const tail = collapseWhitespace(text.slice(titleIndex + title.length));
    // The headline appears once at the start; keep whatever follows it.
    if (tail.length >= 16) text = tail;
  }

  // Trailing "… - Publisher".
  const suffix = publisher ? ` - ${publisher}` : '';
  if (suffix && text.endsWith(suffix)) text = text.slice(0, -suffix.length);

  // The publisher link text is rendered either as the tail of the description
  // (older items) or as its first token (items whose summary follows). Drop it
  // only when a real snippet is left behind.
  const publisherIndex = publisher ? text.indexOf(publisher) : -1;
  if (publisherIndex >= 0) {
    const rest = collapseWhitespace(
      `${text.slice(0, publisherIndex)} ${text.slice(publisherIndex + publisher.length)}`,
    );
    if (rest.length >= 16) text = rest;
  }

  return collapseWhitespace(text);
}

function toRawResult(item: FeedItem): RawResult | null {
  const publisher = item.sourceName || publisherFromTitle(item.title);
  const title = (publisher ? stripPublisherSuffix(item.title, publisher) : item.title).trim();
  const snippet = cleanDescription(item.description, title, publisher);
  const publishedAt = parseDateLoose(toIsoDate(item.pubDate));
  const link = item.link.trim();
  if (!title || !link) return null;

  const meta: Record<string, unknown> = {};
  if (publisher) meta.publisher = publisher;

  return {
    title,
    url: link,
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(Object.keys(meta).length ? { meta } : {}),
  };
}

/**
 * `pubDate` is RFC-822 (`Sat, 13 Dec 2025 07:45:00 GMT`). `parseDateLoose`
 * recognises that shape only well enough to fall back on `Date.parse`, and its
 * own year/month/day pattern would reduce it to the year, so normalise to
 * ISO-8601 first to keep the time of day.
 */
function toIsoDate(pubDate: string): string {
  const raw = pubDate.trim();
  if (!raw) return '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : raw;
}

/**
 * Fallback publisher for feeds without a `<source>` element: Google uses
 * `"Headline - Publisher"`, so the text after the LAST `" - "` is the publisher.
 * Applied only when `<source>` is missing, because headlines may legitimately
 * contain dashes.
 */
function publisherFromTitle(title: string): string {
  const index = title.lastIndexOf(' - ');
  if (index <= 0 || index >= title.length - 3) return '';
  const candidate = title.slice(index + 3).trim();
  // Guard against a hyphenated headline being mistaken for a publisher name.
  return candidate.length <= 40 && !/[。！？!?]/.test(candidate) ? candidate : '';
}
