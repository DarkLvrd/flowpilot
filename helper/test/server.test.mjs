import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createKeyring } from '../lib/keys.js';
import { createPin } from '../lib/pin.js';
import { createHelper } from '../lib/server.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const EXT2 = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';
const MP4 = Buffer.from([0, 0, 0, 0x20, ...Buffer.from('ftypisom'), ...Array(52).fill(0)]);
const tmp = () => mkdtempSync(join(tmpdir(), 'flowpilot-helper-'));

async function start() {
  const home = tmp();
  const keyring = createKeyring({ file: join(home, 'agents.json') });
  const pin = createPin({ file: join(home, 'extension.json') });
  const helper = createHelper({ keyring, pin });
  const port = await helper.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const http = async (method, path, { key, body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  return { helper, keyring, pin, port, base, http };
}

// A stand-in for the extension's service worker: answers the helper's commands with `handle`.
async function fakeExtension(port, handle, { origin = EXT } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin });
  const pending = new Map();
  let rid = 0;
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (m.rid != null) { pending.get(m.rid)?.(m); pending.delete(m.rid); return; }
    if (m.cmd) {
      try { ws.send(JSON.stringify({ id: m.id, ok: true, value: await handle(m.cmd, m.args ?? {}) })); } catch (e) { ws.send(JSON.stringify({ id: m.id, ok: false, error: e.message })); }
    }
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); ws.once('unexpected-response', (_q, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
  const ask = (req, extra = {}) => new Promise((resolve) => { const id = ++rid; pending.set(id, resolve); ws.send(JSON.stringify({ rid: id, req, ...extra })); });
  return { ws, ask };
}

async function paired(t) {
  const code = t.keyring.newCode().code;
  const r = await t.http('POST', '/pair', { body: { code, name: 'test-agent' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.key;
}

test('an agent pairs with the dashboard code, then drives jobs through the extension', async () => {
  const t = await start();
  const calls = [];
  const ext = await fakeExtension(t.port, async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'status') return { session: { cap: 10, spent: 0, halted: false }, jobs: [{ id: 'j1', state: 'queued' }] };
    if (cmd === 'addJob') return { id: 'j1', state: 'queued', ...args.spec };
    return { id: args.id, state: 'approved' };
  });
  // The dashboard asks for the code through the extension.
  const { value: { code } } = await ext.ask('pairCode');
  const pair = await t.http('POST', '/pair', { body: { code, name: 'claude' } });
  const key = pair.body.key;

  assert.equal((await t.http('GET', '/status', { key })).body.session.cap, 10);
  assert.equal((await t.http('POST', '/jobs', { key, body: { spec: { prompt: 'a fox' } } })).body.id, 'j1');
  assert.equal((await t.http('GET', '/jobs/j1', { key })).body.state, 'queued');
  assert.equal((await t.http('POST', '/jobs/j1/approve', { key })).body.state, 'approved');
  assert.deepEqual(calls.map(([c]) => c), ['status', 'addJob', 'status', 'approve']);
  assert.deepEqual(calls[3][1], { id: 'j1' });
  ext.ws.close(); await t.helper.close();
});

test('no key, a wrong key, or a revoked key gets 401; health and pairing need none', async () => {
  const t = await start();
  assert.equal((await t.http('GET', '/status')).status, 401);
  assert.equal((await t.http('GET', '/status', { key: 'fp_nope' })).status, 401);
  assert.equal((await t.http('GET', '/health')).body.extension, false);
  const key = await paired(t);
  t.keyring.revoke('test-agent');
  assert.equal((await t.http('GET', '/status', { key })).status, 401);
  assert.equal((await t.http('POST', '/pair', { body: { code: 'AAAA-AAAA' } })).status, 400);
  await t.helper.close();
});

test('agents can never set the cap, clear a halt or pick the work tab (dashboard only)', async () => {
  const t = await start();
  const calls = [];
  const ext = await fakeExtension(t.port, async (cmd) => { calls.push(cmd); return {}; });
  const key = await paired(t);
  for (const path of ['/cap', '/clear-halt', '/use-tab', '/jobs/j1/setCap', '/jobs/j1/clearHalt']) {
    assert.equal((await t.http('POST', path, { key, body: { cap: 999 } })).status, 404, path);
  }
  assert.deepEqual(calls, []);
  ext.ws.close(); await t.helper.close();
});

test('with no extension connected, agent calls say so (503)', async () => {
  const t = await start();
  const key = await paired(t);
  const r = await t.http('GET', '/status', { key });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /extension is not connected/);
  await t.helper.close();
});

test('an extension error comes back to the agent as 400 with its message', async () => {
  const t = await start();
  const ext = await fakeExtension(t.port, async () => { throw new Error('Cannot approve a job that is done'); });
  const key = await paired(t);
  const r = await t.http('POST', '/jobs/j1/approve', { key });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Cannot approve a job that is done');
  ext.ws.close(); await t.helper.close();
});

test('web pages cannot reach it: a browser Origin or a foreign Host header is refused, and only an extension may open the bridge', async () => {
  const t = await start();
  const key = await paired(t);
  assert.equal((await t.http('GET', '/status', { key, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await t.http('POST', '/pair', { body: { code: 'x' }, headers: { Origin: 'https://evil.example' } })).status, 403);
  // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends its own Host.
  const rebound = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const req = request({ host: '127.0.0.1', port: t.port, path: '/health', headers: { Host: `evil.example:${t.port}` } }, (res) => resolve(res.statusCode));
      req.end();
    });
  });
  assert.equal(rebound, 403);
  await assert.rejects(fakeExtension(t.port, async () => ({}), { origin: 'https://evil.example' }), /403/);
  await t.helper.close();
});

