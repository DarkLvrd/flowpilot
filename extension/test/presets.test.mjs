import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreset, normalizePreset, applyPresetToSpec, PRESET_DEFAULTS } from '../lib/presets.js';

const REF = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';
const REF2 = '63078305-0723-426c-ab9f-36657a5e0801';

test('a default preset is valid and carries the documented fields', () => {
  const p = normalizePreset(defaultPreset());
  assert.deepEqual(Object.keys(p).sort(), ['aspect', 'count', 'durationS', 'firstFrame', 'folder', 'kind', 'lastFrame', 'name', 'refs', 'resolution', 'template']);
  assert.equal(p.kind, 'video');
  assert.equal(p.resolution, '720p');
  assert.equal(p.durationS, 4);
  assert.equal(p.aspect, '16:9');
  assert.equal(p.count, 1);
  assert.equal(p.template, PRESET_DEFAULTS.template);
  assert.deepEqual(p.refs, []);
});

test('a preset survives a JSON round-trip unchanged', () => {
  const input = defaultPreset({
    name: 'client A', kind: 'video', resolution: '360p', durationS: 8, aspect: '9:16', count: 2,
    template: '{project}/{scene}-{index}', folder: 'client-a', refs: [REF], firstFrame: null, lastFrame: null,
  });
  const once = normalizePreset(input);
  const twice = normalizePreset(JSON.parse(JSON.stringify(once)));
  assert.deepEqual(twice, once);
});

test('bad values are refused with a clear message', () => {
  assert.throws(() => normalizePreset({ kind: 'gif' }), /kind/i);
  assert.throws(() => normalizePreset({ resolution: '1080p' }), /resolution/i);
  assert.throws(() => normalizePreset({ durationS: 5 }), /duration/i);
  assert.throws(() => normalizePreset({ aspect: '4:3' }), /aspect/i);
  assert.throws(() => normalizePreset({ count: 9 }), /count/i);
  assert.throws(() => normalizePreset({ template: '{nope}' }), /nope/);
});

test('an image preset cannot carry video references', () => {
  assert.throws(() => normalizePreset({ kind: 'image', refs: [REF] }), /video/i);
  assert.throws(() => normalizePreset({ kind: 'image', firstFrame: REF }), /video/i);
});

test('a preset cannot carry both Ingredients references and Frames', () => {
  assert.throws(() => normalizePreset({ refs: [REF], firstFrame: REF2 }), /both|either/i);
});

test('a malformed reference in a preset is refused', () => {
  assert.throws(() => normalizePreset({ refs: ['not-a-ref'] }), /media id or an absolute path/);
});

test('applyPresetToSpec fills only what the row left out', () => {
  const preset = normalizePreset(defaultPreset({ kind: 'video', resolution: '360p', durationS: 8, aspect: '9:16', count: 2, refs: [REF] }));
  const spec = applyPresetToSpec(preset, { prompt: 'x', resolution: '720p' });
  assert.equal(spec.resolution, '720p'); // the row wins
  assert.equal(spec.durationS, 8);
  assert.equal(spec.aspect, '9:16');
  assert.equal(spec.count, 2);
  assert.deepEqual(spec.refs, [REF]); // the default reference set
  assert.equal(spec.prompt, 'x');
});

test('the preset reference set does not turn an explicit text row into an Ingredients row', () => {
  const preset = normalizePreset(defaultPreset({ refs: [REF] }));
  const spec = applyPresetToSpec(preset, { prompt: 'x', input: 'text' });
  assert.equal(spec.refs, undefined);
});

test('a row that brings its own references keeps them', () => {
  const preset = normalizePreset(defaultPreset({ refs: [REF] }));
  const spec = applyPresetToSpec(preset, { prompt: 'x', refs: [REF2] });
  assert.deepEqual(spec.refs, [REF2]);
});
