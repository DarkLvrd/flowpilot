import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandPromptSet, PROMPT_TEMPLATE, SHOT_LABELS } from '../lib/promptset.js';

test('one sentence becomes a set of scene prompts that all keep the same subject', () => {
  const set = expandPromptSet('a red fox running through snow at sunrise');
  assert.equal(set.length, 4); // the default set
  assert.ok(set.every((s) => s.prompt.includes('a red fox running through snow at sunrise')));
  assert.equal(new Set(set.map((s) => s.prompt)).size, 4); // a different shot each time
  assert.deepEqual(set.map((s) => s.label), SHOT_LABELS.slice(0, 4));
  assert.deepEqual(set.map((s) => s.index), [1, 2, 3, 4]);
});

test('the shots run wide → close, so the set reads like one scene rather than four ideas', () => {
  const set = expandPromptSet('a lighthouse on a cliff', { scenes: 3 });
  assert.match(set[0].prompt, /wide establishing shot/);
  assert.match(set[1].prompt, /medium shot/);
  assert.match(set[2].prompt, /close-up shot/);
});

test('lighting comes from words in the sentence, by a documented rule', () => {
  assert.match(expandPromptSet('a fox at night')[0].prompt, /moody low light/);
  assert.match(expandPromptSet('a fox at sunrise')[0].prompt, /golden-hour/);
  assert.match(expandPromptSet('a fox in the rain')[0].prompt, /overcast light/);
  assert.match(expandPromptSet('a plain fox')[0].prompt, /soft natural light/); // documented default
});

test('style and motion are appended, and a motion word in the sentence is picked up', () => {
  const set = expandPromptSet('a fox walks through snow', { style: 'watercolour' });
  assert.match(set[0].prompt, /walking steadily/);
  assert.match(set[0].prompt, /watercolour$/);
  assert.match(expandPromptSet('a fox', { motion: 'slow dolly in' })[0].prompt, /slow dolly in$/);
});

test('the scene count is clamped to the shots that exist', () => {
  assert.equal(expandPromptSet('a fox', { scenes: 99 }).length, SHOT_LABELS.length);
  assert.equal(expandPromptSet('a fox', { scenes: 1 }).length, 1);
  assert.equal(expandPromptSet('a fox', { scenes: 0 }).length, 1);
});

test('an empty sentence is refused with a clear message instead of producing junk prompts', () => {
  assert.throws(() => expandPromptSet('   '), /Describe the scene/);
  assert.throws(() => expandPromptSet('...'), /Describe the scene/);
  assert.throws(() => expandPromptSet(undefined), /Describe the scene/);
});

test('every prompt is plain editable text the job form accepts: one line, trimmed, non-empty', () => {
  for (const s of expandPromptSet('a red fox\nrunning', { style: '  film  ' })) {
    assert.equal(typeof s.prompt, 'string');
    assert.equal(s.prompt, s.prompt.trim());
    assert.ok(s.prompt.length > 0);
    assert.ok(!s.prompt.includes('\n'));
  }
});

test('the documented template names the parts every prompt is built from', () => {
  assert.equal(PROMPT_TEMPLATE, '<subject>, <shot>, <light>, <motion>, <style>');
});
