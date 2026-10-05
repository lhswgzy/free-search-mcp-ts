/**
 * Behavioural tests for the client installer (`src/install/*`).
 *
 * Every install/uninstall round trip runs against a throwaway HOME built with
 * `fs.mkdtemp`, so the developer's real client configs are never touched.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CLIENT_SPECS,
  FORWARDED_ENV_KEYS,
  buildEntryShape,
  defaultInstallContext,
  deleteNested,
  getClientSpec,
  getNested,
  parseJsonc,
  removeTomlServer,
  resolveServerEntry,
  setNested,
  tomlServerBlock,
  upsertTomlServer,
  type InstallContext,
  type ServerEntry,
} from '../src/install/clients.js';
import { detectClients, formatInstallReport, install, uninstall } from '../src/install/index.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fsmcp-install-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function contextFor(home: string): Partial<InstallContext> {
  return { home, appData: join(home, 'AppData'), cwd: home };
}

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

const ENTRY: ServerEntry = { command: 'npx', args: ['-y', 'free-search-mcp-ts'], env: { BRAVE_API_KEY: 'secret' } };

/* ------------------------------------------------------------------ *
 * JSONC parsing
 * ------------------------------------------------------------------ */

describe('parseJsonc', () => {
  it('strips line and block comments and trailing commas', () => {
    const text = `{
  // a line comment
  "a": 1, /* a block comment */
  "list": [1, 2,],
}`;
    const parsed = parseJsonc(text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.hadComments).toBe(true);
    expect(parsed.value['a']).toBe(1);
    expect(parsed.value['list']).toEqual([1, 2]);
  });

  it('keeps a // that appears inside a string value', () => {
    const parsed = parseJsonc('{"url": "https://example.com//path", "k": "/* not a comment */"}');
    expect(parsed.hadComments).toBe(false);
    expect(parsed.value['url']).toBe('https://example.com//path');
    expect(parsed.value['k']).toBe('/* not a comment */');
  });

  it('reports an error instead of throwing on invalid JSON', () => {
    const parsed = parseJsonc('{ "a": }');
    expect(parsed.error).toBeDefined();
    expect(parsed.value).toEqual({});
  });

  it('returns an empty object for an empty file and for a non-object root', () => {
    expect(parseJsonc('   \n').value).toEqual({});
    const arrayRoot = parseJsonc('[1, 2]');
    expect(arrayRoot.value).toEqual({});
    expect(arrayRoot.error).toContain('not an object');
  });
});

/* ------------------------------------------------------------------ *
 * Dotted-path access
 * ------------------------------------------------------------------ */

