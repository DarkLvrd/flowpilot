// The entity library surfaces agents use: the helper's mirror file, the HTTP routes, the CLI
// commands and `flowpilot prompts` (report §2.7). The extension is faked, so this runs offline.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createKeyring } from '../lib/keys.js';
import { createPin } from '../lib/pin.js';
import { createHelper } from '../lib/server.js';
import { main } from '../lib/cli.js';
import { entitiesFile, describeSourcePhoto, normalizeRef } from '../lib/entities-file.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const PID = '7bcd806e-da37-4ada-aa6a-10fb4ffe7efb';
const MEDIA = 'bc92bce2-2183-4ab2-80f6-d5aead42857a';
const PNG = Buffer.from([0x89, ...Buffer.from('PNG\r\n'), 0x1a, 0x0a, ...Array(32).fill(0)]);

const entity = () => ({
  id: 'ent_4b1e77aa', kind: 'character', name: 'Rudy', aliases: [], orientation: 'portrait',
  description: 'CHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.',
  negative: 'realistic skin', refs: [{ mediaId: MEDIA, role: 'sheet', label: 'rudy_sheet_v1', addedAt: 1 }],
  primaryRefMediaId: MEDIA, sourcePhoto: null, flowCharacter: null,
  approvedAt: 1, approvedBy: 'dashboard', version: 1, history: [],
});
const library = () => ({ schema: 1, projectId: PID, styleId: null, entities: [entity()], updatedAt: 1 });

const worlds = [];
after(async () => { await Promise.all(worlds.map((w) => w.close())); }); // failed tests still close their sockets

async function world() {
  const home = mkdtempSync(join(tmpdir(), 'fp-entities-'));
  const keyring = createKeyring({ file: join(home, 'agents.json') });
  const pin = createPin({ file: join(home, 'extension.json') });
  const helper = createHelper({ keyring, pin, home });
  const port = await helper.listen(0);
  const calls = [];
  const job = { id: 'j1', name: 'rudy shot', state: 'queued', prompt: 'a\n\nCHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.', promptParts: [{ kind: 'base', ref: 'prompt', sha256: 'a'.repeat(64), text: 'a' }, { kind: 'entity', ref: 'ent_4b1e77aa', sha256: 'b'.repeat(64), text: 'CHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.' }] };
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: EXT });
  const pending = new Map();
  let rid = 0;
  ws.on('message', async (raw) => {
    const m = JSON.parse(raw);
    if (m.rid != null) { pending.get(m.rid)?.(m); pending.delete(m.rid); return; }
    calls.push([m.cmd, m.args]);
    let value;
    switch (m.cmd) {
      case 'status': value = { session: { cap: 10, spent: 0, halted: false }, workTab: { projectId: PID }, jobs: [job] }; break;
      case 'entities': value = { projectId: PID, library: library(), template: { sections: ['shot', 'beat', 'action', 'motion', 'setting', 'camera', 'entities', 'style', 'audio', 'negative'], durationS: 4 }, warnings: ['No style entity yet: add the project style lock so every prompt ends with it'] }; break;
      case 'entityExport': value = library(); break;
      case 'entityUpsert': value = { ...m.args.entity, id: 'ent_new0001', version: 1, approvedAt: null, refs: (m.args.entity.refs ?? []).map((r) => ({ addedAt: 1, ...r })) }; break;
      case 'entityApprove': value = { ...entity(), approvedAt: 5, approvedBy: m.args.by ?? 'agent' }; break;
      case 'entityUnapprove': value = { ...entity(), approvedAt: null, approvedBy: null, version: 2 }; break;
      case 'entitySupersede': value = { ...entity(), refs: [], version: 2, primaryRefMediaId: null, history: [{ version: 1, refs: entity().refs, reason: m.args.reason, supersededAt: 9 }] }; break;
      case 'entityAddRef': value = { ...entity(), version: 2, refs: [...entity().refs, { addedAt: 9, ...m.args.ref }] }; break;
      case 'entitySetStyle': value = { id: 'ent_style1', kind: 'style', name: 'Style lock', description: 'The whole video stays in this 3D Pixar/Disney animation style…', negative: 'photorealistic', refs: [], version: 1, approvedAt: 9, approvedBy: 'dashboard' }; break;
      case 'entityImport': value = { ...library(), entities: [...library().entities, ...(m.args.library.entities ?? [])] }; break;
      case 'entityRestore': value = { projectId: PID, mode: m.args.mode, library: library() }; break;
      case 'composePrompt': value = { projectId: PID, text: `x\n\nCHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.`, sha256: 'c'.repeat(64), entities: [{ entityId: 'ent_4b1e77aa', name: 'Rudy', version: 1, mediaId: MEDIA }], parts: [{ kind: 'base', ref: 'prompt', sha256: 'a'.repeat(64), text: 'x' }, { kind: 'entity', ref: 'ent_4b1e77aa', sha256: 'b'.repeat(64), text: 'CHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.' }] }; break;
      default: value = { cmd: m.cmd, args: m.args };
    }
    ws.send(JSON.stringify({ id: m.id, ok: true, value }));
  });
  await new Promise((r) => ws.once('open', r));
  const ask = (req, extra = {}) => new Promise((resolve) => { const id = ++rid; pending.set(id, resolve); ws.send(JSON.stringify({ rid: id, req, ...extra })); });
  const env = { FLOWPILOT_HOME: home, FLOWPILOT_PORT: String(port) };
  const run = async (...argv) => {
    const out = [];
    const code = await main(argv, { env, out: (s) => out.push(s), err: (s) => out.push(s) });
    return { code, text: out.join('\n') };
  };
  await run('pair', keyring.newCode().code);
  const close = async () => { ws.close(); await helper.close(); };
  const w = { home, port, calls, ask, run, close };
  worlds.push(w);
  return w;
}

