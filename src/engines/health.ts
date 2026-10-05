/**
 * Engine health tracking (circuit breaker).
 *
 * A blocked or dead engine must not cost every future query a full timeout.
 * After `engineFailureThreshold` consecutive failures an engine is benched for
 * `engineCooldownMs`; while benched it is skipped without a request, and a
 * single success closes the breaker again.
 *
 * This is what makes the default configuration usable on a network where one or
 * two providers are unreachable: the first query pays the timeout, every later
 * query does not.
 */

import type { EngineHealth } from '../types.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('health');

export interface HealthRecord {
  engine: string;
  consecutiveFailures: number;
  totalCalls: number;
  totalFailures: number;
  totalResults: number;
  /** Epoch ms until which the engine is benched. 0 when healthy. */
  benchedUntil: number;
  lastError?: string;
  lastLatencyMs?: number;
  lastSuccessAt?: number;
  /** True when the last failure was classified as a block/captcha. */
  lastWasBlock?: boolean;
  /** How the last failure was classified; drives the bench policy. */
  lastFailureKind?: FailureKind;
}

/**
 * Failure classes, because they deserve different policies:
 *
 *   - `blocked`     — the provider decided to refuse us (403/429/captcha). One
 *                     occurrence benches the engine for the full cooldown;
 *                     retrying a deliberate refusal only risks a harder block.
 *   - `unreachable` — the host cannot be connected to at all (DNS failure,
 *                     connection refused, connect timeout). On a network that
 *                     filters a provider this is deterministic, not a blip, and
 *                     waiting for it on every single search is the difference
 *                     between a 10-second search and a 1-second one. Benched
 *                     after one occurrence, for a shorter window than a block.
 *   - `other`       — a read timeout, a parse failure, a 5xx. Might be
 *                     transient, so it takes `failureThreshold` occurrences.
 */
export type FailureKind = 'blocked' | 'unreachable' | 'other';

const BLOCKED_RE = /blocked|captcha|challenge|\b429\b|\b403\b|forbidden|automated|consent|rate.?limit/i;
const UNREACHABLE_RE =
  /ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_DNS|UND_ERR_SOCKET|CERT_|ERR_TLS|UNABLE_TO_VERIFY|SELF_SIGNED/i;

export function classifyFailure(message: string): FailureKind {
  if (BLOCKED_RE.test(message)) return 'blocked';
  if (UNREACHABLE_RE.test(message)) return 'unreachable';
  return 'other';
}

export interface HealthTrackerOptions {
  failureThreshold: number;
  cooldownMs: number;
  /**
   * Optional persistence so the breaker survives a process restart.
   *
   * Without it, a client that restarts the MCP server (or a user running the
   * CLI twice) re-pays the full timeout on a provider that is blocked on this
   * network — which is exactly the network where this matters most.
   */
  persistence?: HealthPersistence;
}

export interface HealthPersistence {
  load(): HealthRecord[];
  save(records: readonly HealthRecord[]): void;
}

export class EngineHealthTracker {
  private records = new Map<string, HealthRecord>();
  private lastSaveAt = 0;

  constructor(private readonly options: HealthTrackerOptions) {
    const restored = options.persistence?.load() ?? [];
    for (const record of restored) {
      this.records.set(record.engine, { lastWasBlock: false, ...record });
    }
    if (restored.length > 0) {
      const benched = restored.filter((r) => r.benchedUntil > Date.now());
      if (benched.length > 0) {
        log.debug(`restored breaker state: ${benched.map((r) => r.engine).join(', ')} still benched`);
      }
    }
  }

  /**
   * Persist on change, throttled so a burst of engine failures costs one write
   * rather than one per engine. A change to the bench set always writes
   * immediately, because that is the state worth surviving a restart.
   */
  private persist(force = false): void {
    const persistence = this.options.persistence;
    if (!persistence) return;
    const now = Date.now();
    if (!force && now - this.lastSaveAt < 500) return;
    this.lastSaveAt = now;
    try {
      persistence.save([...this.records.values()]);
    } catch (err) {
      log.debug(`could not persist breaker state: ${(err as Error).message}`);
    }
  }

