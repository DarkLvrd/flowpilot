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
      if (fail) return { ok: false, error: fail };
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
