import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore } from '../lib/jobs.js';
import { createRunner } from '../lib/runner.js';
import { planImport } from '../lib/storyboard.js';
import { parseCatalog } from '../lib/catalog.js';
import { parseBatchResponse } from '../lib/rpc.js';
import { fixture } from './helpers.mjs';

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
function fakeWorld({ page = {}, media = [], detail = {}, bytes = MP4, blocked = false, attachedOverride = null } = {}) {
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
  // A Flow Character has no media id in the DOM: its chip and its picker tile are matched by the
  // /asb/ thumbnail token (report §4). The fake mirrors the real driver — the tile token it read
  // during the attach, and the same token on the chip it left in the bar.
  const tokensOf = (references) => (references?.characters ?? []).map((c) => `asb-${c.entityId}`);
  const driver = {
    async prepare(job) {
      log.push(`prepare:${job.name}`);
      const attached = attachedOverride ?? (job.references
        ? { ingredients: job.references.ingredients ?? [], firstFrame: job.references.firstFrame ?? null, lastFrame: job.references.lastFrame ?? null, characters: tokensOf(job.references) }
        : { ingredients: [], firstFrame: null, lastFrame: null, characters: [] });
      const characterTokens = Object.fromEntries((job.references?.characters ?? []).map((c) => [c.name, `asb-${c.entityId}`]));
      return {
        tabId: 7, url: `https://flow.google.com/project/${PID}`, prompt: job.prompt,
        summary: { kind: 'video', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
        input: 'ingredients', model: 'Omni 1.1 Flash', cost: 4, generateEnabled: true, overlayOpen: false, attached,
        characterTokens, mentions: [], ...page,
      };
    },
    async clickGenerate() { log.push('click'); return { ok: true }; },
    async inFront() { return world.front; },
  };
  // Resolves a classified reference to a media id: an id passes through; a path 'uploads' to a
  // deterministic fake id. `resolveError` (set on the world) makes resolution throw/halt.
  const resolve = async (job) => {
    log.push(`resolve:${job.name}`);
    if (world.resolveError) throw world.resolveError;
    const id = (r) => (r.kind === 'mediaId' ? r.mediaId : `uploaded-${r.path.replace(/\W+/g, '-')}`);
    const plan = job.referencePlan;
    const characters = (plan.characters ?? []).map((c) => ({ entityId: c.entityId, name: c.name }));
    return {
      ingredients: (plan.ingredients ?? []).map(id),
      firstFrame: plan.firstFrame ? id(plan.firstFrame) : null,
      lastFrame: plan.lastFrame ? id(plan.lastFrame) : null,
      ...(characters.length ? { characters } : {}),
    };
  };
  const refs = { resolve };
  const files = {
    async fetchBytes(url) { log.push(`fetch:${url}`); return bytes; },
    async save(job, data, type) { log.push(`save:${job.name}.${type}`); return `FlowPilot/${job.projectId}/${job.name}.${type}`; },
  };
  const workTab = { async get() { return { tabId: 7, projectId: PID }; } };
  const world = { log, server, flow, driver, files, workTab, refs, front: true, resolveError: null };
  return world;
}

const spec = (name, extra = {}) => ({
  name, projectId: PID, prompt: `prompt ${name}`, recipe: 'abra_t2v_4s_360p', expectedCost: 4, modelFamily: 'Omni 1.1 Flash',
  settings: { kind: 'video', input: 'ingredients', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 }, ...extra,
});

async function setup(worldOpts, { cap = 100, maxInFlight = 2, now = NOW } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  const store = createJobStore(memoryArea(), { now: clock });
  await store.setCap(cap);
  const world = fakeWorld(worldOpts);
  const runner = createRunner({ store, ...world, settings: { maxInFlight }, now: clock });
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

test('a plain (no-reference) job stored with references: null submits through the real path', async () => {
  // addJob stores a plain job with references: null; the pre-spend check must read that as
  // "no references" and submit, never throw and wedge the job in submitting (finding #1).
  const { store, world, runner } = await setup();
  const job = await approved(store, 'a', { references: null });
  await runner.tick();
  assert.ok(world.log.includes('click'));
  const after = await store.get(job.id);
  assert.equal(after.state, 'submitted');
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

// Only finished videos have been seen live; mid-render the detail may list just the poster.
test('a rendering video whose detail has only its poster waits, and does not stall the other jobs', async () => {
  const { store, world, runner } = await setup();
  const a = await approved(store, 'a');
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: NOW - 10_000, cost: 4 });
  await store.apply(a.id, { type: 'matched', mediaId: 'm1' });
  world.server.detail.m1 = ['m1', PID, 'w', 'CAE', ['https://flow-content.google/image/m1?Expires=1&KeyName=k&Signature=s']];
  const b = await approved(store, 'b');

  const r = await runner.tick();
  assert.equal(r.error, undefined);
  assert.equal((await store.get(a.id)).state, 'rendering');
  assert.equal((await store.get(b.id)).state, 'submitted');

  world.server.detail.m1[4].push('https://flow-content.google/video/m1?Expires=1&KeyName=k&Signature=s');
  await runner.tick();
  assert.equal((await store.get(a.id)).state, 'done');
});

test('a download Flow never serves gives up after 15 min instead of waiting forever (e.g. a retried job that never finished rendering)', async () => {
  const { store, world, runner } = await setup();
  const a = await approved(store, 'a');
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: NOW - 70 * 60_000, cost: 4 });
  await store.apply(a.id, { type: 'matched', mediaId: 'm1' });
  await store.apply(a.id, { type: 'fail', reason: 'Still not ready after 60 min: not ready' });
  await store.apply(a.id, { type: 'retryDownload' }); // detail for m1 keeps answering "not ready"

  await runner.tick();
  assert.equal((await store.get(a.id)).state, 'downloading');

  const later = createRunner({ store, ...world, settings: { maxInFlight: 2 }, now: () => NOW + 16 * 60_000 });
  await later.tick();
  const after = await store.get(a.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /15 min/);
  assert.ok(!world.log.includes('click'));
});

