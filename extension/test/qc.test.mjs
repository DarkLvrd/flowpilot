// The QC loop's pure half (report §2.6, §2.8): the six checks, the failure policy as data, the
// verdict, the automatic `technical` check and the record itself. No browser, no credits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  QC_CHECKS, QC_VISIBLE, QC_RESULTS, QC_VERDICTS, QC_POLICY, qcVerdict, policyFor,
  technicalCheck, buildQcRecord, validateQcRecord, consistencyBlockFor, fixCostText, fixJobSpec,
  jobPromptParts, reviewView,
} from '../lib/qc.js';
import { appendConsistencyBlock } from '../lib/entities.js';
import { sha256Hex } from '../lib/sha256.js';

const MEDIA = 'bc92bce2-2183-4ab2-80f6-d5aead42857a';
const MEDIA2 = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';

const allPass = () => Object.fromEntries(QC_CHECKS.map((c) => [c, 'pass']));
const withFail = (...fails) => ({ ...allPass(), ...Object.fromEntries(fails.map((c) => [c, 'fail'])) });

// A finished video job exactly as the store keeps one.
const doneVideo = (over = {}) => ({
  id: 'j1', state: 'done', mediaId: MEDIA, recipe: 'abra_i2v_4s_360p',
  settings: { kind: 'video', input: 'frames', resolution: '360p', durationS: 4, aspect: '16:9', count: 1, refs: [], firstFrame: MEDIA2, lastFrame: null },
  file: { path: '/tmp/scene_4.mp4', type: 'mp4' },
  ...over,
});

test('the checklist is the design\'s six ids, in order, with technical automatic', () => {
  assert.deepEqual(QC_CHECKS, ['technical', 'identity', 'wardrobe', 'location', 'artefacts', 'style']);
  assert.deepEqual(QC_VISIBLE, ['identity', 'wardrobe', 'location', 'artefacts', 'style']);
  assert.deepEqual(QC_RESULTS, ['pass', 'fail']);
  assert.deepEqual(QC_VERDICTS, ['approved', 'regen', 'blocked']);
  // Every check has exactly one policy row, in the design's table order (technical last), and
  // technical is the only automatic one.
  assert.deepEqual(QC_POLICY.map((p) => p.check), [...QC_VISIBLE, 'technical']);
  assert.deepEqual(QC_POLICY.filter((p) => p.automatic).map((p) => p.check), ['technical']);
  assert.equal(policyFor('wardrobe').check, 'wardrobe');
  assert.throws(() => policyFor('vibes'), /Unknown check/);
});

test('every policy row is complete: an action, a cost, and a block text (except technical)', () => {
  for (const row of QC_POLICY) {
    assert.equal(typeof row.action, 'string');
    assert.equal(typeof row.label, 'string');
    assert.equal(typeof row.what, 'string');
    assert.equal(typeof row.still, 'boolean');
    assert.deepEqual(Object.keys(row.credits).sort(), ['stills', 'videos']);
    assert.equal(Number.isInteger(row.credits.stills) && row.credits.stills >= 0, true);
    assert.equal(Number.isInteger(row.credits.videos) && row.credits.videos >= 0, true);
    if (row.check === 'technical') {
      assert.equal(row.block, null);
      assert.deepEqual(row.credits, { stills: 0, videos: 0 });
    } else {
      assert.equal(typeof row.block, 'string');
      assert.equal(row.block.trim().length > 0, true);
    }
  }
  // A still is free and a new video is not: no row may claim a paying still.
  for (const row of QC_POLICY) assert.equal(row.credits.stills, 0);
  assert.equal(QC_POLICY.filter((p) => p.credits.videos > 0).length, 5);
});

test('all six checks passing is an approval with nothing to do', () => {
  const v = qcVerdict(allPass());
  assert.equal(v.verdict, 'approved');
  assert.deepEqual(v.failed, []);
  assert.deepEqual(v.actions, []);
  assert.equal(v.ok, true);
});

