/**
 * Installer orchestration.
 *
 * `free-search-mcp-ts install` detects which MCP clients exist on this machine,
 * writes the server entry into each one's config (with a backup), and reports
 * exactly what it changed. `uninstall` reverses it. `doctor` verifies that the
 * server can actually reach the network and its engines.
 *
 * Detection is deliberately conservative: a client is only touched when its
 * config file already exists, unless the user names it explicitly.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import {
  CLIENT_SPECS,
  DEFAULT_SERVER_NAME,
  buildEntryShape,
  defaultInstallContext,
  deleteNested,
  getClientSpec,
  getNested,
  pickConfigPath,
  readConfigFile,
  removeTomlServer,
  resolveServerEntry,
  setNested,
  tomlServerBlock,
  upsertTomlServer,
  writeJsonConfig,
  writeTextConfig,
  type ClientSpec,
  type CommandMode,
  type InstallContext,
  type ServerEntry,
} from './clients.js';
import { createLogger } from '../util/logger.js';

const log = createLogger('install');

export interface InstallOptions {
  /** Client ids to target. Empty means "every detected client". */
  clients?: string[];
  /** Server name to register under. Default `free-search-mcp-ts`. */
  name?: string;
  /** How the client should launch the server. */
  mode?: CommandMode;
  /** Explicit command override. */
  command?: string;
  /** Extra arguments when `command` is overridden. */
  args?: string[];
  /** Extra environment variables for the client. */
  env?: Record<string, string>;
  /** Which config file to prefer for clients that have both. */
  scope?: 'auto' | 'workspace' | 'user';
  /** Report what would happen without writing anything. */
  dryRun?: boolean;
  /** Overwrite an existing entry for this server name. */
  force?: boolean;
  /** Include clients whose config file does not exist yet. */
  includeUndetected?: boolean;
  context?: Partial<InstallContext>;
  cliPath?: string;
}

export interface ClientResult {
  id: string;
  label: string;
  configPath: string;
  detected: boolean;
  action: 'installed' | 'updated' | 'already-present' | 'skipped' | 'removed' | 'not-found' | 'manual' | 'failed';
  detail: string;
  backup?: string;
  /** A copy-pasteable snippet, useful when the file is edited by hand. */
  snippet?: string;
}

export interface InstallReport {
  serverName: string;
  entry: ServerEntry;
  results: ClientResult[];
  dryRun: boolean;
}

/** Which clients look present on this machine. */
export function detectClients(context?: Partial<InstallContext>): { spec: ClientSpec; path: string; exists: boolean }[] {
  const ctx = defaultInstallContext(context);
  return CLIENT_SPECS.filter((spec) => !spec.manual).map((spec) => {
    const path = pickConfigPath(spec, ctx);
    return { spec, path, exists: Boolean(path) && existsSync(path) };
  });
}

