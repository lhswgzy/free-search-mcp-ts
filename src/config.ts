/**
 * Configuration resolution.
 *
 * Precedence (lowest to highest): built-in defaults -> `config.json` in the
 * data directory -> `.env` in the data directory -> process environment ->
 * explicit overrides passed by the CLI or a programmatic caller.
 *
 * Every knob has both a long `FREE_SEARCH_*` env var and a short `FSMCP_*`
 * alias; API keys also honour the vendor-standard names so that a machine
 * which already has `BRAVE_API_KEY` set just works.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LogLevel } from './util/logger.js';
import type { SafeSearchLevel } from './types.js';

/** Engines that need no key and are always attempted first. */
export const PRIMARY_ENGINES = ['duckduckgo', 'mojeek', 'googlenews'] as const;

/**
 * Extra keyless engines used as a safety net. They are only consulted when the
 * primary set returns too little, which is what makes the default experience
 * survive DNS-level blocking of one or two providers.
 *
 * Bing is the global fallback; the three Chinese engines are only eligible for
 * CJK queries (or an explicit region), which the search orchestrator decides
 * from the engine's `affinity` in the registry.
 */
export const FALLBACK_ENGINES = ['bing', 'baidu', 'sogou', 'so360'] as const;

export interface Config {
  dataDir: string;
  cachePath: string;
  configPath: string;

  /** Explicit engine list. Empty means "use the primary + fallback policy". */
  engines: string[];
  /** When true, `engines` is empty and the auto policy applies. */
  autoEngines: boolean;
  primaryEngines: string[];
  fallbackEngines: string[];

  maxResults: number;
  perEngineResults: number;
  /** Level-2 research also fans out to these extra queries. */
  minResultsBeforeFallback: number;
  timeoutMs: number;
  retries: number;
  concurrency: number;
  engineFailureThreshold: number;
  engineCooldownMs: number;

  proxy?: string;
  userAgent?: string;
  rotateUserAgent: boolean;

  cacheEnabled: boolean;
  /** TTL for fetched pages, ms. */
  cacheTtlMs: number;
  /** TTL for raw engine responses, ms. 0 disables the search cache. */
  searchCacheTtlMs: number;

  respectRobots: boolean;
  allowPrivateHosts: boolean;
  safeSearch: SafeSearchLevel;
  region?: string;
  language?: string;

  maxFetchBytes: number;
  maxMarkdownChars: number;
  maxRedirects: number;

  /** RRF damping constant. 60 is the value from the original Cormack paper. */
  rrfK: number;

  keys: {
    brave?: string;
    serper?: string;
    tavily?: string;
    exa?: string;
    searxng?: string;
    googleCse?: { key?: string; cx?: string };
  };

  logLevel: LogLevel;
}

function envLookup(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

function envStr(names: string[], fallback?: string): string | undefined {
  const v = envLookup(names);
  return v === undefined ? fallback : v;
}

function envInt(names: string[], fallback: number): number {
  const v = envLookup(names);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(names: string[], fallback: boolean): boolean {
  const v = envLookup(names);
  if (v === undefined) return fallback;
  const s = v.toLowerCase().trim();
  if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'n', ''].includes(s)) return false;
  return fallback;
}

function envList(names: string[]): string[] | undefined {
  const v = envLookup(names);
  if (v === undefined) return undefined;
  const items = v
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return items.length ? items : undefined;
}

export function defaultDataDir(): string {
  const explicit = envStr(['FREE_SEARCH_DATA_DIR', 'FSMCP_DATA_DIR']);
  if (explicit) return resolve(explicit);
  return join(homedir(), '.free-search-mcp');
}

/** Tiny `.env` reader: `KEY=VALUE`, `#` comments, optional quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readJsonIfPresent(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function pick<T>(file: Record<string, unknown>, key: string, fallback: T): T {
  const v = file[key];
  return v === undefined || v === null ? fallback : (v as T);
}

export interface LoadConfigOptions {
  dataDir?: string;
  overrides?: Partial<Config>;
  /** Skip reading `.env` (used by tests). */
  skipDotEnv?: boolean;
}

let cached: Config | undefined;

