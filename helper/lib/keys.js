// Agent pairing (docs/SPEC.md decision 9). The dashboard asks for a one-time code; the person gives
// it to an agent, which trades it for a key. Codes live only in memory: one at a time, 5 minutes,
// single use, voided after 5 wrong guesses. Keys are stored as SHA-256 hashes only, in a file only
// the owner can read, so the file itself unlocks nothing.

import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const CODE_TTL_MS = 5 * 60_000;
const MAX_GUESSES = 5;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: codes are read aloud and retyped

const hash = (key) => createHash('sha256').update(key).digest('hex');

export function createKeyring({ file, now = () => Date.now() }) {
  let agents = load();
  let pending = null; // { code, expiresAt, wrong }

  function load() {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).agents ?? [];
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  function save() {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ agents }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }

  return {
    newCode() {
      const pick = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      pending = { code: `${pick()}-${pick()}`, expiresAt: now() + CODE_TTL_MS, wrong: 0 };
      return { code: pending.code, expiresAt: pending.expiresAt };
    },

    // Returns the new key; it is shown once and never stored in the clear.
    redeem(code, name) {
      if (!pending) throw new Error('No pairing code is active: make one in the Flow Pilot dashboard');
      if (now() > pending.expiresAt) {
        pending = null;
        throw new Error('That pairing code expired: make a new one in the dashboard');
      }
      if (String(code).trim().toUpperCase() !== pending.code) {
        if (++pending.wrong >= MAX_GUESSES) pending = null;
        throw new Error('Wrong code');
      }
      pending = null;
      const label = String(name ?? '').trim().slice(0, 60) || 'agent';
      const key = `fp_${randomBytes(32).toString('base64url')}`;
      agents = [...agents.filter((a) => a.name !== label), { name: label, hash: hash(key), pairedAt: now() }];
      save();
      return key;
    },

    verify(key) {
      if (typeof key !== 'string' || !key.startsWith('fp_')) return null;
      const h = hash(key);
      const agent = agents.find((a) => a.hash === h);
      return agent ? { name: agent.name, pairedAt: agent.pairedAt } : null;
    },

    list() {
      return agents.map(({ name, pairedAt }) => ({ name, pairedAt }));
    },

    revoke(name) {
      agents = agents.filter((a) => a.name !== name);
      save();
    },
  };
}
