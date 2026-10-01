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
  mcp                       Run as an MCP server on stdio

Add --json to print raw JSON. The credit cap, clearing a halt and the work tab are dashboard-only.`;

const OPTIONS = {
  name: { type: 'string' }, prompt: { type: 'string' }, kind: { type: 'string' }, resolution: { type: 'string' },
  duration: { type: 'string' }, aspect: { type: 'string' }, count: { type: 'string' }, project: { type: 'string' },
  out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  'forget-extension': { type: 'boolean' },
  ref: { type: 'string', multiple: true }, 'first-frame': { type: 'string' }, 'last-frame': { type: 'string' },
};

class Usage extends Error {}

export async function main(argv, { env = process.env, out = console.log, err = console.error } = {}) {
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
      case 'mcp': { const { runMcp } = await import('./mcp.js'); await runMcp({ client: client() }); return 0; }
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
      case 'doctor': return await doctor(p, client(), out);
      default: throw new Usage(`Unknown command: ${cmd}`);
    }
  } catch (e) {
    if (e instanceof Usage) { err(`${e.message}\n\n${USAGE}`); return 2; }
    err(e.message);
    return 1;
  }
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

async function doctor(p, client, out) {
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
