import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNameTemplate, sanitizePath, uniquify, DEFAULT_TEMPLATE, TOKENS } from '../lib/naming.js';

// ---- applyNameTemplate -----------------------------------------------------------------------

test('the default template turns a scene and index into a predictable relative name', () => {
  const name = applyNameTemplate(DEFAULT_TEMPLATE, { project: 'my-film', scene: 'opening shot', index: 1 });
  assert.equal(name, 'my-film/opening shot-1');
});

test('a template without a project token is scoped to the flow of the template', () => {
  assert.equal(applyNameTemplate('{scene}-{index}', { scene: 'fox', index: 7 }), 'fox-7');
});

test('every documented token is substituted', () => {
  const name = applyNameTemplate('{project}/{scene}-{index}-{name}-{prompt}', {
    project: 'p', scene: 's', index: 3, name: 'n', prompt: 'a red fox runs',
  });
  assert.equal(name, 'p/s-3-n-a red fox runs');
});

test('the token list is the documented one', () => {
  assert.deepEqual([...TOKENS].sort(), ['index', 'name', 'project', 'prompt', 'scene']);
});

test('an unknown token is refused rather than left in the file name', () => {
  assert.throws(() => applyNameTemplate('{scene}-{oops}', { scene: 'a', index: 1 }), /\{oops\}/);
});

test('a missing token value is refused, not silently blanked', () => {
  assert.throws(() => applyNameTemplate('{scene}-{index}', { index: 1 }), /scene/);
  assert.throws(() => applyNameTemplate('{scene}-{index}', { scene: 'a' }), /index/);
});

test('an empty or non-string template is refused', () => {
  assert.throws(() => applyNameTemplate('', { scene: 'a', index: 1 }), /template/i);
  assert.throws(() => applyNameTemplate(null, { scene: 'a', index: 1 }), /template/i);
});

test('index is zero-padded to the width of the batch size when one is given', () => {
  assert.equal(applyNameTemplate('{scene}-{index}', { scene: 'a', index: 7, total: 120 }), 'a-007');
  assert.equal(applyNameTemplate('{scene}-{index}', { scene: 'a', index: 7, total: 9 }), 'a-7');
});

test('path-hostile characters are sanitized and traversal is impossible', () => {
  assert.equal(applyNameTemplate('{scene}', { scene: 'a/b\\c:d*e?f"g<h>i|j' }), 'a/b/c-d-e-f-g-h-i-j');
  assert.equal(applyNameTemplate('{scene}/{index}', { scene: '../../etc/passwd', index: 1 }), 'etc/passwd/1');
});

test('a result that sanitizes down to nothing is refused', () => {
  assert.throws(() => applyNameTemplate('{scene}', { scene: '///' }), /empty/i);
});

// ---- sanitizePath ----------------------------------------------------------------------------

test('sanitizePath drops empty and dot segments and leading slashes', () => {
  assert.equal(sanitizePath('/a//b/./c/'), 'a/b/c');
  assert.equal(sanitizePath('..\\..\\win'), 'win');
  assert.throws(() => sanitizePath('   '), /empty/i);
});

// ---- uniquify --------------------------------------------------------------------------------

test('uniquify leaves a free name alone', () => {
  assert.equal(uniquify('film/fox-1', []), 'film/fox-1');
});

test('uniquify appends a counter before the extension-less name, never overwriting', () => {
  assert.equal(uniquify('film/fox-1', ['film/fox-1']), 'film/fox-1-2');
  assert.equal(uniquify('film/fox-1', ['film/fox-1', 'film/fox-1-2']), 'film/fox-1-3');
});

test('uniquify is case-insensitive so macOS and Windows cannot collide', () => {
  assert.equal(uniquify('film/Fox-1', ['film/fox-1']), 'film/Fox-1-2');
});

test('uniquify keeps the directory and only numbers the file name', () => {
  assert.equal(uniquify('a/b/c-1', ['a/b/c-1', 'a/b/c-1-2', 'a/b/c-1-3']), 'a/b/c-1-4');
});
