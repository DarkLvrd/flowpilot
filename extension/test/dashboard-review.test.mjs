// The dashboard's Review panel builds its cards in a DOM-less environment here (report §2.6): the
// six checks, the verdict, the note, the Fix button per recorded failure, and the one hard rule the
// panel must make visible — nothing is approved or regenerated on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const node = (tag = '') => ({
  tag, children: [], style: {}, hidden: false, value: '', checked: false, disabled: false,
  textContent: undefined, placeholder: undefined, append(...c) { this.children.push(...c); },
  replaceChildren(...c) { this.children = c; }, addEventListener() {}, click() {},
});
globalThis.document = { createElement: (tag) => node(tag) };

const sent = [];
globalThis.chrome = {
  runtime: {
    async sendMessage(msg) {
      sent.push(msg);
      if (msg.cmd === 'qcSet') return { ok: true, value: { id: msg.id, state: 'done', qc: { checkedAt: 1, by: 'human', checks: { technical: 'pass', ...msg.checks }, verdict: Object.values(msg.checks).includes('fail') ? 'regen' : 'approved', note: msg.note ?? null } } };
      if (msg.cmd === 'qcFix') return { ok: true, value: { check: msg.check, action: 'appendConsistencyBlock', cost: '0 credits now: a still is free, then +1 video once it is approved', still: { id: 's9', expectedCost: 0 }, video: null } };
      throw new Error(`unexpected command ${msg.cmd}`);
    },
  },
};

const { createReviewPanel } = await import('../dashboard/review.js');

const walk = (n) => [n, ...(n.children ?? []).flatMap(walk)];
const find = (root, pred) => walk(root).filter(pred);
const text = (n) => [n.textContent ?? '', ...(n.children ?? []).map(text)].join(' ');

const MEDIA = 'bc92bce2-2183-4ab2-80f6-d5aead42857a';
const checks = (over = {}) => ({ technical: 'pass', identity: 'pass', wardrobe: 'pass', location: 'pass', artefacts: 'pass', style: 'pass', ...over });
const qc = (overChecks = {}, note = null) => ({ checkedAt: 1790000000000, by: 'human', checks: checks(overChecks), verdict: Object.values(overChecks).includes('fail') ? 'regen' : 'approved', note });

const reviewed = {
  id: 'aaaa0000-0000-4000-8000-000000000001', name: 'scene_4', state: 'done', prompt: 'the Charger drives home',
  settings: { kind: 'video' }, file: { path: '/clips/scene_4.mp4' },
  anchor: { shotId: 'shot_4', startFrameMediaId: MEDIA, approvedAt: 5 },
  qc: qc({ wardrobe: 'fail' }, 'rear half went flat bronze'),
};
const fresh = {
  id: 'bbbb0000-0000-4000-8000-000000000002', name: 'scene_5', state: 'done', prompt: 'a fox in snow',
  settings: { kind: 'video' }, file: { path: '/clips/scene_5.mp4' },
};
const blockedClip = {
  id: 'cccc0000-0000-4000-8000-000000000003', name: 'scene_6', state: 'done', prompt: 'x',
  settings: { kind: 'video' }, file: { path: '/clips/scene_6.mp4' },
  qc: { checkedAt: 1, by: 'human', checks: checks({ technical: 'fail' }), verdict: 'blocked', note: null },
};
const stillJob = { id: 'dddd0000-0000-4000-8000-000000000004', name: 'scene_4-still', state: 'done', prompt: 'x', settings: { kind: 'image' } };
const renderingVideo = { id: 'eeee0000-0000-4000-8000-000000000005', name: 'scene_7', state: 'rendering', settings: { kind: 'video' } };

