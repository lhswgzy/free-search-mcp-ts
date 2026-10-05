/**
 * HTTP layer.
 *
 * One place that owns: proxy/dispatcher setup, browser-like headers, timeouts,
 * bounded retries with jitter, response size caps and the SSRF guard. Engines
 * and the fetcher both go through here so that behaviour (and the knobs that
 * control it) stay identical everywhere.
 */

import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { Config } from './config.js';
import { createLogger } from './util/logger.js';

const log = createLogger('http');

/** A small pool of current desktop UA strings; rotated per request. */
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

export const DEFAULT_USER_AGENT = USER_AGENTS[0]!;

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  /** Per-attempt timeout. Falls back to config.timeoutMs. */
  timeoutMs?: number;
  /** Number of *extra* attempts after the first. Falls back to config.retries. */
  retries?: number;
  /** Hard cap on the number of body bytes read. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Force a specific User-Agent (e.g. Google News RSS wants a feed reader). */
  userAgent?: string;
  /** Disable UA rotation for this request. */
  fixedUserAgent?: boolean;
  /** Accept header override. */
  accept?: string;
  /** Extra `Referer` header. */
  referer?: string;
  /** Treat these status codes as success (no retry). */
  acceptStatuses?: number[];
  /** Skip the SSRF guard (used for local fixtures in tests). */
  allowPrivate?: boolean;
  /** Return the raw bytes rather than decoding as UTF-8. */
  binary?: boolean;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  url: string;
  headers: Headers;
  body: string;
  bytes: Uint8Array;
  /** Wall-clock duration of the successful attempt. */
  elapsedMs: number;
  attempts: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly bodyPreview?: string;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; url: string; bodyPreview?: string; retryable?: boolean; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'HttpError';
    this.status = opts.status ?? 0;
    this.url = opts.url;
    this.bodyPreview = opts.bodyPreview;
    this.retryable = opts.retryable ?? false;
  }
}

export class BlockedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`Refusing to fetch ${url}: ${reason}`);
    this.name = 'BlockedUrlError';
  }
}

let requestCounter = 0;
let sharedDispatcher: Dispatcher | undefined;
let dispatcherProxy: string | undefined;

/** Build (and memoise) the undici dispatcher, honouring the proxy setting. */
export function getDispatcher(config: Config): Dispatcher {
  if (sharedDispatcher && dispatcherProxy === config.proxy) return sharedDispatcher;

  if (config.proxy) {
    sharedDispatcher = new ProxyAgent({
      uri: config.proxy,
      requestTls: { rejectUnauthorized: false },
      proxyTls: { rejectUnauthorized: false },
    });
    dispatcherProxy = config.proxy;
    log.info(`using proxy ${config.proxy}`);
  } else {
    sharedDispatcher = new Agent({
      connect: { timeout: Math.min(config.timeoutMs, 10_000) },
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: Math.max(8, config.concurrency * 2),
    });
    dispatcherProxy = undefined;
  }
  return sharedDispatcher;
}

export function resetDispatcher(): void {
  sharedDispatcher = undefined;
  dispatcherProxy = undefined;
}

/** Rotate user agents deterministically-ish so tests can pin one. */
export function pickUserAgent(config: Config, index?: number): string {
  if (config.userAgent) return config.userAgent;
  if (!config.rotateUserAgent) return DEFAULT_USER_AGENT;
  const i = index ?? requestCounter++;
  return USER_AGENTS[i % USER_AGENTS.length]!;
}

/** Realistic browser headers; engines are much friendlier when these are present. */
export function browserHeaders(url: string, userAgent: string, accept?: string, referer?: string): Record<string, string> {
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    /* ignore */
  }
  const headers: Record<string, string> = {
    'user-agent': userAgent,
    accept: accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
    'upgrade-insecure-requests': '1',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': referer ? 'same-origin' : 'none',
    'sec-fetch-user': '?1',
    dnt: '1',
  };
  if (referer) {
    headers.referer = referer;
  } else if (origin) {
    headers.referer = `${origin}/`;
  }
  return headers;
}

/** Interpret a `Retry-After` header (seconds or HTTP-date). */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 15_000));
  return undefined;
}

function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true; // unique local IPv6
  if (/^fe80:/i.test(h)) return true; // link-local IPv6
  return false;
}

/**
 * The SSRF guard.
 *
 * `fetch_url` is model-driven, so without this an agent can be talked into
 * reading `http://169.254.169.254/` or an intranet host. Private targets are
 * refused unless the operator opts in with FREE_SEARCH_ALLOW_PRIVATE=1.
 */
export function assertFetchable(url: string, config: Config, allowPrivate?: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new BlockedUrlError(url, 'not a valid absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new BlockedUrlError(url, `unsupported scheme "${u.protocol}"`);
  }
  const allowed = allowPrivate ?? config.allowPrivateHosts;
  if (!allowed && isPrivateHostname(u.hostname)) {
    throw new BlockedUrlError(url, 'private/loopback address (set FREE_SEARCH_ALLOW_PRIVATE=1 to allow)');
  }
}

export interface HttpClient {
  readonly config: Config;
  request(url: string, options?: HttpRequestOptions): Promise<HttpResponse>;
  getText(url: string, options?: HttpRequestOptions): Promise<string>;
  getJson<T = unknown>(url: string, options?: HttpRequestOptions): Promise<T>;
  postForm(url: string, form: Record<string, string>, options?: HttpRequestOptions): Promise<HttpResponse>;
}

