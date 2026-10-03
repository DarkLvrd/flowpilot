import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnostics } from '../lib/diagnostics.js';
import { FLOW_COMPAT, compatNote, compatReport } from '../lib/compat.js';

const NOW = 1_790_569_700_000;

const job = (over = {}) => ({
  id: 'j1', name: 'fox', state: 'done', expectedCost: 4, cost: 4, clickedAt: NOW - 1000,
  error: null, file: { path: '/Users/someone/FlowPilot/hero/fox.mp4', type: 'mp4' }, prompt: 'a red fox on a rock',
  history: [{ state: 'queued', at: 1 }, { state: 'done', at: 2 }], ...over,
});

const bundle = (over = {}) => buildDiagnostics({
  version: '0.1.0',
  selfCheck: { tabId: 7, at: NOW - 5000, ok: false, checks: [{ name: 'Composer', ok: true }, { name: 'Model catalog', ok: false, detail: 'RPC HTrJv: HTTP 429' }] },
  jobs: [job()], session: { cap: 40, spent: 4, halted: false, haltReason: null, haltedAt: null, lastHalt: null, awaitingResume: false },
  lastTick: { at: NOW, error: null, waiting: null }, workTab: { tabId: 7, projectId: 'p1' }, now: NOW, ...over,
});

test('the bundle carries what a maintainer needs: version, self-check detail, halts and job states', () => {
  const b = bundle({
    session: { cap: 40, spent: 4, halted: true, haltReason: 'UNUSUAL_ACTIVITY from Flow: the request was refused', haltedAt: NOW - 60_000, lastHalt: null, awaitingResume: false },
    jobs: [job({ state: 'failed', error: 'Click may not have happened: Error: button not found. Check Flow; not retried.' })],
  });
  assert.match(b.filename, /^flowpilot-diagnostics-\d{4}-\d{2}-\d{2}-\d{4}\.txt$/);
  assert.match(b.text, /0\.1\.0/);
  assert.match(b.text, /OK Composer/);
  assert.match(b.text, /Model catalog/);
  assert.match(b.text, /HTTP 429/);
  assert.ok(b.text.includes('UNUSUAL_ACTIVITY from Flow: the request was refused'));
  assert.match(b.text, /Click may not have happened: Error: button not found\. Check Flow; not retried\./);
  assert.match(b.text, /fox/);
  assert.match(b.text, /failed/);
  // The compatibility note travels with the bundle, dated.
  assert.ok(b.text.includes(FLOW_COMPAT.provenThrough));
  assert.ok(b.text.includes(FLOW_COMPAT.build));
});

test('no cookie, auth header or token can appear in a diagnostic bundle', () => {
  const poison = {
    cookie: 'Cookie: SID=SECRET-SID-VALUE; HSID=SECRET-HSID',
    auth: 'Authorization: Bearer SECRET-BEARER-1234567890',
    token: 'ya29.SECRET-YA29-TOKEN-value',
    signed: 'https://flow-content.google/video/m1?Expires=SECRET-EXP&Signature=SECRET-SIGNATURE&at=SECRET-AT-TOKEN',
    sapisid: '1234567890:SECRET-HASH-PART-A:SECRET-HASH-PART-B',
  };
  const b = bundle({
    selfCheck: { tabId: 7, at: NOW, ok: false, checks: [{ name: 'Page driver', ok: false, detail: `${poison.cookie} ${poison.auth}` }, { name: 'Credit balance', ok: false, detail: poison.token }] },
    jobs: [job({ name: 'leaky', state: 'failed', error: `${poison.auth} while reading ${poison.signed}` })],
    session: { cap: 40, spent: 0, halted: true, haltReason: `${poison.cookie} blocked the request`, haltedAt: NOW, lastHalt: null, awaitingResume: false },
    lastTick: { at: NOW, error: `${poison.token} refused`, waiting: null },
    ...poison, // rogue top-level fields must be ignored entirely
    extra: { userEmail: 'someone@example.com', signedUrl: poison.signed, sapisid: poison.sapisid },
  });

  for (const secret of ['SECRET-SID-VALUE', 'SECRET-HSID', 'SECRET-BEARER-1234567890', 'SECRET-YA29-TOKEN-value',
    'SECRET-EXP', 'SECRET-SIGNATURE', 'SECRET-AT-TOKEN', 'SECRET-HASH-PART-A']) {
    assert.ok(!b.text.includes(secret), `the bundle leaked ${secret}`);
  }
  assert.ok(!b.text.includes('someone@example.com'), 'rogue fields must not be copied');
  assert.match(b.text, /redacted/i, 'the redaction is visible, not silent');
  // Redaction must not eat the useful part of the message around it.
  assert.match(b.text, /Model catalog|Page driver|Credit balance/);
});

test('prompt text and saved paths stay out of a bundle', () => {
  const b = bundle({ jobs: [job({ prompt: 'my unpublished client campaign line', file: { path: '/Users/someone/secret/film.mp4' } })] });
  assert.ok(!b.text.includes('my unpublished client campaign line'));
  assert.ok(!b.text.includes('/Users/someone'));
  assert.match(b.text, /prompt text/i); // says so, rather than leaving the reader guessing
});

test('the bundle states plainly that it is local and what it will never contain', () => {
  const b = bundle();
  assert.match(b.text, /this machine/i);
  assert.match(b.text, /uploaded|sent nowhere|never uploaded/i);
  assert.match(b.text, /no cookies/i);
  assert.match(b.text, /no (sign-in |auth )?tokens/i);
});

test('an empty queue with no work tab and no self-check still produces a valid bundle', () => {
  const b = buildDiagnostics({ version: '0.1.0', selfCheck: null, jobs: [], session: {}, lastTick: null, workTab: null, now: NOW });
  assert.match(b.filename, /^flowpilot-diagnostics-/);
  assert.match(b.text, /no work tab/i);
  assert.match(b.text, /no self-check/i);
  assert.equal(b.fields.jobs, 0);
});

test('the compatibility note is dated and honest about what is unverified', () => {
  const note = compatNote(FLOW_COMPAT);
  assert.ok(note.includes(FLOW_COMPAT.provenThrough), 'the note carries the date it was last proven');
  assert.match(note, /proven/i);
  assert.ok(note.includes(String(FLOW_COMPAT.unverified.length)));

  const report = compatReport(FLOW_COMPAT);
  for (const line of FLOW_COMPAT.knownIssues) assert.ok(report.includes(line), `missing known issue: ${line}`);
  for (const line of FLOW_COMPAT.unverified) assert.ok(report.includes(line), `missing unverified item: ${line}`);
  assert.match(report, /how to update this note/i);
});

test('the compatibility note never claims more than was tested: it names the build it saw', () => {
  assert.match(FLOW_COMPAT.build, /^boq_labs-ai-sandbox-frontend_\d+/);
  assert.match(compatReport(FLOW_COMPAT), /builds move|drift|changed/i);
  // No absolute promises about future Flow builds.
  assert.ok(!/always works|will keep working|guaranteed/i.test(compatReport(FLOW_COMPAT)));
});
