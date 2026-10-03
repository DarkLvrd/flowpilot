import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobStore } from '../lib/jobs.js';
import { resumePlan, resumeGate, coolDown, isNeverSubmitted, COOL_DOWN_MINUTES } from '../lib/resume.js';

const NOW = 1_790_569_700_000;
const MIN = 60_000;

// Same contract as chrome.storage.local: get(key) → { key: value }, set({ key: value }).
function memoryArea() {
  const data = {};
  return {
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
  };
}

const job = (over = {}) => ({ id: 'j', name: 'fox', projectId: 'p1', prompt: 'x', expectedCost: 4, clickedAt: null, mayHaveSubmitted: false, ...over });
const session = (over = {}) => ({ cap: 40, spent: 0, halted: false, haltReason: null, haltedAt: null, awaitingResume: false, ...over });
const okCheck = { tabId: 7, ok: true, checks: [{ name: 'Composer', ok: true }] };

// ---- which rows may ever run again ----------------------------------------------------------

test('only never-submitted rows are offered; a submitted or downloading row is never re-run', () => {
  const plan = resumePlan([
    job({ id: 'a', name: 'done', state: 'done', clickedAt: 1, cost: 4 }),
    job({ id: 'b', name: 'downloading', state: 'downloading', clickedAt: 2, cost: 4, mediaId: 'm1' }),
    job({ id: 'c', name: 'rendering', state: 'rendering', clickedAt: 3, cost: 4, mediaId: 'm2' }),
    job({ id: 'd', name: 'ready', state: 'approved' }),
  ]);
  assert.deepEqual(plan.ready.map((j) => j.name), ['ready']);
  assert.deepEqual(plan.waiting, []);
  assert.equal(plan.skipped.length, 3);
  for (const s of plan.skipped) assert.match(s.why, /already submitted/);
});

test('a row that may have reached Flow before the halt is never resumed, and says why', () => {
  const plan = resumePlan([job({ id: 'a', name: 'ghost', state: 'failed', mayHaveSubmitted: true, error: 'Click may not have happened' })]);
  assert.deepEqual(plan.ready, []);
  assert.equal(plan.skipped.length, 1);
  assert.match(plan.skipped[0].why, /may have been submitted/);
  assert.match(plan.skipped[0].why, /check Flow/);
});

test('a queued row is reported as waiting for the person’s approval, not as ready to run', () => {
  const plan = resumePlan([job({ id: 'a', name: 'newt', state: 'queued' })]);
  assert.deepEqual(plan.ready, []);
  assert.deepEqual(plan.waiting.map((j) => j.name), ['newt']);
});

test('rows interrupted mid-submit are ready (they never clicked) and keep their original order', () => {
  const plan = resumePlan([
    job({ id: 'a', name: 'one', state: 'halted', haltedFrom: 'approved' }),
    job({ id: 'b', name: 'two', state: 'halted', haltedFrom: 'submitting' }),
    job({ id: 'c', name: 'three', state: 'halted', haltedFrom: 'queued' }),
  ]);
  assert.deepEqual(plan.ready.map((j) => j.name), ['one', 'two']);
  assert.deepEqual(plan.waiting.map((j) => j.name), ['three']);
});

test('finished and cancelled rows are left alone, and a failure before the click points at Re-queue', () => {
  const plan = resumePlan([
    job({ id: 'a', state: 'cancelled' }),
    job({ id: 'b', state: 'done', clickedAt: 1, cost: 4 }),
    job({ id: 'c', name: 'oops', state: 'failed', error: 'prompt mismatch' }),
  ]);
  assert.deepEqual(plan.ready, []);
  assert.equal(plan.skipped.find((s) => s.id === 'c').why.includes('Re-queue'), true);
});

