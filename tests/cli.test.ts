/**
 * Behavioural tests for the command line (`src/cli.ts`).
 *
 * `main()` is only ever called for read-only subcommands; the tests capture
 * stdout through a spy and always restore it, so a stray write cannot leak into
 * another test's output.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COMMAND_ALIASES, parseArgs, resolveCommand, main } from '../src/cli.js';
import { SERVER_VERSION } from '../src/server.js';
import { TOOLS } from '../src/tools/index.js';
import { CLIENT_SPECS } from '../src/install/clients.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fsmcp-cli-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Spy on stdout and collect everything written to it. */
function captureStdout(): { text: () => string; restore: () => void } {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as never);
  return { text: () => chunks.join(''), restore: () => spy.mockRestore() };
}

async function runCli(argv: string[]): Promise<string> {
  const capture = captureStdout();
  try {
    await main(argv);
  } finally {
    capture.restore();
  }
  return capture.text();
}

/* ------------------------------------------------------------------ *
 * Argument parsing
 * ------------------------------------------------------------------ */

describe('parseArgs', () => {
  it('reads a value given as --flag value', () => {
    const args = parseArgs(['search', '--max', '5']);
    expect(args.command).toBe('search');
    expect(args.flags.get('max')).toBe('5');
    expect(args.positionals).toEqual([]);
  });

  it('reads a value given as --flag=value', () => {
    const args = parseArgs(['search', '--max=5', '--freshness=week']);
    expect(args.flags.get('max')).toBe('5');
    expect(args.flags.get('freshness')).toBe('week');
  });

  it('treats a known boolean flag as true with no value', () => {
    const args = parseArgs(['search', '--json']);
    expect(args.flags.get('json')).toBe(true);
    expect(args.flags.has('max')).toBe(false);
  });

  it('treats a trailing unknown flag as true', () => {
    expect(parseArgs(['search', '--depth']).flags.get('depth')).toBe(true);
  });

  it('accumulates a repeated flag into an array', () => {
    const args = parseArgs(['install', '--client', 'cursor', '--client', 'zed']);
    expect(args.flags.get('client')).toEqual(['cursor', 'zed']);
  });

  it('keeps a comma-separated list intact for the CLI list handling to split', () => {
    const args = parseArgs(['install', '--client', 'cursor,zed']);
    expect(args.flags.get('client')).toEqual(['cursor,zed']);
    // A single occurrence is still stored as a one-element list.
    expect(parseArgs(['install', '--client', 'cursor']).flags.get('client')).toEqual(['cursor']);
  });

  it('maps the short flags -h, -v and -j', () => {
    expect(parseArgs(['-h']).flags.get('help')).toBe(true);
    expect(parseArgs(['-v']).flags.get('version')).toBe(true);
    expect(parseArgs(['search', '-j']).flags.get('json')).toBe(true);
    expect(parseArgs(['-h']).command).toBe('');
  });

  it('stops flag parsing at --', () => {
    const args = parseArgs(['search', '--', '--json']);
    expect(args.command).toBe('search');
    expect(args.positionals).toEqual(['--json']);
    expect(args.flags.size).toBe(0);
  });

  it('keeps a positional that starts with - after --', () => {
    const args = parseArgs(['fetch', '--', '-v-weird-path']);
    expect(args.positionals).toEqual(['-v-weird-path']);
    expect(args.flags.has('version')).toBe(false);
    expect(args.command).toBe('fetch');
  });

  it('treats a value that itself starts with -- as the next flag', () => {
    const args = parseArgs(['search', '--site', '--json']);
    expect(args.flags.get('site')).toBe(true);
    expect(args.flags.get('json')).toBe(true);
    expect(args.positionals).toEqual([]);
  });

  it('collects extra positionals after the command', () => {
    const args = parseArgs(['search', 'model', 'context', 'protocol']);
    expect(args.command).toBe('search');
    expect(args.positionals).toEqual(['model', 'context', 'protocol']);
  });

  it('lower-cases the command so aliases match', () => {
    expect(parseArgs(['LS']).command).toBe('ls');
  });
});

/* ------------------------------------------------------------------ *
 * Command resolution
 * ------------------------------------------------------------------ */

