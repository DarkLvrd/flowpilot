import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlockJudge } from '../lib/block-check.js';

// A fake TypeSafe endpoint: answers each Noul question with the probability `score(text)` gives
// the message it carries, and records every request.
function fakeJev(score, { statuses = [] } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response('{"detail":"busy"}', { status });
    const { questions } = JSON.parse(init.body);
    const answers = {};
    for (const [id, q] of Object.entries(questions)) answers[id] = { type: 'noul', noul: score(q.instructions.message) };
    return Response.json({ model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } });
  };
  return { fetch, calls };
}

test('the default threshold halts on a middling yes (additive only, so it leans towards stopping)', async () => {
  const r = await judge(fakeJev(() => 0.5)).check(["Please verify it's you to continue."]);
  assert.equal(r.halt, true);
  assert.equal((await judge(fakeJev(() => 0.25)).check(['Only 12 credits left this month'])).halt, false);
});

const judge = (jev, opts = {}) => createBlockJudge({ fetch: jev.fetch, apiKey: 'test-key', sleep: async () => {}, ...opts });

test('halts when Jev is sure a message means the account is being limited', async () => {
  const jev = fakeJev((t) => (/daily limit/.test(t) ? 0.97 : 0.02));
  const r = await judge(jev).check(['Your video is ready', "You've reached your daily limit"]);
  assert.equal(r.halt, true);
  assert.equal(r.message, "You've reached your daily limit");
  assert.deepEqual(r.scores, [{ message: 'Your video is ready', p: 0.02 }, { message: "You've reached your daily limit", p: 0.97 }]);
});

test('a failed or malformed call adds nothing: no halt, and says why', async () => {
  const down = { fetch: async () => new Response('{"detail":"bad key"}', { status: 401 }) };
  const r1 = await judge(down).check(['Account limited']);
  assert.equal(r1.halt, false);
  assert.match(r1.error, /401/);

  const odd = { fetch: async () => Response.json({ answers: { n0: { type: 'noul' } } }) };
  const r2 = await judge(odd).check(['Account limited']);
  assert.equal(r2.halt, false);
  assert.match(r2.error, /answer/);

  const offline = { fetch: async () => { throw new TypeError('fetch failed'); } };
  const r3 = await judge(offline).check(['Account limited']);
  assert.equal(r3.halt, false);
  assert.match(r3.error, /fetch failed/);
});

test('retries 429 and 529 with growing waits, then gives up without halting', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const busyOnce = fakeJev(() => 0.95, { statuses: [429, 529] });
  const r1 = await judge(busyOnce, { sleep }).check(['Too many requests']);
  assert.equal(r1.halt, true);
  assert.equal(busyOnce.calls.length, 3);
  assert.ok(waits[1] > waits[0]);

  const alwaysBusy = fakeJev(() => 0.95, { statuses: [429, 429, 429, 429, 429, 429] });
  const r2 = await judge(alwaysBusy, { sleep }).check(['Too many requests']);
  assert.equal(r2.halt, false);
  assert.match(r2.error, /429/);
  assert.equal(alwaysBusy.calls.length, 4);
});

test('asks once per distinct message and skips the call when there is nothing to ask', async () => {
  const jev = fakeJev(() => 0.01);
  assert.deepEqual(await judge(jev).check(['', '   ']), { halt: false });
  assert.equal(jev.calls.length, 0);

  await judge(jev).check(['Project renamed', ' Project renamed ', 'Copied']);
  // Each question carries its own message: pointing at a shared list by index let Jev blur
  // neighbouring messages (calibration run, 2026-09-28).
  assert.deepEqual(Object.values(jev.calls[0].body.questions).map((q) => q.instructions.message), ['Project renamed', 'Copied']);
  assert.equal(jev.calls[0].init.headers.Authorization, 'Bearer test-key');
});

test('a Jev call that hangs gives up after the time limit, without halting', async () => {
  // Never answers; only the abort signal ends it (the engine waits on this call).
  const hung = { fetch: (_url, init) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason))) };
  const r = await judge(hung, { timeoutMs: 20 }).check(['Account limited']);
  assert.equal(r.halt, false);
  assert.match(r.error, /unreachable/);
});
