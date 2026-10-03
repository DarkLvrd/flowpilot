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
    entities: async (projectId) => { calls.push(['entities', projectId]); return { projectId: projectId ?? 'p1', library: { entities: [{ name: 'Rudy' }] }, warnings: [] }; },
    entityUpsert: async (projectId, entity) => { calls.push(['entityUpsert', projectId, entity]); return { id: 'ent_1', ...entity, version: 1, approvedAt: null }; },
    entityAct: async (action, body) => { calls.push([action, body]); return { id: 'ent_1', name: body.name ?? 'Rudy' }; },
    composePrompt: async (projectId, spec) => { calls.push(['composePrompt', projectId, spec]); return { projectId: projectId ?? 'p1', text: 'x\n\nCHARACTER — RUDY (identical in every shot): a man', parts: [], entities: [{ name: 'Rudy' }] }; },
    shots: async (projectId) => { calls.push(['shots', projectId]); return { projectId: projectId ?? 'p1', shots: [{ id: 'shot_4', gate: { ok: false, problems: ['not approved'] }, videoCost: 7 }] }; },
    shotsImport: async (body) => { calls.push(['importShots', body]); return { format: 'json', shots: 1, totalCost: 7, added: [{ shotId: 'shot_4', stillJobId: 's1', videoCost: 7, warnings: [] }] }; },
    anchor: async (body) => { calls.push(['anchor', body]); return { shot: { id: body.shotId }, approval: { mediaId: 'ffffffff-0000-4000-8000-000000000006' }, video: { id: 'v1', expectedCost: 4 } }; },
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
  assert.deepEqual(names.sort(), ['flowpilot_add_job', 'flowpilot_anchor_still', 'flowpilot_approve', 'flowpilot_cancel', 'flowpilot_compose_prompt', 'flowpilot_entity_approve', 'flowpilot_entity_list', 'flowpilot_entity_supersede', 'flowpilot_entity_upsert', 'flowpilot_import_shots', 'flowpilot_job', 'flowpilot_requeue', 'flowpilot_retry_download', 'flowpilot_shots', 'flowpilot_status']);
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

  // Ingredients and Frames params forward verbatim; the add_job schema advertises them.
  const addTool = (await s.call('tools/list', {})).result.tools.find((t) => t.name === 'flowpilot_add_job');
  for (const p of ['refs', 'firstFrame', 'lastFrame']) assert.ok(addTool.inputSchema.properties[p], `schema advertises ${p}`);
  const ref = await s.call('tools/call', { name: 'flowpilot_add_job', arguments: { prompt: 'face', refs: ['/pics/a.png', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] } });
  assert.equal(ref.result.isError, false);
  assert.deepEqual(client.calls.at(-1), ['add', { prompt: 'face', refs: ['/pics/a.png', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }]);
  await s.call('tools/call', { name: 'flowpilot_add_job', arguments: { prompt: 'tween', firstFrame: '/pics/start.png', lastFrame: '/pics/end.png' } });
  assert.deepEqual(client.calls.at(-1), ['add', { prompt: 'tween', firstFrame: '/pics/start.png', lastFrame: '/pics/end.png' }]);

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

test('the entity tools list, upsert, approve (and un-approve) and supersede a locked reference', async () => {
  const client = fakeClient();
  const s = session(client);
  await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  const listed = await s.call('tools/call', { name: 'flowpilot_entity_list', arguments: { projectId: 'p1' } });
  assert.equal(JSON.parse(listed.result.content[0].text).library.entities[0].name, 'Rudy');
  assert.deepEqual(client.calls.at(-1), ['entities', 'p1']);

  const upserted = await s.call('tools/call', { name: 'flowpilot_entity_upsert', arguments: { projectId: 'p1', kind: 'character', name: 'Rudy', description: 'a heavyset man', refs: [{ mediaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'rudy_sheet_v1' }] } });
  assert.equal(upserted.result.isError, false, JSON.stringify(upserted.result));
  assert.deepEqual(client.calls.at(-1), ['entityUpsert', 'p1', { projectId: undefined, kind: 'character', name: 'Rudy', description: 'a heavyset man', refs: [{ mediaId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', label: 'rudy_sheet_v1' }], approve: false }]);

  await s.call('tools/call', { name: 'flowpilot_entity_approve', arguments: { projectId: 'p1', name: 'Rudy' } });
  assert.deepEqual(client.calls.at(-1), ['approve', { projectId: 'p1', name: 'Rudy' }]);
  await s.call('tools/call', { name: 'flowpilot_entity_approve', arguments: { projectId: 'p1', name: 'Rudy', approve: false, reason: 'bad ref' } });
  assert.deepEqual(client.calls.at(-1), ['unapprove', { projectId: 'p1', name: 'Rudy', reason: 'bad ref' }]);
  await s.call('tools/call', { name: 'flowpilot_entity_supersede', arguments: { projectId: 'p1', name: 'Rudy', ref: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reason: 'flat bronze' } });
  assert.deepEqual(client.calls.at(-1), ['supersede', { projectId: 'p1', name: 'Rudy', ref: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', reason: 'flat bronze' }]);
  await s.end();
});

test('the shot tools list the gate, import stills only, and anchor a finished still', async () => {
  const client = fakeClient();
  const s = session(client);
  await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  const listed = await s.call('tools/call', { name: 'flowpilot_shots', arguments: { projectId: 'p1' } });
  assert.equal(JSON.parse(listed.result.content[0].text).shots[0].id, 'shot_4');
  assert.deepEqual(client.calls.at(-1), ['shots', 'p1']);

  const imported = await s.call('tools/call', { name: 'flowpilot_import_shots', arguments: { projectId: 'p1', text: '[{"scene":4}]' } });
  assert.equal(imported.result.isError, false);
  assert.deepEqual(client.calls.at(-1), ['importShots', { projectId: 'p1', text: '[{"scene":4}]' }]);

  const anchored = await s.call('tools/call', { name: 'flowpilot_anchor_still', arguments: { projectId: 'p1', shotId: 'shot_4', note: 'looks right' } });
  assert.equal(JSON.parse(anchored.result.content[0].text).video.id, 'v1');
  assert.deepEqual(client.calls.at(-1), ['anchor', { projectId: 'p1', shotId: 'shot_4', note: 'looks right' }]);

  const missing = await s.call('tools/call', { name: 'flowpilot_anchor_still', arguments: {} });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /shotId/);
  await s.end();
});

test('flowpilot_compose_prompt previews the text, and add_job advertises entities', async () => {
  const client = fakeClient();
  const s = session(client);
  await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {} });

  const addTool = (await s.call('tools/list', {})).result.tools.find((t) => t.name === 'flowpilot_add_job');
  assert.ok(addTool.inputSchema.properties.entities, 'add_job advertises entities');

  const composed = await s.call('tools/call', { name: 'flowpilot_compose_prompt', arguments: { projectId: 'p1', prompt: 'she turns', entities: ['Rudy'], durationS: 4 } });
  assert.equal(composed.result.isError, false);
  assert.match(composed.result.content[0].text, /CHARACTER — RUDY/);
  assert.deepEqual(client.calls.at(-1), ['composePrompt', 'p1', { projectId: undefined, prompt: 'she turns', entities: ['Rudy'], durationS: 4 }]);
  await s.end();
});
