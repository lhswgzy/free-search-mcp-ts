#!/usr/bin/env node
/**
 * `free-search-mcp` command line.
 *
 * With no arguments it serves MCP over stdio, which is what a client does when
 * it runs `npx -y free-search-mcp` — that default is load-bearing, so every
 * other behaviour is behind an explicit subcommand.
 *
 * The subcommands are not a wrapper around the server: they construct the same
 * `Services` object and call the same tool handlers. `free-search-mcp search`
 * is therefore a genuine end-to-end test of what a model would get.
 */

import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getConfig,
  loadConfig,
  redactConfig,
  resetConfig,
  ensureDataDir,
  type Config,
} from './config.js';
import { closeCache, getCache, PageCache } from './cache.js';
import { createServices, getTool, TOOLS, probeFetch, type Services } from './tools/index.js';
import { createMcpServer, runHttpServer, runStdioServer, toolManifest, SERVER_VERSION } from './server.js';
import { detectClients, formatInstallReport, install, uninstall } from './install/index.js';
import { catalogue, ENGINE_IDS, isConfigured } from './engines/registry.js';
import { resetDispatcher } from './http.js';
import { renderEngineTable, formatBytes, ms, plural } from './tools/format.js';
import { setLogLevel } from './util/logger.js';

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
}

export type { ParsedArgs };

/** Flags that may be given more than once and accumulate. */
const REPEATABLE = new Set(['client', 'engines', 'include', 'exclude', 'env']);

/** Flags that never take a value. */
const BOOLEAN_FLAGS = new Set([
  'help', 'version', 'json', 'list', 'dry-run', 'force', 'verbose', 'quiet', 'links',
  'skip-engines', 'check-engines', 'no-cache', 'all', 'raw', 'yes', 'print', 'refresh', 'out',
]);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | boolean | string[]>();
  const positionals: string[] = [];
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).toLowerCase();
      let value: string | boolean;
      if (eq !== -1) {
        value = arg.slice(eq + 1);
      } else if (BOOLEAN_FLAGS.has(key)) {
        value = true;
      } else {
        const next = argv[i + 1];
        if (next === undefined || (next.startsWith('--') && next.length > 2)) {
          value = true;
        } else {
          value = next;
          i++;
        }
      }
      assign(flags, key, value);
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && arg !== '-') {
      const key = arg.slice(1).toLowerCase();
      if (key === 'h') assign(flags, 'help', true);
      else if (key === 'v') assign(flags, 'version', true);
      else if (key === 'j') assign(flags, 'json', true);
      else assign(flags, key, true);
      continue;
    }
    if (!command) {
      command = arg.toLowerCase();
      continue;
    }
    positionals.push(arg);
  }

  return { command, positionals, flags };
}

function assign(flags: Map<string, string | boolean | string[]>, key: string, value: string | boolean): void {
  if (REPEATABLE.has(key)) {
    const existing = flags.get(key);
    const list = Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : [];
    if (typeof value === 'string') list.push(value);
    flags.set(key, list);
    return;
  }
  flags.set(key, value);
}

function flagString(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags.get(key);
  return typeof value === 'string' ? value : undefined;
}

function flagBool(args: ParsedArgs, key: string): boolean {
  const value = args.flags.get(key);
  return value === true || value === 'true' || value === '1';
}

