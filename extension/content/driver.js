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
  // A Flow Character exposes no media id and no entity id in the DOM: its chip and its picker tile
  // only carry an /asb/<token> thumbnail (report §4). That token is the only handle the pre-spend
  // check can compare, and it is byte-identical between the tile and the chip.
  const ASB_TOKEN = /\/asb\/([A-Za-z0-9_-]+)/;
  const CHARACTER_CHIP = 'flow-character-ingredient-chip';
  // The picker's own category rail; a character has its own category and is not in `All` (report §2).
  const CHARACTER_CATEGORY = 'Characters';
  const UPLOAD_TOOLTIP = 'Upload media';
  const ADD_TO_PROMPT = /^add to prompt$/i;
  const FRAME_SLOT = { firstFrame: 'Start', lastFrame: 'End' };
  // Reference tiles and attached thumbnails can take a few seconds to render (a fresh upload, or a
  // virtual-scroller picker); one budget for finding a tile and for reading the attach back.
  const ATTACH_WAIT_MS = 15_000;
  // Closing the asset picker is a click and a DOM change, not a render: short, but not zero.
  const PICKER_CLOSE_MS = 3_000;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  // Material icons are ligature words in the text ("videocam", "crop_16_9"); accessible names skip them.
  const visibleText = (el) => {
    if (!el) return '';
    const copy = el.cloneNode(true);
    copy.querySelectorAll('mat-icon').forEach((icon) => icon.remove());
    return text(copy);
  };
  // A readable Settings summary: the video chip's own kind word, or the image chip's model name plus
  // the crop/count it carries (lib/preflight.js parseSettingsSummary is the authority on what the
  // summary means and refuses anything it cannot read).
  const SUMMARY_READABLE = /^\s*(Video|Image)\b|crop_|\bx\d/;

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
      ['Settings summary readable', !!summary && SUMMARY_READABLE.test(text(summary))],
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

  // The open picker's tile for a media, matched by tile text; returns the tile so a caller can read
  // its thumbnail token (the character chip's only identity handle).
  const asbToken = (el) => ((el?.getAttribute('src') || el?.src || '').match(ASB_TOKEN) || [])[1] ?? null;
  // The character chips attached in the composer, by thumbnail token. A character chip carries no
  // media id (CONTENT_ID does not match it), so it contributes nothing to attachedIdsNow().
  function characterChipTokens() {
    const bar = promptBox()?.querySelector('flow-ingredient-bar') || promptBox();
    if (!bar) return [];
    return [...new Set($$(`${CHARACTER_CHIP} img`, bar).map(asbToken).filter(Boolean))];
  }

  // Every mention chip in the prompt, with the entity id Flow will send. Flow marks a mention it
  // will NOT send (an id outside `validMentionIds`) with `mention-chip-invalid`, and serialises it
  // as plain text (report §3a) — a silent character failure the pre-spend check fails closed on.
  function readMentions() {
    return $$('span.mention-chip', promptBox() || document).map((el) => ({
      entityId: el.getAttribute('data-entity-id') ?? el.getAttribute('data-mention-id') ?? null,
      referenceType: el.getAttribute('data-reference-type') ?? null,
      valid: !el.classList.contains('mention-chip-invalid'),
    }));
  }

  function readAttached(input) {
    const ids = attachedIdsNow();
    const characters = characterChipTokens();
    if (input === 'frames') return { ingredients: [], firstFrame: ids[0] ?? null, lastFrame: ids[1] ?? null, characters };
    return { ingredients: ids, firstFrame: null, lastFrame: null, characters };
  }

  async function openPicker() {
    if (picker()) return;
    const btn = composerButton(NAMES.ingredients);
    if (!clickable(btn)) throw new Error('Cannot open the asset picker (Add ingredients button not clickable)');
    btn.click();
    await waitFor(picker, { what: 'the asset picker' });
  }

  // The picker's own close control. The Frames picker has one — a mat-icon-button labelled `Close`
  // (live 2026-10-03, recon/FINDINGS.md "Closing the picker") — and clicking it is the only thing
  // that closed that picker: a backdrop click did nothing, and in Frames mode the composer has no
  // "Add ingredients" button to toggle either.
  function pickerCloseControl(scope) {
    return $$('button, [role=button]', scope).find((b) => {
      const label = (b.getAttribute('aria-label') || b.getAttribute('title') || b.getAttribute('mattooltip') || '').trim();
      if (/^close$/i.test(label)) return true;
      const icon = $('mat-icon', b);
      return !!icon && text(icon).toLowerCase() === 'close';
    }) ?? null;
  }

  // Clears the asset picker, in the order the live page needs. The picker's own `close` control
  // first, then the CDK backdrop, then the composer's ingredients button (the Ingredients picker has
  // no close control of its own and is dismissed by its trigger). Each step waits on the real DOM;
  // when none of them closes it the call throws, because a picker left open over the composer makes
  // the *next* step report something misleading ("Settings trigger is not clickable") — the wedge
  // this exists to prevent (BUG-5). A page with no picker open is a no-op.
  async function closePicker() {
    if (!picker()) return;
    const steps = [() => pickerCloseControl(picker()), () => $$('.cdk-overlay-backdrop').find((el) => el.offsetParent !== null), () => composerButton(NAMES.ingredients)];
    for (const step of steps) {
      const control = step();
      if (!control) continue;
      if (!clickable(control)) continue;
      control.click();
      if (await waitFor(() => !picker(), { what: 'the asset picker to close', timeoutMs: PICKER_CLOSE_MS }).catch(() => null)) return;
    }
    throw new Error('The asset picker would not close (tried its own close control, the backdrop and the ingredients button); close it by hand before running another job');
  }

  // A picker tile carries no media id (thumbnails are /asb/ tokens, recon 2026-10-01), so it is
  // matched by the label Flow shows it under — the workflow title for a generated media, the file
  // name for an upload (lib/refs.js referenceNames gives the candidates in that order, with the
  // media's prompt as the fallback). The pre-spend check still verifies the real id afterwards.
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

  // Selects the tile for one media, whose label Flow may show in any one of several ways. Candidates
  // are tried in order and the *first one that matches anything* decides: the tile Flow really labels
  // this media by is not something to guess at past that point. A candidate that matches several
  // tiles cannot identify a media (Flow gives several media the same title — live 2026-10-03, three
  // tiles read "Woman driving Formula One car"), so the job fails instead of attaching one of them.
  // Returns the tile so a caller can read its thumbnail token (a character chip's only handle).
  async function selectInPicker(labels) {
    const wanted = (Array.isArray(labels) ? labels : [labels]).filter((l) => typeof l === 'string' && l !== '');
    if (!wanted.length) throw new Error('No name to find this media by in Flow\'s picker');
    const hits = await waitFor(() => {
      const found = wanted.map((label) => ({ label, tiles: pickerTiles(label) })).filter((h) => h.tiles.length > 0);
      return found.length ? found : null;
    }, { what: `the picker tile for ${wanted.map((l) => `"${l}"`).join(' or ')}`, timeoutMs: ATTACH_WAIT_MS });
    const first = hits[0];
    if (first.tiles.length > 1) throw new Error(`Several media are named "${first.label}" in the picker; cannot tell which to attach`);
    if (!clickable(first.tiles[0])) throw new Error(`The picker tile named "${first.label}" is not clickable`);
    first.tiles[0].click();
    return first.tiles[0];
  }

  // Selects one of the picker's own categories (All | Images | Videos | Voices | Characters | …).
  // Characters live in their own category and are not listed under `All` (report §2), so a
  // character attach must switch the rail first. Fails closed when the category is not there.
  async function selectPickerCategory(label) {
    const items = await waitFor(() => {
      const p = picker();
      if (!p) return null;
      const found = $$('mat-list-item, [role=tab], li, button, [role=button]', p)
        .filter((el) => visibleText(el) === label && !el.matches('.asset-item, [role=option]'));
      return found.length ? found : null;
    }, { what: `the picker category "${label}"`, timeoutMs: ATTACH_WAIT_MS });
    if (items.length > 1) throw new Error(`Several picker categories read "${label}"; cannot tell which to open`);
    if (items[0].getAttribute('aria-selected') === 'true') return;
    if (!clickable(items[0])) throw new Error(`The picker category "${label}" is not clickable`);
    items[0].click();
    // The tile appears only once the category is applied; selectInPicker waits for it, so a rail
    // click that did not land fails the job instead of attaching the wrong thing.
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

  // Attaches already-in-project references to the composer for the job's input mode. The Video mode
  // radios must already be set to Ingredients/Frames before attaching (in Image mode Flow's grid can
  // route a selection into the out-of-scope image editor — recon 2026-10-01), and an image job's
  // Ingredients go through the same asset picker. References carry a `names` map (media id → the
  // labels Flow may show that media under, in the order to try) because the picker grid shows no id.
  // A failed attach closes what it opened, and a picker that will not close is reported with the
  // failure that left it open: an overlay left over the composer is what wedges the next prepare.
  async function attachReferences(input, references) {
    try {
      return await attachEachReference(input, references);
    } catch (e) {
      try {
        await closePicker();
      } catch (closeError) {
        // A Halt already stops everything for a person to look; never lose that reason.
        if (!(e instanceof Halt)) e.message = `${e.message}; ${closeError.message}`;
      }
      throw e;
    }
  }

  async function attachEachReference(input, references) {
    const names = references?.names ?? {};
    const nameFor = (id) => names[id] ?? id;
    const characterTokens = {};
    // A Flow Character goes through the same picker, under its own category (report §3b). It has
    // no media id, so the tile's thumbnail token is captured here and compared with the chip by
    // the pre-spend check: that comparison is the only proof the right character was attached.
    if (input !== 'frames') {
      for (const character of references?.characters ?? []) {
        await openPicker();
        await selectPickerCategory(CHARACTER_CATEGORY);
        const tile = await selectInPicker(character.name);
        const token = asbToken($('img', tile));
        if (!token) throw new Error(`The picker tile for the character "${character.name}" has no thumbnail, so its chip could not be verified`);
        confirmIfPresent();
        await closePicker();
        await waitFor(() => characterChipTokens().includes(token), { what: `the character chip for "${character.name}" to appear attached`, timeoutMs: ATTACH_WAIT_MS });
        characterTokens[character.name] = token;
      }
    }
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
        await closePicker();
        // The thumbnail renders just after the picker closes; wait for it so the pre-spend check
        // (which reads attached ids) does not run before the reference is on the page.
        await waitFor(() => attachedIdsNow().includes(id), { what: `the ${FRAME_SLOT[which]} frame to appear attached`, timeoutMs: ATTACH_WAIT_MS });
      }
      return characterTokens;
    }
    for (const id of references?.ingredients ?? []) {
      await openPicker();
      await selectInPicker(nameFor(id));
      confirmIfPresent();
      await closePicker();
      await waitFor(() => attachedIdsNow().includes(id), { what: `reference ${id} to appear attached`, timeoutMs: ATTACH_WAIT_MS });
    }
    return characterTokens;
  }

  function readPage() {
    const input = radio('Frames')?.checked ? 'frames' : radio('Ingredients')?.checked ? 'ingredients' : null;
    return {
      url: location.origin + location.pathname,
      prompt: promptText(),
      summaryText: text(composerButton(NAMES.settings)),
      // The settings panel's own checked mode radio, when the panel is open. In Image mode the
      // chip carries the image model's name instead of a kind word, so this is the one place the
      // mode itself can be read; lib/preflight.js uses it as the fallback kind.
      modeKind: radio('Video')?.checked ? 'video' : radio('Image')?.checked ? 'image' : null,
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

  // ---- The model family: Flow's own `Select model family` menu (live 2026-10-04) ----------------
  //
  // The button (aria-label `Select model family`) shows the family Flow is currently on, e.g.
  // `🍌 Nano Banana 2`. Opening it renders a mat-menu of `flow-menu-item`s, one per family, the
  // current one marked `selected`, each item's own visible text exactly the family name the catalog
  // knows. A job may name its Flow image model (`settings.model` → `job.modelFamily`); when the
  // account is on a different one this selects the job's through Flow's own menu — the same careful
  // click as every other control — instead of failing with a bare mismatch (report §4a, BUG-A).
  const modelMenu = () => $$('.cdk-overlay-pane').find((p) => p.offsetParent !== null && $$('flow-menu-item', p).length > 0) || null;
  const modelButton = () => button(NAMES.model);

  async function selectModelFamily(want) {
    const btn = modelButton();
    if (!btn) throw new Error("Flow's model button is not on the page; open Flow's settings panel to read or change the model");
    const current = visibleText(btn);
    if (current === want) return null; // already on the job's model: no click, nothing changes
    if (!clickable(btn)) throw new Error(`Flow's model button ("${current}") is not clickable, so the job's model "${want}" cannot be selected`);
    btn.click();
    const menu = await waitFor(modelMenu, { what: "Flow's model menu" });
    const items = $$('flow-menu-item', menu);
    const item = items.find((el) => visibleText(el) === want);
    if (!item) throw new Error(`Flow's model menu does not offer "${want}" (it offers ${items.map(visibleText).filter(Boolean).join(', ') || 'nothing'}); pick one of those in Flow, or name a model the catalog knows on the job`);
    const target = $$('[role=menuitem], button, [role=button]', item)[0] || item;
    if (!clickable(target)) throw new Error(`The model menu item "${want}" is not clickable`);
    target.click();
    await waitFor(() => visibleText(modelButton()) === want, { what: `Flow's model to become "${want}"` });
    // The menu animates closed; an overlay left open over the composer is what the pre-spend check
    // refuses, so wait for it to be really gone before carrying on.
    await waitFor(() => !modelMenu(), { what: 'the model menu to close' });
    return current;
  }

  // Sets the composer to the job, reads everything back, leaves the settings panel closed.
  async function prepare(job) {
    const s = job.settings;
    // Flow's zoneless Angular only re-renders on timers/animation frames, which Chrome pauses or
    // throttles in background tabs: clicks land but the page never updates (LESSONS.md #23).
    if (document.visibilityState !== 'visible') throw new Error('The Flow work tab must be the front tab of its window');
    // A prior failed attach may have left the asset picker open over the composer. Clear it, or fail
    // here with that reason rather than at the next click with a misleading one (BUG-5).
    await closePicker();
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
    // An image job may name the Flow image model it wants (`settings.model`). When the account is on
    // a different one, select the job's through Flow's own menu instead of failing with a bare
    // mismatch (report §4a, BUG-A). Scoped to image jobs: a video's model family decides what the
    // clip costs, so that stays the person's choice and the pre-spend check still refuses a mismatch.
    const modelWas = s.kind === 'image' && job.modelFamily ? await selectModelFamily(job.modelFamily) : null;
    const withPanel = readPage();
    const model = visibleText(button(NAMES.model)) || null;
    await closeSettings();
    // Attach references once the mode is set: a video's Ingredients/Frames, or an image's Ingredients
    // (same picker, same read-back). Attaching in Image mode can route Flow into its image editor;
    // when that happens the page's URL changes and the pre-spend check refuses before any click, so
    // nothing is ever submitted from the wrong screen.
    let characterTokens = {};
    if (job.references) {
      try {
        characterTokens = await attachReferences(s.kind === 'video' ? s.input : 'ingredients', job.references) ?? {};
      } catch (e) {
        if (e instanceof Halt) return { ...readPage(), halt: e.message };
        throw e;
      }
      if (s.kind === 'image' && readPage().url !== `https://flow.google.com/project/${job.projectId}`) {
        throw new Error("Attaching an image reference left Flow's project page (the image editor opened); the job was not submitted");
      }
    }
    const after = readPage();
    // What is actually attached now, read back by media id (and by character thumbnail token) for
    // the pre-spend check, plus the mention chips and the token each character's picker tile showed.
    after.attached = readAttached(s.kind === 'video' ? s.input : 'ingredients');
    after.characterTokens = characterTokens;
    after.mentions = readMentions();
    // Mode radios, model and cost are only visible with the panel open; the rest is read after closing.
    return { ...after, input: withPanel.input, modeKind: withPanel.modeKind, costText: withPanel.costText, model, ...(modelWas ? { modelWas } : {}) };
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

  // `attachReferences`, `readPage` and `selectModelFamily` are exposed for the driver test and the
  // live rehearsal harness (recon/dry-run.mjs); prepare is their only caller in the extension itself.
  const api = { selfCheck, readPage, prepare, clickGenerate, inFront, uploadFile, closePicker, attachReferences, selectModelFamily };
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
