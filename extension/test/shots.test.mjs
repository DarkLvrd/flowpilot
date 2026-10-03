// Shot plans, the still-anchor gate and materialisation (report §2.3, §2.4, §2.5, §2.7, §2.8).
// Pure logic first: a shot is either anchored (Frames) or referenced (Ingredients), never both;
// more than three in-frame subjects means the composed still is the merge point; a shot that names
// a Flow Character is text-prefixed and its description block is left out (the attach itself is a
// Phase 3 seam and stays unwired). The gate is that no video job can be built from a shot whose
// still is not approved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalog } from '../lib/catalog.js';
import { parseBatchResponse } from '../lib/rpc.js';
import { loadDefaults } from '../lib/prompt-assets.js';
import { emptyLibrary } from '../lib/entities.js';
import { fixture } from './helpers.mjs';
import {
  SHOT_ROLES, SHOT_MODES, validateShot, planReferences, stillReferences, shotComposeInput,
  stillJobSpec, videoJobSpec, materializeShot, stillGate, approveStill, supersedeStill,
  shotWithConsistencyBlock, createShotStore, SHOTS_KEY, estimateShotCredits,
} from '../lib/shots.js';
import { promptBaseHash } from '../lib/entities.js';

// Same contract as chrome.storage.local.
function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
  };
}

const recipes = parseCatalog(parseBatchResponse(fixture('HTrJv'), 'HTrJv').data);
const defaults = await loadDefaults();
const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';

const MEDIA = {
  rudy: 'aaaaaaaa-0000-4000-8000-000000000001',
  hellcat: 'bbbbbbbb-0000-4000-8000-000000000002',
  street: 'cccccccc-0000-4000-8000-000000000003',
  extra: 'dddddddd-0000-4000-8000-000000000004',
  extra2: 'eeeeeeee-0000-4000-8000-000000000005',
  still: 'ffffffff-0000-4000-8000-000000000006',
  still2: '99999999-0000-4000-8000-000000000007',
  end: '12121212-0000-4000-8000-000000000008',
};

const entity = (over = {}) => ({
  id: 'ent_rudy', kind: 'character', name: 'Rudy', aliases: [], orientation: 'portrait',
  description: 'a heavyset Black man in his 30s',
  refs: [{ mediaId: MEDIA.rudy, role: 'sheet', label: 'rudy_sheet_v1' }],
  primaryRefMediaId: MEDIA.rudy, approvedAt: 1, approvedBy: 'dashboard', version: 1, history: [],
  ...over,
});

const library = (entities) => ({ ...emptyLibrary(PID), entities });

// The shot's entities are the frozen records written at import time: identity (name, version,
// mediaId, approval, flowCharacter) is decided once and never re-read from a library that moved.
const shotEntity = (over = {}) => ({
  entityId: 'ent_rudy', role: 'inFrame', name: 'Rudy', version: 1,
  mediaId: MEDIA.rudy, approvedAt: 1, flowCharacter: null, ...over,
});

const baseShot = (over = {}) => ({
  id: 'shot_4', projectId: PID, scene: 4, name: 'scene_4',
  beat: 'Driving shot heading home in the Hellcat Widebody Red Eye',
  action: 'The Charger drives along a suburban road, the driver relaxed at the wheel.',
  motion: 'anticipation+timing-weight', setting: 'a quiet LA suburban street',
  camera: { shotType: 'wide', moveId: 'tracking-glide' }, audio: 'a deep V8 exhaust note',
  durationS: 4, resolution: '360p', aspect: '16:9', count: 1,
  entities: [shotEntity()],
  mode: 'frames',
  anchor: { startFrameMediaId: null, endFrameMediaId: null },
  still: { jobId: null, mediaId: null },
  prompt: '[SHOT 4 — 4s]',
  promptParts: [{ kind: 'base', ref: 'shot', sha256: 'a'.repeat(64), text: '[SHOT 4 — 4s]' }],
  outputPath: null, stillOutputPath: null,
  ...over,
});

const approval = (over = {}) => ({
  shotId: 'shot_4', frame: 'start', mediaId: MEDIA.still, jobId: 'still-job', approvedAt: 100,
  approvedBy: 'dashboard', note: null, ...over,
});

// --- validation -----------------------------------------------------------------------------

