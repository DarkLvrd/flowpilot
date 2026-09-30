import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPin } from '../lib/pin.js';

const A = 'abcdefghijklmnopabcdefghijklmnop';
const B = 'ponmlkjihgfedcbaponmlkjihgfedcba';
const tmp = () => mkdtempSync(join(tmpdir(), 'fp-pin-'));

test('trust-on-first-use: the first id is pinned and accepted; a different id is refused and never pinned', () => {
  const file = join(tmp(), 'nested', 'extension.json');
  const pin = createPin({ file });
  assert.equal(pin.get(), null);

  assert.equal(pin.check(A), true);
  assert.equal(pin.get(), A);
  assert.equal(pin.check(A), true); // the same id keeps working

  assert.equal(pin.check(B), false); // a second, different extension id is refused
  assert.equal(pin.get(), A); // and the pin is untouched
});

test('the pin file is owner-only (mode 600)', () => {
  const file = join(tmp(), 'extension.json');
  createPin({ file }).check(A);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, A);
});

test('forget clears the pin so the next id pins afresh', () => {
  const file = join(tmp(), 'extension.json');
  const pin = createPin({ file });
  pin.check(A);
  pin.forget();
  assert.equal(pin.get(), null);
  assert.ok(!existsSync(file));
  pin.forget(); // idempotent when there is nothing to clear
  assert.equal(pin.check(B), true); // a fresh trust-on-first-use
  assert.equal(pin.get(), B);
});

test('a pin persists across processes: a new instance reads the same file', () => {
  const file = join(tmp(), 'extension.json');
  createPin({ file }).check(A);
  const reopened = createPin({ file });
  assert.equal(reopened.get(), A);
  assert.equal(reopened.check(B), false);
});
