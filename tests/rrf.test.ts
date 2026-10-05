import { describe, expect, it } from 'vitest';
import { contributionsByEngine, diversify, enforceDomainCap, fuseResults } from '../src/rrf.js';
import type { EngineRanking } from '../src/rrf.js';
import type { RawResult, SearchResult } from '../src/types.js';

/**
 * Options that switch every post-processing step off, so a test can look at the
 * raw RRF arithmetic. `limit: 0` and `maxPerDomain: 0` both mean "no cap".
 */
const RAW_ONLY = { consensusBonus: 0, maxPerDomain: 0, dedupeTitleThreshold: 0, limit: 0 } as const;
const K = 60; // the damping constant from the Cormack paper, and the default here

function raw(url: string, title = url, snippet = ''): RawResult {
  return { title, url, snippet };
}

function result(source: string, title: string, score = 1): SearchResult {
  return { title, url: `https://${source}/${title}`, snippet: '', source, engines: ['alpha'], bestRank: 1, score };
}

describe('fuseResults', () => {
  it('scores 1 / (k + rank) per engine and ranks agreement above a single hit', () => {
    const out = fuseResults(
      [
        { engine: 'alpha', results: [raw('https://both.example.com/'), raw('https://second.example.com/')] },
        { engine: 'beta', results: [raw('https://both.example.com/')] },
        { engine: 'gamma', results: [raw('https://only.example.com/')] },
      ],
      RAW_ONLY,
    );
    const byUrl = new Map(out.map((r) => [r.url, r]));

    // Rank 2 costs exactly one "damping step" more than rank 1.
    expect(byUrl.get('https://both.example.com/')!.score).toBe(Number(((1 / (K + 1)) * 2).toFixed(6)));
    expect(byUrl.get('https://only.example.com/')!.score).toBe(Number((1 / (K + 1)).toFixed(6)));
    expect(byUrl.get('https://second.example.com/')!.score).toBe(Number((1 / (K + 2)).toFixed(6)));

    // Same rank (1) in every engine: two engines beat one, and a rank-1 hit
    // beats a rank-2 hit. The scores are rounded to 6 decimals on the way out,
    // so the relationship is compared with a tolerance rather than exactly.
    expect(out[0]!.url).toBe('https://both.example.com/');
    expect(byUrl.get('https://both.example.com/')!.score).toBeCloseTo(byUrl.get('https://only.example.com/')!.score * 2, 5);
    expect(byUrl.get('https://only.example.com/')!.score).toBeGreaterThan(byUrl.get('https://second.example.com/')!.score);
    expect(out[0]!.bestRank).toBe(1);
  });

  it('scales contributions by engine weight and ignores a weight of zero', () => {
    const out = fuseResults(
      [
        { engine: 'scraper', results: [raw('https://scraped.example.com/')] },
        { engine: 'api', weight: 2, results: [raw('https://api.test.org/')] },
      ],
      RAW_ONLY,
    );
    const api = out.find((r) => r.url === 'https://api.test.org/')!;
    const scraped = out.find((r) => r.url === 'https://scraped.example.com/')!;
    // A high-precision API at the same rank outweighs a scraper.
    expect(api.score).toBe(Number(((1 / (K + 1)) * 2).toFixed(6)));
    expect(api.score).toBeCloseTo(scraped.score * 2, 5);
    expect(out[0]!.url).toBe('https://api.test.org/');

    expect(fuseResults([{ engine: 'off', weight: 0, results: [raw('https://gone.example.com/')] }], RAW_ONLY)).toEqual([]);
  });

  it('adds a consensus bonus per extra engine that agrees', () => {
    const rankings: EngineRanking[] = [
      { engine: 'alpha', results: [raw('https://both.example.com/')] },
      { engine: 'beta', results: [raw('https://both.example.com/')] },
      { engine: 'gamma', results: [raw('https://both.example.com/')] },
    ];
    const without = fuseResults(rankings, { ...RAW_ONLY, consensusBonus: 0 });
    const with0_12 = fuseResults(rankings, { ...RAW_ONLY, consensusBonus: 0.12 });
    const base = Number(((1 / (K + 1)) * 3).toFixed(6));

    expect(without[0]!.score).toBe(base);
    // Three engines => two "extra" agreements on top of the plain RRF sum.
    expect(with0_12[0]!.score).toBe(Number((base + 0.12 * 2).toFixed(6)));
  });

  it('collapses the same page reported by several engines into one result', () => {
    const out = fuseResults(
      [
        { engine: 'alpha', results: [raw('https://www.example.com/doc/?utm_source=nl#top', 'Doc', 'short')] },
        { engine: 'beta', results: [raw('https://example.com/doc', 'Doc from beta', 'a much longer snippet from the beta engine')] },
        { engine: 'gamma', results: [raw('https://example.com/doc/', 'Doc three')] },
      ],
      RAW_ONLY,
    );

    expect(out).toHaveLength(1);
    expect(out[0]!.url).toBe('https://example.com/doc');
    expect(out[0]!.source).toBe('example.com');
    expect([...out[0]!.engines].sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(out[0]!.score).toBe(Number(((1 / (K + 1)) * 3).toFixed(6)));
    // The merge keeps the richest title and the longest snippet, so the user
    // sees the best text any engine offered rather than whichever came first.
    expect(out[0]!.title).toBe('Doc from beta');
    expect(out[0]!.snippet).toBe('a much longer snippet from the beta engine');
  });

  it('counts a URL once per engine even if that engine lists it twice', () => {
    const out = fuseResults(
      [
        {
          engine: 'alpha',
          results: [raw('https://example.com/page?utm_source=a'), raw('https://example.com/page?utm_source=b'), raw('https://other.test.org/x')],
        },
      ],
      RAW_ONLY,
    );

    expect(out).toHaveLength(2);
    const page = out.find((r) => r.url === 'https://example.com/page')!;
    // If the duplicate were counted, the page would gain a rank-2 contribution.
    expect(page.score).toBe(Number((1 / (K + 1)).toFixed(6)));
    expect(page.engines).toEqual(['alpha']);
  });

  it('folds near-identical titles from the same host but keeps different pages', () => {
    const rankings: EngineRanking[] = [
      {
        engine: 'alpha',
        results: [
          raw('https://news.example.com/a', 'Node.js 24 released with new features'),
          raw('https://news.example.com/b', 'Node.js 24 released with new features today'),
          raw('https://news.example.com/c', 'Weekly roundup: what changed in the JavaScript ecosystem'),
        ],
      },
    ];

    // The two "Node.js 24" titles are 0.8 similar: syndicated copies of one story.
    expect(fuseResults(rankings, { ...RAW_ONLY, dedupeTitleThreshold: 0.75 }).map((r) => r.title)).toEqual([
      'Node.js 24 released with new features',
      'Weekly roundup: what changed in the JavaScript ecosystem',
    ]);
    // The default threshold is stricter, so both copies survive untouched.
    expect(fuseResults(rankings, { ...RAW_ONLY, dedupeTitleThreshold: 0.82 })).toHaveLength(3);
  });

  it('does not fold identical titles that live on different hosts', () => {
    const out = fuseResults(
      [
        {
          engine: 'alpha',
          results: [raw('https://one.example.com/', 'Documentation'), raw('https://two.test.org/', 'Documentation')],
        },
      ],
      { ...RAW_ONLY, dedupeTitleThreshold: 0.82 },
    );
    // Generic titles are common; only same-host copies are treated as duplicates.
    expect(out).toHaveLength(2);
  });

  it('pushes per-domain overflow to the back instead of dropping it', () => {
    const out = fuseResults(
      [
        {
          engine: 'alpha',
          results: [
            raw('https://a.example.com/1', 'one'),
            raw('https://a.example.com/2', 'two'),
            raw('https://a.example.com/3', 'three'),
            raw('https://b.test.org/1', 'other'),
          ],
        },
      ],
      { ...RAW_ONLY, maxPerDomain: 2 },
    );

    expect(out).toHaveLength(4); // the count is preserved: nothing is thrown away
    expect(out.map((r) => r.source)).toEqual(['example.com', 'example.com', 'test.org', 'example.com']);
    expect(out[2]!.url).toBe('https://b.test.org/1'); // the cap promotes a second site
    expect(out[3]!.url).toBe('https://a.example.com/3'); // and demotes only the overflow
  });

  it('applies the limit to the de-duplicated list', () => {
    const out = fuseResults(
      [
        {
          engine: 'alpha',
          results: [
            raw('https://a.example.com/1', 'one'),
            raw('https://a.example.com/1?utm_source=x', 'one again'),
            raw('https://b.test.org/2', 'two'),
            raw('https://c.test.org/3', 'three'),
          ],
        },
      ],
      { ...RAW_ONLY, limit: 2 },
    );
    // A duplicate must not eat one of the two slots the caller asked for.
    expect(out.map((r) => r.url)).toEqual(['https://a.example.com/1', 'https://b.test.org/2']);
  });

  it('promotes and demotes configured domains', () => {
    const out = fuseResults(
      [
        { engine: 'alpha', results: [raw('https://docs.example.com/page', 'Docs')] },
        { engine: 'beta', results: [raw('https://farm.test.org/page', 'Farm')] },
      ],
      { ...RAW_ONLY, promoteDomains: ['example.com'], demoteDomains: ['test.org'] },
    );

    expect(out[0]!.url).toBe('https://docs.example.com/page');
    expect(out[0]!.score).toBe(Number(((1 / (K + 1)) * 1.15).toFixed(6)));
    expect(out[1]!.score).toBe(Number(((1 / (K + 1)) * 0.5).toFixed(6)));
  });

  it('keeps a stable order for equal scores', () => {
    // Equal score, equal bestRank and the same title: the first engine seen wins.
    const tied = fuseResults(
      [
        { engine: 'alpha', results: [raw('https://one.example.com/', 'Same title')] },
        { engine: 'beta', results: [raw('https://two.test.org/', 'Same title')] },
      ],
      RAW_ONLY,
    );
    expect(tied.map((r) => r.url)).toEqual(['https://one.example.com/', 'https://two.test.org/']);

    // Still tied, but the titles differ: the tie-break is alphabetical so that
    // the same input always produces the same output.
    const byTitle = fuseResults(
      [
        { engine: 'alpha', results: [raw('https://zzz.example.com/', 'Zebra guide')] },
        { engine: 'beta', results: [raw('https://aaa.test.org/', 'Ant guide')] },
      ],
      RAW_ONLY,
    );
    expect(byTitle.map((r) => r.title)).toEqual(['Ant guide', 'Zebra guide']);
  });
});

describe('enforceDomainCap', () => {
  it('returns the input untouched when the cap is disabled', () => {
    const input = [result('a', '1'), result('a', '2'), result('a', '3')];
    expect(enforceDomainCap(input, 0)).toEqual(input);
  });
});

describe('diversify', () => {
  it('interleaves domains so the same site does not repeat inside the window', () => {
    const input = [
      result('a', 'a1'),
      result('a', 'a2'),
      result('a', 'a3'),
      result('b', 'b1'),
      result('b', 'b2'),
      result('c', 'c1'),
    ];
    const out = diversify(input, 2);

    expect(out).toHaveLength(input.length); // reordering only, never a loss
    expect(out.map((r) => r.source)).toEqual(['a', 'b', 'c', 'a', 'b', 'a']);
    expect(new Set(out.slice(0, 3).map((r) => r.source)).size).toBe(3);
    expect(diversify([], 3)).toEqual([]);
  });
});

describe('contributionsByEngine', () => {
  it('counts how many fused results each engine surfaced', () => {
    const out = fuseResults(
      [
        { engine: 'alpha', results: [raw('https://a.example.com/1'), raw('https://b.example.com/2')] },
        { engine: 'beta', results: [raw('https://b.example.com/2'), raw('https://c.example.com/3')] },
      ],
      RAW_ONLY,
    );
    expect(contributionsByEngine(out)).toEqual({ alpha: 2, beta: 2 });
    expect(contributionsByEngine([])).toEqual({});
  });
});