export function loadConfig(options: LoadConfigOptions = {}): Config {
  const dataDir = resolve(options.dataDir ?? defaultDataDir());
  const configPath = join(dataDir, 'config.json');
  const envPath = join(dataDir, '.env');

  const file = readJsonIfPresent(configPath);
  if (!options.skipDotEnv && existsSync(envPath)) {
    try {
      const dotenv = parseDotEnv(readFileSync(envPath, 'utf8'));
      for (const [k, v] of Object.entries(dotenv)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }
    } catch {
      /* unreadable .env is not fatal */
    }
  }

  const enginesFromEnv = envList(['FREE_SEARCH_ENGINES', 'FSMCP_ENGINES']);
  const enginesFromFile = Array.isArray(file.engines) ? (file.engines as string[]) : undefined;
  const rawEngines = (enginesFromEnv ?? enginesFromFile ?? []).map((e) => e.toLowerCase());
  const autoEngines = rawEngines.length === 0 || rawEngines.includes('auto');

  const proxy =
    envStr(
      ['FREE_SEARCH_PROXY', 'FSMCP_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
      undefined,
    ) ??
    (typeof file.proxy === 'string' ? file.proxy : undefined) ??
    undefined;

  const config: Config = {
    dataDir,
    cachePath: resolve(join(dataDir, envStr(['FREE_SEARCH_CACHE_FILE', 'FSMCP_CACHE_FILE'], 'cache.sqlite')!)),
    configPath,

    engines: autoEngines ? [] : [...new Set(rawEngines.filter((e) => e !== 'auto'))],
    autoEngines,
    primaryEngines: envList(['FREE_SEARCH_PRIMARY_ENGINES']) ?? [...PRIMARY_ENGINES],
    fallbackEngines:
      envList(['FREE_SEARCH_FALLBACK_ENGINES']) ??
      (Array.isArray(file.fallbackEngines) ? (file.fallbackEngines as string[]) : [...FALLBACK_ENGINES]),

    maxResults: envInt(['FREE_SEARCH_MAX_RESULTS', 'FSMCP_MAX_RESULTS'], pick(file, 'maxResults', 12)),
    perEngineResults: envInt(['FREE_SEARCH_PER_ENGINE', 'FSMCP_PER_ENGINE'], pick(file, 'perEngineResults', 10)),
    minResultsBeforeFallback: envInt(
      ['FREE_SEARCH_MIN_RESULTS', 'FSMCP_MIN_RESULTS'],
      pick(file, 'minResultsBeforeFallback', 5),
    ),
    timeoutMs: envInt(['FREE_SEARCH_TIMEOUT', 'FSMCP_TIMEOUT'], pick(file, 'timeoutMs', 15000)),
    retries: envInt(['FREE_SEARCH_RETRIES', 'FSMCP_RETRIES'], pick(file, 'retries', 1)),
    concurrency: envInt(['FREE_SEARCH_CONCURRENCY', 'FSMCP_CONCURRENCY'], pick(file, 'concurrency', 6)),
    engineFailureThreshold: envInt(['FREE_SEARCH_ENGINE_FAILURES'], pick(file, 'engineFailureThreshold', 3)),
    engineCooldownMs: envInt(['FREE_SEARCH_ENGINE_COOLDOWN_MS'], pick(file, 'engineCooldownMs', 10 * 60 * 1000)),

    proxy,
    userAgent: envStr(['FREE_SEARCH_USER_AGENT', 'FSMCP_USER_AGENT'], pick(file, 'userAgent', undefined)),
    rotateUserAgent: envBool(['FREE_SEARCH_ROTATE_UA', 'FSMCP_ROTATE_UA'], pick(file, 'rotateUserAgent', true)),

    cacheEnabled: envBool(['FREE_SEARCH_CACHE', 'FSMCP_CACHE'], pick(file, 'cacheEnabled', true)),
    cacheTtlMs:
      envInt(['FREE_SEARCH_CACHE_TTL_MS'], pick(file, 'cacheTtlMs', 24 * 60 * 60 * 1000)) ||
      Math.round(
        Number(envStr(['FREE_SEARCH_CACHE_TTL_HOURS'], String(pick(file, 'cacheTtlHours', 24)))) * 3600 * 1000,
      ),
    searchCacheTtlMs: envInt(
      ['FREE_SEARCH_SEARCH_CACHE_TTL_MS', 'FSMCP_SEARCH_CACHE_TTL'],
      pick(file, 'searchCacheTtlMs', 15 * 60 * 1000),
    ),

    respectRobots: envBool(['FREE_SEARCH_RESPECT_ROBOTS', 'FSMCP_RESPECT_ROBOTS'], pick(file, 'respectRobots', true)),
    allowPrivateHosts: envBool(['FREE_SEARCH_ALLOW_PRIVATE', 'FSMCP_ALLOW_PRIVATE'], pick(file, 'allowPrivateHosts', false)),
    safeSearch: (envStr(['FREE_SEARCH_SAFE_SEARCH', 'FSMCP_SAFE_SEARCH'], pick(file, 'safeSearch', 'moderate')) as SafeSearchLevel),
    region: envStr(['FREE_SEARCH_REGION', 'FSMCP_REGION'], pick(file, 'region', undefined)),
    language: envStr(['FREE_SEARCH_LANGUAGE', 'FSMCP_LANGUAGE', 'FSMCP_LANG'], pick(file, 'language', undefined)),

    maxFetchBytes: envInt(['FREE_SEARCH_MAX_BYTES', 'FSMCP_MAX_BYTES'], pick(file, 'maxFetchBytes', 5 * 1024 * 1024)),
    maxMarkdownChars: envInt(
      ['FREE_SEARCH_MAX_CHARS', 'FSMCP_MAX_CHARS'],
      pick(file, 'maxMarkdownChars', 120_000),
    ),
    maxRedirects: envInt(['FREE_SEARCH_MAX_REDIRECTS'], pick(file, 'maxRedirects', 8)),

    rrfK: Number(envStr(['FREE_SEARCH_RRF_K', 'FSMCP_RRF_K'], String(pick(file, 'rrfK', 60)))) || 60,

    keys: {
      brave: envStr(['BRAVE_API_KEY', 'BRAVE_SEARCH_API_KEY', 'FREE_SEARCH_BRAVE_KEY']),
      serper: envStr(['SERPER_API_KEY', 'FREE_SEARCH_SERPER_KEY']),
      tavily: envStr(['TAVILY_API_KEY', 'FREE_SEARCH_TAVILY_KEY']),
      exa: envStr(['EXA_API_KEY', 'FREE_SEARCH_EXA_KEY']),
      searxng: envStr(['SEARXNG_URL', 'FREE_SEARCH_SEARXNG_URL']),
      googleCse: {
        key: envStr(['GOOGLE_CSE_KEY', 'GOOGLE_API_KEY']),
        cx: envStr(['GOOGLE_CSE_CX', 'GOOGLE_CSE_ID']),
      },
    },

    logLevel: (envStr(['FREE_SEARCH_LOG_LEVEL', 'FSMCP_LOG_LEVEL', 'LOG_LEVEL'], pick(file, 'logLevel', 'warn')) as LogLevel),
  };

  if (options.overrides) {
    Object.assign(config, options.overrides);
    if (options.overrides.keys) config.keys = { ...config.keys, ...options.overrides.keys };
  }

  applyProxyEnv(config);
  return config;
}

/** Cached loader for library consumers; call `resetConfig()` after editing env. */
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export function setConfig(config: Config): void {
  cached = config;
}

export function resetConfig(): void {
  cached = undefined;
}

export function ensureDataDir(config: Config): string {
  if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
  return config.dataDir;
}

/**
 * Normalise a proxy value into a URL undici understands and export it to the
 * conventional env vars, because some transitive fetchers only read those.
 */
function applyProxyEnv(config: Config): void {
  if (!config.proxy) return;
  let p = config.proxy.trim();
  if (!p) return;
  if (p === 'none' || p === 'off' || p === 'false') {
    config.proxy = undefined;
    return;
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) p = `http://${p}`;
  try {
    const u = new URL(p);
    config.proxy = u.toString();
  } catch {
    config.proxy = undefined;
    return;
  }
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY']) {
    if (process.env[name] === undefined) process.env[name] = config.proxy;
  }
}

/** Redact secrets for `config`/`doctor` output. */
export function redactConfig(config: Config): Record<string, unknown> {
  const mask = (v?: string) => (v ? `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)` : undefined);
  return {
    ...config,
    keys: {
      brave: mask(config.keys.brave),
      serper: mask(config.keys.serper),
      tavily: mask(config.keys.tavily),
      exa: mask(config.keys.exa),
      searxng: config.keys.searxng,
      googleCse: {
        key: mask(config.keys.googleCse?.key),
        cx: mask(config.keys.googleCse?.cx),
      },
    },
  };
}
