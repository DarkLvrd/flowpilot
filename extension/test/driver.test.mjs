// The work-tab driver's asset-picker close path (BUG-5). `content/driver.js` is a classic content
// script — it cannot import from lib/ — so it is loaded here as it really runs, into a minimal fake
// DOM that models the two shapes the live page has (recon/FINDINGS.md "Closing the picker",
// 2026-10-03):
//   * the Frames picker (`flow-add-menu-popover-content`): its own `Close` button closes it and a
//     backdrop click does nothing;
//   * the Ingredients picker: no close control at all, dismissed by the composer's own
//     "Add ingredients" button.
// Nothing here spends anything; the point is that a failed attach cannot leave the picker open over
// the composer, which is what made the *next* prepare die with "Settings trigger is not clickable".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../content/driver.js'), 'utf8');

class FakeEl {
  constructor(tag, { attrs = {}, text = '', classes = [], rect = { left: 0, top: 0, width: 10, height: 10 } } = {}) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.ownText = text;
    this.classes = classes;
    this.rect = rect;
    this.children = [];
    this.parent = null;
    this.hidden = false;
    this.onclick = null;
    this.clicks = 0;
  }

  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  remove() { this.parent?.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get parentElement() { return this.parent; }
  get offsetParent() { return this.hidden || !this.parent ? null : this.parent; }
  get disabled() { return this.attrs.disabled === true; }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  getBoundingClientRect() { return { ...this.rect, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
  contains(el) { return el === this || this.descendants().includes(el); }
  // visibleText() reads a copy with its mat-icon ligatures removed; the original must not change.
  cloneNode() {
    const copy = new FakeEl(this.tagName, { attrs: { ...this.attrs }, text: this.ownText, classes: [...this.classes], rect: { ...this.rect } });
    copy.hidden = this.hidden;
    copy.append(...this.children.map((c) => c.cloneNode(true)));
    return copy;
  }
  closest(sel) { let el = this; while (el) { if (el.matches(sel)) return el; el = el.parent; } return null; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = value; }
  click() { this.clicks++; this.onclick?.(this); }

  matches(selector) {
    return selector.split(',').map((s) => s.trim()).some((one) => this.matchOne(one));
  }

  matchOne(one) {
    if (one.startsWith('.')) return this.classes.includes(one.slice(1));
    const attr = one.match(/^\[([\w-]+)(?:=['"]?([^\]'"]*)['"]?)?\]$/);
    if (attr) return attr[2] === undefined ? this.attrs[attr[1]] != null : this.attrs[attr[1]] === attr[2];
    return this.tagName === one.toUpperCase();
  }

  querySelectorAll(selector) { return this.descendants().filter((el) => el.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

// The driver's own view of the page: the body, and whatever overlays are open on it. Every element
// keeps a rect, so `elementFromPoint` can say what really covers a click — the whole reason an open
// picker made the composer's settings trigger unclickable.
function page() {
  const body = new FakeEl('body');
  const document = {
    body,
    _els: [body],
    querySelectorAll(selector) { return body.querySelectorAll(selector); },
    querySelector(selector) { return body.querySelector(selector); },
    elementFromPoint(x, y) {
      const hit = body.descendants().filter((el) => el.offsetParent !== null)
        .filter((el) => x >= el.rect.left && x <= el.rect.left + el.rect.width && y >= el.rect.top && y <= el.rect.top + el.rect.height);
      return hit.at(-1) ?? null; // last in document order is the topmost
    },
  };
  const sandbox = {
    document,
    location: { origin: 'https://flow.google.com', pathname: '/project/x' },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    // The close path waits on the DOM with a real timeout as its ceiling; a test wants that ceiling
    // reached at once, not in three seconds.
    setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms ?? 0, 5)),
    clearTimeout,
    CSS: { escape: (s) => s },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    DataTransfer: class { constructor() { this.items = { add() {} }; } },
    Event: class {},
    File: class {},
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'content/driver.js' });
  return { document, body, driver: sandbox.__flowPilotDriver, el: (tag, opts) => new FakeEl(tag, opts) };
}

// The composer with its own controls, plus an open picker overlay. `closeControl` and `backdrop` are
// each 'closes' (its click dismisses the picker), 'inert' (the click lands but does nothing, which is
// what the live Frames picker's backdrop really did) or null (not there at all). `triggerCloses` is
// how the Ingredients picker is dismissed: by the composer's own button.
function composerWithPicker({ closeControl = null, backdrop = null, triggerCloses = false, coveringBackdrop = false, backdropRect = { left: 200, top: 200, width: 100, height: 100 } } = {}) {
  const p = page();
  const { body, el } = p;
  const composer = el('flow-base-prompt-box', { rect: { left: 0, top: 0, width: 100, height: 100 } });
  const trigger = el('button', { attrs: { 'aria-label': 'Add ingredients to the prompt box' }, rect: { left: 0, top: 0, width: 20, height: 20 } });
  composer.append(trigger);
  body.append(composer);

  const pane = el('div', { classes: ['cdk-overlay-pane'], rect: { left: 200, top: 200, width: 100, height: 100 } });
  const backdropEl = backdrop ? el('div', { classes: ['cdk-overlay-backdrop'], rect: coveringBackdrop ? { left: 0, top: 0, width: 400, height: 400 } : backdropRect }) : null;
  const close = closeControl ? el('button', { attrs: { 'aria-label': 'Close' }, rect: { left: 200, top: 200, width: 20, height: 20 } }) : null;
  const tile = el('button', { rect: { left: 220, top: 220, width: 20, height: 20 } });
  pane.append(...[close, tile].filter(Boolean));
  body.append(...[backdropEl, pane].filter(Boolean));

  const closed = () => { pane.remove(); backdropEl?.remove(); };
  if (closeControl === 'closes') close.onclick = closed;
  if (backdrop === 'closes') backdropEl.onclick = closed;
  if (triggerCloses) trigger.onclick = closed;
  // A picker can also start closed and be opened by a control on the page (the Frames start slot).
  const setOpen = (open) => { pane.hidden = !open; if (backdropEl) backdropEl.hidden = !open; };
  return { ...p, composer, trigger, pane, backdrop: backdropEl, close, tile, closed, setOpen };
}

test('the Frames picker is closed by its own close control, where a backdrop click does nothing', async () => {
  const p = composerWithPicker({ closeControl: 'closes', backdrop: 'inert', coveringBackdrop: true });
  // It starts wedged exactly like the live page: the backdrop covers the composer's trigger.
  const t = p.trigger.getBoundingClientRect();
  assert.notEqual(p.document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2), p.trigger);
  await p.driver.closePicker();
  assert.equal(p.pane.parent, null);
  assert.equal(p.close.clicks, 1);
  // And the next attempt finds the trigger clickable again — the next prepare is not wedged.
  assert.equal(p.document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2), p.trigger);
  await p.driver.closePicker(); // already closed: no-op, no throw
  assert.equal(p.close.clicks, 1);
});

