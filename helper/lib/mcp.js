// `flowpilot mcp`: an MCP server on stdio (newline-delimited JSON-RPC 2.0) whose tools call the
// helper's HTTP API with this machine's paired key. Same powers as the CLI: jobs only; the cap, the
// halt and the work tab stay in the dashboard (docs/SPEC.md decisions 7-9).

import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const id = { type: 'object', properties: { id: { type: 'string', description: 'Job id' } }, required: ['id'], additionalProperties: false };

const TOOLS = [
  {
    name: 'flowpilot_status',
    description: 'Flow Pilot status: session credit cap and spend, halt state, work tab, and every job with its state and saved file.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: (c) => c.status(),
  },
  {
    name: 'flowpilot_job',
    description: 'One job: state (queued, approved, submitting, submitted, rendering, downloading, done, failed, halted, cancelled), cost, error, saved file.',
    inputSchema: id,
    run: (c, a) => c.job(need(a, 'id')),
  },
  {
    name: 'flowpilot_add_job',
    description: 'Queue a Google Flow generation. It waits as "queued" until approved, then runs from the work tab; the result is saved to Downloads/FlowPilot or to outputPath. For face-matched character work, add reference photos: Ingredients (refs) shape the whole video, or Frames (firstFrame + optional lastFrame) generate the video between a start and end photo. Name the project\'s approved entities in `entities` to have their canonical blocks, the style lock and the merged negatives composed into the prompt verbatim (flowpilot_compose_prompt previews the exact text). Returns the job with its expected credit cost.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt, verbatim' },
        name: { type: 'string', description: 'Job and file name' },
        kind: { type: 'string', enum: ['video', 'image'] },
        resolution: { type: 'string', enum: ['360p', '720p'] },
        durationS: { type: 'integer', enum: [4, 6, 8, 10] },
        aspect: { type: 'string', enum: ['16:9', '9:16'] },
        count: { type: 'integer', minimum: 1, maximum: 4 },
        refs: { type: 'array', items: { type: 'string' }, maxItems: 3, description: 'Ingredients: 1-3 reference photos, each a Flow media id or an absolute image path (png/jpeg/webp). Makes a reference-to-video generation.' },
        firstFrame: { type: 'string', description: 'Frames: the start photo (a Flow media id or an absolute image path).' },
        lastFrame: { type: 'string', description: 'Frames: the end photo; the video is generated between firstFrame and lastFrame. Needs firstFrame.' },
        projectId: { type: 'string', description: 'Flow project id; defaults to the work tab project' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Approved entity names or ids from the project library; their canonical blocks are composed into the prompt verbatim' },
        audio: { type: 'string', description: 'SFX/ambience tail for the composed prompt (only used with entities)' },
        outputPath: { type: 'string', description: 'Absolute path for the result (.mp4 for video; .png/.jpg/.webp for image). Never overwrites.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    run: (c, a) => { need(a, 'prompt'); return c.add(a); },
  },
  { name: 'flowpilot_approve', description: 'Approve a queued job so it may spend credits (within the session cap set in the dashboard).', inputSchema: id, run: (c, a) => c.act(need(a, 'id'), 'approve') },
  { name: 'flowpilot_cancel', description: 'Cancel a queued, approved or halted job.', inputSchema: id, run: (c, a) => c.act(need(a, 'id'), 'cancel') },
  { name: 'flowpilot_requeue', description: 'Queue a failed job again; only allowed if it was never clicked.', inputSchema: id, run: (c, a) => c.act(need(a, 'id'), 'requeue') },
  { name: 'flowpilot_retry_download', description: 'Download a failed job\'s finished result again; never generates again.', inputSchema: id, run: (c, a) => c.act(need(a, 'id'), 'retry-download') },

  // ---- Entity library and prompt composition (report §2.7). Job data: allowed for agents, and
  // none of it can spend credits. The cap, the halt and the work tab stay dashboard-only.
  {
    name: 'flowpilot_entity_list',
    description: 'The project\'s consistency library: every entity (character, vehicle, product, location, style) with its kind, version, approval, locked reference media ids and the canonical text block, plus the project template and library warnings. Entities are per Flow project; a character used in two projects needs a second library.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string', description: 'Flow project id; defaults to the work tab project' } }, additionalProperties: false },
    run: (c, a) => c.entities(a.projectId),
  },
  {
    name: 'flowpilot_entity_upsert',
    description: 'Create or update (as a new version) a consistency entity in a project\'s library. The description is the canonical block inserted verbatim into every prompt that uses the entity. A reference must be a locked Flow media id (a local path is not a locked reference: uploading it again would be a new subject). New entities start unapproved; approve before using them in a job.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Flow project id; defaults to the work tab project' },
        name: { type: 'string', description: 'Entity name, e.g. Rudy' },
        kind: { type: 'string', enum: ['character', 'product', 'vehicle', 'location', 'style'] },
        description: { type: 'string', description: 'The canonical block, verbatim (e.g. "CHARACTER — RUDY …")' },
        negative: { type: 'string', description: 'Comma-separated negatives merged into the prompt\'s Negative: line' },
        aliases: { type: 'array', items: { type: 'string' } },
        orientation: { type: 'string', enum: ['portrait', 'landscape', 'square', 'none'] },
        refs: { type: 'array', items: { type: 'object', properties: { mediaId: { type: 'string' }, role: { type: 'string' }, label: { type: 'string' } }, required: ['mediaId'], additionalProperties: false }, description: 'Locked Flow media ids with a unique label per project' },
        approve: { type: 'boolean', description: 'Approve it in the same call' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    run: (c, a) => c.entityUpsert(a.projectId, { ...a, projectId: undefined, approve: a.approve === true }),
  },
  {
    name: 'flowpilot_entity_approve',
    description: 'Approve (or with approve:false, un-approve) an entity so jobs may use it. An unapproved entity is refused by the composer, so nothing can be composed around a subject the person has not seen.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, name: { type: 'string' }, approve: { type: 'boolean' }, reason: { type: 'string' } }, required: ['name'], additionalProperties: false },
    run: (c, a) => (a.approve === false
      ? c.entityAct('unapprove', { projectId: a.projectId, name: a.name, reason: a.reason })
      : c.entityAct('approve', { projectId: a.projectId, name: a.name })),
  },
  {
    name: 'flowpilot_entity_supersede',
    description: 'Replace one locked reference of an entity (e.g. after a QC failure the flat-bronze fix): a new version is created, the old set lands in history with the reason, and nothing is edited in place.',
    inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, name: { type: 'string' }, ref: { type: 'string', description: 'The media id to drop' }, reason: { type: 'string', description: 'Why it is being replaced, e.g. "flat bronze rear half"' } }, required: ['name', 'ref'], additionalProperties: false },
    run: (c, a) => c.entityAct('supersede', { projectId: a.projectId, name: a.name, ref: a.ref, reason: a.reason }),
  },
  {
    name: 'flowpilot_compose_prompt',
    description: 'Compose, without queueing anything, the exact prompt Flow would receive for a shot or a plain job: the base text (verbatim), one canonical block per named entity, the project style lock, and the merged Negative: line — each with its sha256. Use it to check the text before any credits move. Unknown or unapproved entities are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        prompt: { type: 'string', description: 'The base prompt text, written first and verbatim' },
        entities: { type: 'array', items: { type: 'string' }, description: 'Entity names or ids, in the order their blocks should appear' },
        scene: { type: ['integer', 'string'], description: 'Shot number, for the [SHOT n — Ns] header' },
        durationS: { type: 'integer', enum: [4, 6, 8, 10] },
        beat: { type: 'string' }, action: { type: 'string' },
        motion: { type: 'string', description: 'Motion ids joined with + (e.g. anticipation+timing-weight) or a ready motion line' },
        setting: { type: 'string' },
        camera: { type: 'object', properties: { shotType: { type: 'string' }, moveId: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
        audio: { type: 'string', description: 'SFX/ambience tail; the template adds "— no music, no narration"' },
      },
      additionalProperties: false,
    },
    run: (c, a) => c.composePrompt(a.projectId, { ...a, projectId: undefined }),
  },
];

