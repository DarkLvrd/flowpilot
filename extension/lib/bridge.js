// The extension's end of the helper bridge (helper/lib/server.js has the message format). The
// extension connects out to the helper on 127.0.0.1; the helper never reaches into the browser.
// Optional: without a running helper, everything but agent access and absolute output paths works.
// Chrome keeps the service worker alive while the socket is active (Chrome 116+), so a ping every
// 20 s holds it open; if the helper is down, the next alarm tick calls start() again.

export const HELPER_PORT = 47615;
const PING_MS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;

// openSocket(url) → a WebSocket-like object; onCommand(cmd, args) → value (throws to refuse).
export function createBridge({ url, openSocket = (u) => new WebSocket(u), onCommand, onChange = () => {} }) {
  let ws = null;
  let open = false;
  let ping = null;
  let rid = 0;
  const waiting = new Map();

  function setOpen(value) {
    if (open === value) return;
    open = value;
    onChange(value);
  }

  function dropped() {
    clearInterval(ping);
    ws = null;
    setOpen(false);
    for (const [id, w] of waiting) { clearTimeout(w.timer); w.reject(new Error('The helper disconnected')); waiting.delete(id); }
  }

  async function onMessage(event) {
    let m;
    try { m = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data)); } catch { return; }
    if (m.rid != null) {
      const w = waiting.get(m.rid);
      if (!w) return;
      waiting.delete(m.rid);
      clearTimeout(w.timer);
      m.ok ? w.resolve(m.value) : w.reject(new Error(m.error));
      return;
    }
    if (m.id == null || !m.cmd) return;
    let reply;
    try { reply = { id: m.id, ok: true, value: await onCommand(m.cmd, m.args ?? {}) }; } catch (e) { reply = { id: m.id, ok: false, error: e.message }; }
    ws?.send(JSON.stringify(reply));
  }

  return {
    get connected() { return open; },

    // Connects unless already connected or connecting. Safe to call on every tick.
    start() {
      if (ws) return;
      let socket;
      try { socket = openSocket(url); } catch { return; }
      ws = socket;
      socket.addEventListener('open', () => {
        if (ws !== socket) return;
        setOpen(true);
        ping = setInterval(() => this.request('ping').catch(() => {}), PING_MS);
      });
      socket.addEventListener('message', (e) => { if (ws === socket) onMessage(e); });
      socket.addEventListener('close', () => { if (ws === socket) dropped(); });
      socket.addEventListener('error', () => {}); // a close always follows
    },

    stop() {
      const socket = ws;
      dropped();
      socket?.close();
    },

    // Asks the helper for something (pairCode, writeFile, ping).
    request(req, extra = {}) {
      if (!open) return Promise.reject(new Error('The Flow Pilot helper is not running: start it with `npx flowpilot serve`'));
      const id = ++rid;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`The helper did not answer "${req}" within 30 s`)); }, REQUEST_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ rid: id, req, ...extra }));
      });
    },
  };
}