describe('command aliases and the default command', () => {
  it('defaults to serve when no command is given', () => {
    expect(parseArgs([]).command).toBe('');
    expect(resolveCommand(parseArgs([]))).toBe('serve');
    expect(resolveCommand(parseArgs(['--json']))).toBe('serve');
  });

  it('resolves the documented aliases', () => {
    expect(resolveCommand(parseArgs(['ls']))).toBe('engines');
    expect(resolveCommand(parseArgs(['q', 'widgets']))).toBe('search');
    expect(resolveCommand(parseArgs(['add']))).toBe('install');
    expect(resolveCommand(parseArgs(['rm']))).toBe('uninstall');
    expect(COMMAND_ALIASES['ls']).toBe('engines');
    expect(COMMAND_ALIASES['q']).toBe('search');
    expect(COMMAND_ALIASES['add']).toBe('install');
    expect(COMMAND_ALIASES['rm']).toBe('uninstall');
  });

  it('passes an unknown command through untouched', () => {
    expect(resolveCommand(parseArgs(['doctor']))).toBe('doctor');
    expect(resolveCommand(parseArgs(['frobnicate']))).toBe('frobnicate');
  });

  it('routes the ls alias to the engine listing', async () => {
    const output = await runCli(['ls', '--data-dir', tempDir()]);
    expect(output).toContain('# Available search engines');
    expect(output).toContain('duckduckgo');
  });
});

/* ------------------------------------------------------------------ *
 * Read-only main() paths
 * ------------------------------------------------------------------ */

describe('main() read-only paths', () => {
  it('prints the version for --version', async () => {
    const output = await runCli(['--version']);
    expect(output.trim()).toBe(SERVER_VERSION);
  });

  it('lists the eight tools for `tools`', async () => {
    const output = await runCli(['tools', '--data-dir', tempDir()]);
    expect(output).toContain('# Tools (8)');
    for (const tool of TOOLS) {
      expect(output, `tool ${tool.name}`).toContain(`## \`${tool.name}\``);
    }
    expect(TOOLS).toHaveLength(8);
  });

  it('lists the supported clients for `clients`', async () => {
    const output = await runCli(['clients', '--data-dir', tempDir()]);
    expect(output).toContain('# Supported MCP clients');
    expect(output).toContain('| id | Client | Config file | Detected |');
    for (const id of ['claude-desktop', 'cursor', 'zed', 'codex', 'opencode']) {
      expect(output, `client ${id}`).toContain(`\`${id}\``);
    }
    expect(CLIENT_SPECS.some((spec) => spec.id === 'ollama')).toBe(true);
  });

  it('prints the effective data directory for `config`', async () => {
    const dataDir = tempDir();
    const output = await runCli(['config', '--data-dir', dataDir]);
    expect(output).toContain('# Effective configuration');
    expect(output).toContain('Data directory:');
    expect(output).toContain(dataDir);
    expect(output).toContain('```json');
  });

  it('exposes the JSON output paths without throwing', async () => {
    const dataDir = tempDir();
    expect(await runCli(['tools', '--json', '--data-dir', dataDir])).toContain('"name": "web_search"');
    expect(await runCli(['ls', '--json', '--data-dir', dataDir])).toContain('"engines"');
  });
});

/* ------------------------------------------------------------------ *
 * Comma-separated list handling, end to end
 * ------------------------------------------------------------------ */

describe('CLI list handling', () => {
  it('splits one comma-separated --client flag into several clients', async () => {
    // --dry-run guarantees nothing is written to the real HOME.
    const output = await runCli(['install', '--client', 'cursor,zed', '--dry-run', '--data-dir', tempDir()]);
    expect(output).toContain('Dry run');
    expect(output).toContain('Cursor');
    expect(output).toContain('Zed');
  });

  it('accepts a repeated --client flag as well', async () => {
    const output = await runCli([
      'install',
      '--client',
      'cursor',
      '--client',
      'zed',
      '--dry-run',
      '--data-dir',
      tempDir(),
    ]);
    expect(output).toContain('Cursor');
    expect(output).toContain('Zed');
  });
});
