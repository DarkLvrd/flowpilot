import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchResponse } from '../lib/rpc.js';
import { parseProjectMedia, parseMediaDetail, parseEntities, characterUsed, findResult } from '../lib/media.js';
import { fixture } from './helpers.mjs';

const PROJECT = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';
const IMAGE_1 = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
const VIDEO = '63078305-0723-426c-ab9f-36657a5e0801';
const media = parseProjectMedia(parseBatchResponse(fixture('Zzl0ze'), 'Zzl0ze').data);

test('lists every generation in the project (recon: 2 images, 1 video)', () => {
  assert.equal(media.length, 3);
  assert.deepEqual(media.map((m) => m.kind).sort(), ['image', 'image', 'video']);
  assert.ok(media.every((m) => m.projectId === PROJECT));
});

test('a video record carries its prompt, recipe and ingredient', () => {
  const v = media.find((m) => m.mediaId === VIDEO);
  assert.deepEqual(
    { prompt: v.prompt, recipe: v.recipe, ingredientIds: v.ingredientIds, workflowId: v.workflowId },
    { prompt: 'he is riding his house', recipe: 'abra_r2v_4s_360p', ingredientIds: [IMAGE_1], workflowId: 'af10a18f-c1af-40ea-8b3d-673298f5f101' },
  );
  assert.equal(v.createdAt, 1790569610232);
});

test('an image record carries its prompt and no recipe', () => {
  const i = media.find((m) => m.mediaId === IMAGE_1);
  assert.equal(i.prompt, 'a boy on a horse');
  assert.equal(i.recipe, null);
  assert.deepEqual(i.ingredientIds, []);
});

test('an empty project is an empty list, a shapeless payload is an error', () => {
  assert.deepEqual(parseProjectMedia([null, [], []]), []);
  assert.throws(() => parseProjectMedia({}), /Flow changed/);
});

test('media detail gives the signed download URL and kind', () => {
  const d = parseMediaDetail(parseBatchResponse(fixture('as29s'), 'as29s').data);
  assert.equal(d.mediaId, IMAGE_1);
  assert.equal(d.kind, 'image');
  assert.match(d.url, /^https:\/\/flow-content\.google\/image\/1037d045-1d92-4e1e-a0f7-b695b9ed1372\?Expires=\d+&KeyName=[^&]+&Signature=/);
});

test('media detail without a signed URL is an error (never guess a URL)', () => {
  assert.throws(() => parseMediaDetail([IMAGE_1, PROJECT, 'w', 'CAE', null, []]), /Flow changed/);
});

test('finds a job result by verbatim prompt, created after the click, not taken by another job', () => {
  const clickedAt = 1790569600000;
  const hit = findResult(media, { prompt: 'he is riding his house', since: clickedAt, exclude: [] });
  assert.equal(hit.mediaId, VIDEO);
  assert.equal(findResult(media, { prompt: 'he is riding his house', since: clickedAt, exclude: [VIDEO] }), null);
  assert.equal(findResult(media, { prompt: 'he is riding his house ', since: clickedAt, exclude: [] }), null);
  assert.equal(findResult(media, { prompt: 'a boy on a horse', since: clickedAt, exclude: [] }), null);
});

// First live job (2026-09-28): Flow gave the workflow its own short title, so the workflow's
// text is no longer the prompt. The verbatim prompt is inside the media record.
test('finds a result by its verbatim prompt when Flow titled the workflow differently', () => {
  const live = parseProjectMedia(parseBatchResponse(fixture('Zzl0ze-first-job'), 'Zzl0ze').data);
  const fox = live.find((m) => m.mediaId === '6a2d2214-751e-4e3c-9cc7-98867c205121');
  assert.equal(fox.prompt, 'a red fox trotting through fresh snow at dawn, soft light');
  assert.equal(fox.kind, 'video');
  assert.equal(fox.recipe, 'abra_t2v_4s_360p');
  const hit = findResult(live, { prompt: 'a red fox trotting through fresh snow at dawn, soft light', since: 1790654667771 - 120_000 });
  assert.equal(hit?.mediaId, '6a2d2214-751e-4e3c-9cc7-98867c205121');
});

// First live job: a video's detail lists a poster image URL before the video URL.
test('media detail gives the URL of the kind asked for: the video, not its poster', () => {
  const inner = parseBatchResponse(fixture('as29s-first-job'), 'as29s').data;
  const video = parseMediaDetail(inner, 'video');
  assert.equal(video.kind, 'video');
  assert.match(video.url, /^https:\/\/flow-content\.google\/video\/6a2d2214-751e-4e3c-9cc7-98867c205121\?/);
  assert.equal(video.mediaId, '6a2d2214-751e-4e3c-9cc7-98867c205121');
  assert.equal(parseMediaDetail(inner, 'image').kind, 'image');
});

// The prompt's rich-text form is [[["prompt"]]]: exactly one string inside. A nested list that
// merely starts with a string (a recipe entry, say) is not the prompt.
// ---- Flow Characters (report §2, §5; data/flowpilot-flow-characters/report.md) ------------------

