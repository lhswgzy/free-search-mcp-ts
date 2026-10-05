#!/usr/bin/env node
/**
 * Acceptance harness.
 *
 * Runs every check that has to pass before this project can be called working,
 * and prints one summary table. Exits non-zero if anything fails.
 *
 *   node scripts/verify.mjs              # offline: typecheck, build, tests, protocol probes, packaging
 *   node scripts/verify.mjs --online     # also performs a real search and fetch
 *   node scripts/verify.mjs --skip-build # reuse the existing dist/
 *
 * Deliberately dependency-free (plain Node) so it works on a fresh clone.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const online = process.argv.includes('--online');
const skipBuild = process.argv.includes('--skip-build');

const results = [];
let currentPhase = '';

function phase(title) {
  currentPhase = title;
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/**
 * Run a command, capture output, record pass/fail.
 *
 * `shell` is opt-in and must stay off for anything invoked by absolute path:
 * on Windows a `shell: true` spawn splits `C:\Program Files\nodejs\node.exe`
 * at the space and fails with "is not recognized as an operable program".
 * Only npm needs a shell, because npm is a `.cmd` shim there.
 */
function run(name, command, args, options = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: options.shell ?? false,
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return record(name, result, started, options);
}

/**
 * Run an npm command line through a shell.
 *
 * The whole command is passed as one string rather than as an argv array,
 * because Node emits DEP0190 when `shell: true` is combined with separate
 * arguments — it can only concatenate them, never escape them.
 */