test('validateShot accepts the design record and refuses the shapes that cannot be planned', () => {
  assert.equal(validateShot(baseShot()), true);
  assert.equal(SHOT_MODES.join(','), 'frames,ingredients');
  assert.equal(SHOT_ROLES.join(','), 'inFrame,context');
  assert.throws(() => validateShot(baseShot({ id: '' })), /id/i);
  assert.throws(() => validateShot(baseShot({ mode: 'both' })), /mode/i);
  assert.throws(() => validateShot(baseShot({ entities: [{ entityId: 'ent_rudy', role: 'hero' }] })), /role/i);
  assert.throws(() => validateShot(baseShot({ entities: [{ role: 'inFrame' }] })), /entityId/i);
  assert.throws(() => validateShot(baseShot({ entities: [{ entityId: 'ent_rudy', role: 'inFrame' }, { entityId: 'ent_rudy', role: 'context' }] })), /twice/i);
  assert.throws(() => validateShot(baseShot({ durationS: 5 })), /duration/i);
});

test('a role that is not named is in-frame; context entities never reach the reference plan', () => {
  const shot = baseShot({ entities: [shotEntity({ role: undefined }), shotEntity({ entityId: 'ent_street', name: 'Street', mediaId: MEDIA.street, role: 'context' })], anchor: { startFrameMediaId: MEDIA.still } });
  const plan = planReferences(shot);
  assert.deepEqual(plan.ingredients.length, 0); // frames mode never carries ingredients
  assert.deepEqual(plan.inFrame.map((e) => e.entityId), ['ent_rudy']);
  assert.deepEqual(plan.context.map((e) => e.entityId), ['ent_street']);
});

// --- planReferences: anchored or referenced, never both --------------------------------------

test('a frames shot is anchored to its approved still and carries no ingredients', () => {
  const shot = baseShot({ anchor: { startFrameMediaId: MEDIA.still, endFrameMediaId: null } });
  const { inFrame, ...plan } = planReferences(shot);
  assert.deepEqual(plan, {
    input: 'frames', ingredients: [], firstFrame: MEDIA.still, lastFrame: null,
    context: [], characters: [], omitEntityBlocks: [],
  });
  assert.equal(inFrame.length, 1);
});

test('a frames shot with a declared end frame plans both frames', () => {
  const shot = baseShot({ anchor: { startFrameMediaId: MEDIA.still, endFrameMediaId: MEDIA.end } });
  const plan = planReferences(shot);
  assert.equal(plan.firstFrame, MEDIA.still);
  assert.equal(plan.lastFrame, MEDIA.end);
});

test('an ingredients shot references its in-frame entities and is not pinned to a still', () => {
  const shot = baseShot({ mode: 'ingredients' });
  const plan = planReferences(shot);
  assert.equal(plan.input, 'ingredients');
  assert.deepEqual(plan.ingredients, [MEDIA.rudy]);
  assert.equal(plan.firstFrame, null);
  assert.equal(plan.lastFrame, null);
});

test('a shot can never be anchored and referenced at once', () => {
  // An ingredients shot pinned to an anchor still is the import-time mutual exclusion.
  assert.throws(() => planReferences(baseShot({ mode: 'ingredients', anchor: { startFrameMediaId: MEDIA.still, endFrameMediaId: null } })), /anchored|Ingredients.*still|both/i);
  // A frames shot that also lists ingredient references is the same refusal from the other side.
  assert.throws(() => planReferences(baseShot({ refs: [MEDIA.still] })), /Ingredients|both/i);
});

test('more than three in-frame subjects refuse Ingredients and name the still as the merge point', () => {
  const many = ['a', 'b', 'c', 'd'].map((k, i) => shotEntity({ entityId: `ent_${k}`, name: `E${i}`, mediaId: MEDIA.extra, role: 'inFrame' }));
  const shot = baseShot({ mode: 'ingredients', entities: many });
  assert.throws(() => planReferences(shot), /3|three/i);
  assert.throws(() => planReferences(shot), /frames|still/i);
  // The same four are fine once the shot is anchored: the composed still merges them.
  assert.equal(planReferences(baseShot({ entities: many, anchor: { startFrameMediaId: MEDIA.still } })).input, 'frames');
});

test('Ingredients needs at least one in-frame subject', () => {
  assert.throws(() => planReferences(baseShot({ mode: 'ingredients', entities: [shotEntity({ role: 'context' })] })), /in-frame|inFrame|at least one/i);
});

