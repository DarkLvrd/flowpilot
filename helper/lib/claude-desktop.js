// Wiring Flow Pilot into Claude Desktop's own config (`flowpilot install-claude`). The config is
// shared with every other MCP server the person uses, so this only ever touches the `flowpilot`
// entry: other servers, `preferences` and anything else are carried through untouched, a malformed
// `mcpServers` block is refused rather than replaced, and the existing file is copied to a timestamped
// backup first. The command is this Node binary by absolute path, because Claude Desktop does not
// inherit the shell PATH and a bare "node" often is not found.

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'flowpilot';
export const MIN_NODE_MAJOR = 20;
export const NODE_URL = 'https://nodejs.org';
const BIN = fileURLToPath(new URL('../bin/flowpilot.js', import.meta.url));

export function defaultConfigPath({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (env.FLOWPILOT_CLAUDE_CONFIG) return env.FLOWPILOT_CLAUDE_CONFIG;
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

// The `mcpServers.flowpilot` block. A custom helper home or port is passed through, since Claude
// Desktop starts the server with its own environment, not the shell's.
export function buildServerEntry({ script = BIN, node = process.execPath, env = {} } = {}) {
  const entry = { command: node, args: [script, 'mcp'] };
  const pass = {};
  if (env.FLOWPILOT_HOME) pass.FLOWPILOT_HOME = env.FLOWPILOT_HOME;
  if (env.FLOWPILOT_PORT) pass.FLOWPILOT_PORT = env.FLOWPILOT_PORT;
  if (Object.keys(pass).length) entry.env = pass;
  return entry;
}

// Clear message when the Node the config would run is missing or too old, instead of a broken server
// in Claude.
export function checkNode({ execPath = process.execPath, version = process.versions.node, min = MIN_NODE_MAJOR } = {}) {
  const major = Number(String(version).split('.')[0]);
  if (!execPath) throw new Error(`I could not find the Node.js program to run the server. Install Node.js ${min} or newer from ${NODE_URL} and run this again.`);
  if (!Number.isFinite(major) || major < min) throw new Error(`Node.js ${version} is too old: Flow Pilot needs Node.js ${min} or newer. Install it from ${NODE_URL} and run this again.`);
  return execPath;
}

// Pure merge: returns the next config plus what the `flowpilot` entry was, and never mutates the input.
export function mergeServerEntry(config, entry, name = SERVER_NAME) {
  if (config == null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('The Claude Desktop config is not a JSON object; refusing to change it.');
  }
  const servers = config.mcpServers;
  if (servers !== undefined && (servers === null || typeof servers !== 'object' || Array.isArray(servers))) {
    throw new Error('The "mcpServers" block in the Claude Desktop config is not an object; refusing to overwrite it.');
  }
  const previous = servers?.[name] ?? null;
  return {
    config: { ...config, mcpServers: { ...(servers ?? {}), [name]: entry } },
    previous,
    entry,
    changed: JSON.stringify(previous) !== JSON.stringify(entry),
  };
}

// Read-only look at an existing config: does `mcpServers.flowpilot` point at this install?
export function inspectConfig({ file, entry, name = SERVER_NAME } = {}) {
  if (!existsSync(file)) return { file, present: false, ok: false, reason: 'missing' };
  let config;
  try { config = JSON.parse(readFileSync(file, 'utf8')); } catch { return { file, present: true, ok: false, reason: 'unreadable' }; }
  const current = config?.mcpServers?.[name] ?? null;
  if (!current) return { file, present: true, ok: false, reason: 'no-server', current: null };
  const same = current.command === entry?.command && JSON.stringify(current.args) === JSON.stringify(entry?.args);
  return { file, present: true, ok: same, reason: same ? 'ok' : 'different', current };
}

export function installClaudeDesktop({ file, entry = buildServerEntry(), name = SERVER_NAME, now = () => new Date() } = {}) {
  const existed = existsSync(file);
  let config = {};
  if (existed) {
    try { config = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      throw new Error(`${file} is not valid JSON (${e.message}); fix or move it aside and run this again.`);
    }
  }
  const merged = mergeServerEntry(config, entry, name);
  if (!merged.changed) return { file, backup: null, changed: false, previous: merged.previous, entry };
  let backup = null;
  if (existed) {
    backup = `${file}.bak-${stamp(now())}`;
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(merged.config, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600); // an older file keeps its old mode otherwise
  return { file, backup, changed: true, previous: merged.previous, entry };
}

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
