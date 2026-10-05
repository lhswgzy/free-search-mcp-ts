import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_DEFINITIONS, ENGINE_IDS } from '../src/engines/registry.js';
import { TOOLS } from '../src/tools/index.js';

/**
 * Documentation/code consistency.
 *
 * A README that documents an environment variable the code never reads, or an
 * engine id that does not exist, is worse than no documentation: a reader
 * follows it, nothing happens, and trust is gone. These tests fail CI when the
 * docs and the source drift apart — and they are how the "24 engines, not 25"
 * counting mistake in an earlier draft was caught.
 */

const read = (path: string): string => readFileSync(path, 'utf8');

const README = read('README.md');
const README_ZH = read('README.zh-CN.md');
const ENV_EXAMPLE = read('.env.example');
const CHANGELOG = read('CHANGELOG.md');
const CONTRIBUTING = read('CONTRIBUTING.md');

const SOURCE = [
  'src/config.ts',
  'src/cli.ts',
  'src/http.ts',
  'src/install/clients.ts',
  'src/tools/index.ts',
  'src/engines/registry.ts',
]
  .map(read)
  .join('\n');

describe('documentation matches the implementation', () => {
  it('documents no environment variable that the source never reads', () => {
    const documented = new Set<string>();
    for (const text of [README, README_ZH, ENV_EXAMPLE, CONTRIBUTING]) {
      for (const match of text.matchAll(/\b(FREE_SEARCH_[A-Z0-9_]+|FSMCP_[A-Z0-9_]+)\b/g)) {
        documented.add(match[1]!);
      }
    }
    // Vendor-standard key names are read via envLookup rather than by a literal
    // FREE_SEARCH_ name, so assert them separately.
    const vendorKeys = ['BRAVE_API_KEY', 'SERPER_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'SEARXNG_URL', 'GOOGLE_CSE_KEY', 'GOOGLE_CSE_CX'];
    for (const key of vendorKeys) {
      const mentioned = [README, README_ZH, ENV_EXAMPLE].some((text) => text.includes(key));
      if (mentioned) documented.add(key);
    }

    expect(documented.size).toBeGreaterThan(25);
    const unread = [...documented].filter((variable) => !SOURCE.includes(variable));
    expect(unread, `these variables are documented but never read in src/: ${unread.join(', ')}`).toEqual([]);
  });

  it('keeps every registry engine in the README and every README id in the registry', () => {
    const idPattern = /`([a-z0-9][a-z0-9-]{1,20})`/g;
    const documented = new Set<string>();
    for (const text of [README, README_ZH]) {
      for (const match of text.matchAll(idPattern)) {
        if (ENGINE_IDS.includes(match[1]!)) documented.add(match[1]!);
      }
    }
    const missing = ENGINE_IDS.filter((id) => !documented.has(id));
    expect(missing, `engines absent from the README engine tables: ${missing.join(', ')}`).toEqual([]);
    expect(documented.size).toBe(ENGINE_IDS.length);
  });

  it('states the engine count correctly in both READMEs', () => {
    const total = ENGINE_DEFINITIONS.length;
    const words: Record<number, string> = {
      22: 'Twenty-two', 23: 'Twenty-three', 24: 'Twenty-four', 25: 'Twenty-five', 26: 'Twenty-six',
    };
    expect(README).toContain(`${words[total] ?? total} engines`);
    expect(README_ZH).toContain(`共 ${total} 个引擎`);
    expect(CHANGELOG).toContain(`**Engines (${total})**`);
  });

  it('documents only CLI subcommands the switch actually handles', () => {
    const cliSource = read('src/cli.ts');
    const documented = new Set<string>();
    for (const match of README.matchAll(/^free-search-mcp-ts\s+([a-z]+)/gm)) documented.add(match[1]!);
    expect(documented.size).toBeGreaterThan(8);
    const unhandled = [...documented].filter((command) => !new RegExp(`case '${command}':`).test(cliSource));
    expect(unhandled, `README documents commands the CLI does not handle: ${unhandled.join(', ')}`).toEqual([]);
  });

  it('names only real MCP tools in the README', () => {
    const names = TOOLS.map((tool) => tool.name);
    expect(names).toHaveLength(8);
    const documented = new Set<string>();
    for (const match of README.matchAll(/`(web_search|research|fetch_url|fetch_urls|parse_document|search_index|local_index|list_engines)`/g)) {
      documented.add(match[1]!);
    }
    expect([...documented].sort()).toEqual([...names].sort());
  });

  it('documents every client spec it claims to support', () => {
    const specs = read('src/install/clients.ts');
    // Each spec id must be reachable from the CLI's client listing.
    const ids = [...specs.matchAll(/^\s{4}id: '([a-z0-9-]+)',/gm)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThanOrEqual(13);
    expect(ids).toContain('claude-desktop');
    expect(ids).toContain('codex');
    // Every id must be documented somewhere a user can find it.
    const listing = read('src/cli.ts');
    for (const id of ids) {
      expect(listing.includes(id) || specs.includes(id)).toBe(true);
    }
  });

  it('quotes measurement figures that the measurement script can reproduce', () => {
    // The scripts must exist and the README must point at them, otherwise the
    // numbers become unfalsifiable claims.
    const script = read('scripts/measure-savings.mts');
    expect(script).toContain('estimateTokens');
    expect(README).toContain('scripts/measure-savings.mts');
    expect(README_ZH).toContain('scripts/measure-savings.mts');
    expect(README).toMatch(/\b32\s*%/);
  });

  it('promises no key is required while still offering the optional ones', () => {
    expect(README).toContain('No keys by default');
    // Every keyed engine must name the env var that enables it.
    const keyed = ENGINE_DEFINITIONS.filter((definition) => definition.tier === 'keyed');
    expect(keyed.length).toBe(5);
    for (const definition of keyed) {
      expect(SOURCE.includes(definition.id)).toBe(true);
    }
    for (const key of ['BRAVE_API_KEY', 'SERPER_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'GOOGLE_CSE_KEY']) {
      expect(ENV_EXAMPLE).toContain(key);
    }
  });

  it('keeps authorship and the statement of origin', () => {
    // This project is an independent implementation that shares a concept with
    // an older, more mature Python project of a similar name. Two things have to
    // stay true in the documentation: the copyright belongs to whoever wrote
    // this code, and a reader must be told plainly which project came first.
    // Stripping either one is the failure this guards against.
    const authors = read('AUTHORS.md');
    const license = read('LICENSE');
    const pkg = JSON.parse(read('package.json')) as { name: string; author: { name: string; url: string }; files: string[] };

    // 1. Copyright is asserted for this codebase, by its author.
    expect(authors).toContain('lhswg');
    expect(authors).toContain('lhswgzy');
    expect(license).toContain('lhswg');
    expect(pkg.author.name).toBe('lhswg');
    expect(pkg.author.url).toContain('lhswgzy');

    // 2. The original project is named and linked, in both READMEs and AUTHORS.
    for (const text of [README, README_ZH, authors]) {
      expect(text).toContain('sweetcornna/free-search-mcp');
    }
    expect(authors).toMatch(/not a fork/i);
    expect(authors).toMatch(/no code/i);

    // 3. The npm name deliberately differs from the original's package name, so
    //    the original author keeps their own name on their own registry.
    expect(pkg.name).toBe('free-search-mcp-ts');
    expect(pkg.name).not.toBe('free-search-mcp');
    expect(authors).toContain('free-search-mcp-ts');

    // 4. AUTHORS.md has to ship with the package, or the surviving artifact
    //    would carry no statement of origin at all.
    expect(pkg.files).toContain('AUTHORS.md');
    expect(pkg.files).toContain('LICENSE');
  });
});