test('an unapproved entity or one without a locked media id refuses the plan', () => {
  assert.throws(() => planReferences(baseShot({ mode: 'ingredients', entities: [shotEntity({ approvedAt: null })] })), /not approved/i);
  assert.throws(() => planReferences(baseShot({ mode: 'ingredients', entities: [shotEntity({ mediaId: null })] })), /media id|primary ref/i);
  // A library entry can supply identity the frozen record left out.
  const lib = library([entity()]);
  assert.deepEqual(planReferences(baseShot({ mode: 'ingredients', entities: [shotEntity({ mediaId: null, approvedAt: null })] }), lib).ingredients, [MEDIA.rudy]);
  assert.throws(() => planReferences(baseShot({ mode: 'ingredients', entities: [shotEntity({ entityId: 'ent_ghost' })] }), lib), /unknown|ghost/i);
});

// --- the Flow Character seam -----------------------------------------------------------------

const CHARACTER = { name: 'Rudy', entityId: '0bfec740-409e-42f5-80d1-82baac3349f3', primaryMediaId: 'b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca', referenceWorkflowIds: ['e3696fd0-eb73-4b82-a8a2-096fa4cb0dde'] };

test('a flowCharacter entity is text-prefixed and its description block is left out', () => {
  const shot = baseShot({ mode: 'ingredients', entities: [shotEntity({ name: 'Rudy', flowCharacter: CHARACTER }), shotEntity({ entityId: 'ent_street', name: 'Street', mediaId: MEDIA.street, role: 'context' })] });
  const plan = planReferences(shot);
  // The id a job carries is Flow's own entity id, never the library id: `classifyCharacter` needs a
  // uuid Flow echoes back after a generation, and the picker attaches by Flow's id (BUG-2).
  assert.deepEqual(plan.characters, [{ entityId: CHARACTER.entityId, name: 'Rudy', mention: '@Rudy' }]);
  // The prompt blocks are keyed by the *library* id, so the omit list keeps that one.
  assert.deepEqual(plan.omitEntityBlocks, ['ent_rudy']);
  // The composer input carries the mention as prompt text and the omit list for the composer.
  const input = shotComposeInput(shot);
  assert.match(input.prompt, /@Rudy/);
  assert.deepEqual(input.omitEntityBlocks, ['ent_rudy']);
  assert.deepEqual(input.entities, ['ent_rudy', 'ent_street']);
  // The attach is the picker's job, not the plan's: the plan describes the id Flow must confirm.
  assert.equal('attach' in plan, false);
  assert.deepEqual(videoJobSpec(shot, plan).characters, [{ entityId: CHARACTER.entityId, name: 'Rudy' }]);
  // The character's own name is the one Flow's picker tile and chip show, so it is what the driver
  // matches the tile by — even when the library entity goes under a different label.
  const renamed = baseShot({ mode: 'ingredients', entities: [shotEntity({ name: 'Rudy the character', flowCharacter: CHARACTER })] });
  assert.deepEqual(planReferences(renamed).characters, [{ entityId: CHARACTER.entityId, name: 'Rudy', mention: '@Rudy' }]);
});

test('a flowCharacter entity needs no locked media id: Flow holds the face', () => {
  const shot = baseShot({ mode: 'ingredients', entities: [shotEntity({ name: 'Rudy', mediaId: null, flowCharacter: CHARACTER })] });
  const plan = planReferences(shot);
  assert.deepEqual(plan.ingredients, []); // no photo to attach: the character chip is the reference
  assert.deepEqual(plan.characters, [{ entityId: CHARACTER.entityId, name: 'Rudy', mention: '@Rudy' }]);
  assert.deepEqual(videoJobSpec(shot, plan).refs, []);
  assert.deepEqual(videoJobSpec(shot, plan).characters, [{ entityId: CHARACTER.entityId, name: 'Rudy' }]);
  // The approval rule does not move: an unapproved character is still refused.
  assert.throws(() => planReferences(baseShot({ mode: 'ingredients', entities: [shotEntity({ name: 'Rudy', mediaId: null, approvedAt: null, flowCharacter: CHARACTER })] })), /not approved/i);
});

