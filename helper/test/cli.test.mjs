import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createKeyring } from '../lib/keys.js';
import { createPin } from '../lib/pin.js';
import { createHelper } from '../lib/server.js';
import { main } from '../lib/cli.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

async function world({ extension = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fp-cli-'));
  const keyring = createKeyring({ file: join(home, 'agents.json') });
  const pin = createPin({ file: join(home, 'extension.json') });
  const helper = createHelper({ keyring, pin });
  const port = await helper.listen(0);
  const calls = [];
  let ws;
  if (extension) {
    ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: EXT });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (!m.cmd) return;
      calls.push([m.cmd, m.args]);
      const value = m.cmd === 'status'
        ? { session: { cap: 10, spent: 4, halted: false }, workTab: { projectId: 'p1' }, jobs: [{ id: 'j1', name: 'fox', state: 'done', file: { path: '/x/fox.mp4' } }] }
        : { id: m.args.id ?? 'j2', state: m.cmd === 'addJob' ? 'queued' : 'approved', expectedCost: 4 };
      ws.send(JSON.stringify({ id: m.id, ok: true, value }));
    });
    await new Promise((r) => ws.once('open', r));
  }
  const env = { FLOWPILOT_HOME: home, FLOWPILOT_PORT: String(port) };
  const run = async (...argv) => {
    const out = [];
    const code = await main(argv, { env, out: (s) => out.push(s), err: (s) => out.push(s) });
    return { code, text: out.join('\n') };
  };
  const close = async () => { ws?.close(); await helper.close(); };
  return { home, keyring, run, calls, close };
}

test('pair stores the key for the owner only; later commands use it', async () => {
  const w = await world();
  assert.match((await w.run('status')).text, /not paired/i);
  const r = await w.run('pair', w.keyring.newCode().code, '--name', 'claude');
  assert.equal(r.code, 0, r.text);
  const keyFile = join(w.home, 'key');
  assert.equal(statSync(keyFile).mode & 0o077, 0);
  assert.match(readFileSync(keyFile, 'utf8'), /^fp_/);

  const s = await w.run('status');
  assert.equal(s.code, 0, s.text);
  assert.match(s.text, /4 \/ 10/);
  assert.match(s.text, /fox/);
  await w.close();
});

test('add, approve, cancel and job forward to the extension; --json prints raw JSON', async () => {
  const w = await world();
  await w.run('pair', w.keyring.newCode().code);
  const added = await w.run('add', '--prompt', 'a red fox', '--kind', 'video', '--resolution', '360p', '--duration', '4', '--out', '/Users/me/fox.mp4', '--json');
  assert.equal(added.code, 0, added.text);
  assert.equal(JSON.parse(added.text).id, 'j2');
  assert.deepEqual(w.calls.at(-1), ['addJob', { spec: { prompt: 'a red fox', kind: 'video', resolution: '360p', durationS: 4, outputPath: '/Users/me/fox.mp4' } }]);

  await w.run('approve', 'j2');
  await w.run('cancel', 'j2');
  assert.deepEqual(w.calls.slice(-2), [['approve', { id: 'j2' }], ['cancel', { id: 'j2' }]]);
  assert.match((await w.run('job', 'j1')).text, /done/);
  await w.close();
});

test('errors are short and the exit code is non-zero', async () => {
  const w = await world({ extension: false });
  await w.run('pair', w.keyring.newCode().code);
  const r = await w.run('status');
  assert.equal(r.code, 1);
  assert.match(r.text, /extension is not connected/);
  assert.equal((await w.run('add')).code, 2); // no prompt
  assert.equal((await w.run('fly')).code, 2);
  await w.close();
});

test('doctor reports each part of the setup', async () => {
  const w = await world();
  let r = await w.run('doctor');
  assert.equal(r.code, 1);
  assert.match(r.text, /✅ .*Helper running/);
  assert.match(r.text, /✅ .*Extension connected/);
  assert.match(r.text, /❌ .*Paired/);
  await w.run('pair', w.keyring.newCode().code);
  r = await w.run('doctor');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /✅ .*Work tab/);
  assert.match(r.text, new RegExp(`Extension pinned.*${EXT_ID}`)); // reports the pinned id
  await w.close();
});

test('serve --forget-extension clears the pinned extension and reports it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fp-cli-'));
  const extFile = join(home, 'extension.json');
  writeFileSync(extFile, JSON.stringify({ id: EXT_ID }));
  const env = { FLOWPILOT_HOME: home, FLOWPILOT_PORT: '0' };
  const out = [];
  const done = main(['serve', '--forget-extension'], { env, out: (s) => out.push(s), err: (s) => out.push(s) });
  await new Promise((r) => setTimeout(r, 50)); // serve forgets the pin, then starts listening
  assert.ok(!existsSync(extFile));
  process.emit('SIGINT'); // stop the helper we started
  assert.equal(await done, 0);
  assert.match(out.join('\n'), /forgot the pinned extension/i);
});
