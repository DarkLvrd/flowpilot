import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256, sha256Hex } from '../lib/sha256.js';

// Independent known-good values (FIPS 180-4 vectors plus Node's own digest), never recomputed the
// way the module computes them.
const vector = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('hashes the FIPS 180-4 vectors', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  );
});

test('agrees with Node for multi-block and non-ASCII text', () => {
  for (const s of ['x'.repeat(55), 'y'.repeat(56), 'z'.repeat(64), 'a'.repeat(1000), 'Rudy — 3D Pixar ✨\nline two']) {
    assert.equal(sha256Hex(s), vector(s), `sha256 mismatch for ${s.length} chars`);
  }
});

test('returns the digest as bytes and hex of the same value', () => {
  const bytes = sha256('abc');
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 32);
  assert.equal(Buffer.from(bytes).toString('hex'), sha256Hex('abc'));
});