// The plan is not where a character job is validated: `buildJob` (the one path every job takes) is.
// The library id used to travel as far as here, and only `classifyCharacter` refused it — so the
// shot→video path could never be built. This runs a character shot through the real builder.
test('a character shot builds a real job through buildJob, carrying Flow\'s entity id', () => {
  const shot = baseShot({ mode: 'ingredients', entities: [shotEntity({ name: 'Rudy', mediaId: null, flowCharacter: CHARACTER })], anchor: { startFrameMediaId: null, endFrameMediaId: null } });
  const approvals = [{ shotId: shot.id, frame: 'start', mediaId: MEDIA.still, approvedAt: 7, approvedBy: 'dashboard', note: null }];
  // An Ingredients shot is not pinned by its still, but its still still has to be approved first.
  const shotWithStill = { ...shot, still: { jobId: 'j', mediaId: MEDIA.still } };
  const job = materializeShot(shotWithStill, approvals, { projectId: PID, recipes });
  assert.equal(job.settings.kind, 'video');
  assert.equal(job.settings.input, 'ingredients');
  assert.deepEqual(job.referencePlan.characters, [{ entityId: CHARACTER.entityId, name: 'Rudy' }]);
  assert.deepEqual(job.settings.characters, [{ entityId: CHARACTER.entityId, name: 'Rudy' }]);
  // A Flow Character is a reference for the recipe (r2v), so the price is the reference recipe's.
  assert.match(job.recipe, /r2v/);
  // And the library id in the same place fails closed: Flow's own id is the only usable one.
  assert.throws(() => materializeShot({ ...shotWithStill, entities: [shotEntity({ name: 'Rudy', mediaId: null, flowCharacter: { ...CHARACTER, entityId: 'ent_rudy' } })] }, approvals, { projectId: PID, recipes }), /entity id/i);
});

// Flow replaces the ingredient bar with the start/end slots in Frames (report §6), so there is no
// chip to attach and nothing the pre-spend check could confirm. The plan still describes the text
// mention, but no job is built: refused before anything is queued.
test('a Frames shot with a Flow Character is refused before a job is built', () => {
  const shot = baseShot({ entities: [shotEntity({ name: 'Rudy', flowCharacter: CHARACTER })], anchor: { startFrameMediaId: MEDIA.still } });
  assert.deepEqual(planReferences(shot).characters, [{ entityId: CHARACTER.entityId, name: 'Rudy', mention: '@Rudy' }]);
  assert.throws(() => videoJobSpec(shot, planReferences(shot)), /Frames/i);
  assert.throws(() => estimateShotCredits(shot, { recipes, library: library([entity({ flowCharacter: CHARACTER })]), projectId: PID }), /Frames/i);
});

// --- the still's references and job specs ----------------------------------------------------

test('the still takes up to three in-frame refs, in order, and refuses a missing media id', () => {
  const ents = ['a', 'b', 'c', 'd'].map((k, i) => shotEntity({ entityId: `ent_${k}`, name: `E${i}`, mediaId: [MEDIA.rudy, MEDIA.hellcat, MEDIA.street, MEDIA.extra][i], role: 'inFrame' }));
  const refs = stillReferences(baseShot({ entities: ents, mode: 'frames' }));
  assert.deepEqual(refs, [MEDIA.rudy, MEDIA.hellcat, MEDIA.street]); // the merge point is the first three
  assert.deepEqual(stillReferences(baseShot({ entities: [shotEntity({ mediaId: null })] })), []);
  assert.throws(() => stillReferences(baseShot({ entities: [shotEntity({ approvedAt: null })] })), /not approved/i);
});

test('the still job is a free image built from the composed shot prompt and its refs', () => {
  const shot = baseShot({ mode: 'ingredients', entities: [shotEntity(), shotEntity({ entityId: 'ent_hellcat', name: 'Hellcat', mediaId: MEDIA.hellcat, kind: 'vehicle' })] });
  const spec = stillJobSpec(shot, { recipes, template: defaults.template });
  assert.equal(spec.kind, 'image');
  assert.equal(spec.name, 'scene_4-still');
  assert.deepEqual(spec.refs, [MEDIA.rudy, MEDIA.hellcat]);
  const fields = Object.fromEntries(Object.entries(spec));
  assert.equal(fields.firstFrame, undefined);
  assert.equal(shot.stillOutputPath, null);
  const withPath = stillJobSpec(baseShot({ stillOutputPath: '/tmp/storyboard/scene_4.png' }), { recipes });
  assert.equal(withPath.outputPath, '/tmp/storyboard/scene_4.png');
});