function flagNumber(args: ParsedArgs, key: string): number | undefined {
  const value = flagString(args, key);
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function flagList(args: ParsedArgs, key: string): string[] {
  const value = args.flags.get(key);
  if (Array.isArray(value)) return value.flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter(Boolean);
  return [];
}

/* ------------------------------------------------------------------ *
 * Help
 * ------------------------------------------------------------------ */

const HELP = `
free-search-mcp ${SERVER_VERSION} — local-first, key-free web search for MCP clients

USAGE
  npx -y free-search-mcp [command] [options]

  With no command the server speaks MCP over stdio, which is what a client
  expects when it spawns this binary.

COMMANDS
  serve                     Run the MCP server (default). --transport stdio|http
  install                   Register the server with the MCP clients found here
  uninstall                 Remove the registration
  doctor                    Check the network, the engines and the local index
  search <query>            Run a multi-engine search and print the Markdown
  research <query>          Search, read the sources and print a citable brief
  fetch <url>               Fetch one page or document as Markdown
  parse <path>              Parse a local document (PDF, DOCX, XLSX, PPTX, CSV…)
  engines                   List engines, their tier and their health
  cache <sub>               stats | search <q> | clear | prune | vacuum | path
  config                    Show the effective configuration
  tools                     List the MCP tools with their input schemas
  clients                   List the MCP clients this installer supports

COMMON OPTIONS
  --json                    Machine-readable output where available
  --engines a,b             Use specific engines (see \`engines\`)
  --max <n>                 Maximum results (search/research)
  --depth <1-3>             Research depth (default 2)
  --freshness day|week|month|year
  --lang <code>             Language hint, e.g. en, zh
  --region <code>           Region hint, e.g. us, cn
  --data-dir <path>         Override the data directory (default ~/.free-search-mcp)
  --verbose | --quiet       Log level
  -h, --help                This help
  -v, --version             Version

EXAMPLES
  npx -y free-search-mcp install
  npx -y free-search-mcp install --client cursor --dry-run
  npx -y free-search-mcp search "rust async runtime comparison" --max 8
  npx -y free-search-mcp research "state of MCP adoption" --depth 3 --json
  npx -y free-search-mcp serve --transport http --port 8765
  npx -y free-search-mcp doctor

ENVIRONMENT
  FREE_SEARCH_ENGINES       Comma-separated engine ids, or "auto" (default)
  FREE_SEARCH_MAX_RESULTS   Default result count (12)
  FREE_SEARCH_TIMEOUT       Per-request timeout in ms (15000)
  FREE_SEARCH_CACHE         Set to 0 to disable the local SQLite index
  FREE_SEARCH_PROXY         HTTP(S) proxy, e.g. http://127.0.0.1:7890
  FREE_SEARCH_RESPECT_ROBOTS  Set to 0 to ignore robots.txt when fetching
  BRAVE_API_KEY, SERPER_API_KEY, TAVILY_API_KEY, EXA_API_KEY, SEARXNG_URL
                            Optional keys that unlock higher-quality engines
`;

export const COMMAND_ALIASES: Record<string, string> = {
  mcp: 'serve',
  server: 'serve',
  stdio: 'serve',
  http: 'serve',
  s: 'search',
  r: 'research',
  f: 'fetch',
  q: 'search',
  add: 'install',
  remove: 'uninstall',
  rm: 'uninstall',
  ls: 'engines',
  list: 'engines',
  setup: 'install',
  check: 'doctor',
};

/**
 * Resolve the command a parsed argv asks for: aliases are folded, and no
 * command at all means `serve`, which is what an MCP client expects when it
 * spawns this binary with no arguments.
 */
export function resolveCommand(args: ParsedArgs): string {
  return args.command ? (COMMAND_ALIASES[args.command] ?? args.command) : 'serve';
}

/* ------------------------------------------------------------------ *
 * Output helpers
 * ------------------------------------------------------------------ */

function out(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Status glyphs as escapes, so this source file stays pure ASCII. */
const TICK = '\u2705';
const WARN = '\u26a0\ufe0f';
const CROSS = '\u274c';

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (flagBool(args, 'version') && !args.command) {
    out(SERVER_VERSION);
    return;
  }
  if (flagBool(args, 'help') && !args.command) {
    out(HELP.trimStart());
    return;
  }
  if (flagBool(args, 'verbose')) setLogLevel('debug');
  if (flagBool(args, 'quiet')) setLogLevel('silent');

  const command = resolveCommand(args);

  const dataDir = flagString(args, 'data-dir');
  const config = loadConfig(dataDir ? { dataDir } : {});
  applyLogLevelFromConfig(config, args);

  switch (command) {
    case 'serve':
      await commandServe(args, config);
      return;
    case 'install':
      commandInstall(args);
      return;
    case 'uninstall':
      commandUninstall(args);
      return;
    case 'doctor':
      await commandDoctor(args, config);
      return;
    case 'search':
      await commandSearch(args, config);
      return;
    case 'research':
      await commandResearch(args, config);
      return;
    case 'fetch':
      await commandFetch(args, config);
      return;
    case 'parse':
      await commandParse(args, config);
      return;
    case 'engines':
      await commandEngines(args, config);
      return;
    case 'cache':
      commandCache(args, config);
      return;
    case 'config':
      commandConfig(args, config);
      return;
    case 'tools':
      commandTools(args);
      return;
    case 'clients':
      commandClients(args);
      return;
    case 'help':
      out(HELP.trimStart());
      return;
    default:
      fail(`Unknown command "${args.command}".\nRun \`free-search-mcp --help\` for the list.`);
  }
}

function applyLogLevelFromConfig(config: Config, args: ParsedArgs): void {
  if (flagBool(args, 'verbose') || flagBool(args, 'quiet')) return;
  setLogLevel(config.logLevel);
}

/* ------------------------------------------------------------------ *
 * serve
 * ------------------------------------------------------------------ */

async function commandServe(args: ParsedArgs, config: Config): Promise<void> {
  const transport = (flagString(args, 'transport') ?? (args.command === 'http' ? 'http' : 'stdio')).toLowerCase();
  const services = createServices(config);
  ensureDataDir(config);

  if (transport === 'http') {
    const port = flagNumber(args, 'port') ?? 8765;
    const host = flagString(args, 'host') ?? '127.0.0.1';
    const path = flagString(args, 'path') ?? '/mcp';
    const running = await runHttpServer(services, {
      port,
      host,
      path,
      corsOrigin: flagString(args, 'cors') ?? '*',
    });
    process.stderr.write(`free-search-mcp listening on ${running.url}\n`);
    if (flagBool(args, 'print')) printJson({ url: running.url, transport: 'streamable-http', tools: TOOLS.length });
    const shutdown = async (): Promise<void> => {
      await running.close();
      closeCache();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
    return;
  }

  if (transport !== 'stdio') {
    fail(`Unknown transport "${transport}". Use "stdio" or "http".`);
  }
  await runStdioServer(services);
}

/* ------------------------------------------------------------------ *
 * install / uninstall
 * ------------------------------------------------------------------ */

function commandInstall(args: ParsedArgs): void {
  if (flagBool(args, 'list')) {
    commandClients(args);
    return;
  }
  const report = install({
    clients: flagList(args, 'client'),
    ...(flagString(args, 'name') ? { name: flagString(args, 'name')! } : {}),
    ...(flagString(args, 'mode') ? { mode: flagString(args, 'mode') as 'auto' | 'npx' | 'node' } : {}),
    ...(flagString(args, 'command') ? { command: flagString(args, 'command')! } : {}),
    ...(flagString(args, 'scope') ? { scope: flagString(args, 'scope') as 'auto' | 'workspace' | 'user' } : {}),
    ...(flagList(args, 'env').length ? { env: parseEnvFlags(flagList(args, 'env')) } : {}),
    dryRun: flagBool(args, 'dry-run'),
    force: flagBool(args, 'force'),
    includeUndetected: flagBool(args, 'all'),
    cliPath: process.argv[1],
  });

  if (flagBool(args, 'json')) {
    printJson(report);
    return;
  }
  out(formatInstallReport(report));
}

function parseEnvFlags(entries: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    env[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
  }
  return env;
}

function commandUninstall(args: ParsedArgs): void {
  const report = uninstall({
    clients: flagList(args, 'client'),
    ...(flagString(args, 'name') ? { name: flagString(args, 'name')! } : {}),
    dryRun: flagBool(args, 'dry-run'),
    cliPath: process.argv[1],
  });
  if (flagBool(args, 'json')) {
    printJson(report);
    return;
  }
  out(formatInstallReport(report));
}

function commandClients(args: ParsedArgs): void {
  const detected = detectClients();
  if (flagBool(args, 'json')) {
    printJson(
      detected.map((entry) => ({
        id: entry.spec.id,
        label: entry.spec.label,
        configPath: entry.path,
        detected: entry.exists,
        docs: entry.spec.docs,
        note: entry.spec.note,
        manual: entry.spec.manual,
      })),
    );
    return;
  }
  out('# Supported MCP clients');
  out('');
  out('| id | Client | Config file | Detected |');
  out('|----|--------|-------------|----------|');
  for (const entry of detected) {
    out(`| \`${entry.spec.id}\` | ${entry.spec.label} | \`${entry.path}\` | ${entry.exists ? 'yes' : 'no'} |`);
  }
  out('');
  out('Register with: `free-search-mcp install --client <id>` (repeat the flag for several).');
  out('');
  out('## Clients that cannot be configured from a file');
  out('');
  out(
    '- **Ollama / Open WebUI** — Ollama does not speak MCP itself. Run `free-search-mcp serve --transport http --port 8765` and add `http://127.0.0.1:8765/mcp` as a streamable-HTTP MCP server in an MCP-aware front end (Open WebUI, LibreChat, …).',
  );
}

/* ------------------------------------------------------------------ *
 * doctor
 * ------------------------------------------------------------------ */

async function commandDoctor(args: ParsedArgs, config: Config): Promise<void> {
  const services = createServices(config);
  const checks: { name: string; ok: boolean | 'warn'; detail: string }[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node.js',
    ok: major >= 22 ? true : 'warn',
    detail: `v${process.versions.node}${major >= 24 ? '' : ' (Node 24+ recommended for the SQLite FTS5 cache)'}`,
  });

  const cache = getCache(config);
  const stats = cache.stats();
  checks.push({
    name: 'Local index',
    ok: stats.fts5 || !config.cacheEnabled ? true : 'warn',
    detail: stats.fts5
      ? `SQLite FTS5 at ${stats.path} (${stats.pages} pages, ${formatBytes(stats.bytes)})`
      : cache.degradedReason ?? 'in-memory fallback',
  });

  try {
    ensureDataDir(config);
    checks.push({ name: 'Data directory', ok: true, detail: config.dataDir });
  } catch (err) {
    checks.push({ name: 'Data directory', ok: false, detail: (err as Error).message });
  }

  checks.push({
    name: 'Proxy',
    ok: true,
    detail: config.proxy ? config.proxy : 'none configured (direct connections)',
  });

  const probe = await probeFetch(services, 'https://example.com/');
  checks.push({
    name: 'Network (HTTPS)',
    ok: probe.ok,
    detail: probe.ok ? probe.detail : `${probe.detail} — check your connection or set FREE_SEARCH_PROXY`,
  });

  let engineRows: { id: string; ok: boolean; detail: string }[] = [];
  if (!flagBool(args, 'skip-engines')) {
    engineRows = await sweepEngines(args, config, services);
    const okCount = engineRows.filter((row) => row.ok).length;
    checks.push({
      name: 'Engines',
      ok: okCount > 0,
      detail: `${okCount}/${engineRows.length} usable from this machine`,
    });
  }

  const keyed = catalogue(config).filter((engine) => engine.requiresKey);
  const configuredKeyed = keyed.filter((engine) => engine.configured);
  checks.push({
    name: 'Optional API keys',
    ok: true,
    detail: configuredKeyed.length
      ? configuredKeyed.map((e) => e.id).join(', ')
      : 'none — the keyless engines are in use (this is fine)',
  });

  const clients = detectClients();
  const detected = clients.filter((c) => c.exists);
  checks.push({
    name: 'MCP clients detected',
    ok: true,
    detail: detected.length ? detected.map((c) => c.spec.id).join(', ') : 'none — run `free-search-mcp clients`',
  });

  const registered: string[] = [];
  for (const entry of detected) {
    try {
      const text = await readFile(entry.path, 'utf8');
      if (text.includes('free-search-mcp')) registered.push(entry.spec.id);
    } catch {
      /* an unreadable config is not a doctor failure */
    }
  }
  checks.push({
    name: 'Registered clients',
    ok: registered.length ? true : 'warn',
    detail: registered.length ? registered.join(', ') : 'not registered anywhere yet — run `free-search-mcp install`',
  });

  if (flagBool(args, 'json')) {
    printJson({ checks, engines: engineRows, cache: stats, config: redactConfig(config) });
    closeCache();
    return;
  }

  out('# free-search-mcp doctor');
  out('');
  out('| Check | Result | Detail |');
  out('|-------|--------|--------|');
  for (const check of checks) {
    const icon = check.ok === true ? TICK : check.ok === 'warn' ? WARN : CROSS;
    out(`| ${check.name} | ${icon} | ${check.detail.replace(/\|/g, '\\|')} |`);
  }
  out('');

  if (engineRows.length) {
    out('## Engine sweep');
    out('');
    out('Probed with a real query. An engine that fails here is benched automatically, so searches stay fast.');
    out('');
    out('| Engine | Result | Detail |');
    out('|--------|--------|--------|');
    for (const row of engineRows) {
      out(`| \`${row.id}\` | ${row.ok ? TICK : CROSS} | ${row.detail.replace(/\|/g, '\\|')} |`);
    }
    out('');
  }

  const failures = checks.filter((c) => c.ok === false);
  if (failures.length === 0) {
    out('Everything looks good. Try `free-search-mcp search "model context protocol"`.');
  } else {
    out(`${plural(failures.length, 'check')} failed. Fix those before relying on the server.`);
  }
  closeCache();
}

async function sweepEngines(
  args: ParsedArgs,
  config: Config,
  services: Services,
): Promise<{ id: string; ok: boolean; detail: string }[]> {
  const requested = flagList(args, 'engines');
  const all = catalogue(config);
  const ids = requested.length
    ? requested
    : ENGINE_IDS.filter((id) => isConfigured(id, config)).filter((id) => {
        const tier = all.find((e) => e.id === id)?.tier;
        return tier === 'primary' || tier === 'fallback' || tier === 'keyed';
      });

  const query = flagString(args, 'query') ?? 'model context protocol';
  const { resolveEngines } = await import('./engines/registry.js');
  const resolved = resolveEngines(ids, { http: services.http, config });

  const rows = await Promise.all(
    resolved.map(async (entry) => {
      const started = Date.now();
      try {
        const results = await entry.engine.search(query, { limit: 5, timeoutMs: Math.min(config.timeoutMs, 12_000) });
        const elapsed = Date.now() - started;
        return {
          id: entry.engine.id,
          ok: results.length > 0,
          detail: results.length > 0 ? `${results.length} results in ${ms(elapsed)}` : `no results in ${ms(elapsed)}`,
        };
      } catch (err) {
        return {
          id: entry.engine.id,
          ok: false,
          detail: `${(err as Error).message.slice(0, 120)} (${ms(Date.now() - started)})`,
        };
      }
    }),
  );

  for (const id of ids) {
    if (!resolved.some((r) => r.engine.id === id)) {
      rows.push({ id, ok: false, detail: 'not configured (needs an API key or instance URL)' });
    }
  }
  return rows;
}

/* ------------------------------------------------------------------ *
 * search / research
 * ------------------------------------------------------------------ */

async function commandSearch(args: ParsedArgs, config: Config): Promise<void> {
  const query = args.positionals.join(' ').trim();
  if (!query) fail('Usage: free-search-mcp search "<query>" [--max 12] [--engines duckduckgo,bing]');
  const services = createServices(config);

  const tool = getTool('web_search')!;
  const result = await tool.handler(
    {
      query,
      max_results: flagNumber(args, 'max') ?? flagNumber(args, 'max-results') ?? config.maxResults,
      engines: flagList(args, 'engines').length ? flagList(args, 'engines') : flagBool(args, 'all') ? ['all'] : undefined,
      freshness: flagString(args, 'freshness'),
      safe_search: flagString(args, 'safe') ?? flagString(args, 'safe-search'),
      language: flagString(args, 'lang') ?? flagString(args, 'language'),
      region: flagString(args, 'region'),
      site: flagString(args, 'site'),
      include_domains: flagList(args, 'include').length ? flagList(args, 'include') : undefined,
      exclude_domains: flagList(args, 'exclude').length ? flagList(args, 'exclude') : undefined,
      format: flagBool(args, 'json') ? 'json' : 'markdown',
    },
    services,
  );

  out(result.text);
  closeCache();
}

async function commandResearch(args: ParsedArgs, config: Config): Promise<void> {
  const query = args.positionals.join(' ').trim();
  if (!query) fail('Usage: free-search-mcp research "<question>" [--depth 2] [--sources 8]');
  const services = createServices(config);

  const tool = getTool('research')!;
  const result = await tool.handler(
    {
      query,
      depth: flagNumber(args, 'depth') ?? 2,
      max_sources: flagNumber(args, 'sources') ?? flagNumber(args, 'max-sources'),
      passages_per_source: flagNumber(args, 'passages'),
      engines: flagList(args, 'engines').length ? flagList(args, 'engines') : undefined,
      freshness: flagString(args, 'freshness'),
      language: flagString(args, 'lang'),
      region: flagString(args, 'region'),
      include_domains: flagList(args, 'include').length ? flagList(args, 'include') : undefined,
      exclude_domains: flagList(args, 'exclude').length ? flagList(args, 'exclude') : undefined,
      refresh: flagBool(args, 'refresh') ? true : undefined,
      format: flagBool(args, 'json') ? 'json' : 'markdown',
    },
    services,
  );

  out(result.text);
  const outFile = flagString(args, 'out');
  if (outFile) {
    writeFileSync(resolvePath(outFile), `${result.text}\n`, 'utf8');
    process.stderr.write(`written to ${resolvePath(outFile)}\n`);
  }
  closeCache();
}

/* ------------------------------------------------------------------ *
 * fetch / parse
 * ------------------------------------------------------------------ */

async function commandFetch(args: ParsedArgs, config: Config): Promise<void> {
  const url = args.positionals[0];
  if (!url) fail('Usage: free-search-mcp fetch <url> [--max-chars 40000] [--offset 0] [--links]');
  const services = createServices(config);
  const tool = getTool('fetch_url')!;
  const result = await tool.handler(
    {
      url,
      max_chars: flagNumber(args, 'max-chars'),
      offset: flagNumber(args, 'offset'),
      refresh: flagBool(args, 'refresh') ? true : undefined,
      include_links: flagBool(args, 'links') || undefined,
      format: flagBool(args, 'json') ? 'json' : 'markdown',
    },
    services,
  );
  out(result.text);
  closeCache();
}

async function commandParse(args: ParsedArgs, config: Config): Promise<void> {
  const path = args.positionals[0];
  if (!path) fail('Usage: free-search-mcp parse <file> [--sheet "Sheet1"] [--max-chars 40000]');
  const services = createServices(config);
  const tool = getTool('parse_document')!;
  const result = await tool.handler(
    {
      path,
      sheet: flagString(args, 'sheet'),
      max_chars: flagNumber(args, 'max-chars'),
      format: flagBool(args, 'json') ? 'json' : 'markdown',
    },
    services,
  );
  out(result.text);
  closeCache();
}

/* ------------------------------------------------------------------ *
 * engines / cache / config / tools
 * ------------------------------------------------------------------ */

async function commandEngines(args: ParsedArgs, config: Config): Promise<void> {
  const services = createServices(config);
  if (flagBool(args, 'check') || flagBool(args, 'check-engines') || flagBool(args, 'doctor')) {
    const rows = await sweepEngines(args, config, services);
    if (flagBool(args, 'json')) {
      printJson(rows);
      closeCache();
      return;
    }
    out('# Engine check');
    out('');
    out('| Engine | Result | Detail |');
    out('|--------|--------|--------|');
    for (const row of rows) out(`| \`${row.id}\` | ${row.ok ? TICK : CROSS} | ${row.detail.replace(/\|/g, '\\|')} |`);
    closeCache();
    return;
  }

  const engines = catalogue(config, { http: services.http, config });
  if (flagBool(args, 'json')) {
    printJson({ engines, health: services.search.health.detailed() });
    closeCache();
    return;
  }
  out(renderEngineTable(engines, services.search.health.snapshot(ENGINE_IDS)));
  out('');
  const health = services.search.health.detailed().filter((h) => h.totalCalls > 0);
  if (health.length) {
    out('## Health this session');
    out('');
    out('| Engine | Calls | Failures | Results | Last latency | Benched for |');
    out('|--------|-------|----------|---------|--------------|-------------|');
    for (const row of health) {
      out(
        `| \`${row.engine}\` | ${row.totalCalls} | ${row.totalFailures} | ${row.totalResults} | ${
          row.lastLatencyMs ? ms(row.lastLatencyMs) : '—'
        } | ${row.benchedRemainingMs > 0 ? ms(row.benchedRemainingMs) : '—'} |`,
      );
    }
  }
  closeCache();
}

function commandCache(args: ParsedArgs, config: Config): void {
  const sub = (args.positionals[0] ?? 'stats').toLowerCase();
  const cache = getCache(config);

  switch (sub) {
    case 'stats': {
      const stats = cache.stats();
      if (flagBool(args, 'json')) printJson(stats);
      else out(renderStats(stats));
      return;
    }
    case 'search': {
      const query = args.positionals.slice(1).join(' ');
      if (!query) fail('Usage: free-search-mcp cache search "<query>"');
      const hits = cache.searchPages(query, flagNumber(args, 'max') ?? 10);
      if (flagBool(args, 'json')) {
        printJson(hits);
        return;
      }
      if (!hits.length) {
        out('_No local matches._');
        return;
      }
      hits.forEach((hit, index) => {
        out(`${index + 1}. ${hit.title}`);
        out(`   ${hit.url}`);
        out(`   ${hit.snippet}`);
        out('');
      });
      return;
    }
    case 'clear': {
      const scope = (flagString(args, 'scope') ?? 'all') as 'pages' | 'search' | 'all';
      const removed = cache.clear(scope);
      out(`Removed ${removed} record(s) from the local index.`);
      return;
    }
    case 'prune': {
      const days = flagNumber(args, 'max-age-days') ?? flagNumber(args, 'days');
      const maxPages = flagNumber(args, 'max-pages');
      const removed = cache.prune({
        ...(days ? { maxAgeMs: days * 86_400_000 } : {}),
        ...(maxPages ? { maxRows: maxPages } : {}),
      });
      out(`Pruned ${removed} page record(s).`);
      return;
    }
    case 'vacuum': {
      cache.vacuum();
      out('Database compacted.');
      return;
    }
    case 'path': {
      out(cache.path ?? '(cache disabled)');
      return;
    }
    default:
      fail(`Unknown cache subcommand "${sub}". Use stats | search | clear | prune | vacuum | path.`);
  }
}

function renderStats(stats: ReturnType<PageCache['stats']>): string {
  return [
    '# Local index',
    '',
    `- Enabled: ${stats.enabled ? 'yes' : 'no'}`,
    `- Backend: ${stats.fts5 ? 'SQLite FTS5' : 'in-memory LRU (degraded)'}`,
    `- File: \`${stats.path ?? '—'}\``,
    `- Cached pages: ${stats.pages}`,
    `- Cached engine responses: ${stats.searchCacheEntries}`,
    `- Size: ${formatBytes(stats.bytes)}`,
    `- Oldest page: ${stats.oldestFetchedAt ?? '—'}`,
    `- Newest page: ${stats.newestFetchedAt ?? '—'}`,
  ].join('\n');
}

function commandConfig(args: ParsedArgs, config: Config): void {
  const redacted = redactConfig(config);
  if (flagBool(args, 'json')) {
    printJson(redacted);
    return;
  }
  out('# Effective configuration');
  out('');
  out(`Data directory: \`${config.dataDir}\``);
  out(`Config file: \`${config.configPath}\` (${existsSync(config.configPath) ? 'present' : 'not created'})`);
  out('');
  out('```json');
  out(JSON.stringify(redacted, null, 2));
  out('```');
}

function commandTools(args: ParsedArgs): void {
  if (flagBool(args, 'json')) {
    printJson(toolManifest());
    return;
  }
  out(`# Tools (${TOOLS.length})`);
  out('');
  for (const tool of TOOLS) {
    out(`## \`${tool.name}\` — ${tool.title}`);
    out('');
    out(tool.description);
    out('');
    out('| Argument | Required | Description |');
    out('|----------|----------|-------------|');
    for (const [key, schema] of Object.entries(tool.schema)) {
      const field = schema as unknown as { description?: string; isOptional?: () => boolean };
      const optional = typeof field.isOptional === 'function' ? field.isOptional() : false;
      out(`| \`${key}\` | ${optional ? 'no' : 'yes'} | ${(field.description ?? '').replace(/\|/g, '\\|')} |`);
    }
    out('');
  }
}

/* ------------------------------------------------------------------ *
 * Programmatic entry
 * ------------------------------------------------------------------ */

/** Start the MCP server programmatically (used when imported as a library). */
export async function serve(options: { config?: Config } = {}): Promise<void> {
  const config = options.config ?? getConfig();
  ensureDataDir(config);
  await runStdioServer(createServices(config));
}

export { createMcpServer, TOOLS };

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

/**
 * Was this file the process entry point, or was it imported as a library?
 *
 * Comparing `process.argv[1]` with `import.meta.url` directly is not enough:
 * npm's global shims and `npm link` pass the *symlinked* path while Node
 * resolves the real path for `import.meta.url`, so a naive comparison fails and
 * the CLI exits silently doing nothing. Resolve both through `realpath` first,
 * then fall back to a basename check so an unusual launcher still works.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;

  let here: string;
  try {
    here = fileURLToPath(import.meta.url);
  } catch {
    return false;
  }

  try {
    if (realpathSync(entry) === realpathSync(here)) return true;
  } catch {
    /* fall through to the looser checks */
  }

  // Global shim / npm link / npx cache: the launcher path differs from the real
  // one, but the basename still identifies this module.
  const entryName = entry.replace(/\\/g, '/').split('/').pop() ?? '';
  const hereName = here.replace(/\\/g, '/').split('/').pop() ?? '';
  if (entryName !== hereName) return false;
  return /^(?:cli|index)\.(?:js|mjs|cjs|ts)$/.test(entryName);
}

if (invokedDirectly()) {
  main().catch((err: unknown) => {
    // A crash must not look like a protocol error to the client.
    process.stderr.write(
      `free-search-mcp failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    resetDispatcher();
    closeCache();
    resetConfig();
    process.exit(1);
  });
}
