/**
 * Minimal structured logger.
 *
 * MCP servers speak JSON-RPC over stdout, so *nothing* may ever be written to
 * stdout outside the protocol. Every diagnostic therefore goes to stderr, and
 * the level is configurable so an interactive CLI run can be chatty while a
 * client-launched server stays quiet.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = 'warn';

export function setLogLevel(level: LogLevel | string | undefined): void {
  if (!level) return;
  const normalized = String(level).toLowerCase() as LogLevel;
  if (normalized in LEVELS) currentLevel = normalized;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function isLevelEnabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVELS[currentLevel] >= LEVELS[level];
}

function emit(level: Exclude<LogLevel, 'silent'>, scope: string, message: string, extra?: unknown): void {
  if (!isLevelEnabled(level)) return;
  const stamp = new Date().toISOString();
  const head = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${scope}: ${message}`;
  if (extra === undefined) {
    process.stderr.write(`${head}\n`);
    return;
  }
  let rendered: string;
  if (extra instanceof Error) {
    rendered = extra.stack || `${extra.name}: ${extra.message}`;
  } else {
    try {
      rendered = JSON.stringify(extra);
    } catch {
      rendered = String(extra);
    }
  }
  process.stderr.write(`${head} ${rendered}\n`);
}

export interface Logger {
  error(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  debug(message: string, extra?: unknown): void;
  child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    error: (m, e) => emit('error', scope, m, e),
    warn: (m, e) => emit('warn', scope, m, e),
    info: (m, e) => emit('info', scope, m, e),
    debug: (m, e) => emit('debug', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}
