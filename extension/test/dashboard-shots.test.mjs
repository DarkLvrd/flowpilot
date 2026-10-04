// The Shots panel's still cell draws a thumbnail from a read (`stillThumb`) that resolves later.
// The card used to append the async function's return value straight into the DOM, so an approved
// still rendered the literal text `[object Promise]` where its picture belongs (report §10 fault C).
// This is the DOM-less harness dashboard-review.test.mjs uses, with `append` behaving like the
// browser's: a non-node argument is stringified, which is what made the promise visible on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const node = (tag = '') => ({
  tag, children: [], style: {}, hidden: false, value: '', checked: false, disabled: false,
  textContent: undefined, placeholder: undefined, files: [],
  append(...c) {
    for (const child of c.flat()) {
      this.children.push(child != null && typeof child === 'object' && 'tag' in child ? child : textNode(String(child)));
    }
  },
  replaceChildren(...c) { this.children = []; this.append(...c); },
  addEventListener() {}, click() {},
});
const textNode = (t) => { const n = node('#text'); n.textContent = t; return n; };
globalThis.document = { createElement: (tag) => node(tag) };

let send;
globalThis.chrome = { runtime: { sendMessage: (msg) => send(msg) } };

const { createShotsPanel } = await import('../dashboard/shots.js');

const walk = (n) => [n, ...(n.children ?? []).flatMap(walk)];
const find = (root, pred) => walk(root).filter(pred);
const text = (n) => [n.textContent ?? '', ...(n.children ?? []).map(text)].join(' ');
// The panel loads, renders, then the thumbnail read lands: two store reads, each its own turn.
const settle = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };

const MEDIA = '72b2d6a5-8285-4189-9c24-90e03be0440b';
const THUMB = `https://flow-content.google/image/${MEDIA}`;
const shot = (over = {}) => ({
  id: 'shot_shot_1_rooftop-2', scene: 1, mode: 'frames', entities: [],
  still: { jobId: 'e327fb4f-0000-4000-8000-000000000000', mediaId: MEDIA },
  stillJob: { id: 'e327fb4f-0000-4000-8000-000000000000', state: 'done', mediaId: MEDIA },
  gate: { ok: true, start: { mediaId: MEDIA }, problems: [] },
  videoJob: { id: 'v1', state: 'queued', prompt: 'a rooftop' }, videoCost: 4,
  ...over,
});

const render = async (root, shots, thumb = { ok: true, value: { url: THUMB } }) => {
  const reads = [];
  send = async (msg) => {
    if (msg.cmd === 'shots') return { ok: true, value: { projectId: 'p1', shots } };
    if (msg.cmd === 'stillThumb') { reads.push(msg.mediaId); return thumb; }
    throw new Error(`unexpected command ${msg.cmd}`);
  };
  createShotsPanel(root).render('p1');
  await settle();
  return reads;
};

test('an approved still draws its thumbnail, never the promise\'s string', async () => {
  const root = node();
  const reads = await render(root, [shot()]);
  const imgs = find(root, (n) => n.tag === 'img');
  assert.equal(imgs.length, 1, 'the still cell holds the thumbnail image');
  assert.equal(imgs[0].src, THUMB);
  assert.equal(imgs[0].alt, `still ${MEDIA}`);
  assert.deepEqual(reads, [MEDIA], 'one read of the still\'s signed URL');
  assert.equal(find(root, (n) => n.textContent === '[object Promise]').length, 0);
  assert.ok(!text(root).includes('[object Promise]'), `the card still shows a promise: ${text(root)}`);
  assert.ok(!text(root).includes(MEDIA), 'the media id text is replaced by the picture once it resolves');
});

test('the cell shows the media id while the read is still in flight, then the picture', async () => {
  const root = node();
  const pending = 'aaaa1111-0000-4000-8000-000000000000';
  const pendingUrl = `https://flow-content.google/image/${pending}`;
  let release;
  send = async (msg) => {
    if (msg.cmd === 'shots') return { ok: true, value: { projectId: 'p1', shots: [shot({ still: { jobId: 'j2', mediaId: pending }, gate: { ok: true, problems: [] } })] } };
    if (msg.cmd === 'stillThumb') return new Promise((r) => { release = () => r({ ok: true, value: { url: pendingUrl } }); });
    throw new Error(`unexpected command ${msg.cmd}`);
  };
  createShotsPanel(root).render('p1');
  await settle();
  assert.equal(find(root, (n) => n.tag === 'img').length, 0, 'no picture before the read lands');
  assert.ok(text(root).includes(pending), 'the media id is the honest placeholder');
  release();
  await settle();
  const imgs = find(root, (n) => n.tag === 'img');
  assert.equal(imgs.length, 1, 'the picture lands when the read does');
  assert.equal(imgs[0].src, pendingUrl);
  assert.ok(!text(root).includes('[object Promise]'));
});

test('a read that fails leaves the media id text instead of a broken row', async () => {
  const other = 'b1241524-0000-4000-8000-000000000000';
  const root = node();
  const reads = await render(root, [shot({
    still: { jobId: 'j3', mediaId: other },
    gate: { ok: true, problems: [] },
  })], { ok: false, error: 'HTR…: HTTP 429' });
  assert.deepEqual(reads, [other]);
  assert.equal(find(root, (n) => n.tag === 'img').length, 0);
  assert.ok(text(root).includes(other), 'the id text stays');
  assert.ok(!text(root).includes('[object Promise]'));
  assert.match(text(root), /anchored to the approved still/, 'the rest of the card still renders');
});