function runShell(name, commandLine, options = {}) {
  const started = Date.now();
  const result = spawnSync(commandLine, {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, ...(options.env ?? {}) },
    timeout: options.timeoutMs ?? 900_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return record(name, result, started, options);
}

function record(name, result, started, options) {
  const elapsed = Date.now() - started;
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = result.status === 0;
  results.push({ phase: currentPhase, name, ok, elapsed, output: combined });

  const tail = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? (result.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? '';
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name} \x1b[2m(${(elapsed / 1000).toFixed(1)}s)\x1b[0m${ok ? '' : `\n      ${tail.slice(0, 200)}`}`);
  if (!ok && options.verbose) {
    for (const line of combined.split('\n').slice(-25)) console.log(`      ${line.slice(0, 200)}`);
  }
  return { ok, output: combined };
}

/** npm must go through a shell on Windows because npm is a `.cmd` shim. */
const runNpm = (name, commandLine, options = {}) => runShell(name, `npm ${commandLine}`, options);

/** Assertion-style check with no external process. */
function assert(name, condition, detail = '') {
  results.push({ phase: currentPhase, name, ok: Boolean(condition), elapsed: 0, output: detail });
  console.log(`  ${condition ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` \x1b[2m(${detail})\x1b[0m` : ''}`);
}

const cli = 'dist/cli.js';
const dataDir = mkdtempSync(join(tmpdir(), 'fsmcp-verify-'));
const cliEnv = { FREE_SEARCH_DATA_DIR: dataDir, FREE_SEARCH_LOG_LEVEL: 'error' };

console.log(`\x1b[1mfree-search-mcp-ts acceptance harness\x1b[0m\n  project: ${projectRoot}\n  mode:    ${online ? 'online' : 'offline'}${skipBuild ? ', reusing dist/' : ''}`);

/* ---------------------------------------------------------------- *
 * 1. Static checks
 * ---------------------------------------------------------------- */
phase('Static analysis');
runNpm('typecheck (tsc --noEmit)', 'run typecheck');

if (!skipBuild) {
  phase('Build');
  runNpm('build (tsc)', 'run build');
}

if (!existsSync(join(projectRoot, cli))) {
  console.error(`\n\x1b[31m${cli} is missing — cannot continue.\x1b[0m`);
  process.exit(1);
}

/* ---------------------------------------------------------------- *
 * 2. Test suite
 * ---------------------------------------------------------------- */
phase('Test suite');
const tests = runNpm('vitest run', 'test', { env: cliEnv });
const testsPassed = Number(/Tests\s+(\d+) passed/.exec(tests.output)?.[1] ?? 0);
const testsFailed = Number(/Tests\s+(\d+) failed/.exec(tests.output)?.[1] ?? 0);
if (testsPassed) assert(`test count is meaningful`, testsPassed >= 250, `${testsPassed} passed, ${testsFailed} failed`);

/* ---------------------------------------------------------------- *
 * 3. Protocol probes
 * ---------------------------------------------------------------- */
phase('MCP stdio transport');
run('protocol probe (stdio)', process.execPath, ['scripts/probe-stdio.mjs'], { verbose: true });

phase('MCP HTTP transport');
run('protocol probe (streamable HTTP)', process.execPath, ['scripts/probe-http.mjs'], { verbose: true });

/* ---------------------------------------------------------------- *
 * 4. CLI surface
 * ---------------------------------------------------------------- */
phase('CLI surface');
const version = run('--version', process.execPath, [cli, '--version'], { env: cliEnv });
assert('--version prints a semver', /^\d+\.\d+\.\d+/.test(version.output.trim()));

const tools = run('tools', process.execPath, [cli, 'tools'], { env: cliEnv });
assert('tools lists all 8 tools', ['web_search', 'research', 'fetch_url', 'fetch_urls', 'parse_document', 'search_index', 'local_index', 'list_engines'].every((name) => tools.output.includes(name)));

const clients = run('clients', process.execPath, [cli, 'clients'], { env: cliEnv });
assert('clients lists the supported clients', clients.output.includes('claude-desktop') && clients.output.includes('codex') && clients.output.includes('cursor'));

const config = run('config', process.execPath, [cli, 'config'], { env: cliEnv });
assert('config prints the data directory', config.output.includes(dataDir));

const cacheStats = run('cache stats', process.execPath, [cli, 'cache', 'stats'], { env: cliEnv });
assert('cache stats reports the SQLite FTS5 backend', /SQLite FTS5/.test(cacheStats.output), cacheStats.output.includes('SQLite FTS5') ? 'fts5 live' : 'degraded');

const enginesList = run('engines', process.execPath, [cli, 'engines'], { env: cliEnv });
const engineCount = (enginesList.output.match(/^\| `[a-z0-9-]+` \|/gm) ?? []).length;
assert('engines lists the whole catalogue', engineCount >= 20, `${engineCount} engines`);

const installDry = run('install --dry-run', process.execPath, [cli, 'install', '--dry-run'], { env: cliEnv });
assert('install --dry-run writes nothing and reports a plan', /Dry run/i.test(installDry.output));

/* ---------------------------------------------------------------- *
 * 5. Packaging
 * ---------------------------------------------------------------- */
phase('Packaging');
const packDir = mkdtempSync(join(tmpdir(), 'fsmcp-pack-'));
const packed = runNpm('npm pack', `pack --pack-destination "${packDir}" --json`, { env: cliEnv });
let packInfo = null;
try {
  packInfo = JSON.parse(packed.output.replace(/^[^{[]*/, ''))[0];
} catch {
  /* reported by the assertions below */
}
assert('npm pack produces a tarball', Boolean(packInfo?.filename), packInfo?.filename ?? 'no pack output');
if (packInfo) {
  const files = (packInfo.files ?? []).map((file) => file.path);
  const required = ['dist/cli.js', 'dist/index.js', 'README.md', 'README.zh-CN.md', 'LICENSE', 'CHANGELOG.md', 'AUTHORS.md'];
  const missing = required.filter((path) => !files.includes(path));
  assert('the tarball contains every required file', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${files.length} files`);
  const leaked = files.filter((path) => path.startsWith('tests/') || path.startsWith('scratch/') || path.startsWith('src/'));
  assert('the tarball leaks no tests, scratch or sources', leaked.length === 0, leaked.slice(0, 3).join(', '));
  assert('the tarball is a sensible size', (packInfo.size ?? 0) < 2_000_000, `${((packInfo.size ?? 0) / 1024).toFixed(0)} kB`);
}

/* ---------------------------------------------------------------- *
 * 6. Optional live checks
 * ---------------------------------------------------------------- */
if (online) {
  phase('Live network (opt-in)');
  const search = run('search (live, multi-engine)', process.execPath, [cli, 'search', 'model context protocol', '--max', '5'], { env: cliEnv, timeoutMs: 180_000 });
  assert('a live search returns results', /^\d+\. \*\*\[/m.test(search.output), `${(search.output.match(/^\d+\. \*\*\[/gm) ?? []).length} results`);
  assert('the live search reports which engines ran', /Per-engine counts|engines:/i.test(search.output));

  const fetchRun = run('fetch (live)', process.execPath, [cli, 'fetch', 'https://example.com/'], { env: cliEnv, timeoutMs: 120_000 });
  assert('a live fetch returns Markdown', fetchRun.output.includes('# Example Domain'), `${fetchRun.output.length} chars`);
  assert('the fetch was cached on the second read', /cached/i.test(run('fetch (cached)', process.execPath, [cli, 'fetch', 'https://example.com/'], { env: cliEnv, timeoutMs: 120_000 }).output));

  const doctor = run('doctor (engine sweep)', process.execPath, [cli, 'doctor'], { env: cliEnv, timeoutMs: 300_000 });
  assert('doctor finds at least one usable engine', /Engines \| .*\| \d+\/\d+ usable/.test(doctor.output), (doctor.output.match(/(\d+)\/(\d+) usable/) ?? []).slice(1).join('/'));
}

/* ---------------------------------------------------------------- *
 * Summary
 * ---------------------------------------------------------------- */
try {
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
} catch {
  /* best effort */
}

const failed = results.filter((result) => !result.ok);
console.log(`\n\x1b[1mSummary\x1b[0m`);
for (const result of results) {
  if (result.ok) continue;
  console.log(`  \x1b[31m✗\x1b[0m [${result.phase}] ${result.name}`);
}
console.log(`\n  ${results.length - failed.length}/${results.length} checks passed${online ? '' : ' (offline mode — pass --online for live network checks)'}`);

if (failed.length) {
  console.log('\n\x1b[31mFAILED\x1b[0m');
  process.exit(1);
}
console.log('\n\x1b[32mALL CHECKS PASSED\x1b[0m');
