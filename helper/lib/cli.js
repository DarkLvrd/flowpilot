// `flowpilot` command line. Exit codes: 0 ok, 1 failed, 2 usage error.

import { parseArgs } from 'node:util';
import { createKeyring } from './keys.js';
import { createPin } from './pin.js';
import { createHelper } from './server.js';
import { createClient, paths, readKey, saveKey } from './client.js';

const USAGE = `Usage: flowpilot <command>

  serve [--forget-extension]  Run the helper. --forget-extension clears the pinned extension so the
                            next one to connect is pinned afresh (docs/SPEC.md decision 9)
  pair <code> [--name N]    Pair this machine with the code from the dashboard's "Pair an agent"
  status                    Credits, work tab and the queue
  job <id>                  One job
  add --prompt TEXT [--name N] [--kind video|image] [--resolution 360p|720p]
      [--duration 4|6|8|10] [--aspect 16:9|9:16] [--count 1-4] [--project ID] [--out /abs/path.mp4]
      [--ref REF ...]           Ingredients: reference photo(s) — a Flow media id or an absolute
                                image path (repeat --ref for several); face-matched character work
      [--first-frame REF]       Frames: the start photo (media id or absolute image path)
      [--last-frame REF]        Frames: the end photo; the video is generated in between
  approve|cancel|requeue|retry-download <id>
  doctor                    Check the setup
  install-claude [--config PATH]
                            Add (or update) the Flow Pilot server in your Claude Desktop config,
                            backing the file up first; --config writes elsewhere
  mcp                       Run as an MCP server on stdio (starts the helper itself if it is not
                            already running, and stops only the one it started)

Add --json to print raw JSON. The credit cap, clearing a halt and the work tab are dashboard-only.`;

const OPTIONS = {
  name: { type: 'string' }, prompt: { type: 'string' }, kind: { type: 'string' }, resolution: { type: 'string' },
  duration: { type: 'string' }, aspect: { type: 'string' }, count: { type: 'string' }, project: { type: 'string' },
  out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  'forget-extension': { type: 'boolean' },
  config: { type: 'string' },
  ref: { type: 'string', multiple: true }, 'first-frame': { type: 'string' }, 'last-frame': { type: 'string' },
};

class Usage extends Error {}