test('each failure maps to its own action with the design\'s cost', () => {
  const expected = {
    identity: { action: 'regenStillWithEntityBlock', still: true },
    wardrobe: { action: 'appendConsistencyBlock', still: true },
    location: { action: 'addLocationOrFixSetting', still: true },
    artefacts: { action: 'appendNegatives', still: false },
    style: { action: 'strengthenStyleBlock', still: false },
    technical: { action: 'none', still: false },
  };
  for (const check of QC_CHECKS) {
    const v = qcVerdict(withFail(check));
    assert.deepEqual(v.failed, [check]);
    assert.equal(v.actions.length, 1, check);
    const [a] = v.actions;
    assert.equal(a.check, check);
    assert.equal(a.action, expected[check].action);
    assert.equal(a.still, expected[check].still);
    assert.deepEqual(a.credits, check === 'technical' ? { stills: 0, videos: 0 } : { stills: 0, videos: 1 });
    assert.equal(a.block, check === 'technical' ? null : expected.block ?? QC_POLICY.find((p) => p.check === check).block);
    assert.equal(a.verdict, check === 'technical' ? 'blocked' : 'regen');
    assert.equal(v.verdict, check === 'technical' ? 'blocked' : 'regen');
    assert.equal(v.ok, false);
  }
});

test('technical failing blocks the verdict instead of offering a fix', () => {
  const v = qcVerdict(withFail('technical'));
  assert.equal(v.verdict, 'blocked');
  assert.deepEqual(v.failed, ['technical']);
  assert.equal(v.actions[0].action, 'none');
  assert.equal(v.actions[0].automatic, true);
  assert.match(v.actions[0].what, /before the job reaches done|no clip/i);
  assert.match(fixCostText(v.actions[0]), /0 credits/);
});

test('several failures at once are all offered, in policy order', () => {
  const v = qcVerdict(withFail('style', 'identity', 'artefacts'));
  assert.equal(v.verdict, 'regen');
  assert.deepEqual(v.failed, ['identity', 'artefacts', 'style']); // the checklist's order, not the input's
  assert.deepEqual(v.actions.map((a) => a.check), ['identity', 'artefacts', 'style']); // the policy table's order
  assert.deepEqual(v.actions.map((a) => a.action), ['regenStillWithEntityBlock', 'appendNegatives', 'strengthenStyleBlock']);
  // One regens a still (free, then a video) and two are video-only fixes: three videos in total.
  assert.equal(v.actions.filter((a) => a.still).length, 1);
  assert.equal(v.actions.reduce((n, a) => n + a.credits.videos, 0), 3);
});

test('a note becomes the appended consistency block, and a default is used without one', () => {
  const note = 'rear half of the car went flat bronze after 2s';
  const v = qcVerdict(withFail('wardrobe'), QC_POLICY, { note });
  assert.equal(v.actions[0].block, note);
  assert.equal(v.note, note);
  const plain = qcVerdict(withFail('wardrobe'));
  assert.equal(plain.actions[0].block, policyFor('wardrobe').block);
  assert.equal(consistencyBlockFor('style', { note: '  ' }), policyFor('style').block); // blank note = default
  assert.equal(consistencyBlockFor('artefacts', { note: 'no captions burned in' }), 'no captions burned in');
  assert.equal(consistencyBlockFor('technical', { note: 'x' }), null);
});

test('fixCostText shows a free still now and the video after approval, or the video now', () => {
  const stillFix = qcVerdict(withFail('identity')).actions[0];
  assert.match(fixCostText(stillFix), /0 credits now/);
  assert.match(fixCostText(stillFix), /still/);
  assert.match(fixCostText(stillFix), /\+1 video/);
  const videoFix = qcVerdict(withFail('artefacts')).actions[0];
  assert.match(fixCostText(videoFix), /\+1 video/);
  assert.equal(fixCostText(videoFix).includes('0 credits now'), false);
});

test('qcVerdict fails closed on a missing, unknown or malformed check', () => {
  assert.throws(() => qcVerdict({ technical: 'pass', identity: 'pass' }), /wardrobe/);
  assert.throws(() => qcVerdict({ ...allPass(), vibes: 'pass' }), /Unknown check/);
  assert.throws(() => qcVerdict(allPass(), QC_POLICY.filter((p) => p.check !== 'identity')), /identity/);
  assert.throws(() => qcVerdict({ ...allPass(), style: 'maybe' }), /style/);
  assert.throws(() => qcVerdict(null), /checks/);
});

