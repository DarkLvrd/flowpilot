import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '../lib/sha256.js';
import { loadDefaults } from '../lib/prompt-assets.js';
import {
  KINDS, ROLES, entityBlock, mergeNegative, resolveEntities, composePrompt, promptBaseHash,
  appendConsistencyBlock, supersedeRef, reviseEntity, validateEntity, validateTemplate,
  emptyLibrary, normalizeLibrary, createEntityStore, createTemplateStore, DEFAULT_TEMPLATE, libraryWarnings,
} from '../lib/entities.js';

const MEDIA1 = 'bc92bce2-2183-4ab2-80f6-d5aead42857a';
const MEDIA2 = 'a1b2c3d4-0000-0000-0000-000000000000';
const defaults = await loadDefaults();
const template = defaults.template;

const entity = (over = {}) => ({
  id: 'ent_4b1e77aa', kind: 'character', name: 'Rudy', aliases: ['the guy'], orientation: 'portrait',
  description: 'a heavyset Black man in his 30s with a full dark beard. Plain black tee, white sneakers.',
  negative: 'realistic skin, photograph, different outfit',
  refs: [{ mediaId: MEDIA1, role: 'sheet', label: 'rudy_sheet_v1', addedAt: 1 }],
  primaryRefMediaId: MEDIA1, sourcePhoto: null, flowCharacter: null,
  approvedAt: 1, approvedBy: 'dashboard', version: 1, history: [],
  ...over,
});

const library = (over = {}) => ({
  ...emptyLibrary('p1'),
  styleId: 'ent_style1',
  entities: [entity(), styleEntity()],
  ...over,
});

function styleEntity() {
  return {
    id: 'ent_style1', kind: 'style', name: 'Style lock', aliases: [], orientation: 'none',
    description: defaults.style.description, negative: defaults.style.negative.join(', '),
    refs: [], primaryRefMediaId: null, sourcePhoto: null, flowCharacter: null,
    approvedAt: 1, approvedBy: 'dashboard', version: 1, history: [],
  };
}

// Same contract as chrome.storage.local.
function memoryArea() {
  const data = {};
  return {
    data,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
  };
}

test('an entity block names the subject in caps and is stable until its description changes', () => {
  const a = entityBlock(entity());
  assert.equal(a.text, 'CHARACTER — RUDY (identical in every shot): a heavyset Black man in his 30s with a full dark beard. Plain black tee, white sneakers.');
  assert.equal(a.sha256, sha256Hex(a.text));
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(entityBlock(entity()), a); // stable across calls
  assert.notEqual(entityBlock(entity({ description: 'a taller man' })).sha256, a.sha256);
  // The block carries only the description: negatives, refs and names feed other places.
  assert.equal(a.text.includes('realistic skin'), false);
  assert.equal(a.text.includes(MEDIA1), false);
  assert.equal(entityBlock(entity({ kind: 'vehicle', name: 'Hellcat' })).text.startsWith('VEHICLE — HELLCAT'), true);
  assert.throws(() => entityBlock({ id: 'ent_x', kind: 'ghost', name: 'x', description: 'y' }), /kind/i);
});

test('mergeNegative dedups, keeps the first spelling and includes every entity negative', () => {
  const merged = mergeNegative(['subtitles', 'watermark'], [entity(), entity({ id: 'ent_2', name: 'Car', kind: 'vehicle', negative: 'photograph, flat single-colour paint' })], styleEntity());
  const items = merged.split(', ');
  assert.equal(items[0], 'subtitles');
  assert.equal(items[1], 'watermark');
  assert.deepEqual(items.slice(2, 5), ['realistic skin', 'photograph', 'different outfit']);
  assert.ok(items.includes('flat single-colour paint'));
  assert.ok(items.includes('photorealistic')); // from the style lock
  assert.equal(new Set(items.map((s) => s.toLowerCase())).size, items.length);
  assert.equal(items.indexOf('photograph'), 3); // first spelling kept, later duplicate dropped
  assert.equal(typeof mergeNegative([], [], null), 'string');
  assert.equal(mergeNegative(['a'], [], styleEntity()).startsWith('a, photorealistic'), true);
});