export function install(options: InstallOptions = {}): InstallReport {
  const ctx = defaultInstallContext(options.context);
  const serverName = options.name ?? DEFAULT_SERVER_NAME;
  const entry = resolveServerEntry({
    ...(options.command ? { command: options.command } : {}),
    ...(options.args ? { args: options.args } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.cliPath ? { cliPath: options.cliPath } : {}),
    platform: ctx.platform,
    sourceEnv: process.env,
  });

  const targets = selectTargets(options, ctx);
  const results: ClientResult[] = [];

  for (const { spec, path } of targets) {
    if (spec.manual) {
      results.push({
        id: spec.id,
        label: spec.label,
        configPath: '',
        detected: true,
        action: 'manual',
        detail: spec.manual,
      });
      continue;
    }
    try {
      results.push(installForClient(spec, path, serverName, entry, options));
    } catch (err) {
      results.push({
        id: spec.id,
        label: spec.label,
        configPath: path,
        detected: existsSync(path),
        action: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { serverName, entry, results, dryRun: options.dryRun ?? false };
}

export function uninstall(options: InstallOptions = {}): InstallReport {
  const ctx = defaultInstallContext(options.context);
  const serverName = options.name ?? DEFAULT_SERVER_NAME;
  const entry = resolveServerEntry({ mode: options.mode ?? 'auto', platform: ctx.platform });
  const targets = selectTargets({ ...options, clients: options.clients ?? [] }, ctx, true);
  const results: ClientResult[] = [];

  for (const { spec, path, exists } of targets) {
    if (spec.manual || !path) continue;
    if (!exists) {
      results.push({
        id: spec.id,
        label: spec.label,
        configPath: path,
        detected: false,
        action: 'skipped',
        detail: 'no config file',
      });
      continue;
    }
    if (spec.shape === 'toml') {
      const state = readConfigFile(spec, path);
      const original = String((state.data as { __toml?: string }).__toml ?? '');
      const updated = removeTomlServer(original, serverName);
      if (updated === original.trimEnd()) {
        results.push({ id: spec.id, label: spec.label, configPath: path, detected: true, action: 'not-found', detail: 'no entry to remove' });
        continue;
      }
      const write = options.dryRun ? undefined : writeTextConfig(path, updated);
      results.push({
        id: spec.id,
        label: spec.label,
        configPath: path,
        detected: true,
        action: 'removed',
        detail: options.dryRun ? 'would remove the entry' : 'entry removed',
        ...(write?.backup ? { backup: write.backup } : {}),
      });
      continue;
    }

    const state = readConfigFile(spec, path);
    if (!getNested(state.data, spec.serversPath)?.[serverName]) {
      results.push({ id: spec.id, label: spec.label, configPath: path, detected: true, action: 'not-found', detail: 'no entry to remove' });
      continue;
    }
    deleteNested(state.data, [...spec.serversPath, serverName]);
    const write = options.dryRun ? undefined : writeJsonConfig(path, state.data);
    results.push({
      id: spec.id,
      label: spec.label,
      configPath: path,
      detected: true,
      action: 'removed',
      detail: options.dryRun ? 'would remove the entry' : 'entry removed',
      ...(write?.backup ? { backup: write.backup } : {}),
    });
  }

  return { serverName, entry, results, dryRun: options.dryRun ?? false };
}

function selectTargets(
  options: InstallOptions,
  ctx: InstallContext,
  forceAll = false,
): { spec: ClientSpec; path: string; exists: boolean }[] {
  const requested = (options.clients ?? []).map((c) => c.toLowerCase()).filter(Boolean);
  const all = detectClients(ctx);

  if (requested.length > 0) {
    const out: { spec: ClientSpec; path: string; exists: boolean }[] = [];
    for (const id of requested) {
      const spec = getClientSpec(id);
      if (!spec) {
        log.warn(`unknown client "${id}" — run \`free-search-mcp-ts install --list\` to see the ids`);
        continue;
      }
      if (spec.manual) {
        out.push({ spec, path: '', exists: false });
        continue;
      }
      const path = pickConfigPath(spec, ctx, options.scope ?? 'auto');
      out.push({ spec, path, exists: existsSync(path) });
    }
    return out;
  }

  const detected = all.filter((entry) => entry.exists);
  if (detected.length > 0 && !forceAll) return detected;
  if (forceAll) return all;
  if (options.includeUndetected) {
    return all.filter((entry) => !entry.spec.manual);
  }
  return [];
}

function installForClient(
  spec: ClientSpec,
  path: string,
  serverName: string,
  entry: ServerEntry,
  options: InstallOptions,
): ClientResult {
  const shaped = buildEntryShape(spec, serverName, entry);
  const snippet = `${JSON.stringify({ [spec.serversPath.join('.')]: { [serverName]: shaped } }, null, 2)}`;

  if (spec.shape === 'toml') {
    const state = readConfigFile(spec, path);
    const original = String((state.data as { __toml?: string }).__toml ?? '');
    const hadEntry = new RegExp(`\\[\\s*mcp_servers\\s*\\.\\s*${serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`).test(original);
    if (hadEntry && !options.force) {
      return {
        id: spec.id,
        label: spec.label,
        configPath: path,
        detected: state.exists,
        action: 'already-present',
        detail: 'an entry with this name already exists (use --force to overwrite)',
        snippet,
      };
    }
    if (options.dryRun) {
      return {
        id: spec.id,
        label: spec.label,
        configPath: path,
        detected: state.exists,
        action: hadEntry ? 'updated' : 'installed',
        detail: 'dry run — nothing written',
        snippet,
      };
    }
    const updated = upsertTomlServer(original, serverName, tomlServerBlock(serverName, entry));
    const write = writeTextConfig(path, updated);
    return {
      id: spec.id,
      label: spec.label,
      configPath: path,
      detected: state.exists,
      action: hadEntry ? 'updated' : 'installed',
      detail: `wrote [mcp_servers.${serverName}]`,
      ...(write.backup ? { backup: write.backup } : {}),
      snippet,
    };
  }

  const state = readConfigFile(spec, path);
  if (state.error) {
    return {
      id: spec.id,
      label: spec.label,
      configPath: path,
      detected: state.exists,
      action: 'failed',
      detail: `could not parse the existing config (${state.error}); fix it by hand or move it aside`,
      snippet,
    };
  }

  const existing = getNested(state.data, spec.serversPath)?.[serverName];
  const identical = existing !== undefined && JSON.stringify(existing) === JSON.stringify(shaped);
  if (identical) {
    return {
      id: spec.id,
      label: spec.label,
      configPath: path,
      detected: state.exists,
      action: 'already-present',
      detail: 'entry is already present and identical',
      snippet,
    };
  }
  if (existing !== undefined && !options.force) {
    return {
      id: spec.id,
      label: spec.label,
      configPath: path,
      detected: state.exists,
      action: 'already-present',
      detail: 'an entry with this name already exists and differs (use --force to overwrite)',
      snippet,
    };
  }

  if (options.dryRun) {
    return {
      id: spec.id,
      label: spec.label,
      configPath: path,
      detected: state.exists,
      action: existing !== undefined ? 'updated' : 'installed',
      detail: state.hadComments
        ? 'dry run — nothing written (note: this file contains comments, which a rewrite would normalise)'
        : 'dry run — nothing written',
      snippet,
    };
  }

  setNested(state.data, [...spec.serversPath, serverName], shaped);
  const write = writeJsonConfig(path, state.data);
  return {
    id: spec.id,
    label: spec.label,
    configPath: path,
    detected: state.exists,
    action: existing !== undefined ? 'updated' : 'installed',
    detail: `wrote ${spec.serversPath.join('.')}.${serverName}${state.hadComments ? ' (comments in the previous file were normalised; see the .bak)' : ''}`,
    ...(write.backup ? { backup: write.backup } : {}),
    snippet,
  };
}

/** Compact human-readable report for the CLI. */
export function formatInstallReport(report: InstallReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? '# Dry run — nothing was written' : '# MCP client registration');
  lines.push('');
  lines.push(`Server name: \`${report.serverName}\``);
  lines.push(`Launch command: \`${report.entry.command} ${report.entry.args.join(' ')}\``);
  if (Object.keys(report.entry.env).length) {
    lines.push(`Forwarded environment: ${Object.keys(report.entry.env).join(', ')}`);
  }
  lines.push('');

  if (report.results.length === 0) {
    lines.push('No MCP clients were detected on this machine.');
    lines.push('');
    lines.push('Point the installer at one explicitly, for example:');
    lines.push('');
    lines.push('```bash');
    lines.push('npx -y free-search-mcp-ts install --client claude-desktop');
    lines.push('npx -y free-search-mcp-ts install --client cursor');
    lines.push('```');
    lines.push('');
    lines.push('Run `npx -y free-search-mcp-ts install --list` to see every supported client id.');
    return lines.join('\n');
  }

  lines.push('| Client | Status | Config file |');
  lines.push('|--------|--------|-------------|');
  for (const result of report.results) {
    const icon =
      result.action === 'installed' ? '✅ installed'
      : result.action === 'updated' ? '🔄 updated'
      : result.action === 'already-present' ? '✔︎ already present'
      : result.action === 'removed' ? '🗑 removed'
      : result.action === 'failed' ? '✗ failed'
      : result.action === 'manual' ? 'ℹ︎ manual'
      : '– skipped';
    lines.push(`| ${result.label} | ${icon} | ${result.configPath ? `\`${result.configPath}\`` : '—'} |`);
  }
  lines.push('');

  const notable = report.results.filter((r) => r.action === 'failed' || r.action === 'manual' || r.backup);
  for (const result of notable) {
    lines.push(`**${result.label}** — ${result.detail}`);
    if (result.backup) lines.push(`Backup written to \`${result.backup}\`.`);
    lines.push('');
  }

  const specsById = new Map(CLIENT_SPECS.map((spec) => [spec.id, spec]));
  const notes = report.results
    .map((result) => specsById.get(result.id)?.note)
    .filter((note): note is string => Boolean(note));
  if (notes.length) {
    lines.push('## Next steps');
    lines.push('');
    for (const note of [...new Set(notes)]) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('## Verify');
  lines.push('');
  lines.push('```bash');
  lines.push('npx -y free-search-mcp-ts doctor      # check engines, network and cache');
  lines.push('npx -y free-search-mcp-ts search "model context protocol"   # try a real search');
  lines.push('```');
  return lines.join('\n');
}
