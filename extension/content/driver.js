// Flow Pilot work-tab driver: a classic content script on flow.google.com (isolated world).
// It finds Flow's own controls by accessible name, fills the prompt in one go, sets the mode
// radios, reads back what the page shows, and clicks Flow's own Generate button. It never
// touches reCAPTCHA (including the hidden g-recaptcha-response textarea), cookies or tokens.
// No fixed sleeps: every wait is a MutationObserver on the real DOM, with a timeout as a ceiling.

(() => {
  if (globalThis.__flowPilotDriver) return; // already injected

  const NAMES = {
    generate: 'Start generation',
    settings: 'Settings trigger',
    ingredients: 'Add ingredients to the prompt box',
    account: 'Account details',
    model: 'Select model family',
  };
  const BLOCK_TEXT = /unusual activity|UNUSUAL_ACTIVITY|temporarily blocked/i;
  // A media tile/chip shows its id in its thumbnail URL (recon 2026-10-01); this is how references
  // are found in the picker and read back from the composer — the grid has no data-media-id (#14).
  const CONTENT_ID = /flow-content\.google\/(?:image|video)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const UPLOAD_TOOLTIP = 'Upload media';
  const ADD_TO_PROMPT = /^add to prompt$/i;
  const FRAME_SLOT = { firstFrame: 'Start', lastFrame: 'End' };
  // Reference tiles and attached thumbnails can take a few seconds to render (a fresh upload, or a
  // virtual-scroller picker); one budget for finding a tile and for reading the attach back.
  const ATTACH_WAIT_MS = 15_000;

  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  // Material icons are ligature words in the text ("videocam", "crop_16_9"); accessible names skip them.
  const visibleText = (el) => {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('mat-icon').forEach((icon) => icon.remove());
    return text(copy);
  };

  function labelOf(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
    const label = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    return visibleText(label) || visibleText(el);
  }

  // Flow's Agent panel has its own prompt box and its own "Start generation" button; anything
  // typed or clicked there goes to the Agent chat. The driver only ever uses the main composer.
  const AGENT_PANEL = 'flow-agent-panel, flow-creative-agent-prompt-box';
  const inAgentPanel = (el) => !!el?.closest(AGENT_PANEL);
  const agentPanelOpen = () => !!document.querySelector(AGENT_PANEL);

  const composer = () => $$('flow-base-prompt-box').find((b) => !inAgentPanel(b)) || null;
  const editor = () => composer()?.querySelector('flow-rich-text-editor .ProseMirror[contenteditable=true]') || null;
  // Composer controls are looked up inside the main composer; header controls anywhere outside the Agent panel.
  const button = (name, root = document) => $$('button, [role=button]', root)
    .find((b) => b.getAttribute('aria-label') === name && !inAgentPanel(b));
  const composerButton = (name) => (composer() ? button(name, composer()) : null);
  const agentButton = () => $$('button').find((b) => !b.getAttribute('aria-label') && text(b) === 'Agent' && !inAgentPanel(b));

  function radios() {
    return $$('[role=radio], input[type=radio]').map((el) => ({
      el,
      name: labelOf(el),
      checked: el.getAttribute('aria-checked') === 'true' || el.checked === true,
    }));
  }
  // Radio names can carry a description ("360p 360p generates faster…"), so match the first word(s).
  const radio = (want) => radios().find((r) => r.name === want || r.name.startsWith(`${want} `));

  // Reads the prompt back the way it was written: paragraphs and hard breaks are both line breaks.
  // A multi-line paste lands as one <p> with <br> between lines, not one <p> per line.
  // ProseMirror's trailing <br> (an empty line's placeholder) is not text.
  function promptText() {
    const ed = editor();
    if (!ed) return null;
    const read = (node) => [...node.childNodes].map((n) => {
      if (n.nodeType === Node.TEXT_NODE) return n.data;
      if (n.nodeName === 'BR') return n.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
      return n.nodeType === Node.ELEMENT_NODE ? read(n) : '';
    }).join('');
    return $$(':scope > p', ed).map(read).join('\n');
  }

  function costText() {
    const hit = $$('body *').find((el) => el.children.length < 4 && /^Generating will use\s+\d+\s+credits?/i.test(text(el)));
    return hit ? text(hit) : null;
  }

  function overlayOpen() {
    // Dialogs and menus over the page; the settings panel (it holds the mode radios) doesn't count.
    return $$('[role=dialog], [role=alertdialog], [role=menu]').some((el) => el.offsetParent !== null && !el.querySelector('[role=radio]'));
  }

  function blockedText() {
    const hit = $$('[role=alert], [aria-live], snack-bar-container, .mat-mdc-snack-bar-label').map(text).find((t) => BLOCK_TEXT.test(t));
    return hit || null;
  }

  function waitFor(check, { timeoutMs = 10_000, what = 'page change' } = {}) {
    return new Promise((resolve, reject) => {
      const now = check();
      if (now) return resolve(now);
      const obs = new MutationObserver(() => {
        const v = check();
        if (v) { cleanup(); resolve(v); }
      });
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${what}`)); }, timeoutMs);
      const cleanup = () => { obs.disconnect(); clearTimeout(timer); };
      obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  }

  // Not covered by an overlay: the element at its centre is the element or inside it.
  function clickable(el) {
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!top && (top === el || el.contains(top));
  }

  function selfCheck() {
    const summary = composerButton(NAMES.settings);
    const checks = [
      ['Agent mode off', !agentPanelOpen()],
      ['Prompt box', !!editor()],
      ['Start generation button', !!composerButton(NAMES.generate)],
      ['Settings trigger', !!summary],
      ['Settings summary readable', !!summary && /^(Video|Image)\b/.test(text(summary))],
      ['Add ingredients button', !!composerButton(NAMES.ingredients)],
      ['Agent toggle', !!agentButton()],
      ['Account details', !!button(NAMES.account)],
      ['On a project page', /^\/project\/[0-9a-f-]{36}$/.test(location.pathname)],
    ];
    return checks.map(([name, ok]) => ({ name, ok }));
  }

  // ---- References: the asset picker, uploads and attach (recon 2026-10-01) ------------------

  // The open asset picker (a CDK overlay), or null. The settings panel is not an overlay here.
  const picker = () => $$('.cdk-overlay-pane').find((el) => el.offsetParent !== null && el.querySelector('button, [role=button]')) || null;
  // The media id in an <img>/<video> thumbnail, or null.
  const contentId = (el) => (el?.getAttribute('src') || el?.src || '').match(CONTENT_ID)?.[1] ?? null;
  const promptBox = () => composer()?.closest('flow-prompt-box') || composer()?.parentElement || null;

  // The media ids attached in the composer, scoped to the prompt box's ingredient bar so the
  // project-media grid's own thumbnails are never mistaken for attachments. In Frames mode the two
  // slots (Start, End) sit in DOM order, so the first id is the first frame and the second the last.
  function attachedIdsNow() {
    const bar = promptBox()?.querySelector('flow-ingredient-bar') || promptBox();
    return bar ? [...new Set($$('img, video', bar).map(contentId).filter(Boolean))] : [];
  }
  function readAttached(input) {
    const ids = attachedIdsNow();
    if (input === 'frames') return { ingredients: [], firstFrame: ids[0] ?? null, lastFrame: ids[1] ?? null };
    return { ingredients: ids, firstFrame: null, lastFrame: null };
  }

  async function openPicker() {
    if (picker()) return;
    const btn = composerButton(NAMES.ingredients);
    if (!clickable(btn)) throw new Error('Cannot open the asset picker (Add ingredients button not clickable)');
    btn.click();
    await waitFor(picker, { what: 'the asset picker' });
  }

  async function closePicker() {
    if (!picker()) return;
    const backdrop = $$('.cdk-overlay-backdrop').find((el) => el.offsetParent !== null);
    if (backdrop) backdrop.click(); else composerButton(NAMES.ingredients)?.click();
    await waitFor(() => !picker(), { what: 'the asset picker to close' }).catch(() => {});
  }

  // A picker tile carries no media id (thumbnails are /asb/ tokens, recon 2026-10-01), so it is
  // matched by the media's name — the prompt / uploaded filename Flow shows as the tile label, with
  // the trailing kind word (Image/Video/…) stripped. The pre-spend check still verifies the real id.
  const KIND_LABELS = ['Image', 'Video', 'Audio', 'Voice', 'Avatar', 'Character'];
  const tileName = (el) => {
    const label = visibleText(el);
    for (const k of KIND_LABELS) if (label.endsWith(k) && label.length > k.length) return label.slice(0, -k.length);
    return label;
  };
  const pickerTiles = (name) => {
    const p = picker();
    if (!p || !name) return [];
    return $$('button, [role=button], [role=option], [role=gridcell]', p).filter((t) => visibleText(t) === name || tileName(t) === name);
  };

  // Selects the one tile named `name`; fails closed if none (times out) or several match — never
  // guesses which media to attach when names collide.
  async function selectInPicker(name) {
    const tiles = await waitFor(() => { const m = pickerTiles(name); return m.length ? m : null; },
      { what: `the picker tile named "${name}"`, timeoutMs: ATTACH_WAIT_MS });
    if (tiles.length > 1) throw new Error(`Several media are named "${name}" in the picker; cannot tell which to attach`);
    if (!clickable(tiles[0])) throw new Error(`The picker tile named "${name}" is not clickable`);
    tiles[0].click();
  }

  // Some pickers attach on the tile click and close; others keep a final "Add to prompt". Click it
  // only if it is there (recon 2026-10-01: a single ingredient attaches on click).
  function confirmIfPresent() {
    const p = picker();
    const add = p && $$('button, [role=button]', p).find((b) => ADD_TO_PROMPT.test(text(b)));
    if (add && clickable(add)) add.click();
  }

  // Uploads one file through Flow's own "Upload media" control by building a File from the bytes and
  // setting it on Flow's hidden <input type=file> (no native dialog; LESSONS #13). The caller reads
  // the new media id from Zzl0ze; this never waits for the grid. Leaves the picker open.
  async function uploadFile(fileBase64, name, type) {
    if (agentPanelOpen()) throw new Error('Agent mode is on in Flow; turn it off, then run the job again');
    await openPicker();
    const upload = $$('button, [role=button]', picker()).find((b) => b.getAttribute('mattooltip') === UPLOAD_TOOLTIP || b.classList.contains('sidebar-upload-btn') || /upload media/i.test(text(b)));
    if (!clickable(upload)) throw new Error('No "Upload media" control in the picker');
    upload.click();
    const input = await waitFor(() => $$('input[type=file]').find((i) => (i.accept || '').includes('png')),
      { what: "Flow's upload file input" });
    const bin = atob(fileBase64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const data = new DataTransfer();
    data.items.add(new File([bytes], name, { type }));
    input.files = data.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  // Attaches already-in-project references to the composer for the job's input mode. The mode radios
  // must already be set to Video + Ingredients/Frames (attaching in Image mode opens the out-of-scope
  // image editor — recon 2026-10-01). References carry a `names` map (media id → tile name) because
  // the picker grid shows no id. Closes the picker in every case so a failure never leaves it open.
  async function attachReferences(input, references) {
    const names = references?.names ?? {};
    const nameFor = (id) => names[id] ?? id;
    try {
      if (input === 'frames') {
        for (const which of ['firstFrame', 'lastFrame']) {
          const id = references?.[which];
          if (!id) continue;
          const slot = $$('button, [role=button]', promptBox() || document).find((b) => visibleText(b) === FRAME_SLOT[which]);
          if (!clickable(slot)) throw new Error(`The ${FRAME_SLOT[which]} frame slot is not clickable`);
          slot.click();
          await waitFor(picker, { what: `the picker for the ${FRAME_SLOT[which]} frame` });
          await selectInPicker(nameFor(id));
          confirmIfPresent();
          await waitFor(() => !picker(), { what: 'the picker to close after attaching' }).catch(() => {});
          // The thumbnail renders just after the picker closes; wait for it so the pre-spend check
          // (which reads attached ids) does not run before the reference is on the page.
          await waitFor(() => attachedIdsNow().includes(id), { what: `the ${FRAME_SLOT[which]} frame to appear attached`, timeoutMs: ATTACH_WAIT_MS });
        }
        return;
      }
      for (const id of references?.ingredients ?? []) {
        await openPicker();
        await selectInPicker(nameFor(id));
        confirmIfPresent();
        await waitFor(() => !picker(), { what: 'the picker to close after attaching' }).catch(() => {});
        await waitFor(() => attachedIdsNow().includes(id), { what: `reference ${id} to appear attached`, timeoutMs: ATTACH_WAIT_MS });
      }
    } finally {
      await closePicker().catch(() => {});
    }
  }

  function readPage() {
    const input = radio('Frames')?.checked ? 'frames' : radio('Ingredients')?.checked ? 'ingredients' : null;
    return {
      url: location.origin + location.pathname,
      prompt: promptText(),
      summaryText: text(composerButton(NAMES.settings)),
      costText: costText(),
      input,
      agentPanelOpen: agentPanelOpen(),
      generateEnabled: clickable(composerButton(NAMES.generate)),
      overlayOpen: overlayOpen(),
      blocked: blockedText(),
    };
  }

  // Thrown when the page may have submitted something by itself; the engine halts everything.
  class Halt extends Error {}

  const escapeHtml = (t) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // Replaces the prompt with one paste event (typing corrupts long prompts, LESSONS.md #11).
  // Never uses insertText/keystrokes: ProseMirror turns an inserted line break into an Enter
  // keypress, and Enter submits. Lines go in as <p> paragraphs so no break is ever typed.
  async function fillPrompt(prompt) {
    if (agentPanelOpen()) throw new Error('Agent mode is on in Flow; turn it off, then run the job again');
    const ed = editor();
    if (!ed) throw new Error('Prompt box not found');
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = getSelection();
    // ProseMirror learns about a new selection from the browser's selectionchange event, which
    // comes after addRange. Pasting before it lands appends to the old text instead of replacing it.
    const selected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for the prompt box to be selected')), 3000);
      document.addEventListener('selectionchange', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    sel.removeAllRanges();
    sel.addRange(range);
    await selected;
    const data = new DataTransfer();
    data.setData('text/plain', prompt);
    data.setData('text/html', prompt.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join(''));
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));

    const outcome = await waitFor(() => {
      if (agentPanelOpen() || !editor()) return 'left';
      return promptText() === prompt ? 'filled' : null;
    }, { timeoutMs: 3000, what: 'the prompt to appear' }).catch(() => 'mismatch');

    if (outcome === 'left') throw new Halt('The composer changed while filling the prompt; something may have been submitted. Check Flow.');
    if (outcome === 'mismatch') {
      const now = promptText();
      if (now === '') throw new Halt('The prompt box emptied itself while filling; something may have been submitted. Check Flow.');
      throw new Error('Prompt did not match verbatim after pasting');
    }
  }

  async function openSettings() {
    if (radio('Video')) return;
    const trigger = composerButton(NAMES.settings);
    if (!clickable(trigger)) throw new Error('Settings trigger is not clickable');
    trigger.click();
    await waitFor(() => radio('Video'), { what: 'the settings panel' });
  }

  async function closeSettings() {
    if (!radio('Video')) return;
    composerButton(NAMES.settings).click();
    await waitFor(() => !radio('Video'), { what: 'the settings panel to close' });
  }

  async function choose(name) {
    const r = radio(name);
    if (!r) throw new Error(`Setting "${name}" not found`);
    if (r.checked) return;
    r.el.click();
    await waitFor(() => radio(name)?.checked, { what: `"${name}" to be selected` });
  }

  // Sets the composer to the job, reads everything back, leaves the settings panel closed.
  async function prepare(job) {
    const s = job.settings;
    // Flow's zoneless Angular only re-renders on timers/animation frames, which Chrome pauses or
    // throttles in background tabs: clicks land but the page never updates (LESSONS.md #23).
    if (document.visibilityState !== 'visible') throw new Error('The Flow work tab must be the front tab of its window');
    await closePicker().catch(() => {}); // a prior failed attach may have left the asset picker open over the composer
    try {
      await fillPrompt(job.prompt);
    } catch (e) {
      if (e instanceof Halt) return { ...readPage(), halt: e.message };
      throw e;
    }
    await openSettings();
    await choose(s.kind === 'video' ? 'Video' : 'Image');
    if (s.kind === 'video') {
      await choose(s.input === 'frames' ? 'Frames' : 'Ingredients');
      await choose(s.resolution);
      await choose(`${s.durationS}s`);
    }
    await choose(s.aspect);
    await choose(`x${s.count}`);
    const withPanel = readPage();
    const model = visibleText(button(NAMES.model)) || null;
    await closeSettings();
    // Attach references once the mode is Video + Ingredients/Frames (attaching in Image mode opens
    // the out-of-scope image editor). References were resolved to media ids by the engine first.
    if (s.kind === 'video' && job.references) {
      try {
        await attachReferences(s.input, job.references);
      } catch (e) {
        if (e instanceof Halt) return { ...readPage(), halt: e.message };
        throw e;
      }
    }
    const after = readPage();
    // What is actually attached now, read back by media id for the pre-spend check.
    after.attached = readAttached(s.kind === 'video' ? s.input : 'ingredients');
    // Mode radios, model and cost are only visible with the panel open; the rest is read after closing.
    return { ...after, input: withPanel.input, costText: withPanel.costText, model };
  }

  // `expect` is what the pre-spend check approved ({ url, prompt, summaryText }). Everything is
  // re-read here, in the same synchronous step as the click, so nothing can change in between.
  async function clickGenerate(expect) {
    const blocked = blockedText();
    if (blocked) return { ok: false, blocked };
    const gen = composerButton(NAMES.generate);
    const changed = [
      agentPanelOpen() && 'Agent mode is on in Flow',
      document.visibilityState !== 'visible' && 'the work tab is not the front tab',
      location.origin + location.pathname !== expect?.url && `the page is ${location.pathname}`,
      promptText() !== expect?.prompt && 'the prompt changed',
      text(composerButton(NAMES.settings)) !== expect?.summaryText && 'the settings changed',
      overlayOpen() && 'an overlay is open',
      !clickable(gen) && 'Start generation is not clickable',
    ].filter(Boolean);
    if (changed.length) return { ok: false, notClicked: true, error: changed.join('; ') };
    gen.click();
    try {
      // Flow clears the prompt box once it accepts a generation; a block shows as an alert.
      const outcome = await waitFor(() => (blockedText() ? 'blocked' : promptText() === '' ? 'accepted' : null),
        { timeoutMs: 30_000, what: 'Flow to accept the generation' });
      return outcome === 'blocked' ? { ok: false, blocked: blockedText() } : { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  const inFront = () => document.visibilityState === 'visible';

  const api = { selfCheck, readPage, prepare, clickGenerate, inFront, uploadFile, closePicker };
  globalThis.__flowPilotDriver = api; // isolated world only; the page cannot see it

  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
      if (msg?.to !== 'driver' || !api[msg.cmd]) return false;
      Promise.resolve(api[msg.cmd](...(msg.args || []))).then(
        (value) => reply({ ok: true, value }),
        (e) => reply({ ok: false, error: e.message }),
      );
      return true;
    });
  }
})();
