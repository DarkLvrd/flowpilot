// The dashboard's Entities panel builds its cards in a DOM-less environment here: this checks the
// panel renders a card with the entity's block verbatim, that "Uses: …" resolves ids to names, and
// that a missing work tab is reported instead of throwing.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PID = '7bcd806e-da37-4ada-aa6a-10fb4ffe7efb';
const MEDIA = 'bc92bce2-2183-4ab2-80f6-d5aead42857a';

const node = () => ({
  children: [], style: {}, hidden: false, files: [], value: '', checked: false, colSpan: 0,
  append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; },
  addEventListener() {}, click() {}, reset() {},
});
const text = (n) => [n.textContent ?? '', ...(n.children ?? []).map(text)].join(' ');

let asked = 0;
let fail = null; // when set, the service worker answers like a failed command
const sent = [];
const CHAR = '0bfec740-409e-42f5-80d1-82baac3349f3';
const CHAR_IMAGE = 'b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca';
const CHAR_REF = 'e3696fd0-eb73-4b82-a8a2-096fa4cb0dde';
let charList = []; // what Flow itself holds for this project (most projects: none)
let charFail = null; // when set, only the read-only characters call fails
const library = {
  schema: 1, projectId: PID, styleId: null, updatedAt: 1,
  entities: [{
    id: 'ent_4b1e77aa', kind: 'character', name: 'Rudy', aliases: [], orientation: 'portrait',
    description: 'CHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.',
    negative: 'realistic skin', refs: [{ mediaId: MEDIA, role: 'sheet', label: 'rudy_sheet_v1', addedAt: 1 }],
    primaryRefMediaId: MEDIA, sourcePhoto: null, version: 2, history: [{ version: 1, reason: 'flat bronze', supersededAt: 5 }],
    approvedAt: 1, approvedBy: 'dashboard',
  }],
};

globalThis.document = { createElement: () => node() };
globalThis.URL.createObjectURL ??= () => 'blob:x';
globalThis.URL.revokeObjectURL ??= () => {};
globalThis.chrome = {
  storage: { onChanged: { addListener() {} } },
  runtime: {
    async sendMessage(msg) {
      asked++;
      sent.push(msg);
      if (fail) return { ok: false, error: fail };
      if (msg.cmd === 'characters') {
        if (charFail) return { ok: false, error: charFail };
        return { ok: true, value: { projectId: msg.projectId ?? PID, characters: charList } };
      }
      if (msg.cmd === 'entityUpsert') return { ok: true, value: { id: 'ent_new', name: msg.entity.name } };
      if (msg.cmd !== 'entities') throw new Error(`unexpected command ${msg.cmd}`);
      return { ok: true, value: { projectId: msg.projectId ?? PID, library, template: null, style: {}, warnings: ['No style entity yet'] } };
    },
  },
};

const { entityNames, createEntitiesPanel } = await import('../dashboard/entities.js');

test('entityNames turns a job\'s entity ids into names and caches the library', async () => {
  assert.deepEqual(await entityNames(PID, []), []);
  assert.deepEqual(await entityNames(PID, [{ entityId: 'ent_4b1e77aa' }, { entityId: 'ent_gone' }]), ['Rudy', 'ent_gone']);
  const before = asked;
  await entityNames(PID, [{ entityId: 'ent_4b1e77aa' }]);
  assert.equal(asked, before); // served from the cache: a queue render does not re-ask per job

  // A library that cannot be read never hides the queue: the row falls back to the ids.
  fail = 'No work tab: open a Flow project in the tab you bound, or pass a project id';
  // A project never seen before, so the cache cannot answer for it.
  assert.deepEqual(await entityNames('11111111-2222-3333-4444-555555555555', [{ entityId: 'ent_4b1e77aa' }]), ['ent_4b1e77aa']);
  fail = null;
});

test('the panel renders a card with the canonical block verbatim and the library warnings', async () => {
  const root = node();
  const panel = createEntitiesPanel(root);
  panel.render(PID);
  await new Promise((r) => setTimeout(r, 0));
  const rendered = text(root);
  assert.ok(rendered.includes('Rudy'), rendered.slice(0, 200));
  assert.ok(rendered.includes('CHARACTER — RUDY (identical in every shot): a heavyset man in a black tee.'));
  assert.ok(rendered.includes('rudy_sheet_v1'));
  assert.ok(rendered.includes(`✅ approved (v2)`));
  assert.ok(rendered.includes('⚠️ No style entity yet'));
  assert.ok(rendered.includes('Supersede…'));
  assert.ok(rendered.includes('Add entity'));
});

// Report §8.1 step 2: the panel shows what Flow itself holds and links it. The entity id is what
// the job and the QC record verify, so the link is made from the read, not typed in by hand.
test('the panel lists the project\'s Flow Characters and links one to a library entity', async () => {
  sent.length = 0;
  charList = [{ entityId: CHAR, projectId: PID, name: 'nancy', primaryMediaId: CHAR_IMAGE, referenceWorkflowIds: [CHAR_REF] }];
  const root = node();
  const panel = createEntitiesPanel(root);
  panel.render(PID);
  await new Promise((r) => setTimeout(r, 0));
  const rendered = text(root);
  assert.match(rendered, /Flow Characters in this project \(1\)/);
  assert.match(rendered, /nancy/);
  assert.match(rendered, new RegExp(CHAR));
  assert.match(rendered, /1 reference workflow/);
  // One click links it: the upsert carries the whole link, never just the name.
  const walk = (n) => [n, ...(n.children ?? []).filter((c) => typeof c === 'object').flatMap(walk)];
  const link = walk(root).find((n) => n.textContent === 'Add to the library');
  assert.ok(link, 'the link button is offered for an unlinked character');
  await link.onclick();
  const upsert = sent.find((m) => m.cmd === 'entityUpsert');
  assert.equal(upsert.entity.kind, 'character');
  assert.deepEqual(upsert.entity.flowCharacter, { name: 'nancy', entityId: CHAR, primaryMediaId: CHAR_IMAGE, referenceWorkflowIds: [CHAR_REF] });
  assert.match(upsert.entity.description, /Flow Character/);
  charList = [];
});

// A character read that fails must not hide the library, and a project with none says so plainly.
test('a failed character read is reported without hiding the library', async () => {
  const root = node();
  const panel = createEntitiesPanel(root);
  charList = [];
  charFail = 'No work tab: open a Flow project in the tab you bound, or pass a project id';
  panel.render(PID);
  await new Promise((r) => setTimeout(r, 0));
  const rendered = text(root);
  assert.match(rendered, /Flow Characters could not be read/);
  assert.match(rendered, /CHARACTER — RUDY/); // the library still renders
  charFail = null;
});

test('with no work tab and no project the panel reports what to do instead of throwing', async () => {
  fail = 'No work tab: open a Flow project in the tab you bound, or pass a project id';
  const root = node();
  const panel = createEntitiesPanel(root);
  panel.render(null);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(text(root), /No work tab: open a Flow project/);
  assert.match(text(root), /Use project/); // the project box is still there to type one in
  fail = null;
});