test('resolveEntities matches id, name and alias, refuses unknown, ambiguous and unapproved', () => {
  const lib = library({ entities: [entity(), styleEntity(), entity({ id: 'ent_2', name: 'Twin', aliases: ['the guy'] })] });
  assert.deepEqual(resolveEntities(lib, ['Rudy']).map((e) => e.id), ['ent_4b1e77aa']);
  assert.deepEqual(resolveEntities(lib, ['rudy']).map((e) => e.id), ['ent_4b1e77aa']); // case-insensitive
  assert.deepEqual(resolveEntities(lib, ['ent_4b1e77aa']).map((e) => e.name), ['Rudy']);
  assert.deepEqual(resolveEntities(lib, [{ entityId: 'ent_4b1e77aa' }]).map((e) => e.name), ['Rudy']);
  assert.deepEqual(resolveEntities(lib, ['Style lock']).map((e) => e.kind), ['style']);
  assert.throws(() => resolveEntities(lib, ['Nobody']), /Unknown entity "Nobody"/);
  assert.throws(() => resolveEntities(lib, ['the guy']), /ambiguous/i); // Rudy's alias and Twin's alias
  assert.throws(() => resolveEntities(lib, ['Rudy', 'rudy']), /twice|duplicate/i);
  const unapproved = library({ entities: [entity({ approvedAt: null, approvedBy: null })] });
  assert.throws(() => resolveEntities(unapproved, ['Rudy']), /not approved/i);
  assert.throws(() => resolveEntities(library({ entities: [] }), ['Rudy']), /Unknown entity/);
});

test('composePrompt inserts entity and style blocks byte-verbatim, in the fixed order', async () => {
  const lib = library();
  const shot = {
    scene: 4, durationS: 4,
    beat: 'Driving shot heading home in the Hellcat Widebody Red Eye',
    action: 'The Charger drives along a suburban road, the driver relaxed at the wheel.',
    motion: 'anticipation+timing-weight',
    setting: 'a quiet LA suburban street at warm late afternoon, palm trees, driveways',
    camera: { shotType: 'wide', moveId: 'tracking-glide' },
    entities: ['Rudy'],
    audio: 'a deep V8 exhaust note rising into a supercharger whine, tyres on asphalt',
  };
  const { parts, text, sha256 } = composePrompt(shot, lib, template);

  assert.deepEqual(parts.map((p) => `${p.kind}:${p.ref}`), [
    'base:shot', 'base:beat', 'base:action', 'base:motion', 'base:setting', 'base:camera',
    'entity:ent_4b1e77aa', 'style:ent_style1', 'base:audio', 'base:negative',
  ]);

  // The entity block is the exact string entityBlock returns, and it is inside the prompt as-is.
  const block = entityBlock(entity());
  assert.equal(parts[6].text, block.text);
  assert.equal(parts[6].sha256, block.sha256);
  assert.ok(text.includes(block.text));
  // The style lock is byte-identical to the canonical asset text (it contains its own newlines).
  assert.equal(parts[7].text, defaults.style.description);
  assert.ok(text.includes(defaults.style.description));

  // Section order is the design's order even though the labels differ from the template placeholders.
  const at = (s) => text.indexOf(s);
  for (const [a, b] of [['[SHOT 4 — 4s]', '"Driving shot'], ['"Driving shot', 'ACTION:'], ['ACTION:', 'MOTION:'],
    ['MOTION:', 'SETTING:'], ['SETTING:', 'CAMERA:'], ['CAMERA:', block.text], [block.text, defaults.style.description],
    [defaults.style.description, 'Audio:'], ['Audio:', 'Negative:']]) {
    assert.ok(at(a) >= 0 && at(b) > at(a), `expected ${JSON.stringify(a)} before ${JSON.stringify(b)} in:\n${text}`);
  }
  assert.match(text, /^\[SHOT 4 — 4s\]/);
  assert.ok(text.endsWith('\n') === false);
  assert.equal(/\n\n\n/.test(text), false);
  assert.equal(parts.every((p) => !/\s+$/.test(p.text) && !/^\s/.test(p.text)), true);
  assert.equal(sha256, sha256Hex(text));
});