test('isNeverSubmitted is the single rule the plan and the receipt share', () => {
  assert.equal(isNeverSubmitted(job({ state: 'approved' })), true);
  assert.equal(isNeverSubmitted(job({ state: 'submitted', clickedAt: 5 })), false);
  assert.equal(isNeverSubmitted(job({ state: 'failed', mayHaveSubmitted: true })), false);
});

// The preview-first shape: a held video is not something a Resume should run.
test('a preview-first job held on its free still is not resumed, and says what it is waiting for', () => {
  const plan = resumePlan([
    job({ id: 'a', name: 'film', state: 'awaiting-preview', role: 'video' }),
    job({ id: 'b', name: 'look', state: 'done', role: 'preview', clickedAt: 1, cost: 0 }),
  ]);
  assert.deepEqual(plan.ready, []);
  assert.deepEqual(plan.waiting, []);
  const film = plan.skipped.find((s) => s.id === 'a');
  assert.match(film.why, /preview/i);
  assert.match(film.why, /approve/i);
});

// ---- the cool-down --------------------------------------------------------------------------

test('the cool-down explains the halt in plain words and gives a wait a person can follow', () => {
  const c = coolDown({ haltReason: 'UNUSUAL_ACTIVITY from Flow: the request was refused', haltedAt: NOW, now: NOW + 10 * MIN });
  assert.equal(c.waitMinutes, COOL_DOWN_MINUTES);
  assert.equal(c.earliestAt, NOW + COOL_DOWN_MINUTES * MIN);
  assert.equal(c.remainingMinutes, 50);
  assert.match(c.why, /unusual.?activity/i);
  assert.ok(c.checklist.length >= 3);
  assert.ok(c.checklist.some((l) => /credit balance/i.test(l)));
  assert.ok(c.checklist.some((l) => /Flow yourself|open Flow/i.test(l)));
  // It never says "Flow Pilot will retry" — the whole point of the item is that it will not.
  assert.ok(!/will retry|automatically/i.test(c.note));
});

test('the cool-down is advice, not a lock: after the wait it is simply ready, never automatic', () => {
  const c = coolDown({ haltReason: 'blocked', haltedAt: NOW, now: NOW + 61 * MIN });
  assert.equal(c.remainingMinutes, 0);
  assert.match(c.note, /never resumes by itself|your choice/i);
});

test('an unknown halt reason is still explained without inventing a cause', () => {
  const c = coolDown({ haltReason: 'something odd', haltedAt: NOW, now: NOW });
  assert.match(c.why, /something odd/);
  assert.equal(c.remainingMinutes, COOL_DOWN_MINUTES);
});

// ---- the gate -------------------------------------------------------------------------------

test('resume refuses while the halt is still set, quoting the halt', () => {
  const g = resumeGate({ session: session({ halted: true, haltReason: 'UNUSUAL_ACTIVITY: refused', haltedAt: NOW }), selfCheck: okCheck, workTab: { tabId: 7 }, plan: { ready: [job({ state: 'approved' })], waiting: [] }, now: NOW });
  assert.equal(g.ok, false);
  assert.match(g.blockers.join(' '), /halt is still set/);
  assert.ok(g.blockers.join(' ').includes('UNUSUAL_ACTIVITY: refused'));
});

test('resume refuses while the self-check is still failing, naming the failing step', () => {
  const selfCheck = { tabId: 7, ok: false, checks: [{ name: 'Composer', ok: false, detail: 'Generate button is disabled' }, { name: 'Model catalog', ok: true }] };
  const g = resumeGate({ session: session(), selfCheck, workTab: { tabId: 7 }, plan: { ready: [job({ state: 'approved' })], waiting: [] }, now: NOW });
  assert.equal(g.ok, false);
  assert.match(g.blockers.join(' '), /Composer/);
  assert.match(g.blockers.join(' '), /still failing|Flow may have changed|Fix/);
});

