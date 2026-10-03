import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchResponse } from '../lib/rpc.js';
import { parseProjectMedia } from '../lib/media.js';
import { classifyRef, validateReferences, newlyUploadedId, referenceNames, MAX_INGREDIENTS, MAX_CHARACTERS } from '../lib/refs.js';
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

// ---- Flow Characters (report §8.1 step 3): a character is an entity id, not an uploaded photo ---

const CHAR = '0bfec740-409e-42f5-80d1-82baac3349f3';
const CHAR2 = '11111111-1111-4111-8111-111111111111';

// The plan keeps its old shape when no character is asked for, so nothing downstream changes.
test('a job without a character keeps the old plan shape', () => {
  assert.equal('characters' in validateReferences({ input: 'text' }), false);
  assert.equal('characters' in validateReferences({ input: 'ingredients', refs: [ID] }), false);
});

test('a character rides along with the prompt: entity id and name, validated', () => {
  const v = validateReferences({ input: 'text', characters: [{ entityId: CHAR, name: 'nancy' }] });
  assert.deepEqual(v.characters, [{ entityId: CHAR, name: 'nancy' }]);
  assert.deepEqual(v.ingredients, []);
  // Flow holds the character, so an Ingredients job can be character-only — the picker attaches it.
  assert.deepEqual(validateReferences({ input: 'ingredients', characters: [{ entityId: CHAR, name: 'nancy' }] }).ingredients, []);
  assert.deepEqual(validateReferences({ input: 'ingredients', refs: [ID], characters: [{ entityId: CHAR, name: 'nancy' }] }).characters, [{ entityId: CHAR, name: 'nancy' }]);
});

test('a character without a usable id or name fails closed, never attached on a name alone', () => {
  assert.throws(() => validateReferences({ input: 'text', characters: [{ name: 'nancy' }] }), /entity id/i);
  assert.throws(() => validateReferences({ input: 'text', characters: [{ entityId: 'nancy', name: 'nancy' }] }), /entity id/i);
  assert.throws(() => validateReferences({ input: 'text', characters: [{ entityId: CHAR, name: '  ' }] }), /name/i);
  assert.throws(() => validateReferences({ input: 'text', characters: [{ entityId: CHAR, name: 'nancy' }, { entityId: CHAR, name: 'nancy' }] }), /twice|duplicate/i);
  const many = Array.from({ length: MAX_CHARACTERS + 1 }, (_, i) => ({ entityId: `${i}1111111-1111-4111-8111-111111111111`, name: `c${i}` }));
  assert.throws(() => validateReferences({ input: 'text', characters: many }), new RegExp(`${MAX_CHARACTERS}`));
});

// Frames replaces the ingredient bar with the start/end slots (report §6), so there is no chip to
// attach and nothing to verify: a Frames job with a character is refused before it is ever queued.
test('a Frames job refuses a character (its composer has no character chip)', () => {
  assert.throws(() => validateReferences({ input: 'frames', firstFrame: ID, characters: [{ entityId: CHAR, name: 'nancy' }] }), /Frames/i);
  assert.deepEqual(validateReferences({ input: 'frames', firstFrame: ID }), { input: 'frames', ingredients: [], firstFrame: { kind: 'mediaId', mediaId: ID }, lastFrame: null });
  // A raw string is not a character record: refused, not silently dropped.
  assert.throws(() => validateReferences({ input: 'text', characters: [CHAR2] }), /entity id/i);
});

test('referenceNames maps media ids to their Zzl0ze names (the driver matches picker tiles by name)', () => {
  const media = parseProjectMedia(parseBatchResponse(fixture('Zzl0ze'), 'Zzl0ze').data);
  const names = referenceNames(media, [ID, ID2, 'ffffffff-ffff-4fff-8fff-ffffffffffff']);
  assert.equal(names[ID], 'a boy on a horse');
  assert.equal(names[ID2], 'he is riding his house');
  assert.ok(!('ffffffff-ffff-4fff-8fff-ffffffffffff' in names)); // unknown id omitted -> driver fails closed
});

test('newlyUploadedId finds the upload by its file name and image kind, else fails closed', () => {
  const rec = (mediaId, kind, prompt) => ({ mediaId, kind, prompt });
  const existing = rec('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'image', 'old photo');
  const upload = rec('11111111-1111-4111-8111-111111111111', 'image', 'face.png');
  const before = [existing];

  // Plain case: the uploaded image appears under its file name.
  assert.equal(newlyUploadedId(before, [existing, upload], 'face.png'), upload.mediaId);

  // Busy shared project: an unrelated video render lands during the upload (LESSONS #13, finding
  // #2). The old "exactly one new record" rule would over-count and fail; the name + image-kind
  // match still picks the upload.
  const render = rec('22222222-2222-4222-8222-222222222222', 'video', 'someone else’s clip');
  assert.equal(newlyUploadedId(before, [existing, render, upload], 'face.png'), upload.mediaId);

  // Not visible yet: nothing new, or only unrelated media landed — retryable, fails closed.
  assert.throws(() => newlyUploadedId(before, [existing], 'face.png'), /not visible/i);
  assert.throws(() => newlyUploadedId(before, [existing, render], 'face.png'), /not visible/i);

  // Ambiguous: two fresh images share the uploaded name — never guess which to attach.
  const dup = rec('33333333-3333-4333-8333-333333333333', 'image', 'face.png');
  assert.throws(() => newlyUploadedId(before, [existing, upload, dup], 'face.png'), /ambiguous|several|cannot tell/i);
});
