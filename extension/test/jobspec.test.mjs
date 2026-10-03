import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchResponse } from '../lib/rpc.js';
import { parseCatalog } from '../lib/catalog.js';
import { buildJob, safeName } from '../lib/jobspec.js';
import { fixture } from './helpers.mjs';

const recipes = parseCatalog(parseBatchResponse(fixture('HTrJv'), 'HTrJv').data);
const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';

const base = { prompt: 'a red fox', kind: 'video', resolution: '360p', durationS: 4 };
const build = (spec = {}, opts = {}) => buildJob({ ...base, ...spec }, { projectId: PID, recipes, ...opts });

test('a plain video job carries the recipe, its cost and the catalog family name', () => {
  const job = build({ name: 'fox' });
  assert.equal(job.recipe, 'abra_t2v_4s_360p');
  assert.equal(job.expectedCost, 4);
  assert.equal(job.modelFamily, 'Omni 1.1 Flash');
  assert.equal(job.name, 'fox');
  assert.equal(job.projectId, PID);
  assert.equal(job.settings.input, 'ingredients'); // Flow has no text radio; text is empty Ingredients
  assert.equal(job.settings.count, 1);
  assert.equal(job.references, null);
  assert.equal(job.state, undefined); // pure: the store adds id/state/timestamps
});

test('count multiplies the credit cost', () => {
  assert.equal(build({ count: 4 }).expectedCost, 16);
});

test('an image job is priced from the image recipe (free today) and takes no references', () => {
  const job = build({ kind: 'image', input: undefined, refs: undefined, resolution: undefined, durationS: undefined, model: 'nano-banana-pro' });
  assert.equal(job.recipe, 'GEM_PIX_2');
  assert.equal(job.expectedCost, 0);
  assert.equal(job.settings.kind, 'image');
  assert.throws(() => build({ kind: 'image', refs: ['/pics/face.png'] }), /video/i);
});

test('the prompt is trimmed and CRLF-normalized; an empty prompt is refused', () => {
  assert.equal(build({ prompt: '  a  fox\r\nruns  ' }).prompt, 'a  fox\nruns');
  assert.throws(() => build({ prompt: '   ' }), /Prompt is empty/);
  assert.throws(() => build({ prompt: undefined }), /Prompt is empty/);
});

test('a bad project id is refused', () => {
  assert.throws(() => build({}, { projectId: 'not-a-uuid' }), /project id/i);
});

test('the input mode is inferred from the fields, exactly like the dashboard', () => {
  assert.equal(build({}).settings.input, 'ingredients');
  assert.equal(build({ refs: [PID] }).settings.input, 'ingredients');
  assert.equal(build({ firstFrame: PID }).settings.input, 'frames');
  assert.equal(build({ firstFrame: PID }).referencePlan.input, 'frames');
  assert.equal(build({ input: 'ingredients', refs: [PID] }).referencePlan.ingredients[0].mediaId, PID);
});

test('a malformed reference is refused with the reference module’s clear error', () => {
  assert.throws(() => build({ input: 'ingredients', refs: ['not-an-id-or-path'] }), /media id or an absolute path/);
  assert.throws(() => build({ input: 'ingredients', refs: [] }), /at least one reference/);
  assert.throws(() => build({ input: 'frames', firstFrame: undefined }), /first frame/);
});

test('an absolute output path is kept, but only with the right extension for the kind', () => {
  assert.equal(build({ outputPath: '/Users/me/film/fox.mp4' }).outputPath, '/Users/me/film/fox.mp4');
  assert.throws(() => build({ outputPath: 'film/fox.mp4' }), /absolute/);
  assert.throws(() => build({ outputPath: '/Users/me/.zshrc' }), /\.mp4/);
});

test('aspect and count are checked', () => {
  assert.throws(() => build({ aspect: '4:3' }), /aspect/);
  assert.throws(() => build({ count: 9 }), /Count must be 1-4/);
});

test('an unreadable catalog still builds the job but with unknown cost and model', () => {
  const job = buildJob({ ...base, name: 'x' }, { projectId: PID, recipes: null });
  assert.equal(job.expectedCost, null);
  assert.equal(job.modelFamily, null);
  assert.equal(job.recipe, 'abra_t2v_4s_360p');
});

test('the job name is sanitized and falls back to a stable default', () => {
  assert.equal(build({ name: 'a/b:c*d' }).name, 'a_b_c_d');
  assert.equal(build({ name: '   ' }).name, 'untitled');
});

test('a non-numeric duration on a video row is refused with its value, not NaN', () => {
  assert.throws(() => build({ durationS: 'abc' }), /Unsupported duration: "abc"/);
  // An image job ignores duration, so it still builds.
  assert.equal(build({ kind: 'image', durationS: 'abc' }).settings.kind, 'image');
});

test('a name template produces the relative output path, with {project} and {scene}', () => {
  const job = build({ name: 'opening shot', scene: 'opening shot' }, { template: '{project}/{scene}-{index}', index: 3, total: 10 });
  assert.equal(job.relativePath, `${PID}/opening shot-03`); // padded so a 10-row batch sorts
  assert.equal(build({ name: 'only-a-name' }, { template: '{scene}-{index}', index: 1 }).relativePath, 'only-a-name-1');
  assert.equal(job.name, 'opening shot'); // the queue label stays the scene name
});

test('a template token with no value refuses the row rather than guessing', () => {
  assert.throws(() => build({}, { template: '{scene}-{index}', index: 1 }), /scene/);
  assert.throws(() => build({ name: 'x' }, { template: '{scene}-{index}' }), /index/);
});

test('safeName keeps dots, dashes and spaces and caps the length', () => {
  assert.equal(safeName('a.b-c d.mp4'), 'a.b-c d.mp4');
  assert.equal(safeName('x'.repeat(300)).length, 120);
});

// Preview-first (lib/preview.js): the video is created before its still exists, so buildJob is
// asked to hold the first frame. The job must still be priced as the Frames recipe it will run,
// with no first frame attached yet, and must refuse anything that contradicts the still.
test('holdFirstFrame builds a Frames video with no first frame, priced as the frames recipe it will run', () => {
  const job = build({ name: 'film' }, { holdFirstFrame: true });
  assert.equal(job.settings.input, 'frames');
  assert.equal(job.settings.firstFrame, null);
  assert.equal(job.referencePlan.input, 'frames');
  assert.equal(job.referencePlan.firstFrame, null);
  assert.equal(job.recipe, 'abra_i2v_4s_360p');
  assert.equal(job.expectedCost, 4);
});

test('holdFirstFrame keeps an end frame, classifying it like any other frame reference', () => {
  const job = build({ name: 'film', lastFrame: '63078305-0723-426c-ab9f-36657a5e0801' }, { holdFirstFrame: true });
  assert.deepEqual(job.referencePlan.lastFrame, { kind: 'mediaId', mediaId: '63078305-0723-426c-ab9f-36657a5e0801' });
  assert.equal(job.recipe, 'omni_flash_i2v_4s_first_last_360p');
});

test('holdFirstFrame refuses ingredient references, a given first frame, and a non-video kind', () => {
  assert.throws(() => build({ name: 'x', refs: ['1037d045-1d92-4e1e-a0f7-b695b9ed1372'] }, { holdFirstFrame: true }), /Frames, not ingredient/);
  assert.throws(() => build({ name: 'x', firstFrame: '1037d045-1d92-4e1e-a0f7-b695b9ed1372' }, { holdFirstFrame: true }), /first frame from the still/);
  assert.throws(() => build({ name: 'x', kind: 'image' }, { holdFirstFrame: true }), /Only a video job/);
});
