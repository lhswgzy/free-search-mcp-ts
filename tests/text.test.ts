import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  makeSnippet,
  mdCell,
  mdLinkText,
  scoreBlock,
  selectPassages,
  shingleSimilarity,
  splitBlocks,
  splitSentences,
  tokenize,
  truncate,
  uniqueTerms,
} from '../src/util/text.js';

describe('tokenize', () => {
  it('lowercases, drops stopwords and short tokens, and keeps numbers', () => {
    // "The" is a stopword, "go" is under the three-character floor, but a pure
    // digit run is kept because years and versions are real query terms.
    expect(tokenize('The Quick, brown-fox! 42 and go')).toEqual(['quick', 'brown-fox', '42']);
  });

  it('can keep stopwords when a caller needs every surface form', () => {
    expect(tokenize('the cat', { keepStopwords: true })).toEqual(['the', 'cat']);
  });

  it('strips punctuation surrounding a token', () => {
    expect(tokenize('(hello), "world"!')).toEqual(['hello', 'world']);
  });

  it('splits a CJK run into overlapping bigrams', () => {
    expect(tokenize('模型上下文协议')).toEqual(['模型', '型上', '上下', '下文', '文协', '协议']);
    // A two-character run must yield exactly one bigram: one bigram too many
    // would make FTS phrase queries match text that is not there.
    expect(tokenize('上下')).toEqual(['上下']);
    expect(tokenize('中')).toEqual(['中']);
  });

  it('handles mixed Latin and CJK text', () => {
    expect(tokenize('FTS5 上下文 search')).toEqual(['fts5', 'search', '上下', '下文']);
  });
});

describe('uniqueTerms', () => {
  it('de-duplicates terms while preserving first-seen order', () => {
    expect(uniqueTerms('Apple apple banana APPLE')).toEqual(['apple', 'banana']);
  });
});

describe('truncate', () => {
  const text = 'This sentence ends here ok. Second sentence goes on and on and on.';

  it('returns short text unchanged', () => {
    expect(truncate('hello', 40)).toBe('hello');
  });

  it('cuts at a sentence boundary when one is late enough to be useful', () => {
    // The boundary sits past 60% of the budget, so it is preferred over a
    // mid-word cut, and the ellipsis signals the omission.
    expect(truncate(text, 40)).toBe('This sentence ends here ok.…');
  });

  it('never returns more than the requested maximum', () => {
    const long = `${text} ${'word '.repeat(60)}`;
    for (let max = 1; max <= 120; max++) {
      expect(truncate(long, max).length).toBeLessThanOrEqual(max);
    }
  });

  it('returns nothing when there is no room at all', () => {
    // A zero-character budget cannot be honoured with an ellipsis, which would
    // be one character too many.
    expect(truncate('abcdef', 0)).toBe('');
  });
});

describe('estimateTokens', () => {
  it('is zero for empty input and grows with the text', () => {
    expect(estimateTokens('')).toBe(0);
    const words = 'the quick brown fox jumps over the lazy dog again and again '.repeat(3);
    let previous = 0;
    for (let i = 1; i <= words.length; i++) {
      const estimate = estimateTokens(words.slice(0, i));
      expect(estimate).toBeGreaterThanOrEqual(previous);
      previous = estimate;
    }
    expect(previous).toBeGreaterThan(0);
  });

  it('counts CJK text as denser than Latin text', () => {
    // ~1.5 chars per token for CJK against ~4 for Latin: a budget check that
    // ignored this would overrun the context window on Chinese pages.
    expect(estimateTokens('中'.repeat(100))).toBeGreaterThan(estimateTokens('a'.repeat(100)));
  });
});

describe('splitSentences', () => {
  it('splits ordinary prose on sentence terminators', () => {
    expect(splitSentences('One. Two.')).toEqual(['One.', 'Two.']);
    expect(splitSentences('')).toEqual([]);
  });

  it('keeps an "e.g." abbreviation inside its sentence', () => {
    expect(splitSentences('We tried e.g. the first option. It worked.')).toEqual([
      'We tried e.g. the first option.',
      'It worked.',
    ]);
  });

  it('keeps a "vs." abbreviation inside its sentence', () => {
    expect(splitSentences('We compared Rust vs. Go. Both are fast.')).toEqual(['We compared Rust vs. Go.', 'Both are fast.']);
  });
});

describe('splitBlocks', () => {
  const markdown = '# Title\n\nIntro paragraph here.\n\n```js\nconst secret = 1;\n```\n\nClosing paragraph.';

  it('excludes fenced code and keeps the surrounding paragraphs', () => {
    const blocks = splitBlocks(markdown).map((b) => b.text);
    expect(blocks).toEqual(['# Title', 'Intro paragraph here.', 'Closing paragraph.']);
    expect(blocks.join('\n')).not.toContain('const secret');
  });

  it('reports offsets that address the original document', () => {
    for (const block of splitBlocks(markdown)) {
      expect(markdown.slice(block.offset, block.offset + block.text.length)).toBe(block.text);
    }
  });
});

