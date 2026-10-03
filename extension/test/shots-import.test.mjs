// Shot import: the storyboard reader, the row rules and the shot store (report §2.7 "Batch import
// row", §2.8). Importing a shot list plans one still job per row and prices the video it will
// unlock; it never queues a video job, so the SHOW-BEFORE-SPEND gate is structural rather than a
// state a person has to clear.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog } from '../lib/catalog.js';
import { parseBatchResponse } from '../lib/rpc.js';
import { loadDefaults } from '../lib/prompt-assets.js';
import { emptyLibrary } from '../lib/entities.js';
import { fixture } from './helpers.mjs';
import {
  normalizeShotRow, validateShotRow, defaultShotMode, parseShotRows, planShotImport,
  createShotStore, SHOTS_KEY,
} from '../lib/shots.js';

const recipes = parseCatalog(parseBatchResponse(fixture('HTrJv'), 'HTrJv').data);
const template = (await loadDefaults()).template;
const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';

const MEDIA = {
  rudy: 'aaaaaaaa-0000-4000-8000-000000000001',
  hellcat: 'bbbbbbbb-0000-4000-8000-000000000002',
  street: 'cccccccc-0000-4000-8000-000000000003',
  still: 'ffffffff-0000-4000-8000-000000000006',
};

const entity = (over = {}) => ({
  id: 'ent_rudy', kind: 'character', name: 'Rudy', aliases: ['the guy'], orientation: 'portrait',
  description: 'a heavyset Black man in his 30s',
  refs: [{ mediaId: MEDIA.rudy, role: 'sheet', label: 'rudy_sheet_v1' }],
  primaryRefMediaId: MEDIA.rudy, approvedAt: 1, approvedBy: 'dashboard', version: 1, history: [],
  ...over,
});

const library = () => ({
  ...emptyLibrary(PID),
  entities: [
    entity(),
    entity({ id: 'ent_hellcat', kind: 'vehicle', name: 'Hellcat', aliases: [], refs: [{ mediaId: MEDIA.hellcat, role: 'sheet', label: 'hellcat_sheet_v1' }], primaryRefMediaId: MEDIA.hellcat }),
    entity({ id: 'ent_pending', kind: 'character', name: 'Rufus', refs: [], primaryRefMediaId: null, approvedAt: null }),
  ],
});

const row = (over = {}) => ({
  scene: 4, name: 'scene_4',
  beat: 'Driving shot heading home in the Hellcat Widebody Red Eye',
  action: 'The Charger drives along a suburban road.',
  motion: 'anticipation+timing-weight',
  setting: 'a quiet LA suburban street',
  camera: { shotType: 'wide', moveId: 'tracking-glide' },
  audio: 'a deep V8 exhaust note',
  entities: ['Rudy', 'Hellcat'],
  mode: 'ingredients',
  ...over,
});

function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
  };
}

test('a shot row reads the same from JSON objects and from dotted CSV columns', () => {
  const fromJson = normalizeShotRow(row());
  assert.equal(fromJson.scene, 4);
  assert.deepEqual(fromJson.entities, ['Rudy', 'Hellcat']);
  assert.equal(fromJson.camera.moveId, 'tracking-glide');
  assert.equal(fromJson.mode, 'ingredients');

  const csv = [
    'scene,name,beat,action,motion,setting,camera.shotType,camera.moveId,audio,entities,mode,anchor.startFrame,anchor.endFrame,still.refs,still.outputPath,resolution,durationS,aspect,count,outputPath,qc',
    '4,scene_4,driving home,the Charger drives,anticipation,quiet street,wide,tracking-glide,V8 note,Rudy;Hellcat,ingredients,,,Rudy;Hellcat,/tmp/storyboard/scene_4.png,720p,4,16:9,1,/tmp/clips/scene_4.mp4,identity;wardrobe',
  ].join('\n');
  const { format, rows } = parseShotRows(csv, { filename: 'shots.csv' });
  assert.equal(format, 'csv');
  const parsed = normalizeShotRow(rows[0]);
  assert.deepEqual(parsed.entities, ['Rudy', 'Hellcat']);
  assert.deepEqual(parsed.still.refs, ['Rudy', 'Hellcat']);
  assert.equal(parsed.still.outputPath, '/tmp/storyboard/scene_4.png');
  assert.equal(parsed.outputPath, '/tmp/clips/scene_4.mp4');
  assert.deepEqual(parsed.qc, ['identity', 'wardrobe']);
  assert.equal(parsed.camera.shotType, 'wide');
});

test('a row that pins an anchor and asks for Ingredients is refused before anything is planned', () => {
  assert.deepEqual(validateShotRow(row({ mode: 'ingredients', anchor: { startFrame: MEDIA.still } })), ['mode:ingredients and anchor.startFrame are mutually exclusive (Frames vs Ingredients)']);
  assert.deepEqual(validateShotRow(row({ mode: 'nonsense' })), ['mode must be one of frames, ingredients']);
  assert.deepEqual(validateShotRow(row({ durationS: 5 })), ['durationS must be one of 4/6/8/10s']);
  assert.deepEqual(validateShotRow({}), ['a row needs a scene or a name']);
});

test('the default mode references 1-3 subjects and anchors anything else', () => {
  assert.equal(defaultShotMode({}, 2), 'ingredients');
  assert.equal(defaultShotMode({}, 0), 'frames');
  assert.equal(defaultShotMode({}, 4), 'frames'); // more than three: the still is the merge point
  assert.equal(defaultShotMode({ anchor: { startFrame: MEDIA.still } }, 2), 'frames');
  assert.equal(defaultShotMode({ mode: 'ingredients' }, 4), 'ingredients'); // an explicit mode is kept
});