test('the panel lists finished clips only, with the six checks, the verdict, the note and the fixes', () => {
  sent.length = 0;
  const root = node();
  const panel = createReviewPanel(root, { onChange: () => {} });
  panel.render([reviewed, fresh, blockedClip, stillJob, renderingVideo]);
  assert.equal(root.children.length, 3, 'one card per finished clip; stills and running jobs are not reviewed here');

  const reviewedText = text(root.children[0]);
  assert.match(reviewedText, /scene_4/);
  assert.match(reviewedText, /shot_4/);
  assert.match(reviewedText, /verdict regen/);
  assert.match(reviewedText, /technical/);
  for (const check of ['identity', 'wardrobe', 'location', 'artefacts', 'style']) assert.match(reviewedText, new RegExp(check));
  assert.match(reviewedText, /rear half went flat bronze/);
  // The fix is offered with its cost, and it names the action (not a blind regenerate).
  assert.match(reviewedText, /Fix wardrobe — Append a consistency block for that entity \(0 credits now/);
  assert.match(reviewedText, /the failed take stays on disk/);
  const fix = find(root.children[0], (n) => n.tag === 'button' && /^Fix wardrobe/.test(n.textContent ?? ''));
  assert.equal(fix.length, 1);
  assert.equal(fix[0].disabled, false);

  // A clip nobody has reviewed yet: no fix button, a disabled Record until all five are picked.
  const freshText = text(root.children[1]);
  assert.match(freshText, /not reviewed yet/);
  assert.match(freshText, /pick pass or fail for all five/);
  assert.equal(find(root.children[1], (n) => n.tag === 'button').filter((b) => /^Fix /.test(b.textContent ?? '')).length, 0);
  assert.equal(find(root.children[1], (n) => n.tag === 'button')[0].disabled, true);

  // A clip the machine itself rejected is blocked: the reason is shown and no fix is offered at all.
  const blockedText = text(root.children[2]);
  assert.match(blockedText, /verdict blocked/);
  assert.match(blockedText, /failed its own byte\/settings check/);
  assert.match(blockedText, /no fix to offer/);
  assert.equal(find(root.children[2], (n) => n.tag === 'button' && /^Fix /.test(n.textContent ?? '')).length, 0);
  assert.equal(sent.length, 0); // rendering a panel never writes and never queues
});

// Report §8.1 step 5: the card states the character from the generation's own record — or says
// plainly that it was not confirmed — and never lets the picture stand in for the data.
test('the card cites a verified character, and says so when the record did not confirm one', () => {
  const char = { entityId: '0bfec740-409e-42f5-80d1-82baac3349f3', name: 'nancy' };
  const confirmed = {
    ...fresh, id: 'ffff0000-0000-4000-8000-00000000000a', name: 'scene_8',
    referencePlan: { input: 'ingredients', ingredients: [], firstFrame: null, lastFrame: null, characters: [char] },
    characterUsed: char,
    qc: { checkedAt: 1, by: 'human', checks: checks(), verdict: 'approved', note: null, characterUsed: char },
  };
  const unconfirmed = { ...confirmed, id: 'ffff0000-0000-4000-8000-00000000000b', name: 'scene_9', characterUsed: null, qc: { checkedAt: 1, by: 'human', checks: checks(), verdict: 'approved', note: null, characterUsed: null } };
  const root = node();
  createReviewPanel(root, { onChange: () => {} }).render([confirmed, unconfirmed]);
  assert.match(text(root.children[0]), /character nancy: ✅ verified in the generation record/);
  assert.match(text(root.children[0]), /0bfec740-409e-42f5-80d1-82baac3349f3/);
  assert.match(text(root.children[1]), /character nancy: ⚠️ not confirmed in the generation record/);
  assert.doesNotMatch(text(root.children[1]), /verified/);
});

test('recording a verdict sends the five checks and the note; nothing is written before the click', async () => {
  sent.length = 0;
  let refreshed = 0;
  const root = node();
  const panel = createReviewPanel(root, { onChange: async () => { refreshed++; } });
  panel.render([fresh]);
  const card = root.children[0];
  const selects = find(card, (n) => n.tag === 'select');
  assert.equal(selects.length, 5);
  const record = find(card, (n) => n.tag === 'button')[0];
  assert.equal(record.value, '');
  for (const select of selects) { select.value = 'pass'; select.onchange(); }
  selects[1].value = 'fail'; // wardrobe
  selects[1].onchange();
  assert.match(text(card), /this would be: regen/);
  assert.equal(record.disabled, false);
  const note = find(card, (n) => n.tag === 'input')[0];
  note.value = 'the jacket turned grey';
  note.oninput();
  await record.onclick();
  const call = sent.find((m) => m.cmd === 'qcSet');
  assert.deepEqual(call.checks, { identity: 'pass', wardrobe: 'fail', location: 'pass', artefacts: 'pass', style: 'pass' });
  assert.equal(call.note, 'the jacket turned grey');
  assert.equal(call.id, fresh.id);
  assert.equal(refreshed, 1);
});

test('a Fix is a click that confirms, queues the next job and says what it cost — never automatic', async () => {
  sent.length = 0;
  const root = node();
  const panel = createReviewPanel(root, { onChange: () => {} });
  panel.render([reviewed]);
  const fix = find(root.children[0], (n) => n.tag === 'button' && /^Fix wardrobe/.test(n.textContent ?? ''))[0];

  // With no confirmation (a person cancelled), nothing is sent at all.
  globalThis.confirm = () => false;
  await fix.onclick();
  assert.equal(sent.length, 0);

  globalThis.confirm = () => true;
  await fix.onclick();
  assert.deepEqual(sent.at(-1), { cmd: 'qcFix', id: reviewed.id, check: 'wardrobe' });
  assert.match(text(root), /still job s9 \(free\)/);
  delete globalThis.confirm;
});
