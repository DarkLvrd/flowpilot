// Trust-on-first-use pinning of the extension that may open the bridge (docs/SPEC.md decision 9).
// The helper accepts the first `chrome-extension://` id that connects and refuses any other, so a
// second installed extension cannot pose as Flow Pilot and request pairing codes (`pairCode`) or
// receive agent commands. The pinned id is stored owner-only under the helper home; reset it with
// `flowpilot serve --forget-extension`.

import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';

export function createPin({ file, now = () => Date.now() }) {
  function read() {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).id ?? null;
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
  }

  return {
    get: read,

    // Trust-on-first-use: the first id is pinned and accepted; afterwards a matching id is accepted
    // and a different one is refused (never pinned). Returns true if `id` may open the bridge.
    check(id) {
      const pinned = read();
      if (pinned) return pinned === id;
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ id, pinnedAt: now() }, null, 2), { mode: 0o600 });
      renameSync(tmp, file);
      return true;
    },

    forget() {
      rmSync(file, { force: true });
    },
  };
}
