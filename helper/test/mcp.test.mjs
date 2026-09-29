import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runMcp } from '../lib/mcp.js';

// Talks to the MCP server over in-memory stdio: newline-delimited JSON-RPC 2.0.
function session(client) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runMcp({ client, input, output });
  const replies = new Map();
  let buf = '';
  output.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id;
    replies.set(n, resolve);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const notify = (method) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { call, notify, end: async () => { input.end(); await done; } };
}

function fakeClient() {
  const calls = [];
  return {
    calls,
    status: async () => ({ session: { cap: 10, spent: 0 }, jobs: [] }),
    job: async (id) => ({ id, state: 'rendering' }),
    add: async (spec) => { calls.push(['add', spec]); return { id: 'j1', state: 'queued', expectedCost: 4 }; },
    act: async (id, action) => { calls.push([action, id]); if (id === 'bad') throw new Error('Cannot approve a job that is done'); return { id, state: 'approved' }; },
  };
}

test('initializes and lists the Flow Pilot tools; none can set the cap or clear a halt', async () => {
  const s = session(fakeClient());
  const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.ok(init.result.capabilities.tools);
  s.notify('notifications/initialized');
  const { result: { tools } } = await s.call('tools/list', {});
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), ['flowpilot_add_job', 'flowpilot_approve', 'flowpilot_cancel', 'flowpilot_job', 'flowpilot_requeue', 'flowpilot_retry_download', 'flowpilot_status']);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
  assert.ok(!names.some((n) => /cap|halt|tab/.test(n)));
  await s.end();
});

test('tools call the helper and return its answer as JSON text; failures are tool errors, not protocol errors', async () => {
  const client = fakeClient();
  const s = session(client);
  await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
  const added = await s.call('tools/call', { name: 'flowpilot_add_job', arguments: { prompt: 'a red fox', kind: 'video', durationS: 4, outputPath: '/Users/me/fox.mp4' } });
  assert.equal(added.result.isError, false);
  assert.equal(JSON.parse(added.result.content[0].text).id, 'j1');
  assert.deepEqual(client.calls[0], ['add', { prompt: 'a red fox', kind: 'video', durationS: 4, outputPath: '/Users/me/fox.mp4' }]);

  await s.call('tools/call', { name: 'flowpilot_retry_download', arguments: { id: 'j1' } });
  assert.deepEqual(client.calls[1], ['retry-download', 'j1']);

  const bad = await s.call('tools/call', { name: 'flowpilot_approve', arguments: { id: 'bad' } });
  assert.equal(bad.result.isError, true);
  assert.match(bad.result.content[0].text, /Cannot approve/);

  const missing = await s.call('tools/call', { name: 'flowpilot_approve', arguments: {} });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /id/);

  assert.equal((await s.call('tools/call', { name: 'flowpilot_set_cap', arguments: {} })).error.code, -32602);
  assert.equal((await s.call('resources/list', {})).error.code, -32601);
  assert.deepEqual((await s.call('ping', {})).result, {});
  await s.end();
});