test('the Ingredients picker, which has no close control, is dismissed by the composer trigger', async () => {
  const p = composerWithPicker({ triggerCloses: true });
  await p.driver.closePicker();
  assert.equal(p.pane.parent, null);
  assert.equal(p.trigger.clicks, 1);
  assert.equal(p.close, null);
});

test('a backdrop click is tried when the picker has no close control of its own', async () => {
  const p = composerWithPicker({ backdrop: 'closes', triggerCloses: true, backdropRect: { left: 400, top: 400, width: 100, height: 100 } });
  await p.driver.closePicker();
  assert.equal(p.pane.parent, null);
  assert.equal(p.trigger.clicks, 0); // the backdrop did it, before the trigger was ever tried
});

test('a picker that will not close is a loud error, not a wedged composer', async () => {
  const p = composerWithPicker({ closeControl: 'inert', backdrop: 'inert', coveringBackdrop: true });
  await assert.rejects(() => p.driver.closePicker(), /picker would not close/i);
  // The message says what was tried and what to do, so a failing job reads as this and not as
  // "Settings trigger is not clickable" three steps later.
  await assert.rejects(() => p.driver.closePicker(), /close control, the backdrop and the ingredients button/i);
  assert.equal(p.pane.parent, p.body); // the picker is still there: nothing was silently swallowed
});

// The failure this whole path exists for (BUG-5): an attach that fails mid-way used to leave the
// Frames picker open over the composer, and the *next* prepare then died with "Settings trigger is
// not clickable". `prepare` starts with this same routine, so a trigger that reports clickable here
// is what the next attempt really sees.
const ID = 'ffffffff-0000-4000-8000-000000000006';

test('a failed attach closes the picker it opened, so the next prepare finds the trigger clickable', async () => {
  const p = composerWithPicker({ closeControl: 'closes' });
  const start = p.el('button', { text: 'Start', rect: { left: 0, top: 40, width: 20, height: 20 } });
  start.onclick = () => p.setOpen(true);
  p.composer.append(start);
  p.pane.hidden = true; // the picker is not open until the frame slot is clicked
  p.tile.ownText = 'Person standing on rooftop balcony';
  p.tile.onclick = () => {}; // the tile click lands, but the media never appears attached
  await assert.rejects(
    () => p.driver.attachReferences('frames', { firstFrame: ID, names: { [ID]: ['Person standing on rooftop balcony'] } }),
    /appear attached/i,
  );
  assert.equal(p.close.clicks, 1); // what the failed attach opened, it closed
  const t = p.trigger.getBoundingClientRect();
  assert.equal(p.document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2), p.trigger);
});
