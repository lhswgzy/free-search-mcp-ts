import { describe, expect, it } from 'vitest';
import {
  decodeBase64Target,
  extractWrapperTarget,
  hostMatches,
  normalizeUrl,
  registrableDomain,
  sameUrl,
} from '../src/util/url.js';

/**
 * `normalizeUrl` is the dedupe key for the whole fusion pipeline: if two
 * spellings of the same page produce different keys, RRF can never collapse
 * "the same page from four engines" into one strong result.
 */
describe('normalizeUrl', () => {
  it('strips tracking parameters, sorts the rest and drops the fragment', () => {
    const normalized = normalizeUrl('https://WWW.Example.com/a/?utm_source=news&b=2&a=1&fbclid=xyz#section');
    expect(normalized?.key).toBe('https://example.com/a?a=1&b=2');
    // The URL shown to the user and the dedupe key are the same string, so a
    // result that was merged can always be re-fetched as-is.
    expect(normalized?.url).toBe(normalized?.key);
    expect(normalized?.host).toBe('example.com');
    expect(normalized?.domain).toBe('example.com');
    expect(normalized?.path).toBe('/a');
  });

  it('orders parameters by name regardless of how the engine wrote them', () => {
    expect(normalizeUrl('https://example.com/p?z=1&b=2&a=3')?.key).toBe('https://example.com/p?a=3&b=2&z=1');
  });

  it('drops empty parameters except the ones that change meaning', () => {
    // `b=` carries nothing, but `q=` is a real query parameter for search URLs
    // and is listed in KEEP_PARAMS, so it survives even while empty.
    expect(normalizeUrl('https://example.com/p?b=&a=1')?.key).toBe('https://example.com/p?a=1');
    expect(normalizeUrl('https://example.com/p?q=&b=1')?.key).toBe('https://example.com/p?b=1&q=');
  });

  it('removes www., the default port and the scheme casing', () => {
    expect(normalizeUrl('HTTPS://WWW.Example.com:443/x')?.key).toBe('https://example.com/x');
    expect(normalizeUrl('http://example.com:80/x')?.key).toBe('http://example.com/x');
    // A non-default port identifies a different origin, so it must be kept.
    expect(normalizeUrl('https://example.com:8443/x')?.key).toBe('https://example.com:8443/x');
  });

  it('collapses a trailing slash and a trailing index.html', () => {
    expect(normalizeUrl('https://example.com/a/b/')?.key).toBe('https://example.com/a/b');
    expect(normalizeUrl('https://example.com/docs/index.html')?.key).toBe('https://example.com/docs');
    expect(normalizeUrl('https://example.com/index.html')?.key).toBe('https://example.com/');
    // The root path keeps its slash: "https://example.com" alone reads like a host.
    expect(normalizeUrl('https://example.com')?.key).toBe('https://example.com/');
  });

  it('keeps the path case but lowercases the host', () => {
    expect(normalizeUrl('https://example.com/Case/Path')?.key).toBe('https://example.com/Case/Path');
  });

  it('accepts protocol-relative and scheme-less links', () => {
    expect(normalizeUrl('//example.com/x')?.key).toBe('https://example.com/x');
    expect(normalizeUrl('example.com/x')?.key).toBe('https://example.com/x');
  });

  it('rejects anything that is not an http(s) URL', () => {
    expect(normalizeUrl('ftp://example.com/x')).toBeNull();
    expect(normalizeUrl('mailto:someone@example.com')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
    expect(normalizeUrl('   ')).toBeNull();
  });

  it('rejects hostnames without a dot, which are nav links rather than sites', () => {
    expect(normalizeUrl('https://localhost/x')).toBeNull();
    expect(normalizeUrl('localhost')).toBeNull();
  });

  it('maps different spellings of one page onto a single key', () => {
    const a = normalizeUrl('https://www.example.com/doc/?utm_source=nl#top');
    const b = normalizeUrl('https://example.com/doc/index.html');
    expect(a?.key).toBe('https://example.com/doc');
    expect(b?.key).toBe('https://example.com/doc');
    expect(a && b && sameUrl(a.url, b.url)).toBe(true);
  });
});

describe('registrableDomain', () => {
  it('keeps the registrable part of a multi-part public suffix', () => {
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('foo.com.cn')).toBe('foo.com.cn');
    // github.io is in the multi-part list, so a user site keeps its label.
    expect(registrableDomain('x.github.io')).toBe('x.github.io');
  });

  it('reduces plain hosts to the last two labels', () => {
    expect(registrableDomain('example.com')).toBe('example.com');
    expect(registrableDomain('a.b.example.com')).toBe('example.com');
  });

  it('strips www. and is case insensitive', () => {
    expect(registrableDomain('www.example.com')).toBe('example.com');
    expect(registrableDomain('NEWS.BBC.CO.UK')).toBe('bbc.co.uk');
  });
});

