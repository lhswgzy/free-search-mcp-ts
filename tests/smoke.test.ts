import { describe, expect, it } from 'vitest';
import { normalizeUrl, registrableDomain, extractWrapperTarget, decodeBase64Target } from '../src/util/url.js';
import { fuseResults } from '../src/rrf.js';

describe('runner smoke test', () => {
  it('resolves .js specifiers to .ts sources', () => {
    expect(typeof normalizeUrl).toBe('function');
    expect(typeof extractWrapperTarget).toBe('function');
  });

  it('has access to the fusion entry point', () => {
    expect(typeof fuseResults).toBe('function');
  });

  it('normalises a URL', () => {
    expect(normalizeUrl('https://WWW.Example.com/a/?utm_source=x#frag')?.key).toBe('https://example.com/a');
  });

  it('extracts a registrable domain', () => {
    expect(registrableDomain('news.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('decodes a Bing ck/a base64 wrapper href', () => {
    const wrapped =
      'https://bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly93d3cuYnJpdGFubmljYS5jb20vdG9waWMvc3RhdGUtc292ZXJlaWduLXBvbGl0aWNhbC1lbnRpdHk&ver=2';
    expect(extractWrapperTarget(wrapped)).toBe('https://www.britannica.com/topic/state-sovereign-political-entity');
  });

  it('decodes a protocol-relative DuckDuckGo wrapper', () => {
    expect(extractWrapperTarget('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc')).toBe('https://example.com/doc');
  });

  it('leaves a plain URL alone and refuses an opaque one', () => {
    expect(decodeBase64Target('https://example.com/x')).toBe('https://example.com/x');
    expect(extractWrapperTarget('https://www.baidu.com/link?url=dVecrWd7MFlkFJO3')).toBeUndefined();
  });
});
