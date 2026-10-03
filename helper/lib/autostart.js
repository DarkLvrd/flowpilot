// The helper that `flowpilot mcp` runs on demand. Claude Desktop starts the MCP server but nothing
// starts `flowpilot serve`, so without this the person sees a connection error instead of a working
// tool. The MCP server starts a helper of its own — and only its own: if one is already listening
// (someone ran `flowpilot serve`, or an earlier MCP server started it) it is reused as-is and never
// touched, so two owners never fight over the port. Whatever this module starts, it also stops.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/flowpilot.js', import.meta.url));
export const START_TRIES = 40; // 40 × 250 ms = 10 s, generous for a local bind
export const START_INTERVAL_MS = 250;
export const PROBE_TIMEOUT_MS = 700;
export const STOP_GRACE_MS = 3000;

// Is a helper answering on this port? Used to decide whether to start one at all. A closed port is
// false, never a throw.
export async function isHelperListening(port, { fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export function startHelper({ port, env = process.env, log = () => {}, spawnImpl = spawn } = {}) {
  const child = spawnImpl(process.execPath, [BIN, 'serve'], {
    env: { ...env, FLOWPILOT_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'], // never inherit stdout: that is the MCP channel
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', (c) => log(String(c).trimEnd()));
  return child;
}

export function createAutoStart({
  port,
  env = process.env,
  probe = () => isHelperListening(port),
  start = () => startHelper({ port, env }),
  tries = START_TRIES,
  intervalMs = START_INTERVAL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {},
} = {}) {
  let child = null;
  let ready = false;

  const exited = (c) => c.exitCode != null || c.signalCode != null;

  function waitExit(c, ms) {
    if (exited(c)) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { c.kill('SIGKILL'); resolve(); }, ms);
      c.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }

  return {
    get started() { return !!child; },

    // Returns { started, child }: started is true only when this call started the helper. Throws a
    // message the person (or Claude) can act on if no helper can be reached.
    async ensure() {
      if (ready) return { started: !!child, child };
      if (await probe()) { ready = true; return { started: false, child: null }; }

      log(`Starting the Flow Pilot helper on 127.0.0.1:${port}…`);
      const c = start();
      child = c;
      let lastError = null;
      c.once?.('error', (e) => { lastError = e.message; });
      c.stderr?.on?.('data', (b) => { lastError = String(b).trim() || lastError; });

      for (let i = 0; i < tries; i++) {
        if (exited(c)) {
          if (await probe()) { child = null; ready = true; return { started: false, child: null }; } // another helper won the port
          child = null;
          throw new Error(`The Flow Pilot helper stopped right after it started${lastError ? `: ${lastError}` : ''}`);
        }
        if (await probe()) { ready = true; return { started: true, child: c }; }
        await sleep(intervalMs);
      }
      if (await probe()) { ready = true; return { started: true, child: c }; }
      await this.stop();
      throw new Error(`The Flow Pilot helper did not start on 127.0.0.1:${port}. Run \`flowpilot serve\` in a terminal to see why.`);
    },

    // Stop only the helper this module started. A helper that was already running is left alone.
    async stop() {
      const c = child;
      child = null;
      ready = false;
      if (!c || exited(c)) return;
      c.kill('SIGTERM');
      await waitExit(c, STOP_GRACE_MS);
    },

    // Synchronous cleanup for a signal handler: the last thing before the MCP process exits.
    stopNow() {
      const c = child;
      child = null;
      ready = false;
      if (c && !exited(c)) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
    },
  };
}
