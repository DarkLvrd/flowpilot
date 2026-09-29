// Boots the real service worker against a fake `chrome` and a fake Flow tab serving recon fixtures.
// Checks the wiring (messages, self-check, add job with cost, who may set the cap); no browser needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';
const EXT = 'chrome-extension://abc/';
const data = {};
const writes = [];
let listener;
let onFocus, onActivated; // window focus and tab switch listeners
const tabs = { 7: { id: 7, url: `https://flow.google.com/project/${PID}` } };
const driverChecks = [{ name: 'Prompt box', ok: true }];
let rateLimited = false; // next RPC answers HTTP 429

globalThis.chrome = {
  runtime: {
    id: 'abc',
    getURL: (p) => EXT + p,
    onMessage: { addListener: (fn) => { listener = fn; } },
  },
  storage: {
    local: {
      async get(k) { return k in data ? { [k]: structuredClone(data[k]) } : {}; },
      async set(o) { writes.push(...Object.keys(o)); Object.assign(data, structuredClone(o)); },
    },
    onChanged: { addListener() {} },
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: (fn) => { onFocus = fn; } } },
  tabs: {
    async get(id) { if (!tabs[id]) throw new Error('no tab'); return tabs[id]; },
    async update() {},
    async sendMessage(_id, msg) { return msg.cmd === 'selfCheck' ? { ok: true, value: driverChecks } : { ok: false, error: 'not in smoke test' }; },
    onUpdated: { addListener() {} },
    onActivated: { addListener: (fn) => { onActivated = fn; } },
  },
  scripting: {
    async executeScript({ args: [rpcid] }) {
      if (rateLimited) return [{ result: { status: 429, text: '' } }];
      const known = { nzlxg: 'nzlxg', HTrJv: 'HTrJv', yBhWQ: 'yBhWQ', Zzl0ze: 'Zzl0ze' };
      return [{ result: known[rpcid] ? { status: 200, text: fixture(known[rpcid]) } : { status: 400, text: '' } }];
    },
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  downloads: {},
};

await import('../sw.js');

const send = (msg, url = `${EXT}dashboard/index.html`) => new Promise((resolve) => {
  const handled = listener(msg, { id: 'abc', url }, resolve);
  if (!handled) resolve({ ignored: true });
});

test('ignores messages from content scripts on Flow', async () => {
  assert.deepEqual(await send({ cmd: 'status' }, `https://flow.google.com/project/${PID}`), { ignored: true });
});

test('binding the work tab runs the self-check against the page RPCs', async () => {
  const r = await send({ cmd: 'useTab', tabId: 7 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.ok, true, JSON.stringify(r.value.checks));
  assert.equal(r.value.balance, 261);
});

test('adding a job prices it from the catalog', async () => {
  const r = await send({ cmd: 'addJob', spec: { name: 'fox', prompt: 'a red fox', kind: 'video', input: 'text', resolution: '360p', durationS: 4 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.recipe, 'abra_t2v_4s_360p');
  assert.equal(r.value.expectedCost, 4);
  assert.equal(r.value.modelFamily, 'Omni 1.1 Flash');
  assert.equal(r.value.state, 'queued');
});

test('jobs with references are refused until the driver can attach them', async () => {
  const r = await send({ cmd: 'addJob', spec: { prompt: 'x', input: 'ingredients', refs: ['m1'] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /not supported yet/);
});

test('only the dashboard can set the cap', async () => {
  assert.match((await send({ cmd: 'setCap', cap: 10 }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);
  assert.equal((await send({ cmd: 'setCap', cap: 10 })).ok, true);
  assert.equal((await send({ cmd: 'status' })).value.session.cap, 10);
});

// Every storage write wakes the dashboard, which reads `status` again. If reading status wrote
// anything (it used to run an engine tick), the two would loop hundreds of times a second.
test('reading status writes nothing to storage', async () => {
  await send({ cmd: 'status' });
  await new Promise((r) => setTimeout(r, 50)); // let any tick the message started finish
  writes.length = 0;
  await send({ cmd: 'status' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(writes, []);
});

test('a block while adding a job halts the queue instead of queueing blind', async () => {
  rateLimited = true;
  const r = await send({ cmd: 'addJob', spec: { name: 'x', prompt: 'x', kind: 'video', input: 'text', resolution: '360p', durationS: 4 } });
  rateLimited = false;
  assert.equal(r.ok, false);
  assert.match(r.error, /429|blocked/i);
  const s = (await send({ cmd: 'status' })).value.session;
  assert.equal(s.halted, true);
  assert.equal((await send({ cmd: 'clearHalt' })).ok, true);
});

// Focus and tab switches tick only to start a job that waits for Flow in front (LESSONS #16:
// every tick asks Flow for status, which is paced; switching windows must not add polls).
test('window focus and tab switches tick only while a job waits for the Flow tab', async () => {
  const settle = () => new Promise((r) => setTimeout(r, 50));
  const ticked = async (fire) => { await settle(); writes.length = 0; await fire(); await settle(); return writes.includes('flowpilot.lastTick'); };

  data['flowpilot.lastTick'] = { at: 1, error: null, waiting: null };
  assert.equal(await ticked(() => onFocus(1)), false);
  assert.equal(await ticked(() => onActivated({ tabId: 7 })), false);

  data['flowpilot.lastTick'] = { at: 1, error: null, waiting: 'Bring the Flow tab to the front to submit the next job' };
  assert.equal(await ticked(() => onFocus(-1)), false); // focus left Chrome
  assert.equal(await ticked(() => onActivated({ tabId: 8 })), false); // some other tab
  assert.equal(await ticked(() => onFocus(1)), true);
  data['flowpilot.lastTick'].waiting = 'x';
  assert.equal(await ticked(() => onActivated({ tabId: 7 })), true);
});
