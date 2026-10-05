/**
 * MCP client registration.
 *
 * Each supported client gets a spec describing where its config lives, how the
 * file is formatted, and what a server entry looks like in it. Everything else
 * (backups, JSONC tolerance, upsert vs append, dry runs) is generic.
 *
 * Two principles:
 *   1. **Never destroy config.** Every write is preceded by a `.bak` copy, and
 *      only the one key we own is touched.
 *   2. **Be honest about limits.** Where a client cannot be configured from a
 *      file (a GUI-only client, or one without MCP support at all) the spec says
 *      so and the installer prints instructions instead of pretending.
 */

import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const DEFAULT_SERVER_NAME = 'free-search-mcp';

/** Environment variables worth forwarding into the client's config. */
export const FORWARDED_ENV_KEYS = [
  'BRAVE_API_KEY',
  'SERPER_API_KEY',
  'TAVILY_API_KEY',
  'EXA_API_KEY',
  'SEARXNG_URL',
  'GOOGLE_CSE_KEY',
  'GOOGLE_CSE_CX',
  'FREE_SEARCH_ENGINES',
  'FREE_SEARCH_PROXY',
  'FREE_SEARCH_DATA_DIR',
  'FREE_SEARCH_MAX_RESULTS',
  'FREE_SEARCH_CACHE',
  'FREE_SEARCH_RESPECT_ROBOTS',
  'FREE_SEARCH_REGION',
  'FREE_SEARCH_LANGUAGE',
  'FREE_SEARCH_LOG_LEVEL',
] as const;

/** How a client expects a stdio server to be described. */
export type EntryShape = 'standard' | 'vscode' | 'zed' | 'opencode' | 'toml';

export interface InstallContext {
  platform: NodeJS.Platform;
  home: string;
  appData: string;
  cwd: string;
  /** The directory containing the running CLI, used for the `node` command mode. */
  installDir: string;
}

export interface ClientSpec {
  id: string;
  label: string;
  /** Dotted path to the map that holds server entries. */
  serversPath: string[];
  shape: EntryShape;
  /** True when the file may contain comments/trailing commas. */
  jsonc?: boolean;
  /** Config file candidates; the first existing one wins, else the first is created. */
  paths: (ctx: InstallContext) => string[];
  /** Where to read about the client. */
  docs?: string;
  /** Extra guidance printed after installing. */
  note?: string;
  /** Set for clients that cannot be registered from a file. */
  manual?: string;
  /**
   * Whether `npx` must go through `cmd /c` on Windows. Modern clients spawn
   * with cross-spawn and do not need it; older Electron-based ones do.
   */
  windowsCmdWrap?: boolean;
}

export function defaultInstallContext(overrides: Partial<InstallContext> = {}): InstallContext {
  const platform = overrides.platform ?? osPlatform();
  const home = overrides.home ?? homedir();
  const appData =
    overrides.appData ??
    process.env.APPDATA ??
    (platform === 'darwin' ? join(home, 'Library', 'Application Support') : join(home, '.config'));
  return {
    platform,
    home,
    appData,
    cwd: overrides.cwd ?? process.cwd(),
    installDir: overrides.installDir ?? process.cwd(),
  };
}

const isWin = (ctx: InstallContext): boolean => ctx.platform === 'win32';