test('the video spec is Frames when anchored and Ingredients when referenced', () => {
  const anchored = baseShot({ anchor: { startFrameMediaId: MEDIA.still } });
  const frames = videoJobSpec(anchored, planReferences(anchored));
  assert.equal(frames.kind, 'video');
  assert.equal(frames.input, 'frames');
  assert.equal(frames.firstFrame, MEDIA.still);
  assert.equal(frames.lastFrame, null);
  assert.deepEqual(frames.entities.map((e) => e.entityId), ['ent_rudy']);

  const referenced = baseShot({ mode: 'ingredients' });
  const ingredients = videoJobSpec(referenced, planReferences(referenced));
  assert.equal(ingredients.input, 'ingredients');
  assert.deepEqual(ingredients.refs, [MEDIA.rudy]);
  assert.equal(ingredients.firstFrame, undefined);
  // A job with no character is unchanged: no `characters` field at all.
  assert.equal('characters' in ingredients, false);
});

// --- the gate and the approval ledger --------------------------------------------------------

test('a video job is never built until the shot\'s still is approved', () => {
  const shot = baseShot();
  const gate = stillGate(shot, []);
  assert.equal(gate.ok, false);
  assert.match(gate.problems.join(' '), /still|approve/i);
  assert.throws(() => materializeShot(shot, [], { projectId: PID, recipes }), /approve|still/i);
});

test('approving a still records who, when and which media id, and sets the anchor', () => {
  const shot = baseShot();
  const { shot: next, approvals, entry } = approveStill(shot, [], { mediaId: MEDIA.still, jobId: 'still-job', approvedBy: 'dashboard', note: 'looks right', at: 1234 });
  assert.deepEqual(entry, { shotId: 'shot_4', frame: 'start', mediaId: MEDIA.still, jobId: 'still-job', approvedAt: 1234, approvedBy: 'dashboard', note: 'looks right' });
  assert.deepEqual(approvals, [entry]);
  assert.equal(next.anchor.startFrameMediaId, MEDIA.still);
  assert.equal(next.still.mediaId, MEDIA.still);
  assert.equal(stillGate(next, approvals).ok, true);
});

test('an approval for a different shot or a superseded one does not open the gate', () => {
  const shot = baseShot();
  assert.equal(stillGate(shot, [approval({ shotId: 'shot_9' })]).ok, false);
  assert.equal(stillGate(shot, [approval({ supersededAt: 5, supersededReason: 'a new still was queued' })]).ok, false);
});

test('re-anchoring to a new still makes the old approval stale until the new one is approved', () => {
  const approved = approveStill(baseShot(), [], { mediaId: MEDIA.still, at: 1 });
  const regenerated = baseShot({ still: { jobId: 'still-job-2', mediaId: MEDIA.still2 }, anchor: { startFrameMediaId: MEDIA.still } });
  const gate = stillGate(regenerated, approved.approvals);
  assert.equal(gate.ok, false);
  assert.match(gate.problems.join(' '), /new still|replaced/i);
  const reapproved = approveStill(regenerated, approved.approvals, { mediaId: MEDIA.still2, jobId: 'still-job-2', at: 2 });
  assert.equal(stillGate(reapproved.shot, reapproved.approvals).ok, true);
  assert.equal(reapproved.approvals.length, 2); // the ledger keeps the superseded entry
  assert.equal(reapproved.approvals[0].mediaId, MEDIA.still);
});

test('a declared end frame must be approved too before the video can be built', () => {
  const shot = baseShot({ anchor: { startFrameMediaId: MEDIA.still, endFrameMediaId: MEDIA.end } });
  const start = approveStill(shot, [], { mediaId: MEDIA.still, at: 1 });
  assert.equal(stillGate(start.shot, start.approvals).ok, false);
  assert.match(stillGate(start.shot, start.approvals).problems.join(' '), /end frame/i);
  const end = approveStill(start.shot, start.approvals, { mediaId: MEDIA.end, frame: 'end', at: 2 });
  assert.equal(stillGate(end.shot, end.approvals).ok, true);
});

test('queueing a new still supersedes the current approval instead of carrying it forward', () => {
  const approved = approveStill(baseShot(), [], { mediaId: MEDIA.still, at: 1 });
  const { approvals } = supersedeStill(approved.shot, approved.approvals, { reason: 'a new still was queued', at: 9 });
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].supersededAt, 9);
  assert.equal(stillGate(approved.shot, approvals).ok, false);
});

// --- materialisation -------------------------------------------------------------------------

