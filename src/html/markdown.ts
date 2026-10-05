/**
 * HTML -> Markdown conversion.
 *
 * Pipeline: linkedom parses, relative URLs are absolutised, Mozilla Readability
 * isolates the main article, and Turndown renders GFM Markdown. When Readability
 * declines (a docs site, a changelog, a table-heavy spec) a conservative
 * fallback strips chrome from `<body>` instead of giving up.
 *
 * Markdown rather than JSON or raw HTML is the whole point of this server:
 * headings, lists, links and tables survive, while the ~40 % of tokens that go
 * on HTML tags or JSON punctuation do not.
 */

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { tidyMarkdown, truncate } from '../util/text.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('html');

/**
 * linkedom and Readability are typed against `lib.dom`. This package
 * deliberately compiles with a Node-only lib set so that `fetch`/`Response`
 * come from @types/node rather than from the DOM, which means the small surface
 * of DOM API we actually use is declared structurally here instead of pulling
 * in `lib.dom` (whose `fetch`/`Headers` would then collide).
 */
interface DomElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
  textContent?: string | null;
  innerHTML?: string;
  nodeName?: string;
  firstChild?: DomElement | null;
}

interface DomDocument {
  documentElement?: DomElement | null;
  body?: DomElement | null;
  querySelector(selector: string): DomElement | null;
  querySelectorAll(selector: string): Iterable<DomElement>;
  toString(): string;
}

interface ArticleLike {
  title?: string | null;
  content?: string | null;
  textContent?: string | null;
  byline?: string | null;
  excerpt?: string | null;
  siteName?: string | null;
  lang?: string | null;
  publishedTime?: string | null;
}

/** Readability's constructor re-typed against our structural DOM. */
const ReadabilityCtor = Readability as unknown as new (
  document: unknown,
  options?: Record<string, unknown>,
) => { parse(): ArticleLike | null };

export interface ReadableArticle {
  title: string;
  /** Markdown body. */
  markdown: string;
  /** Plain-text body (used for word counts and passage scoring). */
  textContent: string;
  byline?: string;
  excerpt?: string;
  publishedAt?: string;
  siteName?: string;
  language?: string;
  /** `readability` when the article extractor succeeded, else `fallback`. */
  extractor: 'readability' | 'fallback';
}

/** Elements that never carry article content. */
const STRIP_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed',
  'svg', 'canvas', 'form', 'input', 'select', 'textarea', 'button',
  'nav', 'footer', 'aside', 'dialog', 'menu',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]', '[role="search"]',
  '[aria-hidden="true"]', '[hidden]',
  '.advertisement', '.ad', '.ads', '.adsbygoogle', '.sponsored',
  '.cookie', '.cookies', '#cookie-banner', '.gdpr',
  '.newsletter', '.subscribe', '.social-share', '.share-buttons', '.share',
  '.comments', '#comments', '.comment-section', '.related-posts', '.recommended',
  '.sidebar', '#sidebar', '.breadcrumb', '.breadcrumbs', '.pagination',
  '.site-header', '.site-footer', '.masthead', '.menu', '.toolbar',
];

function createTurndown(): TurndownService {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '_',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    preformattedCode: true,
  });

  service.use(gfm);

  // Keep fenced code blocks verbatim: no escaping, no smart quotes.
  service.addRule('fencedCodeBlockClean', {
    filter: (node) =>
      node.nodeName === 'PRE' &&
      !!node.firstChild &&
      (node.firstChild as unknown as { nodeName: string }).nodeName === 'CODE',
    replacement: (_content, node) => {
      const el = node as unknown as DomElement;
      const codeEl = (el as unknown as { firstChild: DomElement }).firstChild;
      const className = codeEl.getAttribute?.('class') ?? '';
      const language = /(?:language|lang)-([\w+#.-]+)/.exec(className)?.[1] ?? '';
      const code = (codeEl.textContent ?? '').replace(/\n+$/, '');
      return `\n\n\`\`\`${language}\n${code}\n\`\`\`\n\n`;
    },
  });

  // Images: drop tracking pixels and 1x1 spacers, keep a useful alt/URL only.
  service.addRule('cleanImages', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as unknown as DomElement;
      const src = el.getAttribute('src') ?? '';
      const alt = (el.getAttribute('alt') ?? '').trim();
      if (!src || /^data:/.test(src)) return '';
      if (/(?:^|[/_.-])(sprite|spacer|pixel|blank|1x1|tracking)(?:[/_.-]|$)/i.test(src)) return '';
      return alt ? `\n\n![${alt}](${src})\n\n` : '';
    },
  });

  // Empty anchors are noise; a bare `[](url)` costs tokens and reads badly.
  service.addRule('dropEmptyLinks', {
    filter: (node) => node.nodeName === 'A' && !(node.textContent ?? '').trim(),
    replacement: () => '',
  });

  service.addRule('definitionLists', {
    filter: ['dl'],
    replacement: (content) => `\n\n${content}\n\n`,
  });
  service.addRule('definitionTerm', {
    filter: ['dt'],
    replacement: (content) => `\n\n**${content.trim()}**\n`,
  });
  service.addRule('definitionDescription', {
    filter: ['dd'],
    replacement: (content) => `: ${content.trim()}\n`,
  });

  return service;
}

