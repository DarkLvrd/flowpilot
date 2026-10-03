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

// [[["prompt"]]] — the rich-text form of the prompt inside a record. A job that used a Flow
// Character stores the prompt in the mention form instead, and the live build has two of them:
//   ["<full text>", null, [[mention node, "<text after the chip>"]]]   (a character's own images)
//   [null, null, [[mention node, "<text after the chip>"]]]            (a video job, 2026-10-03)
// where the chip's own title stands in for the chip and leaves a double space. In the second form
// the full text sits beside that content list in the same params array, as the plain prompt does in
// every other record. All of them are read; anything else is left alone rather than mistaken for a
// prompt, and a job is matched by the text Flow actually stored, never by the workflow's own title.
function findNestedPrompt(record) {
  const rich = findRichPrompt(record);
  if (rich != null) return rich;
  // No plain rich-text prompt: the mention form that carries the text itself, or — when its first
  // element is null (a video job) — the params list's own text.
  const mentioned = findMentionPrompt(record);
  if (mentioned != null) return mentioned;
  if (hasMentionContent(record)) return findParamsPrompt(record);
  return null;
}

// The mention form that holds the text as its first element: ["<full text>", null, [segment, …]].
function findMentionPrompt(record) {
  let prompt = null;
  walk(record, (node) => {
    if (prompt) return false;
    if (isMentionContent(node) && typeof node[0] === 'string') prompt = node[0];
    return !prompt;
  });
  return prompt;
}

// [[["prompt"]]] — exactly one string inside.
function findRichPrompt(record) {
  let prompt = null;
  walk(record, (node) => {
    if (prompt) return false;
    if (node.length === 1 && Array.isArray(node[0]) && node[0].length === 1
        && Array.isArray(node[0][0]) && node[0][0].length === 1 && typeof node[0][0][0] === 'string') prompt = node[0][0][0];
    return !prompt;
  });
  return prompt;
}

// The params list every media record starts with: [ [seconds, nanos], "<the prompt text>", … ].
function findParamsPrompt(record) {
  let prompt = null;
  walk(record, (node) => {
    if (prompt) return false;
    const stamp = node[0];
    if (Array.isArray(stamp) && stamp.length === 2 && Number.isInteger(stamp[0]) && stamp[0] > 1e9
        && typeof node[1] === 'string' && node[1].trim() !== '') prompt = node[1];
    return !prompt;
  });
  return prompt;
}

function hasMentionContent(record) {
  let found = false;
  walk(record, (node) => {
    if (isMentionContent(node)) found = true;
    return !found;
  });
  return found;
}

// The content node a mention job's prompt lives in: [<maybe the text>, null, [segment, …]].
function isMentionContent(node) {
  return Array.isArray(node) && node.length >= 3 && node[1] === null && Array.isArray(node[2]) && node[2].some(isMentionSegment);
}

// A mention node in a character job's prompt content: [null, [null, null, [entityId, name]]].
function isMentionPair(node) {
  return Array.isArray(node) && node.length === 3 && node[0] === null && node[1] === null
    && isId(node[2]?.[0]) && typeof node[2][1] === 'string';
}
function isMentionNode(node) {
  return Array.isArray(node) && node.length === 2 && node[0] === null && isMentionPair(node[1]);
}
// One prompt-content segment: [<mention node>, "<the text after it>"]. The live account wraps that
// text in a one-element list (`[["  is in a Formula One car…"]]`) while the recon report recorded it
// as a bare string; both are read, because the prompt a character job is matched by lives here.
function isMentionSegment(node) {
  if (!Array.isArray(node) || node.length !== 2 || !isMentionNode(node[0])) return false;
  return typeof node[1] === 'string'
    || (Array.isArray(node[1]) && node[1].length === 1 && typeof node[1][0] === 'string');
}

function findEntityMentions(record) {
  const out = [];
  walk(record, (node) => {
    if (isMentionPair(node) && !out.some((m) => m.entityId === node[2][0])) out.push({ entityId: node[2][0], name: node[2][1] });
    return true;
  });
  return out;
}

// The record's entity-reference list: a non-empty list of one-id lists ([ ["<entityId>"], … ]). Its
// position varies by recipe family — [null, [[id]]] on a character's own images, and the last slot of
// the recipe block on the paid video job (2026-10-03) — so it is found by shape, and no plain record
// on this account contains one (checked against every Zzl0ze fixture). The looser ingredient
// predicate ([null, number, mediaId]) deliberately does not match it (report §5).
function findEntityRefs(record) {
  const ids = [];
  walk(record, (node) => {
    for (const child of node) {
      if (!isEntityRefList(child)) continue;
      for (const e of child) if (!ids.includes(e[0])) ids.push(e[0]);
    }
    return true;
  });
  return ids;
}

// A non-empty list of one-id lists: [["uuid"], …].
function isEntityRefList(node) {
  return Array.isArray(node) && node.length > 0
    && node.every((e) => Array.isArray(e) && e.length === 1 && isId(e[0]));
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
