/**
 * MCP server wiring.
 *
 * Two transports are supported:
 *
 *   - **stdio** (default) — what every MCP client expects when it spawns
 *     `npx -y free-search-mcp-ts`. Nothing but JSON-RPC may touch stdout, so all
 *     diagnostics go to stderr.
 *   - **streamable HTTP** — for clients that cannot spawn a process (web UIs,
 *     containerised agents, a shared instance on localhost). Stateless: one
 *     transport serves every request, no session bookkeeping.
 *
 * The tool schemas come from `src/tools/index.ts`, so the server and the CLI
 * can never drift apart.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { createServices, TOOLS, type Services } from './tools/index.js';
import type { Config } from './config.js';
import { createLogger } from './util/logger.js';

const log = createLogger('server');

export const SERVER_NAME = 'free-search-mcp-ts';
export const SERVER_VERSION = '0.1.0';

/** Build an `McpServer` with every tool registered. */
export function createMcpServer(services: Services): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
      title: 'free-search-mcp-ts',
      websiteUrl: 'https://github.com/lhswgzy/free-search-mcp-ts',
    },
    {
      capabilities: { tools: {} },
      instructions: [
        'Local-first web research. No API key is required.',
        'web_search queries several independent engines and fuses their results with Reciprocal Rank Fusion — prefer it over a single-provider search.',
        'fetch_url converts a page or document (HTML, PDF, DOCX, XLSX, PPTX, EPUB, ODT, CSV, JSON) to clean Markdown and caches it locally.',
        'research does search + fetch + passage extraction in one call and returns a citable Markdown brief; it quotes rather than paraphrases, so write the synthesis yourself.',
        'search_index searches the local cache of everything fetched so far, with no network requests.',
        'Output is Markdown by default because it costs roughly 40% fewer tokens than JSON; pass format:"json" when you need structured data.',
      ].join(' '),
    },
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.schema,
        annotations: tool.annotations,
      },
      async (args: unknown) => {
        try {
          const result = await tool.handler(args as never, services);
          if (result.isError) {
            return { content: [{ type: 'text' as const, text: result.text }], isError: true };
          }
          return {
            content: [{ type: 'text' as const, text: result.text }],
            ...(result.structured ? { structuredContent: result.structured } : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`tool ${tool.name} failed: ${message}`);
          return {
            content: [{ type: 'text' as const, text: `**${tool.name} failed:** ${message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

/** Run over stdio, which is what an MCP client spawns. */
export async function runStdioServer(services: Services, options: { keepAlive?: boolean } = {}): Promise<void> {
  const server = createMcpServer(services);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, shutting down`);
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.connect(transport);
  log.info(`stdio transport ready (${TOOLS.length} tools)`);
  if (options.keepAlive === false) return;
}

export interface HttpServerOptions {
  port: number;
  host: string;
  /** Path that serves MCP. Default `/mcp`. */
  path?: string;
  /** Allowed CORS origins; `*` by default. */
  corsOrigin?: string;
}

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Run over streamable HTTP.
 *
 * `GET /` serves a small status page and `GET /health` returns JSON, so a human
 * can confirm the server is alive without speaking MCP.
 */
export async function runHttpServer(services: Services, options: HttpServerOptions): Promise<RunningHttpServer> {
  const mcpPath = options.path ?? '/mcp';

  const http = createHttpServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${options.host}:${options.port}`}`);
    const cors = {
      'access-control-allow-origin': options.corsOrigin ?? '*',
      'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
      'access-control-allow-headers': 'content-type, accept, mcp-session-id, mcp-protocol-version, authorization',
      'access-control-expose-headers': 'mcp-session-id',
    };
    for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          status: 'ok',
          server: SERVER_NAME,
          version: SERVER_VERSION,
          tools: TOOLS.length,
          transport: 'streamable-http',
          endpoint: mcpPath,
        }),
      );
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
        `<!doctype html><meta charset="utf-8"><title>free-search-mcp-ts</title>
<body style="font-family:ui-sans-serif,system-ui,sans-serif;max-width:44rem;margin:3rem auto;line-height:1.6">
<h1>free-search-mcp-ts</h1>
<p>Running. Model Context Protocol endpoint: <code>${mcpPath}</code> (streamable HTTP, stateless).</p>
<p>${TOOLS.length} tools available: ${TOOLS.map((t) => `<code>${t.name}</code>`).join(', ')}.</p>
<p>Health: <a href="/health"><code>/health</code></a></p>
</body>`,
      );
      return;
    }

    if (url.pathname !== mcpPath) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found', endpoint: mcpPath }));
      return;
    }

    // A fresh server and transport per request is the documented stateless
    // pattern for the streamable HTTP transport. Sharing one transport across
    // requests looks like it works — the first initialize succeeds — but the
    // transport then treats the connection as already initialised and stops
    // answering `tools/list` and `tools/call` correctly. Constructing the
    // server is cheap (tool registration is in-memory), so pay it per request
    // and get correct behaviour.
    const server = createMcpServer(services);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    const cleanup = (): void => {
      void transport.close().catch(() => {});
      void server.close().catch(() => {});
    };
    res.on('close', cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      log.warn(`http request failed: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'internal error' }));
      }
    } finally {
      // For a JSON response the reply is already flushed; for an SSE stream the
      // response's 'close' event drives cleanup instead.
      if (res.writableEnded) cleanup();
    }
  }

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      http.off('error', reject);
      resolve();
    });
  });

  const url = `http://${options.host === '0.0.0.0' ? '127.0.0.1' : options.host}:${options.port}${mcpPath}`;
  log.info(`HTTP transport listening on ${url}`);

  return {
    url,
    async close() {
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Convenience for embedding the server in another process. */
export function createStdioServer(config: Config): McpServer {
  return createMcpServer(createServices(config));
}

/** JSON schema snapshot of every tool, exposed by `free-search-mcp-ts tools --json`. */
export function toolManifest(): Record<string, unknown> {
  return {
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      annotations: tool.annotations,
      inputSchema: safeJsonSchema(tool.schema),
    })),
  };
}

function safeJsonSchema(shape: z.ZodRawShape): unknown {
  try {
    // zod v4 exposes `z.toJSONSchema`; zod v3 does not, so this is a runtime
    // probe rather than a typed call. `tools` output is still useful without it
    // because the argument list is derived from the shape directly.
    const fn = (z as unknown as { toJSONSchema?: (schema: unknown) => unknown }).toJSONSchema;
    if (typeof fn === 'function') return fn(z.object(shape));
    const properties: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const described = field as unknown as { description?: string; isOptional?: () => boolean };
      properties[key] = {
        ...(described.description ? { description: described.description } : {}),
        ...(typeof described.isOptional === 'function' && described.isOptional() ? {} : { required: true }),
      };
    }
    return { type: 'object', properties };
  } catch {
    return undefined;
  }
}
