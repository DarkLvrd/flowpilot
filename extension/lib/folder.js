// The folder the person picked for this session with the File System Access API
// (docs/SPEC.md decision 5). The handle lives in IndexedDB, which both the dashboard (where the
// user gesture happens) and the service worker (where the finished file is written) can reach.
// Browser-only: every function degrades to null when IndexedDB or the API is unavailable, and the
// service worker then falls back to a browser download. Nothing here touches Flow or credentials.

const DB = 'flowpilot';
const STORE = 'handles';
const KEY = 'outputFolder';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const store = db.transaction(STORE, mode).objectStore(STORE);
    const req = run(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function setFolderHandle(handle) {
  const db = await openDb();
  if (!db) return null;
  await tx(db, 'readwrite', (s) => s.put(handle, KEY));
  return { name: handle.name };
}

export async function getFolderHandle() {
  try {
    const db = await openDb();
    if (!db) return null;
    return (await tx(db, 'readonly', (s) => s.get(KEY))) ?? null;
  } catch { return null; }
}

export async function clearFolderHandle() {
  const db = await openDb();
  if (!db) return null;
  await tx(db, 'readwrite', (s) => s.delete(KEY));
  return null;
}

// Whether the picked folder can be written to right now (the grant is per session).
export async function folderGranted(handle) {
  if (!handle?.queryPermission) return false;
  return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
}

// Writes `bytes` to `relativePath` under `root`, creating subfolders, and never overwriting an
// existing file: a collision gets -2, -3… (the same rule as the browser download's uniquify).
export async function writeToFolder(root, relativePath, bytes) {
  const segments = String(relativePath).split('/').filter(Boolean);
  const filename = segments.pop();
  const dirSegments = segments;
  let dir = root;
  for (const seg of dirSegments) dir = await dir.getDirectoryHandle(seg, { create: true });

  let name = filename;
  for (let n = 2; ; n++) {
    const existing = await dir.getFileHandle(name).catch(() => null);
    if (!existing) break;
    name = `${filename}-${n}`;
  }
  const fileHandle = await dir.getFileHandle(name, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(bytes);
  await writable.close();
  return [...dirSegments, name].join('/');
}
