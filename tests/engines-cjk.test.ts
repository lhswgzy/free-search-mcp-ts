/**
 * Tests for the three Chinese-language HTML engines (Baidu, Sogou, 360).
 *
 * The captured pages are large and were recorded from a network where the global
 * engines are blocked, which is exactly the condition these parsers exist for.
 * Each file is parsed once per suite and the assertions then run against the
 * result list, so the cost is paid a single time.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Config } from '../src/config.js';
import { parseBaiduResults } from '../src/engines/baidu.js';
import { parseSogouResults } from '../src/engines/sogou.js';
import { parseSo360Results } from '../src/engines/so360.js';
import { createEngine, getDefinition, isConfigured } from '../src/engines/registry.js';
import type { HttpClient } from '../src/http.js';
import type { RawResult } from '../src/types.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const BAIDU_URL = 'https://www.baidu.com/s?wd=model%20context%20protocol';
const SOGOU_URL = 'https://www.sogou.com/web?query=model%20context%20protocol';
const SO360_URL = 'https://www.so.com/s?q=model%20context%20protocol';

function stubConfig(overrides: Partial<Config> = {}): Config {
  return {
    timeoutMs: 15_000,
    retries: 1,
    concurrency: 6,
    maxFetchBytes: 5 * 1024 * 1024,
    maxMarkdownChars: 120_000,
    userAgent: undefined,
    rotateUserAgent: false,
    proxy: undefined,
    cacheEnabled: false,
    respectRobots: false,
    allowPrivateHosts: false,
    keys: {},
    ...overrides,
  } as unknown as Config;
}

/** A client that must never be used: these tests call the parsers directly. */
function neverUsedClient(): HttpClient {
  return {
    config: undefined as unknown as Config,
    request() {
      throw new Error('this test must not perform an HTTP request');
    },
    getText() {
      throw new Error('this test must not perform an HTTP request');
    },
    getJson() {
      throw new Error('this test must not perform an HTTP request');
    },
    postForm() {
      throw new Error('this test must not perform an HTTP request');
    },
  };
}

const hosts = (results: RawResult[]): string[] => results.map((r) => new URL(r.url).hostname);

describe('CJK engine metadata', () => {
  const config = stubConfig();

  it('agrees with the registry for baidu, sogou and so360', () => {
    for (const id of ['baidu', 'sogou', 'so360']) {
      const definition = getDefinition(id);
      expect(definition, `registry definition for ${id}`).toBeDefined();
      const engine = createEngine(id, { http: neverUsedClient(), config });
      expect(engine).toBeDefined();
      expect(engine!.id).toBe(definition!.id);
      expect(engine!.kind).toBe('html');
      expect(engine!.requiresKey).toBe(false);
      expect(engine!.regions).toContain('cn');
      expect(isConfigured(id, config)).toBe(true);
    }
  });
});