test('the bridge pins the first extension id and refuses any other with 403, never pinning it', async () => {
  const t = await start();
  const ext = await fakeExtension(t.port, async () => ({}), { origin: EXT });
  assert.equal(t.pin.get(), 'abcdefghijklmnopabcdefghijklmnop');
  // A second, different installed extension cannot pose as Flow Pilot.
  await assert.rejects(fakeExtension(t.port, async () => ({}), { origin: EXT2 }), /403/);
  assert.equal(t.pin.get(), 'abcdefghijklmnopabcdefghijklmnop'); // the impostor is never pinned
  // The pinned extension still connects.
  const again = await fakeExtension(t.port, async () => ({}), { origin: EXT });
  again.ws.close(); ext.ws.close(); await t.helper.close();
});

test('the extension saves a finished file to an absolute path: media only, bytes checked, never overwriting', async () => {
  const t = await start();
  const ext = await fakeExtension(t.port, async () => ({}));
  const dir = tmp();
  const want = join(dir, 'scenes', 'fox.mp4');
  const r1 = await ext.ask('writeFile', { path: want, data: MP4.toString('base64') });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.value.path, want);
  assert.deepEqual(readFileSync(want), MP4);

  const r2 = await ext.ask('writeFile', { path: want, data: MP4.toString('base64') });
  assert.equal(r2.value.path, join(dir, 'scenes', 'fox (1).mp4'));
  assert.deepEqual(readFileSync(want), MP4);

  const rc = join(dir, '.zshrc');
  writeFileSync(rc, 'keep');
  for (const [path, why] of [[rc, /\.mp4|media/], [join(dir, 'x.sh'), /media/], ['relative/fox.mp4', /absolute/], [join(dir, 'fox.png'), /not a png|match/i]]) {
    const r = await ext.ask('writeFile', { path, data: MP4.toString('base64') });
    assert.equal(r.ok, false, path);
    assert.match(r.error, why);
  }
  assert.equal(readFileSync(rc, 'utf8'), 'keep');
  assert.ok(!existsSync(join(dir, 'x.sh')));
  ext.ws.close(); await t.helper.close();
});
