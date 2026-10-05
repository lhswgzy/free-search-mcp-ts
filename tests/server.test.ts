/**
 * Behavioural tests for the MCP server wiring (`src/server.ts`).
 *
 * The important one is the in-process round trip: a real `Client` talking to a
 * real `McpServer` over `InMemoryTransport.createLinkedPair()`. That exercises
 * the schema registration, argument validation and result framing without a
 * subprocess or a network request.
 *
 * One optional subprocess test speaks the same protocol to `dist/cli.js` over
 * stdio; it is skipped when the project has not been built, so `vitest run`
 * never requires a prior `npm run build`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig, type Config } from '../src/config.js';
import { closeCache } from '../src/cache.js';
import { assertFetchable, type HttpClient, type HttpRequestOptions, type HttpResponse } from '../src/http.js';
import { createServices, TOOLS, type Services } from '../src/tools/index.js';
import { createMcpServer, createStdioServer, SERVER_NAME, SERVER_VERSION, toolManifest } from '../src/server.js';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fsmcp-server-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  closeCache();
  // The stdio test spawns a real process that keeps a SQLite handle briefly;
  // retry the removal so a slow exit cannot fail the suite on Windows.
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function testConfig(): Config {
  return loadConfig({
    dataDir: tempDir(),
    skipDotEnv: true,
    overrides: { engines: [], autoEngines: true, respectRobots: false },
  });
}

function response(url: string, body: string, contentType = 'text/html; charset=utf-8'): HttpResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status: 200,
    ok: true,
    url,
    headers: new Headers({ 'content-type': contentType }),
    body,
    bytes,
    elapsedMs: 1,
    attempts: 1,
  };
}

/** A page shaped like a Bing result list, padded past the 512-byte block heuristic. */
function resultsPage(): string {
  const rows = [
    { url: 'https://alpha.example.com/one', title: 'Alpha page about widgets', snippet: 'Alpha snippet describing the widget pipeline in enough detail to be useful for a reader.' },
    { url: 'https://beta.example.com/two', title: 'Beta page about gadgets', snippet: 'Beta snippet describing the gadget pipeline in enough detail to be useful for a reader.' },
  ]
    .map(
      (r) =>
        `<li class="b_algo"><h2><a href="${r.url}">${r.title}</a></h2><div class="b_caption"><p>${r.snippet}</p></div></li>`,
    )
    .join('\n');
  return (
    '<!doctype html><html><head><title>widgets</title></head><body><main><ol id="b_results">\n' +
    `${rows}\n</ol><p>${'filler text '.repeat(60)}</p></main></body></html>`
  );
}

/** Every host answers with the same body, so any engine that runs succeeds. */
function stubHttp(config: Config, calls: string[] = []): HttpClient {
  const client: HttpClient = {
    config,
    async request(url, options: HttpRequestOptions = {}) {
      calls.push(url);
      assertFetchable(url, config, options.allowPrivate);
      return response(url, resultsPage());
    },
    async getText(url, options) {
      return (await client.request(url, options)).body;
    },
    async getJson<T>(url: string, options?: HttpRequestOptions): Promise<T> {
      return JSON.parse((await client.request(url, options)).body) as T;
    },
    async postForm(url, _form, options) {
      return client.request(url, { ...options, method: 'POST' });
    },
  };
  return client;
}

function stubServices(): Services {
  const config = testConfig();
  return createServices(config, stubHttp(config));
}

interface Session {
  client: Client;
  close: () => Promise<void>;
}

/** Connect a real MCP client to a real server over the in-memory transport. */
async function connect(services: Services): Promise<Session> {
  const server = createMcpServer(services);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'vitest-mcp-client', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

describe('toolManifest', () => {
  it('describes all eight tools with a name, title, description and schema', () => {
    const manifest = toolManifest();
    expect(manifest['server']).toEqual({ name: SERVER_NAME, version: SERVER_VERSION });

    const tools = manifest['tools'] as {
      name: string;
      title: string;
      description: string;
      annotations: Record<string, unknown>;
      inputSchema: unknown;
    }[];
    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.name.length, `${tool.name} name`).toBeGreaterThan(0);
      expect(tool.title.length, `${tool.name} title`).toBeGreaterThan(0);
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(40);
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.inputSchema, `${tool.name} inputSchema`).not.toBeNull();
    }
    const webSearch = tools.find((t) => t.name === 'web_search')!;
    expect(JSON.stringify(webSearch.inputSchema)).toContain('query');
    expect(webSearch.annotations['readOnlyHint']).toBe(true);
  });
});