test('the helper mirrors the library to a file under its home and reads it back', async () => {
  const w = await world();
  const written = await w.ask('writeEntities', { projectId: PID, library: library() });
  assert.equal(written.ok, true, written.error);
  const file = entitiesFile(w.home, PID);
  assert.equal(written.value.path, file);
  assert.equal(existsSync(file), true);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.entities[0].name, 'Rudy');
  assert.equal(stored.projectId, PID);

  const read = await w.ask('readEntities', { projectId: PID });
  assert.equal(read.ok, true, read.error);
  assert.deepEqual(read.value.library.entities[0].refs, library().entities[0].refs);

  // A hand-broken file is refused rather than handed to the extension.
  writeFileSync(file, '{"entities": "nope"}');
  const broken = await w.ask('readEntities', { projectId: PID });
  assert.equal(broken.ok, false);
  assert.match(broken.error, /entities/i);
  await w.close();
});

test('the mirror path cannot be walked out of the projects folder, and a bad library is not written', async () => {
  const w = await world();
  const escape = await w.ask('writeEntities', { projectId: '../../etc', library: library() });
  assert.equal(escape.ok, false);
  assert.match(escape.error, /uuid/i);
  const bad = await w.ask('writeEntities', { projectId: PID, library: { schema: 1, projectId: PID, entities: [{ name: 'no id' }] } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /id/i);
  assert.equal(existsSync(entitiesFile(w.home, PID)), false);
  await w.close();
});

test('the entity HTTP routes forward to the extension as entity commands', async () => {
  const w = await world();
  const key = readFileSync(join(w.home, 'key'), 'utf8').trim();
  const base = `http://127.0.0.1:${w.port}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  assert.equal((await call('GET', `/entities?projectId=${PID}`)).body.library.entities[0].name, 'Rudy');
  assert.deepEqual(w.calls.at(-1), ['entities', { projectId: PID }]);

  const upsert = await call('POST', '/entities', { projectId: PID, entity: { kind: 'location', name: 'Lake', description: 'a quiet lake at dawn' } });
  assert.equal(upsert.body.id, 'ent_new0001');
  assert.equal(w.calls.at(-1)[0], 'entityUpsert');

  await call('POST', '/entities/approve', { projectId: PID, name: 'Rudy' });
  assert.equal(w.calls.at(-1)[0], 'entityApprove');
  await call('POST', '/entities/supersede', { projectId: PID, name: 'Rudy', ref: MEDIA, reason: 'flat bronze' });
  assert.deepEqual(w.calls.at(-1), ['entitySupersede', { projectId: PID, name: 'Rudy', ref: MEDIA, reason: 'flat bronze' }]);
  await call('POST', '/entities/import', { projectId: PID, library: library(), mode: 'merge' });
  assert.deepEqual(w.calls.at(-1)[1].mode, 'merge');
  await call('POST', '/entities/restore', { projectId: PID, mode: 'merge' });
  assert.equal(w.calls.at(-1)[0], 'entityRestore');
  const exported = await call('GET', `/entities/export?projectId=${PID}`);
  assert.equal(exported.body.entities[0].id, 'ent_4b1e77aa');
  const composed = await call('POST', '/prompts', { projectId: PID, spec: { prompt: 'x', entities: ['Rudy'] } });
  assert.equal(composed.body.entities[0].name, 'Rudy');
  assert.equal(w.calls.at(-1)[0], 'composePrompt');

  const unknown = await call('POST', '/entities/wat', { projectId: PID });
  assert.equal(unknown.status, 404);
  await w.close();
});

test('the CLI adds, lists, shows, approves, supersedes and exports entities', async () => {
  const w = await world();
  const desc = join(w.home, 'rudy.txt');
  writeFileSync(desc, 'CHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.\n');

  const added = await w.run('entity', 'add', '--project', PID, '--kind', 'character', '--name', 'Rudy', '--desc-file', desc, '--ref', MEDIA, '--role', 'sheet', '--label', 'rudy_sheet_v1', '--json');
  assert.equal(added.code, 0, added.text);
  assert.equal(w.calls.at(-1)[0], 'entityUpsert');
  assert.deepEqual(w.calls.at(-1)[1].entity.refs, [{ mediaId: MEDIA, role: 'sheet', label: 'rudy_sheet_v1' }]);
  assert.equal(JSON.parse(added.text).name, 'Rudy');

  const listed = await w.run('entity', 'list', '--project', PID);
  assert.equal(listed.code, 0, listed.text);
  assert.match(listed.text, /✅ Rudy \(character, v1\)/);
  assert.match(listed.text, /⚠️ No style entity yet/);

  const shown = await w.run('entity', 'show', '--project', PID, '--name', 'rudy');
  assert.equal(shown.code, 0, shown.text);
  assert.match(shown.text, /CHARACTER — RUDY/);
  assert.match(shown.text, /prompt block: CHARACTER — RUDY \(identical in every shot\)/);
  assert.match(shown.text, new RegExp(MEDIA));

  assert.equal((await w.run('entity', 'approve', '--project', PID, '--name', 'Rudy')).code, 0);
  // The extension records who approved it: a bridge call is an agent, a dashboard click is 'dashboard'.
  assert.deepEqual(w.calls.at(-1), ['entityApprove', { projectId: PID, name: 'Rudy' }]);

  const superseded = await w.run('entity', 'supersede', '--project', PID, '--name', 'Rudy', '--ref', MEDIA, '--reason', 'flat bronze rear half');
  assert.equal(superseded.code, 0, superseded.text);
  assert.deepEqual(w.calls.at(-1), ['entitySupersede', { projectId: PID, name: 'Rudy', ref: MEDIA, reason: 'flat bronze rear half' }]);

  const out = join(w.home, 'export.json');
  const exported = await w.run('entity', 'export', '--project', PID, '--file', out);
  assert.equal(exported.code, 0, exported.text);
  assert.match(exported.text, /Exported 1 entities/);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).entities[0].name, 'Rudy');

  const imported = await w.run('entity', 'import', '--project', PID, '--file', out, '--replace');
  assert.equal(imported.code, 0, imported.text);
  assert.equal(w.calls.at(-1)[1].mode, 'replace');
  assert.equal(w.calls.at(-1)[1].library.entities[0].name, 'Rudy');

  const restored = await w.run('entity', 'restore', '--project', PID);
  assert.equal(restored.code, 0, restored.text);
  assert.equal(w.calls.at(-1)[0], 'entityRestore');
  await w.close();
});

test('the CLI refuses a path as a locked reference, but records it as source provenance', async () => {
  const w = await world();
  const photo = join(w.home, 'photo.png');
  writeFileSync(photo, PNG);
  const desc = join(w.home, 'block.txt');
  writeFileSync(desc, 'VEHICLE — HELLCAT (identical in every shot): a two-tone widebody Charger.');

  const refused = await w.run('entity', 'add', '--project', PID, '--kind', 'vehicle', '--name', 'Hellcat', '--desc-file', desc, '--ref', photo);
  assert.equal(refused.code, 1);
  assert.match(refused.text, /media id/);

  const ok = await w.run('entity', 'add', '--project', PID, '--kind', 'vehicle', '--name', 'Hellcat', '--desc-file', desc, '--source-photo', photo, '--json');
  assert.equal(ok.code, 0, ok.text);
  const sent = JSON.parse(ok.text);
  assert.equal(sent.sourcePhoto.path, photo);
  assert.equal(sent.sourcePhoto.name, 'photo.png');
  assert.equal(sent.sourcePhoto.sha256.length, 64);
  assert.deepEqual(sent.refs, []); // no locked reference at all: provenance only

  assert.throws(() => normalizeRef('/tmp/front.png'), /media id/);
  assert.throws(() => describeSourcePhoto(desc), /must be a PNG, JPEG or WebP/);
  assert.throws(() => describeSourcePhoto('relative.png'), /absolute/);
  await w.close();
});

test('flowpilot prompts shows the composed parts and hashes without spending', async () => {
  const w = await world();
  const shown = await w.run('prompts', 'j1');
  assert.equal(shown.code, 0, shown.text);
  assert.match(shown.text, /Job j1/);
  assert.match(shown.text, /base\s+prompt/);
  assert.match(shown.text, /entity\s+ent_4b1e77aa/);
  assert.match(shown.text, /a{12}…/);
  assert.match(shown.text, /what Flow will receive/);
  assert.match(shown.text, /CHARACTER — RUDY \(identical in every shot\)/);

  const json = JSON.parse((await w.run('prompts', 'j1', '--json')).text);
  assert.equal(json.parts.length, 2);
  assert.equal(json.prompt, json.parts.map((p) => p.text).join('\n\n'));
  await w.close();
});

test('flowpilot compose is a dry run over the entity library', async () => {
  const w = await world();
  const composed = await w.run('compose', '--project', PID, '--prompt', 'she turns to face the camera', '--entity', 'Rudy');
  assert.equal(composed.code, 0, composed.text);
  assert.deepEqual(w.calls.at(-1)[1].spec, { prompt: 'she turns to face the camera', entities: ['Rudy'] });
  assert.match(composed.text, /CHARACTER — RUDY/);
  assert.match(composed.text, /what Flow will receive/);
  await w.close();
});

test('an entity with no locked reference is reported, and a job with no composed parts says so', async () => {
  const w = await world();
  const missingDesc = await w.run('entity', 'add', '--project', PID, '--kind', 'character', '--name', 'Rudy');
  assert.equal(missingDesc.code, 2);
  assert.match(missingDesc.text, /--desc-file/);
  const noKind = await w.run('entity', 'add', '--project', PID, '--name', 'Rudy', '--description', 'x');
  assert.equal(noKind.code, 2);
  assert.match(noKind.text, /--kind/);
  assert.equal((await w.run('entity', 'wat', '--project', PID)).code, 2);
  await w.close();
});

test('the source-photo and mirror helpers are usable on their own', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-src-'));
  const photo = join(dir, 'a.png');
  mkdirSync(dir, { recursive: true });
  writeFileSync(photo, PNG);
  const described = describeSourcePhoto(photo);
  assert.equal(described.name, 'a.png');
  assert.equal(described.type, 'png');
  assert.equal(described.sha256.length, 64);
  assert.throws(() => describeSourcePhoto(join(dir, 'missing.png')), /not found/);
});