export function createHttpClient(config: Config): HttpClient {
  async function attempt(url: string, options: HttpRequestOptions): Promise<HttpResponse> {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    const userAgent = options.userAgent ?? pickUserAgent(config);
    const headers: Record<string, string> =
      options.accept === 'application/json' || options.accept?.includes('json')
        ? {
            'user-agent': userAgent,
            accept: options.accept!,
            'accept-language': 'en-US,en;q=0.9',
          }
        : browserHeaders(url, userAgent, options.accept, options.referer);

    if (method === 'POST') {
      headers['content-type'] = headers['content-type'] ?? 'application/x-www-form-urlencoded';
    }
    Object.assign(headers, options.headers ?? {});

    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);

    const started = Date.now();
    const res = await undiciFetch(url, {
      method,
      headers,
      body: options.body,
      redirect: 'follow',
      signal,
      dispatcher: getDispatcher(config),
    } as Parameters<typeof undiciFetch>[1]);

    const maxBytes = options.maxBytes ?? config.maxFetchBytes;
    const bytes = await readCapped(res, maxBytes);

    return {
      status: res.status,
      ok: res.ok,
      url: res.url || url,
      headers: res.headers as unknown as Headers,
      body: options.binary ? '' : new TextDecoder('utf-8', { fatal: false }).decode(bytes),
      bytes,
      elapsedMs: Date.now() - started,
      attempts: 1,
    };
  }

  async function request(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
    assertFetchable(url, config, options.allowPrivate);

    const retries = options.retries ?? config.retries;
    const acceptStatuses = new Set(options.acceptStatuses ?? []);
    let lastError: unknown;

    for (let i = 0; i <= retries; i++) {
      try {
        const res = await attempt(url, options);
        const ok = res.ok || acceptStatuses.has(res.status);
        if (ok) {
          return { ...res, attempts: i + 1 };
        }

        const retryable = res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
        const preview = res.body.slice(0, 300).replace(/\s+/g, ' ');
        const error = new HttpError(`HTTP ${res.status} for ${url}`, {
          status: res.status,
          url,
          bodyPreview: preview,
          retryable,
        });
        if (!retryable || i === retries) throw error;

        const retryAfter = parseRetryAfter(res.headers?.get?.('retry-after') ?? null);
        const backoff = retryAfter ?? Math.min(400 * 2 ** i + Math.random() * 250, 6000);
        log.debug(`retry ${i + 1}/${retries} in ${Math.round(backoff)}ms after HTTP ${res.status} ${url}`);
        await sleep(backoff, options.signal);
      } catch (err) {
        lastError = err;
        const isHttp = err instanceof HttpError;
        if (isHttp && !err.retryable) throw err;
        if (isHttp && i === retries) throw err;

        // Network-level failure: DNS, TLS, reset, timeout.
        const message = err instanceof Error ? err.message : String(err);
        const cause = (err as { cause?: { code?: string } })?.cause?.code;
        const aborted = (err as Error)?.name === 'AbortError' || (err as Error)?.name === 'TimeoutError';
        if (options.signal?.aborted) throw err;

        // Fatal transport errors are not transient: retrying a blocked or
        // unroutable host just doubles the latency before the caller can move on
        // to another engine. This is the difference between a 20-second search
        // and a 10-second one on a network that blocks a provider outright.
        const fatal =
          !!cause &&
          /^(?:ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS_RESOLVE_FAILED|UND_ERR_SOCKET|CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN)/.test(
            cause,
          );
        if (fatal || i === retries) {
          throw new HttpError(`Request failed for ${url}: ${message}${cause ? ` (${cause})` : ''}`, {
            url,
            retryable: false,
            cause: err,
          });
        }

        const backoff = Math.min(400 * 2 ** i + Math.random() * 250, aborted ? 1500 : 6000);
        log.debug(`retry ${i + 1}/${retries} in ${Math.round(backoff)}ms after ${message}`);
        await sleep(backoff, options.signal);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new HttpError(`Request failed for ${url}`, { url, retryable: false });
  }

  return {
    config,
    request,
    async getText(url, options) {
      return (await request(url, options)).body;
    },
    async getJson<T>(url: string, options?: HttpRequestOptions): Promise<T> {
      const res = await request(url, { accept: 'application/json', ...options });
      const text = res.body.trim();
      // A few APIs (StackExchange, Google) guard against JSON hijacking.
      const cleaned = text.startsWith(')') || text.startsWith("while(1);") ? text.replace(/^[^{[]*/, '') : text;
      try {
        return JSON.parse(cleaned) as T;
      } catch (err) {
        throw new HttpError(`Invalid JSON from ${url}: ${(err as Error).message}`, {
          url,
          status: res.status,
          bodyPreview: text.slice(0, 200),
        });
      }
    },
    async postForm(url, form, options) {
      const body = new URLSearchParams(form).toString();
      return request(url, { ...options, method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded', ...options?.headers } });
    },
  };
}

/** Read a response body while enforcing a hard byte cap. */
async function readCapped(res: { body: ReadableStream<Uint8Array> | null; arrayBuffer(): Promise<ArrayBuffer> }, maxBytes: number): Promise<Uint8Array> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // Partial body is still useful (e.g. server closed mid-stream).
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= out.length) break;
    const slice = chunk.byteLength > out.length - offset ? chunk.subarray(0, out.length - offset) : chunk;
    out.set(slice, offset);
    offset += slice.byteLength;
  }
  return out;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run tasks with a concurrency cap, preserving input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}
