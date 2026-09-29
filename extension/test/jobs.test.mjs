import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore } from '../lib/jobs.js';

// Same contract as chrome.storage.local: get(key) → { key: value }, set({ key: value }).
function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
  };
}

const spec = { name: 'fox', projectId: 'p1', prompt: 'a red fox', settings: { kind: 'video' }, recipe: 'abra_t2v_4s_360p', expectedCost: 4 };

async function storeWithCap(cap = 20) {
  const area = memoryArea();
  const store = createJobStore(area);
  await store.setCap(cap);
  return { area, store };
}

test('a job walks the happy path and its state survives a new store on the same storage', async () => {
  const { area, store } = await storeWithCap();
  const { id } = await store.add(spec);
  await store.apply(id, { type: 'approve' });
  await store.apply(id, { type: 'start', tabId: 7 });
  await store.apply(id, { type: 'clicked', at: 1000, cost: 4 });
  await store.apply(id, { type: 'matched', mediaId: 'm1' });
  await store.apply(id, { type: 'ready', mediaId: 'm1' });
  await store.apply(id, { type: 'saved', path: 'FlowPilot/p1/fox.mp4', fileType: 'mp4' });

  const reopened = createJobStore(area); // service worker restarted
  const job = await reopened.get(id);
  assert.equal(job.state, 'done');
  assert.equal(job.mediaId, 'm1');
  assert.equal(job.file.path, 'FlowPilot/p1/fox.mp4');
  assert.deepEqual((await reopened.session()).spent, 4);
});

test('illegal transitions are refused and change nothing', async () => {
  const { store } = await storeWithCap();
  const { id } = await store.add(spec);
  await assert.rejects(store.apply(id, { type: 'clicked', at: 1, cost: 4 }), /queued/);
  assert.equal((await store.get(id)).state, 'queued');
  assert.equal((await store.session()).spent, 0);
});

test('approving twice is harmless', async () => {
  const { store } = await storeWithCap();
  const { id } = await store.add(spec);
  await store.apply(id, { type: 'approve' });
  await store.apply(id, { type: 'approve' });
  assert.equal((await store.get(id)).state, 'approved');
});

test('a click that would pass the cap is refused by the store too', async () => {
  const { store } = await storeWithCap(5);
  const { id } = await store.add(spec);
  await store.apply(id, { type: 'approve' });
  await store.apply(id, { type: 'start', tabId: 7 });
  await store.apply(id, { type: 'clicked', at: 1, cost: 4 });
  const b = await store.add(spec);
  await store.apply(b.id, { type: 'approve' });
  await store.apply(b.id, { type: 'start', tabId: 7 });
  await assert.rejects(store.apply(b.id, { type: 'clicked', at: 2, cost: 4 }), /cap/);
  assert.equal((await store.session()).spent, 4);
});

test('no click is possible without a cap', async () => {
  const store = createJobStore(memoryArea());
  const { id } = await store.add(spec);
  await store.apply(id, { type: 'approve' });
  await store.apply(id, { type: 'start', tabId: 7 });
  await assert.rejects(store.apply(id, { type: 'clicked', at: 1, cost: 0 }), /cap/);
});

test('recovery after a restart: unclicked submit goes back to approved, clicked jobs are never re-submitted', async () => {
  const { area, store } = await storeWithCap();
  const a = await store.add(spec);
  const b = await store.add(spec);
  for (const j of [a, b]) {
    await store.apply(j.id, { type: 'approve' });
    await store.apply(j.id, { type: 'start', tabId: 7 });
  }
  await store.apply(b.id, { type: 'clicked', at: 1, cost: 4 });

  const reopened = createJobStore(area);
  await reopened.recover();
  assert.equal((await reopened.get(a.id)).state, 'approved');
  assert.equal((await reopened.get(b.id)).state, 'submitted');
});

test('halt stops every active job and blocks new clicks until cleared', async () => {
  const { store } = await storeWithCap();
  const a = await store.add(spec);
  const b = await store.add(spec);
  const done = await store.add(spec);
  await store.apply(a.id, { type: 'approve' });
  await store.apply(done.id, { type: 'cancel' });
  await store.halt('UNUSUAL_ACTIVITY');

  assert.equal((await store.session()).halted, true);
  assert.equal((await store.get(a.id)).state, 'halted');
  assert.equal((await store.get(b.id)).state, 'halted');
  assert.equal((await store.get(done.id)).state, 'cancelled');
  await assert.rejects(store.apply(a.id, { type: 'approve' }), /halted/);

  await store.clearHalt();
  assert.equal((await store.get(a.id)).state, 'approved');
  assert.equal((await store.get(b.id)).state, 'queued');
});

test('a failed job may be re-queued only if it never clicked', async () => {
  const { store } = await storeWithCap();
  const a = await store.add(spec);
  await store.apply(a.id, { type: 'approve' });
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'fail', reason: 'prompt mismatch' });
  await store.apply(a.id, { type: 'requeue' });
  assert.equal((await store.get(a.id)).state, 'queued');

  await store.apply(a.id, { type: 'approve' });
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: 1, cost: 4 });
  await store.apply(a.id, { type: 'fail', reason: 'no result' });
  await assert.rejects(store.apply(a.id, { type: 'requeue' }), /already clicked/);
});

test('concurrent applies do not lose writes', async () => {
  const { store } = await storeWithCap();
  const jobs = await Promise.all([1, 2, 3, 4, 5].map(() => store.add(spec)));
  await Promise.all(jobs.map((j) => store.apply(j.id, { type: 'approve' })));
  const states = (await store.list()).map((j) => j.state);
  assert.deepEqual(states, ['approved', 'approved', 'approved', 'approved', 'approved']);
});

test('a failed download can be retried: it goes back to downloading, keeps its media and cost, never re-clicks', async () => {
  const { store } = await storeWithCap();
  const { id } = await store.add(spec);
  await store.apply(id, { type: 'approve' });
  await store.apply(id, { type: 'start', tabId: 7 });
  await store.apply(id, { type: 'clicked', at: 1000, cost: 4 });
  await store.apply(id, { type: 'ready', mediaId: 'm1' });
  await store.apply(id, { type: 'fail', reason: 'Download rejected: expected mp4 for a video, got jpeg' });
  const again = await store.apply(id, { type: 'retryDownload' });
  assert.equal(again.state, 'downloading');
  assert.equal(again.mediaId, 'm1');
  assert.equal(again.error, null);
  assert.equal((await store.session()).spent, 4);

  // Only a job that already has its result can retry a download.
  const other = await store.add(spec);
  await store.apply(other.id, { type: 'fail', reason: 'x' });
  await assert.rejects(store.apply(other.id, { type: 'retryDownload' }), /no result/);
});

test('a download retried during a halt waits as halted, like every other active job, and goes on once cleared', async () => {
  const { store } = await storeWithCap();
  const { id } = await store.add(spec);
  await store.apply(id, { type: 'approve' });
  await store.apply(id, { type: 'start', tabId: 7 });
  await store.apply(id, { type: 'clicked', at: 1000, cost: 4 });
  await store.apply(id, { type: 'ready', mediaId: 'm1' });
  await store.apply(id, { type: 'fail', reason: 'Download rejected' });
  await store.halt('Flow reported UNUSUAL_ACTIVITY');

  const held = await store.apply(id, { type: 'retryDownload' });
  assert.equal(held.state, 'halted');
  assert.equal(held.haltedFrom, 'downloading');
  await store.clearHalt();
  assert.equal((await store.get(id)).state, 'downloading');
});