test('resume refuses without a self-check, or with one from a different tab', () => {
  const none = resumeGate({ session: session(), selfCheck: null, workTab: { tabId: 7 }, plan: { ready: [] }, now: NOW });
  assert.equal(none.ok, false);
  assert.match(none.blockers.join(' '), /self-check/);

  const stale = resumeGate({ session: session(), selfCheck: { ...okCheck, tabId: 9 }, workTab: { tabId: 7 }, plan: { ready: [] }, now: NOW });
  assert.equal(stale.ok, false);
  assert.match(stale.blockers.join(' '), /different tab/);
});

test('the gate lets a person resume before the cool-down if they choose, but warns them', () => {
  const c = coolDown({ haltReason: 'blocked', haltedAt: NOW, now: NOW + MIN });
  const g = resumeGate({ session: session({ haltedAt: NOW }), selfCheck: okCheck, workTab: { tabId: 7 }, plan: { ready: [job({ state: 'approved' })], waiting: [] }, now: NOW + MIN, coolDown: c });
  assert.equal(g.ok, true);
  assert.match(g.warnings.join(' '), /59 min left/);
  assert.match(g.warnings.join(' '), /your choice|never resumes by itself/i);
});

test('the gate warns when there is nothing to resume instead of pretending to act', () => {
  const g = resumeGate({ session: session(), selfCheck: okCheck, workTab: { tabId: 7 }, plan: { ready: [], waiting: [job({ state: 'queued' })] }, now: NOW + 61 * MIN });
  assert.equal(g.ok, true);
  assert.match(g.warnings.join(' '), /Nothing will be submitted|waiting for approval/);
});

// ---- the store and the runner ---------------------------------------------------------------

const spec = { name: 'fox', projectId: 'p1', prompt: 'a red fox', settings: { kind: 'video' }, recipe: 'abra_t2v_4s_360p', expectedCost: 4 };

test('clearing a halt holds the never-submitted rows until an explicit resume', async () => {
  const store = createJobStore(memoryArea());
  await store.setCap(40);
  const a = await store.add(spec);
  const b = await store.add(spec);
  await store.apply(a.id, { type: 'approve' });
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: 1, cost: 4 }); // a is on Flow's side now
  await store.apply(b.id, { type: 'approve' });
  await store.halt('UNUSUAL_ACTIVITY: refused');

  const held = await store.clearHalt();
  assert.equal(held.halted, false);
  assert.equal(held.awaitingResume, true, 'the never-submitted row waits for a press, not for a timer');
  // The row that already reached Flow keeps going to its result; it is never re-submitted.
  assert.equal((await store.get(a.id)).state, 'submitted');
  assert.equal((await store.get(b.id)).state, 'approved');

  const resumed = await store.resume();
  assert.equal(resumed.awaitingResume, false);
});

test('a halt with nothing left to submit does not hold the queue', async () => {
  const store = createJobStore(memoryArea());
  await store.setCap(40);
  const a = await store.add(spec);
  await store.apply(a.id, { type: 'approve' });
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: 1, cost: 4 });
  await store.halt('blocked');
  const cleared = await store.clearHalt();
  assert.equal(cleared.awaitingResume, false);
});

test('the cap still refuses a resumed row that would pass it', async () => {
  const store = createJobStore(memoryArea());
  await store.setCap(5);
  const a = await store.add(spec);
  const b = await store.add(spec);
  await store.apply(a.id, { type: 'approve' });
  await store.apply(a.id, { type: 'start', tabId: 7 });
  await store.apply(a.id, { type: 'clicked', at: 1, cost: 4 }); // 4 of 5 spent
  await store.apply(b.id, { type: 'approve' });
  await store.halt('UNUSUAL_ACTIVITY');
  await store.clearHalt();
  await store.resume();
  await store.apply(b.id, { type: 'start', tabId: 7 });
  await assert.rejects(store.apply(b.id, { type: 'clicked', at: 2, cost: 4 }), /cap/);
  assert.equal((await store.session()).spent, 4);
});
