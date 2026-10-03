// Boots the real service worker against a fake `chrome` and a fake Flow tab serving recon fixtures.
// Checks the wiring (messages, self-check, add job with cost, who may set the cap); no browser needed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { expandPromptSet } from '../lib/promptset.js';

const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';
const EXT = 'chrome-extension://abc/';
const data = {};
const writes = [];
let listener;
let onFocus, onActivated; // window focus and tab switch listeners
const focusCalls = []; // tabs.update / windows.update calls (bringing the work tab forward)
const tabs = { 7: { id: 7, windowId: 1, url: `https://flow.google.com/project/${PID}` } };
const driverChecks = [{ name: 'Prompt box', ok: true }];
let rateLimited = false; // next RPC answers HTTP 429
let mediaFixture = 'Zzl0ze'; // Zzl0ze answers this fixture; a test can point it at another project
const CHAR_PROJECT = 'de7baa89-1896-4825-bf06-ab0853619277';

globalThis.chrome = {
  runtime: {
    id: 'abc',
    getURL: (p) => EXT + p,
    getManifest: () => ({ version: '0.1.0' }),
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
  windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: (fn) => { onFocus = fn; } }, async update(id, info) { focusCalls.push({ window: id, ...info }); } },
  tabs: {
    async get(id) { if (!tabs[id]) throw new Error('no tab'); return tabs[id]; },
    async update(id, info) { focusCalls.push({ tab: id, ...(info ?? {}) }); },
    async sendMessage(_id, msg) { return msg.cmd === 'selfCheck' ? { ok: true, value: driverChecks } : { ok: false, error: 'not in smoke test' }; },
    onUpdated: { addListener() {} },
    onActivated: { addListener: (fn) => { onActivated = fn; } },
  },
  scripting: {
    async executeScript({ args: [rpcid] }) {
      if (rateLimited) return [{ result: { status: 429, text: '' } }];
      const known = { nzlxg: 'nzlxg', HTrJv: 'HTrJv', yBhWQ: 'yBhWQ', Zzl0ze: mediaFixture };
      return [{ result: known[rpcid] ? { status: 200, text: fixture(known[rpcid]) } : { status: 400, text: '' } }];
    },
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  downloads: {},
};

// The helper bridge's socket: the tests play the helper's side.
const sockets = [];
globalThis.WebSocket = class FakeSocket {
  constructor(url) { this.url = url; this.sent = []; this.listeners = {}; sockets.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close', {}); }
  emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); }
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

