// The entity library mirror (report §4.8: "the library lives in browser storage … mirror it to a
// file (helper) and support export/import from day one"). The extension writes the library through
// the bridge on every change; the helper keeps it at
// `~/.flowpilot/projects/<projectId>/entities.json` so a browser reinstall does not lose it.
//
// Nothing here trusts the caller: the project id must be a Flow project uuid (so it can never walk
// out of the projects folder), the library goes through the same `normalizeLibrary` validation the
// extension uses, and the file is written to a temp name and renamed (a half-written library is
// never visible).

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeLibrary, isMediaId } from '../../extension/lib/entities.js';
import { sha256Hex } from '../../extension/lib/sha256.js';
import { sniffType } from '../../extension/lib/magic.js';

const PROJECT_ID = /^[0-9a-f-]{36}$/;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024; // the same bound a reference upload uses
const IMAGE_TYPES = new Set(['png', 'jpeg', 'webp']);

const checkProjectId = (projectId) => {
  if (typeof projectId !== 'string' || !PROJECT_ID.test(projectId)) throw new Error(`A Flow project id is a uuid, got: ${JSON.stringify(projectId)}`);
  return projectId;
};

export function projectDir(home, projectId) {
  return join(home, 'projects', checkProjectId(projectId));
}

export function entitiesFile(home, projectId) {
  return join(projectDir(home, projectId), 'entities.json');
}

// Validates and writes the mirror; returns the path written.
export function writeEntitiesFile(home, projectId, library, { now = Date.now() } = {}) {
  const validated = normalizeLibrary({ ...library, projectId, updatedAt: library?.updatedAt ?? now }, projectId);
  const file = entitiesFile(home, projectId);
  mkdirSync(projectDir(home, projectId), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return file;
}

// The mirrored library, validated again on the way out (a hand-edited file must not become a
// library the extension would refuse).
export function readEntitiesFile(home, projectId) {
  const file = entitiesFile(home, projectId);
  if (!existsSync(file)) {
    throw new Error(`No mirrored entity library for project ${projectId} at ${file} (nothing to restore yet)`);
  }
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new Error(`The mirrored entity library ${file} is not valid JSON: ${e.message}`);
  }
  return normalizeLibrary(raw, projectId);
}

// A dropped photo is provenance, never a locked reference: it names the file, its bytes kind and
// its sha256 so an entity can be traced back to the original while the refs stay media ids
// (report §2.1 rule 3). Bytes are checked here so a non-image is refused before anything is stored.
export function describeSourcePhoto(path, { readBytes = readFileSync } = {}) {
  if (typeof path !== 'string' || !/^(\/|[A-Za-z]:[\\/])/.test(path)) throw new Error(`A source photo path must be absolute: ${JSON.stringify(path)}`);
  let bytes;
  try { bytes = readBytes(path); } catch (e) {
    throw new Error(e.code === 'ENOENT' ? `Source photo not found: ${path}` : `Cannot read source photo ${path}: ${e.message}`);
  }
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error(`Source photo is too large (${bytes.length} bytes, max ${MAX_SOURCE_BYTES}): ${path}`);
  const type = sniffType(bytes);
  if (!IMAGE_TYPES.has(type)) throw new Error(`A source photo must be a PNG, JPEG or WebP image: ${path} is ${type ?? 'not an image'}`);
  return { path, name: path.split(/[\\/]/).pop(), sha256: sha256Hex(new Uint8Array(bytes)), type };
}

// One reference for an entity: a locked Flow media id, or `{ mediaId, role, label }`.
export function normalizeRef(ref) {
  const mediaId = typeof ref === 'string' ? ref.trim() : ref?.mediaId;
  if (!isMediaId(mediaId)) {
    throw new Error(`A locked reference must be a Flow media id, got ${JSON.stringify(mediaId)}${typeof ref === 'string' && ref.startsWith('/') ? ' — upload it in Flow first (locked ids only), or use --source-photo for provenance' : ''}`);
  }
  return { ...(typeof ref === 'object' ? ref : {}), mediaId };
}