test('composePrompt appends to a plain job prompt without touching its text', async () => {
  const lib = library();
  const { parts, text } = composePrompt({ prompt: 'she turns to face the camera', entities: ['Rudy'] }, lib, template);
  assert.deepEqual(parts.map((p) => p.kind), ['base', 'entity', 'style', 'base']);
  assert.equal(parts[0].text, 'she turns to face the camera'); // base text verbatim
  assert.equal(parts[0].ref, 'prompt');
  assert.ok(text.startsWith('she turns to face the camera\n\nCHARACTER — RUDY'));
  assert.match(text, /Negative: .*photorealistic/);
  assert.equal(text.includes('Audio:'), false); // no audio given: nothing invented
  assert.equal(text.includes('SETTING:'), false);
});

test('composePrompt emits a motion line from motion ids and a camera sentence from the libraries', () => {
  const { text } = composePrompt({
    scene: 1, durationS: 8, beat: 'the sprint', motion: 'anticipation+arcs',
    camera: { shotType: 'medium', moveId: 'dolly-in-push', note: 'keeping pace' }, entities: [],
  }, library(), template);
  assert.match(text, /MOTION: he tenses\/inhales briefly before… \/ the car dips slightly before the turn \/ the gang gathers its breath before the sprint; the motion travels in a smooth arc/);
  assert.match(text, /CAMERA: medium slow dolly-in to an extreme close-up, keeping pace/);
});

test('composePrompt refuses an unknown or unapproved entity instead of composing around it', () => {
  assert.throws(() => composePrompt({ prompt: 'x', entities: ['Nobody'] }, library(), template), /Unknown entity/);
  const lib = library({ entities: [entity({ approvedAt: null })] });
  assert.throws(() => composePrompt({ prompt: 'x', entities: ['Rudy'] }, lib, template), /not approved/i);
});

test('the base hash is stable and survives an appended consistency block', () => {
  const { parts } = composePrompt({ prompt: 'a fox', entities: ['Rudy'] }, library(), template);
  const base = promptBaseHash(parts);
  assert.equal(base, promptBaseHash(composePrompt({ prompt: 'a fox', entities: ['Rudy'] }, library(), template).parts));
  assert.notEqual(base, promptBaseHash(composePrompt({ prompt: 'a hare', entities: ['Rudy'] }, library(), template).parts));
  assert.notEqual(base, promptBaseHash(composePrompt({ prompt: 'a fox' }, library(), template).parts));

  const next = appendConsistencyBlock(parts, { id: 'car_two_tone', text: 'The car keeps its two-tone split: sand/champagne front, glossy chocolate rear.' });
  assert.equal(promptBaseHash(next), base); // sections 1-10 unchanged
  assert.equal(next.length, parts.length + 1);
  assert.equal(next.at(-1).kind, 'consistency');
  assert.equal(next.at(-1).ref, 'car_two_tone');
  assert.equal(next.at(-1).sha256, sha256Hex('The car keeps its two-tone split: sand/champagne front, glossy chocolate rear.'));
  assert.deepEqual(parts.map((p) => p.sha256), next.slice(0, parts.length).map((p) => p.sha256));
  assert.equal(parts.length, next.length - 1); // input not mutated
  const plain = appendConsistencyBlock(parts, 'a plain string block');
  assert.equal(promptBaseHash(plain), base); // still sections 1-10 only
  assert.equal(plain.at(-1).ref, 'consistency');
  assert.equal(plain.at(-1).text, 'a plain string block');
  // A second fix appends to the first: the base hash and every base part stay byte-identical, and
  // both blocks stay in order, so a job's whole fix history is auditable from the parts alone.
  const twice = appendConsistencyBlock(next, { id: 'second_fix', text: 'the location stays the quiet street' });
  assert.equal(promptBaseHash(twice), base);
  assert.deepEqual(twice.slice(0, parts.length), parts);
  assert.deepEqual(twice.slice(parts.length).map((p) => p.ref), ['car_two_tone', 'second_fix']);
  assert.deepEqual(next.map((p) => p.sha256), twice.slice(0, next.length).map((p) => p.sha256));
});

