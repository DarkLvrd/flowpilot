#!/usr/bin/env node
// Read-only recon: attach to a Flow tab over CDP, reload it once, and save every
// batchexecute request/response the page makes by itself to recon/raw/.
// Credentials never reach disk: request headers and cookies are not recorded, and the
// page's `at` (XSRF) form field is redacted from request bodies.
//
// Usage: node recon/capture.mjs [--port 9333] [--seconds 20] [--no-reload]

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PORT = Number(opt('port', 9333));
const SECONDS = Number(opt('seconds', 20));
const RELOAD = !args.includes('--no-reload');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'raw', 'capture');
mkdirSync(OUT, { recursive: true });

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const tab = targets.find((t) => t.type === 'page' && t.url.startsWith('https://flow.google.com/'));
if (!tab) throw new Error(`No flow.google.com tab on CDP port ${PORT}`);

const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) => new Promise((ok, fail) => {
  const id = nextId++;
  pending.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params }));
});

const requests = new Map();
const saved = [];

function redactBody(body) {
  if (!body) return body;
  const p = new URLSearchParams(body);
  if (p.has('at')) p.set('at', '<redacted>');
  return p.toString();
}

ws.onmessage = async ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    const { ok, fail } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
    return;
  }
  if (msg.method === 'Network.requestWillBeSent') {
    const { requestId, request } = msg.params;
    if (!request.url.includes('/data/batchexecute')) return;
    const u = new URL(request.url);
    requests.set(requestId, {
      rpcids: u.searchParams.get('rpcids'),
      build: u.searchParams.get('bl'),
      sourcePath: u.searchParams.get('source-path'),
      body: redactBody(request.postData),
    });
  }
  if (msg.method === 'Network.loadingFinished') {
    const r = requests.get(msg.params.requestId);
    if (!r) return;
    try {
      const { body, base64Encoded } = await send('Network.getResponseBody', { requestId: msg.params.requestId });
      r.response = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
    } catch (e) {
      r.response = `<unavailable: ${e.message}>`;
    }
    const file = `${String(saved.length).padStart(2, '0')}-${r.rpcids.replace(/,/g, '+')}.json`;
    writeFileSync(join(OUT, file), JSON.stringify(r, null, 2));
    saved.push(file);
  }
};

await send('Network.enable', { maxPostDataSize: 1_000_000 });
if (RELOAD) await send('Page.reload');
await new Promise((ok) => setTimeout(ok, SECONDS * 1000));
ws.close();
console.log(`saved ${saved.length} calls to ${OUT}`);
for (const f of saved) console.log(`  ${f}`);