test('a result that cannot be saved fails its job (Retry download can try again) and does not stall the others', async () => {
  const { store, world, runner } = await setup();
  world.files.save = async () => { throw new Error('EACCES: permission denied, open /Volumes/locked/fox.mp4'); };
  const a = await approved(store, 'a');
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: 1, cost: 4 });
  await store.apply(a.id, { type: 'ready', mediaId: 'm1' });
  world.server.detail.m1 = ['m1', PID, 'w', 'CAE', ['https://flow-content.google/video/m1?Expires=1&KeyName=k&Signature=s']];
  const b = await approved(store, 'b');

  const r = await runner.tick();
  assert.equal(r.error, undefined);
  const after = await store.get(a.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /Could not save.*permission denied/);
  assert.equal((await store.get(b.id)).state, 'submitted');
});

// ---- Imported batches run through the same engine -------------------------------------------------

const catalog = parseCatalog(parseBatchResponse(fixture('HTrJv'), 'HTrJv').data);
const storyboard = 'scene,prompt,resolution,duration\nopening,a red fox,360p,4\nclosing,a blue fox,360p,4\n';

const queueImport = async (store, plan) => {
  const ids = [];
  for (const row of plan.rows) {
    assert.equal(row.ok, true, row.error);
    const job = await store.add(row.job);
    await store.apply(job.id, { type: 'approve' });
    ids.push(job.id);
  }
  return ids;
};

test('an imported storyboard batch queues and submits through the real job model', async () => {
  const { store, world, runner } = await setup({}, { cap: 100 });
  const plan = planImport({ text: storyboard, filename: 'story.csv', projectId: PID, recipes: catalog, template: '{project}/{scene}-{index}' });
  const ids = await queueImport(store, plan);

  await runner.tick();
  await runner.tick();

  assert.deepEqual((await store.list()).map((j) => j.state), ['submitted', 'submitted']);
  assert.equal((await store.session()).spent, 8);
  assert.equal((await store.get(ids[0])).relativePath, `${PID}/opening-1`);
  assert.ok(world.log.includes('prepare:opening') && world.log.includes('prepare:closing'));
});

