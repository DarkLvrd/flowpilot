import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore } from '../lib/jobs.js';
import { createRunner } from '../lib/runner.js';

const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';
const MP4 = new Uint8Array([0, 0, 0, 0x20, ...'ftypisom'].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c)).concat(Array(52).fill(0)));
const NOW = 1_790_569_700_000; // epoch ms, Sept 2026 like the recon records
const HTML = new Uint8Array([...'<!doctype html><html>'].map((c) => c.charCodeAt(0)));

function memoryArea() {
  const data = {};
  return {
    async get(k) { return k in data ? { [k]: structuredClone(data[k]) } : {}; },
    async set(o) { Object.assign(data, structuredClone(o)); },
  };
}

// A fake Flow tab: records calls, serves project media and media detail from `server`.
function fakeWorld({ page = {}, media = [], detail = {}, bytes = MP4, blocked = false } = {}) {
  const log = [];
  const server = { media, detail };
  const flow = {
    async call(key, inner) {
      log.push(`rpc:${key}`);
      if (blocked) return { ok: false, kind: 'blocked', message: 'Flow reported UNUSUAL_ACTIVITY' };
      if (key === 'projectMedia') return { ok: true, data: server.media };
      if (key === 'mediaDetail') return server.detail[inner[0]] ? { ok: true, data: server.detail[inner[0]] } : { ok: false, kind: 'rpc-error', message: 'not ready' };
      return { ok: false, kind: 'rpc-error', message: 'unexpected' };
    },
  };
  const driver = {
    async prepare(job) {
      log.push(`prepare:${job.name}`);
      return {
        tabId: 7, url: `https://flow.google.com/project/${PID}`, prompt: job.prompt,
        summary: { kind: 'video', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
        input: 'ingredients', model: 'Omni 1.1 Flash', cost: 4, generateEnabled: true, overlayOpen: false, ...page,
      };
    },
    async clickGenerate() { log.push('click'); return { ok: true }; },
    async inFront() { return world.front; },
  };
  const files = {
    async fetchBytes(url) { log.push(`fetch:${url}`); return bytes; },
    async save(job, data, type) { log.push(`save:${job.name}.${type}`); return `FlowPilot/${job.projectId}/${job.name}.${type}`; },
  };
  const workTab = { async get() { return { tabId: 7, projectId: PID }; } };
  const world = { log, server, flow, driver, files, workTab, front: true };
  return world;
}

const spec = (name, extra = {}) => ({
  name, projectId: PID, prompt: `prompt ${name}`, recipe: 'abra_t2v_4s_360p', expectedCost: 4, modelFamily: 'Omni 1.1 Flash',
  settings: { kind: 'video', input: 'ingredients', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 }, ...extra,
});

async function setup(worldOpts, { cap = 100, maxInFlight = 2, now = NOW, noticeCheck } = {}) {
  const store = createJobStore(memoryArea(), { now: () => now });
  await store.setCap(cap);
  const world = fakeWorld(worldOpts);
  const runner = createRunner({ store, ...world, settings: { maxInFlight }, now: () => now, noticeCheck });
  return { store, world, runner };
}

async function approved(store, name, extra) {
  const job = await store.add(spec(name, extra));
  await store.apply(job.id, { type: 'approve' });
  return job;
}

test('submits an approved job: the click is recorded before it happens', async () => {
  const { store, world, runner } = await setup();
  let stateAtClick;
  const click = world.driver.clickGenerate;
  const job = await approved(store, 'a');
  world.driver.clickGenerate = async () => { stateAtClick = (await store.get(job.id)).state; return click(); };

  await runner.tick();
  assert.equal(stateAtClick, 'submitted');
  const after = await store.get(job.id);
  assert.equal(after.state, 'submitted');
  assert.equal(after.cost, 4);
  assert.equal((await store.session()).spent, 4);
});

test('a failed pre-spend check fails the job and never clicks', async () => {
  const { store, world, runner } = await setup({ page: { prompt: 'something else' } });
  const job = await approved(store, 'a');
  await runner.tick();
  assert.ok(!world.log.includes('click'));
  const after = await store.get(job.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /prompt/);
  assert.equal((await store.session()).spent, 0);
});

test('the click goes to the job’s own tab, with what the pre-spend check saw', async () => {
  const { store, world, runner } = await setup({ page: { summaryText: 'Video · 360p · 4s crop_16_9 x1' } });
  const job = await approved(store, 'a');
  let args;
  world.driver.clickGenerate = async (...a) => { args = a; return { ok: true }; };
  await runner.tick();
  assert.deepEqual(args, [7, { url: `https://flow.google.com/project/${PID}`, prompt: job.prompt, summaryText: 'Video · 360p · 4s crop_16_9 x1' }]);
});

test('a work tab rebound during prepare fails the job before the point of no return', async () => {
  const { store, world, runner } = await setup();
  const job = await approved(store, 'a');
  const prepare = world.driver.prepare;
  world.driver.prepare = async (j) => { world.workTab.get = async () => ({ tabId: 8, projectId: PID }); return prepare(j); };
  await runner.tick();
  assert.ok(!world.log.includes('click'));
  const after = await store.get(job.id);
  assert.equal(after.state, 'failed');
  assert.equal(after.clickedAt, null);
  assert.match(after.error, /work tab/);
});

test('a driver that refuses at click time fails the job as not clicked', async () => {
  const { store, world, runner } = await setup();
  const job = await approved(store, 'a');
  world.driver.clickGenerate = async () => ({ ok: false, notClicked: true, error: 'prompt changed' });
  await runner.tick();
  const after = await store.get(job.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /^Not clicked: prompt changed/);
  assert.ok(!after.mayHaveSubmitted);
});

test('queued (unapproved) jobs are never submitted', async () => {
  const { store, world, runner } = await setup();
  await store.add(spec('a'));
  await runner.tick();
  assert.ok(!world.log.some((l) => l.startsWith('prepare')));
});

test('one submission per tick, and no more than maxInFlight renders', async () => {
  const { store, world, runner } = await setup({}, { maxInFlight: 2 });
  for (const n of ['a', 'b', 'c']) await approved(store, n);
  await runner.tick();
  await runner.tick();
  await runner.tick();
  assert.deepEqual(world.log.filter((l) => l === 'click').length, 2);
  assert.deepEqual((await store.list()).map((j) => j.state), ['submitted', 'submitted', 'approved']);
});

test('jobs for another project wait (the work tab never navigates on its own here)', async () => {
  const { store, world, runner } = await setup();
  await approved(store, 'a', { projectId: 'other-project' });
  await runner.tick();
  assert.ok(!world.log.includes('click'));
});

test('a blocked response halts every job and nothing more is clicked', async () => {
  const { store, world, runner } = await setup({ blocked: true });
  const a = await approved(store, 'a');
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: 1, cost: 4 });
  await approved(store, 'b');
  await runner.tick();
  assert.equal((await store.session()).halted, true);
  assert.deepEqual((await store.list()).map((j) => j.state), ['halted', 'halted']);
  assert.ok(!world.log.includes('click'));
});