const turndown = createTurndown();

/** Serialise a linkedom document back to HTML. */
function serialize(doc: DomDocument): string {
  const d = doc as unknown as { documentElement?: { outerHTML?: string }; toString(): string };
  return d.documentElement?.outerHTML ?? d.toString();
}

/**
 * Rewrite relative `href`/`src`/`srcset` to absolute URLs in place.
 *
 * Readability clones nodes and does not always know the document base URI, so
 * doing this up front is the only reliable way to keep links usable.
 */
export function absolutiseUrls(doc: DomDocument, baseUrl: string): number {
  let rewritten = 0;
  const resolve = (value: string): string | null => {
    const v = value.trim();
    if (!v || v.startsWith('#') || /^(?:data|blob|javascript|mailto|tel):/i.test(v)) return null;
    try {
      return new URL(v, baseUrl).toString();
    } catch {
      return null;
    }
  };

  const attributes = ['href', 'src', 'poster', 'cite', 'action'] as const;
  for (const attr of attributes) {
    const nodes = doc.querySelectorAll(`[${attr}]`);
    for (const el of nodes) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const absolute = resolve(value);
      if (absolute && absolute !== value) {
        el.setAttribute(attr, absolute);
        rewritten++;
      }
    }
  }

  // srcset holds a comma-separated list of "url descriptor" pairs.
  const srcsets = doc.querySelectorAll('[srcset]');
  for (const el of srcsets) {
    const value = el.getAttribute('srcset');
    if (!value) continue;
    const rewrittenValue = value
      .split(',')
      .map((part) => {
        const [url, ...descriptor] = part.trim().split(/\s+/);
        const absolute = url ? resolve(url) : null;
        return [absolute ?? url, ...descriptor].filter(Boolean).join(' ');
      })
      .join(', ');
    el.setAttribute('srcset', rewrittenValue);
  }

  // <base href> would otherwise send Turndown's relative links nowhere useful.
  const bases = doc.querySelectorAll('base');
  for (const el of bases) el.remove();

  return rewritten;
}

/** Remove non-content elements from a document, in place. */
export function stripChrome(doc: DomDocument): void {
  for (const selector of STRIP_SELECTORS) {
    const nodes = doc.querySelectorAll(selector);
    for (const el of nodes) {
      try {
        el.remove();
      } catch {
        /* some nodes cannot be detached; ignore */
      }
    }
  }
}

export interface ConvertOptions {
  /** Base URL used to absolutise relative links. */
  url?: string;
  /** Force the fallback extractor (used for non-article pages). */
  forceFallback?: boolean;
  /** Readability character threshold; lower keeps short pages. */
  charThreshold?: number;
}

/**
 * Convert an HTML document string into Markdown plus metadata.
 *
 * Never throws: any failure degrades to a regex-based text extraction so that
 * `fetch_url` still returns something useful for malformed or exotic markup.
 */
