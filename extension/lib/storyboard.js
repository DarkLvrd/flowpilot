// Storyboard / batch import: parse a JSON or CSV storyboard (or a pasted list), map each row onto
// the job model and plan the batch — per-row errors, per-row cost and the batch total — before a
// single job is queued (docs/SPEC.md decisions 3 and 8). Pure: the service worker queues the built
// jobs and the dashboard renders the preview. Every row goes through lib/jobspec.js buildJob, the
// same validation addJob uses, so a batch is never accepted on weaker terms than a hand-added job.

import { buildJob } from './jobspec.js';
import { uniquify } from './naming.js';
import { applyPresetToSpec } from './presets.js';

export function detectFormat(text, filename = '') {
  const ext = /\.([a-z0-9]+)$/i.exec(String(filename))?.[1]?.toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'csv') return 'csv';
  const t = String(text ?? '').trimStart();
  if (t === '') return null;
  return t[0] === '[' || t[0] === '{' ? 'json' : 'csv';
}

export function parseStoryboard(text, { filename = '' } = {}) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('The storyboard is empty');
  const format = detectFormat(text, filename);
  if (format === 'json') return { format, rows: parseJson(text) };
  if (format === 'csv') {
    const rows = parseCsv(text);
    const keys = Object.keys(rows[0] ?? {}).map(normKey);
    if (!keys.includes('prompt') && !keys.includes('scene')) {
      throw new Error('A CSV storyboard needs a "prompt" or "scene" column in its header row');
    }
    return { format, rows };
  }
  throw new Error('Cannot tell whether this storyboard is JSON or CSV; name the file .json or .csv, or start JSON with [ or {');
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e.message}`);
  }
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === 'object') {
    list = data.scenes ?? data.jobs ?? data.storyboard;
    if (!Array.isArray(list)) throw new Error('A JSON storyboard must be an array of rows, or an object with a "scenes" or "jobs" array');
  } else {
    throw new Error('A JSON storyboard must be an array of rows, or an object with a "scenes" or "jobs" array');
  }
  if (list.length === 0) throw new Error('The storyboard has no rows');
  return list.map((r, i) => {
    if (typeof r === 'string') return { prompt: r };
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`Row ${i + 1} is not an object`);
    return r;
  });
}

// Minimal RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF.
export function parseCsv(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('The CSV is empty');
  const table = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); table.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); table.push(row); }
  const rows = table.filter((r) => r.some((f) => String(f).trim() !== ''));
  if (rows.length === 0) throw new Error('The CSV is empty');
  const header = rows[0].map((h) => String(h).trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

// Column aliases (case/space/underscore/hyphen-insensitive) → the canonical row field.
const ALIASES = {
  scene: 'scene', shot: 'scene',
  name: 'name', job: 'name', jobname: 'name', title: 'name',
  prompt: 'prompt', text: 'prompt',
  kind: 'kind', type: 'kind',
  mode: 'input', input: 'input',
  resolution: 'resolution', res: 'resolution',
  duration: 'durationS', durations: 'durationS', durationsec: 'durationS', durationseconds: 'durationS', seconds: 'durationS', secs: 'durationS',
  aspect: 'aspect', ratio: 'aspect',
  count: 'count', n: 'count', copies: 'count',
  refs: 'refs', reference: 'refs', references: 'refs', ingredients: 'refs', ingredient: 'refs',
  firstframe: 'firstFrame', startframe: 'firstFrame', first: 'firstFrame',
  lastframe: 'lastFrame', endframe: 'lastFrame', last: 'lastFrame',
  outputpath: 'outputPath', output: 'outputPath', out: 'outputPath', path: 'outputPath',
  model: 'model',
};

export function parseRows(rawRows = []) {
  return rawRows.map(normalizeRow);
}

function normalizeRow(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const canon = ALIASES[normKey(key)];
    if (!canon) continue;
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue; // empty CSV cells are "absent"
    switch (canon) {
      case 'refs': out.refs = splitRefs(value); break;
      case 'durationS': out.durationS = parseDuration(value); break;
      case 'count': out.count = Number(value); break;
      case 'kind': out.kind = kindAlias(value); break;
      case 'input': out.input = inputAlias(value); break;
      case 'resolution': out.resolution = String(value).trim().toLowerCase(); break;
      case 'aspect': out.aspect = String(value).trim(); break;
      default: out[canon] = typeof value === 'string' ? value.trim() : value;
    }
  }
  return out;
}

const splitRefs = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : String(v).split(/[\n;|]+/).map((s) => s.trim()).filter(Boolean));

function parseDuration(v) {
  if (typeof v === 'number') return v;
  const m = /^(\d+)\s*(?:s|sec|secs|seconds)?$/i.exec(String(v).trim());
  return m ? Number(m[1]) : v;
}

const kindAlias = (v) => {
  const k = String(v).trim().toLowerCase();
  if (['video', 'clip', 'vid'].includes(k)) return 'video';
  if (['image', 'img', 'still', 'photo'].includes(k)) return 'image';
  return k;
};

const inputAlias = (v) => {
  const k = String(v).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (['text', 't2v', 'texttovideo'].includes(k)) return 'text';
  if (['ingredients', 'ingredient', 'ref', 'refs', 'reference', 'references', 'r2v'].includes(k)) return 'ingredients';
  if (['frames', 'frame', 'firstlast', 'i2v'].includes(k)) return 'frames';
  return k;
};

const normKey = (k) => String(k).toLowerCase().replace(/[\s_-]+/g, '');

// Plans a storyboard: every row is mapped and validated through buildJob, so a bad row is reported
// by index and the caller can refuse the whole import. Cost is summed; `totalCost` is null when any
// row's cost is unknown (the page's own cost line then decides before the click). Duplicate scene
// names get -2, -3… so one batch never overwrites itself.
export function planImport({ text, filename = '', projectId, recipes = null, template = null, preset = null, taken = [] }) {
  const { format, rows: raw } = parseStoryboard(text, { filename });
  const usedNames = new Set(taken);
  const usedPaths = new Set();
  let knownCost = 0;
  const unknownCostRows = [];

  const rows = raw.map((r, i) => {
    const index = i + 1;
    const normalized = normalizeRow(r);
    // A selected preset fills only what the row left out (row wins).
    const spec = preset ? applyPresetToSpec(preset, normalized) : normalized;
    // A deterministic label (never a timestamp): scene, then name, then its position.
    const baseName = spec.name ?? spec.scene ?? `scene-${index}`;
    spec.name = uniquify(baseName, usedNames);
    usedNames.add(spec.name);
    try {
      const job = buildJob(spec, { projectId, recipes, template, index, total: raw.length });
      if (job.relativePath) job.relativePath = uniquify(job.relativePath, usedPaths);
      usedPaths.add(job.relativePath ?? `${job.projectId}/${job.name}`);
      if (job.expectedCost == null) unknownCostRows.push(index);
      else knownCost += job.expectedCost;
      return { index, scene: spec.scene ?? spec.name, ok: true, error: null, cost: job.expectedCost, spec, job };
    } catch (e) {
      return { index, scene: spec.scene ?? spec.name, ok: false, error: e.message, cost: null, spec, job: null };
    }
  });

  return {
    format,
    rows,
    knownCost,
    totalCost: unknownCostRows.length ? null : knownCost,
    unknownCostRows,
    anyError: rows.some((r) => !r.ok),
  };
}
