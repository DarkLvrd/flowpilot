import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettingsSummary, parseCostLine, checkBeforeSpend } from '../lib/preflight.js';

// The chip text is captured from the live page (recon/FINDINGS.md "Settings chip shapes",
// 2026-10-03; `recon/raw/live-chips.mjs` is the probe that read it). The Settings trigger's own
// textContent, exactly as the driver reads it — leading spaces and all.
test('reads the Settings trigger summary', () => {
  assert.deepEqual(parseSettingsSummary(' Video · 360p · 4s crop_16_9 x1 '),
    { kind: 'video', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 });
  assert.deepEqual(parseSettingsSummary(' Video · 720p · 10s crop_9_16 x2 '),
    { kind: 'video', resolution: '720p', durationS: 10, aspect: '9:16', count: 2 });
  // Image mode: Flow writes the image model's name where a video chip writes the word `Video`, so
  // there is no kind word to read. Its own shape (no resolution, no duration) says image.
  assert.deepEqual(parseSettingsSummary(' 🍌 Nano Banana 2 crop_16_9 x1 '),
    { kind: 'image', resolution: null, durationS: null, aspect: '16:9', count: 1 });
  assert.deepEqual(parseSettingsSummary(' 🍌 Nano Banana 2 crop_9_16 x2 '),
    { kind: 'image', resolution: null, durationS: null, aspect: '9:16', count: 2 });
  // The other image aspects Flow offers are real chips too, unpriced kinds Flow Pilot does not
  // build (`buildJob` allows 16:9 and 9:16 only): the kind is still image and the aspect stays
  // null, so a job can never be submitted against an aspect the parser only guessed at.
  for (const [chip, aspect] of [['crop_landscape', null], ['crop_square', null], ['crop_portrait', null]]) {
    assert.deepEqual(parseSettingsSummary(` 🍌 Nano Banana 2 ${chip} x1 `),
      { kind: 'image', resolution: null, durationS: null, aspect, count: 1 });
  }
});

test('the settings panel\'s own checked mode radio settles the kind when the chip has no word', () => {
  // The driver reads the mode radio while the panel is open; it is Flow's own statement of the mode
  // and it travels with the chip text into this parser.
  assert.equal(parseSettingsSummary(' 🍌 Nano Banana 2 crop_16_9 x1 ', { mode: 'image' }).kind, 'image');
  assert.equal(parseSettingsSummary(' Video · 360p · 4s crop_16_9 x1 ', { mode: 'video' }).kind, 'video');
  // The chip's own word wins, so a mode radio that drifted from the panel is caught as a kind
  // mismatch by the pre-spend check rather than smuggled through by the hint.
  assert.equal(parseSettingsSummary(' Video · 360p · 4s crop_16_9 x1 ', { mode: 'image' }).kind, 'video');
  assert.equal(parseSettingsSummary(' Video · 360p · 4s crop_16_9 x1 ', { mode: 'image' }).resolution, '360p');
});

test('a chip that reads as neither kind keeps kind null, so nothing is submitted blind', () => {
  assert.equal(parseSettingsSummary('something new').kind, null);
  assert.equal(parseSettingsSummary('').kind, null);
  assert.equal(parseSettingsSummary(undefined).kind, null);
  assert.equal(parseSettingsSummary('Image · crop_16_9 x1').kind, 'image'); // a kind word, if Flow ever writes one
  assert.equal(parseSettingsSummary('Image · crop_16_9 x1').aspect, '16:9');
  // A chip with a resolution but no mode word: not an image chip (an image chip has neither a
  // resolution nor a duration), so without the panel's radio reading the kind stays null.
  assert.equal(parseSettingsSummary('Omni 1.1 Flash 360p 4s crop_16_9 x1').kind, null);
  assert.equal(parseSettingsSummary('Omni 1.1 Flash 360p 4s crop_16_9 x1', { mode: 'video' }).kind, 'video');
});

test('reads the cost line', () => {
  assert.equal(parseCostLine('Generating will use 4 credits'), 4);
  assert.equal(parseCostLine('Generating will use 1 credit'), 1);
  assert.equal(parseCostLine('Generating will use  12  credits'), 12);
  assert.equal(parseCostLine('Generate'), null);
});

