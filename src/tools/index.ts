/**
 * Tool definitions, schemas and handlers.
 *
 * One table is the single source of truth: the MCP server registers the schemas
 * from here, and the CLI calls the same handlers directly. That means
 * `free-search-mcp search "..."` on the command line exercises exactly the code
 * path a model would, which is the only way a CLI and a server stay honest with
 * each other.
 *
 * Every tool takes an optional `format` (`markdown` by default, `json` on
 * request) because the Markdown output is optimised for a model's context
 * window, while JSON is what a script or another tool wants.
 */

import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { FetchedPage } from '../types.js';
import { createHttpClient, type HttpClient } from '../http.js';
import { SearchService } from '../search.js';
import { FetchService, pageToText } from '../fetch/page.js';
import { ResearchService } from '../research.js';
import { getCache } from '../cache.js';
import { parseDocument, detectDocumentKind } from '../fetch/documents.js';
import { catalogue, ENGINE_IDS } from '../engines/registry.js';
import {
  renderCacheStats,
  renderEngineTable,
  renderFetchedPage,
  renderIndexHits,
  renderResearchBrief,
  renderSearchResults,
  researchToJson,
  searchResultsToJson,
} from './format.js';
import { createLogger } from '../util/logger.js';
import { detectBlock } from '../engines/kit.js';
import { normalizeUrl } from '../util/url.js';

const log = createLogger('tools');

export interface Services {
  config: Config;
  http: HttpClient;
  search: SearchService;
  fetch: FetchService;
  research: ResearchService;
}

export function createServices(config: Config, http?: HttpClient): Services {
  const client = http ?? createHttpClient(config);
  const search = new SearchService(config, client);
  const fetchService = new FetchService(config, client);
  return {
    config,
    http: client,
    search,
    fetch: fetchService,
    research: new ResearchService({ config, search, fetch: fetchService }),
  };
}

export interface ToolResponse {
  /** Markdown (or JSON) payload returned to the caller. */
  text: string;
  /** Populated when `format: 'json'` was requested. */
  structured?: Record<string, unknown>;
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/**
 * A tool as the registry stores it.
 *
 * Argument types are erased here on purpose: `defineTool` is where the
 * typed-authoring world ends and the dynamic JSON-RPC world begins. The MCP SDK
 * validates incoming arguments against `schema` before the handler runs, so the
 * cast inside `defineTool` is the only place that trusts a caller.
 */
export interface AnyToolDefinition {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  annotations: ToolAnnotations;
  handler: (args: Record<string, unknown>, services: Services) => Promise<ToolResponse>;
}

interface TypedToolDefinition<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  schema: S;
  annotations: ToolAnnotations;
  handler: (args: z.infer<z.ZodObject<S>>, services: Services) => Promise<ToolResponse>;
}

function defineTool<S extends z.ZodRawShape>(definition: TypedToolDefinition<S>): AnyToolDefinition {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    schema: definition.schema,
    annotations: definition.annotations,
    handler: (args, services) => definition.handler(args as z.infer<z.ZodObject<S>>, services),
  };
}

/* ------------------------------------------------------------------ *
 * Shared schema fragments
 * ------------------------------------------------------------------ */

const formatSchema = z
  .enum(['markdown', 'json'])
  .optional()
  .describe('Output format. "markdown" (default) is compact and readable; "json" returns structured data for post-processing.');

const engineSchema = z
  .array(z.string())
  .optional()
  .describe(
    'Engines to use, in priority order. Omit for automatic tiered selection (keyless defaults first, then fallbacks, then matching subject indexes). Use ["all"] for every configured engine, or see the list_engines tool for ids.',
  );

const freshnessSchema = z
  .enum(['day', 'week', 'month', 'year'])
  .optional()
  .describe('Only return results newer than this. Honoured by engines that support it (Google News, Bing, Serper, Tavily, Brave, Google CSE) and ignored by the rest.');

const safeSearchSchema = z
  .enum(['off', 'moderate', 'strict'])
  .optional()
  .describe('Safe-search level. Defaults to the server configuration ("moderate").');

const maxCharsSchema = z
  .number()
  .int()
  .min(500)
  .max(400_000)
  .optional()
  .describe('Maximum characters of content to return. Longer content is truncated and a `next offset` is reported so you can continue reading.');

