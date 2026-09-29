#!/usr/bin/env node
// Read-only recon: attach to a Flow tab over CDP, reload it once, and save every
// batchexecute request/response the page makes by itself to recon/raw/.
// Credentials never reach disk: request headers and cookies are not recorded, and the
// page's `at` (XSRF) form field is redacted from request bodies.
//
// --generate: for the first live job (spec decision 13). No reload; records every non-GET request
// to a Google host (the generate call may not be batchexecute) with its HTTP status, and replaces
// any long token-like string (the reCAPTCHA token Flow mints on Generate) before anything is saved.
//
// Usage: node recon/capture.mjs [--port 9333] [--seconds 20] [--no-reload] [--generate]

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
const GENERATE = args.includes('--generate');
const RELOAD = !args.includes('--no-reload') && !GENERATE;
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'raw', GENERATE ? `generate-${Date.now()}` : 'capture');
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

// Tokens are long unbroken runs of base64url; ids (uuids, rpc ids) and prompts are not.
const redactTokens = (text) => text.replace(/[A-Za-z0-9_\-]{120,}/g, (t) => `<redacted ${t.length} chars>`);

function redactBody(body) {
  if (!body) return body;
  if (!body.includes('=')) return GENERATE ? redactTokens(body) : body; // JSON body, not a form
  const p = new URLSearchParams(body);
  if (p.has('at')) p.set('at', '<redacted>');
  if (GENERATE) for (const [k, v] of p) p.set(k, redactTokens(v));
  return p.toString();
}

const isGoogleHost = (host) => /(^|\.)(google\.com|googleapis\.com)$/.test(host);

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
    const u = new URL(request.url);
    const batch = request.url.includes('/data/batchexecute');
    if (GENERATE ? request.method === 'GET' || !isGoogleHost(u.hostname) : !batch) return;
    requests.set(requestId, {
      endpoint: `${request.method} ${u.host}${u.pathname}`,
      rpcids: u.searchParams.get('rpcids') ?? u.pathname.split('/').pop(),
      build: u.searchParams.get('bl'),
      sourcePath: u.searchParams.get('source-path'),
      body: redactBody(request.postData),
    });
  }
  if (msg.method === 'Network.responseReceived' && requests.has(msg.params.requestId)) {
    requests.get(msg.params.requestId).status = msg.params.response.status;
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
    const file = `${String(saved.length).padStart(2, '0')}-${r.rpcids.replace(/[^\w+-]/g, '+').replace(/,/g, '+')}.json`;
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