export function htmlToMarkdown(html: string, options: ConvertOptions = {}): ReadableArticle {
  const url = options.url ?? 'https://example.invalid/';
  const result: ReadableArticle = {
    title: '',
    markdown: '',
    textContent: '',
    extractor: 'fallback',
  };

  let doc: DomDocument | undefined;
  try {
    const parsed = parseHTML(html, { url } as unknown as Parameters<typeof parseHTML>[1]) as unknown as {
      document: DomDocument;
    };
    doc = parsed.document;
  } catch (err) {
    log.debug(`linkedom parse failed: ${(err as Error).message}`);
  }

  if (doc) {
    try {
      if (url && doc) absolutiseUrls(doc, url);
    } catch (err) {
      log.debug(`url absolutisation failed: ${(err as Error).message}`);
    }

    // Document-level metadata, read before Readability mutates the tree.
    result.title = firstText(doc, ['meta[property="og:title"]', 'meta[name="twitter:title"]']) ?? titleOf(doc);
    result.siteName = firstText(doc, ['meta[property="og:site_name"]']) ?? undefined;
    result.language =
      firstAttr(doc, 'html', 'lang') ?? firstText(doc, ['meta[http-equiv="content-language"]']) ?? undefined;
    result.publishedAt =
      firstText(doc, [
        'meta[property="article:published_time"]',
        'meta[name="article:published_time"]',
        'meta[name="date"]',
        'meta[name="DC.date"]',
        'meta[name="pubdate"]',
        'time[datetime]',
      ]) ?? undefined;
    result.byline = firstText(doc, ['meta[name="author"]', 'meta[property="article:author"]']) ?? undefined;

    if (!options.forceFallback) {
      try {
        const reader = new ReadabilityCtor(doc, {
          charThreshold: options.charThreshold ?? 200,
          keepClasses: false,
          disableJSONLD: false,
        });
        const article = reader.parse();
        if (article && article.content && (article.textContent ?? '').trim().length > 120) {
          result.markdown = tidyMarkdown(turndown.turndown(article.content));
          result.textContent = (article.textContent ?? '').trim();
          result.title = (article.title ?? result.title ?? '').trim() || result.title;
          result.byline = (article.byline ?? result.byline) || undefined;
          result.excerpt = (article.excerpt ?? undefined) || undefined;
          result.siteName = (article.siteName ?? result.siteName) || undefined;
          result.language = (article.lang ?? result.language) || undefined;
          if (article.publishedTime) result.publishedAt = article.publishedTime;
          result.extractor = 'readability';
        }
      } catch (err) {
        log.debug(`readability failed: ${(err as Error).message}`);
      }
    }

    if (!result.markdown) {
      try {
        stripChrome(doc);
        const body =
          doc.querySelector('article') ?? doc.querySelector('main') ?? doc.body ?? undefined;
        const bodyHtml = body?.innerHTML ?? serialize(doc);
        result.markdown = tidyMarkdown(turndown.turndown(bodyHtml));
        if (!result.textContent) result.textContent = tidyMarkdown(htmlToText(bodyHtml));
        result.extractor = 'fallback';
      } catch (err) {
        log.debug(`fallback extraction failed: ${(err as Error).message}`);
      }
    }
  }

  if (!result.markdown) {
    // Last resort: never return an empty body for a page that had content.
    const text = htmlToText(html);
    result.markdown = tidyMarkdown(text);
    result.textContent = text;
    result.extractor = 'fallback';
  }

  result.markdown = cleanMarkdown(result.markdown);
  if (!result.textContent) result.textContent = tidyMarkdown(htmlToText(result.markdown));
  if (!result.title) result.title = firstLine(result.markdown) || url;

  return result;
}

/** Trim Markdown artefacts that readability/turndown leave behind. */
export function cleanMarkdown(markdown: string): string {
  let md = tidyMarkdown(markdown);

  // Bare "read more"/"share" navigation lines.
  md = md
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^\[(?:read more|learn more|more|share|tweet|print|comments?|skip to content|advertisement)\]\([^)]*\)$/i.test(t)) {
        return false;
      }
      if (/^(?:share|tweet|advertisement|sponsored|related articles?|table of contents|skip to main content)$/i.test(t)) {
        return false;
      }
      if (/^[|\s-]+$/.test(t) && t.includes('|')) return false; // empty table rows
      return true;
    })
    .join('\n');

  // `![](url)` with no alt text and no caption is rarely useful and always noisy.
  md = md.replace(/^!\[\]\([^)]*\)$/gm, '');

  // Consecutive identical links (common in card layouts).
  md = md.replace(/(\[[^\]]+\]\([^)]+\))\n\1/g, '$1');

  // Collapse >2 blank lines again after removals, and normalise list spacing.
  md = md.replace(/\n{3,}/g, '\n\n').replace(/^\s+$/gm, '').replace(/[ \t]+$/gm, '');

  return tidyMarkdown(md);
}

/** Strip all tags and decode the common entities. */
export function htmlToText(html: string): string {
  return decodeEntities(
    (html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|section|article|blockquote|pre)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–',
  mdash: '—', hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«',
  raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•',
  middot: '·', deg: '°', euro: '€', pound: '£', yen: '¥', times: '×',
  divide: '÷', plusmn: '±', frac12: '½', sup2: '²', sup3: '³', eacute: 'é',
  egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä',
  szlig: 'ß', shy: '', zwj: '', zwnj: '',
};

export function decodeEntities(text: string): string {
  return (text || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/* ------------------------- tiny DOM query helpers ------------------------- */

function firstText(doc: DomDocument, selectors: string[]): string | null {
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (!el) continue;
    const value = (el.getAttribute('content') ?? el.getAttribute('datetime') ?? el.textContent ?? '').trim();
    if (value) return value;
  }
  return null;
}

function firstAttr(doc: DomDocument, selector: string, attr: string): string | null {
  const el = doc.querySelector(selector);
  const value = el?.getAttribute(attr);
  return value ? value.trim() : null;
}

function titleOf(doc: DomDocument): string {
  const el = doc.querySelector('title');
  return (el?.textContent ?? '').trim();
}

function firstLine(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t.length > 2) return truncate(t, 120);
  }
  return '';
}

/** Extract candidate links from markdown for agentic follow-up. */
export function extractLinks(markdown: string, limit = 50): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[2]!;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ text: m[1]!.trim(), url });
    if (out.length >= limit) break;
  }
  return out;
}

export { serialize as serializeDocument };