/* ------------------------------------------------------------------ *
 * web_search
 * ------------------------------------------------------------------ */

const webSearch = defineTool({
  name: 'web_search',
  title: 'Web search (multi-engine)',
  description: [
    'Search the web across several independent engines at once and get back one de-duplicated, re-ranked result list.',
    'Results from every engine are merged with Reciprocal Rank Fusion, so a page several engines agree on outranks a page only one engine found — this is materially more stable than querying a single provider.',
    'Runs with no API key by default; engines that are blocked or failing are skipped automatically and reported.',
    'Prefer this over fetch_url when you do not yet know which page has the answer. Use research() when you want the pages read for you as well.',
  ].join(' '),
  schema: {
    query: z.string().min(1).describe('The search query. Natural language works; operators such as "site:example.com", quoted phrases and "filetype:pdf" are passed through to engines that support them.'),
    max_results: z.number().int().min(1).max(50).optional().describe('Maximum fused results to return (default 12).'),
    engines: engineSchema,
    freshness: freshnessSchema,
    safe_search: safeSearchSchema,
    language: z.string().optional().describe('Language hint such as "en", "zh", "ja". Also picks language-appropriate default engines.'),
    region: z.string().optional().describe('Region hint such as "us", "cn", "de". Selects region-appropriate engines and result sets.'),
    site: z.string().optional().describe('Restrict results to one domain (host suffix match), e.g. "docs.python.org". Equivalent to adding site: to the query but applied after fusion, so it cannot be ignored by an engine.'),
    include_domains: z.array(z.string()).optional().describe('Only keep results from these domains.'),
    exclude_domains: z.array(z.string()).optional().describe('Drop results from these domains.'),
    format: formatSchema,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, services) {
    const outcome = await services.search.search(args.query, {
      ...(args.max_results ? { limit: args.max_results } : {}),
      ...(args.engines ? { engines: args.engines } : {}),
      ...(args.freshness ? { freshness: args.freshness } : {}),
      ...(args.safe_search ? { safeSearch: args.safe_search } : {}),
      ...(args.language ? { language: args.language } : {}),
      ...(args.region ? { region: args.region } : {}),
      ...(args.site ? { site: args.site } : {}),
      ...(args.include_domains ? { includeDomains: args.include_domains } : {}),
      ...(args.exclude_domains ? { excludeDomains: args.exclude_domains } : {}),
    });

    const renderOptions = {
      query: outcome.query,
      results: outcome.results,
      enginesUsed: outcome.enginesUsed,
      enginesEmpty: outcome.enginesEmpty,
      enginesFailed: outcome.enginesFailed,
      enginesSkipped: outcome.enginesSkipped,
      engineCounts: outcome.engineCounts,
      elapsedMs: outcome.elapsedMs,
      cached: outcome.cached,
    };

    if (args.format === 'json') {
      const payload = searchResultsToJson(renderOptions);
      return { text: JSON.stringify(payload, null, 2), structured: payload };
    }
    return { text: renderSearchResults(renderOptions) };
  },
});

/* ------------------------------------------------------------------ *
 * fetch_url
 * ------------------------------------------------------------------ */

