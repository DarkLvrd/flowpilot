import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontTabNotice } from '../ui.js';

test('the front-tab notice names the count and the rule, in plain words', () => {
  assert.equal(frontTabNotice({ reason: 'front-tab', count: 1 }), '1 job waiting: keep the Flow tab in front while jobs submit.');
  assert.equal(frontTabNotice({ reason: 'front-tab', count: 3 }), '3 jobs waiting: keep the Flow tab in front while jobs submit.');
});

test('with no work tab yet, the notice says what to do instead', () => {
  const text = frontTabNotice({ reason: 'no-work-tab', count: 2 });
  assert.match(text, /2 jobs waiting/);
  assert.match(text, /Use this tab/);
  assert.match(text, /Open a Flow project/);
});

test('nothing waiting means no notice', () => {
  assert.equal(frontTabNotice(null), null);
  assert.equal(frontTabNotice(undefined), null);
  assert.equal(frontTabNotice({ reason: 'front-tab', count: 0 }), null);
});
