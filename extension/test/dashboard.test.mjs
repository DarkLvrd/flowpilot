// The dashboard has no DOM harness, but the HTML↔script id contract is a real seam: a renamed or
// mistyped id would only surface as a runtime TypeError in the browser. This reads both files and
// checks the contract, plus that the dashboard's request commands are ones the service worker knows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ext = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ext, 'dashboard/index.html'), 'utf8');
const js = readFileSync(join(ext, 'dashboard/dashboard.js'), 'utf8');
const sw = readFileSync(join(ext, 'sw.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const usedIds = new Set([
  ...[...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/show\('([^']+)'/g)].map((m) => m[1]),
  'error', 'importError', // the default and explicit error-banner ids passed to act()/show()
]);

test('every element id the dashboard script uses exists in the dashboard HTML', () => {
  const missing = [...usedIds].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test('every label in the dashboard points at an element that exists', () => {
  const targets = [...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(targets.filter((t) => !htmlIds.has(t)), []);
});

test('every command the dashboard sends is a service-worker handler', () => {
  const cmds = new Set([...js.matchAll(/send\('([^']+)'/g)].map((m) => m[1]));
  assert.ok(cmds.size > 0);
  // Handlers are the keys of the `handlers` object in sw.js (both `name() {}` and `name: async () =>`).
  const start = sw.indexOf('const handlers = {');
  const end = sw.indexOf('\n};', start);
  const body = sw.slice(start, end);
  const known = new Set([...body.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z][\w]*)\s*[:(]/gm)].map((m) => m[1]));
  const missing = [...cmds].filter((c) => !known.has(c));
  assert.deepEqual(missing, []);
});