test('an imported batch obeys the session credit cap exactly like single jobs', async () => {
  const { store, runner } = await setup({}, { cap: 5 });
  const plan = planImport({ text: storyboard, filename: 'story.csv', projectId: PID, recipes: catalog });
  await queueImport(store, plan);

  await runner.tick();
  await runner.tick();

  const after = await store.list();
  assert.equal(after[0].state, 'submitted');
  assert.equal(after[1].state, 'failed');
  assert.match(after[1].error, /cap/);
  assert.equal((await store.session()).spent, 4);
});

// ---- References (Ingredients and Frames) ------------------------------------------------------

const REF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const ingSpec = (name, ingredients) => spec(name, {
  recipe: 'abra_r2v_4s_360p',
  settings: { kind: 'video', input: 'ingredients', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
  referencePlan: { input: 'ingredients', ingredients, firstFrame: null, lastFrame: null },
});

test('an Ingredients job resolves its references, attaches them, passes the check and clicks', async () => {
  const { store, world, runner } = await setup();
  const job = await store.add(ingSpec('a', [{ kind: 'mediaId', mediaId: REF_A }, { kind: 'path', path: '/pics/face.png' }]));
  await store.apply(job.id, { type: 'approve' });
  await runner.tick();
  assert.ok(world.log.includes('resolve:a'));
  assert.ok(world.log.indexOf('resolve:a') < world.log.indexOf('prepare:a')); // resolve before prepare

// A character-only job has no photo reference at all, yet it must resolve (that is what records the
// character on the job) and submit: the chip is the reference (report §8.1 step 3, 8.4).
test('a character-only job resolves its character and submits through the ordinary path', async () => {
  const { store, world, runner } = await setup();
  const char = { entityId: '0bfec740-409e-42f5-80d1-82baac3349f3', name: 'nancy' };
  const job = await approved(store, 'char', { referencePlan: { input: 'ingredients', ingredients: [], firstFrame: null, lastFrame: null, characters: [char] } });
  await runner.tick();
  assert.ok(world.log.includes('resolve:char'));
  assert.ok(world.log.includes('click'));
  const after = await store.get(job.id);
  assert.equal(after.state, 'submitted');
  assert.deepEqual(after.references.characters, [char]);
  assert.equal((await store.session()).spent, 4);
});
  assert.ok(world.log.includes('click'));
  const after = await store.get(job.id);
  assert.equal(after.state, 'submitted');
  assert.deepEqual(after.references, { ingredients: [REF_A, 'uploaded--pics-face-png'], firstFrame: null, lastFrame: null });
});

test('an Ingredients job whose composer attached the wrong references fails and never clicks', async () => {
  const { store, world, runner } = await setup({ attachedOverride: { ingredients: [REF_A], firstFrame: null, lastFrame: null } });
  const job = await store.add(ingSpec('a', [{ kind: 'mediaId', mediaId: REF_A }, { kind: 'mediaId', mediaId: REF_B }]));
  await store.apply(job.id, { type: 'approve' });
  await runner.tick();
  assert.ok(!world.log.includes('click'));
  const after = await store.get(job.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /reference/i);
  assert.equal((await store.session()).spent, 0);
});

test('a Frames job resolves the first and last frame and attaches both', async () => {
  const { store, world, runner } = await setup();
  const job = await store.add(spec('a', {
    recipe: 'omni_flash_i2v_4s_first_last_360p',
    settings: { kind: 'video', input: 'frames', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
    referencePlan: { input: 'frames', ingredients: [], firstFrame: { kind: 'path', path: '/a/first.png' }, lastFrame: { kind: 'mediaId', mediaId: REF_B } },
  }));
  await store.apply(job.id, { type: 'approve' });
  // The page must show the Frames input for the mode check to pass.
  world.driver.prepare = (function (orig) { return async (j) => ({ ...(await orig(j)), input: 'frames' }); })(world.driver.prepare);
  await runner.tick();
  assert.ok(world.log.includes('click'));
  const after = await store.get(job.id);
  assert.deepEqual(after.references, { ingredients: [], firstFrame: 'uploaded--a-first-png', lastFrame: REF_B });
});

test('a reference that will not resolve (upload failed) fails the job and never clicks', async () => {
  const { store, world, runner } = await setup();
  world.resolveError = new Error('the upload never appeared in the project within 3 min');
  const job = await store.add(ingSpec('a', [{ kind: 'path', path: '/pics/face.png' }]));
  await store.apply(job.id, { type: 'approve' });
  await runner.tick();
  assert.ok(!world.log.includes('click'));
  const after = await store.get(job.id);
  assert.equal(after.state, 'failed');
  assert.match(after.error, /Could not attach references.*upload never appeared/);
  assert.equal((await store.session()).spent, 0);
});

test('a block while resolving references halts everything', async () => {
  const { store, world, runner } = await setup();
  world.resolveError = Object.assign(new Error('blocked'), { blocked: 'Flow reported UNUSUAL_ACTIVITY' });
  const job = await store.add(ingSpec('a', [{ kind: 'path', path: '/pics/face.png' }]));
  await store.apply(job.id, { type: 'approve' });
  const r = await runner.tick();
  assert.match(r.error, /Halted/);
  assert.equal((await store.session()).halted, true);
  assert.ok(!world.log.includes('click'));
});

// ---- Preview-first ----------------------------------------------------------------------------

// The point of preview-first: once the person approves the free still, the video runs from exactly
// that still, through the ordinary Frames path, and only then does the spend happen.
test('a promoted preview-first video submits with the approved still as its first frame', async () => {
  const { store, world, runner } = await setup();
  const video = await store.add(spec('film', {
    recipe: 'abra_i2v_4s_360p',
    settings: { kind: 'video', input: 'frames', resolution: '360p', durationS: 4, aspect: '16:9', count: 1, refs: [], firstFrame: null, lastFrame: null },
    referencePlan: { input: 'frames', ingredients: [], firstFrame: null, lastFrame: null },
    role: 'video', initialState: 'awaiting-preview',
  }));
  assert.equal((await store.get(video.id)).state, 'awaiting-preview');
  assert.equal((await store.session()).spent, 0); // the still was free and the video is held

  await store.apply(video.id, {
    type: 'promote',
    referencePlan: { input: 'frames', ingredients: [], firstFrame: { kind: 'mediaId', mediaId: REF_A }, lastFrame: null },
    settings: { ...video.settings, input: 'frames', firstFrame: REF_A },
  });
  // The page must show the Frames input for the mode check to pass.
  world.driver.prepare = (function (orig) { return async (j) => ({ ...(await orig(j)), input: 'frames' }); })(world.driver.prepare);

  await runner.tick();
  assert.ok(world.log.includes('click'));
  const after = await store.get(video.id);
  assert.equal(after.state, 'submitted');
  assert.equal(after.references.firstFrame, REF_A);
  assert.equal(after.cost, 4);
  assert.equal((await store.session()).spent, 4); // spent only now, after the still was approved
});

// ---- Cool-down hold (report §9.2) -------------------------------------------------------------

test('time alone never restarts a halted batch: the never-submitted rows wait for the Resume press', async () => {
  let clock = NOW;
  const { store, world, runner } = await setup({}, { now: () => clock });
  const a = await approved(store, 'a');
  await store.halt('UNUSUAL_ACTIVITY from Flow: the request was refused');
  await store.clearHalt();
  clock += 6 * 60 * 60_000; // hours after the halt: exactly the situation a timer would "fix"
  world.log.length = 0;

  const held = await runner.tick();
  assert.ok(!world.log.includes('click'), 'nothing may be submitted without a person pressing Resume');
  assert.match(held.waiting, /Resume/);
  assert.equal((await store.get(a.id)).state, 'approved');

  await store.resume(); // the dashboard press
  await runner.tick();
  assert.ok(world.log.includes('click'));
  assert.equal((await store.get(a.id)).state, 'submitted');
});

test('a resumed row still goes through the pre-spend check, and the cap still stops it', async () => {
  const { store, world, runner } = await setup({}, { cap: 4 });
  const a = await approved(store, 'a');
  const b = await approved(store, 'b');
  await runner.tick(); // a spends the whole cap
  await store.halt('UNUSUAL_ACTIVITY');
  await store.clearHalt();
  await store.resume();
  world.log.length = 0;

  await runner.tick();
  assert.ok(!world.log.includes('click'));
  assert.match((await store.get(b.id)).error, /cap/);
  assert.equal((await store.session()).spent, 4);
});