function need(args, key) {
  if (typeof args?.[key] !== 'string' || !args[key]) throw new Error(`"${key}" is required`);
  return args[key];
}

export const TOOL_NAMES = TOOLS.map((t) => t.name);

// Run the real command over stdio and read its `tools/list` — the same handshake Claude Desktop does.
// `initialize` and `tools/list` never touch the helper, so this has no side effects.
export function probeMcpServer({ command = process.execPath, args = [], env = process.env, timeoutMs = 8000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      fn(value);
    };
    timer = setTimeout(() => finish(reject, new Error(`The MCP server did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => finish(reject, new Error('The MCP server exited before it listed its tools')));
    child.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.id !== 2) continue;
        if (m.error) finish(reject, new Error(m.error.message));
        else if (m.result?.tools) finish(resolve, { tools: m.result.tools.map((t) => t.name) });
      }
    });
    const write = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    write({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    child.stdin.end();
  });
}

export function runMcp({ client, input = process.stdin, output = process.stdout }) {
  const write = (m) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);

  async function handle(method, params) {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        return {
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'flowpilot', version: '0.1.0' },
          instructions: 'Queue Google Flow image/video jobs. Add a job, approve it, then poll flowpilot_job until done; the saved file path is in job.file.path. Credit cap and halts are set by the person in the dashboard. For consistent characters, vehicles and locations across clips, keep the project\'s entity library (flowpilot_entity_list) and name approved entities in flowpilot_add_job; flowpilot_compose_prompt shows the exact prompt first.',
        };
      }
      case 'ping': return {};
      case 'tools/list': return { tools: TOOLS.map(({ run, ...t }) => t) };
      case 'tools/call': {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
        try {
          const value = await tool.run(client, params.arguments ?? {});
          return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: e.message }], isError: true };
        }
      }
      default: throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let m;
    try { m = JSON.parse(line); } catch { write({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (m.id == null) return; // notifications (initialized, cancelled) need no answer
    const p = handle(m.method, m.params).then(
      (result) => write({ id: m.id, result }),
      (e) => write({ id: m.id, error: { code: e.code ?? -32603, message: e.message } }),
    ).finally(() => pending.delete(p));
    pending.add(p);
  });
  return new Promise((resolve) => lines.once('close', async () => { await Promise.all(pending); resolve(); }));
}
