import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchResponse } from '../lib/rpc.js';
import { parseProjectMedia, parseMediaDetail, findResult } from '../lib/media.js';
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