test('a ref is superseded as a new version, never by replacing it in place', () => {
  const before = entity();
  const next = supersedeRef(before, MEDIA1, 'flat bronze rear half', 1700);
  assert.equal(next.version, 2);
  assert.deepEqual(next.refs, []);
  assert.equal(next.primaryRefMediaId, null);
  assert.equal(next.history.length, 1);
  assert.deepEqual(next.history[0].refs, before.refs);
  assert.equal(next.history[0].version, 1);
  assert.equal(next.history[0].reason, 'flat bronze rear half');
  assert.equal(next.history[0].supersededAt, 1700);
  assert.deepEqual(before.refs.length, 1); // the input entity is untouched
  assert.throws(() => supersedeRef(before, 'not-a-media-id', 'x', 1), /no reference/i);
});

test('reviseEntity versions any change and keeps the old set in history', () => {
  const before = entity();
  const next = reviseEntity(before, { description: 'a taller man', refs: [...before.refs, { mediaId: MEDIA2, role: 'front', label: 'rudy_front', addedAt: 9 }] }, { reason: 'new front ref', by: 'cli', at: 42 });
  assert.equal(next.version, 2);
  assert.equal(next.description, 'a taller man');
  assert.equal(next.refs.length, 2);
  const entry = next.history[0];
  assert.equal(entry.version, 1);
  assert.deepEqual(entry.refs, before.refs);
  assert.equal(entry.description, before.description);
  assert.equal(entry.reason, 'new front ref');
  assert.equal(entry.by, 'cli');
  assert.equal(entry.supersededAt, 42);
  assert.equal(before.version, 1);
});

test('validateEntity and normalizeLibrary refuse malformed data instead of trusting it', () => {
  assert.doesNotThrow(() => validateEntity(entity()));
  assert.throws(() => validateEntity(entity({ name: '' })), /name/i);
  assert.throws(() => validateEntity(entity({ kind: 'ghost' })), /kind/i);
  assert.throws(() => validateEntity(entity({ refs: [{ mediaId: '/Users/me/front.png', role: 'front' }] })), /media id/i);
  assert.throws(() => validateEntity(entity({ refs: [{ mediaId: MEDIA1, role: 'toe' }] })), /role/i);
  assert.throws(() => validateEntity(entity({ description: '' })), /description/i);
  assert.throws(() => validateEntity(entity({ refs: [{ mediaId: MEDIA1, role: 'sheet' }, { mediaId: MEDIA1, role: 'front' }] })), /twice|duplicate/i);
  assert.deepEqual(ROLES.character.includes('sheet'), true);
  assert.deepEqual(KINDS, ['character', 'product', 'vehicle', 'location', 'style']);

  const lib = normalizeLibrary({ schema: 1, projectId: 'p1', styleId: null, entities: [entity()] }, 'p1');
  assert.equal(lib.entities.length, 1);
  assert.throws(() => normalizeLibrary({ entities: [{ name: 'no id' }] }, 'p1'), /id/i);
  assert.throws(() => normalizeLibrary({ entities: 'nope' }, 'p1'), /entities/i);
  assert.deepEqual(emptyLibrary('p9'), { schema: 1, projectId: 'p9', styleId: null, entities: [], updatedAt: 0 });
});