test('an Ingredients job (reference media id) is queued as a reference-to-video generation', async () => {
  const REF = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
  const r = await send({ cmd: 'addJob', spec: { name: 'ref', prompt: 'x', input: 'ingredients', refs: [REF], resolution: '360p', durationS: 4 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.recipe, 'abra_r2v_4s_360p');
  assert.equal(r.value.expectedCost, 4);
  assert.deepEqual(r.value.referencePlan.ingredients, [{ kind: 'mediaId', mediaId: REF }]);
  assert.equal(r.value.settings.input, 'ingredients');
});

test('a Frames job (first + last frame) is queued as a first-last generation', async () => {
  const A = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
  const B = '63078305-0723-426c-ab9f-36657a5e0801';
  const r = await send({ cmd: 'addJob', spec: { name: 'frames', prompt: 'x', input: 'frames', firstFrame: A, lastFrame: B, resolution: '360p', durationS: 4 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.recipe, 'omni_flash_i2v_4s_first_last_360p');
  assert.equal(r.value.settings.input, 'frames');
  assert.deepEqual(r.value.referencePlan.firstFrame, { kind: 'mediaId', mediaId: A });
  assert.deepEqual(r.value.referencePlan.lastFrame, { kind: 'mediaId', mediaId: B });
});

test('a job with a malformed reference is refused with a clear error', async () => {
  const r = await send({ cmd: 'addJob', spec: { prompt: 'x', input: 'ingredients', refs: ['not-an-id-or-path'] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /media id or an absolute path/);
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
  // Clearing a halt holds the rows that never clicked until a person presses Resume; these tests
  // only care about the rest of the wiring, so release the hold the way a person would.
  assert.equal((await send({ cmd: 'resumeUnsubmitted' })).ok, true);
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

// A prompt built by "describe it once" must be usable straight in the job form: same bytes, no
// reformatting, so what the person approved is what the driver pastes.
test('a prompt from the describe-it-once helper is accepted by the job form verbatim', async () => {
  const [first] = expandPromptSet('a red fox in the snow', { scenes: 1, style: 'cinematic' });
  const r = await send({ cmd: 'addJob', spec: { name: 'from-helper', prompt: first.prompt, kind: 'video', input: 'text', resolution: '360p', durationS: 4 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.prompt, first.prompt);
});

// ---- Preview-first ---------------------------------------------------------------------------

const STILL_MEDIA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// Puts a job the extension already queued into the state a finished still would be in.
const markStillDone = (id) => {
  data['flowpilot'].jobs = data['flowpilot'].jobs.map((j) =>
    (j.id === id ? { ...j, state: 'done', mediaId: STILL_MEDIA, file: { path: 'FlowPilot/x/still.png', type: 'png' } } : j));
};

test('preview-first queues a free still and holds the video until that still is approved', async () => {
  const r = await send({ cmd: 'previewJob', spec: { name: 'fox film', prompt: 'a red fox in snow', resolution: '360p', durationS: 4 } });
  assert.equal(r.ok, true, r.error);
  const { still, video } = r.value;
  assert.equal(still.settings.kind, 'image');
  assert.equal(still.expectedCost, 0);        // Flow charges nothing for a still
  assert.equal(still.state, 'queued');
  assert.equal(still.role, 'preview');
  assert.equal(video.state, 'awaiting-preview');
  assert.equal(video.role, 'video');
  assert.equal(video.previewJobId, still.id);
  assert.equal(video.expectedCost, 4);        // the eventual video's cost is known while it waits
  assert.equal(video.recipe, 'abra_i2v_4s_360p');
  assert.equal(video.settings.input, 'frames');
});

test('preview-first refuses ingredient references and a first frame: it builds the first frame from the still', async () => {
  const REF = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
  const a = await send({ cmd: 'previewJob', spec: { name: 'x', prompt: 'p', refs: [REF] } });
  assert.equal(a.ok, false);
  assert.match(a.error, /Frames|ingredient/i);
  const b = await send({ cmd: 'previewJob', spec: { name: 'x', prompt: 'p', firstFrame: REF } });
  assert.equal(b.ok, false);
  assert.match(b.error, /first frame/i);
});

test('a held video cannot be approved, and promoting it fails until the still has finished', async () => {
  const r = await send({ cmd: 'previewJob', spec: { name: 'held', prompt: 'p', resolution: '360p', durationS: 4 } });
  const { video } = r.value;
  assert.match((await send({ cmd: 'approve', id: video.id })).error, /awaiting-preview/);
  const p = await send({ cmd: 'promotePreview', id: video.id });
  assert.equal(p.ok, false);
  assert.match(p.error, /still/i);
  assert.equal((await send({ cmd: 'status' })).value.counts.awaitingPreview >= 1, true);
});

test('promoting a held video attaches the finished still as its first frame and spends nothing', async () => {
  const r = await send({ cmd: 'previewJob', spec: { name: 'shoot', prompt: 'p', resolution: '360p', durationS: 4 } });
  const { still, video } = r.value;
  markStillDone(still.id);
  const p = await send({ cmd: 'promotePreview', id: video.id });
  assert.equal(p.ok, true, p.error);
  assert.equal(p.value.state, 'approved');
  assert.equal(p.value.settings.firstFrame, STILL_MEDIA);
  assert.deepEqual(p.value.referencePlan.firstFrame, { kind: 'mediaId', mediaId: STILL_MEDIA });
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0);
});

test('only the dashboard may promote a still (the popup cannot)', async () => {
  const r = await send({ cmd: 'previewJob', spec: { name: 'gate', prompt: 'p' } });
  assert.match((await send({ cmd: 'promotePreview', id: r.value.video.id }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);
});

test('the Flow tab can be brought forward on a person’s click, and the status counts the jobs waiting', async () => {
  await send({ cmd: 'useTab', tabId: 7 });
  focusCalls.length = 0;
  const r = await send({ cmd: 'focusWorkTab' });
  assert.equal(r.ok, true, r.error);
  assert.ok(focusCalls.some((c) => c.tab === 7 && c.active === true), JSON.stringify(focusCalls));
  assert.ok(focusCalls.some((c) => c.window === 1 && c.focused === true), JSON.stringify(focusCalls));
  const s = (await send({ cmd: 'status' })).value;
  assert.equal(typeof s.counts.awaitingPreview, 'number');
  assert.equal(s.counts.approved > 0, true); // jobs approved but not yet submitted wait for the front tab
  assert.equal(s.waitingFor.reason, 'front-tab');
  assert.equal(s.waitingFor.count, s.counts.approved);
});

// ---- A linked Flow Character becomes a job (BUG-2/4) ----------------------------------------

// The Flow Character the live account holds (recon/FINDINGS.md, project de7baa89…): the id Flow
// gave it, which is the only id its picker and its generation record know.
const FLOW_CHAR = { name: 'nancy', entityId: '0bfec740-409e-42f5-80d1-82baac3349f3', primaryMediaId: 'b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca' };

// An approved library entity that IS a Flow Character, added the way the MCP/CLI path does it.
const linkCharacter = async () => {
  const r = await send({ cmd: 'entityUpsert', entity: { name: 'LinkedNancy', kind: 'character', description: 'CHARACTER — NANCY (identical in every shot)', approved: true, flowCharacter: FLOW_CHAR } });
  assert.equal(r.ok, true, r.error);
};

// `flowpilot add --entity nancy` names a library entity; the composed block used to be sent with the
// character dropped, so no documented path turned a linked character into a job.
test('a job that names a linked Flow Character carries Flow\'s entity id, and the picker attaches it', async () => {
  await linkCharacter();
  const r = await send({ cmd: 'addJob', spec: { name: 'nancy-rooftop', prompt: 'she waits by the car', kind: 'video', resolution: '360p', durationS: 4, entities: ['LinkedNancy'] } });
  assert.equal(r.ok, true, r.error);
  // Flow's own entity id, never the library id (`ent_…`): classifyCharacter refuses anything else.
  assert.deepEqual(r.value.settings.characters, [{ entityId: FLOW_CHAR.entityId, name: 'nancy' }]);
  assert.deepEqual(r.value.referencePlan.characters, [{ entityId: FLOW_CHAR.entityId, name: 'nancy' }]);
  // A character rides in the Ingredients bar, so the job is an Ingredients one even with no photo.
  assert.equal(r.value.settings.input, 'ingredients');
  assert.match(r.value.recipe, /r2v/);
  assert.equal(r.value.expectedCost, 4); // priced as a reference job, shown before any click
  // The composed block is still composed: the same job, one prompt, both facts.
  assert.match(r.value.prompt, /CHARACTER — NANCY/);
  assert.deepEqual(r.value.entities.map((e) => e.entityId.startsWith('ent_')), [true]); // the library id, for the record
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0);
});

test('naming an entity that is not a Flow Character changes nothing about characters', async () => {
  await send({ cmd: 'entityUpsert', entity: { name: 'PlainRudy', kind: 'character', description: 'a heavyset man in his 30s', approved: true, refs: [{ mediaId: REF_MEDIA, role: 'sheet', label: 'plainrudy_sheet_v1' }] } });
  const r = await send({ cmd: 'addJob', spec: { name: 'plain', prompt: 'he waits', kind: 'video', resolution: '360p', durationS: 4, entities: ['PlainRudy'] } });
  assert.equal(r.ok, true, r.error);
  // Its block is composed (that is what naming an entity is for) and no character is invented.
  assert.match(r.value.prompt, /heavyset man in his 30s/);
  assert.equal('characters' in r.value.settings, false);
  assert.equal('characters' in r.value.referencePlan, false);
  // The entity's locked reference photos are not silently turned into Ingredients either: only a
  // shot plan or an explicit `refs` puts a photo in the composer.
  assert.deepEqual(r.value.referencePlan.ingredients, []);
  assert.equal(r.value.referencePlan.input, 'text');
});

// A link that cannot be carried must fail loudly: Frames has no character chip, so attaching it
// could never be verified and the clip would be paid for without the subject.
test('a linked Flow Character in a Frames job is refused, never silently dropped', async () => {
  const r = await send({ cmd: 'addJob', spec: { name: 'framed', prompt: 'she turns', kind: 'video', resolution: '360p', durationS: 4, firstFrame: REF_MEDIA, entities: ['LinkedNancy'] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /Frames/i);
  assert.match(r.error, /nancy/i);
  // And the still preview, which runs in Frames, is refused for the same reason.
  const p = await send({ cmd: 'previewJob', spec: { name: 'held', prompt: 'p', entities: ['LinkedNancy'] } });
  assert.equal(p.ok, false);
  assert.match(p.error, /Frames|Character/i);
});

test('the linked-character tests leave the entity library as they found it', async () => {
  await send({ cmd: 'entityRemove', name: 'LinkedNancy' });
  await send({ cmd: 'entityRemove', name: 'PlainRudy' });
  assert.deepEqual((await send({ cmd: 'entities' })).value.library.entities, []);
});

// ---- Shots and the still→anchor gate (report §2.3-§2.5, Phase 2) ------------------------------

const REF_MEDIA = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';

// An approved character with a locked reference, then a shot list that names it: importing queues a
// free still job per row and never a video job.
const importOneShot = async (row) => {
  await send({ cmd: 'entityUpsert', entity: { name: 'ShotRudy', kind: 'character', description: 'a heavyset Black man in his 30s', approved: true, refs: [{ mediaId: REF_MEDIA, role: 'sheet', label: 'shotrudy_sheet_v1' }] } });
  const r = await send({ cmd: 'importShots', rows: [row] });
  assert.equal(r.ok, true, r.error);
  return r.value.added[0];
};

test('importing a shot list queues one free still per row and no video job at all', async () => {
  const added = await importOneShot({ scene: 4, beat: 'driving home', entities: ['ShotRudy'], mode: 'ingredients' });
  assert.equal(added.videoCost, 7); // abra_r2v_4s at the default 720p, shown before any click
  const shots = (await send({ cmd: 'shots' })).value.shots;
  const shot = shots.find((s) => s.id === added.shotId);
  assert.equal(shot.mode, 'ingredients');
  assert.equal(shot.still.jobId, added.stillJobId);
  assert.equal(shot.videoJob, null);
  assert.equal(shot.gate.ok, false);
  assert.equal((await send({ cmd: 'status' })).value.jobs.find((j) => j.id === added.stillJobId).settings.kind, 'image');
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0);
});

test('the gate: a shot with no finished still cannot create a video job', async () => {
  const added = await importOneShot({ scene: 5, entities: ['ShotRudy'], mode: 'ingredients' });
  const r = await send({ cmd: 'approveAnchor', shotId: added.shotId });
  assert.equal(r.ok, false);
  assert.match(r.error, /no finished still|still/i);
});

test('approving a finished still records the ledger entry and materialises the video job', async () => {
  const added = await importOneShot({ scene: 6, entities: ['ShotRudy'], mode: 'ingredients' });
  markStillDone(added.stillJobId);
  const r = await send({ cmd: 'approveAnchor', shotId: added.shotId, note: 'identity matches the sheet' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.video.state, 'queued');
  assert.equal(r.value.video.settings.input, 'ingredients');
  assert.deepEqual(r.value.video.referencePlan.ingredients, [{ kind: 'mediaId', mediaId: REF_MEDIA }]);
  assert.equal(r.value.video.anchor.shotId, added.shotId);
  assert.equal(r.value.video.anchor.startFrameMediaId, STILL_MEDIA);
  assert.equal(typeof r.value.video.anchor.approvedAt, 'number');
  assert.equal(r.value.approval.approvedBy, 'dashboard');
  assert.equal(r.value.approval.note, 'identity matches the sheet');
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0); // nothing clicked, nothing spent
  const shot = (await send({ cmd: 'shots' })).value.shots.find((s) => s.id === added.shotId);
  assert.equal(shot.gate.ok, true);
  assert.equal(shot.videoJob.id, r.value.video.id);
});

test('a Frames shot is anchored to the approved still as its first frame', async () => {
  const added = await importOneShot({ scene: 7, entities: ['ShotRudy'], mode: 'frames' });
  markStillDone(added.stillJobId);
  const r = await send({ cmd: 'approveAnchor', shotId: added.shotId });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.video.settings.input, 'frames');
  assert.deepEqual(r.value.video.referencePlan.firstFrame, { kind: 'mediaId', mediaId: STILL_MEDIA });
  assert.equal(r.value.video.recipe, 'abra_i2v_4s');
});

test('queueing a new still supersedes the approval, so the old one can never carry forward', async () => {
  const added = await importOneShot({ scene: 8, entities: ['ShotRudy'], mode: 'ingredients' });
  markStillDone(added.stillJobId);
  assert.equal((await send({ cmd: 'approveAnchor', shotId: added.shotId })).ok, true);
  const requeued = await send({ cmd: 'queueStill', shotId: added.shotId });
  assert.equal(requeued.ok, true, requeued.error);
  const shot = (await send({ cmd: 'shots' })).value.shots.find((s) => s.id === added.shotId);
  assert.equal(shot.gate.ok, false);
  assert.equal(shot.still.jobId, requeued.value.still.id);
  assert.match(shot.gate.problems.join(' '), /not approved|new still/i);
  // The video job created before the re-anchor still exists and is never rewritten.
  assert.equal(shot.videoJob.id, requeued.value.shot.videoJobId);
});

test('a shot list with an unknown entity is refused whole, and an agent may approve a still too', async () => {
  await send({ cmd: 'entityUpsert', entity: { name: 'ShotRudy', kind: 'character', description: 'a heavyset man', approved: true, refs: [{ mediaId: REF_MEDIA, role: 'sheet', label: 'shotrudy_sheet_v1' }] } });
  const bad = await send({ cmd: 'importShots', rows: [{ scene: 9, entities: ['Ghost'] }] });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown entity "Ghost"/);
  assert.equal((await send({ cmd: 'shots' })).value.shots.some((s) => s.scene === 9), false);
  const good = await send({ cmd: 'importShots', rows: [{ scene: 10, entities: ['ShotRudy'], mode: 'ingredients' }] });
  markStillDone(good.value.added[0].stillJobId);
  // An agent (the popup or the helper bridge, not the dashboard) may approve: decision 7 says
  // approval is an assertion, and the ledger records who did it.
  const r = await send({ cmd: 'approveAnchor', shotId: good.value.added[0].shotId }, `${EXT}popup/popup.html`);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.approval.approvedBy, 'agent');
});

test('the shot tests leave the entity library as they found it', async () => {
  await send({ cmd: 'entityRemove', name: 'ShotRudy' });
  assert.deepEqual((await send({ cmd: 'entities' })).value.library.entities, []);
});

test('a hand-written job cannot claim a shot anchor; only approving a still can', async () => {
  const r = await send({ cmd: 'addJob', spec: { prompt: 'x', firstFrame: REF_MEDIA, anchor: { shotId: 'shot_99', startFrameMediaId: REF_MEDIA } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /anchor/i);
});

// ---- The QC loop (report §2.6, Phase 3) -------------------------------------------------------

const VIDEO_MEDIA = '5a5a5a5a-1111-4111-8111-111111111111';

// Puts a job the extension already queued into the state a finished clip would be in (the runner
// downloads and byte-checks a video exactly like a still before `done`).
const markVideoDone = (id) => {
  data['flowpilot'].jobs = data['flowpilot'].jobs.map((j) => (j.id === id
    ? { ...j, state: 'done', mediaId: VIDEO_MEDIA, file: { path: `FlowPilot/x/${id}.mp4`, type: 'mp4' }, references: { ingredients: [REF_MEDIA], firstFrame: null, lastFrame: null, names: {} } }
    : j));
};

// A shot whose still is approved and whose video job has finished: the clip a Review card shows.
const finishedClip = async (scene, mode = 'ingredients') => {
  const added = await importOneShot({ scene, entities: ['ShotRudy'], mode });
  markStillDone(added.stillJobId);
  const video = (await send({ cmd: 'approveAnchor', shotId: added.shotId })).value.video;
  markVideoDone(video.id);
  return { shotId: added.shotId, stillJobId: added.stillJobId, video };
};

const PASS5 = { identity: 'pass', wardrobe: 'pass', location: 'pass', artefacts: 'pass', style: 'pass' };

let reviewed; // the clip the fix tests work from, recorded once below

test('a QC verdict is recorded on a finished clip as metadata, with technical computed not trusted', async () => {
  reviewed = await finishedClip(11);
  const r = await send({ cmd: 'qcSet', id: reviewed.video.id, checks: { ...PASS5, wardrobe: 'fail' }, note: 'rear half of the car went flat bronze after 2s' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value.qc.checks, { technical: 'pass', ...PASS5, wardrobe: 'fail' });
  assert.equal(r.value.qc.verdict, 'regen');
  assert.equal(r.value.qc.by, 'human');
  assert.equal(r.value.qc.note, 'rear half of the car went flat bronze after 2s');
  assert.equal(typeof r.value.qc.checkedAt, 'number');
  assert.equal(r.value.state, 'done'); // written like `references`: no state change, no click, no spend
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0);
  // The verdict is derived from the checks: a caller cannot state a technical result that contradicts
  // the job, and a clip the machine itself rejected is blocked rather than approved.
  const contradict = await send({ cmd: 'qcSet', id: reviewed.video.id, checks: { ...PASS5, technical: 'fail' } });
  assert.equal(contradict.ok, false);
  assert.match(contradict.error, /automatic/);
  const incomplete = await send({ cmd: 'qcSet', id: reviewed.video.id, checks: { identity: 'pass' } });
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /wardrobe/);
  // A clip that has not finished has nothing to review yet.
  const pending = (await send({ cmd: 'addJob', spec: { name: 'pending fox', prompt: 'a red fox', resolution: '360p', durationS: 4 } })).value;
  const running = await send({ cmd: 'qcSet', id: pending.id, checks: PASS5 });
  assert.equal(running.ok, false);
  assert.match(running.error, /review|finished|done/i);
});

test('the technical check reads a machine-rejected clip as blocked, and no fix is offered', async () => {
  const added = await importOneShot({ scene: 12, entities: ['ShotRudy'], mode: 'ingredients' });
  markStillDone(added.stillJobId);
  const video = (await send({ cmd: 'approveAnchor', shotId: added.shotId })).value.video;
  markVideoDone(video.id);
  data['flowpilot'].jobs = data['flowpilot'].jobs.map((j) => (j.id === video.id ? { ...j, file: { path: 'x.png', type: 'png' } } : j));
  const r = await send({ cmd: 'qcSet', id: video.id, checks: PASS5 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.qc.verdict, 'blocked');
  assert.equal(r.value.qc.checks.technical, 'fail');
  const fix = await send({ cmd: 'qcFix', id: video.id, check: 'technical' });
  assert.equal(fix.ok, false);
  assert.match(fix.error, /no fix|nothing to fix/i);
});

test('a video-only fix appends a block and makes a new video from the still already approved', async () => {
  const clip = await finishedClip(13);
  await send({ cmd: 'qcSet', id: clip.video.id, checks: { ...PASS5, artefacts: 'fail' }, note: 'a watermark appeared bottom-right' });
  const before = (await send({ cmd: 'status' })).value.jobs.find((j) => j.id === clip.video.id);
  const baseHash = before.promptParts.filter((p) => p.kind !== 'consistency').map((p) => p.sha256).join(',');
  const r = await send({ cmd: 'qcFix', id: clip.video.id, check: 'artefacts' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.still, null); // a video-only fix needs no new still
  assert.equal(r.value.video.state, 'queued');
  assert.equal(r.value.video.expectedCost, 7); // the price shown before the fix is taken (720p r2v)
  assert.notEqual(r.value.video.id, clip.video.id);
  assert.equal(r.value.video.anchor.startFrameMediaId, STILL_MEDIA); // the same approved still, untouched
  // The new video carries the appended block; the failed take is untouched on disk and in the record.
  assert.equal(r.value.video.promptParts.at(-1).kind, 'consistency');
  assert.equal(r.value.video.promptParts.at(-1).ref, 'artefacts_fix');
  assert.equal(r.value.video.promptParts.at(-1).text, 'a watermark appeared bottom-right');
  assert.equal(r.value.video.prompt.endsWith('a watermark appeared bottom-right'), true);
  assert.deepEqual(r.value.video.promptParts.slice(0, before.promptParts.length).map((p) => p.sha256), before.promptParts.map((p) => p.sha256));
  const after = (await send({ cmd: 'status' })).value.jobs.find((j) => j.id === clip.video.id);
  assert.equal(after.file.path, before.file.path);
  assert.deepEqual(after.promptParts, before.promptParts);
  assert.equal(after.state, 'done'); // the failed take stays, on disk and in the queue
  assert.equal((await send({ cmd: 'shots' })).value.shots.find((s) => s.id === clip.shotId).videoJob.id, r.value.video.id);
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0); // queued, not clicked
  // The shot's own base parts are byte-identical: the fix only appended.
  const shot = (await send({ cmd: 'shots' })).value.shots.find((s) => s.id === clip.shotId);
  assert.equal(shot.promptParts.filter((p) => p.kind !== 'consistency').map((p) => p.sha256).join(','), baseHash);
});

test('a still fix queues a free still, supersedes the old approval, and still writes nothing by itself', async () => {
  const clip = await finishedClip(14);
  await send({ cmd: 'qcSet', id: clip.video.id, checks: { ...PASS5, wardrobe: 'fail' }, note: 'the jacket turned grey' });
  const r = await send({ cmd: 'qcFix', id: clip.video.id, check: 'wardrobe' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.video, null); // the still comes first: no video exists until it is approved
  assert.equal(r.value.still.expectedCost, 0); // a still is free
  assert.equal(r.value.still.settings.kind, 'image');
  assert.equal(r.value.still.promptParts.at(-1).text, 'the jacket turned grey');
  const shot = (await send({ cmd: 'shots' })).value.shots.find((s) => s.id === clip.shotId);
  assert.equal(shot.gate.ok, false); // the old approval was superseded, never carried forward
  assert.equal(shot.still.jobId, r.value.still.id);
  assert.equal(shot.videoJob.id, clip.video.id); // the old video row is untouched
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0);
  // With that new still finished, approving it builds a video that carries the fix.
  markStillDone(r.value.still.id);
  const anchored = await send({ cmd: 'approveAnchor', shotId: clip.shotId });
  assert.equal(anchored.ok, true, anchored.error);
  assert.equal(anchored.value.video.promptParts.at(-1).ref, 'wardrobe_fix');
});

test('a fix is refused when there is no verdict, no failure, or no fix to offer', async () => {
  const clip = await finishedClip(15);
  const noVerdict = await send({ cmd: 'qcFix', id: clip.video.id, check: 'identity' });
  assert.equal(noVerdict.ok, false);
  assert.match(noVerdict.error, /QC/i);
  await send({ cmd: 'qcSet', id: clip.video.id, checks: PASS5 });
  const notFailed = await send({ cmd: 'qcFix', id: clip.video.id, check: 'identity' });
  assert.equal(notFailed.ok, false);
  assert.match(notFailed.error, /not a failed check/i);
  const unknown = await send({ cmd: 'qcFix', id: clip.video.id, check: 'vibes' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown check/);
});

test('a fix for a clip that is not part of a shot makes a new job from the same spec', async () => {
  const plain = (await send({ cmd: 'addJob', spec: { name: 'plain clip', prompt: 'a red fox in snow', kind: 'video', input: 'ingredients', refs: [REF_MEDIA], resolution: '360p', durationS: 4 } })).value;
  markVideoDone(plain.id);
  await send({ cmd: 'qcSet', id: plain.id, checks: { ...PASS5, style: 'fail' }, note: 'it drifted photoreal' });
  const r = await send({ cmd: 'qcFix', id: plain.id, check: 'style' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.video.settings.input, 'ingredients');
  assert.deepEqual(r.value.video.referencePlan.ingredients, [{ kind: 'mediaId', mediaId: REF_MEDIA }]);
  assert.equal(r.value.video.promptParts.at(-1).ref, 'style_fix');
  assert.equal(r.value.video.prompt, 'a red fox in snow\n\nit drifted photoreal');
  assert.equal((await send({ cmd: 'status' })).value.jobs.find((j) => j.id === plain.id).state, 'done');
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0);
  // A job that was never composed from the library has no parts: the base prompt is its own part,
  // and the fix appends to it instead of replacing it.
  // An identity failure asks for a free image job instead, with the same references.
  await send({ cmd: 'qcSet', id: plain.id, checks: { ...PASS5, identity: 'fail' } });
  const still = await send({ cmd: 'qcFix', id: plain.id, check: 'identity' });
  assert.equal(still.ok, true, still.error);
  assert.equal(still.value.still.settings.kind, 'image');
  assert.equal(still.value.still.expectedCost, 0);
  assert.equal(still.value.still.promptParts.at(-1).ref, 'identity_fix');
});

test('agents may record a verdict and take a fix: job data, never the cap, the halt or the work tab', async () => {
  const clip = await finishedClip(16);
  const agent = `${EXT}popup/popup.html`;
  const recorded = await send({ cmd: 'qcSet', id: clip.video.id, checks: { ...PASS5, location: 'fail' } }, agent);
  assert.equal(recorded.ok, true, recorded.error);
  assert.equal(recorded.value.qc.by, 'agent');
  const fixed = await send({ cmd: 'qcFix', id: clip.video.id, check: 'location' }, agent);
  assert.equal(fixed.ok, true, fixed.error);
  assert.equal(fixed.value.still.settings.kind, 'image');
  assert.equal((await send({ cmd: 'setCap', cap: 10 }, agent)).ok, false); // still dashboard-only
});

test('the QC tests leave the entity library as they found it', async () => {
  await send({ cmd: 'entityRemove', name: 'ShotRudy' });
  assert.deepEqual((await send({ cmd: 'entities' })).value.library.entities, []);
});

// ---- Helper bridge ----------------------------------------------------------------------------

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
after(() => sockets.at(-1)?.close()); // stops the bridge's ping timer so the process can exit
const helperSays = (m) => sockets.at(-1).emit('message', { data: JSON.stringify(m) });
const replyTo = (id) => sockets.at(-1).sent.find((m) => m.id === id);

test('the extension connects to the helper on 127.0.0.1 when it starts', async () => {
  assert.equal(sockets.at(-1).url, 'ws://127.0.0.1:47615/bridge');
  sockets.at(-1).emit('open', {});
  await settle();
  assert.equal((await send({ cmd: 'status' })).value.helper.connected, true);
});

test('agents through the helper get only the agent commands: never the cap, the halt or the work tab', async () => {
  helperSays({ id: 1, cmd: 'setCap', args: { cap: 999 } });
  helperSays({ id: 2, cmd: 'clearHalt', args: {} });
  helperSays({ id: 3, cmd: 'useTab', args: { tabId: 7 } });
  helperSays({ id: 4, cmd: 'status', args: {} });
  await settle();
  for (const id of [1, 2, 3]) {
    assert.equal(replyTo(id).ok, false);
    assert.match(replyTo(id).error, /Agents cannot/);
  }
  assert.equal(replyTo(4).ok, true);
  assert.equal(replyTo(4).value.session.cap, 10);
});

test('agents cannot bring the Flow tab forward or promote a still: both are person actions', async () => {
  helperSays({ id: 10, cmd: 'focusWorkTab', args: {} });
  helperSays({ id: 11, cmd: 'promotePreview', args: { id: 'x' } });
  await settle();
  for (const id of [10, 11]) {
    assert.equal(replyTo(id).ok, false);
    assert.match(replyTo(id).error, /Agents cannot/);
  }
});

test('the dashboard gets a pairing code from the helper (the popup cannot)', async () => {
  const pending = send({ cmd: 'pairCode' });
  await settle();
  const ask = sockets.at(-1).sent.find((m) => m.req === 'pairCode');
  helperSays({ rid: ask.rid, ok: true, value: { code: 'ABCD-EFGH', expiresAt: 1 } });
  assert.equal((await pending).value.code, 'ABCD-EFGH');
  assert.match((await send({ cmd: 'pairCode' }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);
});

test('a job may name an absolute output path for the helper to write; anything else is refused when added', async () => {
  const spec = { name: 'fox', prompt: 'a red fox', kind: 'video', input: 'text', resolution: '360p', durationS: 4 };
  const ok = await send({ cmd: 'addJob', spec: { ...spec, outputPath: '/Users/me/film/fox.mp4' } });
  assert.equal(ok.value.outputPath, '/Users/me/film/fox.mp4');
  assert.match((await send({ cmd: 'addJob', spec: { ...spec, outputPath: 'film/fox.mp4' } })).error, /absolute/);
  assert.match((await send({ cmd: 'addJob', spec: { ...spec, outputPath: '/Users/me/.zshrc' } })).error, /\.mp4/);
});

// ---- Storyboard / batch import (decision 3) and presets ---------------------------------------

const REF = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
const CSV = 'scene,prompt,kind,resolution,duration\nopening,a red fox,video,360p,4\nclosing,a blue fox,video,360p,4\n';

test('a storyboard preview plans rows and the batch total, and queues nothing', async () => {
  const before = (await send({ cmd: 'status' })).value.jobs.length;
  const r = await send({ cmd: 'previewImport', text: CSV, filename: 'story.csv' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.format, 'csv');
  assert.equal(r.value.rows.length, 2);
  assert.ok(r.value.rows.every((row) => row.ok), JSON.stringify(r.value.rows));
  assert.equal(r.value.totalCost, 8);
  assert.equal(r.value.anyError, false);
  assert.equal(r.value.cap, 10);
  assert.equal((await send({ cmd: 'status' })).value.jobs.length, before); // preview queues nothing
});

test('a bad row is reported by index and a refused import queues nothing', async () => {
  const before = (await send({ cmd: 'status' })).value.jobs.length;
  const text = JSON.stringify([
    { scene: 'good', prompt: 'a red fox', resolution: '360p', duration: 4 },
    { scene: 'bad', prompt: 'x', count: 9 },
  ]);
  const preview = await send({ cmd: 'previewImport', text });
  assert.equal(preview.value.anyError, true);
  assert.equal(preview.value.rows[1].ok, false);
  assert.match(preview.value.rows[1].error, /Count must be 1-4/);

  const bad = await send({ cmd: 'importJobs', text });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /row 2/);
  assert.match(bad.error, /Count must be 1-4/);
  assert.equal((await send({ cmd: 'status' })).value.jobs.length, before);
});

test('a valid storyboard import queues every row through the real job model', async () => {
  const r = await send({ cmd: 'importJobs', text: CSV, filename: 'story.csv', template: '{project}/{scene}-{index}' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.added.length, 2);
  assert.equal(r.value.totalCost, 8);
  const jobs = (await send({ cmd: 'status' })).value.jobs;
  const imported = jobs.filter((j) => r.value.added.includes(j.id));
  assert.deepEqual(imported.map((j) => j.state), ['queued', 'queued']);
  assert.deepEqual(imported.map((j) => j.name), ['opening', 'closing']);
  assert.ok(imported.every((j) => j.recipe === 'abra_t2v_4s_360p'));
  assert.equal(imported[0].relativePath, `${PID}/opening-1`);
});

test('a preset saves, lists and deletes, and its defaults apply to an imported batch', async () => {
  const saved = await send({ cmd: 'savePreset', preset: { name: 'client A', kind: 'video', resolution: '360p', durationS: 8, aspect: '16:9', count: 1, refs: [REF] } });
  assert.equal(saved.ok, true, saved.error);
  assert.ok(saved.value.id);
  assert.equal(saved.value.refs[0], REF);

  const listed = await send({ cmd: 'listPresets' });
  assert.equal(listed.ok, true);
  assert.equal(listed.value.length, 1);

  // The preset's resolution/duration/refs fill a row that only names a scene and prompt.
  const preview = await send({ cmd: 'previewImport', text: 'scene,prompt\nsolo,x', presetId: saved.value.id });
  assert.equal(preview.value.rows[0].ok, true, preview.value.rows[0].error);
  assert.equal(preview.value.rows[0].spec.resolution, '360p');
  assert.equal(preview.value.rows[0].spec.durationS, 8);
  assert.deepEqual(preview.value.rows[0].spec.refs, [REF]);
  assert.equal(preview.value.rows[0].job.recipe, 'abra_r2v_8s_360p');

  assert.equal((await send({ cmd: 'deletePreset', id: saved.value.id })).ok, true);
  assert.equal((await send({ cmd: 'listPresets' })).value.length, 0);
});

test('only the dashboard may save or delete presets', async () => {
  assert.match((await send({ cmd: 'savePreset', preset: { name: 'x' } }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);
  assert.match((await send({ cmd: 'deletePreset', id: 'nope' }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);
});

// ---- Receipt (§9.1: a local, exportable spend-and-safety record) ------------------------------

test('the dashboard exports a receipt from the records; the popup cannot', async () => {
  const r = await send({ cmd: 'receipt' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.value.filename, /^flowpilot-receipt-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  assert.match(r.value.text, /Flow Pilot — spend and safety receipt/);
  assert.equal(r.value.summary.cap, 10); // the cap set earlier in this file
  // Prompt text is user content: it stays out unless the person asks for it.
  assert.ok(!r.value.text.includes('a red fox'), 'prompt text must not be in the receipt by default');
  const withPrompts = await send({ cmd: 'receipt', includePrompts: true });
  assert.ok(withPrompts.value.text.includes('a red fox'));
  assert.match((await send({ cmd: 'receipt' }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);
});

// ---- Cool-down and resume (§9.2: manual, never a timer) ---------------------------------------

test('resume is a dashboard-only press: it refuses while the halt is set, then runs only never-submitted rows', async () => {
  const spec = { name: 'resume-me', prompt: 'x', kind: 'video', input: 'text', resolution: '360p', durationS: 4 };
  const job = (await send({ cmd: 'addJob', spec })).value;
  await send({ cmd: 'approve', id: job.id });
  assert.match((await send({ cmd: 'resumeUnsubmitted' }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);

  rateLimited = true; // the next job add is refused as a block, which halts the queue
  await send({ cmd: 'addJob', spec: { ...spec, name: 'blocked' } });
  rateLimited = false;
  const refused = await send({ cmd: 'resumeUnsubmitted' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /halt is still set/);

  assert.equal((await send({ cmd: 'clearHalt' })).ok, true);
  const s = (await send({ cmd: 'status' })).value;
  assert.equal(s.session.awaitingResume, true, 'the never-submitted row waits for the press');
  assert.ok(s.resume.ready.some((j) => j.id === job.id));

  const r = await send({ cmd: 'resumeUnsubmitted' });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.value.resumed >= 1);
  assert.equal(typeof r.value.skipped, 'number');
  assert.equal((await send({ cmd: 'status' })).value.session.awaitingResume, false);
});

// ---- Compatibility note and diagnostics (§9.3) -------------------------------------------------

test('the dashboard saves a local diagnostic bundle: dated, honest, and free of cookies, tokens and prompts', async () => {
  const before = (await send({ cmd: 'status' })).value;
  assert.match(before.compat.note, /last proven against the Flow build of/);
  assert.match(before.compat.report, /Known issues|Not verified/);

  const r = await send({ cmd: 'diagnostics' });
  assert.equal(r.ok, true, r.error);
  assert.match(r.value.filename, /^flowpilot-diagnostics-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
  assert.match(r.value.text, /Flow Pilot: 0\.1\.0/);
  assert.match(r.value.text, /no cookies/i);
  // The exact wording of the last halt travels with the bundle.
  assert.ok(r.value.text.includes(before.session.lastHalt.reason));
  // Prompt text is user content and paths can name a person: neither is in a bundle.
  assert.ok(!r.value.text.includes('a red fox'), 'prompt text must not be in the bundle');
  assert.ok(!r.value.text.includes('/Users/me/'), 'file paths must not be in the bundle');
  // Nothing credential-shaped, and not even the words of a header value.
  assert.ok(!/\bya29\./.test(r.value.text));
  assert.ok(!/Authorization\s*[:=]\s*\S/.test(r.value.text));
  assert.ok(!/Bearer\s+\S/.test(r.value.text));
  assert.match((await send({ cmd: 'diagnostics' }, `${EXT}popup/popup.html`)).error, /Only the dashboard/);
});

// ---- Entity library + composer (report §2.1/§2.2/§2.7) ---------------------------------------


test('an entity is created unapproved, approved from the dashboard, and mirrored to the helper file', async () => {
  const made = await send({ cmd: 'entityUpsert', entity: { kind: 'character', name: 'Rudy', description: 'a heavyset Black man in his 30s with a full dark beard', refs: [{ mediaId: REF, role: 'sheet', label: 'rudy_sheet_v1' }] } });
  assert.equal(made.ok, true, made.error);
  assert.equal(made.value.approvedAt, null);
  assert.equal(made.value.version, 1);
  assert.equal(made.value.primaryRefMediaId, REF);

  const approved = await send({ cmd: 'entityApprove', name: 'Rudy' });
  assert.equal(approved.value.approvedAt > 0, true);
  assert.equal(approved.value.approvedBy, 'dashboard');

  await settle();
  const mirror = sockets.at(-1).sent.filter((m) => m.req === 'writeEntities').at(-1);
  assert.equal(mirror.projectId, PID);
  assert.equal(mirror.library.entities[0].name, 'Rudy');
  assert.equal(mirror.library.entities[0].approvedBy, 'dashboard');

  const listed = await send({ cmd: 'entities' });
  assert.equal(listed.value.projectId, PID);
  assert.deepEqual(listed.value.library.entities.map((e) => e.name), ['Rudy']);
  assert.equal(listed.value.warnings.some((w) => /No style entity/.test(w)), true);
});

test('a job that names an entity gets the composed prompt verbatim and records the subject version', async () => {
  const r = await send({ cmd: 'addJob', spec: { name: 'rudy job', prompt: 'she turns to face the camera', entities: ['Rudy'], resolution: '360p', durationS: 4 } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.prompt.startsWith('she turns to face the camera\n\nCHARACTER — RUDY (identical in every shot): a heavyset Black man in his 30s with a full dark beard'), true);
  assert.match(r.value.prompt, /Negative: /);
  assert.equal(r.value.prompt, r.value.promptParts.map((p) => p.text).join('\n\n'));
  assert.deepEqual(r.value.promptParts.map((p) => p.kind), ['base', 'entity', 'base']);
  assert.deepEqual(r.value.entities, [{ entityId: made_id(r.value.entities), version: 1, mediaId: REF, role: 'inFrame' }]);
  // The prompt Flow receives is the composed one, so the pre-spend verbatim check still holds.
  assert.equal(r.value.prompt.includes(r.value.promptParts[0].text), true);
});

const made_id = ([e]) => e.entityId;

test('an unknown or unapproved entity is refused before the job is queued', async () => {
  const unknown = await send({ cmd: 'addJob', spec: { name: 'x', prompt: 'x', entities: ['Nobody'], durationS: 4 } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /Unknown entity "Nobody"/);

  await send({ cmd: 'entityUnapprove', name: 'Rudy', reason: 'checking the refusal' });
  const unapproved = await send({ cmd: 'addJob', spec: { name: 'x', prompt: 'x', entities: ['Rudy'], durationS: 4 } });
  assert.equal(unapproved.ok, false);
  assert.match(unapproved.error, /not approved/i);

  const before = (await send({ cmd: 'status' })).value.jobs.length;
  assert.equal(before, (await send({ cmd: 'status' })).value.jobs.length); // nothing was queued
  await send({ cmd: 'entityApprove', name: 'Rudy' });
});

test('the project style lock comes from the canonical asset and is inserted verbatim', async () => {
  const styled = await send({ cmd: 'entitySetStyle' });
  assert.equal(styled.ok, true, styled.error);
  assert.equal(styled.value.kind, 'style');
  assert.match(styled.value.description, /^The whole video stays in this 3D Pixar\/Disney animation style from the first frame to the last:/);

  await send({ cmd: 'entityApprove', name: 'Rudy' });
  const job = await send({ cmd: 'addJob', spec: { name: 'styled job', prompt: 'a fox runs', entities: ['Rudy'], resolution: '360p', durationS: 4 } });
  assert.equal(job.ok, true, job.error);
  assert.equal(job.value.prompt.includes(styled.value.description), true);
  assert.deepEqual(job.value.promptParts.filter((p) => p.kind).map((p) => p.kind), ['base', 'entity', 'style', 'base']);
  const listed = await send({ cmd: 'entities' });
  assert.equal(listed.value.library.styleId, styled.value.id);
  assert.deepEqual(listed.value.warnings, []);
});

test('composing a prompt is a dry run: it returns the text and hashes and spends nothing', async () => {
  const r = await send({ cmd: 'composePrompt', spec: { prompt: 'she turns to face the camera', entities: ['Rudy'] } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.value.entities[0].name, 'Rudy');
  assert.match(r.value.text, /CHARACTER — RUDY/);
  assert.equal(r.value.sha256.length, 64);
  assert.equal(r.value.parts.every((p) => p.sha256.length === 64), true);
  const s = (await send({ cmd: 'status' })).value.session;
  assert.equal(s.spent, 0);
});

// Report §8.1 step 1: the read side, end to end through the service worker. No new RPC, no click,
// no credits — the entity list rides inside the Zzl0ze the media reader already fetches.
test('the project\'s Flow Characters are read from the media response, and agents may read them', async () => {
  mediaFixture = 'Zzl0ze-characters';
  const r = await send({ cmd: 'characters' });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.value.characters, [{
    entityId: '0bfec740-409e-42f5-80d1-82baac3349f3', projectId: CHAR_PROJECT, name: 'nancy',
    primaryMediaId: 'b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca', referenceWorkflowIds: ['e3696fd0-eb73-4b82-a8a2-096fa4cb0dde'],
  }]);
  // Most projects have none: an empty list, not an error.
  mediaFixture = 'Zzl0ze';
  assert.deepEqual((await send({ cmd: 'characters' })).value.characters, []);
  // Read-only, so an agent may ask through the helper.
  helperSays({ id: 30, cmd: 'characters', args: {} });
  await settle();
  assert.equal(replyTo(30).ok, true, replyTo(30).error);
  assert.equal((await send({ cmd: 'status' })).value.session.spent, 0);
});

test('agents may write entities through the helper but still cannot set the cap or clear a halt', async () => {
  helperSays({ id: 20, cmd: 'entityUpsert', args: { entity: { kind: 'location', name: 'Lake', description: 'a quiet lake at dawn' } } });
  await settle(); // one helper request at a time (the CLI is sequential)
  helperSays({ id: 21, cmd: 'composePrompt', args: { spec: { prompt: 'x', entities: ['Lake'] } } });
  helperSays({ id: 22, cmd: 'setCap', args: { cap: 999 } });
  helperSays({ id: 23, cmd: 'clearHalt', args: {} });
  await settle();
  assert.equal(replyTo(20).ok, true, replyTo(20).error);
  assert.equal(replyTo(21).ok, false); // unapproved: the composer refuses
  assert.match(replyTo(21).error, /not approved/i);
  assert.match(replyTo(22).error, /Agents cannot/);
  assert.match(replyTo(23).error, /Agents cannot/);
  assert.equal((await send({ cmd: 'status' })).value.session.cap, 10);
});
