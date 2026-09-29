// Writes a finished result to an absolute path an agent named (docs/SPEC.md decision 5). An agent key
// must not become a way to write any file: only media names, only when the bytes are that media
// type, and never over an existing file (a taken name gets " (1)", " (2)", …).

import { openSync, writeSync, closeSync, mkdirSync } from 'node:fs';
import { isAbsolute, dirname, extname, basename, join } from 'node:path';
import { sniffType } from '../../extension/lib/magic.js';

const TYPE_OF_EXT = { '.mp4': 'mp4', '.png': 'png', '.jpg': 'jpeg', '.jpeg': 'jpeg', '.webp': 'webp' };

// Returns the path actually written.
export function writeMedia(path, bytes) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`Output path must be absolute: ${path}`);
  const ext = extname(path).toLowerCase();
  const want = TYPE_OF_EXT[ext];
  if (!want) throw new Error(`Only media files can be written (.mp4, .png, .jpg, .jpeg, .webp): ${path}`);
  const got = sniffType(bytes);
  if (got !== want) throw new Error(`The bytes are ${got ?? 'not media'}, not a ${ext.slice(1)}: ${path}`);

  mkdirSync(dirname(path), { recursive: true });
  const stem = basename(path, extname(path));
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? path : join(dirname(path), `${stem} (${n})${extname(path)}`);
    let fd;
    try {
      fd = openSync(candidate, 'wx'); // fails if it exists: never overwrite
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try { writeSync(fd, bytes); } finally { closeSync(fd); }
    return candidate;
  }
  throw new Error(`Too many files named like ${path}`);
}
