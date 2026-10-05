/**
 * Reproduce the two measurements quoted in the README.
 *
 *   npx tsx scripts/measure-savings.mts
 *
 * Section 1 is self-contained and always runs. Section 2 needs real HTML: it
 * uses the captured samples in `scratch/samples/` when they are present, and
 * otherwise downloads two public pages. Nothing here is a benchmark harness —
 * it exists so the numbers in the README can be checked rather than believed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { htmlToMarkdown } from '../src/html/markdown.ts';
import { estimateTokens } from '../src/util/text.ts';
import { renderSearchResults, searchResultsToJson } from '../src/tools/format.ts';

/* ------------------------------------------------------------------ *
 * Section 1 — Markdown vs JSON for the same search result set
 * ------------------------------------------------------------------ */

console.log('=== search output: Markdown vs JSON, identical result set ===\n');

const results = Array.from({ length: 10 }, (_, i) => ({
  title: `A representative result title number ${i + 1} about the model context protocol`,
  url: `https://example${i}.com/articles/2025/09/a-fairly-long-article-slug-${i}`,
  snippet:
    'A snippet of the kind search engines actually return, containing one or two sentences of context about the page so the reader can judge relevance before fetching it.',
  source: `example${i}.com`,
  engines: i % 3 === 0 ? ['duckduckgo', 'bing'] : ['bing'],
  bestRank: i + 1,
  score: 0.5 - i * 0.01,
  ...(i % 2 === 0 ? { publishedAt: '2025-09-26T00:00:00.000Z' } : {}),
}));

const renderOptions = {
  query: 'state of the art in retrieval augmented generation',
  results,
  enginesUsed: ['duckduckgo', 'bing'],
  enginesEmpty: ['mojeek'],
  enginesFailed: [],
  enginesSkipped: [],
  engineCounts: { duckduckgo: 6, bing: 10 },
  elapsedMs: 1200,
};

const markdown = renderSearchResults(renderOptions);
const json = JSON.stringify(searchResultsToJson(renderOptions), null, 2);
const markdownTokens = estimateTokens(markdown);
const jsonTokens = estimateTokens(json);

console.log(`markdown : ${markdown.length.toLocaleString('en-US')} chars, ~${markdownTokens.toLocaleString('en-US')} tokens`);
console.log(`json     : ${json.length.toLocaleString('en-US')} chars, ~${jsonTokens.toLocaleString('en-US')} tokens`);
console.log(`saving   : ${(100 - (markdownTokens / jsonTokens) * 100).toFixed(1)}% fewer tokens as Markdown\n`);

/* ------------------------------------------------------------------ *
 * Section 2 — raw HTML vs the Markdown this server returns
 * ------------------------------------------------------------------ */

console.log('=== page fetch: raw HTML vs returned Markdown ===\n');

interface PageSample {
  label: string;
  url: string;
  file?: string;
}

const samples: PageSample[] = [
  { label: 'MDN Fetch API', url: 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', file: 'scratch/samples/article-mdn.html' },
  { label: 'Bing results', url: 'https://www.bing.com/search?q=model+context+protocol', file: 'scratch/samples/bing.html' },
  { label: 'example.com', url: 'https://example.com/' },
];

const header = ['source', 'html kB', 'md kB', 'html tok', 'md tok', 'saving'];
console.log(header[0]!.padEnd(18) + header.slice(1).map((h) => h.padStart(10)).join(''));

let totalHtml = 0;
let totalMd = 0;
let measured = 0;

for (const sample of samples) {
  let html: string | undefined;

  if (sample.file && existsSync(sample.file)) {
    html = readFileSync(sample.file, 'utf8');
  } else {
    try {
      const res = await fetch(sample.url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; free-search-mcp measurement)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) html = await res.text();
    } catch {
      /* unavailable on this network; skip the row */
    }
  }

  if (!html) {
    console.log(sample.label.padEnd(18) + '  (unavailable — skipped)');
    continue;
  }

  const md = htmlToMarkdown(html, { url: sample.url }).markdown;
  const htmlTokens = estimateTokens(html);
  const mdTokens = estimateTokens(md);
  totalHtml += htmlTokens;
  totalMd += mdTokens;
  measured++;

  console.log(
    sample.label.padEnd(18) +
      (html.length / 1024).toFixed(0).padStart(10) +
      (md.length / 1024).toFixed(1).padStart(10) +
      htmlTokens.toLocaleString('en-US').padStart(10) +
      mdTokens.toLocaleString('en-US').padStart(10) +
      `${(100 - (mdTokens / htmlTokens) * 100).toFixed(1)}%`.padStart(10),
  );
}

if (measured > 0) {
  console.log(`\nTOTAL across ${measured} page(s): ${(100 - (totalMd / totalHtml) * 100).toFixed(1)}% fewer tokens than the raw HTML.`);
  console.log('Most of that is content extraction (chrome removed), not just the format.');
} else {
  console.log('\nNo page could be sampled. Section 1 above is network-independent.');
}