test('importing a shot list plans a free still per row and prices the video it unlocks', () => {
  const plan = planShotImport({
    rows: [row(), row({ scene: 5, name: 'scene_5', entities: ['Rudy'], mode: 'frames' })],
    projectId: PID, library: library(), template, recipes,
  });
  assert.equal(plan.anyError, false);
  assert.equal(plan.rows.length, 2);
  assert.equal(plan.rows[0].ok, true, plan.rows[0].error ?? '');
  assert.equal(plan.rows[0].shot.id, 'shot_4');
  assert.equal(plan.rows[0].shot.mode, 'ingredients');
  assert.deepEqual(plan.rows[0].stillJob.referencePlan.ingredients.map((r) => r.mediaId), [MEDIA.rudy, MEDIA.hellcat]);
  assert.equal(plan.rows[0].stillJob.settings.kind, 'image');
  assert.equal(plan.rows[0].stillJob.expectedCost, 0);
  assert.equal(plan.rows[0].cost, 7); // r2v 4s at the default 720p
  assert.deepEqual(plan.rows[0].shot.entities.map((e) => e.name), ['Rudy', 'Hellcat']);
  assert.equal(plan.rows[0].shot.promptParts.length > 0, true);
  // The second row is anchored: its still carries the entity photo and its video is priced Frames.
  assert.equal(plan.rows[1].shot.mode, 'frames');
  assert.equal(plan.rows[1].stillJob.expectedCost, 0);
  assert.equal(typeof plan.rows[1].cost, 'number');
  assert.equal(plan.totalCost, plan.rows[0].cost + plan.rows[1].cost);
});

test('an unknown entity fails the row; an unapproved one is left out with a warning', () => {
  const plan = planShotImport({ rows: [row({ entities: ['Ghost'] })], projectId: PID, library: library(), template, recipes });
  assert.equal(plan.anyError, true);
  assert.match(plan.rows[0].error, /Unknown entity "Ghost"/);

  const warned = planShotImport({ rows: [row({ entities: ['Rudy', 'Rufus'] })], projectId: PID, library: library(), template, recipes });
  assert.equal(warned.anyError, false);
  assert.match(warned.rows[0].warnings.join(' '), /Rufus is not approved/);
  assert.deepEqual(warned.rows[0].shot.entities.map((e) => e.name), ['Rudy']);
  assert.deepEqual(warned.rows[0].stillJob.referencePlan.ingredients.map((r) => r.mediaId), [MEDIA.rudy]);
});

test('a declared anchor may be a media id or a finished still job\'s output path, never a stray path', () => {
  const plan = planShotImport({
    rows: [row({ mode: 'frames', anchor: { startFrame: MEDIA.still, endFrame: null } })],
    projectId: PID, library: library(), template, recipes,
  });
  assert.equal(plan.anyError, false);
  assert.equal(plan.rows[0].shot.anchor.startFrameMediaId, MEDIA.still);
  assert.match(plan.rows[0].warnings.join(' '), /not approved yet/);

  const viaPath = planShotImport({
    rows: [row({ mode: 'frames', anchor: { startFrame: '/tmp/storyboard/scene_4.png' } })],
    projectId: PID, library: library(), template, recipes, knownStill: { '/tmp/storyboard/scene_4.png': MEDIA.still },
  });
  assert.equal(viaPath.rows[0].shot.anchor.startFrameMediaId, MEDIA.still);

  const stray = planShotImport({
    rows: [row({ mode: 'frames', anchor: { startFrame: '/tmp/nope.png' } })],
    projectId: PID, library: library(), template, recipes,
  });
  assert.equal(stray.anyError, true);
  assert.match(stray.rows[0].error, /media id|finished still job/);
});

test('the shot store keeps the plan, supersedes the old approval on a new still, and records the video', async () => {
  const area = memoryArea();
  const store = createShotStore(area, { now: () => 500 });
  const plan = planShotImport({ rows: [row({ mode: 'frames' })], projectId: PID, library: library(), template, recipes });
  const shot = plan.rows[0].shot;
  await store.addMany(PID, [shot]);
  assert.deepEqual((await store.list(PID)).shots.map((s) => s.id), ['shot_4']);
  assert.equal(area.data[SHOTS_KEY].projects[PID].shots.length, 1);

  // Queue the still, approve it, then queue a new one: the approval is superseded, not carried.
  await store.recordStill(PID, shot.id, { jobId: 'still-1' });
  await store.approve(PID, shot.id, { mediaId: MEDIA.still, jobId: 'still-1', approvedBy: 'dashboard', at: 100 });
  let { shot: approved, approvals } = await store.get(PID, shot.id);
  assert.equal(approvals.length, 1);
  assert.equal(approved.anchor.startFrameMediaId, MEDIA.still);

  await store.recordStill(PID, shot.id, { jobId: 'still-2' });
  ({ shot: approved, approvals } = await store.get(PID, shot.id));
  assert.equal(approvals[0].supersededAt, 500);
  assert.equal(approvals[0].supersededReason, 'a new still was queued');
  assert.equal(approved.still.jobId, 'still-2');
  assert.equal(approved.still.mediaId, null);

  await store.approve(PID, shot.id, { mediaId: MEDIA.still, jobId: 'still-2', at: 200 });
  await store.attachVideo(PID, shot.id, 'video-1');
  ({ shot: approved } = await store.get(PID, shot.id));
  assert.deepEqual(approved.videoJobIds, ['video-1']);
  assert.equal(approved.videoJobId, 'video-1');
  assert.match(approved.history.at(-1).reason, /video job video-1/);

  await store.remove(PID, shot.id);
  assert.deepEqual(await store.list(PID), { shots: [], approvals: [] });
});