const ENTITY = '0bfec740-409e-42f5-80d1-82baac3349f3';
const PRIMARY = 'b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca';
const REF_WORKFLOW = 'e3696fd0-eb73-4b82-a8a2-096fa4cb0dde';
const CHAR_PROJECT = 'de7baa89-1896-4825-bf06-ab0853619277';
const charInner = parseBatchResponse(fixture('Zzl0ze-characters'), 'Zzl0ze').data;

// The verbatim entity record the report captured, at response field 6 (JSON index 5).
test('parseEntities reads the character list out of the project contents', () => {
  const entities = parseEntities(charInner);
  assert.equal(entities.length, 1);
  assert.deepEqual(entities[0], {
    entityId: ENTITY,
    projectId: CHAR_PROJECT,
    name: 'nancy',
    primaryMediaId: PRIMARY,
    referenceWorkflowIds: [REF_WORKFLOW],
  });
});

// Zero characters is the normal case (18 of 19 projects in the recon), and it is an empty list,
// not an error: a field that is absent or null says "this project has no characters".
test('a project with no characters reads as an empty list, a shapeless payload still errors', () => {
  assert.deepEqual(parseEntities([null, [], [], [], null, null]), []);
  assert.deepEqual(parseEntities([null, [], []]), []);
  assert.throws(() => parseEntities({}), /Flow changed/);
  assert.throws(() => parseEntities([null, [], [], [], null, 'not a list']), /Flow changed/);
});

// Fail closed: a node that does not look like a CHARACTER entity is skipped rather than guessed
// at — a wrong entityId would attach the wrong subject and the credits would still be spent.
test('parseEntities skips records that are not CHARACTER entities, and never invents an id', () => {
  const other = [CHAR_PROJECT, ENTITY, null, [2, 'a car', []], PRIMARY, [1, 1], [1, 0], [1, 0]];
  const noName = [CHAR_PROJECT, ENTITY, null, [1, '', []], PRIMARY, [1, 1], [1, 0], [1, 0]];
  const noId = [CHAR_PROJECT, 'not-an-id', null, [1, 'nancy', []], PRIMARY, [1, 1], [1, 0], [1, 0]];
  assert.deepEqual(parseEntities([null, [], [], [], null, [other, noName, noId, 'x', null]]), []);
  // A character with no primary image / no reference workflows is still a character.
  const bare = [CHAR_PROJECT, ENTITY, null, [1, 'nancy', [[[]]]], null, null, null, null];
  assert.deepEqual(parseEntities([null, [], [], [], null, [bare]]), [
    { entityId: ENTITY, projectId: CHAR_PROJECT, name: 'nancy', primaryMediaId: null, referenceWorkflowIds: [] },
  ]);
});

// Report §5: the finished generation's own record echoes the character back — a mention segment in
// the prompt content and an entity-reference list. This is what the QC card states as verified.
test('a record reads back the entity mention and the entity-reference list', () => {
  const record = parseProjectMedia(charInner).find((m) => m.entityMentions.length || m.entityRefs.length);
  assert.deepEqual(record.entityMentions, [{ entityId: ENTITY, name: 'nancy' }]);
  assert.deepEqual(record.entityRefs, [ENTITY]);
  assert.equal(record.recipe, 'abra_r2v_4s_360p');
  // The prompt of a mention job is the full text Flow stored, chip text included (double space).
  assert.equal(record.prompt, "nancy  is in a Formula One car because this is her first time and she's looking kind of scared.");
});

test('characterUsed confirms only the character the record actually shows', () => {
  const record = parseProjectMedia(charInner).find((m) => m.entityMentions.length);
  assert.deepEqual(characterUsed(record, [{ entityId: ENTITY, name: 'nancy' }]), { entityId: ENTITY, name: 'nancy' });
  // A job that expected another character, or expected none, is not confirmed by this record.
  assert.equal(characterUsed(record, [{ entityId: '11111111-1111-4111-8111-111111111111', name: 'rudy' }]), null);
  assert.equal(characterUsed(record, []), null);
  assert.equal(characterUsed(record, null), null);
  // An entity-reference list alone (a chip-only attach, unverified on the wire) still confirms the id.
  const refOnly = { entityMentions: [], entityRefs: [ENTITY] };
  assert.deepEqual(characterUsed(refOnly, [{ entityId: ENTITY, name: 'nancy' }]), { entityId: ENTITY, name: 'nancy' });
});

test('the verbatim prompt is the one-string [[["…"]]] node, not any nested list that starts with a string', () => {
  const MID = '11111111-1111-1111-1111-111111111111';
  const WID = '22222222-2222-2222-2222-222222222222';
  const inner = [null, [], [[MID, PROJECT, WID, 'CAE', null, [[1_790_569_695, 0], null,
    [null, [[['abra_t2v_4s_360p', 1, null]]], [[null, null, [[['prompt a']]]]]]]]]];
  assert.equal(parseProjectMedia(inner)[0].prompt, 'prompt a');
});
