#!/usr/bin/env node
// Read-only DOM probe: attach to the Flow tab over CDP and report how the composer hooks are
// marked up (tag, role, aria-label, contenteditable). Clicks nothing, types nothing.
// For the page's request parameters (WIZ_global_data) it reports only whether each key is
// present, never its value.
//
// Usage: node recon/probe-dom.mjs [--port 9333]

const args = process.argv.slice(2);
const i = args.indexOf('--port');
const PORT = Number(i >= 0 ? args[i + 1] : 9333);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const tab = targets.find((t) => t.type === 'page' && t.url.startsWith('https://flow.google.com/'));
if (!tab) throw new Error(`No flow.google.com tab on CDP port ${PORT}`);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });

function probe() {
  const describe = (el) => el && {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute('role'),
    ariaLabel: el.getAttribute('aria-label'),
    ariaChecked: el.getAttribute('aria-checked'),
    disabled: el.disabled ?? null,
    ariaDisabled: el.getAttribute('aria-disabled'),
    contentEditable: el.getAttribute('contenteditable'),
    text: (el.textContent || '').trim().slice(0, 60),
  };
  const buttons = [...document.querySelectorAll('button, [role=button]')]
    .map(describe)
    .filter((b) => b.ariaLabel || b.text);
  const editables = [...document.querySelectorAll('[contenteditable], textarea, [role=textbox]')].map(describe);
  const radios = [...document.querySelectorAll('[role=radio], input[type=radio]')].map(describe);
  const wiz = window.WIZ_global_data || {};
  return {
    url: location.href,
    wizKeysPresent: Object.fromEntries(['SNlM0e', 'cfb2h', 'FdrFJe'].map((k) => [k, typeof wiz[k] === 'string' && wiz[k].length > 0])),
    buttons: buttons.slice(0, 60),
    editables,
    radios,
  };
}

ws.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression: `(${probe})()`, returnByValue: true },
}));
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id !== 1) return;
  console.log(JSON.stringify(msg.result.result.value ?? msg.result, null, 2));
  ws.close();
};
