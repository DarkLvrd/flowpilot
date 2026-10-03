// The helper: a local HTTP API for agents and a WebSocket bridge the extension connects to
// (docs/SPEC.md decisions 6 and 9). It holds no job state; every agent call is forwarded to the
// extension, which runs it exactly as a dashboard click would. Only jobs and results cross the
// bridge: never cookies or auth tokens (LESSONS #4).
//
// Bridge messages (JSON):
//   helper → extension  { id, cmd, args }          extension → helper  { id, ok, value | error }
//   extension → helper  { rid, req, ... }          helper → extension  { rid, ok, value | error }
//     req: 'pairCode' (the dashboard's "Pair an agent"), 'writeFile' { path, data: base64 },
//          'readMedia' { path } → { name, type, data: base64 } for a reference image, 'ping',
//          'writeEntities' { projectId, library } and 'readEntities' { projectId } — the entity
//          library mirror under the helper home (report §4.8)
//
// Reachable only from this machine and never from web pages: bound to 127.0.0.1, Host must be
// 127.0.0.1/localhost (DNS rebinding), requests carrying a browser Origin are refused, and only a
// chrome-extension:// origin may open the bridge.

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { writeMedia, readMedia } from './files.js';
import { paths } from './client.js';
import { writeEntitiesFile, readEntitiesFile } from './entities-file.js';

