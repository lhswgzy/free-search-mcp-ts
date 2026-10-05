#!/usr/bin/env node
/**
 * End-to-end MCP protocol probe over stdio.
 *
 * Spawns the real CLI exactly as an MCP client would and speaks JSON-RPC down
 * the pipe: initialize -> notifications/initialized -> tools/list -> tools/call.
 *
 * This is the only check that proves the built server is *usable by a client*
 * rather than merely that its internals work. It is plain Node with no
 * dependencies, so `node scripts/probe-stdio.mjs` works on a fresh clone after
 * `npm run build`.
 *
 *   node scripts/probe-stdio.mjs [--cli path/to/cli.js] [--query "..."]
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const cliPath = resolve(projectRoot, arg('cli', 'dist/cli.js'));
const query = arg('query', 'model context protocol');

if (!existsSync(cliPath)) {
  console.error(`✗ ${cliPath} does not exist — run \`npm run build\` first.`);
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), 'fsmcp-stdio-'));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const child = spawn(process.execPath, [cliPath], {
  cwd: projectRoot,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, FREE_SEARCH_DATA_DIR: dataDir, FREE_SEARCH_LOG_LEVEL: 'error' },
});

let buffer = '';
let nonJsonStdout = 0;
const pending = new Map();
let nextId = 1;
const stderrChunks = [];

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      nonJsonStdout++;
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolveReply = pending.get(message.id);
      pending.delete(message.id);
      resolveReply(message);
    }
  }
});

child.stderr.on('data', (chunk) => {
  stderrChunks.push(chunk.toString('utf8'));
});

function send(method, params, expectReply = true, timeoutMs = 90_000) {
  const id = expectReply ? nextId++ : undefined;
  const payload = { jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, ...(params !== undefined ? { params } : {}) };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  if (id === undefined) return Promise.resolve(undefined);
  return new Promise((resolveReply, reject) => {
    pending.set(id, resolveReply);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);
  });
}

try {
  console.log(`\nMCP stdio probe → ${cliPath}\n`);

  const init = await send('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: 'free-search-mcp-probe', version: '1.0.0' },
  });
  const initResult = init.result ?? {};
  check('initialize returns a result', Boolean(init.result));
  check('serverInfo.name is free-search-mcp', initResult.serverInfo?.name === 'free-search-mcp', initResult.serverInfo?.name);
  check('protocolVersion negotiated', Boolean(initResult.protocolVersion), initResult.protocolVersion);
  check('advertises the tools capability', Boolean(initResult.capabilities?.tools));
  check('ships usage instructions', typeof initResult.instructions === 'string' && initResult.instructions.length > 50, `${initResult.instructions?.length ?? 0} chars`);

  await send('notifications/initialized', undefined, false);

  const ping = await send('ping', {});
  check('ping responds', ping.error === undefined);

  const list = await send('tools/list', {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((tool) => tool.name);
  const expected = ['web_search', 'research', 'fetch_url', 'fetch_urls', 'parse_document', 'search_index', 'local_index', 'list_engines'];
  check(`tools/list returns ${expected.length} tools`, tools.length === expected.length, names.join(', '));
  check('every expected tool is present', expected.every((name) => names.includes(name)));
  check('every tool has a description', tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 40));
  check('every tool has an input schema', tools.every((tool) => tool.inputSchema && typeof tool.inputSchema === 'object'));

  const webSearch = tools.find((tool) => tool.name === 'web_search');
  check('web_search requires a query argument', Array.isArray(webSearch?.inputSchema?.required) && webSearch.inputSchema.required.includes('query'));
  check('web_search declares its query property', Boolean(webSearch?.inputSchema?.properties?.query));
  check('read-only tools are annotated read-only', webSearch?.annotations?.readOnlyHint === true);

  const call = await send('tools/call', { name: 'web_search', arguments: { query, max_results: 3, format: 'json' } });
  const text = call.result?.content?.[0]?.text ?? '';
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* reported below */
  }
  check('tools/call web_search succeeds', call.error === undefined && text.length > 50, call.error ? JSON.stringify(call.error).slice(0, 140) : `${text.length} chars`);
  check('web_search format:json returns its declared shape', Boolean(payload && Array.isArray(payload.results)), payload ? `${payload.results?.length ?? 0} results from ${payload.enginesUsed?.length ?? 0} engine(s)` : 'not valid JSON');
  check('json results carry structuredContent too', Boolean(call.result?.structuredContent));

  const engines = await send('tools/call', { name: 'list_engines', arguments: {} });
  const engineText = engines.result?.content?.[0]?.text ?? '';
  check('list_engines lists the catalogue', engineText.includes('duckduckgo') && engineText.includes('bing'), `${engineText.length} chars`);

  const index = await send('tools/call', { name: 'search_index', arguments: { query: 'anything' } });
  check('search_index answers from the local index', index.error === undefined && (index.result?.content?.[0]?.text ?? '').length > 20);

  const blocked = await send('tools/call', { name: 'fetch_url', arguments: { url: 'http://127.0.0.1:9/nope' } });
  check('the SSRF guard refuses a loopback URL', blocked.result?.isError === true, (blocked.result?.content?.[0]?.text ?? '').slice(0, 90));

  const unknown = await send('tools/call', { name: 'definitely_not_a_tool', arguments: {} });
  check('an unknown tool is rejected, not crashed on', unknown.error !== undefined || unknown.result?.isError === true);

  check('nothing but JSON-RPC was written to stdout', nonJsonStdout === 0, `${nonJsonStdout} non-JSON line(s)`);
} catch (err) {
  check(`probe completed without throwing (${err.message})`, false);
} finally {
  child.stdin.end();
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  child.kill();
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length) {
  console.log('\n  server stderr:');
  for (const line of stderrChunks.join('').split('\n').slice(0, 12)) if (line.trim()) console.log(`    ${line.slice(0, 160)}`);
}
process.exit(failed.length === 0 ? 0 : 1);
