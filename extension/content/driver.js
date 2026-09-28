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
  };
  const BLOCK_TEXT = /unusual activity|UNUSUAL_ACTIVITY|temporarily blocked/i;

  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const text = (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim();

  function labelOf(el) {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
    const label = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
    return text(label) || text(el);
  }

  const button = (name) => $$('button, [role=button]').find((b) => b.getAttribute('aria-label') === name);
  const agentButton = () => $$('button').find((b) => !b.getAttribute('aria-label') && text(b) === 'Agent');
  const editor = () => document.querySelector('flow-rich-text-editor .ProseMirror[contenteditable=true]');

  function radios() {
    return $$('[role=radio], input[type=radio]').map((el) => ({
      el,
      name: labelOf(el),
      checked: el.getAttribute('aria-checked') === 'true' || el.checked === true,
    }));
  }
  // Radio names can carry a description ("360p 360p generates faster…"), so match the first word(s).
  const radio = (want) => radios().find((r) => r.name === want || r.name.startsWith(`${want} `));

  function promptText() {
    const ed = editor();
    if (!ed) return null;
    return $$(':scope > p', ed).map((p) => p.textContent).join('\n');
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
    const summary = button(NAMES.settings);
    const checks = [
      ['Prompt box', !!editor()],
      ['Start generation button', !!button(NAMES.generate)],
      ['Settings trigger', !!summary],
      ['Settings summary readable', !!summary && /^(Video|Image)\b/.test(text(summary))],
      ['Add ingredients button', !!button(NAMES.ingredients)],
      ['Agent toggle', !!agentButton()],
      ['Account details', !!button(NAMES.account)],
      ['On a project page', /^\/project\/[0-9a-f-]{36}$/.test(location.pathname)],
    ];
    return checks.map(([name, ok]) => ({ name, ok }));
  }

  function readPage() {
    const input = radio('Frames')?.checked ? 'frames' : radio('Ingredients')?.checked ? 'ingredients' : null;
    return {
      url: location.origin + location.pathname,
      prompt: promptText(),
      summaryText: text(button(NAMES.settings)),
      costText: costText(),
      input,
      generateEnabled: clickable(button(NAMES.generate)),
      overlayOpen: overlayOpen(),
      blocked: blockedText(),
    };
  }

  async function fillPrompt(prompt) {
    const ed = editor();
    if (!ed) throw new Error('Prompt box not found');
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    // One paste event replaces the whole content at once (typing corrupts long prompts).
    const data = new DataTransfer();
    data.setData('text/plain', prompt);
    ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    try {
      await waitFor(() => promptText() === prompt, { timeoutMs: 3000, what: 'the prompt to appear' });
    } catch {
      sel.removeAllRanges();
      range.selectNodeContents(ed);
      sel.addRange(range);
      document.execCommand('insertText', false, prompt);
    }
    if (promptText() !== prompt) throw new Error('Prompt did not match verbatim after filling');
  }

  async function openSettings() {
    if (radio('Video')) return;
    const trigger = button(NAMES.settings);
    if (!clickable(trigger)) throw new Error('Settings trigger is not clickable');
    trigger.click();
    await waitFor(() => radio('Video'), { what: 'the settings panel' });
  }

  async function closeSettings() {
    if (!radio('Video')) return;
    button(NAMES.settings).click();
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
    await fillPrompt(job.prompt);
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
    await closeSettings();
    const after = readPage();
    // Mode radios and cost are only visible with the panel open; the rest is read after closing.
    return { ...after, input: withPanel.input, costText: withPanel.costText };
  }

  async function clickGenerate() {
    const blocked = blockedText();
    if (blocked) return { ok: false, blocked };
    const gen = button(NAMES.generate);
    if (!clickable(gen)) return { ok: false, error: 'Start generation is not clickable' };
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

  const api = { selfCheck, readPage, prepare, clickGenerate };
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
