#!/usr/bin/env node
/**
 * End-to-end probe for the streamable-HTTP transport.
 *
 * Starts the built server on a loopback port, then exercises the HTTP surface a
 * real client would use: /health, the status page, CORS preflight, the MCP
 * initialize handshake, tools/list and a real tools/call.
 *
 * Plain Node, no dependencies:
 *   node scripts/probe-http.mjs [--cli dist/cli.js] [--port 8799]
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
const port = Number(arg('port', '8799'));
const base = `http://127.0.0.1:${port}`;

if (!existsSync(cliPath)) {
  console.error(`✗ ${cliPath} does not exist — run \`npm run build\` first.`);
  process.exit(1);
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const dataDir = mkdtempSync(join(tmpdir(), 'fsmcp-http-'));
const child = spawn(process.execPath, [cliPath, 'serve', '--transport', 'http', '--port', String(port), '--host', '127.0.0.1'], {
  cwd: projectRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FREE_SEARCH_DATA_DIR: dataDir, FREE_SEARCH_LOG_LEVEL: 'error' },
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});
child.stdout.on('data', () => {
  /* the HTTP server writes nothing to stdout */
});

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function rpc(method, params, id, sessionId) {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let payload = {};
  if (text) {
    if (text.includes('\ndata:') || text.trimStart().startsWith('event:')) {
      const frames = text.split('\n').filter((line) => line.startsWith('data:'));
      payload = JSON.parse(frames[frames.length - 1].slice(5).trim());
    } else {
      payload = JSON.parse(text);
    }
  }
  return { status: res.status, sessionId: res.headers.get('mcp-session-id') ?? undefined, payload };
}

try {
  console.log(`\nMCP HTTP probe → ${base}\n`);

  const listening = await waitForHealth();
  check('server starts and answers /health', listening, listening ? '' : stderr.split('\n')[0]?.slice(0, 120) ?? '');
  if (!listening) throw new Error('server never became healthy');

  const health = await (await fetch(`${base}/health`)).json();
  check('/health reports the tool count and endpoint', health.status === 'ok' && health.tools === 8 && health.endpoint === '/mcp', JSON.stringify(health));

  const root = await fetch(`${base}/`);
  check('GET / serves a status page', root.status === 200 && (await root.text()).includes('free-search-mcp'));

  const preflight = await fetch(`${base}/mcp`, { method: 'OPTIONS' });
  check('OPTIONS /mcp answers a CORS preflight', preflight.status === 204, `allow-origin: ${preflight.headers.get('access-control-allow-origin')}`);

  const missing = await fetch(`${base}/nope`);
  check('an unknown path returns 404 JSON', missing.status === 404);

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'free-search-mcp-probe', version: '1.0.0' },
  }, 1);
  check('initialize over HTTP', init.payload?.result?.serverInfo?.name === 'free-search-mcp', init.payload?.result?.serverInfo?.name ?? JSON.stringify(init.payload).slice(0, 100));

  const session = init.sessionId;

  const list = await rpc('tools/list', {}, 2, session);
  const tools = list.payload?.result?.tools ?? [];
  check('tools/list over HTTP returns 8 tools', tools.length === 8, tools.map((t) => t.name).join(', '));

  const call = await rpc('tools/call', { name: 'web_search', arguments: { query: 'model context protocol', max_results: 2, format: 'json' } }, 3, session);
  const text = call.payload?.result?.content?.[0]?.text ?? '';
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* reported below */
  }
  check('tools/call web_search over HTTP', call.payload?.error === undefined && Array.isArray(payload?.results), payload ? `${payload.results.length} results in ${payload.elapsedMs}ms` : (call.payload?.error?.message ?? 'no result'));

  const index = await rpc('tools/call', { name: 'search_index', arguments: { query: 'example' } }, 4, session);
  check('tools/call search_index over HTTP', index.payload?.error === undefined, (index.payload?.result?.content?.[0]?.text ?? '').split('\n')[1]?.slice(0, 60) ?? '');
} catch (err) {
  check(`probe completed without throwing (${err.message})`, false);
} finally {
  child.kill();
  await new Promise((r) => setTimeout(r, 200));
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n  ${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
