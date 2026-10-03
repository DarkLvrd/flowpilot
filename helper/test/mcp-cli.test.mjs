import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import WebSocket from 'ws';
import { createKeyring } from '../lib/keys.js';
import { createPin } from '../lib/pin.js';
import { createHelper } from '../lib/server.js';
import { isHelperListening } from '../lib/autostart.js';
import { main } from '../lib/cli.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

// Drives `flowpilot mcp` over in-memory stdio, the way Claude Desktop drives it over a pipe.
function pipe() {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map();
  let buf = '';
  output.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id;
    replies.set(n, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  return { input, output, call, close: () => input.end() };
}

function freePort() {
  // A port nothing is listening on: bind an ephemeral server, read the port, close it.
  return new Promise((resolve) => {
    const srv = createHelper({ keyring: createKeyring({ file: join(tmpdir(), `unused-${Math.random()}`) }) });
    srv.listen(0).then(async (port) => { await srv.close(); resolve(port); });
  });
}

test('flowpilot mcp reuses a helper already listening and answers a tool call with its JSON', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fp-mcp-'));
  const keyring = createKeyring({ file: join(home, 'agents.json') });
  const helper = createHelper({ keyring, pin: createPin({ file: join(home, 'extension.json') }) });
  const port = await helper.listen(0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: EXT });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (!m.cmd) return;
    ws.send(JSON.stringify({ id: m.id, ok: true, value: { session: { cap: 10, spent: 0 }, workTab: null, jobs: [{ id: 'j1', name: 'fox', state: 'done' }] } }));
  });
  await new Promise((r) => ws.once('open', r));
  saveKeyFor(home, keyring);

  const env = { FLOWPILOT_HOME: home, FLOWPILOT_PORT: String(port) };
  const p = pipe();
  const out = [];
  const done = main(['mcp'], { env, out: (s) => out.push(s), err: (s) => out.push(s), input: p.input, output: p.output });
  const init = await p.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const listed = await p.call('tools/list', {});
  const names = listed.result.tools.map((t) => t.name).sort();
  assert.equal(names.length, 7);

  const status = await p.call('tools/call', { name: 'flowpilot_status', arguments: {} });
  assert.equal(status.result.isError, false, status.result.content[0].text);
  assert.equal(JSON.parse(status.result.content[0].text).jobs[0].name, 'fox');
  assert.equal(await isHelperListening(port), true); // someone else's helper is still up
  p.close();
  assert.equal(await done, 0);
  ws.close();
  await helper.close();
});

test('flowpilot mcp starts a helper of its own when none is listening, and stops it on exit', async () => {
  const port = await freePort();
  const home = mkdtempSync(join(tmpdir(), 'fp-mcp-'));
  const keyring = createKeyring({ file: join(home, 'agents.json') });
  saveKeyFor(home, keyring);
  assert.equal(await isHelperListening(port), false);

  const env = { FLOWPILOT_HOME: home, FLOWPILOT_PORT: String(port) };
  const p = pipe();
  const out = [];
  const done = main(['mcp'], { env, out: (s) => out.push(s), err: (s) => out.push(s), input: p.input, output: p.output });
  await p.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  // No extension here, so the honest answer is 503 — which proves the helper we started is reachable.
  const status = await p.call('tools/call', { name: 'flowpilot_status', arguments: {} });
  assert.equal(status.result.isError, true);
  assert.match(status.result.content[0].text, /extension is not connected/i);
  assert.equal(await isHelperListening(port), true);

  p.close();
  assert.equal(await done, 0);
  assert.equal(await isHelperListening(port), false); // the process it started is gone
});

function saveKeyFor(home, keyring) {
  const key = keyring.redeem(keyring.newCode().code, 'claude');
  writeFileSync(join(home, 'key'), `${key}\n`, { mode: 0o600 });
}