describe('hostMatches', () => {
  it('contains sub-domains of the filter host', () => {
    expect(hostMatches('news.bbc.co.uk', 'bbc.co.uk')).toBe(true);
    expect(hostMatches('example.com', 'example.com')).toBe(true);
  });

  it('does not match a host that merely ends with the filter text', () => {
    // "notbbc.co.uk" ends with "bbc.co.uk" but is a different site; matching it
    // would silently let excluded domains back into the results.
    expect(hostMatches('notbbc.co.uk', 'bbc.co.uk')).toBe(false);
    expect(hostMatches('evilexample.com', 'example.com')).toBe(false);
  });

  it('normalises www. and a leading dot on the filter', () => {
    expect(hostMatches('example.com', 'www.example.com')).toBe(true);
    expect(hostMatches('example.com', '.example.com')).toBe(true);
    expect(hostMatches('example.com', '')).toBe(false);
  });
});

describe('extractWrapperTarget', () => {
  it('decodes the Bing ck/a u=a1<base64url> form', () => {
    const wrapped =
      'https://bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly93d3cuYnJpdGFubmljYS5jb20vdG9waWMvc3RhdGUtc292ZXJlaWduLXBvbGl0aWNhbC1lbnRpdHk&ver=2';
    expect(extractWrapperTarget(wrapped)).toBe('https://www.britannica.com/topic/state-sovereign-political-entity');
  });

  it('translates the url-safe base64 alphabet back before decoding', () => {
    // The base64 of this path ends with a "+", so the payload really does need
    // the "-" -> "+" translation to decode.
    const target = 'https://example.com/topic/aaa~';
    const base64url = Buffer.from(target, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(base64url).toContain('-');
    expect(extractWrapperTarget(`https://www.bing.com/ck/a?!&&p=abc&u=a1${base64url}&ver=2`)).toBe(target);
  });

  it('unwraps a protocol-relative DuckDuckGo uddg link', () => {
    expect(extractWrapperTarget('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc')).toBe('https://example.com/doc');
  });

  it('unwraps a percent-encoded uddg value without losing the inner query', () => {
    const wrapped = 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FRRF%3Ffoo%3D1%26bar%3D2';
    expect(extractWrapperTarget(wrapped)).toBe('https://en.wikipedia.org/wiki/RRF?foo=1&bar=2');
  });

  it('returns undefined for a wrapper whose payload it cannot decode', () => {
    // An opaque Baidu token: guessing would send the fetcher somewhere random,
    // so the caller falls back to following the redirect instead.
    expect(extractWrapperTarget('https://www.baidu.com/link?url=dVecrWd7MFlkFJO3')).toBeUndefined();
    // A relative or unrelated parameter is also not a target we can resolve offline.
    expect(extractWrapperTarget('https://tracker.example.com/redirect?url=%2Flocal%2Fpath')).toBeUndefined();
    expect(extractWrapperTarget('https://out.example.com/go?dest=https%3A%2F%2Freal.example.com')).toBeUndefined();
    expect(extractWrapperTarget('https://example.com/plain')).toBeUndefined();
    expect(extractWrapperTarget('')).toBeUndefined();
  });
});

describe('decodeBase64Target', () => {
  it('returns an already-plain URL unchanged', () => {
    expect(decodeBase64Target('https://example.com/x')).toBe('https://example.com/x');
  });

  it('decodes a value with no version marker at offset zero', () => {
    expect(decodeBase64Target('aHR0cHM6Ly9leGFtcGxlLmNvbS9h')).toBe('https://example.com/a');
  });

  it('returns undefined for garbage instead of inventing a URL', () => {
    expect(decodeBase64Target('not-base64-@@@')).toBeUndefined();
    expect(decodeBase64Target('')).toBeUndefined();
    expect(decodeBase64Target('   ')).toBeUndefined();
  });
});