  private record(engine: string): HealthRecord {
    let r = this.records.get(engine);
    if (!r) {
      r = {
        engine,
        consecutiveFailures: 0,
        totalCalls: 0,
        totalFailures: 0,
        totalResults: 0,
        benchedUntil: 0,
      };
      this.records.set(engine, r);
    }
    return r;
  }

  isBenched(engine: string, now = Date.now()): boolean {
    const r = this.records.get(engine);
    if (!r) return false;
    return r.benchedUntil > now;
  }

  /** Remaining bench time in ms, 0 when the engine is usable. */
  benchRemainingMs(engine: string, now = Date.now()): number {
    const r = this.records.get(engine);
    if (!r) return 0;
    return Math.max(0, r.benchedUntil - now);
  }

  recordSuccess(engine: string, resultCount: number, latencyMs: number): void {
    const r = this.record(engine);
    const wasBenched = r.benchedUntil > 0;
    r.consecutiveFailures = 0;
    r.benchedUntil = 0;
    r.totalCalls++;
    r.totalResults += resultCount;
    r.lastLatencyMs = latencyMs;
    r.lastSuccessAt = Date.now();
    r.lastError = undefined;
    r.lastWasBlock = false;
    this.persist(wasBenched);
  }

  recordFailure(engine: string, error: unknown, latencyMs?: number): void {
    const r = this.record(engine);
    r.consecutiveFailures++;
    r.totalCalls++;
    r.totalFailures++;
    r.lastError = error instanceof Error ? error.message : String(error);
    if (latencyMs !== undefined) r.lastLatencyMs = latencyMs;

    const kind = classifyFailure(r.lastError);
    r.lastFailureKind = kind;
    r.lastWasBlock = kind === 'blocked';

    const { threshold, cooldownMs } = this.policyFor(kind);
    let benchedNow = false;
    if (r.consecutiveFailures >= threshold) {
      const wasBenched = r.benchedUntil > Date.now();
      r.benchedUntil = Date.now() + cooldownMs;
      benchedNow = !wasBenched;
      log.debug(
        `${engine} benched for ${Math.round(cooldownMs / 1000)}s (${kind}) after ${r.consecutiveFailures} failure(s): ${r.lastError}`,
      );
    }
    this.persist(benchedNow);
  }

  /** Bench policy per failure class. See `FailureKind` for the reasoning. */
  private policyFor(kind: FailureKind): { threshold: number; cooldownMs: number } {
    switch (kind) {
      case 'blocked':
        return { threshold: 1, cooldownMs: this.options.cooldownMs };
      case 'unreachable':
        // Shorter than a block: the network path may come back (a VPN connects,
        // a proxy starts), and we want to notice that reasonably soon.
        return { threshold: 1, cooldownMs: Math.min(this.options.cooldownMs, 5 * 60 * 1000) };
      default:
        return { threshold: Math.max(1, this.options.failureThreshold), cooldownMs: this.options.cooldownMs };
    }
  }

  /** Health rows for `list_engines` / `doctor`, one per known engine. */
  snapshot(engines: readonly string[]): EngineHealth[] {
    const now = Date.now();
    return engines.map((engine) => {
      const r = this.records.get(engine);
      const benched = r ? r.benchedUntil > now : false;
      return {
        engine,
        ok: r ? r.consecutiveFailures === 0 && !benched : true,
        latencyMs: r?.lastLatencyMs ?? 0,
        results: r?.totalResults ?? 0,
        ...(r?.lastError ? { error: r.lastError } : {}),
        ...(benched ? { skipped: true } : {}),
      };
    });
  }

  /** Full records for a `doctor` style dump. */
  detailed(): (HealthRecord & { benchedRemainingMs: number })[] {
    const now = Date.now();
    return [...this.records.values()].map((r) => ({
      ...r,
      benchedRemainingMs: Math.max(0, r.benchedUntil - now),
    }));
  }

  reset(engine?: string): void {
    if (engine) this.records.delete(engine);
    else this.records.clear();
    this.persist(true);
  }
}

let shared: EngineHealthTracker | undefined;

export function getHealthTracker(options: HealthTrackerOptions): EngineHealthTracker {
  if (!shared) shared = new EngineHealthTracker(options);
  else {
    // Keep the tracker but honour changed configuration.
    (shared as unknown as { options: HealthTrackerOptions }).options = options;
  }
  return shared;
}

export function resetHealthTracker(): void {
  shared = undefined;
}
