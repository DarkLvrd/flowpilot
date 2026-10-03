#!/usr/bin/env node
// Live dry run of the work-tab driver behind a request firewall. Test harness only, never shipped.
//
// While it runs, every non-GET request from the Flow tab is failed inside the browser before it
// leaves, except batchexecute calls whose rpc ids are all on the read-only allowlist. So even if
// filling the composer submitted something (docs/LESSONS.md #22), nothing reaches Google.
// It never calls clickGenerate, and it clears the prompt box at the end.
//
// Usage: node recon/dry-run.mjs [--port 9333] [--prompt "text"]

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSettingsSummary } from '../extension/lib/preflight.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const PORT = Number(opt('port', 9333));
const PROMPT = opt('prompt', 'flowpilot dry run, blocked by firewall: a lighthouse at dusk\nsecond line');
const READ_ONLY = new Set(['nzlxg', 'HTrJv', 'yBhWQ', 'ngNC2', 'Zzl0ze', 'as29s', 'mrlkwd', 'GN0Bre', 'o30O0e',
  'cPZSdc', 'tRARke', 'NfrxTb', 'KV2T2d', 'LPzVkd', 'qJcgMc', 've2Lsc', 'DTaVef', 'Yizz8d', 'WuwhI']);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const tab = targets.find((t) => t.type === 'page' && t.url.startsWith('https://flow.google.com/project/'));
if (!tab) throw new Error(`No Flow project tab on CDP port ${PORT}`);
const projectId = new URL(tab.url).pathname.split('/')[2];

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
let nextId = 0;
const pending = new Map();
const blocked = [];
const send = (method, params = {}) => new Promise((ok) => { const id = ++nextId; pending.set(id, ok); ws.send(JSON.stringify({ id, method, params })); });

ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method !== 'Fetch.requestPaused') return;
  const { requestId, request } = msg.params;
  const u = new URL(request.url);
  const rpcids = u.pathname.endsWith('/data/batchexecute') ? (u.searchParams.get('rpcids') || '').split(',') : null;
  const allowed = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) || (rpcids && rpcids.every((r) => READ_ONLY.has(r)));
  if (allowed) {
    send('Fetch.continueRequest', { requestId });
  } else {
    blocked.push(`${request.method} ${u.host}${u.pathname}${rpcids ? ` rpcids=${rpcids}` : ''}`);
    send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
  }
};

const fw = await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
if (fw.error) throw new Error(`Firewall did not start: ${fw.error.message}`);
console.log('firewall on');

try {
  const tree = await send('Page.getFrameTree');
  const world = await send('Page.createIsolatedWorld', { frameId: tree.result.frameTree.frame.id, worldName: `flowpilot-dry-${Date.now()}` });
  const contextId = world.result.executionContextId;
  const run = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
    return r.result.result.value;
  };
  await run(readFileSync(join(root, 'extension/content/driver.js'), 'utf8'));

  const checks = await run('__flowPilotDriver.selfCheck()');
  for (const c of checks) console.log(c.ok ? '✅' : '❌', c.name);
  if (checks.some((c) => !c.ok)) {
    console.log('Self-check failed: not touching the composer.');
  } else {
    // The summary alone cannot state the mode: in Image mode Flow writes the image model's name
    // where a video chip writes `Video`. So read it the way the engine does — the panel's own mode
    // radio, with the panel opened and closed again here (no fixed sleep: wait on the radios).
    const raw = await run(`(async () => {
      const trig = [...document.querySelectorAll('button, [role=button]')].find((b) => b.getAttribute('aria-label') === 'Settings trigger');
      if (!trig) return null;
      if (!document.querySelector('[role=radio]')) {
        trig.click();
        await new Promise((resolve) => { const obs = new MutationObserver(() => { if (document.querySelector('[role=radio]')) { obs.disconnect(); resolve(); } }); obs.observe(document.body, { subtree: true, childList: true, attributes: true }); });
      }
      const page = __flowPilotDriver.readPage();
      trig.click();
      return page;
    })()`);
    const summary = parseSettingsSummary(raw.summaryText, { mode: raw.modeKind });
    const kind = summary.kind;
    console.log('settings:', JSON.stringify({ summaryText: raw.summaryText, modeKind: raw.modeKind, parsed: summary }));
    // Ask for exactly what is already selected, so no setting changes.
    const job = { prompt: PROMPT, settings: kind === 'video'
      ? { kind, input: 'ingredients', resolution: summary.resolution, durationS: summary.durationS, aspect: summary.aspect, count: summary.count }
      : { kind: 'image', aspect: summary.aspect, count: summary.count } };
    // Twice: the second prompt must replace the first, not append to it.
    for (const prompt of ['flowpilot dry run, stale text that must be replaced', PROMPT]) {
      try {
        const page = await run(`__flowPilotDriver.prepare(${JSON.stringify({ ...job, prompt })})`);
        console.log('prepare →', JSON.stringify({ ...page, prompt: page.prompt === prompt ? '<verbatim match>' : page.prompt }, null, 1));
      } catch (e) {
        console.log('prepare threw:', e.message.split('\n')[0]);
        break;
      }
    }
  }
  // Clear the box by deleting the selection (no text insertion, so no Enter can be simulated).
  await run(`(() => { const box = [...document.querySelectorAll('flow-base-prompt-box')].find((b) => !b.closest('flow-agent-panel'));
    const ed = box?.querySelector('.ProseMirror'); if (!ed) return; ed.focus(); const r = document.createRange(); r.selectNodeContents(ed);
    getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand('delete'); })()`);
} finally {
  await send('Fetch.disable');
  console.log('firewall off; blocked requests:', blocked.length ? blocked : 'none');
  console.log(`project ${projectId}`);
  ws.close();
}
