import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchResponse } from '../lib/rpc.js';
import { parseProjectMedia } from '../lib/media.js';
import { classifyRef, validateReferences, newlyUploadedId, referenceNames, MAX_INGREDIENTS } from '../lib/refs.js';
import { fixture } from './helpers.mjs';

const ID = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
const ID2 = '63078305-0723-426c-ab9f-36657a5e0801';

test('classifies a Flow media id and an absolute path; rejects anything else', () => {
  assert.deepEqual(classifyRef(ID), { kind: 'mediaId', mediaId: ID });
  assert.deepEqual(classifyRef('/home/me/face.png'), { kind: 'path', path: '/home/me/face.png' });
  assert.deepEqual(classifyRef('C:\\pics\\face.png'), { kind: 'path', path: 'C:\\pics\\face.png' });
  assert.equal(classifyRef(`  ${ID}  `).mediaId, ID); // trims
  assert.throws(() => classifyRef('face.png'), /media id or an absolute path/);
  assert.throws(() => classifyRef('http://x/face.png'), /media id or an absolute path/);
  assert.throws(() => classifyRef(''), /media id or an absolute path/);
  assert.throws(() => classifyRef(42), /media id or an absolute path/);
});

test('text input carries no references', () => {
  assert.deepEqual(validateReferences({ input: 'text' }), { input: 'text', ingredients: [], firstFrame: null, lastFrame: null });
  assert.throws(() => validateReferences({ input: 'text', refs: [ID] }), /text.*no reference|no reference.*text/i);
  assert.throws(() => validateReferences({ input: 'text', firstFrame: ID }), /text|frame/i);
});

test('ingredients input needs at least one reference, up to the Flow limit, no duplicates', () => {
  const v = validateReferences({ input: 'ingredients', refs: [ID, '/a/b.png'] });
  assert.equal(v.input, 'ingredients');
  assert.deepEqual(v.ingredients, [{ kind: 'mediaId', mediaId: ID }, { kind: 'path', path: '/a/b.png' }]);
  assert.deepEqual(v.firstFrame, null);
  assert.deepEqual(v.lastFrame, null);
  assert.throws(() => validateReferences({ input: 'ingredients', refs: [] }), /at least one/i);
  assert.throws(() => validateReferences({ input: 'ingredients' }), /at least one/i);
  assert.throws(() => validateReferences({ input: 'ingredients', refs: [ID, ID] }), /duplicate/i);
  const many = Array.from({ length: MAX_INGREDIENTS + 1 }, (_, i) => `/a/${i}.png`);
  assert.throws(() => validateReferences({ input: 'ingredients', refs: many }), new RegExp(`${MAX_INGREDIENTS}`));
});

test('ingredients input rejects frames fields', () => {
  assert.throws(() => validateReferences({ input: 'ingredients', refs: [ID], firstFrame: ID2 }), /frame/i);
});

test('frames input needs a first frame; last is optional; no extra refs', () => {
  const only = validateReferences({ input: 'frames', firstFrame: ID });
  assert.deepEqual(only, { input: 'frames', ingredients: [], firstFrame: { kind: 'mediaId', mediaId: ID }, lastFrame: null });
  const both = validateReferences({ input: 'frames', firstFrame: '/a/first.png', lastFrame: ID2 });
  assert.deepEqual(both.firstFrame, { kind: 'path', path: '/a/first.png' });
  assert.deepEqual(both.lastFrame, { kind: 'mediaId', mediaId: ID2 });
  assert.throws(() => validateReferences({ input: 'frames' }), /first frame/i);
  assert.throws(() => validateReferences({ input: 'frames', lastFrame: ID }), /first frame/i);
  assert.throws(() => validateReferences({ input: 'frames', firstFrame: ID, refs: [ID2] }), /frame.*ingredient|ingredient.*frame|reference/i);
  assert.throws(() => validateReferences({ input: 'frames', firstFrame: ID, lastFrame: ID }), /same|duplicate/i);
});

test('an unknown input mode is refused', () => {
  assert.throws(() => validateReferences({ input: 'wat' }), /input/i);
});

test('referenceNames maps media ids to their Zzl0ze names (the driver matches picker tiles by name)', () => {
  const media = parseProjectMedia(parseBatchResponse(fixture('Zzl0ze'), 'Zzl0ze').data);
  const names = referenceNames(media, [ID, ID2, 'ffffffff-ffff-4fff-8fff-ffffffffffff']);
  assert.equal(names[ID], 'a boy on a horse');
  assert.equal(names[ID2], 'he is riding his house');
  assert.ok(!('ffffffff-ffff-4fff-8fff-ffffffffffff' in names)); // unknown id omitted -> driver fails closed
});

test('newlyUploadedId returns the single new media id after an upload, else fails closed', () => {
  const after = parseProjectMedia(parseBatchResponse(fixture('Zzl0ze'), 'Zzl0ze').data);
  const before = after.filter((m) => m.mediaId !== ID);
  assert.equal(newlyUploadedId(before, after), ID);
  assert.throws(() => newlyUploadedId(after, after), /no new media/i);
  const twoNew = after.filter((m) => m.mediaId === ID);
  assert.throws(() => newlyUploadedId([], twoNew.concat(after.filter((m) => m.mediaId === ID2))), /one new media/i);
});