describe('nested config access', () => {
  it('creates intermediate objects and reads them back', () => {
    const root: Record<string, unknown> = {};
    setNested(root, ['mcpServers', 'free-search-mcp-ts'], { command: 'npx' });
    expect(getNested(root, ['mcpServers'])).toEqual({ 'free-search-mcp-ts': { command: 'npx' } });
    expect(getNested(root, ['mcpServers', 'free-search-mcp-ts'])).toEqual({ command: 'npx' });

    setNested(root, ['a', 'b', 'c'], { deep: true });
    expect(getNested(root, ['a', 'b'])).toEqual({ c: { deep: true } });
  });

  it('replaces a non-object intermediate value', () => {
    const root: Record<string, unknown> = { a: 5 };
    setNested(root, ['a', 'b'], { ok: true });
    expect(getNested(root, ['a', 'b'])).toEqual({ ok: true });
  });

  it('returns undefined for missing paths and for scalar leaves', () => {
    expect(getNested({}, ['nope'])).toBeUndefined();
    expect(getNested({ a: 1 }, ['a'])).toBeUndefined();
    expect(getNested({ a: { b: 2 } }, ['a', 'b'])).toBeUndefined();
  });

  it('deletes only the addressed key', () => {
    const root: Record<string, unknown> = {
      mcpServers: { 'free-search-mcp-ts': { command: 'npx' }, other: { command: 'other' } },
    };
    expect(deleteNested(root, ['mcpServers', 'free-search-mcp-ts'])).toBe(true);
    expect(getNested(root, ['mcpServers'])).toEqual({ other: { command: 'other' } });
    expect(deleteNested(root, ['mcpServers', 'absent'])).toBe(false);
    expect(deleteNested({}, ['x', 'y'])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Entry shape per client
 * ------------------------------------------------------------------ */

describe('buildEntryShape', () => {
  it('gives vscode a stdio type', () => {
    const shaped = buildEntryShape(getClientSpec('vscode')!, 'free-search-mcp-ts', ENTRY);
    expect(shaped['type']).toBe('stdio');
    expect(shaped['command']).toBe('npx');
    expect(shaped['args']).toEqual(['-y', 'free-search-mcp-ts']);
    expect(shaped['env']).toEqual({ BRAVE_API_KEY: 'secret' });
  });

  it('gives zed a custom source', () => {
    const shaped = buildEntryShape(getClientSpec('zed')!, 'free-search-mcp-ts', ENTRY);
    expect(shaped['source']).toBe('custom');
    expect(shaped['command']).toBe('npx');
  });

  it('gives opencode a command array and an environment key', () => {
    const shaped = buildEntryShape(getClientSpec('opencode')!, 'free-search-mcp-ts', ENTRY);
    expect(shaped['command']).toEqual(['npx', '-y', 'free-search-mcp-ts']);
    expect(shaped['type']).toBe('local');
    expect(shaped['enabled']).toBe(true);
    expect(shaped['environment']).toEqual({ BRAVE_API_KEY: 'secret' });
    expect(shaped['env']).toBeUndefined();
  });

  it('gives standard and toml clients command + args', () => {
    const standard = buildEntryShape(getClientSpec('cursor')!, 'free-search-mcp-ts', ENTRY);
    const toml = buildEntryShape(getClientSpec('codex')!, 'free-search-mcp-ts', ENTRY);
    expect(standard['command']).toBe('npx');
    expect(standard['args']).toEqual(['-y', 'free-search-mcp-ts']);
    expect(toml).toEqual(standard);
  });

  it('omits the env key entirely when nothing is forwarded', () => {
    const shaped = buildEntryShape(getClientSpec('cursor')!, 'free-search-mcp-ts', {
      command: 'npx',
      args: [],
      env: {},
    });
    expect(shaped).toEqual({ command: 'npx', args: [] });
    expect('env' in shaped).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * TOML handling
 * ------------------------------------------------------------------ */

describe('TOML server blocks', () => {
  const EXISTING = `model = "gpt-5"
approval_policy = "never"

[mcp_servers.other]
command = "other-server"
args = ["--flag"]

[history]
persistence = "save-all"
`;

  it('renders a block with an env subsection', () => {
    const block = tomlServerBlock('free-search-mcp-ts', ENTRY);
    expect(block).toContain('[mcp_servers.free-search-mcp-ts]');
    expect(block).toContain('command = "npx"');
    expect(block).toContain('args = ["-y", "free-search-mcp-ts"]');
    expect(block).toContain('[mcp_servers.free-search-mcp-ts.env]');
    expect(block).toContain('BRAVE_API_KEY = "secret"');
  });

  it('appends to an existing file without disturbing neighbouring tables', () => {
    const updated = upsertTomlServer(EXISTING, 'free-search-mcp-ts', tomlServerBlock('free-search-mcp-ts', ENTRY));
    expect(updated).toContain('[mcp_servers.free-search-mcp-ts]');
    expect(updated).toContain('model = "gpt-5"');
    expect(updated).toContain('[mcp_servers.other]');
    expect(updated).toContain('command = "other-server"');
    expect(updated).toContain('[history]');
    expect(updated).toContain('persistence = "save-all"');
  });

  it('is idempotent on a second call', () => {
    const once = upsertTomlServer(EXISTING, 'free-search-mcp-ts', tomlServerBlock('free-search-mcp-ts', ENTRY));
    const twice = upsertTomlServer(once, 'free-search-mcp-ts', tomlServerBlock('free-search-mcp-ts', ENTRY));
    expect(twice).toBe(once);
    expect(occurrences(twice, '[mcp_servers.free-search-mcp-ts]')).toBe(1);
  });

  it('removes the block and its env subsection but keeps the rest', () => {
    const updated = upsertTomlServer(EXISTING, 'free-search-mcp-ts', tomlServerBlock('free-search-mcp-ts', ENTRY));
    const removed = removeTomlServer(updated, 'free-search-mcp-ts');
    expect(removed).not.toContain('free-search-mcp-ts');
    expect(removed).not.toContain('BRAVE_API_KEY');
    expect(removed).toContain('[mcp_servers.other]');
    expect(removed).toContain('command = "other-server"');
    expect(removed).toContain('[history]');
    expect(removed).toContain('persistence = "save-all"');
  });

  it('leaves a file without the entry untouched', () => {
    expect(removeTomlServer(EXISTING, 'free-search-mcp-ts')).toBe(EXISTING.trimEnd());
  });
});

/* ------------------------------------------------------------------ *
 * Command resolution
 * ------------------------------------------------------------------ */

describe('resolveServerEntry', () => {
  it('uses npx in npx mode', () => {
    const entry = resolveServerEntry({ mode: 'npx', platform: 'linux', sourceEnv: {} });
    expect(entry.command).toBe('npx');
    expect(entry.args).toEqual(['-y', 'free-search-mcp-ts']);
    expect(entry.env).toEqual({});
  });

  it('uses the current node binary in node mode', () => {
    const cliPath = join('opt', 'free-search-mcp-ts', 'dist', 'cli.js');
    const entry = resolveServerEntry({ mode: 'node', cliPath, platform: 'linux', sourceEnv: {} });
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([resolve(cliPath)]);
    expect(entry.command).not.toBe('npx');
  });

  it('refuses node mode for a transient _npx cache path', () => {
    const transient =
      'C:/Users/someone/AppData/Local/npm-cache/_npx/abc123/node_modules/free-search-mcp-ts/dist/cli.js';
    const entry = resolveServerEntry({ mode: 'auto', cliPath: transient, platform: 'linux', sourceEnv: {} });
    expect(entry.command).toBe('npx');
    expect(entry.args).toContain('free-search-mcp-ts');
  });

  it('uses node mode for a real node_modules installation', () => {
    const installed = 'C:/work/project/node_modules/free-search-mcp-ts/dist/cli.js';
    const entry = resolveServerEntry({ mode: 'auto', cliPath: installed, platform: 'linux', sourceEnv: {} });
    expect(entry.command).toBe(process.execPath);
    expect(entry.args).toEqual([resolve(installed)]);
  });

  it('honours an explicit command override', () => {
    const entry = resolveServerEntry({ command: '/usr/local/bin/fsmcp', args: ['serve'], sourceEnv: {} });
    expect(entry).toEqual({ command: '/usr/local/bin/fsmcp', args: ['serve'], env: {} });
  });

  it('wraps npx in cmd /c on Windows when the client needs it', () => {
    const entry = resolveServerEntry({ mode: 'npx', platform: 'win32', windowsCmdWrap: true, sourceEnv: {} });
    expect(entry.command).toBe('cmd');
    expect(entry.args).toEqual(['/c', 'npx', '-y', 'free-search-mcp-ts']);
  });

  it('forwards only recognised environment variables', () => {
    const entry = resolveServerEntry({
      mode: 'npx',
      sourceEnv: {
        BRAVE_API_KEY: 'brave',
        FREE_SEARCH_REGION: 'de',
        FREE_SEARCH_PROXY: '',
        UNRELATED_SECRET: 'nope',
      } as NodeJS.ProcessEnv,
      env: { FREE_SEARCH_MAX_RESULTS: '5' },
    });
    expect(entry.env).toEqual({ BRAVE_API_KEY: 'brave', FREE_SEARCH_REGION: 'de', FREE_SEARCH_MAX_RESULTS: '5' });
    expect(FORWARDED_ENV_KEYS).toContain('BRAVE_API_KEY');
    expect(entry.env['UNRELATED_SECRET']).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Client detection
 * ------------------------------------------------------------------ */

describe('detectClients', () => {
  it('reports every file-based client as undetected in an empty HOME', () => {
    const home = tempHome();
    const detected = detectClients(contextFor(home));
    expect(detected.length).toBe(CLIENT_SPECS.filter((s) => !s.manual).length);
    expect(detected.every((d) => d.exists === false)).toBe(true);
  });

  it('detects a client once its config file exists', () => {
    const home = tempHome();
    const cursorPath = join(home, '.cursor', 'mcp.json');
    // The file has to exist for the installer to consider Cursor "present".
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(cursorPath, '{}\n', 'utf8');

    const detected = detectClients(contextFor(home));
    const cursor = detected.find((d) => d.spec.id === 'cursor');
    expect(cursor?.exists).toBe(true);
    expect(cursor?.path).toBe(cursorPath);
    expect(detected.find((d) => d.spec.id === 'zed')?.exists).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * install() / uninstall() round trips
 * ------------------------------------------------------------------ */

describe('install and uninstall (JSON client)', () => {
  it('creates the config, backs it up, and is idempotent', () => {
    const home = tempHome();
    const configPath = join(home, '.cursor', 'mcp.json');
    const context = contextFor(home);

    const first = install({ clients: ['cursor'], mode: 'npx', context });
    expect(first.results[0]!.action).toBe('installed');
    expect(first.results[0]!.detected).toBe(false);
    expect(first.serverName).toBe('free-search-mcp-ts');
    expect(first.entry.command).toBe('npx');
    expect(existsSync(configPath)).toBe(true);
    expect(first.results[0]!.backup).toBeUndefined();
    expect(readJson(configPath).mcpServers['free-search-mcp-ts'].args).toEqual(['-y', 'free-search-mcp-ts']);

    const second = install({ clients: ['cursor'], mode: 'npx', context });
    expect(second.results[0]!.action).toBe('already-present');
    expect(second.results[0]!.backup).toBeUndefined();
  });

  it('never clobbers an unrelated key inside mcpServers or at the root', () => {
    const home = tempHome();
    const configPath = join(home, '.cursor', 'mcp.json');
    const context = contextFor(home);
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other', args: ['--x'] } } }, null, 2),
      'utf8',
    );

    const report = install({ clients: ['cursor'], mode: 'npx', context });
    expect(report.results[0]!.action).toBe('installed');
    expect(report.results[0]!.backup).toBe(`${configPath}.bak`);
    expect(existsSync(`${configPath}.bak`)).toBe(true);
    expect(JSON.parse(readFileSync(`${configPath}.bak`, 'utf8')).mcpServers['free-search-mcp-ts']).toBeUndefined();

    const after = readJson(configPath);
    expect(after.theme).toBe('dark');
    expect(after.mcpServers.other).toEqual({ command: 'other', args: ['--x'] });
    expect(after.mcpServers['free-search-mcp-ts']).toBeDefined();
  });

  it('reports updated only with force, and then rewrites the entry', () => {
    const home = tempHome();
    const configPath = join(home, '.cursor', 'mcp.json');
    const context = contextFor(home);
    install({ clients: ['cursor'], mode: 'npx', context });

    const differing = install({ clients: ['cursor'], mode: 'npx', env: { FREE_SEARCH_REGION: 'de' }, context });
    expect(differing.results[0]!.action).toBe('already-present');
    expect(differing.results[0]!.detail).toContain('--force');

    const forced = install({
      clients: ['cursor'],
      mode: 'npx',
      env: { FREE_SEARCH_REGION: 'de' },
      force: true,
      context,
    });
    expect(forced.results[0]!.action).toBe('updated');
    expect(forced.results[0]!.backup).toBe(`${configPath}.bak`);
    expect(readJson(configPath).mcpServers['free-search-mcp-ts'].env).toMatchObject({ FREE_SEARCH_REGION: 'de' });
  });

  it('writes nothing at all in dry-run mode', () => {
    const home = tempHome();
    const configPath = join(home, '.cursor', 'mcp.json');
    const report = install({ clients: ['cursor'], mode: 'npx', dryRun: true, context: contextFor(home) });

    expect(report.dryRun).toBe(true);
    expect(report.results[0]!.action).toBe('installed');
    expect(report.results[0]!.detail).toContain('dry run');
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(`${configPath}.bak`)).toBe(false);
  });

  it('removes only our entry and leaves unrelated ones intact', () => {
    const home = tempHome();
    const configPath = join(home, '.cursor', 'mcp.json');
    const context = contextFor(home);
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other' } } }, null, 2),
      'utf8',
    );
    install({ clients: ['cursor'], mode: 'npx', context });

    const removed = uninstall({ clients: ['cursor'], context });
    expect(removed.results[0]!.action).toBe('removed');
    expect(removed.results[0]!.detail).toContain('removed');
    expect(removed.results[0]!.backup).toBe(`${configPath}.bak`);

    const after = readJson(configPath);
    expect(after.mcpServers['free-search-mcp-ts']).toBeUndefined();
    expect(after.mcpServers.other).toEqual({ command: 'other' });
    expect(after.theme).toBe('dark');
  });

  it('reports not-found when there is nothing to remove', () => {
    const home = tempHome();
    const configPath = join(home, '.cursor', 'mcp.json');
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(configPath, '{"mcpServers":{}}\n', 'utf8');

    const removed = uninstall({ clients: ['cursor'], context: contextFor(home) });
    expect(removed.results[0]!.action).toBe('not-found');
    expect(readJson(configPath).mcpServers).toEqual({});
  });

  it('writes nothing in a dry-run uninstall', () => {
    const home = tempHome();
    const configPath = join(home, '.cursor', 'mcp.json');
    const context = contextFor(home);
    install({ clients: ['cursor'], mode: 'npx', context });
    const before = readFileSync(configPath, 'utf8');

    const report = uninstall({ clients: ['cursor'], dryRun: true, context });
    expect(report.results[0]!.action).toBe('removed');
    expect(report.results[0]!.detail).toContain('would remove');
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

describe('install and uninstall (TOML client)', () => {
  it('round-trips a Codex config file', () => {
    const home = tempHome();
    const configPath = join(home, '.codex', 'config.toml');
    const context = contextFor(home);

    const first = install({ clients: ['codex'], mode: 'npx', context });
    expect(first.results[0]!.action).toBe('installed');
    expect(existsSync(configPath)).toBe(true);
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('[mcp_servers.free-search-mcp-ts]');
    expect(text).toContain('command = "npx"');
    expect(text).toContain('args = ["-y", "free-search-mcp-ts"]');

    const second = install({ clients: ['codex'], mode: 'npx', context });
    expect(second.results[0]!.action).toBe('already-present');

    const forced = install({
      clients: ['codex'],
      mode: 'npx',
      env: { FREE_SEARCH_REGION: 'de' },
      force: true,
      context,
    });
    expect(forced.results[0]!.action).toBe('updated');
    expect(forced.results[0]!.backup).toBe(`${configPath}.bak`);
    const forcedText = readFileSync(configPath, 'utf8');
    expect(forcedText).toContain('[mcp_servers.free-search-mcp-ts.env]');
    expect(forcedText).toContain('FREE_SEARCH_REGION = "de"');
    expect(occurrences(forcedText, '[mcp_servers.free-search-mcp-ts]')).toBe(1);

    const removed = uninstall({ clients: ['codex'], context });
    expect(removed.results[0]!.action).toBe('removed');
    expect(readFileSync(configPath, 'utf8')).not.toContain('free-search-mcp-ts');
  });

  it('keeps unrelated tables in an existing TOML file', () => {
    const home = tempHome();
    const configPath = join(home, '.codex', 'config.toml');
    const context = contextFor(home);
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(configPath, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n', 'utf8');

    install({ clients: ['codex'], mode: 'npx', context });
    const installed = readFileSync(configPath, 'utf8');
    expect(installed).toContain('model = "gpt-5"');
    expect(installed).toContain('[mcp_servers.other]');
    expect(installed).toContain('command = "other"');
    expect(installed).toContain('[mcp_servers.free-search-mcp-ts]');

    uninstall({ clients: ['codex'], context });
    const after = readFileSync(configPath, 'utf8');
    expect(after).not.toContain('free-search-mcp-ts');
    expect(after).toContain('model = "gpt-5"');
    expect(after).toContain('[mcp_servers.other]');
    expect(after).toContain('command = "other"');
  });
});

/* ------------------------------------------------------------------ *
 * Reports
 * ------------------------------------------------------------------ */

describe('install reports', () => {
  it('renders a table of results and next steps', () => {
    const home = tempHome();
    const report = install({ clients: ['cursor'], mode: 'npx', context: contextFor(home) });
    const text = formatInstallReport(report);
    expect(text).toContain('# MCP client registration');
    expect(text).toContain('Server name: `free-search-mcp-ts`');
    expect(text).toContain('Cursor');
    expect(text).toContain('## Verify');
  });

  it('explains what to do when no client was detected', () => {
    const text = formatInstallReport({
      serverName: 'free-search-mcp-ts',
      entry: { command: 'npx', args: ['-y', 'free-search-mcp-ts'], env: {} },
      results: [],
      dryRun: false,
    });
    expect(text).toContain('No MCP clients were detected');
    expect(text).toContain('install --client claude-desktop');
  });

  it('summarises a dry run', () => {
    const home = tempHome();
    const report = install({ clients: ['cursor'], mode: 'npx', dryRun: true, context: contextFor(home) });
    const text = formatInstallReport(report);
    expect(text).toContain('Dry run');
    expect(text).toContain('nothing was written');
  });
});
