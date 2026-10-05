/**
 * Markdown-first renderers for every tool response.
 *
 * The whole reason this server returns Markdown instead of JSON is token cost:
 * JSON spends roughly 40 % of its bytes on braces, quotes and repeated key
 * names, none of which help a model. Every renderer here is written to be
 * compact *and* unambiguous, and each one is paired with an opt-in JSON path
 * (`format: "json"`) for callers that want to post-process.
 */

import type { EngineHealth, FetchedPage, ResearchReport, ResearchSource, SearchResult } from '../types.js';
import { estimateTokens, mdCell, mdLinkText, truncate } from '../util/text.js';

/** A one-line provenance banner: `12 results · 4 engines · 1.3 s`. */
export function banner(parts: (string | undefined | false | null)[]): string {
  const items = parts.filter((p): p is string => Boolean(p));
  return items.length ? `_${items.join(' · ')}_` : '';
}

export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

export function ms(value: number): string {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function tokens(text: string): string {
  return `~${estimateTokens(text).toLocaleString('en-US')} tokens`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ *
 * web_search
 * ------------------------------------------------------------------ */

export interface SearchRenderOptions {
  query: string;
  results: SearchResult[];
  enginesUsed: string[];
  enginesEmpty: string[];
  enginesFailed: { engine: string; error: string }[];
  enginesSkipped: string[];
  engineCounts: Record<string, number>;
  elapsedMs: number;
  cached?: boolean;
  /** Include the per-result engine attribution line. */
  showEngines?: boolean;
  /** Cap snippet length in characters. */
  snippetChars?: number;
  headingLevel?: number;
}

/** Render matches as a numbered Markdown list with provenance. */
export function renderSearchResults(options: SearchRenderOptions): string {
  const {
    query,
    results,
    enginesUsed,
    enginesEmpty,
    enginesFailed,
    enginesSkipped,
    engineCounts,
    elapsedMs,
    showEngines = true,
    snippetChars = 320,
  } = options;
  const h = '#'.repeat(options.headingLevel ?? 1);
  const lines: string[] = [];

  lines.push(`${h} Search results for \`${query}\``);
  lines.push('');

  if (results.length === 0) {
    lines.push(
      banner([
        'no results',
        enginesUsed.length ? `engines: ${enginesUsed.join(', ')}` : undefined,
        ms(elapsedMs),
      ]),
    );
    lines.push('');
    lines.push('No engine returned a usable result. Suggestions:');
    lines.push('');
    lines.push('- Try a shorter or differently worded query.');
    lines.push('- Broaden it: drop quotes, `site:` filters and rare jargon.');
    lines.push('- Check `list_engines` — a provider may be benched after repeated blocks.');
    if (enginesFailed.length) {
      lines.push('');
      lines.push('**Engine errors**');
      for (const failure of enginesFailed) lines.push(`- \`${failure.engine}\`: ${failure.error}`);
    }
    return lines.join('\n');
  }

  const engineSummary = Object.entries(engineCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([engine, count]) => `${engine} ${count}`)
    .join(', ');

  lines.push(
    banner([
      plural(results.length, 'result'),
      `${plural(enginesUsed.length, 'engine')} (${enginesUsed.join(', ')})`,
      ms(elapsedMs),
      options.cached ? 'partly cached' : undefined,
    ]),
  );
  lines.push('');

  results.forEach((result, index) => {
    const title = mdLinkText(result.title);
    lines.push(`${index + 1}. **[${title}](${result.url})**`);
    const meta: string[] = [`\`${result.source}\``];
    if (showEngines && result.engines.length) {
      meta.push(result.engines.length > 1 ? `${result.engines[0]} +${result.engines.length - 1}` : result.engines[0]!);
    }
    if (result.publishedAt) meta.push(formatDate(result.publishedAt));
    lines.push(`   ${meta.join(' · ')}`);
    if (result.snippet) {
      lines.push(`   ${truncate(result.snippet, snippetChars).replace(/\n+/g, ' ')}`);
    }
    lines.push('');
  });

  const notes: string[] = [];
  if (engineSummary) notes.push(`**Per-engine counts:** ${engineSummary}`);
  if (enginesEmpty.length) notes.push(`**Returned nothing:** ${enginesEmpty.join(', ')}`);
  if (enginesSkipped.length) {
    notes.push(`**Skipped (temporarily benched after repeated failures):** ${enginesSkipped.join(', ')}`);
  }
  if (enginesFailed.length) {
    notes.push(
      `**Errors:** ${enginesFailed
        .slice(0, 6)
        .map((f) => `\`${f.engine}\` — ${truncate(f.error, 120)}`)
        .join('; ')}`,
    );
  }
  if (notes.length) {
    lines.push('---');
    lines.push(...notes.map((n) => `_${n}_`));
  }

  return lines.join('\n').trimEnd();
}

/** Machine-readable projection of a search result (used when `format: json`). */
export function searchResultsToJson(options: SearchRenderOptions): Record<string, unknown> {
  return {
    query: options.query,
    count: options.results.length,
    elapsedMs: options.elapsedMs,
    enginesUsed: options.enginesUsed,
    enginesEmpty: options.enginesEmpty,
    enginesFailed: options.enginesFailed,
    enginesSkipped: options.enginesSkipped,
    engineCounts: options.engineCounts,
    results: options.results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      source: r.source,
      engines: r.engines,
      score: r.score,
      bestRank: r.bestRank,
      ...(r.publishedAt ? { publishedAt: r.publishedAt } : {}),
      ...(r.meta ? { meta: r.meta } : {}),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * fetch_url
 * ------------------------------------------------------------------ */

export interface FetchRenderOptions {
  page: FetchedPage;
  includeLinks?: boolean;
  maxLinkCount?: number;
  headingLevel?: number;
}

/** Render a fetched page as a headed Markdown document. */
export function renderFetchedPage(options: FetchRenderOptions): string {
  const { page, includeLinks = false, maxLinkCount = 25 } = options;
  const lines: string[] = [];

  const facts: string[] = [
    `\`${displayHost(page.finalUrl)}\``,
    `${page.wordCount.toLocaleString('en-US')} words`,
    tokens(page.content),
    page.document ? page.document.kind.toUpperCase() : page.contentFormat,
    page.cached ? `cached, fetched ${formatDate(page.fetchedAt)}` : `fetched ${formatDate(page.fetchedAt)}`,
  ];
  if (page.publishedAt) facts.push(`published ${formatDate(page.publishedAt)}`);
  if (page.byline) facts.push(`by ${page.byline}`);

  lines.push(`# ${mdLinkText(page.title) || displayHost(page.finalUrl)}`);
  lines.push('');
  lines.push(banner(facts));
  lines.push('');
  if (page.finalUrl !== page.url) {
    lines.push(`_Requested: ${page.url}_`);
    lines.push('');
  }
  if (page.document && page.document.sheets?.length) {
    lines.push(`_Sheets: ${page.document.sheets.map((s) => `${s.name} (${s.rows}×${s.cols})`).join(', ')}_`);
    lines.push('');
  }
  if (page.warnings?.length) {
    for (const warning of page.warnings) lines.push(`> ⚠︎ ${warning}`);
    lines.push('');
  }

  lines.push(stripLeadingTitle(page.content.trim(), page.title));
  lines.push('');

  if (page.truncated) {
    lines.push('---');
    lines.push(
      `_Content truncated. Continue with \`offset: ${page.nextOffset}\` to read the rest._`,
    );
    lines.push('');
  }

  if (includeLinks && page.links?.length) {
    lines.push('---');
    lines.push(`## Outgoing links (${Math.min(page.links.length, maxLinkCount)} of ${page.links.length})`);
    lines.push('');
    for (const link of page.links.slice(0, maxLinkCount)) {
      lines.push(`- [${mdLinkText(link.text) || link.url}](${link.url})`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/* ------------------------------------------------------------------ *
 * research
 * ------------------------------------------------------------------ */

/**
 * Render the research brief.
 *
 * The brief is deliberately *extractive*: this project has no model of its own,
 * so instead of pretending to summarise it selects the passages from each
 * source that best answer the query and labels every claim with a citation.
 * The calling model does the writing; the hard part — finding, fetching,
 * de-duplicating and locating the relevant paragraphs — is done here.
 */
export function renderResearchBrief(report: ResearchReport, options: { passagesPerSource?: number; passageChars?: number } = {}): string {
  const lines: string[] = [];
  const ok = report.sources.filter((s) => !s.error);

  lines.push(`# Research brief: \`${report.query}\``);
  lines.push('');
  lines.push(
    banner([
      `depth ${report.depth}`,
      plural(report.queries.length, 'query', 'queries'),
      plural(ok.length, 'source'),
      ms(report.elapsedMs),
      `generated ${report.generatedAt}`,
    ]),
  );
  lines.push('');
  lines.push(
    '> Extractive brief: every passage below is quoted from the cited source, in the order it appears there. ' +
      'Nothing is paraphrased by this server — synthesise the findings yourself and cite the numbered sources.',
  );
  lines.push('');

  // Table of contents with the useful facts up front.
  lines.push('## Sources at a glance');
  lines.push('');
  lines.push('| # | Source | Title | Engines | Words | Published |');
  lines.push('|---|--------|-------|---------|-------|-----------|');
  for (const source of report.sources) {
    const title = truncate(mdCell(source.title), 70);
    if (source.error) {
      lines.push(`| ${source.index} | \`${source.source || '—'}\` | ${title} | ${source.engines.join(', ') || '—'} | — | _fetch failed_ |`);
      continue;
    }
    lines.push(
      `| ${source.index} | \`${source.source}\` | ${title} | ${source.engines.join(', ') || '—'} | ${source.wordCount.toLocaleString('en-US')} | ${
        source.publishedAt ? formatDate(source.publishedAt) : '—'
      } |`,
    );
  }
  lines.push('');

  const queriesRun = report.queries;
  if (queriesRun.length > 1) {
    lines.push(`**Queries executed:** ${queriesRun.map((q) => `\`${q}\``).join(', ')}`);
    lines.push('');
  }

  // Per-source evidence.
  for (const source of report.sources) {
    lines.push(`## ${source.index}. [${mdLinkText(source.title) || source.source}](${source.url})`);
    lines.push('');
    if (source.error) {
      lines.push(`> ⚠︎ Could not fetch this source: ${source.error}`);
      lines.push('');
      continue;
    }
    const facts = [
      `\`${source.source}\``,
      `${source.wordCount.toLocaleString('en-US')} words`,
      source.engines.length ? `found by ${source.engines.join(', ')}` : undefined,
      source.publishedAt ? `published ${formatDate(source.publishedAt)}` : undefined,
      source.cached ? 'cached' : undefined,
    ];
    lines.push(banner(facts));
    lines.push('');
    if (source.passages.length === 0) {
      lines.push('_No passage in this source matched the query terms._');
      lines.push('');
      continue;
    }
    for (const passage of source.passages) {
      const text = truncate(passage.text.replace(/\n{2,}/g, '\n'), options.passageChars ?? 900);
      // Block-quote every line so multi-paragraph passages stay one quote.
      lines.push(
        text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n'),
      );
      lines.push('');
    }
  }

  // Honest reporting of the gaps.
  const failed = report.sources.filter((s) => s.error);
  const notes: string[] = [];
  notes.push(`**Engines used:** ${report.enginesUsed.join(', ') || 'none'}`);
  if (report.enginesFailed.length) {
    notes.push(
      `**Engines that failed:** ${report.enginesFailed
        .slice(0, 8)
        .map((f) => `\`${f.engine}\` (${truncate(f.error, 90)})`)
        .join('; ')}`,
    );
  }
  if (failed.length) {
    notes.push(`**Sources that could not be fetched:** ${failed.map((f) => `[${f.index}] ${f.source}`).join(', ')}`);
  }
  if (notes.length) {
    lines.push('---');
    lines.push(...notes.map((n) => `_${n}_`));
  }

  return lines.join('\n').trimEnd();
}

/* ------------------------------------------------------------------ *
 * Engines, cache, index
 * ------------------------------------------------------------------ */

export function renderEngineTable(
  engines: { id: string; label: string; kind: string; tier: string; weight: number; requiresKey: boolean; keyEnv?: string; configured: boolean; note?: string }[],
  health?: EngineHealth[],
): string {
  const healthById = new Map((health ?? []).map((h) => [h.engine, h]));
  const lines: string[] = [];
  lines.push('# Available search engines');
  lines.push('');
  lines.push('| Engine | Tier | Kind | Weight | Key | Status | Notes |');
  lines.push('|--------|------|------|--------|-----|--------|-------|');
  for (const engine of engines) {
    const h = healthById.get(engine.id);
    const status = !engine.configured
      ? engine.keyEnv
        ? `no key (set \`${engine.keyEnv}\`)`
        : 'not configured'
      : h?.skipped
        ? `benched${h.error ? `: ${truncate(h.error, 40)}` : ''}`
        : h && !h.ok
          ? `failing: ${truncate(h.error ?? '', 40)}`
          : 'ready';
    lines.push(
      `| \`${engine.id}\` | ${engine.tier} | ${engine.kind} | ${engine.weight.toFixed(2)} | ${
        engine.requiresKey ? `yes (${engine.keyEnv ?? '—'})` : 'no'
      } | ${mdCell(status)} | ${mdCell(engine.note ?? '')} |`,
    );
  }
  lines.push('');
  lines.push(
    '_Tiers: `primary` runs by default, `fallback` runs when the primary tier returns too little, ' +
      '`api` runs when the query matches its subject, `optional` and `keyed` run only when selected or configured._',
  );
  return lines.join('\n');
}

export function renderCacheStats(stats: {
  enabled: boolean;
  path: string | null;
  pages: number;
  searchCacheEntries: number;
  bytes: number;
  oldestFetchedAt: string | null;
  newestFetchedAt: string | null;
  fts5: boolean;
}): string {
  const lines: string[] = [];
  lines.push('# Local index status');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Enabled | ${stats.enabled ? 'yes' : 'no'} |`);
  lines.push(`| Engine | ${stats.fts5 ? 'SQLite FTS5' : 'in-memory LRU (degraded)'} |`);
  lines.push(`| Database | \`${stats.path ?? '—'}\` |`);
  lines.push(`| Cached pages | ${stats.pages.toLocaleString('en-US')} |`);
  lines.push(`| Cached engine responses | ${stats.searchCacheEntries.toLocaleString('en-US')} |`);
  lines.push(`| Size on disk | ${formatBytes(stats.bytes)} |`);
  lines.push(`| Oldest page | ${stats.oldestFetchedAt ?? '—'} |`);
  lines.push(`| Newest page | ${stats.newestFetchedAt ?? '—'} |`);
  lines.push('');
  lines.push('_All data stays on this machine. Nothing is uploaded anywhere._');
  return lines.join('\n');
}

export function renderIndexHits(
  query: string,
  hits: { url: string; title: string; snippet: string; score: number; fetchedAt: string }[],
): string {
  const lines: string[] = [];
  lines.push(`# Local index matches for \`${query}\``);
  lines.push('');
  if (hits.length === 0) {
    lines.push('_Nothing in the local index matches. Fetch some pages first, or search the web._');
    return lines.join('\n');
  }
  lines.push(banner([plural(hits.length, 'page'), 'previously fetched']));
  lines.push('');
  hits.forEach((hit, index) => {
    lines.push(`${index + 1}. **[${mdLinkText(hit.title) || hit.url}](${hit.url})**`);
    lines.push(`   \`${displayHost(hit.url)}\` · score ${hit.score} · fetched ${formatDate(hit.fetchedAt)}`);
    if (hit.snippet) lines.push(`   ${hit.snippet.replace(/\s+/g, ' ')}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

export function formatDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const date = new Date(parsed);
  const now = Date.now();
  const diff = now - parsed;
  const day = 86_400_000;
  if (diff >= 0 && diff < day) {
    const hours = Math.floor(diff / 3_600_000);
    if (hours < 1) return 'just now';
    return `${hours}h ago`;
  }
  if (diff >= day && diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Drop a leading heading that merely repeats the page title.
 *
 * The fetcher prepends the title so the stored Markdown is self-contained (and
 * so `format: json` callers get a usable document), but the renderer already
 * emits the title as an H1 — without this, every fetched page shows its title
 * twice.
 */
export function stripLeadingTitle(content: string, title: string): string {
  const match = /^#{1,2}\s+(.+)\n+/.exec(content);
  if (!match) return content;
  const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '');
  if (normalise(match[1]!) === normalise(title)) return content.slice(match[0].length);
  return content;
}

/** Summarise a research report for the JSON output path. */
export function researchToJson(report: ResearchReport): Record<string, unknown> {
  return {
    query: report.query,
    generatedAt: report.generatedAt,
    depth: report.depth,
    queries: report.queries,
    enginesUsed: report.enginesUsed,
    enginesFailed: report.enginesFailed,
    elapsedMs: report.elapsedMs,
    sources: report.sources.map((s: ResearchSource) => ({
      index: s.index,
      title: s.title,
      url: s.url,
      source: s.source,
      engines: s.engines,
      score: s.score,
      wordCount: s.wordCount,
      cached: s.cached,
      ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
      ...(s.error ? { error: s.error } : {}),
      passages: s.passages.map((p) => ({ text: p.text, score: Number(p.score.toFixed(3)), offset: p.offset })),
    })),
  };
}