describe('scoreBlock', () => {
  const terms = tokenize('sqlite fts5 cache');

  it('ranks a paragraph covering more query terms above one that covers fewer', () => {
    const covers = scoreBlock('The sqlite fts5 cache stores pages locally in a table for fast lookups.', terms);
    const misses = scoreBlock('The sqlite documentation is available online for everyone to read today.', terms);
    expect(covers).toBeGreaterThan(misses);
  });

  it('scores nothing without terms or without a block', () => {
    expect(scoreBlock('some text', [])).toBe(0);
    expect(scoreBlock('', terms)).toBe(0);
  });

  it('adds a recency prior when asked for one', () => {
    const block = 'The sqlite fts5 cache was rewritten in 2024 with a new index.';
    const plain = scoreBlock(block, terms);
    expect(scoreBlock(block, terms, { preferRecent: true }) - plain).toBeCloseTo(0.1, 10);
  });
});

describe('selectPassages', () => {
  // Paragraphs are separated by ~200 character fillers so that the overlap
  // guard (which tolerates nearby blocks) cannot reject neighbours.
  const filler = `Filler ${'word '.repeat(40)}`;
  const doc = [
    'SQLite FTS5 gives full text search with bm25 ranking for local pages.',
    filler,
    'A second paragraph also mentions sqlite and fts5 with different wording.',
    filler,
    'The third sqlite paragraph repeats the fts5 term to raise its coverage.',
    filler,
    'Finally the fourth sqlite fts5 paragraph closes the document body here.',
  ].join('\n\n');

  it('returns matching passages in document order with faithful offsets', () => {
    const passages = selectPassages(doc, 'sqlite fts5');
    expect(passages).toHaveLength(4);
    for (let i = 1; i < passages.length; i++) {
      expect(passages[i]!.offset).toBeGreaterThan(passages[i - 1]!.offset);
    }
    for (const passage of passages) {
      expect(doc.slice(passage.offset, passage.offset + passage.text.length)).toBe(passage.text);
    }
    // Non-overlapping: the brief must not quote the same bytes twice.
    for (let i = 1; i < passages.length; i++) {
      expect(passages[i - 1]!.offset + passages[i - 1]!.text.length).toBeLessThanOrEqual(passages[i]!.offset);
    }
  });

  it('honours maxPassages', () => {
    expect(selectPassages(doc, 'sqlite fts5', { maxPassages: 2 })).toHaveLength(2);
  });

  it('honours maxCharsPerPassage', () => {
    const passages = selectPassages(doc, 'sqlite fts5', { maxCharsPerPassage: 40 });
    expect(passages.length).toBeGreaterThan(0);
    for (const passage of passages) expect(passage.text.length).toBeLessThanOrEqual(40);
  });

  it('stops adding passages once maxTotalChars is reached', () => {
    const roomy = selectPassages(doc, 'sqlite fts5', { maxTotalChars: 2400 });
    expect(roomy).toHaveLength(4);
    expect(roomy.reduce((total, p) => total + p.text.length, 0)).toBeLessThanOrEqual(2400);

    // The first passage is always kept even when it alone exceeds the budget, so
    // the overshoot is bounded by one passage rather than being unbounded.
    expect(selectPassages(doc, 'sqlite fts5', { maxTotalChars: 20 })).toHaveLength(1);
  });

  it('falls back to the document lead when nothing matches', () => {
    const passages = selectPassages('# Intro\n\nNothing relevant here at all.\n\nAnother paragraph about cooking.', 'zzzqqq');
    expect(passages).toHaveLength(1);
    expect(passages[0]!.offset).toBe(0);
    expect(passages[0]!.score).toBe(0);
    expect(passages[0]!.text.startsWith('# Intro')).toBe(true);
  });

  it('returns nothing for an empty document', () => {
    expect(selectPassages('', 'anything')).toEqual([]);
  });
});

describe('makeSnippet', () => {
  it('centres the window on the first query match', () => {
    const body = `${'x'.repeat(500)} needle ${'y'.repeat(500)}`;
    const snippet = makeSnippet(body, 'needle', 100);
    expect(snippet).toContain('needle');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(100 + 2); // the two ellipses
  });

  it('returns short bodies unchanged and strips html tags', () => {
    expect(makeSnippet('short text', 'short')).toBe('short text');
    expect(makeSnippet('<p>Hello <b>world</b></p>', 'world')).toBe('Hello world');
  });

  it('still returns a bounded snippet when the query does not occur', () => {
    const body = `${'x'.repeat(500)} needle ${'y'.repeat(500)}`;
    const snippet = makeSnippet(body, 'zzz', 100);
    expect(snippet.length).toBeLessThanOrEqual(100);
    expect(snippet).not.toContain('needle');
  });
});

describe('shingleSimilarity', () => {
  it('is 1 for identical strings and 0 for unrelated ones', () => {
    expect(shingleSimilarity('SQLite full text search', 'SQLite full text search')).toBe(1);
    expect(shingleSimilarity('SQLite full text search engine', 'Cooking with cast iron pans')).toBe(0);
    expect(shingleSimilarity('', 'anything')).toBe(0);
  });

  it('scores syndicated near-duplicate titles high', () => {
    // 0.8 is high enough for title de-duplication but still under the 0.82
    // default threshold, which is why the RRF tests pass an explicit value.
    expect(shingleSimilarity('Node.js 24 released with new features', 'Node.js 24 released with new features today')).toBe(0.8);
  });
});

describe('markdown escaping', () => {
  it('escapes table cells so one pipe cannot break the table', () => {
    expect(mdCell('a|b')).toBe('a\\|b');
    expect(mdCell('line one\nline two')).toBe('line one line two');
  });

  it('strips brackets from link text', () => {
    expect(mdLinkText('[bracketed] text')).toBe('bracketed text');
  });
});