describe('createMcpServer', () => {
  it('builds a server without throwing', () => {
    expect(() => createMcpServer(stubServices())).not.toThrow();
  });

  it('builds the stdio convenience server without throwing', () => {
    expect(() => createStdioServer(testConfig())).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * In-process MCP round trip
 * ------------------------------------------------------------------ */

describe('MCP round trip over the in-memory transport', () => {
  it('lists the eight tools with a web_search schema that requires query', async () => {
    const session = await connect(stubServices());
    try {
      const listed = await session.client.listTools();
      expect(listed.tools).toHaveLength(8);
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...TOOLS.map((t) => t.name)].sort());

      const webSearch = listed.tools.find((t) => t.name === 'web_search')!;
      expect(webSearch.title!.length).toBeGreaterThan(0);
      expect(webSearch.description!.length).toBeGreaterThan(40);
      const schema = webSearch.inputSchema as {
        type: string;
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect(schema.type).toBe('object');
      expect(schema.required).toContain('query');
      expect(schema.properties?.['query']).toBeDefined();

      expect(session.client.getServerVersion()?.name).toBe(SERVER_NAME);
      expect(session.client.getInstructions()).toContain('Local-first');
    } finally {
      await session.close();
    }
  });

  it('answers tools/call web_search with parseable JSON', async () => {
    const session = await connect(stubServices());
    try {
      const call = await session.client.callTool({
        name: 'web_search',
        arguments: { query: 'x', max_results: 2, format: 'json' },
      });

      expect(call.isError).toBeFalsy();
      const content = call.content as { type: string; text: string }[];
      expect(content.length).toBeGreaterThan(0);
      expect(content[0]!.type).toBe('text');

      const payload = JSON.parse(content[0]!.text) as { query: string; results: unknown[]; count: number };
      expect(payload.query).toBe('x');
      expect(Array.isArray(payload.results)).toBe(true);
      expect(payload.results.length).toBeGreaterThan(0);
      expect(payload.count).toBe(payload.results.length);
      expect((call as { structuredContent?: unknown }).structuredContent).toBeDefined();
    } finally {
      await session.close();
    }
  });

  it('answers a Markdown tool call with text content', async () => {
    const session = await connect(stubServices());
    try {
      const call = await session.client.callTool({ name: 'list_engines', arguments: {} });
      expect(call.isError).toBeFalsy();
      const text = (call.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('duckduckgo');
      expect(text).toContain('# Available search engines');
    } finally {
      await session.close();
    }
  });

  it('reports a private URL as an isError tool result', async () => {
    const session = await connect(stubServices());
    try {
      const call = await session.client.callTool({
        name: 'fetch_url',
        arguments: { url: 'http://127.0.0.1:9/secret' },
      });
      expect(call.isError).toBe(true);
      const text = (call.content as { type: string; text: string }[])[0]!.text;
      expect(text).toContain('private/loopback address');
    } finally {
      await session.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Optional subprocess handshake (needs a build)
 * ------------------------------------------------------------------ */

const distCli = resolve(process.cwd(), 'dist', 'cli.js');

interface JsonRpcMessage {
  id?: number;
  result?: { tools?: { name: string }[] };
  error?: unknown;
}

/** Minimal stdio JSON-RPC client: initialize + tools/list, no tool calls. */
async function stdioHandshake(cliPath: string, dataDir: string): Promise<string[]> {
  const child = spawn(process.execPath, [cliPath], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FREE_SEARCH_DATA_DIR: dataDir, FREE_SEARCH_LOG_LEVEL: 'error' },
  });

  let buffer = '';
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  let nextId = 1;

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index: number;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue; // Anything non-JSON here would break a real client.
      }
      const resolvePending = message.id === undefined ? undefined : pending.get(message.id);
      if (resolvePending && message.id !== undefined) {
        pending.delete(message.id);
        resolvePending(message);
      }
    }
  });

  const send = (method: string, params?: unknown): Promise<JsonRpcMessage> => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    return new Promise<JsonRpcMessage>((resolvePromise, reject) => {
      pending.set(id, resolvePromise);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 20_000);
    });
  };

  try {
    await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'vitest-stdio', version: '1.0.0' },
    });
    const listed = await send('tools/list', {});
    return (listed.result?.tools ?? []).map((tool) => tool.name);
  } finally {
    child.stdin.end();
    child.kill();
    // Wait for the process to actually exit so the temp data directory is not
    // still locked when the test's cleanup runs.
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(resolveExit, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolveExit();
      });
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timer);
        resolveExit();
      }
    });
  }
}

describe('stdio transport', () => {
  it.skipIf(!existsSync(distCli))('serves the same eight tools over stdio', async () => {
    const names = await stdioHandshake(distCli, tempDir());
    expect(names).toHaveLength(8);
    expect(names).toContain('web_search');
    expect(names).toContain('list_engines');
  });
});
