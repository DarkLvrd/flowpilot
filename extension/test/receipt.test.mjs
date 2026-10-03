import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReceipt, promptFingerprint } from '../lib/receipt.js';

const NOW = 1_790_569_700_000; // epoch ms, Oct 2026 like the recon records
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// The records the extension actually keeps per job (lib/jobs.js): cost is written only at the
// write-ahead click, so `cost` is the only provable charge, and `expectedCost` is a quote.
const job = (over = {}) => ({
  id: 'j1', name: 'fox', projectId: 'p1', prompt: 'a red fox on a rock',
  settings: { kind: 'video', resolution: '720p', durationS: 4, aspect: '16:9', count: 1 },
  expectedCost: 4, cost: null, clickedAt: null, mediaId: null, file: null, error: null,
  createdAt: NOW - 600_000, updatedAt: NOW - 60_000,
  history: [{ state: 'queued', at: NOW - 600_000 }],
  ...over,
});

const session = (over = {}) => ({ cap: 40, spent: 0, halted: false, haltReason: null, haltedAt: null, awaitingResume: false, ...over });

function receipt({ jobs, session: s = session(), ...rest }) {
  return buildReceipt({ jobs, session: s, selfCheck: { ok: true, checks: [] }, version: '0.1.0', now: NOW, ...rest });
}

test('a batch that spent records the exact charge per row and the honest total', () => {
  const r = receipt({
    jobs: [
      job({ id: 'a', name: 'fox', cost: 4, clickedAt: NOW - 500_000, state: 'done', file: { path: '/Users/me/FlowPilot/hero/fox.mp4', type: 'mp4' } }),
      job({ id: 'b', name: 'owl', cost: 8, clickedAt: NOW - 400_000, state: 'failed', error: 'Click may not have happened: Error: button not found. Check Flow; not retried.' }),
    ],
    session: session({ spent: 12 }),
  });

  assert.match(r.filename, /^flowpilot-receipt-\d{4}-\d{2}-\d{2}-\d{4}\.md$/);
  assert.equal(r.summary.chargedTotal, 12);
  assert.equal(r.summary.chargedRows, 2);
  assert.match(r.text, /at most 40 credits/);
  assert.match(r.text, /12 credits/);
  // Per-row facts a person can check in Flow: the charge and the file it produced.
  assert.match(r.text, /4 credits/);
  assert.match(r.text, /8 credits/);
  assert.match(r.text, /\/Users\/me\/FlowPilot\/hero\/fox\.mp4/);
  // The failure is reported with Flow Pilot's own words, and the row is not hidden.
  assert.match(r.text, /Click may not have happened: Error: button not found\. Check Flow; not retried\./);
});

test('a row that was never submitted is reported as not charged, not as spent', () => {
  const r = receipt({
    jobs: [
      job({ id: 'a', name: 'fox', cost: 4, clickedAt: NOW - 500_000, state: 'done' }),
      job({ id: 'b', name: 'owl', state: 'cancelled', history: [{ state: 'queued', at: 1 }, { state: 'cancelled', at: 2 }] }),
      job({ id: 'c', name: 'newt', state: 'approved' }),
    ],
    session: session({ spent: 4 }),
  });

  assert.equal(r.summary.chargedTotal, 4);
  assert.equal(r.summary.neverSubmitted, 2);
  assert.equal(r.summary.estimatedTotal, 8);
  assert.match(r.text, /never submitted, so nothing was charged/);
  assert.match(r.text, /owl/);
  assert.match(r.text, /newt/);
});

test('a row that may have reached Flow before the halt is never counted as a proven spend', () => {
  const halt = 'UNUSUAL_ACTIVITY from Flow: the request was refused';
  const r = receipt({
    jobs: [
      job({
        id: 'a', name: 'fox', state: 'failed', mayHaveSubmitted: true, error: 'Click may not have happened',
        history: [{ state: 'queued', at: 1 }, { state: 'submitting', at: 2 }, { state: 'halted', at: 3, reason: halt }],
      }),
    ],
    session: session({ halted: true, haltReason: halt, haltedAt: NOW - 300_000, spent: 0 }),
  });

  assert.equal(r.summary.chargedTotal, 0);
  assert.equal(r.summary.mayHaveBeenCharged, 1);
  // The exact wording of the block, once, straight from the records.
  assert.ok(r.text.includes(halt));
  assert.match(r.text, /cannot prove whether Flow charged/);
  assert.match(r.text, /NOT included in the 0 credits/);
  assert.match(r.text, /Check your balance in Flow/);
});

test('the receipt quotes the session counter and names a mismatch with the rows', () => {
  const r = receipt({
    jobs: [job({ id: 'a', name: 'fox', cost: 4, clickedAt: NOW - 500_000, state: 'done' })],
    session: session({ spent: 9 }),
  });
  assert.equal(r.summary.chargedTotal, 4);
  assert.match(r.text, /session counter says 9 credits/);
  assert.match(r.text, /disagree/);
});

test('prompt text stays out of the receipt unless it is asked for; the fingerprint is always there', () => {
  const secret = 'a red fox wearing my client\u2019s unreleased logo';
  const off = receipt({ jobs: [job({ prompt: secret, state: 'approved' })] });
  assert.ok(!off.text.includes(secret));
  assert.match(off.text, new RegExp(promptFingerprint(secret)));
  assert.match(off.text, /not included in this receipt/);

  const on = receipt({ jobs: [job({ prompt: secret, state: 'approved' })], includePrompts: true });
  assert.ok(on.text.includes(secret));
});

test('prompt fingerprints are stable, short and different for different prompts', () => {
  assert.equal(promptFingerprint('a red fox'), promptFingerprint('a red fox'));
  assert.match(promptFingerprint('a red fox'), /^[0-9a-f]{8}$/);
  assert.notEqual(promptFingerprint('a red fox'), promptFingerprint('a red fax'));
});

test('the receipt says plainly that it never left the machine and that Flow Pilot does not retry', () => {
  const r = receipt({ jobs: [job({ state: 'queued' })] });
  assert.match(r.text, /on this machine/);
  assert.match(r.text, /never uploads this file/i);
  assert.match(r.text, /does not retry after a block/);
});

test('an empty queue still produces an honest, readable receipt', () => {
  const r = receipt({ jobs: [] });
  assert.equal(r.summary.jobs, 0);
  assert.equal(r.summary.chargedTotal, 0);
  assert.match(r.text, /No jobs were in the queue/);
  assert.match(r.text, new RegExp(day(NOW).slice(0, 4)));
});

test('the receipt is built from the records alone: an unclicked row is never called a spend', () => {
  // A job whose cost is known (quote) but which never clicked must not add to the charged total,
  // even though the store knows what it would have cost (the report's "spent credits" complaint).
  const r = receipt({ jobs: [job({ state: 'approved', expectedCost: 7, cost: null })] });
  assert.equal(r.summary.chargedTotal, 0);
  assert.equal(r.summary.estimatedTotal, 7);
  assert.match(r.text, /nothing was charged/);
});