/** All supported clients, in the order the installer presents them. */
export const CLIENT_SPECS: readonly ClientSpec[] = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    serversPath: ['mcpServers'],
    shape: 'standard',
    windowsCmdWrap: true,
    docs: 'https://modelcontextprotocol.io/quickstart/user',
    paths: (ctx) =>
      isWin(ctx)
        ? [join(ctx.appData, 'Claude', 'claude_desktop_config.json')]
        : ctx.platform === 'darwin'
          ? [join(ctx.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')]
          : [join(ctx.home, '.config', 'Claude', 'claude_desktop_config.json')],
    note: 'Restart Claude Desktop completely (quit from the tray, not just the window) for the server to appear.',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://docs.claude.com/en/docs/claude-code/mcp',
    paths: (ctx) => [join(ctx.home, '.claude.json')],
    note: 'Equivalent to running: claude mcp add free-search-mcp -- npx -y free-search-mcp',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://docs.cursor.com/context/model-context-protocol',
    paths: (ctx) => [join(ctx.home, '.cursor', 'mcp.json')],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://docs.windsurf.com/windsurf/cascade/mcp',
    paths: (ctx) => [join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json')],
  },
  {
    id: 'vscode',
    label: 'VS Code (GitHub Copilot agent mode)',
    serversPath: ['servers'],
    shape: 'vscode',
    jsonc: true,
    docs: 'https://code.visualstudio.com/docs/copilot/chat/mcp-servers',
    paths: (ctx) => [
      join(ctx.cwd, '.vscode', 'mcp.json'),
      isWin(ctx) ? join(ctx.appData, 'Code', 'User', 'mcp.json') : join(ctx.home, '.config', 'Code', 'User', 'mcp.json'),
    ],
    note: 'The workspace file (.vscode/mcp.json) is created in the current directory; use --scope user for the global one.',
  },
  {
    id: 'cline',
    label: 'Cline (VS Code extension)',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://docs.cline.bot/mcp/configuring-mcp-servers',
    paths: (ctx) => [
      isWin(ctx)
        ? join(ctx.appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
        : join(ctx.home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    ],
  },
  {
    id: 'roo-code',
    label: 'Roo Code (VS Code extension)',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://docs.roocode.com/features/mcp/using-mcp-in-roo',
    paths: (ctx) => [
      isWin(ctx)
        ? join(ctx.appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json')
        : join(ctx.home, '.config', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'),
    ],
  },
  {
    id: 'zed',
    label: 'Zed',
    serversPath: ['context_servers'],
    shape: 'zed',
    jsonc: true,
    docs: 'https://zed.dev/docs/ai/mcp',
    paths: (ctx) =>
      isWin(ctx)
        ? [join(ctx.appData, 'Zed', 'settings.json')]
        : ctx.platform === 'darwin'
          ? [join(ctx.home, 'Library', 'Application Support', 'Zed', 'settings.json')]
          : [join(ctx.home, '.config', 'zed', 'settings.json')],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    serversPath: ['mcp_servers'],
    shape: 'toml',
    docs: 'https://github.com/openai/codex',
    paths: (ctx) => [join(ctx.home, '.codex', 'config.toml')],
    note: 'Equivalent to running: codex mcp add free-search-mcp -- npx -y free-search-mcp',
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://github.com/google-gemini/gemini-cli',
    paths: (ctx) => [join(ctx.home, '.gemini', 'settings.json')],
  },
  {
    id: 'opencode',
    label: 'opencode',
    serversPath: ['mcp'],
    shape: 'opencode',
    jsonc: true,
    docs: 'https://opencode.ai/docs/mcp-servers/',
    paths: (ctx) => [
      join(ctx.home, '.config', 'opencode', 'opencode.json'),
      join(ctx.cwd, 'opencode.json'),
    ],
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://lmstudio.ai/docs/app/mcp',
    paths: (ctx) => [join(ctx.home, '.lmstudio', 'mcp.json')],
  },
  {
    id: 'continue',
    label: 'Continue',
    serversPath: ['mcpServers'],
    shape: 'standard',
    docs: 'https://docs.continue.dev/customize/deep-dives/mcp',
    paths: (ctx) => [join(ctx.home, '.continue', 'config.json')],
    note: 'Recent Continue versions configure MCP servers in the assistant YAML instead. If the entry does not appear, add it from the Continue UI.',
  },
  {
    id: 'ollama',
    label: 'Ollama / Open WebUI',
    serversPath: [],
    shape: 'standard',
    docs: 'https://docs.openwebui.com/openapi-servers/mcp',
    paths: () => [],
    manual:
      'Ollama itself does not speak MCP: the tool-calling loop has to live in the client. Point an MCP-capable front end at this server instead — run `free-search-mcp serve --transport http --port 8765` and add http://127.0.0.1:8765/mcp as a streamable-HTTP MCP server in Open WebUI (Settings → Tools → MCP), LibreChat, or any other MCP-aware UI. The same HTTP endpoint works from a container or another machine on your network.',
  },
] as const;

export function getClientSpec(id: string): ClientSpec | undefined {
  return CLIENT_SPECS.find((spec) => spec.id === id.toLowerCase());
}

/* ------------------------------------------------------------------ *
 * JSONC parsing
 * ------------------------------------------------------------------ */

/**
 * Strip `//` and block comments plus trailing commas, then parse.
 * Returns the parse result and whether comments were present, because writing
 * the file back will lose them and the caller should say so.
 */
export function parseJsonc(text: string): { value: Record<string, unknown>; hadComments: boolean; error?: string } {
  let hadComments = false;
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      hadComments = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      hadComments = true;
      i++;
      continue;
    }
    out += ch;
  }

  // Remove trailing commas before } or ].
  const withoutTrailingCommas = out.replace(/,(\s*[}\]])/g, '$1');

  if (!withoutTrailingCommas.trim()) return { value: {}, hadComments };
  try {
    const parsed = JSON.parse(withoutTrailingCommas) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown>, hadComments };
    }
    return { value: {}, hadComments, error: 'config root is not an object' };
  } catch (err) {
    return { value: {}, hadComments, error: (err as Error).message };
  }
}