test('qcVerdict is pure: the input object and the policy are not touched', () => {
  const checks = withFail('identity');
  const before = structuredClone(checks);
  const policyBefore = structuredClone(QC_POLICY);
  const v = qcVerdict(checks, QC_POLICY, { note: 'x' });
  assert.deepEqual(checks, before);
  assert.deepEqual(QC_POLICY, policyBefore);
  assert.notEqual(v.actions[0], QC_POLICY[0]);
});

test('the automatic technical check reads what the extension already verified', () => {
  assert.deepEqual(technicalCheck(doneVideo()), { check: 'technical', result: 'pass', problems: [] });
  assert.deepEqual(technicalCheck({ ...doneVideo(), state: 'rendering' }).result, 'fail');
  assert.match(technicalCheck({ ...doneVideo(), state: 'rendering' }).problems.join(' '), /never finished|rendering/);
  assert.equal(technicalCheck({ ...doneVideo(), mediaId: null }).result, 'fail');
  assert.equal(technicalCheck({ ...doneVideo(), file: null }).result, 'fail');
  // Bytes that do not match the kind, and a recipe that no longer matches the settings: both fail.
  const wrongBytes = technicalCheck({ ...doneVideo(), file: { path: '/tmp/x.png', type: 'png' } });
  assert.equal(wrongBytes.result, 'fail');
  assert.match(wrongBytes.problems.join(' '), /png/);
  const drifted = technicalCheck({ ...doneVideo(), recipe: 'abra_i2v_6s_360p' });
  assert.equal(drifted.result, 'fail');
  assert.match(drifted.problems.join(' '), /recipe/);
  // An image job is checked the same way when it names its model.
  const image = { id: 'i1', state: 'done', mediaId: MEDIA, recipe: 'NARWHAL', settings: { kind: 'image', model: 'nano-banana-2' }, file: { path: '/tmp/x.png', type: 'png' } };
  assert.equal(technicalCheck(image).result, 'pass');
  assert.equal(technicalCheck({ ...image, file: { path: '/tmp/x.mp4', type: 'mp4' } }).result, 'fail');
  // A still that named no model rides on Flow's own image model, so there is no recipe to compare.
  const accountDefault = { ...image, recipe: null, settings: { kind: 'image' } };
  assert.equal(technicalCheck(accountDefault).result, 'pass');
});

test('buildQcRecord fills technical in itself, derives the verdict and refuses a contradiction', () => {
  const at = 1790000000000;
  const record = buildQcRecord({ job: doneVideo(), checks: { identity: 'pass', wardrobe: 'fail', location: 'pass', artefacts: 'pass', style: 'pass' }, by: 'human', note: 'flat bronze', at });
  assert.deepEqual(record, {
    checkedAt: at,
    by: 'human',
    checks: { technical: 'pass', identity: 'pass', wardrobe: 'fail', location: 'pass', artefacts: 'pass', style: 'pass' },
    verdict: 'regen',
    note: 'flat bronze',
    characterUsed: null,
  });
  assert.equal(buildQcRecord({ job: doneVideo(), checks: Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), at }).verdict, 'approved');
  // A caller may state technical, but only in agreement with the automatic result.
  assert.equal(buildQcRecord({ job: doneVideo(), checks: { ...Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), technical: 'pass' }, at }).checks.technical, 'pass');
  assert.throws(() => buildQcRecord({ job: doneVideo(), checks: { ...Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), technical: 'fail' }, at }), /technical/);
  // The record carries a machine-failed clip as blocked, never as approved (technical is read from
  // the job, so a caller states only the five visible checks).
  const blocked = buildQcRecord({ job: { ...doneVideo(), state: 'failed' }, checks: Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), at });
  assert.equal(blocked.verdict, 'blocked');
  assert.equal(blocked.checks.technical, 'fail');
  assert.throws(() => buildQcRecord({ job: doneVideo(), checks: { identity: 'pass' }, at }), /wardrobe/);
  assert.throws(() => buildQcRecord({ job: doneVideo(), checks: Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), by: 'robot', at }), /human or agent/);
});