test('the entity store keeps a per-project library, versions changes and survives a restart', async () => {
  const area = memoryArea();
  let at = 100;
  let n = 0;
  const store = createEntityStore(area, { now: () => at, newId: () => `ent_new000${++n}` });
  assert.deepEqual(await store.list('p1'), []);

  const made = await store.upsert('p1', { kind: 'character', name: 'Rudy', description: 'a heavyset man', negative: 'realistic skin', refs: [{ mediaId: MEDIA1, role: 'sheet', label: 'rudy_sheet_v1' }] });
  assert.equal(made.id, 'ent_new0001');
  assert.equal(made.version, 1);
  assert.equal(made.approvedAt, null);
  assert.equal(made.primaryRefMediaId, MEDIA1);
  assert.equal(made.refs[0].addedAt, 100);

  const approved = await store.approve('p1', 'Rudy', { by: 'dashboard' });
  assert.equal(approved.approvedAt, 100);
  assert.equal(approved.approvedBy, 'dashboard');

  at = 200;
  const revised = await store.upsert('p1', { id: made.id, description: 'a taller heavyset man' });
  assert.equal(revised.version, 2);
  assert.equal(revised.description, 'a taller heavyset man');
  assert.equal(revised.approvedAt, 100); // approval survives a revision
  assert.equal(revised.history.length, 1);
  assert.equal((await store.get('p1', 'Rudy')).description, 'a taller heavyset man');
  assert.equal((await store.get('p1', made.id)).version, 2);
  assert.equal(await store.get('p1', 'Nobody'), null);

  await store.setStyle('p1', { name: 'Style lock', description: defaults.style.description, negative: defaults.style.negative.join(', ') });
  const lib = await store.library('p1');
  assert.equal(lib.styleId, (await store.get('p1', 'Style lock')).id);
  assert.equal(lib.entities.filter((e) => e.kind === 'style').length, 1);

  const reopened = createEntityStore(area); // service worker restarted
  assert.equal((await reopened.library('p1')).entities.length, 2);
  assert.deepEqual((await reopened.list('p2')), []); // projects are separate

  await reopened.remove('p1', 'Rudy');
  assert.equal(await reopened.get('p1', 'Rudy'), null);
});

test('the entity store refuses a duplicate name, a duplicate label and a bad media id', async () => {
  const store = createEntityStore(memoryArea(), { now: () => 1, newId: (() => { let n = 0; return () => `ent_${++n}`; })() });
  await store.upsert('p1', { kind: 'character', name: 'Rudy', description: 'a man', refs: [{ mediaId: MEDIA1, role: 'sheet', label: 'rudy_sheet_v1' }] });
  await assert.rejects(() => store.upsert('p1', { kind: 'vehicle', name: 'rudy', description: 'a car' }), /already in this project/i);
  await assert.rejects(() => store.upsert('p1', { kind: 'vehicle', name: 'Hellcat', description: 'a car', refs: [{ mediaId: MEDIA2, role: 'side', label: 'rudy_sheet_v1' }] }), /label/i);
  await assert.rejects(() => store.upsert('p1', { kind: 'vehicle', name: 'Hellcat', description: 'a car', refs: [{ mediaId: '/tmp/x.png', role: 'side' }] }), /media id/i);
  await assert.rejects(() => store.approve('p1', 'Nobody'), /Unknown entity/);
});

