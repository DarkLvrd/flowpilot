// The extension's end of the helper bridge, against the real helper server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createBridge } from '../lib/bridge.js';
import { createKeyring } from '../../helper/lib/keys.js';
import { createHelper } from '../../helper/lib/server.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const openSocket = (url) => new WebSocket(url, { origin: EXT }); // Chrome sets this Origin itself
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

async function helper(port = 0) {
  const keyring = createKeyring({ file: join(mkdtempSync(join(tmpdir(), 'fp-bridge-')), 'agents.json') });
  const h = createHelper({ keyring });
  return { h, keyring, port: await h.listen(port) };
}

async function until(check, what) {
  for (let i = 0; i < 100; i++) { if (check()) return; await settle(20); }
  throw new Error(`Timed out waiting for ${what}`);
}

test('runs agent commands and gets pairing codes through the helper', async () => {
  const { h, keyring, port } = await helper();
  const seen = [];
  const bridge = createBridge({ url: `ws://127.0.0.1:${port}/bridge`, openSocket, onCommand: async (cmd, args) => { seen.push([cmd, args]); return { ok: cmd }; } });
  bridge.start();
  await until(() => bridge.connected, 'the bridge to connect');

  const { code } = await bridge.request('pairCode');
  const key = keyring.redeem(code, 'claude');
  const res = await fetch(`http://127.0.0.1:${port}/jobs/j1/approve`, { method: 'POST', headers: { Authorization: `Bearer ${key}` } });
  assert.deepEqual(await res.json(), { ok: 'approve' });
  assert.deepEqual(seen, [['approve', { id: 'j1' }]]);
  bridge.stop();
  await h.close();
});

test('with no helper running, requests fail fast and start() tries again later', async () => {
  const { h, port } = await helper();
  await h.close(); // nothing listens on `port` now
  const bridge = createBridge({ url: `ws://127.0.0.1:${port}/bridge`, openSocket, onCommand: async () => ({}) });
  bridge.start();
  await settle(100);
  assert.equal(bridge.connected, false);
  await assert.rejects(bridge.request('pairCode'), /helper is not running/);

  const again = await helper(port);
  bridge.start();
  await until(() => bridge.connected, 'the bridge to reconnect');
  assert.match((await bridge.request('pairCode')).code, /-/);
  bridge.stop();
  await again.h.close();
});

test('a command the extension rejects comes back as that error', async () => {
  const { h, keyring, port } = await helper();
  const bridge = createBridge({ url: `ws://127.0.0.1:${port}/bridge`, openSocket, onCommand: async () => { throw new Error('Only the dashboard can set the credit cap'); } });
  bridge.start();
  await until(() => bridge.connected, 'the bridge to connect');
  const key = keyring.redeem((await bridge.request('pairCode')).code, 'x');
  const res = await fetch(`http://127.0.0.1:${port}/status`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /Only the dashboard/);
  bridge.stop();
  await h.close();
});