const fetchUrl = defineTool({
  name: 'fetch_url',
  title: 'Fetch a URL as Markdown',
  description: [
    'Fetch one web page or document and return its main content as clean Markdown, with the navigation, adverts and cookie banners removed.',
    'Handles HTML (via a readability pass), PDF, DOCX, XLSX, PPTX, EPUB, ODT, CSV, JSON and plain text.',
    'Results are stored in a local SQLite index, so reading the same URL again is instant and the page becomes searchable offline with search_index.',
    'Long pages are truncated rather than refused: the response reports a `next offset` you can pass back to continue.',
    'robots.txt is honoured by default and private/loopback addresses are refused as a safety measure.',
  ].join(' '),
  schema: {
    url: z.string().describe('Absolute http(s) URL to fetch.'),
    max_chars: maxCharsSchema,
    offset: z.number().int().min(0).optional().describe('Skip this many characters into the content. Use the `next offset` from a previous call to page through a long document.'),
    refresh: z.boolean().optional().describe('Ignore the local cache and re-fetch (default false).'),
    use_cache: z.boolean().optional().describe('Use the cached copy when it is fresh (default true).'),
    include_links: z.boolean().optional().describe('Also return the outgoing links found in the body, for follow-up fetching.'),
    respect_robots: z.boolean().optional().describe('Honour robots.txt for this request (default: the server setting, which is true).'),
    format: formatSchema,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, services) {
    let page: FetchedPage;
    try {
      page = await services.fetch.fetchPage(args.url, {
        ...(args.max_chars ? { maxChars: args.max_chars } : {}),
        ...(args.offset !== undefined ? { offset: args.offset } : {}),
        ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
        ...(args.use_cache !== undefined ? { useCache: args.use_cache } : {}),
        ...(args.respect_robots !== undefined ? { respectRobots: args.respect_robots } : {}),
        includeLinks: args.include_links ?? false,
      });
    } catch (err) {
      // A refused URL (SSRF guard, robots.txt, HTTP error) is an answer, not a
      // crash: the CLI calls this handler directly and must print a clean
      // message, and the MCP server should not have to translate a stack trace.
      const message = err instanceof Error ? err.message : String(err);
      return { text: `Could not fetch \`${args.url}\`: ${message}`, isError: true };
    }

    const text = args.format === 'json' ? pageToJson(page, args.include_links ?? false) : renderFetchedPage({ page, includeLinks: args.include_links ?? false });
    return args.format === 'json' ? { text, structured: JSON.parse(text) as Record<string, unknown> } : { text };
  },
});

