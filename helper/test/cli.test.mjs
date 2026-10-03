import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { createKeyring } from '../lib/keys.js';
import { createPin } from '../lib/pin.js';
import { createHelper } from '../lib/server.js';
import { main } from '../lib/cli.js';
import { buildServerEntry } from '../lib/claude-desktop.js';

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

// A finished clip's QC record, as the extension keeps one (report §2.6).
const QC_RECORD = {
  checkedAt: 1790000000000, by: 'human',
  checks: { technical: 'pass', identity: 'pass', wardrobe: 'fail', location: 'pass', artefacts: 'pass', style: 'pass' },
  verdict: 'regen', note: 'rear half of the car went flat bronze after 2s',
};

// Every world registers itself: a failing assertion must never leave this file's helper server or
// bridge socket open, because one leaked handle keeps the whole `node --test` process alive (the
// suite then looks hung even though every test printed a result).
const worlds = [];
const closeWorlds = async () => { await Promise.all(worlds.map((w) => w.close())); };
after(closeWorlds);

async function world({ extension = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fp-cli-'));
  const keyring = createKeyring({ file: join(home, 'agents.json') });
  const pin = createPin({ file: join(home, 'extension.json') });
  const helper = createHelper({ keyring, pin });
  const port = await helper.listen(0);
  const calls = [];
  let ws;
  if (extension) {
    ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`, { origin: EXT });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (!m.cmd) return;
      calls.push([m.cmd, m.args]);
      const value = m.cmd === 'status'
        ? { session: { cap: 10, spent: 4, halted: false }, workTab: { projectId: 'p1' }, jobs: [
          { id: 'j1', name: 'fox', state: 'done', file: { path: '/x/fox.mp4' } },
          { id: 'j2', name: 'car', state: 'done', file: { path: '/x/car.mp4' }, qc: QC_RECORD },
        ] }
        : m.cmd === 'shots'
          ? { projectId: 'p1', shots: [{ id: 'shot_4', scene: 4, mode: 'ingredients', gate: { ok: false, problems: ['not approved'] }, stillJob: { id: 's1', state: 'rendering' }, videoCost: 7 }] }
          : m.cmd === 'importShots'
            ? { format: 'json', totalCost: 7, shots: 1, added: [{ shotId: 'shot_4', stillJobId: 's1', videoCost: 7, warnings: ['Rufus is not approved'] }] }
            : m.cmd === 'queueStill'
              ? { shot: { id: m.args.shotId }, still: { id: 's2', expectedCost: 0 } }
              : m.cmd === 'approveAnchor'
                ? { shot: { id: m.args.shotId }, approval: { mediaId: 'ffffffff-0000-4000-8000-000000000006', frame: 'start' }, video: { id: 'v1', expectedCost: 4 } }
                : m.cmd === 'qcSet'
                  ? { id: m.args.id, state: 'done', qc: { checkedAt: 1790000000000, by: 'agent', checks: { technical: 'pass', ...m.args.checks }, verdict: Object.values(m.args.checks).includes('fail') ? 'regen' : 'approved', note: m.args.note ?? null } }
                  : m.cmd === 'qcFix'
                    ? { check: m.args.check, action: 'appendConsistencyBlock', reason: `QC fix (${m.args.check})`, cost: '0 credits now: a still is free, then +1 video once it is approved', still: { id: 's9', expectedCost: 0, settings: { kind: 'image' } }, video: null }
                    : { id: m.args.id ?? 'j2', state: m.cmd === 'addJob' ? 'queued' : 'approved', expectedCost: 4 };
      ws.send(JSON.stringify({ id: m.id, ok: true, value }));
    });
    await new Promise((r) => ws.once('open', r));
  }
  const env = { FLOWPILOT_HOME: home, FLOWPILOT_PORT: String(port), FLOWPILOT_CLAUDE_CONFIG: join(home, 'claude_desktop_config.json') };
  const runWith = async (opts, ...argv) => {
    const out = [];
    const code = await main(argv, { env, out: (s) => out.push(s), err: (s) => out.push(s), ...opts });
    return { code, text: out.join('\n') };
  };
  const run = (...argv) => runWith({}, ...argv);
  const close = async () => { ws?.close(); await helper.close(); };
  const w = { home, env, keyring, run, runWith, calls, close };
  worlds.push(w);
  return w;
}

test('pair stores the key for the owner only; later commands use it', async () => {
  const w = await world();
  assert.match((await w.run('status')).text, /not paired/i);
  const r = await w.run('pair', w.keyring.newCode().code, '--name', 'claude');
  assert.equal(r.code, 0, r.text);
  const keyFile = join(w.home, 'key');
  assert.equal(statSync(keyFile).mode & 0o077, 0);
  assert.match(readFileSync(keyFile, 'utf8'), /^fp_/);

  const s = await w.run('status');
  assert.equal(s.code, 0, s.text);
  assert.match(s.text, /4 \/ 10/);
  assert.match(s.text, /fox/);
  await w.close();
});

test('add, approve, cancel and job forward to the extension; --json prints raw JSON', async () => {
  const w = await world();
  await w.run('pair', w.keyring.newCode().code);
  const added = await w.run('add', '--prompt', 'a red fox', '--kind', 'video', '--resolution', '360p', '--duration', '4', '--out', '/Users/me/fox.mp4', '--json');
  assert.equal(added.code, 0, added.text);
  assert.equal(JSON.parse(added.text).id, 'j2');
  assert.deepEqual(w.calls.at(-1), ['addJob', { spec: { prompt: 'a red fox', kind: 'video', resolution: '360p', durationS: 4, outputPath: '/Users/me/fox.mp4' } }]);

  await w.run('approve', 'j2');
  await w.run('cancel', 'j2');
  assert.deepEqual(w.calls.slice(-2), [['approve', { id: 'j2' }], ['cancel', { id: 'j2' }]]);
  assert.match((await w.run('job', 'j1')).text, /done/);
  await w.close();
});

test('add forwards Ingredients (--ref, repeatable) and Frames (--first-frame/--last-frame)', async () => {
  const w = await world();
  await w.run('pair', w.keyring.newCode().code);
  await w.run('add', '--prompt', 'face', '--ref', '/pics/a.png', '--ref', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--json');
  assert.deepEqual(w.calls.at(-1), ['addJob', { spec: { prompt: 'face', refs: ['/pics/a.png', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] } }]);
  await w.run('add', '--prompt', 'tween', '--first-frame', '/pics/start.png', '--last-frame', '/pics/end.png', '--json');
  assert.deepEqual(w.calls.at(-1), ['addJob', { spec: { prompt: 'tween', firstFrame: '/pics/start.png', lastFrame: '/pics/end.png' } }]);
  await w.close();
});

test('errors are short and the exit code is non-zero', async () => {
  const w = await world({ extension: false });
  await w.run('pair', w.keyring.newCode().code);
  const r = await w.run('status');
  assert.equal(r.code, 1);
  assert.match(r.text, /extension is not connected/);
  assert.equal((await w.run('add')).code, 2); // no prompt
  assert.equal((await w.run('fly')).code, 2);
  await w.close();
});

test('shots list/import, still and anchor forward to the extension (§2.3-§2.5)', async () => {
  const w = await world();
  await w.run('pair', w.keyring.newCode().code);

  const list = await w.run('shots', 'list', '--project', 'p1');
  assert.equal(list.code, 0, list.text);
  assert.match(list.text, /shot_4/);
  assert.match(list.text, /🟡 still not approved/);
  assert.deepEqual(w.calls.at(-1), ['shots', { projectId: 'p1' }]);

  const file = join(w.home, 'shots.json');
  writeFileSync(file, JSON.stringify([{ scene: 4, entities: ['Rudy'] }]));
  const imported = await w.run('shots', 'import', '--project', 'p1', '--file', file);
  assert.equal(imported.code, 0, imported.text);
  assert.equal(w.calls.at(-1)[0], 'importShots');
  assert.equal(w.calls.at(-1)[1].filename, file);
  assert.match(imported.text, /still job s1/);
  assert.match(imported.text, /Rufus is not approved/);

  const still = await w.run('still', 'shot_4', '--project', 'p1', '--json');
  assert.equal(JSON.parse(still.text).still.id, 's2');
  assert.deepEqual(w.calls.at(-1), ['queueStill', { projectId: 'p1', shotId: 'shot_4' }]);

  const mediaId = 'ffffffff-0000-4000-8000-000000000006';
  const anchor = await w.run('anchor', 'shot_4', '--project', 'p1', '--media', mediaId, '--note', 'looks right', '--json');
  assert.equal(anchor.code, 0, anchor.text);
  const call = w.calls.at(-1);
  assert.equal(call[0], 'approveAnchor');
  assert.deepEqual({ ...call[1], frame: undefined }, { projectId: 'p1', shotId: 'shot_4', mediaId, note: 'looks right', frame: undefined });

  assert.equal((await w.run('shots')).code, 0); // defaults to list
  assert.equal((await w.run('still')).code, 2); // needs a shot id
  assert.equal((await w.run('anchor')).code, 2);
  assert.equal((await w.run('shots', 'fly')).code, 2);
  await w.close();
});

test('qc reads a clip\'s record, records a verdict and offers the fix (§2.6)', async () => {
  const w = await world();
  await w.run('pair', w.keyring.newCode().code);

  // Read: the record the extension kept, with the fix it implies and what that costs.
  const read = await w.run('qc', 'j2');
  assert.equal(read.code, 0, read.text);
  assert.match(read.text, /by human/);
  assert.match(read.text, /verdict: regen/);
  assert.match(read.text, /❌ wardrobe/);
  assert.match(read.text, /flat bronze/);
  assert.match(read.text, /appendConsistencyBlock/);
  assert.match(read.text, /0 credits now/);

  const unreviewed = await w.run('qc', 'j1');
  assert.equal(unreviewed.code, 0, unreviewed.text);
  assert.match(unreviewed.text, /No QC verdict yet/i);
  assert.match(unreviewed.text, /--identity pass/);

  // Record: the five visible checks go to the extension; technical is never asked for.
  const recorded = await w.run('qc', 'j1', '--identity', 'pass', '--wardrobe', 'pass', '--location', 'pass', '--artefacts', 'fail', '--style', 'pass', '--note', 'a watermark appeared', '--json');
  assert.equal(recorded.code, 0, recorded.text);
  assert.deepEqual(w.calls.at(-1), ['qcSet', { id: 'j1', checks: { identity: 'pass', wardrobe: 'pass', location: 'pass', artefacts: 'fail', style: 'pass' }, note: 'a watermark appeared' }]);
  assert.equal(JSON.parse(recorded.text).qc.verdict, 'regen');

  // A fix is a click: it queues the next job and says what that costs.
  const fixed = await w.run('qc', 'j2', '--fix', 'wardrobe');
  assert.equal(fixed.code, 0, fixed.text);
  assert.deepEqual(w.calls.at(-1), ['qcFix', { id: 'j2', check: 'wardrobe' }]);
  assert.match(fixed.text, /s9/);
  assert.match(fixed.text, /0 credits now/);
  assert.match(fixed.text, /failed take stays on disk/);

  // Usage errors, not silent half-verdicts.
  assert.equal((await w.run('qc')).code, 2);
  assert.equal((await w.run('qc', 'j1', '--fix')).code, 2);
  assert.equal((await w.run('qc', 'j1', '--identity', 'maybe')).code, 2);
  assert.equal((await w.run('qc', 'j1', '--identity', 'pass')).code, 2); // the other four are missing
  await w.close();
});

test('doctor reports each part of the setup', async () => {
  const w = await world();
  // The published MCP surface, stated explicitly so a rename or a removal fails here: the seven job
  // tools plus the five entity-library/prompt-composition tools (report §2.7, Phase 1) and the three
  // shot/gate tools (Phase 2). doctor's own check is that the server advertises exactly what mcp.js
  // publishes.
  const { TOOL_NAMES } = await import('../lib/mcp.js');
  const expected = [
    'flowpilot_status', 'flowpilot_job', 'flowpilot_add_job', 'flowpilot_approve', 'flowpilot_cancel', 'flowpilot_requeue', 'flowpilot_retry_download',
    'flowpilot_entity_list', 'flowpilot_entity_upsert', 'flowpilot_entity_approve', 'flowpilot_entity_supersede', 'flowpilot_compose_prompt',
    'flowpilot_characters',
    'flowpilot_shots', 'flowpilot_import_shots', 'flowpilot_anchor_still', 'flowpilot_review',
  ];
  assert.deepEqual([...TOOL_NAMES].sort(), [...expected].sort());
  const tools = [...TOOL_NAMES];
  const probeMcp = async () => ({ tools });
  writeFileSync(w.env.FLOWPILOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: { flowpilot: buildServerEntry({ env: w.env }) } }));
  let r = await w.runWith({ probeMcp }, 'doctor');
  assert.equal(r.code, 1);
  assert.match(r.text, /✅ .*Helper running/);
  assert.match(r.text, /✅ .*Extension connected/);
  assert.match(r.text, /✅ .*MCP server command works/);
  assert.match(r.text, /✅ .*MCP tools/);
  assert.match(r.text, /✅ .*Claude Desktop config/);
  assert.match(r.text, /❌ .*Paired/);
  await w.run('pair', w.keyring.newCode().code);
  r = await w.runWith({ probeMcp }, 'doctor');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /✅ .*Work tab/);
  assert.match(r.text, new RegExp(`Extension pinned.*${EXT_ID}`)); // reports the pinned id
  await w.close();
});

test('doctor flags an MCP server that will not answer, a wrong tool list, and a missing or stale Claude config', async () => {
  const w = await world();
  await w.run('pair', w.keyring.newCode().code);

  let r = await w.runWith({ probeMcp: async () => { throw new Error('the MCP server did not answer within 8 s'); } }, 'doctor');
  assert.equal(r.code, 1);
  assert.match(r.text, /❌ .*MCP server command works.*did not answer/s);
  assert.match(r.text, /❌ .*MCP tools/);

  r = await w.runWith({ probeMcp: async () => ({ tools: ['flowpilot_status', 'flowpilot_delete_everything'] }) }, 'doctor');
  assert.equal(r.code, 1);
  assert.match(r.text, /✅ .*MCP server command works/);
  assert.match(r.text, /❌ .*MCP tools.*flowpilot_delete_everything/s);

  assert.match(r.text, /❌ .*Claude Desktop config.*install-claude/s); // no config file yet
  writeFileSync(w.env.FLOWPILOT_CLAUDE_CONFIG, JSON.stringify({ mcpServers: { flowpilot: { command: '/somewhere/else/node', args: ['/old/flowpilot.js', 'mcp'] } } }));
  r = await w.runWith({ probeMcp: async () => ({ tools: [] }) }, 'doctor');
  assert.match(r.text, /❌ .*Claude Desktop config.*install-claude/s);
  await w.close();
});

test('serve --forget-extension clears the pinned extension and reports it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fp-cli-'));
  const extFile = join(home, 'extension.json');
  writeFileSync(extFile, JSON.stringify({ id: EXT_ID }));
  const env = { FLOWPILOT_HOME: home, FLOWPILOT_PORT: '0' };
  const out = [];
  const done = main(['serve', '--forget-extension'], { env, out: (s) => out.push(s), err: (s) => out.push(s) });
  await new Promise((r) => setTimeout(r, 50)); // serve forgets the pin, then starts listening
  assert.ok(!existsSync(extFile));
  process.emit('SIGINT'); // stop the helper we started
  assert.equal(await done, 0);
  assert.match(out.join('\n'), /forgot the pinned extension/i);
});