test('materialiseShot builds the Frames video from the approved still, the entities and the parts', () => {
  const anchored = baseShot({ anchor: { startFrameMediaId: MEDIA.still } });
  const { shot, approvals } = approveStill(anchored, [], { mediaId: MEDIA.still, jobId: 'still-job', approvedBy: 'dashboard', at: 42 });
  const job = materializeShot(shot, approvals, { projectId: PID, recipes });
  assert.equal(job.kind, undefined);
  assert.equal(job.settings.kind, 'video');
  assert.equal(job.settings.input, 'frames');
  assert.deepEqual(job.referencePlan.firstFrame, { kind: 'mediaId', mediaId: MEDIA.still });
  assert.equal(job.anchor.shotId, 'shot_4');
  assert.equal(job.anchor.startFrameMediaId, MEDIA.still);
  assert.equal(job.anchor.approvedAt, 42);
  assert.equal(job.recipe, 'abra_i2v_4s_360p');
  assert.equal(job.expectedCost, 4); // 360p i2v: the cost shown before the click
  assert.deepEqual(job.entities, [{ entityId: 'ent_rudy', version: 1, mediaId: MEDIA.rudy, role: 'inFrame' }]);
  assert.deepEqual(job.promptParts, shot.promptParts);
  assert.equal(job.prompt, shot.prompt);
});

test('an ingredients shot materialises an Ingredients video once its still is approved', () => {
  const referenced = baseShot({ mode: 'ingredients' });
  const { shot, approvals } = approveStill(referenced, [], { mediaId: MEDIA.still, at: 42 });
  const job = materializeShot(shot, approvals, { projectId: PID, recipes });
  assert.equal(job.settings.input, 'ingredients');
  assert.deepEqual(job.referencePlan.ingredients, [{ kind: 'mediaId', mediaId: MEDIA.rudy }]);
  assert.equal(job.referencePlan.firstFrame, null);
  assert.equal(job.anchor.startFrameMediaId, MEDIA.still); // the approval is recorded even when unused as a frame
});

// --- QC fixes append a block, never rewrite the base (report §2.2, §2.6) ----------------------

test('a QC fix appends a consistency block to the shot and leaves every base hash identical', () => {
  const before = baseShot();
  const base = promptBaseHash(before.promptParts);
  const fixed = shotWithConsistencyBlock(before, { id: 'wardrobe_fix', text: 'the car keeps its two-tone split' }, { at: 700, reason: 'QC fix (wardrobe)' });
  assert.equal(promptBaseHash(fixed.promptParts), base);
  assert.equal(fixed.promptParts.length, before.promptParts.length + 1);
  assert.equal(fixed.promptParts.at(-1).kind, 'consistency');
  assert.equal(fixed.promptParts.at(-1).ref, 'wardrobe_fix');
  assert.equal(fixed.prompt, fixed.promptParts.map((p) => p.text).join('\n\n'));
  assert.match(fixed.prompt, /the car keeps its two-tone split/);
  assert.equal(fixed.history.at(-1).at, 700);
  assert.match(fixed.history.at(-1).reason, /wardrobe/);
  // The shot that was reviewed is untouched: a fix adds to the record, it never edits it.
  assert.deepEqual(before.promptParts, baseShot().promptParts);
  assert.equal(before.history, undefined);
  // A second fix appends again; the base hash still has not moved.
  const twice = shotWithConsistencyBlock(fixed, { id: 'identity_fix', text: 'the face stays Rudy' }, { at: 800 });
  assert.equal(promptBaseHash(twice.promptParts), base);
  assert.deepEqual(twice.promptParts.slice(0, before.promptParts.length), before.promptParts);
  assert.deepEqual(twice.promptParts.slice(before.promptParts.length).map((p) => p.ref), ['wardrobe_fix', 'identity_fix']);
});

test('the shot store appends a block in place of the shot record, keeping its base parts', async () => {
  const area = memoryArea();
  const store = createShotStore(area, { now: () => 900 });
  await store.addMany(PID, [baseShot()]);
  const base = promptBaseHash(baseShot().promptParts);
  const next = await store.appendBlock(PID, 'shot_4', { id: 'artefacts_fix', text: 'no text or watermark' }, { reason: 'QC fix (artefacts)' });
  assert.equal(promptBaseHash(next.promptParts), base);
  assert.equal(next.promptParts.at(-1).ref, 'artefacts_fix');
  const stored = (await store.list(PID)).shots.find((s) => s.id === 'shot_4');
  assert.equal(stored.prompt, next.prompt);
  assert.equal(stored.promptParts.length, baseShot().promptParts.length + 1);
  assert.deepEqual(area.data[SHOTS_KEY].projects[PID].shots[0].promptParts, next.promptParts);
  await assert.rejects(store.appendBlock(PID, 'nope', { id: 'x', text: 'y' }), /No shot/);
});
