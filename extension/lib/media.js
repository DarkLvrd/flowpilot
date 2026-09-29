// Project media (Zzl0ze) and media detail (as29s) readers. Shape-based:
//   media record = [mediaId, projectId, workflowId, …]     (three ids up front)
//   workflow     = [workflowId, null, null, [title, …], projectId]  (title = prompt on older media;
//                  Flow now writes its own short title, so the record's own prompt comes first)
//   recipe       = [recipeId, number, …] somewhere inside a video record
//   ingredient   = [null, number, mediaId] inside a record
// Results are matched by id and verbatim prompt, never by grid position (LESSONS.md #14).

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_RECIPE = /t2v|i2v|r2v|edit|upsampler|first_last|extend|interpolation/;
const SIGNED_URL = /^https:\/\/flow-content\.google\/(image|video)\/([^/?]+)\?.*Signature=/;

const isId = (v) => typeof v === 'string' && ID.test(v);

// Returns [{ mediaId, projectId, workflowId, kind, prompt, recipe, ingredientIds, createdAt }].
export function parseProjectMedia(inner) {
  if (!Array.isArray(inner)) throw new Error('Flow changed: project media is not a list');
  const titles = new Map();
  const records = [];
  walk(inner, (node) => {
    if (isRecord(node)) {
      records.push(node);
      return false; // don't look for records inside a record
    }
    if (isWorkflow(node)) titles.set(node[0], node[3][0]);
    return true;
  });
  return records.map((r) => {
    const recipe = findRecipe(r);
    return {
      mediaId: r[0],
      projectId: r[1],
      workflowId: r[2],
      kind: recipe && VIDEO_RECIPE.test(recipe) ? 'video' : 'image',
      prompt: findNestedPrompt(r) ?? titles.get(r[2]),
      recipe,
      ingredientIds: findIngredients(r),
      createdAt: findTimestamp(r),
    };
  });
}

// Returns { mediaId, kind, url } where url is the signed flow-content.google URL.
export function parseMediaDetail(inner) {
  let hit = null;
  walk(inner, (node) => {
    for (const v of node) {
      const m = typeof v === 'string' && v.match(SIGNED_URL);
      if (m && !hit) hit = { kind: m[1], urlId: m[2], url: v };
    }
    return !hit;
  });
  if (!hit) throw new Error('Flow changed: media detail has no signed download URL');
  const mediaId = isId(inner[0]) ? inner[0] : hit.urlId;
  return { mediaId, kind: hit.kind, url: hit.url };
}

// The earliest record with exactly this prompt, created at or after `since` (ms), whose id is not
// in `exclude` (ids already claimed by other jobs). null when there is none yet.
export function findResult(media, { prompt, since, exclude = [] }) {
  return media
    .filter((m) => m.prompt === prompt && m.createdAt != null && m.createdAt >= since && !exclude.includes(m.mediaId))
    .sort((a, b) => a.createdAt - b.createdAt)[0] ?? null;
}

function isRecord(node) {
  return isId(node[0]) && isId(node[1]) && isId(node[2]);
}

function isWorkflow(node) {
  return isId(node[0]) && Array.isArray(node[3]) && typeof node[3][0] === 'string' && isId(node[4]);
}

function findRecipe(record) {
  let recipe = null;
  walk(record, (node) => {
    if (!recipe && typeof node[0] === 'string' && /^[A-Za-z0-9]+_[A-Za-z0-9_]+$/.test(node[0]) && typeof node[1] === 'number') {
      recipe = node[0];
    }
    return !recipe;
  });
  return recipe;
}

function findIngredients(record) {
  const ids = [];
  walk(record, (node) => {
    if (node.length === 3 && node[0] === null && typeof node[1] === 'number' && isId(node[2])
        && node[2] !== record[0] && !ids.includes(node[2])) ids.push(node[2]);
    return true;
  });
  return ids;
}

// [[["prompt"]]] — the rich-text form of the prompt inside a record.
function findNestedPrompt(record) {
  let prompt = null;
  walk(record, (node) => {
    if (!prompt && node.length === 1 && Array.isArray(node[0]) && node[0].length === 1
        && Array.isArray(node[0][0]) && typeof node[0][0][0] === 'string') prompt = node[0][0][0];
    return !prompt;
  });
  return prompt;
}

// First [seconds, nanos] pair → epoch ms.
function findTimestamp(record) {
  let ms = null;
  walk(record, (node) => {
    if (ms === null && node.length === 2 && Number.isInteger(node[0]) && node[0] > 1e9 && node[0] < 1e11
        && Number.isInteger(node[1]) && node[1] >= 0 && node[1] < 1e9) {
      ms = node[0] * 1000 + Math.floor(node[1] / 1e6);
    }
    return ms === null;
  });
  return ms;
}

// Depth-first over arrays; `visit` returns false to skip a node's children.
function walk(node, visit) {
  if (!Array.isArray(node)) return;
  if (visit(node) === false) return;
  for (const child of node) walk(child, visit);
}
