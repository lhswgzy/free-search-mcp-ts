/**
 * Unit tests for the HTML -> Markdown pipeline (`src/html/markdown.ts`).
 *
 * These run entirely against on-disk fixtures and hand-written markup: no
 * network, no clock. The point is to lock down what a *user* of `fetch_url`
 * sees — an article with its tables and code blocks intact, absolute links, no
 * navigation chrome — rather than internal implementation details.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  absolutiseUrls,
  cleanMarkdown,
  decodeEntities,
  extractLinks,
  htmlToMarkdown,
  htmlToText,
  serializeDocument,
  stripChrome,
} from '../src/html/markdown.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

/** The module's DOM interfaces are structural, so linkedom documents are cast. */
type StructuralDoc = Parameters<typeof stripChrome>[0];
const asDoc = (html: string): StructuralDoc =>
  (parseHTML(html) as unknown as { document: StructuralDoc }).document;

const MDN_URL = 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API';

const chromeOnlyPage = `<!doctype html><html><head><title>Nav only</title>
<script>console.log('tracking beacon');</script>
<style>body { color: red; }</style></head><body>
<nav><a href="/">Home</a><a href="/about">About us</a></nav>
<main><p>Short.</p></main>
<footer class="site-footer"><p>© 2024 Example Ltd. All rights reserved.</p></footer>
<div class="cookie" id="cookie-banner">We use cookies. Accept all cookies to continue.</div>
</body></html>`;

