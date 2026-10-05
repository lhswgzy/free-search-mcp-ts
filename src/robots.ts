/**
 * robots.txt handling for the `fetch_url` tool.
 *
 * Search-engine style crawling is not what this does — a model asked to read a
 * page is closer to a user opening a tab — but the polite default is to honour
 * `Disallow` for the specific paths we are about to read. `FREE_SEARCH_RESPECT_ROBOTS=0`
 * turns it off. Failures to retrieve robots.txt are treated as "allowed".
 */

import type { Config } from './config.js';
import type { HttpClient } from './http.js';
import { createLogger } from './util/logger.js';

const log = createLogger('robots');

export interface RobotsRule {
  allow: boolean;
  /** Path pattern; `*` is a wildcard, `$` anchors the end. */
  pattern: string;
}

export interface RobotsEntry {
  rules: RobotsRule[];
  crawlDelayMs?: number;
  fetchedAt: number;
  /** True when robots.txt was missing or unreadable. */
  missing: boolean;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export function parseRobotsTxt(text: string, userAgent = '*'): RobotsEntry {
  const lines = text.split(/\r?\n/);
  const groups: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number }[] = [];
  let current: { agents: string[]; rules: RobotsRule[]; crawlDelay?: number } | undefined;
  let lastWasAgent = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) {
      current = { agents: ['*'], rules: [] };
      groups.push(current);
    }
    if (field === 'disallow') {
      current.rules.push({ allow: false, pattern: value });
    } else if (field === 'allow') {
      current.rules.push({ allow: true, pattern: value });
    } else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = Math.min(seconds, 30) * 1000;
    }
  }

  const ua = userAgent.toLowerCase();
  // Prefer the most specific matching group; `*` is the final fallback.
  const scoreGroup = (agents: string[]): number => {
    let best = -1;
    for (const a of agents) {
      if (a === '*') best = Math.max(best, 0);
      else if (ua.includes(a) || a.includes(ua)) best = Math.max(best, a.length + 1);
    }
    return best;
  };

  let chosen: (typeof groups)[number] | undefined;
  let chosenScore = -1;
  for (const g of groups) {
    const score = scoreGroup(g.agents);
    if (score > chosenScore) {
      chosen = g;
      chosenScore = score;
    }
  }

  return {
    rules: chosen?.rules ?? [],
    crawlDelayMs: chosen?.crawlDelay,
    fetchedAt: Date.now(),
    missing: groups.length === 0,
  };
}

/** Longest-match wins; `Allow` beats `Disallow` on an equal-length match. */
export function isPathAllowed(entry: RobotsEntry, path: string): boolean {
  if (entry.missing || entry.rules.length === 0) return true;
  let bestLen = -1;
  let allowed = true;
  for (const rule of entry.rules) {
    if (rule.pattern === '') {
      // "Disallow:" with an empty value means "allow everything".
      if (!rule.allow && bestLen < 0) {
        bestLen = 0;
        allowed = true;
      }
      continue;
    }
    if (matchPattern(rule.pattern, path)) {
      const len = rule.pattern.replace(/[*$]/g, '').length;
      if (len > bestLen || (len === bestLen && rule.allow)) {
        bestLen = len;
        allowed = rule.allow;
      }
    }
  }
  return allowed;
}

function matchPattern(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
  } catch {
    return false;
  }
}

export class RobotsCache {
  private entries = new Map<string, RobotsEntry>();
  private inflight = new Map<string, Promise<RobotsEntry>>();

  constructor(
    private readonly http: HttpClient,
    private readonly config: Config,
    private readonly userAgent: string,
  ) {}

  async get(origin: string): Promise<RobotsEntry> {
    const key = origin.replace(/\/+$/, '');
    const hit = this.entries.get(key);
    if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) return hit;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const promise = (async (): Promise<RobotsEntry> => {
      try {
        const text = await this.http.getText(`${key}/robots.txt`, {
          accept: 'text/plain,*/*',
          timeoutMs: Math.min(this.config.timeoutMs, 8000),
          retries: 0,
          maxBytes: 512 * 1024,
          acceptStatuses: [401, 403],
        });
        const entry = parseRobotsTxt(text, this.userAgent);
        this.entries.set(key, entry);
        return entry;
      } catch (err) {
        log.debug(`robots.txt unavailable for ${key}: ${(err as Error).message}`);
        const entry: RobotsEntry = { rules: [], fetchedAt: Date.now(), missing: true };
        this.entries.set(key, entry);
        return entry;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /** Returns a reason string when the URL must not be fetched. */
  async check(url: string, opts: { respect?: boolean } = {}): Promise<{ allowed: boolean; reason?: string; crawlDelayMs?: number }> {
    const respect = opts.respect ?? this.config.respectRobots;
    if (!respect) return { allowed: true };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { allowed: true };
    }
    const entry = await this.get(`${u.protocol}//${u.host}`);
    const path = `${u.pathname}${u.search}`;
    const allowed = isPathAllowed(entry, path);
    return {
      allowed,
      reason: allowed ? undefined : `robots.txt disallows ${path} on ${u.host}`,
      crawlDelayMs: entry.crawlDelayMs,
    };
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