test('a submitted job is matched by prompt, downloaded, byte-checked and saved', async () => {
  const { store, world, runner } = await setup();
  const a = await approved(store, 'a');
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: NOW - 10_000, cost: 4 });

  // Same shape as the recon Zzl0ze payload: [null, [workflows], [media records]].
  const MID = '11111111-1111-1111-1111-111111111111';
  const WID = '22222222-2222-2222-2222-222222222222';
  world.server.media = [null,
    [[WID, null, null, ['prompt a', [1_790_569_695, 0], null, null, MID], PID]],
    [[MID, PID, WID, 'CAE', null, [[1_790_569_695, 0], 'prompt a', null, null, null, 'thumb',
      [null, [['abra_t2v_4s_360p', 3, [5], null, 2, 4], []], [[null, null, [[['prompt a']]]]], null, 1]]]]];
  await runner.tick();
  assert.equal((await store.get(a.id)).state, 'rendering');

  world.server.detail['11111111-1111-1111-1111-111111111111'] = ['11111111-1111-1111-1111-111111111111', PID, 'w', 'CAE',
    ['https://flow-content.google/video/11111111-1111-1111-1111-111111111111?Expires=1&KeyName=k&Signature=s']];
  await runner.tick();
  const done = await store.get(a.id);
  assert.equal(done.state, 'done');
  assert.equal(done.file.path, `FlowPilot/${PID}/a.mp4`);
});

