/**
 * Public API.
 *
 * The package is primarily a CLI/MCP server, but the pieces are useful on their
 * own — searching several engines with fusion, converting a page to Markdown,
 * parsing a document, or reading the local index. This module is the supported
 * surface for that; anything not re-exported here is internal and may move.
 *
 * ```ts
 * import { createServices, SearchService, loadConfig } from 'free-search-mcp-ts';
 *
 * const services = createServices(loadConfig());
 * const outcome = await services.search.search('reciprocal rank fusion');
 * console.log(outcome.results.map((r) => r.url));
 * ```
 */

// Configuration
export {
  loadConfig,
  getConfig,
  setConfig,
  resetConfig,
  ensureDataDir,
  redactConfig,
  defaultDataDir,
  parseDotEnv,
  PRIMARY_ENGINES,
  FALLBACK_ENGINES,
  type Config,
  type LoadConfigOptions,
} from './config.js';

// Types
export type {
  RawResult,
  SearchResult,
  SearchEngine,
  EngineSearchOptions,
  EngineKind,
  EngineHealth,
  Freshness,
  SafeSearchLevel,
  FetchedPage,
  DocumentInfo,
  ResearchReport,
  ResearchSource,
  ScoredPassage,
  CacheStats,
  CachePageRow,
  EngineContribution,
} from './types.js';

// Search orchestration and fusion
export { SearchService, guessLanguage, isWrapperUrl, type SearchOptions, type SearchOutcome } from './search.js';
export {
  fuseResults,
  dedupeByTitle,
  enforceDomainCap,
  diversify,
  contributionsByEngine,
  DEFAULT_FUSE_OPTIONS,
  type EngineRanking,
  type FuseOptions,
} from './rrf.js';

// Research
export { ResearchService, deriveExpansionQueries, chooseSources, type ResearchOptions } from './research.js';

// Fetching and conversion
export { FetchService, pageToText, ensureTitle, type FetchPageOptions } from './fetch/page.js';
export {
  parseDocument,
  detectDocumentKind,
  parseDocx,
  parseXlsx,
  parsePptx,
  parseEpub,
  parseOdt,
  parsePdf,
  parseDelimited,
  csvToMarkdown,
  jsonToMarkdown,
  describeJsonShape,
  cleanPdfText,
  type ParsedDocument,
  type ParseDocumentOptions,
  type DocumentKind,
} from './fetch/documents.js';
export {
  htmlToMarkdown,
  htmlToText,
  cleanMarkdown,
  decodeEntities,
  extractLinks,
  absolutiseUrls,
  stripChrome,
  type ReadableArticle,
  type ConvertOptions,
} from './html/markdown.js';

// Networking
export {
  createHttpClient,
  getDispatcher,
  resetDispatcher,
  assertFetchable,
  mapConcurrent,
  sleep,
  HttpError,
  BlockedUrlError,
  DEFAULT_USER_AGENT,
  type HttpClient,
  type HttpRequestOptions,
  type HttpResponse,
} from './http.js';
export { RobotsCache, parseRobotsTxt, isPathAllowed, type RobotsEntry } from './robots.js';

// Local index
export {
  PageCache,
  getCache,
  closeCache,
  searchCacheKey,
  expandForIndex,
  buildFtsQuery,
  type IndexSearchHit,
  type PersistedEngineHealth,
} from './cache.js';

// Engines
export {
  ENGINE_DEFINITIONS,
  ENGINE_IDS,
  KEYLESS_ENGINE_IDS,
  catalogue,
  createEngine,
  getDefinition,
  isConfigured,
  resolveEngines,
  suggestApiEngines,
  tierOf,
  weightOf,
  type EngineContext,
  type EngineInfo,
  type EngineTier,
  type ResolvedEngine,
} from './engines/registry.js';
export { EngineHealthTracker, classifyFailure, type FailureKind, type HealthRecord } from './engines/health.js';
export {
  EngineError,
  extractResults,
  extractGenericResults,
  extractWithSelectors,
  parseDateLoose,
  cleanSnippet,
  type EngineDeps,
  type GenericExtractOptions,
  type SelectorSet,
} from './engines/kit.js';

// Tools
export { TOOLS, createServices, getTool, type Services, type ToolResponse, type AnyToolDefinition } from './tools/index.js';
export {
  renderSearchResults,
  renderFetchedPage,
  renderResearchBrief,
  renderEngineTable,
  renderCacheStats,
  renderIndexHits,
  searchResultsToJson,
  researchToJson,
  formatDate,
  formatBytes,
  displayHost,
  stripLeadingTitle,
  banner,
  plural,
  ms,
  tokens,
} from './tools/format.js';

// Server
export {
  createMcpServer,
  createStdioServer,
  runStdioServer,
  runHttpServer,
  toolManifest,
  SERVER_NAME,
  SERVER_VERSION,
  type HttpServerOptions,
  type RunningHttpServer,
} from './server.js';

// Installer
export {
  install,
  uninstall,
  detectClients,
  formatInstallReport,
  type InstallOptions,
  type InstallReport,
  type ClientResult,
} from './install/index.js';
export {
  CLIENT_SPECS,
  DEFAULT_SERVER_NAME,
  buildEntryShape,
  parseJsonc,
  resolveServerEntry,
  tomlServerBlock,
  upsertTomlServer,
  removeTomlServer,
  type ClientSpec,
  type ServerEntry,
  type CommandMode,
} from './install/clients.js';

// Utilities worth reusing
export {
  normalizeUrl,
  registrableDomain,
  displaySource,
  unwrapRedirect,
  sameUrl,
  hostMatches,
  extractWrapperTarget,
  decodeBase64Target,
  type NormalizedUrl,
} from './util/url.js';
export {
  tokenize,
  uniqueTerms,
  truncate,
  tidyMarkdown,
  collapseWhitespace,
  estimateTokens,
  splitSentences,
  splitBlocks,
  scoreBlock,
  selectPassages,
  makeSnippet,
  shingleSimilarity,
  hasCJK,
  mdCell,
  mdLinkText,
} from './util/text.js';
export { createLogger, setLogLevel, getLogLevel, type Logger, type LogLevel } from './util/logger.js';

/** Convenience: start the MCP server over stdio. Re-exported from the CLI. */
export { serve } from './cli.js';