const MAX_BODY = 1 << 20;
const EXTENSION_TIMEOUT_MS = 30_000;
const JOB_ACTIONS = { approve: 'approve', cancel: 'cancel', requeue: 'requeue', 'retry-download': 'retryDownload' };

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createHelper({ keyring, pin = { check: () => true }, host = '127.0.0.1', log = () => {}, home = paths().home }) {
  let port = null;
  let extension = null; // the one connected extension socket
  let nextId = 0;
  const waiting = new Map(); // id → { resolve, reject, timer }

  // ---- Extension side -----------------------------------------------------------------------

  function callExtension(cmd, args = {}) {
    if (!extension) {
      throw new HttpError(503, 'The Flow Pilot extension is not connected: open Chrome with the extension loaded (it connects within 30 s)');
    }
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(new HttpError(504, `The extension did not answer "${cmd}" within 30 s`)); }, EXTENSION_TIMEOUT_MS);
      waiting.set(id, { resolve, reject, timer });
      extension.send(JSON.stringify({ id, cmd, args }));
    });
  }

  function fromExtension(req) {
    switch (req.req) {
      case 'ping': return 'pong';
      case 'pairCode': return keyring.newCode();
      case 'writeFile': return { path: writeMedia(req.path, Buffer.from(String(req.data ?? ''), 'base64')) };
      case 'readMedia': return readMedia(req.path);
      case 'writeEntities': return { path: writeEntitiesFile(home, req.projectId, req.library) };
      case 'readEntities': return { library: readEntitiesFile(home, req.projectId) };
      default: throw new Error(`Unknown request: ${req.req}`);
    }
  }

  function onBridgeMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.rid != null) {
      let reply;
      try { reply = { rid: m.rid, ok: true, value: fromExtension(m) }; } catch (e) { reply = { rid: m.rid, ok: false, error: e.message }; }
      ws.send(JSON.stringify(reply));
      return;
    }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    clearTimeout(w.timer);
    m.ok ? w.resolve(m.value) : w.reject(new HttpError(400, m.error ?? 'Extension error'));
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 << 20 });
  wss.on('connection', (ws) => {
    extension?.close(1000, 'Replaced by a newer connection');
    extension = ws;
    log('extension connected');
    ws.on('message', (raw) => onBridgeMessage(ws, raw));
    ws.on('close', () => {
      if (extension !== ws) return;
      extension = null;
      log('extension disconnected');
      for (const [id, w] of waiting) { clearTimeout(w.timer); w.reject(new HttpError(503, 'The extension disconnected')); waiting.delete(id); }
    });
  });

  // ---- Agent side ---------------------------------------------------------------------------

  const localHost = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;

  async function readJson(req) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
      chunks.push(c);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Body is not JSON'); }
  }

  function agentOf(req) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const agent = m && keyring.verify(m[1]);
    if (!agent) throw new HttpError(401, 'Missing or unknown key: pair with `flowpilot pair <code>` (code from the dashboard)');
    return agent;
  }

  async function route(req) {
    if (!localHost(req.headers.host)) throw new HttpError(403, 'Wrong Host');
    if (req.headers.origin) throw new HttpError(403, 'Browsers may not call the helper');
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/health') return { ok: true, extension: !!extension };
    if (req.method === 'POST' && path === '/pair') {
      const { code, name } = await readJson(req);
      try { return { key: keyring.redeem(code, name) }; } catch (e) { throw new HttpError(400, e.message); }
    }

    agentOf(req);
    if (req.method === 'GET' && path === '/status') return callExtension('status');
    if (req.method === 'POST' && path === '/jobs') return callExtension('addJob', { spec: (await readJson(req)).spec ?? {} });

    // ---- Entities and prompt composition (report §2.7/§2.8): job data, no credit can be spent by
    // any of these. `projectId` is optional: without it the extension uses the work tab project.
    const q = url.searchParams.get('projectId') ?? undefined;
    if (req.method === 'GET' && path === '/entities') return callExtension('entities', { projectId: q });
    if (req.method === 'GET' && path === '/entities/export') return callExtension('entityExport', { projectId: q });
    if (req.method === 'POST' && path === '/entities') {
      const body = await readJson(req);
      return callExtension('entityUpsert', { projectId: body.projectId ?? q, entity: body.entity, });
    }
    if (req.method === 'POST' && path === '/prompts') {
      const body = await readJson(req);
      return callExtension('composePrompt', { projectId: body.projectId ?? q, spec: body.spec ?? {} });
    }
    const ENTITY_ACTIONS = {
      approve: 'entityApprove', unapprove: 'entityUnapprove', ref: 'entityAddRef', supersede: 'entitySupersede',
      remove: 'entityRemove', style: 'entitySetStyle', import: 'entityImport', restore: 'entityRestore',
    };
    let m = /^\/entities\/([\w-]+)$/.exec(path);
    if (req.method === 'POST' && m && ENTITY_ACTIONS[m[1]]) {
      const body = await readJson(req);
      return callExtension(ENTITY_ACTIONS[m[1]], { ...body, projectId: body.projectId ?? q ?? undefined });
    }

    let j = /^\/jobs\/([\w-]+)$/.exec(path);
    if (req.method === 'GET' && j) {
      const job = (await callExtension('status')).jobs?.find((x) => x.id === j[1]);
      if (!job) throw new HttpError(404, `No job ${j[1]}`);
      return job;
    }
    j = /^\/jobs\/([\w-]+)\/([\w-]+)$/.exec(path);
    if (req.method === 'POST' && j && JOB_ACTIONS[j[2]]) return callExtension(JOB_ACTIONS[j[2]], { id: j[1] });
    throw new HttpError(404, `No such endpoint: ${req.method} ${path}`);
  }

  const server = createServer((req, res) => {
    route(req).then(
      (value) => send(res, 200, value),
      (e) => send(res, e.status ?? 500, { error: e.message }),
    );
  });

  server.on('upgrade', (req, socket, head) => {
    const id = /^chrome-extension:\/\/([a-p]{32})$/.exec(req.headers.origin ?? '');
    const ok = new URL(req.url, 'http://127.0.0.1').pathname === '/bridge'
      && localHost(req.headers.host)
      && id
      && pin.check(id[1]); // trust-on-first-use: only the pinned extension may open the bridge
    if (!ok) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  return {
    listen(p) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, host, () => { port = server.address().port; resolve(port); });
      });
    },
    close() {
      for (const ws of wss.clients) ws.terminate();
      return new Promise((resolve) => server.close(() => resolve()));
    },
    get extensionConnected() { return !!extension; },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