export async function main(argv, { env = process.env, out = console.log, err = console.error, input = process.stdin, output = process.stdout, probeMcp } = {}) {
  let args;
  try {
    args = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  const { values: o, positionals: [cmd, ...rest] } = args;
  if (!cmd || o.help) { out(USAGE); return cmd || o.help ? 0 : 2; }

  const p = paths(env);
  const client = () => createClient({ port: p.port, key: readKey(p) });
  const needKey = () => { if (!readKey(p)) throw new Error('Not paired yet: click "Pair an agent" in the Flow Pilot dashboard, then run `flowpilot pair <code>`'); };
  const print = (value, human) => out(o.json ? JSON.stringify(value, null, 2) : human(value));
  const id = () => { if (!rest[0]) throw new Usage(`${cmd} needs a job id`); return rest[0]; };

  try {
    switch (cmd) {
      case 'serve': return await serve(p, out, { forgetExtension: o['forget-extension'] });
      case 'mcp': return await mcp(p, env, err, { input, output });
      case 'install-claude': return await installClaude(p, o, out, env);
      case 'pair': {
        if (!rest[0]) throw new Usage('pair needs the code from the dashboard');
        saveKey(p, await client().pair(rest[0], o.name ?? 'cli'));
        out(`Paired. Key saved to ${p.key} (only you can read it).`);
        return 0;
      }
      case 'status': needKey(); print(await client().status(), formatStatus); return 0;
      case 'job': needKey(); print(await client().job(id()), formatJob); return 0;
      case 'add': {
        if (!o.prompt) throw new Usage('add needs --prompt');
        needKey();
        const spec = Object.fromEntries(Object.entries({
          name: o.name, prompt: o.prompt, kind: o.kind, resolution: o.resolution,
          durationS: o.duration && Number(o.duration), aspect: o.aspect, count: o.count && Number(o.count),
          projectId: o.project, outputPath: o.out,
          refs: o.ref, firstFrame: o['first-frame'], lastFrame: o['last-frame'],
        }).filter(([, v]) => v !== undefined));
        print(await client().add(spec), (j) => `Added ${j.id} (${j.state}, ${j.expectedCost ?? '?'} credits). Approve it with \`flowpilot approve ${j.id}\`.`);
        return 0;
      }
      case 'approve': case 'cancel': case 'requeue': case 'retry-download':
        needKey(); print(await client().act(id(), cmd), formatJob); return 0;
      case 'doctor': return await doctor(p, client(), out, { env, probeMcp, config: o.config });
      default: throw new Usage(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof Usage) { err(`${e.message}\n\n${USAGE}`); return 2; }
    err(e.message);
    return 1;
  }
}

async function mcp(p, env, err, { input, output } = {}) {
  const { runMcp } = await import('./mcp.js');
  const { createAutoStart } = await import('./autostart.js');
  // One owner per helper: `ensure` reuses a helper already on the port and only ever starts (and
  // later stops) one of its own, so an MCP server never fights `flowpilot serve` or another one.
  const helper = createAutoStart({ port: p.port, env, log: (m) => err(`[helper] ${m}`) });
  const real = createClient({ port: p.port, key: () => readKey(p) });
  const withHelper = async (fn) => { await helper.ensure(); return fn(real); };
  const client = {
    health: () => withHelper(() => real.health()),
    pair: (code, name) => withHelper(() => real.pair(code, name)),
    status: () => withHelper(() => real.status()),
    job: (id) => withHelper(() => real.job(id)),
    add: (spec) => withHelper(() => real.add(spec)),
    act: (id, action) => withHelper(() => real.act(id, action)),
  };
  const onSignal = () => { helper.stopNow(); process.exit(0); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await runMcp({ client, input, output });
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    await helper.stop();
  }
  return 0;
}

async function installClaude(p, o, out, env) {
  const { installClaudeDesktop, buildServerEntry, defaultConfigPath, checkNode } = await import('./claude-desktop.js');
  checkNode(); // a missing or too-old Node gets a clear message here, not a broken server in Claude
  const file = o.config || defaultConfigPath({ env });
  const result = installClaudeDesktop({ file, entry: buildServerEntry({ env }) });
  if (o.json) { out(JSON.stringify(result, null, 2)); return 0; }
  out(describeInstall(result, p));
  return 0;
}

function describeInstall({ file, backup, changed, previous, entry }, p) {
  const lines = [`Claude Desktop config: ${file}`];
  if (backup) lines.push(`Backup saved:          ${backup}`);
  if (!changed) lines.push('Unchanged:             mcpServers.flowpilot already points at this install.');
  else if (previous) lines.push(`Updated mcpServers.flowpilot:\n  was: ${JSON.stringify(previous)}\n  now: ${JSON.stringify(entry)}`);
  else lines.push(`Added mcpServers.flowpilot: ${JSON.stringify(entry)}`);
  lines.push(
    '',
    'Next steps:',
    '  1. Restart Claude Desktop so it loads the new server.',
    '  2. In the Flow Pilot dashboard, click "Pair an agent" and copy the one-time code,',
    '     then run:  flowpilot pair <CODE>',
    `     The key is saved owner-only in ${p.key}; only jobs and results cross the bridge, never cookies or tokens.`,
    '  3. Flow Pilot needs the extension installed in your Chromium browser and a Flow work tab',
    '     chosen in the popup before any job can run.',
    '  4. In Claude, try: "Use flowpilot_status to show my Flow Pilot queue."',
  );
  return lines.join('\n');
}

async function serve(p, out, { forgetExtension = false } = {}) {
  const keyring = createKeyring({ file: p.agents });
  const pin = createPin({ file: p.extension });
  if (forgetExtension) { pin.forget(); out('Forgot the pinned extension: the next one to connect will be pinned.'); }
  const helper = createHelper({ keyring, pin, log: (m) => out(`${new Date().toLocaleTimeString()} ${m}`) });
  try {
    await helper.listen(p.port);
  } catch (e) {
    throw new Error(e.code === 'EADDRINUSE' ? `Port ${p.port} is taken: is the helper already running?` : e.message);
  }
  out(`Flow Pilot helper on http://127.0.0.1:${p.port} (Ctrl-C to stop). Waiting for the extension…`);
  await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  await helper.close();
  return 0;
}

async function doctor(p, client, out, { env = process.env, probeMcp, config } = {}) {
  const rows = [];
  const add = (ok, what, hint) => rows.push(`${ok ? '✅' : '❌'} ${what}${!ok && hint ? `: ${hint}` : ''}`);
  const [major] = process.versions.node.split('.').map(Number);
  add(major >= 20, `Node ${process.versions.node}`, 'Node 20 or newer is needed');
  const health = await client.health().catch(() => null);
  add(!!health, `Helper running on 127.0.0.1:${p.port}`, 'run `npx flowpilot serve`');
  add(!!health?.extension, 'Extension connected', 'open Chrome with Flow Pilot loaded; it connects within 30 s');
  const pinned = createPin({ file: p.extension }).get();
  if (pinned) add(true, `Extension pinned (${pinned})`);
  const key = readKey(p);
  let status = null;
  if (key && health?.extension) status = await client.status().catch(() => null);
  add(!!key && (status != null || !health?.extension), 'Paired', key ? 'the key was not accepted: pair again' : 'dashboard → "Pair an agent", then `flowpilot pair <code>`');
  if (status) {
    add(!!status.workTab, 'Work tab chosen', 'open a Flow project and click "Use this tab" in the popup');
    add(status.session?.cap != null, 'Credit cap set', 'set it in the dashboard');
    add(!status.session?.halted, 'Not halted', status.session?.haltReason);
  }

  // MCP: the exact command `install-claude` writes, and the config Claude Desktop reads.
  const { buildServerEntry, defaultConfigPath, inspectConfig } = await import('./claude-desktop.js');
  const { TOOL_NAMES, probeMcpServer } = await import('./mcp.js');
  const entry = buildServerEntry({ env });
  let tools = null;
  let mcpError = null;
  try {
    const probe = probeMcp ?? (() => probeMcpServer({ command: entry.command, args: entry.args, env: { ...process.env, ...(entry.env ?? {}) } }));
    tools = (await probe()).tools ?? [];
  } catch (e) { mcpError = e.message; }
  add(tools != null, `MCP server command works (${entry.command} ${entry.args.join(' ')})`, mcpError ?? 'the server did not answer');
  const list = (names) => [...names].sort().join(',');
  add(tools != null && list(tools) === list(TOOL_NAMES), `MCP tools (${TOOL_NAMES.length})`, tools == null ? 'no tools list' : `got: ${tools.join(', ') || 'none'}`);
  const cfg = inspectConfig({ file: config || defaultConfigPath({ env }), entry });
  const cfgHint = {
    missing: 'no config file: run `flowpilot install-claude`',
    unreadable: 'the file is not valid JSON',
    'no-server': 'no flowpilot entry: run `flowpilot install-claude`',
    different: 'points elsewhere: run `flowpilot install-claude`',
  }[cfg.reason];
  add(cfg.ok, `Claude Desktop config (${cfg.file})`, cfgHint);
  out(rows.join('\n'));
  return rows.every((r) => r.startsWith('✅')) ? 0 : 1;
}

function formatStatus(s) {
  const lines = [
    `Work tab: ${s.workTab ? `project ${s.workTab.projectId}` : 'none'} · Credits this session: ${s.session.spent} / ${s.session.cap ?? 'no cap'}`,
  ];
  if (s.session.halted) lines.push(`⛔ Halted: ${s.session.haltReason}`);
  if (s.lastTick?.waiting) lines.push(`⏳ ${s.lastTick.waiting}`);
  for (const j of s.jobs ?? []) lines.push(formatJob(j));
  if (!s.jobs?.length) lines.push('No jobs.');
  return lines.join('\n');
}

function formatJob(j) {
  const extra = j.file?.path ? ` → ${j.file.path}` : j.error ? ` (${j.error})` : '';
  return `${j.id}  ${(j.state ?? '').padEnd(11)} ${j.name ?? ''}${extra}`;
}