describe('htmlToMarkdown on a real article capture', () => {
  const article = htmlToMarkdown(fixture('article-mdn.html'), { url: MDN_URL });

  it('chooses Readability for a page that really is an article', () => {
    expect(article.extractor).toBe('readability');
    expect(article.title).toContain('Fetch API');
    expect(article.markdown.length).toBeGreaterThan(1000);
  });

  it('reads the document metadata an agent needs for citation', () => {
    expect(article.siteName).toBe('MDN Web Docs');
    expect(article.language).toBe('en-US');
    expect(article.publishedAt).toContain('2026-06-08');
  });

  it('keeps a GFM table, including the delimiter row that makes it render', () => {
    expect(article.markdown).toMatch(/^\| Specification \|$/m);
    expect(article.markdown).toMatch(/^\| --- \|$/m);
  });

  it('resolves relative hrefs against the base URL and leaves none behind', () => {
    expect(article.markdown).toContain('(https://developer.mozilla.org/en-US/docs/Web/API/Request)');
    expect(article.markdown).not.toMatch(/\]\(\//);
  });

  it('drops scripts, styles and navigation chrome', () => {
    expect(article.markdown).not.toContain('<script');
    expect(article.markdown).not.toContain('<style');
    expect(article.markdown).not.toContain('class=');
    expect(article.markdown).not.toContain('Skip to main content');
    expect(article.markdown).not.toContain('Sign in');
  });

  it('falls back when the caller forces the fallback extractor', () => {
    const forced = htmlToMarkdown(fixture('article-mdn.html'), { url: MDN_URL, forceFallback: true });
    expect(forced.extractor).toBe('fallback');
    expect(forced.markdown.length).toBeGreaterThan(0);
  });
});

describe('htmlToMarkdown on a focused article excerpt', () => {
  const article = htmlToMarkdown(fixture('article-excerpt.html'), {
    url: 'https://docs.example.com/guide/fetching',
  });

  it('extracts the article body with Readability and its byline', () => {
    expect(article.extractor).toBe('readability');
    expect(article.title).toBe('Fetching data');
    expect(article.byline).toBe('Ada Lovelace');
  });

  it('renders a fenced code block with its language tag', () => {
    expect(article.markdown).toContain('```js');
    expect(article.markdown).toContain('const res = await client.request(url);');
    expect(article.markdown).toMatch(/```js[\s\S]*```/);
  });

  it('renders the GFM table with header, delimiter and both body rows', () => {
    expect(article.markdown).toContain('| Option | Type | Default |');
    expect(article.markdown).toContain('| --- | --- | --- |');
    expect(article.markdown).toContain('| timeoutMs | number | 15000 |');
    expect(article.markdown).toContain('| retries | number | 1 |');
  });

  it('absolutises a relative href instead of shipping a broken link', () => {
    expect(article.markdown).toContain('(https://docs.example.com/docs/quickstart)');
    expect(article.markdown).not.toContain('](/docs/quickstart)');
  });

  it('absolutises images and keeps the alt text', () => {
    expect(article.markdown).toContain('![Request lifecycle diagram](https://docs.example.com/img/diagram.png)');
  });

  it('strips the cookie banner, header nav and footer', () => {
    expect(article.markdown).not.toMatch(/cookie/i);
    expect(article.markdown).not.toContain('About us');
    expect(article.markdown).not.toContain('All rights reserved');
  });

  it('drops the residual "Read more" and "Share" lines cleanMarkdown targets', () => {
    expect(article.markdown).not.toMatch(/read more/i);
    expect(article.markdown).not.toMatch(/^Share$/m);
  });
});

describe('the fallback extractor path', () => {
  it('is used for a page that is nothing but chrome', () => {
    const article = htmlToMarkdown(chromeOnlyPage, { url: 'https://example.com/' });
    expect(article.extractor).toBe('fallback');
    expect(article.markdown).toContain('Short.');
    expect(article.markdown).not.toMatch(/cookie/i);
    expect(article.markdown).not.toContain('All rights reserved');
  });

  it('is used for a real page that is not an article', () => {
    const article = htmlToMarkdown(fixture('article-bing-blog.html'), {
      url: 'https://blogs.bing.com/search/2023/02/07/bing-chat',
    });
    expect(article.extractor).toBe('fallback');
    expect(article.markdown.length).toBeLessThan(500);
  });

  it('never returns an empty body for markup it cannot parse as HTML', () => {
    const article = htmlToMarkdown('<p>Just one paragraph of plain text, no document wrapper at all.</p>');
    expect(article.markdown).toContain('Just one paragraph of plain text');
  });
});

describe('decodeEntities', () => {
  it('decodes the named entities the server actually meets', () => {
    expect(decodeEntities('a &amp; b')).toBe('a & b');
    expect(decodeEntities('1 &mdash; 2')).toBe('1 — 2');
    expect(decodeEntities('x&nbsp;y')).toBe('x y');
    expect(decodeEntities('&laquo;quoted&raquo;')).toBe('«quoted»');
  });

  it('decodes decimal and hex numeric references', () => {
    expect(decodeEntities('&#65;&#66;')).toBe('AB');
    expect(decodeEntities('&#x41;&#x42;')).toBe('AB');
    expect(decodeEntities('&#x1F600;')).toBe('😀');
  });

  it('leaves an out-of-range or unknown reference untouched', () => {
    // 0x110000 is one past the last valid code point; a naive conversion would
    // throw or emit U+FFFD, silently corrupting the text.
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeEntities('&#0;')).toBe('&#0;');
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
  });

  it('is case-insensitive for named entities', () => {
    expect(decodeEntities('&AMP;')).toBe('&');
    expect(decodeEntities('&#X41;')).toBe('A');
  });
});

describe('htmlToText', () => {
  const text = htmlToText(
    '<div>One</div><p>Two &amp; a half</p><ul><li>Three</li></ul><script>bad()</script><br>Four',
  );

  it('removes every tag and decodes entities', () => {
    expect(text).not.toContain('<');
    expect(text).toContain('Two & a half');
  });

  it('preserves block boundaries as line breaks', () => {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    expect(lines).toEqual(['One', 'Two & a half', 'Three', 'Four']);
  });

  it('drops the contents of script and style elements', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Kept</p>')).toBe('Kept');
    expect(text).not.toContain('bad()');
  });

  it('returns an empty string for empty input', () => {
    expect(htmlToText('')).toBe('');
  });
});

