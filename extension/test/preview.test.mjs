import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  promotePatch, assertFreePreview, isPreviewJob, isAwaitingPreview, awaitingPreviewCount,
} from '../lib/preview.js';

const videoSettings = {
  kind: 'video', input: 'frames', resolution: '360p', durationS: 4, aspect: '16:9', count: 1,
  refs: [], firstFrame: null, lastFrame: null,
};
const STILL = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
const LAST = '63078305-0723-426c-ab9f-36657a5e0801';

test('promoting attaches the approved still as the first frame and keeps an end frame', () => {
  const job = {
    settings: videoSettings,
    referencePlan: { input: 'frames', ingredients: [], firstFrame: null, lastFrame: { kind: 'mediaId', mediaId: LAST } },
  };
  const patch = promotePatch(job, STILL);
  assert.deepEqual(patch.referencePlan.firstFrame, { kind: 'mediaId', mediaId: STILL });
  assert.deepEqual(patch.referencePlan.lastFrame, { kind: 'mediaId', mediaId: LAST });
  assert.equal(patch.referencePlan.input, 'frames');
  assert.equal(patch.settings.input, 'frames');
  assert.equal(patch.settings.firstFrame, STILL);
  assert.equal(patch.settings.kind, 'video');
});

test('promoting refuses anything that is not a Flow media id (a still can only be an id, never a path)', () => {
  const job = { settings: videoSettings, referencePlan: { input: 'frames', ingredients: [], firstFrame: null, lastFrame: null } };
  assert.throws(() => promotePatch(job, '/Users/me/still.png'), /media id/i);
  assert.throws(() => promotePatch(job, ''), /media id/i);
  assert.throws(() => promotePatch(job, 'not-a-uuid'), /media id/i);
});

test('a preview is refused unless Flow reports it as free', () => {
  assert.doesNotThrow(() => assertFreePreview(0, 'NARWHAL'));
  assert.throws(() => assertFreePreview(4, 'abra_t2v_4s_360p'), /0-credit.*4 credits/);
  assert.throws(() => assertFreePreview(null, 'GEM_PIX_2'), /unknown cost/);
});

test('roles and states are read from the job, and the held videos are counted', () => {
  assert.equal(isPreviewJob({ role: 'preview' }), true);
  assert.equal(isPreviewJob({ role: 'video' }), false);
  assert.equal(isPreviewJob(null), false);
  assert.equal(isAwaitingPreview({ state: 'awaiting-preview' }), true);
  assert.equal(isAwaitingPreview({ state: 'queued' }), false);
  assert.equal(awaitingPreviewCount([{ state: 'awaiting-preview' }, { state: 'queued' }, { state: 'awaiting-preview' }]), 2);
  assert.equal(awaitingPreviewCount([]), 0);
});