describe('parseBaiduResults', () => {
  let results: RawResult[] = [];

  beforeAll(() => {
    results = parseBaiduResults(fixture('baidu.html'), BAIDU_URL, 25);
  });

  it('finds at least five organic results in a real capture', () => {
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses the container mu attribute instead of the /link?url= wrapper', () => {
    expect(hosts(results)).toContain('cloud.tencent.com');
    expect(results.map((r) => r.url)).toContain('https://cloud.tencent.com/developer/article/2508227');
    for (const result of results) {
      expect(result.url).not.toContain('/link?url=');
      expect(result.url).not.toContain('baidu.com/link');
    }
  });

  it('excludes nourl.ubs.baidu.com onebox rows', () => {
    // The capture really does contain such a unit; it must not become a result.
    expect(fixture('baidu.html')).toContain('nourl.ubs.baidu.com');
    expect(results.some((r) => r.url.includes('nourl.ubs.baidu.com'))).toBe(false);
  });

  it('de-duplicates and parses the printed dates', () => {
    expect(new Set(results.map((r) => r.url)).size).toBe(results.length);
    expect(results[0]!.publishedAt).toBe('2025-03-27T00:00:00.000Z');
    expect(results.filter((r) => r.publishedAt).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps snippets for most results', () => {
    const withSnippet = results.filter((r) => (r.snippet ?? '').length > 10);
    expect(withSnippet.length).toBeGreaterThanOrEqual(Math.ceil(results.length / 2));
  });

  it('honours the requested limit', () => {
    expect(parseBaiduResults(fixture('baidu.html'), BAIDU_URL, 3)).toHaveLength(3);
  });

  it('drops a container whose only destination is the nourl placeholder', () => {
    const html = `<div id="content_left">
      <div class="result c-container" mu="https://one.example/a"><h3><a href="https://www.baidu.com/link?url=aaa">First synthetic result headline</a></h3><div class="c-abstract">First synthetic snippet text that is long enough to keep.</div></div>
      <div class="result c-container" mu="https://two.example/b"><h3><a href="https://www.baidu.com/link?url=bbb">Second synthetic result headline</a></h3><div class="c-abstract">Second synthetic snippet text that is long enough to keep.</div></div>
      <div class="result c-container" mu="https://three.example/c"><h3><a href="https://www.baidu.com/link?url=ccc">Third synthetic result headline</a></h3><div class="c-abstract">Third synthetic snippet text that is long enough to keep.</div></div>
      <div class="result c-container" mu="http://nourl.ubs.baidu.com/61344"><h3><a href="http://nourl.ubs.baidu.com/61344">Onebox unit with no destination</a></h3><div class="c-abstract">This onebox has no destination at all.</div></div>
    </div>`;
    const parsed = parseBaiduResults(html, BAIDU_URL, 10);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((r) => r.url)).toEqual([
      'https://one.example/a',
      'https://two.example/b',
      'https://three.example/c',
    ]);
  });
});

describe('parseSogouResults', () => {
  let results: RawResult[] = [];

  beforeAll(() => {
    results = parseSogouResults(fixture('sogou.html'), SOGOU_URL, 25);
  });

  it('finds at least five organic results in a real capture', () => {
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses the real destination published in data-url, not the click wrapper', () => {
    expect(results.map((r) => r.url)).toContain('https://github.com/modelcontextprotocol');
    for (const result of results) {
      expect(result.url).not.toContain('sogou.com/link');
      expect(result.url).not.toContain('/link?url=');
      expect(result.url).not.toContain('hintidx');
    }
  });

  it('skips hintBox related-search containers', () => {
    // The capture contains hintBox blocks; none of them may surface as a result.
    expect(fixture('sogou.html')).toContain('hintBox');
    expect(results.some((r) => r.title.includes('大家还在搜'))).toBe(false);
    expect(results.some((r) => r.url.includes('user_ip='))).toBe(false);
  });

  it('parses dates that Sogou prints in its cite line', () => {
    expect(results.some((r) => r.publishedAt?.startsWith('2025-04-16'))).toBe(true);
    expect(results.filter((r) => r.publishedAt).length).toBeGreaterThanOrEqual(5);
  });

  it('keeps snippets for most results', () => {
    const withSnippet = results.filter((r) => (r.snippet ?? '').length > 10);
    expect(withSnippet.length).toBeGreaterThanOrEqual(Math.ceil(results.length / 2));
  });

  it('honours the requested limit', () => {
    expect(parseSogouResults(fixture('sogou.html'), SOGOU_URL, 2)).toHaveLength(2);
  });

  it('never returns a hintBox container even when it carries a title and a data-url', () => {
    const html = `<div class="vrwrap"><h3><a href="/link?url=hedJja1">First synthetic sogou result</a></h3><div data-url="https://sogou-one.example/a"></div><div class="space-txt">First synthetic snippet that is long enough.</div></div>
      <div class="vrwrap"><h3><a href="/link?url=hedJja2">Second synthetic sogou result</a></h3><div data-url="https://sogou-two.example/b"></div><div class="space-txt">Second synthetic snippet that is long enough.</div></div>
      <div class="vrwrap"><h3><a href="/link?url=hedJja3">Third synthetic sogou result</a></h3><div data-url="https://sogou-three.example/c"></div><div class="space-txt">Third synthetic snippet that is long enough.</div></div>
      <div class="vrwrap middle-better-hintBox" id="sogou_vr_30010467_2"><h3><a href="/web?query=related">Related searches you may want</a></h3><div data-url="https://hint.example/related"></div><div class="space-txt">Related search suggestions for the same query.</div></div>`;
    const parsed = parseSogouResults(html, SOGOU_URL, 10);
    expect(parsed.map((r) => r.url)).toEqual([
      'https://sogou-one.example/a',
      'https://sogou-two.example/b',
      'https://sogou-three.example/c',
    ]);
  });
});

