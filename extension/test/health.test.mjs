import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthLines, healthSummary, CHECK_PLAIN, FLOW_CHANGED_HINT } from '../lib/health.js';

// The names the extension really emits (content/driver.js selfCheck + sw.js selfCheck).
const NAMES = [
  'Agent mode off', 'Prompt box', 'Start generation button', 'Settings trigger',
  'Settings summary readable', 'Add ingredients button', 'Agent toggle', 'Account details',
  'On a project page', 'Page driver', 'Credit balance', 'Model catalog', 'Omni Flash available',
  'Project media',
];

test('every self-check the extension runs has a plain-language line', () => {
  for (const name of NAMES) {
    assert.equal(typeof CHECK_PLAIN[name], 'string', `no plain line for "${name}"`);
    assert.ok(CHECK_PLAIN[name].length > 0);
  }
});

test('a check becomes { ok, name, plain, detail } and keeps its own detail', () => {
  const [line] = healthLines({ checks: [{ name: 'Credit balance', ok: true, detail: '261' }] });
  assert.deepEqual(line, { ok: true, name: 'Credit balance', plain: CHECK_PLAIN['Credit balance'], detail: '261' });
});

test('a check the extension does not know still shows, with a plain fallback (never hidden)', () => {
  const [line] = healthLines({ checks: [{ name: 'Some new check', ok: false }] });
  assert.equal(line.name, 'Some new check');
  assert.equal(line.ok, false);
  assert.equal(typeof line.plain, 'string');
  assert.ok(line.plain.length > 0);
});

test('the summary is ok only when the self-check ran and every check passed', () => {
  assert.equal(healthSummary({ checks: [{ name: 'Prompt box', ok: true }] }).ok, true);
  assert.equal(healthSummary({ checks: [{ name: 'Prompt box', ok: true }, { name: 'Credit balance', ok: false }] }).ok, false);
  assert.equal(healthSummary(null).ok, false);      // never checked yet
  assert.equal(healthSummary({ checks: [] }).ok, false);
});

test('the summary carries when it was checked and the failing checks, and no invented telemetry', () => {
  const s = healthSummary({ at: 123, balance: 261, checks: [{ name: 'Prompt box', ok: false, detail: 'gone' }] });
  assert.equal(s.checkedAt, 123);
  assert.equal(s.balance, 261);
  assert.deepEqual(s.failing.map((f) => f.name), ['Prompt box']);
  assert.deepEqual(Object.keys(s).sort(), ['at', 'balance', 'checkedAt', 'failing', 'lines', 'ok']);
});

test('the "Flow changed" hint says where to look', () => {
  assert.match(FLOW_CHANGED_HINT, /Flow changed/);
  assert.match(FLOW_CHANGED_HINT, /recon\/capture\.mjs/);
  assert.match(FLOW_CHANGED_HINT, /recon\/FINDINGS\.md/);
  assert.match(FLOW_CHANGED_HINT, /rpc\.js/);
});