test('import and export round-trip a library; merge adds unknown entities and keeps local ones', async () => {
  const area = memoryArea();
  const store = createEntityStore(area, { now: () => 5, newId: (() => { let n = 0; return () => `ent_${++n}`; })() });
  await store.upsert('p1', { kind: 'character', name: 'Rudy', description: 'a man', refs: [{ mediaId: MEDIA1, role: 'sheet', label: 'rudy' }] });
  const exported = await store.exportLibrary('p1');
  assert.equal(exported.schema, 1);
  assert.equal(exported.projectId, 'p1');

  const other = createEntityStore(memoryArea(), { now: () => 5, newId: () => 'ent_other1' });
  await other.importLibrary('p1', exported);
  assert.equal((await other.get('p1', 'Rudy')).description, 'a man');
  assert.deepEqual(await other.exportLibrary('p1'), exported);

  const incoming = { schema: 1, projectId: 'p1', styleId: null, entities: [entity({ id: 'ent_in1', name: 'Hellcat', kind: 'vehicle', description: 'a widebody Charger' })] };
  await other.importLibrary('p1', incoming, { mode: 'merge' });
  assert.deepEqual((await other.list('p1')).map((e) => e.name), ['Rudy', 'Hellcat']);
  await other.importLibrary('p1', incoming, { mode: 'replace' });
  assert.deepEqual((await other.list('p1')).map((e) => e.name), ['Hellcat']);
  await assert.rejects(() => other.importLibrary('p1', { entities: 'nope' }), /entities/i);
  await assert.rejects(() => other.importLibrary('p1', incoming, { mode: 'wat' }), /mode/i);
});

test('every write mirrors the library through the onChange hook', async () => {
  const seen = [];
  const store = createEntityStore(memoryArea(), { now: () => 7, newId: () => 'ent_x', onChange: (lib) => seen.push(lib.entities.length) });
  await store.upsert('p1', { kind: 'character', name: 'Rudy', description: 'a man' });
  await store.approve('p1', 'Rudy');
  assert.deepEqual(seen, [1, 1]);
});

test('libraryWarnings reports what the library cannot do yet, without blocking anything', () => {
  assert.deepEqual(libraryWarnings(library()), []);
  const bare = library({
    styleId: null,
    entities: [
      entity(),
      entity({ id: 'ent_2', name: 'Hellcat', kind: 'vehicle', refs: [{ mediaId: MEDIA2, role: 'side', label: 'rudy_sheet_v1' }] }),
      entity({ id: 'ent_3', name: 'Lake', kind: 'location', refs: [], primaryRefMediaId: null }),
    ],
  });
  const warnings = libraryWarnings(bare);
  assert.ok(warnings.some((w) => /Lake has no locked reference/.test(w)));
  assert.ok(warnings.some((w) => /label "rudy_sheet_v1" is used by Rudy and Hellcat/.test(w)));
  assert.ok(warnings.some((w) => /No style entity/.test(w)));
});

test('validateTemplate reports missing sections and impossible durations; the default is clean', () => {
  assert.deepEqual(validateTemplate(template), []);
  assert.deepEqual(validateTemplate(DEFAULT_TEMPLATE), []);
  const problems = validateTemplate({ ...template, sections: ['shot', 'beat'], allowedDurationsS: [5] });
  assert.ok(problems.some((p) => /section/i.test(p)));
  assert.ok(problems.some((p) => /duration/i.test(p)));
  assert.ok(validateTemplate({ ...template, audioLine: '' }).some((p) => /audio/i.test(p)));
  assert.ok(validateTemplate({ ...template, cameraLibrary: 'x' }).some((p) => /camera/i.test(p)));
});

test('the template store keeps a project override over the defaults and refuses a bad template', async () => {
  const area = memoryArea();
  const store = createTemplateStore(area, { defaults: template, now: () => 3 });
  const fresh = await store.get('p1');
  assert.deepEqual(fresh.sections, template.sections);
  await store.set('p1', { ...template, durationS: 8, cameraLibrary: template.cameraLibrary.slice(0, 3) });
  const edited = await store.get('p1');
  assert.equal(edited.durationS, 8);
  assert.equal(edited.cameraLibrary.length, 3);
  assert.equal((await store.get('p2')).durationS, 4); // other projects keep the default
  await assert.rejects(() => store.set('p1', { ...template, sections: [] }), /section/i);
  await store.reset('p1');
  assert.equal((await store.get('p1')).durationS, 4);
});