describe('cleanMarkdown', () => {
  it('removes bare read-more / share / advertisement lines', () => {
    const cleaned = cleanMarkdown('# Title\n\n[Read more](https://example.com/more)\nShare\nAdvertisement\nBody.');
    expect(cleaned).not.toMatch(/read more/i);
    expect(cleaned).not.toMatch(/^Share$/m);
    expect(cleaned).not.toMatch(/^Advertisement$/m);
    expect(cleaned).toContain('Body.');
  });

  it('collapses runs of blank lines', () => {
    expect(cleanMarkdown('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('drops alt-text-less images and consecutive duplicate links', () => {
    const cleaned = cleanMarkdown('![](https://example.com/p.gif)\n\n[Docs](https://example.com/d)\n[Docs](https://example.com/d)');
    expect(cleaned).not.toContain('p.gif');
    expect(cleaned.match(/example\.com\/d/g)).toHaveLength(1);
  });

  it('keeps a GFM table intact, including its delimiter row', () => {
    // Regression guard: treating `| --- |` as an "empty table row" removed the
    // delimiter and silently turned every table into a plain text block.
    const cleaned = cleanMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(cleaned).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('keeps table rows but still removes genuinely empty ones', () => {
    const cleaned = cleanMarkdown('| A | B |\n| --- | --- |\n|  |  |\n| 1 | 2 |');
    expect(cleaned).toContain('| 1 | 2 |');
    expect(cleaned).not.toMatch(/\|\s+\|\s+\|/);
  });
});

describe('extractLinks', () => {
  const markdown = '[A](https://a.example/1) [A again](https://a.example/1) [B](https://b.example/2) [C](https://c.example/3) [rel](/x)';

  it('de-duplicates by URL and ignores relative links', () => {
    const links = extractLinks(markdown);
    expect(links.map((l) => l.url)).toEqual([
      'https://a.example/1',
      'https://b.example/2',
      'https://c.example/3',
    ]);
  });

  it('honours its limit', () => {
    expect(extractLinks(markdown, 2)).toHaveLength(2);
    expect(extractLinks(markdown, 1)[0]!.text).toBe('A');
  });

  it('returns nothing for markdown without links', () => {
    expect(extractLinks('plain text')).toEqual([]);
  });
});

describe('stripChrome and absolutiseUrls on a small document', () => {
  it('removes nav, footer, cookie banner and script but keeps the main content', () => {
    const doc = asDoc(chromeOnlyPage);
    stripChrome(doc);
    const html = serializeDocument(doc);
    expect(html).toContain('Short.');
    expect(html).not.toContain('<nav');
    expect(html).not.toContain('<footer');
    expect(html).not.toContain('cookie-banner');
    expect(html).not.toContain('tracking beacon');
    expect(html).not.toContain('<style');
  });

  it('rewrites relative attributes and counts what it changed', () => {
    const doc = asDoc('<html><body><a href="/a">A</a><img src="img/b.png" srcset="img/c.png 1x, img/d.png 2x"><a href="#frag">F</a></body></html>');
    const rewritten = absolutiseUrls(doc, 'https://docs.example.com/guide/');
    const html = serializeDocument(doc);
    // `href` and `src` are counted individually; `srcset` is rewritten in place
    // without going through the counter.
    expect(rewritten).toBe(2);
    expect(html).toContain('https://docs.example.com/a');
    expect(html).toContain('https://docs.example.com/guide/img/b.png');
    expect(html).toContain('https://docs.example.com/guide/img/c.png 1x');
    expect(html).toContain('https://docs.example.com/guide/img/d.png 2x');
    expect(html).toContain('href="#frag"');
  });

  it('leaves non-http schemes alone and removes a <base> element', () => {
    const doc = asDoc('<html><head><base href="https://evil.example/"></head><body><a href="mailto:a@b.c">m</a><a href="javascript:void(0)">j</a><a href="/real">r</a></body></html>');
    absolutiseUrls(doc, 'https://docs.example.com/');
    const html = serializeDocument(doc);
    expect(html).toContain('mailto:a@b.c');
    expect(html).toContain('javascript:void(0)');
    expect(html).toContain('https://docs.example.com/real');
    expect(html).not.toContain('<base');
  });
});