/* ------------------------------------------------------------------ *
 * Server entry construction
 * ------------------------------------------------------------------ */

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type CommandMode = 'auto' | 'npx' | 'node';

export interface ResolveEntryOptions {
  /** Override the whole command, e.g. a global install path. */
  command?: string;
  args?: string[];
  mode?: CommandMode;
  /** Extra environment variables to inject. */
  env?: Record<string, string>;
  /** Absolute path of the CLI entry (`dist/cli.js`) for `node` mode. */
  cliPath?: string;
  /** Copy recognised FREE_SEARCH_* and API-key variables from this environment. */
  sourceEnv?: NodeJS.ProcessEnv;
  /** Client asked for it: wrap npx in `cmd /c` on Windows. */
  windowsCmdWrap?: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Work out how a client should launch this server.
 *
 * `auto` prefers an absolute `node /path/to/cli.js` when this process was
 * started from a real installation (a global install or a project dependency),
 * because that survives cache cleanup; when running from an `npx` cache — which
 * can be garbage-collected — it emits the conventional
 * `npx -y free-search-mcp` instead.
 */
export function resolveServerEntry(options: ResolveEntryOptions = {}): ServerEntry {
  const env = collectEnv(options.sourceEnv ?? process.env, options.env);
  const platform = options.platform ?? process.platform;

  if (options.command) {
    return { command: options.command, args: options.args ?? [], env };
  }

  const cliPath = options.cliPath ?? process.argv[1];
  const mode = options.mode ?? 'auto';
  const looksTransient = !!cliPath && /(_npx|npm-cache|_cacache|\.npm[\\/]_npx)/i.test(cliPath);
  const looksInstalled = !!cliPath && /node_modules[\\/](free-search-mcp|@[\w-]+[\\/]free-search-mcp)[\\/]/i.test(cliPath);

  const useNode = mode === 'node' || (mode === 'auto' && looksInstalled && !looksTransient);

  if (useNode && cliPath) {
    return { command: process.execPath, args: [resolve(cliPath)], env };
  }

  if (platform === 'win32' && options.windowsCmdWrap) {
    return { command: 'cmd', args: ['/c', 'npx', '-y', DEFAULT_SERVER_NAME], env };
  }
  return { command: 'npx', args: ['-y', DEFAULT_SERVER_NAME], env };
}

function collectEnv(source: NodeJS.ProcessEnv, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value !== '') env[key] = value;
  }
  return env;
}

/** Shape the entry the way a specific client expects it. */
export function buildEntryShape(spec: ClientSpec, name: string, entry: ServerEntry): Record<string, unknown> {
  const env = Object.keys(entry.env).length ? entry.env : undefined;
  switch (spec.shape) {
    case 'vscode':
      return { type: 'stdio', command: entry.command, args: entry.args, ...(env ? { env } : {}) };
    case 'zed':
      return { source: 'custom', command: entry.command, args: entry.args, ...(env ? { env } : {}) };
    case 'opencode':
      return { type: 'local', command: [entry.command, ...entry.args], enabled: true, ...(env ? { environment: env } : {}) };
    case 'toml':
    case 'standard':
    default:
      return { command: entry.command, args: entry.args, ...(env ? { env } : {}) };
  }
}

/* ------------------------------------------------------------------ *
 * File operations
 * ------------------------------------------------------------------ */

export interface ConfigFileState {
  path: string;
  exists: boolean;
  /** Parsed contents (empty object when missing). */
  data: Record<string, unknown>;
  hadComments: boolean;
  error?: string;
}