test('a record is validated before it is stored: the design\'s five fields and nothing weak', () => {
  const good = buildQcRecord({ job: doneVideo(), checks: Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), at: 1 });
  assert.equal(validateQcRecord(good), true);
  assert.throws(() => validateQcRecord({ ...good, by: 'nobody' }), /human or agent/);
  assert.throws(() => validateQcRecord({ ...good, checkedAt: null }), /checkedAt/);
  assert.throws(() => validateQcRecord({ ...good, verdict: 'ship it' }), /verdict/);
  assert.throws(() => validateQcRecord({ ...good, checks: { ...good.checks, style: 'meh' } }), /style/);
  assert.throws(() => validateQcRecord({ ...good, note: 7 }), /note/);
  assert.throws(() => validateQcRecord(null), /record/i);
  // The stored record has exactly the design's five fields plus `characterUsed`, which the character
  // work adds so the Review card can cite Flow's own record instead of guessing from the picture.
  assert.deepEqual(Object.keys(good).sort(), ['by', 'characterUsed', 'checkedAt', 'checks', 'note', 'verdict']);
});

// Report §8.1 step 5: the QC record states whether the character was really used, from the record
// Flow itself returned for the finished job — never from a person's say-so or the look of the clip.
test('the QC record cites the character Flow confirmed, and refuses one that is not a real id', () => {
  const char = { entityId: '0bfec740-409e-42f5-80d1-82baac3349f3', name: 'nancy' };
  const checks = Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass']));
  const used = buildQcRecord({ job: { ...doneVideo(), characterUsed: char }, checks, at: 1 });
  assert.deepEqual(used.characterUsed, char);
  // A job that asked for a character but whose record did not confirm it says so plainly.
  assert.equal(buildQcRecord({ job: { ...doneVideo(), characterUsed: null }, checks, at: 1 }).characterUsed, null);
  // A job with no character is not spoken for.
  assert.equal(buildQcRecord({ job: doneVideo(), checks, at: 1 }).characterUsed, null);
  // The value comes from the job, so a caller cannot talk it up; a malformed one never lands.
  assert.throws(() => buildQcRecord({ job: { ...doneVideo(), characterUsed: { name: 'nancy' } }, checks, at: 1 }), /entity id/i);
  assert.throws(() => validateQcRecord({ ...used, characterUsed: { entityId: 'nancy', name: 'nancy' } }), /entity id/i);
  assert.throws(() => validateQcRecord({ ...used, characterUsed: 'nancy' }), /characterUsed/i);
});

test('a fix for a clip that is not part of a shot is a new job from the same spec, never an edit', () => {
  const base = { ...doneVideo(), name: 'scene_4', referencePlan: { input: 'frames', ingredients: [], firstFrame: { kind: 'mediaId', mediaId: MEDIA2 }, lastFrame: null }, references: { ingredients: [], firstFrame: MEDIA2, lastFrame: null } };
  const parts = appendConsistencyBlock([{ kind: 'base', ref: 'prompt', sha256: 'a'.repeat(64), text: 'the car drives home' }], { id: 'artefacts_fix', text: 'No text, watermark or logo anywhere in frame.' });
  // A video-only fix: the same frames and settings, the appended part, a fresh name.
  const video = fixJobSpec(base, qcVerdict(withFail('artefacts')).actions[0], parts);
  assert.equal(video.kind, 'video');
  assert.equal(video.input, 'frames');
  assert.equal(video.firstFrame, MEDIA2);
  assert.equal(video.prompt, 'the car drives home\n\nNo text, watermark or logo anywhere in frame.');
  assert.deepEqual(video.promptParts, parts);
  assert.equal(video.name, 'scene_4-artefacts-fix');
  assert.equal(video.resolution, '360p');
  assert.equal(video.durationS, 4);
  // A still fix asks for a free image job instead, carrying the same ingredients references.
  const base2 = { ...base, references: { ingredients: [MEDIA, MEDIA2], firstFrame: null, lastFrame: null }, settings: { ...base.settings, input: 'ingredients', firstFrame: null, refs: [MEDIA] } };
  const ident = fixJobSpec(base2, qcVerdict(withFail('identity')).actions[0], parts);
  assert.equal(ident.kind, 'image');
  assert.deepEqual(ident.refs, [MEDIA, MEDIA2]);
  assert.equal(ident.firstFrame, undefined);
  // The input job is untouched: the same object, no mutated arrays.
  assert.equal(base.name, 'scene_4');
  assert.equal(base.promptParts, undefined);
});

