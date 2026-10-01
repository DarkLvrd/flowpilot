// `flowpilot mcp`: an MCP server on stdio (newline-delimited JSON-RPC 2.0) whose tools call the
// helper's HTTP API with this machine's paired key. Same powers as the CLI: jobs only; the cap, the
// halt and the work tab stay in the dashboard (docs/SPEC.md decisions 7-9).

import { createInterface } from 'node:readline';

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
    description: 'Queue a Google Flow generation. It waits as "queued" until approved, then runs from the work tab; the result is saved to Downloads/FlowPilot or to outputPath. For face-matched character work, add reference photos: Ingredients (refs) shape the whole video, or Frames (firstFrame + optional lastFrame) generate the video between a start and end photo. Returns the job with its expected credit cost.',
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
];

function need(args, key) {
  if (typeof args?.[key] !== 'string' || !args[key]) throw new Error(`"${key}" is required`);
  return args[key];
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
          instructions: 'Queue Google Flow image/video jobs. Add a job, approve it, then poll flowpilot_job until done; the saved file path is in job.file.path. Credit cap and halts are set by the person in the dashboard.',
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
