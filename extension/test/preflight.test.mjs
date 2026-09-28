import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSettingsSummary, parseCostLine, checkBeforeSpend } from '../lib/preflight.js';

test('reads the Settings trigger summary (recon text)', () => {
  assert.deepEqual(parseSettingsSummary('Video · 360p · 4s crop_16_9 x1'),
    { kind: 'video', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 });
  assert.deepEqual(parseSettingsSummary('Video · 720p · 10s crop_9_16 x2'),
    { kind: 'video', resolution: '720p', durationS: 10, aspect: '9:16', count: 2 });
  assert.equal(parseSettingsSummary('Image · crop_16_9 x1').kind, 'image');
  assert.equal(parseSettingsSummary('something new').kind, null);
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
  expectedCost: 4,
};
const page = {
  tabId: 7, url: `https://flow.google.com/project/${PID}`, prompt: 'a red fox runs\nthrough snow',
  summary: { kind: 'video', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 },
  input: 'ingredients', cost: 4, generateEnabled: true, overlayOpen: false,
};
const budget = { cap: 20, spent: 12, halted: false };
const problems = (p = {}, j = {}, b = {}) => checkBeforeSpend({ ...job, ...j }, { ...page, ...p }, { ...budget, ...b }).problems;

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

test('a free image may have no cost line, but a shown cost must still be 0', () => {
  const image = { settings: { kind: 'image', aspect: '16:9', count: 1 }, expectedCost: 0 };
  const imagePage = { summary: { kind: 'image', resolution: null, durationS: null, aspect: '16:9', count: 1 }, input: null };
  assert.deepEqual(problems({ ...imagePage, cost: null }, image), []);
  assert.match(problems({ ...imagePage, cost: 2 }, image).join(), /cost/);
});