describe('parseSo360Results', () => {
  let results: RawResult[] = [];

  beforeAll(() => {
    results = parseSo360Results(fixture('so360.html'), SO360_URL, 25);
  });

  it('returns the handful of organic results the capture contains', () => {
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const result of results) {
      expect(result.url).toMatch(/^https?:\/\//);
      expect(result.title.trim().length).toBeGreaterThan(0);
    }
  });

  it('uses data-mdurl for the destination rather than the /link?m= wrapper', () => {
    expect(results.map((r) => r.url)).toContain('http://uml.org.cn/ai/202507144.asp');
    for (const result of results) {
      expect(result.url).not.toContain('/link?m=');
    }
    // The displayed domain is preserved alongside the real URL.
    expect(results[0]!.meta?.displayUrl).toBe('www.uml.org.cn');
  });

  it('drops untitled header rows and fanyi.so.com translation units', () => {
    // The capture does contain translator units and one untitled header row.
    expect(fixture('so360.html')).toContain('fanyi.so.com');
    expect(fixture('so360.html')).toContain('360翻译');
    expect(hosts(results)).not.toContain('fanyi.so.com');
    expect(results.some((r) => r.title.includes('360翻译'))).toBe(false);
    expect(results.every((r) => r.title.trim().length > 0)).toBe(true);
  });

  it('keeps a snippet for every result', () => {
    for (const result of results) {
      expect((result.snippet ?? '').length).toBeGreaterThan(10);
    }
  });

  it('honours the requested limit', () => {
    expect(parseSo360Results(fixture('so360.html'), SO360_URL, 2)).toHaveLength(2);
  });

  it('drops header, translator and fanyi rows while keeping the organic ones', () => {
    const html = `<ul>
      <li class="res-list"><h3><a href="https://www.so.com/link?m=aaa">First synthetic so360 result</a></h3><cite>one.example</cite><div data-mdurl="https://so360-one.example/a"></div><div class="res-desc">Snippet text for the first synthetic so360 unit.</div></li>
      <li class="res-list"><h3><a href="https://www.so.com/link?m=bbb">Second synthetic so360 result</a></h3><cite>two.example</cite><div data-mdurl="https://so360-two.example/b"></div><div class="res-desc">Snippet text for the second synthetic so360 unit.</div></li>
      <li class="res-list"><h3><a href="https://www.so.com/link?m=ccc">Third synthetic so360 result</a></h3><cite>three.example</cite><div data-mdurl="https://so360-three.example/c"></div><div class="res-desc">Snippet text for the third synthetic so360 unit.</div></li>
      <li class="res-list"><div class="res-desc">Header row that has no title at all.</div></li>
      <li class="res-list"><h3><a href="https://www.so.com/link?m=ddd">360翻译 translation onebox</a></h3><div data-mdurl="https://fanyi.so.com/translate"></div><div class="res-desc">Translation unit text that must not become a result.</div></li>
      <li class="res-list"><h3><a href="https://www.so.com/link?m=eee">A normal looking title for a cite test</a></h3><cite>fanyi.so.com</cite><div data-mdurl="https://elsewhere.example/x"></div><div class="res-desc">Snippet text that belongs to the translator host.</div></li>
    </ul>`;
    const parsed = parseSo360Results(html, SO360_URL, 10);
    expect(parsed.map((r) => r.url)).toEqual([
      'https://so360-one.example/a',
      'https://so360-two.example/b',
      'https://so360-three.example/c',
    ]);
  });
});
