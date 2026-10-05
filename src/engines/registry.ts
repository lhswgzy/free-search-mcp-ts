/**
 * Engine registry.
 *
 * One table describing every provider: how to construct it, how much its vote
 * counts during RRF, which tier it belongs to, and what it is good for. The
 * orchestrator only ever asks this module questions, so adding an engine is a
 * one-line change here plus the engine file itself.
 */

import type { Config } from '../config.js';
import type { HttpClient } from '../http.js';
import type { SearchEngine } from '../types.js';
import { createLogger } from '../util/logger.js';

import { createDuckDuckGoEngine } from './duckduckgo.js';
import { createMojeekEngine } from './mojeek.js';
import { createGoogleNewsEngine } from './googlenews.js';
import { createBingEngine } from './bing.js';
import { createBaiduEngine } from './baidu.js';
import { createSogouEngine } from './sogou.js';
import { createSo360Engine } from './so360.js';
import { createStartpageEngine } from './startpage.js';
import { createBraveEngine } from './brave.js';
import { createSearxngEngine } from './searxng.js';
import { createWikipediaEngine } from './wikipedia.js';
import { createHackerNewsEngine } from './hackernews.js';
import { createGitHubEngine } from './github.js';
import { createStackExchangeEngine } from './stackexchange.js';
import { createArxivEngine } from './arxiv.js';
import { createOpenAlexEngine } from './openalex.js';
import { createCrossrefEngine } from './crossref.js';
import { createNpmEngine } from './npm.js';
import { createCratesEngine } from './crates.js';
import { createBraveApiEngine } from './brave-api.js';
import { createSerperEngine } from './serper.js';
import { createTavilyEngine } from './tavily.js';
import { createExaEngine } from './exa.js';
import { createGoogleCseEngine } from './google-cse.js';

const log = createLogger('registry');

export interface EngineContext {
  http: HttpClient;
  config: Config;
}

export type EngineTier =
  /** The documented keyless defaults: DuckDuckGo, Mojeek, Google News. */
  | 'primary'
  /** Consulted when the primary tier returns too little. */
  | 'fallback'
  /** Only used on an explicit request or in `engines: 'all'` mode. */
  | 'optional'
  /** Subject-specific indexes; only used when the query looks like it fits. */
  | 'api'
  /** Requires an API key; only used when the key is configured. */
  | 'keyed';

interface EngineDefinition {
  id: string;
  tier: EngineTier;
  /** RRF weight. 1 is neutral; higher means "trust this list more". */
  weight: number;
  /** Domains whose results are demoted (content farms, aggregators). */
  factory: (ctx: EngineContext) => SearchEngine;
  /**
   * Language/region affinity. `cn` engines are only eligible for CJK queries
   * or an explicit region request unless the user asks for them by name.
   */
  affinity?: 'global' | 'cn' | 'dev' | 'academic' | 'news';
  /** Query hints that make an `api` tier engine eligible. */
  triggers?: RegExp;
}

/**
 * The registry table.
 *
 * Weighting rationale: a paid API with a clean result list gets more say than a
 * scraper (which may return ads or oneboxes); CJK scrapers get slightly less
 * than their global counterparts because their markup is more volatile.
 */
