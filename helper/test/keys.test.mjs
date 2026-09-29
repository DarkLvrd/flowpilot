import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKeyring } from '../lib/keys.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'flowpilot-keys-')), 'agents.json');

function ring({ file = tmpFile(), start = 1_000_000 } = {}) {
  let t = start;
  const keyring = createKeyring({ file, now: () => t });
  return { keyring, file, advance: (ms) => { t += ms; } };
}

test('a code shown in the dashboard pairs one agent, once, and the key it gets is accepted', () => {
  const { keyring } = ring();
  const { code } = keyring.newCode();
  assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const key = keyring.redeem(code, 'claude');
  assert.equal(keyring.verify(key)?.name, 'claude');
  assert.throws(() => keyring.redeem(code, 'other'), /no pairing code|expired|used/i);
  assert.equal(keyring.verify('fp_wrong'), null);
  assert.equal(keyring.verify(undefined), null);
});

test('codes expire after 5 minutes and a new code replaces the old one', () => {
  const { keyring, advance } = ring();
  const first = keyring.newCode().code;
  const second = keyring.newCode().code;
  assert.throws(() => keyring.redeem(first, 'a'), /wrong code/i);
  advance(5 * 60_000 + 1);
  assert.throws(() => keyring.redeem(second, 'a'), /expired|no pairing code/i);
});

test('five wrong guesses void the code', () => {
  const { keyring } = ring();
  const { code } = keyring.newCode();
  for (let i = 0; i < 5; i++) assert.throws(() => keyring.redeem('AAAA-AAAA', 'x'), /wrong code/i);
  assert.throws(() => keyring.redeem(code, 'x'), /no pairing code/i);
});

test('only a hash of each key is stored, in a file only the owner can read; keys survive a restart and can be revoked', () => {
  const { keyring, file } = ring();
  const key = keyring.redeem(keyring.newCode().code, 'claude');
  const saved = readFileSync(file, 'utf8');
  assert.ok(!saved.includes(key));
  assert.equal(statSync(file).mode & 0o077, 0);

  const reopened = createKeyring({ file });
  assert.equal(reopened.verify(key)?.name, 'claude');
  assert.deepEqual(reopened.list().map((a) => a.name), ['claude']);
  reopened.revoke('claude');
  assert.equal(createKeyring({ file }).verify(key), null);
});
