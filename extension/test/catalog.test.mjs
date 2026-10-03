import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchResponse } from '../lib/rpc.js';
import { parseCatalog, creditCost, recipeFor } from '../lib/catalog.js';
import { fixture } from './helpers.mjs';

const catalog = parseCatalog(parseBatchResponse(fixture('HTrJv'), 'HTrJv').data);

test('reads Omni Flash recipes with their credit costs (recon: 4s 720p = 7, 4s 360p = 4)', () => {
  assert.equal(creditCost(catalog, 'abra_i2v_4s'), 7);
  assert.equal(creditCost(catalog, 'abra_r2v_4s_360p'), 4);
  assert.equal(creditCost(catalog, 'abra_t2v_10s'), 15);
  assert.equal(creditCost(catalog, 'omni_flash_i2v_8s_first_last_360p'), 6);
});

test('images are free', () => {
  assert.equal(creditCost(catalog, 'NARWHAL'), 0);
  assert.equal(creditCost(catalog, 'GEM_PIX_2'), 0);
});

test('knows the family and duration of a recipe', () => {
  const r = catalog.get('abra_r2v_6s_360p');
  assert.equal(r.family, 'Omni 1.1 Flash');
  assert.equal(r.durationS, 6);
});

test('cost that differs by tier is unknown unless the tier is given', () => {
  // veo_3_1_t2v_lite: tiers 1 and 2 cost 10, tier 3 costs 5
  assert.equal(creditCost(catalog, 'veo_3_1_t2v_lite'), null);
  assert.equal(creditCost(catalog, 'veo_3_1_t2v_lite', 2), 10);
  assert.equal(creditCost(catalog, 'veo_3_1_t2v_lite', 3), 5);
});

test('a recipe not offered on a tier has no cost there', () => {
  assert.equal(creditCost(catalog, 'veo_3_1_t2v_lite_4s', 1), null);
});

test('unknown recipe has no cost (fail closed)', () => {
  assert.equal(creditCost(catalog, 'no_such_recipe'), null);
});

test('a catalog with no recipes is an error', () => {
  assert.throws(() => parseCatalog([[null, null, []]]), /Flow changed/);
});

test('picks the Omni Flash recipe for each video input', () => {
  const v = (input, extra = {}) => recipeFor({ kind: 'video', input, durationS: 4, resolution: '720p', ...extra });
  assert.equal(v('text'), 'abra_t2v_4s');
  assert.equal(v('ingredients', { refs: ['m1'] }), 'abra_r2v_4s');
  assert.equal(v('frames', { firstFrame: 'm1' }), 'abra_i2v_4s');
  assert.equal(v('frames', { firstFrame: 'm1', lastFrame: 'm2' }), 'omni_flash_i2v_4s_first_last');
  assert.equal(v('ingredients', { refs: ['m1'], resolution: '360p', durationS: 8 }), 'abra_r2v_8s_360p');
  assert.equal(v('frames', { firstFrame: 'm1', lastFrame: 'm2', resolution: '360p' }), 'omni_flash_i2v_4s_first_last_360p');
  // A Flow Character is a reference like an ingredient (report §3c): a character-only job is r2v,
  // not text-to-video, and the paid capture's job is `abra_r2v_4s_360p`.
  assert.equal(v('ingredients', { characters: [{ entityId: 'e1', name: 'nancy' }], resolution: '360p' }), 'abra_r2v_4s_360p');
});

test('picks the image recipe (recon: tiles show Nano Banana 2)', () => {
  assert.equal(recipeFor({ kind: 'image' }), 'NARWHAL');
  assert.equal(recipeFor({ kind: 'image', model: 'nano-banana-pro' }), 'GEM_PIX_2');
});

test('rejects settings Flow does not offer', () => {
  assert.throws(() => recipeFor({ kind: 'video', input: 'text', durationS: 5, resolution: '720p' }), /duration/);
  assert.throws(() => recipeFor({ kind: 'video', input: 'text', durationS: 4, resolution: '1080p' }), /resolution/);
  assert.throws(() => recipeFor({ kind: 'video', input: 'frames', durationS: 4, resolution: '720p' }), /first frame/);
});