export const ENGINE_DEFINITIONS: readonly EngineDefinition[] = [
  // --- primary: the documented key-free defaults -------------------------
  { id: 'duckduckgo', tier: 'primary', weight: 1.0, affinity: 'global', factory: createDuckDuckGoEngine },
  { id: 'mojeek', tier: 'primary', weight: 0.95, affinity: 'global', factory: createMojeekEngine },
  { id: 'googlenews', tier: 'primary', weight: 0.9, affinity: 'news', factory: createGoogleNewsEngine },

  // --- fallback ---------------------------------------------------------
  { id: 'bing', tier: 'fallback', weight: 1.0, affinity: 'global', factory: createBingEngine },
  { id: 'baidu', tier: 'fallback', weight: 0.9, affinity: 'cn', factory: createBaiduEngine },
  { id: 'sogou', tier: 'fallback', weight: 0.85, affinity: 'cn', factory: createSogouEngine },
  { id: 'so360', tier: 'fallback', weight: 0.8, affinity: 'cn', factory: createSo360Engine },

  // --- optional general web --------------------------------------------
  { id: 'startpage', tier: 'optional', weight: 0.95, affinity: 'global', factory: createStartpageEngine },
  { id: 'brave', tier: 'optional', weight: 0.95, affinity: 'global', factory: createBraveEngine },
  { id: 'searxng', tier: 'optional', weight: 0.9, affinity: 'global', factory: createSearxngEngine },

  // --- subject indexes --------------------------------------------------
  { id: 'wikipedia', tier: 'api', weight: 1.0, affinity: 'global', factory: createWikipediaEngine },
  { id: 'hackernews', tier: 'api', weight: 1.0, affinity: 'dev', triggers: /developer|programming|software|framework|library|release|api\b|hacker|startup|show hn/i, factory: createHackerNewsEngine },
  { id: 'github', tier: 'api', weight: 1.0, affinity: 'dev', triggers: /github|repository|repo\b|library|package|sdk|framework|open[- ]source|cli\b|npm|pypi/i, factory: createGitHubEngine },
  { id: 'stackexchange', tier: 'api', weight: 1.0, affinity: 'dev', triggers: /error|exception|how to|why does|fix\b|stack ?overflow|typescript|python|javascript|rust|java\b|sql\b|regex/i, factory: createStackExchangeEngine },
  { id: 'npm', tier: 'api', weight: 0.95, affinity: 'dev', triggers: /npm|node(?:\.js)?|package|library|module/i, factory: createNpmEngine },
  { id: 'crates', tier: 'api', weight: 0.95, affinity: 'dev', triggers: /crate|rust|cargo/i, factory: createCratesEngine },
  { id: 'arxiv', tier: 'api', weight: 1.0, affinity: 'academic', triggers: /arxiv|paper|preprint|theorem|neural|transformer|benchmark|dataset/i, factory: createArxivEngine },
  { id: 'openalex', tier: 'api', weight: 1.0, affinity: 'academic', triggers: /study|research|paper|journal|citation|survey|meta[- ]analysis|clinical|trial/i, factory: createOpenAlexEngine },
  { id: 'crossref', tier: 'api', weight: 0.95, affinity: 'academic', triggers: /doi|citation|journal|published|paper|study/i, factory: createCrossrefEngine },

  // --- keyed ------------------------------------------------------------
  { id: 'brave-api', tier: 'keyed', weight: 1.15, affinity: 'global', factory: createBraveApiEngine },
  { id: 'serper', tier: 'keyed', weight: 1.15, affinity: 'global', factory: createSerperEngine },
  { id: 'tavily', tier: 'keyed', weight: 1.1, affinity: 'global', factory: createTavilyEngine },
  { id: 'exa', tier: 'keyed', weight: 1.1, affinity: 'global', factory: createExaEngine },
  { id: 'google-cse', tier: 'keyed', weight: 1.15, affinity: 'global', factory: createGoogleCseEngine },
];

/** All engine ids in registry order. */
export const ENGINE_IDS: readonly string[] = ENGINE_DEFINITIONS.map((d) => d.id);

/** Ids that can run with no configuration at all. */
export const KEYLESS_ENGINE_IDS: readonly string[] = ENGINE_DEFINITIONS.filter(
  (d) => d.tier !== 'keyed' && d.id !== 'searxng',
).map((d) => d.id);

export function getDefinition(id: string): EngineDefinition | undefined {
  return ENGINE_DEFINITIONS.find((d) => d.id === id);
}

export function weightOf(id: string): number {
  return getDefinition(id)?.weight ?? 1;
}

export function tierOf(id: string): EngineTier | undefined {
  return getDefinition(id)?.tier;
}

