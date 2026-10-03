// Project media (Zzl0ze) and media detail (as29s) readers. Shape-based:
//   media record = [mediaId, projectId, workflowId, …]     (three ids up front)
//   workflow     = [workflowId, null, null, [title, …], projectId]  (title = prompt on older media;
//                  Flow now writes its own short title, so the record's own prompt comes first)
//   recipe       = [recipeId, number, …] somewhere inside a video record
//   ingredient   = [null, number, mediaId] inside a record
//   entity       = [projectId, entityId, parent, [1, name, [[[workflowId]]]], primaryMediaId, …]
//                  (a Flow Character, in the entity list field — PROJECT_MEDIA_FIELD.entities)
//   mention      = [null, null, [entityId, name]] inside a character job's prompt content
// Results are matched by id and verbatim prompt, never by grid position (LESSONS.md #14).

import { PROJECT_MEDIA_FIELD } from './rpc.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHARACTER = 1; // entity_info[0]: the compiled proto's CHARACTER type (report §2)
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
      // A Flow Character the generation really used, from the record itself (report §5): the
      // structured mention segment and the entity-reference list. Empty for a job without one.
      entityMentions: findEntityMentions(r),
      entityRefs: findEntityRefs(r),
      createdAt: findTimestamp(r),
    };
  });
}

// The project's Flow Characters, read from the entity list inside the same `Zzl0ze` response Flow
// Pilot already fetches for media (there is no separate RPC to poll — report §2). Returns
// [{ entityId, projectId, name, primaryMediaId, referenceWorkflowIds }]. Shape-tolerant: a node
// that is not a CHARACTER entity is skipped, never guessed at, because a wrong entityId would
// attach the wrong subject and the credits would still be spent.
//
// Fail closed: a payload that is not a list is "Flow changed" — but an absent/null field is not an
// error, it is what 18 of 19 projects on this account answer (this project has no characters).
export function parseEntities(inner) {
  if (!Array.isArray(inner)) throw new Error('Flow changed: project contents is not a list');
  const field = inner[PROJECT_MEDIA_FIELD.entities];
  if (field == null) return [];
  if (!Array.isArray(field)) throw new Error('Flow changed: the project entity list is not a list');
  const out = [];
  for (const node of field) {
    const entity = readEntity(node);
    if (entity) out.push(entity);
  }
  return out;
}

function readEntity(node) {
  if (!Array.isArray(node)) return null;
  const [projectId, entityId, , info, primaryMediaId] = node;
  if (!isId(entityId) || !Array.isArray(info) || info[0] !== CHARACTER) return null;
  const name = typeof info[1] === 'string' ? info[1].trim() : '';
  if (name === '') return null;
  return {
    entityId,
    projectId: isId(projectId) ? projectId : null,
    name,
    primaryMediaId: isId(primaryMediaId) ? primaryMediaId : null,
    referenceWorkflowIds: findIds(info[2]),
  };
}

// Which of a job's expected characters the finished generation's own record confirms. Returns
// { entityId, name } for the first expected character the record shows (a mention segment, or the
// entity-reference list), or null — never a guess: a wrong yes would let the Review card claim a
// character was used when Flow received plain text (report §8.2).
export function characterUsed(record, expected = []) {
  const list = Array.isArray(expected) ? expected : [];
  const mentions = record?.entityMentions ?? [];
  const refs = record?.entityRefs ?? [];
  for (const want of list) {
    const entityId = want?.entityId;
    if (!isId(entityId)) continue;
    const mention = mentions.find((m) => m.entityId === entityId);
    if (mention) return { entityId, name: mention.name ?? want.name ?? null };
    if (refs.includes(entityId)) return { entityId, name: want.name ?? null };
  }
  return null;
}

// Returns { mediaId, kind, url } where url is the signed flow-content.google URL. With `kind`
// ('video' | 'image'), only a URL of that kind counts: a video's detail also lists its poster image.
export function parseMediaDetail(inner, kind) {
  let hit = null;
  walk(inner, (node) => {
    for (const v of node) {
      const m = typeof v === 'string' && v.match(SIGNED_URL);
      if (m && !hit && (!kind || m[1] === kind)) hit = { kind: m[1], urlId: m[2], url: v };
    }
    return !hit;
  });
  if (!hit) throw new Error(`Flow changed: media detail has no signed ${kind ?? 'download'} URL`);
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
// A job that used a Flow Character stores the prompt in the mention form instead:
//   ["<full text>", null, [[mention node, "<text after the chip>"]]]
// where the chat chip's own title stands in for the chip and leaves a double space. Both forms are
// read here; anything else is left alone rather than mistaken for a prompt.
function findNestedPrompt(record) {
  let prompt = null;
  walk(record, (node) => {
    if (prompt) return false;
    if (node.length === 1 && Array.isArray(node[0]) && node[0].length === 1
        && Array.isArray(node[0][0]) && node[0][0].length === 1 && typeof node[0][0][0] === 'string') { prompt = node[0][0][0]; return false; }
    if (typeof node[0] === 'string' && node[1] === null && Array.isArray(node[2]) && node[2].some(isMentionSegment)) { prompt = node[0]; return false; }
    return true;
  });
  return prompt;
}

// A mention node in a character job's prompt content: [null, [null, null, [entityId, name]]].
function isMentionPair(node) {
  return Array.isArray(node) && node.length === 3 && node[0] === null && node[1] === null
    && isId(node[2]?.[0]) && typeof node[2][1] === 'string';
}
function isMentionNode(node) {
  return Array.isArray(node) && node.length === 2 && node[0] === null && isMentionPair(node[1]);
}
// One prompt-content segment: [<mention node>, "<the text after it>"].
function isMentionSegment(node) {
  return Array.isArray(node) && node.length === 2 && isMentionNode(node[0]) && typeof node[1] === 'string';
}

function findEntityMentions(record) {
  const out = [];
  walk(record, (node) => {
    if (isMentionPair(node) && !out.some((m) => m.entityId === node[2][0])) out.push({ entityId: node[2][0], name: node[2][1] });
    return true;
  });
  return out;
}

// The record's entity-reference list: [null, [[entityId], …]]. Only that shape counts — the looser
// ingredient predicate ([null, number, mediaId]) deliberately does not match it (report §5).
function findEntityRefs(record) {
  const ids = [];
  walk(record, (node) => {
    if (node.length === 2 && node[0] === null && Array.isArray(node[1]) && node[1].length > 0
        && node[1].every((e) => Array.isArray(e) && e.length === 1 && isId(e[0]))) {
      for (const e of node[1]) if (!ids.includes(e[0])) ids.push(e[0]);
    }
    return true;
  });
  return ids;
}

// Every uuid-like string inside a nested list (an entity's image_references are workflow ids).
function findIds(node) {
  const ids = [];
  walk(node, (n) => {
    for (const v of n) if (isId(v) && !ids.includes(v)) ids.push(v);
    return true;
  });
  return ids;
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