const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';
const job = {
  tabId: 7, projectId: PID, prompt: 'a red fox runs\nthrough snow',
  settings: { kind: 'video', input: 'ingredients', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
  expectedCost: 4, modelFamily: 'Omni 1.1 Flash',
};
const page = {
  tabId: 7, url: `https://flow.google.com/project/${PID}`, prompt: 'a red fox runs\nthrough snow',
  summary: { kind: 'video', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
  input: 'ingredients', model: 'Omni 1.1 Flash', cost: 4, generateEnabled: true, overlayOpen: false,
};
const budget = { cap: 20, spent: 12, halted: false };
const problems = (p = {}, j = {}, b = {}) => checkBeforeSpend({ ...job, ...j }, { ...page, ...p }, { ...budget, ...b }).problems;

// The still gate: the live Image chip (`🍌 Nano Banana 2 crop_16_9 x1`, captured 2026-10-03) parses
// as an image job's page, so `checkBeforeSpend` lets the free still through — this is the bug that
// stopped every still (BUG-1).
const stillJob = {
  tabId: 7, projectId: PID, prompt: 'a rooftop at dusk',
  settings: { kind: 'image', input: 'text', aspect: '16:9', count: 1 },
  expectedCost: 0, modelFamily: '🍌 Nano Banana 2',
};
const stillPage = {
  ...page, prompt: 'a rooftop at dusk',
  summary: parseSettingsSummary(' 🍌 Nano Banana 2 crop_16_9 x1 ', { mode: 'image' }),
  summaryText: ' 🍌 Nano Banana 2 crop_16_9 x1 ', modeKind: 'image', input: 'ingredients',
  model: '🍌 Nano Banana 2', cost: 0,
};

test('an image job against the live Image chip passes the pre-spend check', () => {
  assert.deepEqual(checkBeforeSpend(stillJob, stillPage, budget), { ok: true, problems: [] });
  // The panel's radio reading is what makes the chip legible; without any reading the chip's own
  // shape still settles it, but a shape that says image while the panel says video is caught.
  assert.deepEqual(checkBeforeSpend(stillJob, { ...stillPage, summary: parseSettingsSummary(' 🍌 Nano Banana 2 crop_16_9 x1 ') }, budget), { ok: true, problems: [] });
  assert.match(problems({ summary: parseSettingsSummary(' 🍌 Nano Banana 2 crop_16_9 x1 ', { mode: 'video' }), modeKind: 'video' }, stillJob).join(), /kind is video, job wants image/);
  assert.match(problems({ summaryText: 'something new', summary: parseSettingsSummary('something new'), cost: 0 }, stillJob).join(), /kind is null, job wants image/);
});

// A still that names no model rides on whatever image model the account is on (report §4a, BUG-A):
// the pre-spend check accepts Flow's current model as long as the catalog knows its family, and still
// requires the cost line to match, so an unknown paid model cannot slip through.
const accountStillJob = {
  ...stillJob, modelFamily: null, modelAccountDefault: true,
  imageModelFamilies: ['🍌 Nano Banana Pro', '🍌 Nano Banana 2', '🍌 Nano Banana 2 Lite'],
};

test("a still on the account's own image model passes for any image family the catalog knows", () => {
  const proPage = { ...stillPage, model: '🍌 Nano Banana Pro', summary: parseSettingsSummary(' 🍌 Nano Banana Pro crop_16_9 x1 ', { mode: 'image' }), summaryText: ' 🍌 Nano Banana Pro crop_16_9 x1 ' };
  assert.deepEqual(checkBeforeSpend(accountStillJob, stillPage, budget), { ok: true, problems: [] });
  assert.deepEqual(checkBeforeSpend(accountStillJob, proPage, budget), { ok: true, problems: [] });
  // The cost line is still the guard: a paid image model is refused even though its family is known.
  assert.match(problems({ cost: 5 }, accountStillJob).join(), /cost is 5 credits, expected 0/);
});

test('a still on an image model the catalog does not know fails with what to do', () => {
  const got = problems({ model: '🍌 Nano Banana 9' }, accountStillJob).join(' ');
  assert.match(got, /does not know/);
  assert.match(got, /Nano Banana 2 Lite/);
  // A still that named no model but has no families (the catalog could not be read) fails closed too.
  assert.match(problems({}, { ...accountStillJob, imageModelFamilies: [] }).join(), /no image models to check/);
});

test('all checks pass on a matching page', () => {
  assert.deepEqual(checkBeforeSpend(job, page, budget), { ok: true, problems: [] });
});

test('refuses the wrong tab or the wrong project', () => {
  assert.match(problems({ tabId: 8 }).join(), /tab/);
  assert.match(problems({ url: 'https://flow.google.com/project/other' }).join(), /project/);
  assert.match(problems({ url: `https://flow.google.com/project/${PID}/tools` }).join(), /project/);
  assert.match(problems({ url: `https://evil.example/project/${PID}` }).join(), /project/);
});

test('refuses a prompt that is not verbatim', () => {
  assert.match(problems({ prompt: 'a red fox runs through snow' }).join(), /prompt/);
  assert.match(problems({ prompt: 'a red fox runs\nthrough snow ' }).join(), /prompt/);
});

test('refuses drifted mode or settings', () => {
  assert.match(problems({ summary: { ...page.summary, kind: 'image' } }).join(), /kind/);
  assert.match(problems({ summary: { ...page.summary, durationS: 8 } }).join(), /duration/);
  assert.match(problems({ input: 'frames' }).join(), /input/);
  assert.match(problems({ summary: { ...page.summary, count: 2 } }).join(), /count/);
});

test('refuses a different model, or a job whose model is unknown', () => {
  assert.match(problems({ model: 'Veo 3.1 - Quality' }).join(), /model is Veo 3.1 - Quality, job wants Omni 1.1 Flash/);
  assert.match(problems({ model: null }).join(), /model/);
  assert.match(problems({}, { modelFamily: null }).join(), /model/);
});

test('refuses when the cost line is missing or differs from the expected cost', () => {
  assert.match(problems({ cost: null }).join(), /cost/);
  assert.match(problems({ cost: 7 }).join(), /cost/);
});

test('uses the page cost when the expected cost is unknown', () => {
  assert.deepEqual(problems({ cost: 5 }, { expectedCost: null }), []);
});

test('refuses to pass the session cap', () => {
  assert.deepEqual(problems({}, {}, { spent: 16 }), []);
  assert.match(problems({}, {}, { spent: 17 }).join(), /cap/);
  assert.match(problems({}, {}, { cap: null }).join(), /cap/);
});

test('refuses while halted, with Generate disabled, or with an overlay open', () => {
  assert.match(problems({}, {}, { halted: true }).join(), /halted/);
  assert.match(problems({ generateEnabled: false }).join(), /Generate/);
  assert.match(problems({ overlayOpen: true }).join(), /overlay/);
});

const REF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('Ingredients: the attached reference ids must match the job verbatim, in any order', () => {
  const ing = { references: { input: 'ingredients', ingredients: [REF_A, REF_B], firstFrame: null, lastFrame: null } };
  const attached = { attached: { ingredients: [REF_B, REF_A], firstFrame: null, lastFrame: null } };
  assert.deepEqual(problems(attached, ing), []);
  assert.match(problems({ attached: { ingredients: [REF_A], firstFrame: null, lastFrame: null } }, ing).join(), /reference|ingredient/i);
  assert.match(problems({ attached: { ingredients: [REF_A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'], firstFrame: null, lastFrame: null } }, ing).join(), /reference|ingredient/i);
  assert.match(problems({ attached: { ingredients: [], firstFrame: null, lastFrame: null } }, ing).join(), /reference|ingredient/i);
});

test('Frames: the attached first/last frame ids must match the job', () => {
  const job = { settings: { kind: 'video', input: 'frames', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
    references: { input: 'frames', ingredients: [], firstFrame: REF_A, lastFrame: REF_B } };
  const framePage = { input: 'frames', attached: { ingredients: [], firstFrame: REF_A, lastFrame: REF_B } };
  assert.deepEqual(problems(framePage, job), []);
  assert.match(problems({ ...framePage, attached: { ingredients: [], firstFrame: REF_B, lastFrame: REF_A } }, job).join(), /frame/i);
  assert.match(problems({ ...framePage, attached: { ingredients: [], firstFrame: REF_A, lastFrame: null } }, job).join(), /last frame/i);
  assert.match(problems({ ...framePage, attached: { ingredients: [], firstFrame: null, lastFrame: REF_B } }, job).join(), /first frame/i);
});

test('a job with no references and nothing attached passes the reference check', () => {
  assert.deepEqual(problems({ attached: { ingredients: [], firstFrame: null, lastFrame: null } },
    { references: { input: 'ingredients', ingredients: [], firstFrame: null, lastFrame: null } }), []);
  // A reference attached when the job wanted none is refused.
  assert.match(problems({ attached: { ingredients: [REF_A], firstFrame: null, lastFrame: null } },
    { references: { input: 'ingredients', ingredients: [], firstFrame: null, lastFrame: null } }).join(), /reference|ingredient/i);
});

test('a plain job stores references: null (addJob) — the check must not crash on it', () => {
  // addJob stores a non-reference job with references: null; the default param only covers
  // undefined, so a null here must still be read as "no references" and pass, never throw.
  assert.deepEqual(problems({ attached: { ingredients: [], firstFrame: null, lastFrame: null } },
    { references: null }), []);
  // Even with no attached field read back at all, a null-reference job must not throw.
  assert.deepEqual(problems({ attached: undefined }, { references: null }), []);
});

// ---- the character-attached pre-spend check (report §8.1 step 4) ------------------------------

const CHAR = '0bfec740-409e-42f5-80d1-82baac3349f3';
const CHAR2 = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'ANqvLOZz3WfqTOKEN';
// A character job: the entity id is on job.references, the tile token the driver read is on the
// page, and the chip it left in the bar is reported as an attached token.
const charJob = { references: { input: 'ingredients', ingredients: [], firstFrame: null, lastFrame: null, characters: [{ entityId: CHAR, name: 'nancy' }] } };
const charPage = { attached: { ingredients: [], firstFrame: null, lastFrame: null, characters: [TOKEN] }, characterTokens: { nancy: TOKEN }, mentions: [] };
const charProblems = (p = {}, j = {}) => problems(p, j);

test('a character chip whose token matches the tile it was picked from passes', () => {
  assert.deepEqual(charProblems(charPage, charJob), []);
  // A chip plus a photo reference: both checks pass side by side.
  const withPhoto = { references: { ...charJob.references, ingredients: [REF_A] } };
  assert.deepEqual(charProblems({ ...charPage, attached: { ...charPage.attached, ingredients: [REF_A] } }, withPhoto), []);
});

test('a missing character chip fails closed — the credits would buy a clip without the character', () => {
  assert.match(charProblems({ ...charPage, attached: { ...charPage.attached, characters: [] } }, charJob).join(), /nancy/);
  // The driver never saw the picker tile, so there is no token to compare against.
  assert.match(charProblems({ ...charPage, characterTokens: {} }, charJob).join(), /nancy/);
  // A different character's chip is attached: the token does not match.
  assert.match(charProblems({ ...charPage, attached: { ...charPage.attached, characters: ['another-token'] } }, charJob).join(), /nancy/);
  // A character chip nobody asked for is refused too.
  assert.match(charProblems({ ...charPage, attached: { ...charPage.attached, characters: [TOKEN, 'extra'] }, characterTokens: { nancy: TOKEN } }, { references: null }).join(), /character/i);
  // An old driver that reads no characters at all is refused, never trusted.
  assert.match(charProblems({ attached: { ingredients: [], firstFrame: null, lastFrame: null } }, charJob).join(), /nancy/);
});

test('a mention chip must name the expected entity, and an invalid one fails closed', () => {
  const valid = { ...charPage, mentions: [{ entityId: CHAR, referenceType: 'entity', valid: true }] };
  assert.deepEqual(charProblems(valid, charJob), []);
  // The mention names a different character: Flow would send the wrong entity.
  assert.match(charProblems({ ...valid, mentions: [{ entityId: CHAR2, referenceType: 'entity', valid: true }] }, charJob).join(), /mention/i);
  // Flow marks an unlisted id mention-chip-invalid and serialises it as plain text: fail closed.
  assert.match(charProblems({ ...valid, mentions: [{ entityId: CHAR, referenceType: 'entity', valid: false }] }, charJob).join(), /invalid|mention-chip-invalid/i);
  assert.match(charProblems({ ...charPage, mentions: [{ entityId: CHAR, referenceType: 'entity', valid: false }] }, charJob).join(), /invalid|mention-chip-invalid/i);
});

test('a job with no character is unaffected by the character check', () => {
  assert.deepEqual(charProblems({ attached: { ingredients: [], firstFrame: null, lastFrame: null, characters: [] } }, { references: null }), []);
  assert.deepEqual(problems({ attached: undefined }, { references: null }), []);
});

test('a free image may have no cost line, but a shown cost must still be 0', () => {
  const image = { settings: { kind: 'image', aspect: '16:9', count: 1 }, expectedCost: 0, modelFamily: '🍌 Nano Banana 2' };
  const imagePage = { summary: parseSettingsSummary(' 🍌 Nano Banana 2 crop_16_9 x1 ', { mode: 'image' }), input: null, model: '🍌 Nano Banana 2' };
  assert.deepEqual(problems({ ...imagePage, cost: null }, image), []);
  assert.match(problems({ ...imagePage, cost: 2 }, image).join(), /cost/);
});