export function pickConfigPath(spec: ClientSpec, ctx: InstallContext, scope: 'auto' | 'workspace' | 'user' = 'auto'): string {
  const candidates = spec.paths(ctx);
  if (candidates.length === 0) return '';
  if (scope === 'user' && candidates.length > 1) return candidates[candidates.length - 1]!;
  const existing = candidates.find((candidate) => existsSync(candidate));
  return existing ?? candidates[0]!;
}

export function readConfigFile(spec: ClientSpec, path: string): ConfigFileState {
  if (!path) return { path: '', exists: false, data: {}, hadComments: false };
  if (!existsSync(path)) return { path, exists: false, data: {}, hadComments: false };
  const text = readFileSync(path, 'utf8');
  if (spec.shape === 'toml') {
    return { path, exists: true, data: { __toml: text } as Record<string, unknown>, hadComments: false };
  }
  const { value, hadComments, error } = parseJsonc(text);
  return { path, exists: true, data: value, hadComments, ...(error ? { error } : {}) };
}

export interface WriteResult {
  path: string;
  wrote: boolean;
  backup?: string;
  created: boolean;
  hadComments: boolean;
}

/** Write `data` as pretty JSON, backing the previous file up first. */
export function writeJsonConfig(path: string, data: unknown): WriteResult {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existed = existsSync(path);
  let backup: string | undefined;
  if (existed) {
    backup = `${path}.bak`;
    try {
      copyFileSync(path, backup);
    } catch {
      backup = undefined;
    }
  }
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { path, wrote: true, created: !existed, ...(backup ? { backup } : {}), hadComments: false };
}

/** Write raw text (used for TOML), backing the previous file up first. */
export function writeTextConfig(path: string, text: string): WriteResult {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existed = existsSync(path);
  let backup: string | undefined;
  if (existed) {
    backup = `${path}.bak`;
    try {
      copyFileSync(path, backup);
    } catch {
      backup = undefined;
    }
  }
  writeFileSync(path, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return { path, wrote: true, created: !existed, ...(backup ? { backup } : {}), hadComments: false };
}

/** Read/write a nested object by dotted key path, creating levels as needed. */
export function getNested(root: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let node: unknown = root;
  for (const key of path) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === 'object' && !Array.isArray(node) ? (node as Record<string, unknown>) : undefined;
}

export function setNested(root: Record<string, unknown>, path: string[], value: Record<string, unknown>): void {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const existing = node[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  node[path[path.length - 1]!] = value;
}

export function deleteNested(root: Record<string, unknown>, path: string[]): boolean {
  const parent = path.length > 1 ? getNested(root, path.slice(0, -1)) : root;
  if (!parent) return false;
  const last = path[path.length - 1]!;
  if (!(last in parent)) return false;
  delete parent[last];
  return true;
}

/* ------------------------------------------------------------------ *
 * TOML (only what Codex needs)
 * ------------------------------------------------------------------ */

/** Render a stdio server as a Codex `[mcp_servers.<name>]` block. */
export function tomlServerBlock(name: string, entry: ServerEntry): string {
  const lines: string[] = [];
  lines.push(`[mcp_servers.${name}]`);
  lines.push(`command = ${tomlString(entry.command)}`);
  lines.push(`args = [${entry.args.map(tomlString).join(', ')}]`);
  const envKeys = Object.keys(entry.env);
  if (envKeys.length) {
    lines.push('');
    lines.push(`[mcp_servers.${name}.env]`);
    for (const key of envKeys) lines.push(`${key} = ${tomlString(entry.env[key]!)}`);
  }
  return lines.join('\n');
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Insert or replace a TOML server block, preserving the rest of the file. */
export function upsertTomlServer(text: string, name: string, block: string): string {
  const withoutOld = removeTomlServer(text, name);
  const trimmed = withoutOld.trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ''}${block}\n`;
}

/** Remove `[mcp_servers.<name>]` and any `[mcp_servers.<name>.*]` subsections. */
export function removeTomlServer(text: string, name: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  const headerRe = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:"${escapeRe(name)}"|${escapeRe(name)})\\s*(\\.[^\\]]*)?\\]\\s*$`);
  const anyHeaderRe = /^\s*\[/;

  for (const line of lines) {
    if (headerRe.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && anyHeaderRe.test(line)) {
      skipping = false;
    }
    if (!skipping) out.push(line);
  }
  // Collapse the blank-line runs left behind.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