/**
 * True when the engine's API key (or instance URL) is configured.
 * Keyless engines are always considered configured.
 */
export function isConfigured(id: string, config: Config): boolean {
  const definition = getDefinition(id);
  if (!definition) return false;
  if (definition.tier !== 'keyed' && id !== 'searxng') return true;
  switch (id) {
    case 'brave-api':
      return Boolean(config.keys.brave);
    case 'serper':
      return Boolean(config.keys.serper);
    case 'tavily':
      return Boolean(config.keys.tavily);
    case 'exa':
      return Boolean(config.keys.exa);
    case 'searxng':
      return Boolean(config.keys.searxng);
    case 'google-cse':
      return Boolean(config.keys.googleCse?.key && config.keys.googleCse?.cx);
    default:
      return false;
  }
}

/** Instantiate one engine, or undefined for an unknown id. */
export function createEngine(id: string, ctx: EngineContext): SearchEngine | undefined {
  const definition = getDefinition(id);
  if (!definition) return undefined;
  try {
    return definition.factory(ctx);
  } catch (err) {
    log.warn(`failed to construct engine "${id}": ${(err as Error).message}`);
    return undefined;
  }
}

export interface ResolvedEngine {
  engine: SearchEngine;
  weight: number;
  tier: EngineTier;
}

/**
 * Turn a list of ids into runnable engines, silently dropping unknown ids and
 * keyed engines whose key is missing (the caller reports those separately so
 * the user learns *why* an engine they asked for did not run).
 */
export function resolveEngines(ids: readonly string[], ctx: EngineContext): ResolvedEngine[] {
  const out: ResolvedEngine[] = [];
  for (const id of ids) {
    const definition = getDefinition(id);
    if (!definition) {
      log.warn(`unknown engine id "${id}" — ignoring`);
      continue;
    }
    if (!isConfigured(id, ctx.config)) {
      log.debug(`engine "${id}" skipped: not configured`);
      continue;
    }
    const engine = createEngine(id, ctx);
    if (!engine) continue;
    out.push({ engine, weight: definition.weight, tier: definition.tier });
  }
  return out;
}

/** Human-readable catalogue for `list_engines` and the CLI. */
export interface EngineInfo {
  id: string;
  label: string;
  kind: string;
  tier: EngineTier;
  weight: number;
  requiresKey: boolean;
  keyEnv?: string;
  keyUrl?: string;
  configured: boolean;
  homepage?: string;
  note?: string;
}

export function catalogue(config: Config, ctx?: EngineContext): EngineInfo[] {
  return ENGINE_DEFINITIONS.map((definition) => {
    let label = definition.id;
    let kind = 'unknown';
    let requiresKey = definition.tier === 'keyed';
    let keyEnv: string | undefined;
    let keyUrl: string | undefined;
    let homepage: string | undefined;
    let note: string | undefined;
    if (ctx) {
      const engine = createEngine(definition.id, ctx);
      if (engine) {
        label = engine.label;
        kind = engine.kind;
        requiresKey = engine.requiresKey;
        keyEnv = engine.keyEnv;
        keyUrl = engine.keyUrl;
        homepage = engine.homepage;
        note = engine.note;
      }
    }
    return {
      id: definition.id,
      label,
      kind,
      tier: definition.tier,
      weight: definition.weight,
      requiresKey,
      ...(keyEnv ? { keyEnv } : {}),
      ...(keyUrl ? { keyUrl } : {}),
      configured: isConfigured(definition.id, config),
      ...(homepage ? { homepage } : {}),
      ...(note ? { note } : {}),
    };
  });
}

/**
 * Suggest the `api` tier engines whose trigger patterns match a query. This is
 * the "subject index" escalation: a question about a Rust crate gets crates.io
 * without the caller having to know the engine exists.
 */
export function suggestApiEngines(query: string): string[] {
  return ENGINE_DEFINITIONS.filter((d) => d.tier === 'api' && d.triggers?.test(query)).map((d) => d.id);
}

export type { EngineDefinition };
