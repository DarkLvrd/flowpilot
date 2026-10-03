// A small client for the helper's HTTP API, shared by the CLI and the MCP server.

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HELPER_PORT } from '../../extension/lib/bridge.js';

// Where the helper keeps its files: agents.json (key hashes) and key (this machine's CLI key).
export function paths(env = process.env) {
  const home = env.FLOWPILOT_HOME || join(homedir(), '.flowpilot');
  return { home, agents: join(home, 'agents.json'), key: join(home, 'key'), extension: join(home, 'extension.json'), port: Number(env.FLOWPILOT_PORT || HELPER_PORT) };
}

export function readKey(p) {
  try { return readFileSync(p.key, 'utf8').trim() || null; } catch { return null; }
}

export function saveKey(p, key) {
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  writeFileSync(p.key, `${key}\n`, { mode: 0o600 });
  chmodSync(p.key, 0o600); // an older file keeps its old mode otherwise
}

export function createClient({ port, key }) {
  const base = `http://127.0.0.1:${port}`;
  // `key` may be a function so a long-lived server (the MCP one) picks up a key paired after it started.
  const keyOf = () => (typeof key === 'function' ? key() : key);
  async function call(method, path, body) {
    const bearer = keyOf();
    let res;
    try {
      res = await fetch(base + path, {
        method,
        headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(40_000),
      });
    } catch {
      throw new Error(`The Flow Pilot helper is not running on 127.0.0.1:${port}: start it with \`npx flowpilot serve\``);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }
  return {
    health: () => call('GET', '/health'),
    pair: (code, name) => call('POST', '/pair', { code, name }).then((r) => r.key),
    status: () => call('GET', '/status'),
    job: (id) => call('GET', `/jobs/${encodeURIComponent(id)}`),
    add: (spec) => call('POST', '/jobs', { spec }),
    // action: approve | cancel | requeue | retry-download
    act: (id, action) => call('POST', `/jobs/${encodeURIComponent(id)}/${action}`),

    // ---- Entities and prompt composition (report §2.7). Nothing here can spend credits.
    entities: (projectId) => call('GET', `/entities${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    entityUpsert: (projectId, entity) => call('POST', '/entities', { projectId, entity }),
    // action: approve | unapprove | ref | supersede | remove | style | import | restore
    entityAct: (action, body) => call('POST', `/entities/${action}`, body),
    entityExport: (projectId) => call('GET', `/entities/export${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    composePrompt: (projectId, spec) => call('POST', '/prompts', { projectId, spec }),
  };
}