test('a download whose bytes are not an MP4 fails the job', async () => {
  const { store, runner, world } = await setup({ bytes: HTML });
  const a = await approved(store, 'a');
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: 1, cost: 4 });
  await store.apply(a.id, { type: 'ready', mediaId: 'm1' });
  world.server.detail.m1 = ['m1', PID, 'w', 'CAE', ['https://flow-content.google/video/m1?Expires=1&KeyName=k&Signature=s']];
  await runner.tick();
  const after = await store.get(a.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /mp4/);
  assert.ok(!world.log.some((l) => l.startsWith('save')));
});

test('a submitted job with no result after the timeout fails and is not retried', async () => {
  const { store, runner, world } = await setup();
  const a = await approved(store, 'a');
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: NOW - 31 * 60_000, cost: 4 });
  world.server.media = [null, [], []];
  await runner.tick();
  const after = await store.get(a.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /no result/i);
  assert.ok(!world.log.includes('click'));
});

test('if the composer may have submitted by itself, the job fails for good and everything halts', async () => {
  const { store, world, runner } = await setup({ page: { halt: 'The prompt box emptied itself while filling' } });
  const a = await approved(store, 'a');
  const b = await approved(store, 'b');
  await runner.tick();
  assert.ok(!world.log.includes('click'));
  assert.equal((await store.session()).halted, true);
  const failed = await store.get(a.id);
  assert.equal(failed.state, 'failed');
  assert.equal((await store.get(b.id)).state, 'halted');
  await store.clearHalt();
  await assert.rejects(store.apply(a.id, { type: 'requeue' }), /may have/);
});

// Stands in for the helper's Jev check: calls a message a block when `isBlock(text)` says so.
function fakeNoticeCheck(isBlock) {
  const seen = [];
  return {
    seen,
    async check(texts) {
      seen.push(texts);
      const hit = texts.find(isBlock);
      return hit ? { halt: true, message: hit, p: 0.9 } : { halt: false, p: 0.1 };
    },
  };
}

test('a Flow message the regex missed but Jev calls a block halts everything before the click', async () => {
  const noticeCheck = fakeNoticeCheck((t) => /daily limit/.test(t));
  const { store, world, runner } = await setup({ page: { notices: ["You've reached your daily limit"] } }, { noticeCheck });
  await approved(store, 'a');
  await approved(store, 'b');
  const r = await runner.tick();
  assert.ok(!world.log.includes('click'));
  assert.equal((await store.session()).halted, true);
  assert.match((await store.session()).haltReason, /daily limit/);
  assert.match(r.error, /Halted/);
});

test('Jev only adds halts: a harmless message, a failed Jev call or no helper at all lets the job go ahead', async () => {
  const harmless = fakeNoticeCheck(() => false);
  const failing = { async check() { return { halt: false, error: 'Jev answered HTTP 529' }; } };
  const unreachable = { async check() { throw new TypeError('fetch failed'); } }; // helper bridge down
  for (const noticeCheck of [harmless, failing, unreachable, undefined]) {
    const { store, world, runner } = await setup({ page: { notices: ['Project renamed'] } }, { noticeCheck });
    await approved(store, 'a');
    await runner.tick();
    assert.ok(world.log.includes('click'));
    assert.equal((await store.session()).halted, false);
  }
  assert.deepEqual(harmless.seen, [['Project renamed']]);
});

test('a block message that appears after the click halts everything', async () => {
  const noticeCheck = fakeNoticeCheck((t) => /paused for your account/.test(t));
  const { store, world, runner } = await setup({}, { noticeCheck });
  world.driver.clickGenerate = async () => {
    world.log.push('click');
    return { ok: false, error: 'Timed out waiting for Flow to accept the generation', notices: ['Generating is paused for your account'] };
  };
  const a = await approved(store, 'a');
  await approved(store, 'b');
  await runner.tick();
  assert.equal((await store.session()).halted, true);
  assert.equal((await store.get(a.id)).state, 'halted');
});

test('an approved job waits, unstarted, while the Flow tab is behind another tab, then goes once it is in front', async () => {
  const { store, world, runner } = await setup();
  world.front = false;
  const a = await approved(store, 'a');
  const r = await runner.tick();
  assert.equal((await store.get(a.id)).state, 'approved');
  assert.match(r.waiting, /front/);
  assert.ok(!world.log.some((l) => l.startsWith('prepare')));

  world.front = true;
  await runner.tick();
  assert.equal((await store.get(a.id)).state, 'submitted');
  assert.ok(world.log.includes('click'));
});