function pageToJson(page: FetchedPage, includeLinks: boolean): string {
  return JSON.stringify(
    {
      url: page.url,
      finalUrl: page.finalUrl,
      title: page.title,
      content: page.content,
      contentFormat: page.contentFormat,
      contentType: page.contentType,
      wordCount: page.wordCount,
      cached: page.cached,
      fetchedAt: page.fetchedAt,
      ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
      ...(page.byline ? { byline: page.byline } : {}),
      ...(page.siteName ? { siteName: page.siteName } : {}),
      ...(page.language ? { language: page.language } : {}),
      ...(page.document ? { document: page.document } : {}),
      ...(page.truncated ? { truncated: true, nextOffset: page.nextOffset } : {}),
      ...(page.warnings?.length ? { warnings: page.warnings } : {}),
      ...(includeLinks && page.links ? { links: page.links } : {}),
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ *
 * fetch_urls
 * ------------------------------------------------------------------ */

const fetchUrls = defineTool({
  name: 'fetch_urls',
  title: 'Fetch several URLs',
  description:
    'Fetch up to 12 URLs concurrently and return each as Markdown under its own heading. Cheaper and faster than calling fetch_url repeatedly because the requests overlap. Failures are reported per URL instead of failing the whole call.',
  schema: {
    urls: z.array(z.string()).min(1).max(12).describe('Absolute http(s) URLs to fetch.'),
    max_chars: maxCharsSchema.describe('Maximum characters returned *per page*.'),
    refresh: z.boolean().optional().describe('Ignore the local cache and re-fetch (default false).'),
    concurrency: z.number().int().min(1).max(8).optional().describe('How many fetches to run at once (default 5).'),
    format: formatSchema,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, services) {
    const results = await services.fetch.fetchMany(args.urls, {
      ...(args.max_chars ? { maxChars: args.max_chars } : {}),
      ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
      ...(args.concurrency ? { concurrency: args.concurrency } : {}),
      includeLinks: false,
    });

    if (args.format === 'json') {
      const payload = {
        requested: args.urls.length,
        succeeded: results.filter((r) => r.page).length,
        failed: results.filter((r) => r.error).length,
        pages: results.map((r) =>
          r.page
            ? { url: r.page.url, finalUrl: r.page.finalUrl, title: r.page.title, wordCount: r.page.wordCount, cached: r.page.cached, contentFormat: r.page.contentFormat }
            : { url: r.url, error: r.error },
        ),
      };
      return { text: JSON.stringify(payload, null, 2), structured: payload };
    }

    const lines: string[] = [];
    const ok = results.filter((r) => r.page).length;
    lines.push(`# Fetched ${ok} of ${results.length} URLs`);
    lines.push('');
    results.forEach((entry, index) => {
      if (entry.error || !entry.page) {
        lines.push(`## ${index + 1}. ${entry.url}`);
        lines.push('');
        lines.push(`> ⚠︎ Could not fetch: ${entry.error ?? 'unknown error'}`);
        lines.push('');
        return;
      }
      lines.push(
        renderFetchedPage({
          page: entry.page,
          includeLinks: false,
          headingLevel: 2,
        }),
      );
      lines.push('');
      if (index < results.length - 1) lines.push('---', '');
    });
    return { text: lines.join('\n').trimEnd() };
  },
});

/* ------------------------------------------------------------------ *
 * research
 * ------------------------------------------------------------------ */

const researchTool = defineTool({
  name: 'research',
  title: 'Research a question (search + read + organise)',
  description: [
    'One call that does the whole mechanical research loop: search several engines, derive extra queries from the vocabulary of the results, fetch the most relevant and diverse sources, then extract the passages from each that actually answer the question.',
    'Returns a Markdown brief with numbered, citable sources and verbatim quoted passages — it does NOT paraphrase, because this server has no language model; you write the synthesis from the evidence it gathers.',
    'Use this instead of chaining web_search and several fetch_url calls whenever you need more than a snippet.',
    'depth 1 = the query as written. depth 2 (default) = the query plus expansions derived from what the first page of results is actually about. depth 3 = broader expansion and more sources.',
  ].join(' '),
  schema: {
    query: z.string().min(1).describe('The research question, in natural language.'),
    depth: z.number().int().min(1).max(3).optional().describe('How hard to dig. 1 is fastest, 3 is most thorough (default 2).'),
    max_sources: z.number().int().min(1).max(15).optional().describe('How many sources to fetch and quote (default 8 at depth 2+).'),
    passages_per_source: z.number().int().min(1).max(8).optional().describe('Passages to quote per source (default 4).'),
    engines: engineSchema,
    freshness: freshnessSchema,
    safe_search: safeSearchSchema,
    language: z.string().optional().describe('Language hint such as "en" or "zh".'),
    region: z.string().optional().describe('Region hint such as "us" or "cn".'),
    include_domains: z.array(z.string()).optional().describe('Restrict the research to these domains.'),
    exclude_domains: z.array(z.string()).optional().describe('Exclude these domains from the research.'),
    refresh: z.boolean().optional().describe('Ignore cached pages and re-fetch every source (default false).'),
    format: formatSchema,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, services) {
    const report = await services.research.research(args.query, {
      ...(args.depth ? { depth: args.depth } : {}),
      ...(args.max_sources ? { maxSources: args.max_sources } : {}),
      ...(args.passages_per_source ? { passagesPerSource: args.passages_per_source } : {}),
      ...(args.engines ? { engines: args.engines } : {}),
      ...(args.freshness ? { freshness: args.freshness } : {}),
      ...(args.safe_search ? { safeSearch: args.safe_search } : {}),
      ...(args.language ? { language: args.language } : {}),
      ...(args.region ? { region: args.region } : {}),
      ...(args.include_domains ? { includeDomains: args.include_domains } : {}),
      ...(args.exclude_domains ? { excludeDomains: args.exclude_domains } : {}),
      ...(args.refresh !== undefined ? { refresh: args.refresh } : {}),
    });

    if (args.format === 'json') {
      const payload = researchToJson(report);
      return { text: JSON.stringify(payload, null, 2), structured: payload };
    }
    return { text: renderResearchBrief(report) };
  },
});

/* ------------------------------------------------------------------ *
 * search_index
 * ------------------------------------------------------------------ */

const searchIndex = defineTool({
  name: 'search_index',
  title: 'Search the local page index',
  description: [
    'Full-text search over every page this server has already fetched on this machine, using a local SQLite FTS5 index (with CJK bigram support).',
    'Use it to recall something you read earlier in the session, to avoid re-fetching, or to work offline.',
    'Returns cached page URLs, titles and highlighted snippets — and it costs no network requests at all.',
  ].join(' '),
  schema: {
    query: z.string().min(1).describe('Full-text query. Latin terms match by prefix; CJK phrases match by bigram, so "上下文" finds "模型上下文协议".'),
    max_results: z.number().int().min(1).max(50).optional().describe('Maximum matches to return (default 10).'),
    format: formatSchema,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, services) {
    const hits = services.search.searchLocal(args.query, args.max_results ?? 10);
    if (args.format === 'json') {
      const payload = { query: args.query, count: hits.length, hits };
      return { text: JSON.stringify(payload, null, 2), structured: payload };
    }
    return { text: renderIndexHits(args.query, hits) };
  },
});

/* ------------------------------------------------------------------ *
 * local_index
 * ------------------------------------------------------------------ */

const localIndex = defineTool({
  name: 'local_index',
  title: 'Inspect or maintain the local index',
  description:
    'Report on, prune, clear or compact the local cache that stores fetched pages and recent engine responses. `stats` is safe and cheap; `clear` and `prune` delete data permanently.',
  schema: {
    action: z
      .enum(['stats', 'clear', 'prune', 'vacuum'])
      .optional()
      .describe('stats (default) reports sizes; clear empties the cache; prune drops entries older than max_age_days or beyond max_pages; vacuum compacts the database file.'),
    scope: z.enum(['pages', 'search', 'all']).optional().describe('For `clear`: what to delete (default all).'),
    max_age_days: z.number().int().min(1).optional().describe('For `prune`: drop pages fetched more than this many days ago.'),
    max_pages: z.number().int().min(1).optional().describe('For `prune`: keep only this many of the most recently fetched pages.'),
    format: formatSchema,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async handler(args, services) {
    const cache = getCache(services.config);
    const action = args.action ?? 'stats';
    let detail: Record<string, unknown> = {};

    if (action === 'clear') {
      const removed = cache.clear(args.scope ?? 'all');
      detail = { removed, scope: args.scope ?? 'all' };
    } else if (action === 'prune') {
      const removed = cache.prune({
        ...(args.max_age_days ? { maxAgeMs: args.max_age_days * 86_400_000 } : {}),
        ...(args.max_pages ? { maxRows: args.max_pages } : {}),
      });
      detail = { removed };
    } else if (action === 'vacuum') {
      cache.vacuum();
      detail = { vacuumed: true };
    }

    const stats = cache.stats();
    if (args.format === 'json') {
      const payload = { action, ...detail, stats };
      return { text: JSON.stringify(payload, null, 2), structured: payload };
    }
    const lines: string[] = [];
    if (action !== 'stats') {
      lines.push(`# Local index: ${action}`);
      lines.push('');
      if (typeof detail.removed === 'number') lines.push(`Removed ${detail.removed} record(s).`);
      if (detail.vacuumed) lines.push('Database compacted.');
      lines.push('');
    }
    lines.push(renderCacheStats(stats));
    return { text: lines.join('\n') };
  },
});

/* ------------------------------------------------------------------ *
 * list_engines
 * ------------------------------------------------------------------ */

const listEngines = defineTool({
  name: 'list_engines',
  title: 'List search engines and their status',
  description:
    'Show every engine this server knows about: what it indexes, whether it needs an API key, which tier it belongs to, and its current health (a repeatedly blocked engine is benched for a while). Use it to pick explicit engines for web_search, or to diagnose an empty result list.',
  schema: {
    format: formatSchema,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args, services) {
    const engines = catalogue(services.config, { http: services.http, config: services.config });
    const health = services.search.health.snapshot(ENGINE_IDS);
    if (args.format === 'json') {
      const payload = { engines, health };
      return { text: JSON.stringify(payload, null, 2), structured: payload };
    }
    return { text: renderEngineTable(engines, health) };
  },
});

/* ------------------------------------------------------------------ *
 * parse_document
 * ------------------------------------------------------------------ */

const parseDocumentTool = defineTool({
  name: 'parse_document',
  title: 'Parse a local file or document URL',
  description: [
    'Read a document from a local path or a URL and return its text as Markdown.',
    'Supports PDF, DOCX, XLSX, PPTX, EPUB, ODT, CSV, JSON, HTML and plain text.',
    'Spreadsheets become Markdown tables, presentations become one section per slide, DOCX keeps headings, lists and tables, and PDFs get their hyphenation and column artefacts repaired.',
    'Everything is parsed on this machine — no upload, no conversion service.',
  ].join(' '),
  schema: {
    path: z.string().optional().describe('Local file path (absolute, or relative to the server working directory).'),
    url: z.string().optional().describe('Absolute http(s) URL of a document. Mutually exclusive with `path`.'),
    max_chars: maxCharsSchema,
    sheet: z.string().optional().describe('For spreadsheets: only return the worksheet with this name.'),
    format: formatSchema,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(args, services) {
    if (!args.path && !args.url) {
      return { text: 'Provide either `path` (a local file) or `url` (a remote document).', isError: true };
    }

    // Remote: reuse the fetch pipeline, which already handles every format.
    if (args.url && !args.path) {
      const page = await services.fetch.fetchPage(args.url, {
        ...(args.max_chars ? { maxChars: args.max_chars } : {}),
        includeLinks: false,
      });
      if (args.format === 'json') {
        const payload = {
          url: page.finalUrl,
          title: page.title,
          kind: page.document?.kind ?? page.contentFormat,
          document: page.document,
          wordCount: page.wordCount,
          markdown: page.content,
        };
        return { text: JSON.stringify(payload, null, 2), structured: payload };
      }
      return { text: renderFetchedPage({ page, includeLinks: false }) };
    }

    // Local file.
    const filePath = resolve(args.path!);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(filePath);
    } catch (err) {
      return { text: `Cannot read \`${filePath}\`: ${(err as Error).message}`, isError: true };
    }
    if (!info.isFile()) {
      return { text: `\`${filePath}\` is not a regular file.`, isError: true };
    }
    if (info.size > 100 * 1024 * 1024) {
      return { text: `\`${filePath}\` is ${(info.size / 1024 / 1024).toFixed(1)} MB, which exceeds the 100 MB limit.`, isError: true };
    }

    const name = basename(filePath);
    const kind = detectDocumentKind('', name);
    const bytes = new Uint8Array(await readFile(filePath));
    let parsed = await parseDocument(bytes, { name, maxChars: args.max_chars ?? services.config.maxMarkdownChars });

    // Optional single-sheet extraction for spreadsheets.
    if (args.sheet && parsed.info.kind === 'xlsx') {
      const sections = parsed.markdown.split(/\n(?=## )/);
      const wanted = sections.filter((section) => section.startsWith(`## ${args.sheet}`));
      if (wanted.length === 0) {
        const available = parsed.info.sheets?.map((s) => s.name).join(', ') ?? 'unknown';
        return { text: `No worksheet named \`${args.sheet}\`. Available: ${available}.`, isError: true };
      }
      parsed = { ...parsed, markdown: wanted.join('\n\n') };
    }

    if (args.format === 'json') {
      const payload = {
        path: filePath,
        name,
        kind: parsed.info.kind,
        bytes: info.size,
        document: parsed.info,
        ...(parsed.title ? { title: parsed.title } : {}),
        markdown: parsed.markdown,
      };
      return { text: JSON.stringify(payload, null, 2), structured: payload };
    }

    const lines: string[] = [];
    lines.push(`# ${parsed.title ?? name}`);
    lines.push('');
    lines.push(
      `_\`${filePath}\` · ${parsed.info.kind.toUpperCase()} · ${(info.size / 1024).toFixed(1)} kB · ${parsed.info.chars.toLocaleString('en-US')} characters_`,
    );
    if (parsed.info.sheets?.length) {
      lines.push('');
      lines.push(`_Sheets: ${parsed.info.sheets.map((s) => `${s.name} (${s.rows}×${s.cols})`).join(', ')}_`);
    }
    lines.push('');
    lines.push(parsed.markdown);
    return { text: lines.join('\n').trimEnd() };
  },
});

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export const TOOLS: AnyToolDefinition[] = [
  webSearch,
  researchTool,
  fetchUrl,
  fetchUrls,
  parseDocumentTool,
  searchIndex,
  localIndex,
  listEngines,
];

export type ToolName = 'web_search' | 'research' | 'fetch_url' | 'fetch_urls' | 'parse_document' | 'search_index' | 'local_index' | 'list_engines';

export function getTool(name: string): AnyToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/**
 * Verify a probe URL for `doctor`: fetch it and confirm it converts to text.
 * Kept here so the CLI and the diagnostics share one code path.
 */
export async function probeFetch(services: Services, url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await services.http.request(url, { retries: 0, timeoutMs: 10_000 });
    detectBlock(res.status, res.body, 'probe');
    return { ok: true, detail: `HTTP ${res.status}, ${res.bytes.length} bytes` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export { normalizeUrl, pageToText, log };