// A fix must not quietly change the job: a character the failed take carried stays on the fix, so
// the pre-spend check still verifies the chip and the QC record still confirms the same entity.
test('a fix keeps the Flow Character the failed take ran with', () => {
  const char = { entityId: '0bfec740-409e-42f5-80d1-82baac3349f3', name: 'nancy' };
  const base = { ...doneVideo(), name: 'scene_4', settings: { ...doneVideo().settings, input: 'ingredients', refs: [], characters: [char] }, referencePlan: { input: 'ingredients', ingredients: [], firstFrame: null, lastFrame: null, characters: [char] }, references: { ingredients: [], firstFrame: null, lastFrame: null, characters: [char] } };
  const fixed = fixJobSpec(base, qcVerdict(withFail('style')).actions[0], [{ kind: 'base', ref: 'prompt', sha256: 'a'.repeat(64), text: 'x' }]);
  assert.deepEqual(fixed.characters, [char]);
  assert.equal(fixed.input, 'ingredients');
  // A job without a character is unchanged: no `characters` field at all.
  assert.equal('characters' in fixJobSpec(doneVideo(), qcVerdict(withFail('style')).actions[0], []), false);
});

test('a plain job with no composed parts starts from its own prompt, byte-verbatim', () => {
  const plain = { id: 'p1', name: 'plain', prompt: 'a red fox in snow', settings: { kind: 'video' } };
  const parts = jobPromptParts(plain);
  assert.deepEqual(parts, [{ kind: 'base', ref: 'prompt', sha256: sha256Hex('a red fox in snow'), text: 'a red fox in snow' }]);
  const fixed = appendConsistencyBlock(parts, { id: 'style_fix', text: 'keep the 3D Pixar look' });
  assert.equal(fixed.map((p) => p.text).join('\n\n'), 'a red fox in snow\n\nkeep the 3D Pixar look');
  // A composed job keeps the parts it already has, untouched.
  const composed = { prompt: 'x', promptParts: [{ kind: 'base', ref: 'prompt', sha256: 'b'.repeat(64), text: 'x' }] };
  assert.deepEqual(jobPromptParts(composed), composed.promptParts);
  assert.deepEqual(jobPromptParts({ prompt: '' }), []);
});

test('reviewView is the one view every surface shows', () => {
  const unreviewed = reviewView({ id: 'j1', name: 'fox', state: 'done' });
  assert.deepEqual(unreviewed, { id: 'j1', name: 'fox', state: 'done', reviewed: false, qc: null, verdict: null, failed: [], actions: [] });
  const reviewed = reviewView({ id: 'j1', name: 'car', state: 'done', qc: buildQcRecord({ job: doneVideo(), checks: { ...Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), wardrobe: 'fail' }, note: 'flat bronze', at: 1 }) });
  assert.equal(reviewed.reviewed, true);
  assert.equal(reviewed.verdict, 'regen');
  assert.deepEqual(reviewed.failed, ['wardrobe']);
  assert.equal(reviewed.actions.length, 1);
  assert.equal(reviewed.actions[0].action, 'appendConsistencyBlock');
  assert.equal(reviewed.actions[0].block, 'flat bronze');
  assert.match(reviewed.actions[0].cost, /0 credits now/);
  // The clip's state is the job's, so the panel can show a failed one only where it belongs.
  assert.equal(reviewView({ id: 'j2', state: 'failed', qc: buildQcRecord({ job: { ...doneVideo(), state: 'failed' }, checks: Object.fromEntries(QC_VISIBLE.map((c) => [c, 'pass'])), at: 1 }) }).verdict, 'blocked');
});
