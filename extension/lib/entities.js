// The consistency entity library and the verbatim prompt composer (report §2.1, §2.2, §2.7, §2.8).
//
// An *entity* is a subject that persists across many jobs — a character, vehicle, product or
// location — plus one project-level *style* entity that carries the canonical style lock. The
// library is per Flow project (media ids are project-scoped) and lives in chrome.storage under
// `flowpilot.entities`; the helper mirrors it to a file so a reinstall does not lose it.
//
// Two rules from the design shape everything here:
//   1. Locked means upload once, then always pass the media id. `refs[].mediaId` is a Flow media id
//      or nothing: a path would resolve to a *new* id on every upload, which makes a new subject.
//      A dropped photo is kept as `sourcePhoto` provenance only.
//   2. Nothing is mutated in place. Any change (a ref, the description, the negatives) becomes a new
//      `version`, the old set moves into `history`, and a job stores the version it used.
//
// Pure logic first (`entityBlock`, `mergeNegative`, `resolveEntities`, `composePrompt`,
// `promptBaseHash`, `appendConsistencyBlock`, `supersedeRef`, `validateEntity`, `validateTemplate`),
// then two small serialized stores over a chrome.storage-like area (`createEntityStore`,
// `createTemplateStore`), the same pattern as lib/jobs.js.

import { sha256Hex } from './sha256.js';

export const ENTITIES_KEY = 'flowpilot.entities';
export const TEMPLATES_KEY = 'flowpilot.templates';

export const KINDS = ['character', 'product', 'vehicle', 'location', 'style'];

// Reference roles per kind (report §2.1 rule 1).
export const ROLES = {
  character: ['sheet', 'front', 'three-quarter', 'profile', 'back', 'full-body', 'expression'],
  product: ['sheet', 'front', 'side', 'three-quarter', 'detail'],
  vehicle: ['sheet', 'front', 'side', 'three-quarter', 'detail'],
  location: ['wide', 'medium', 'detail', 'sign'],
  style: ['sheet'],
};

const ORIENTATIONS = ['portrait', 'landscape', 'square', 'none'];
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isMediaId = (v) => typeof v === 'string' && MEDIA_ID.test(v);

// The composer's section order when the asset files cannot be read (lib/prompt-assets.js builds the
// real one from scene_template.md and is what the extension uses). Kept as the design's own list
// (report §2.2/§2.3) so a missing asset fails soft instead of losing the order.
export const DEFAULT_SECTIONS = ['shot', 'beat', 'action', 'motion', 'setting', 'camera', 'entities', 'style', 'audio', 'negative'];
export const DEFAULT_TEMPLATE = {
  sections: DEFAULT_SECTIONS,
  durationS: 4,
  allowedDurationsS: [4, 6, 8, 10],
  negativeBase: ['subtitles', 'watermark', 'text on screen', 'logo', 'blurred faces', 'distorted hands'],
  audioLine: 'Audio: {audio} — no music, no narration',
  motionLineShape: 'Motion: [anticipation] + [primary motion with timing/weight] + [easing] + [follow-through/secondary] + [arcs].',
  shotTypes: [],
  cameraLibrary: [],
  motionLibrary: [],
};

export function emptyLibrary(projectId) {
  return { schema: 1, projectId, styleId: null, entities: [], updatedAt: 0 };
}

// ---- validation ----------------------------------------------------------------------------

const kindOf = (e) => String(e?.kind ?? '').toLowerCase();

// Throws a human-readable error; the stores call it before every write and imports call it per row.
export function validateEntity(entity) {
  if (!entity || typeof entity !== 'object') throw new Error('An entity must be an object');
  if (typeof entity.id !== 'string' || entity.id === '') throw new Error('An entity needs an id');
  if (typeof entity.name !== 'string' || entity.name.trim() === '') throw new Error('An entity needs a name');
  const kind = kindOf(entity);
  if (!KINDS.includes(kind)) throw new Error(`Unknown entity kind: ${JSON.stringify(entity.kind)} (one of ${KINDS.join(', ')})`);
  if (typeof entity.description !== 'string' || entity.description.trim() === '') throw new Error(`Entity "${entity.name}" needs a description`);
  if (entity.negative != null && typeof entity.negative !== 'string') throw new Error(`Entity "${entity.name}": negative must be a string`);
  if (entity.orientation != null && !ORIENTATIONS.includes(entity.orientation)) throw new Error(`Entity "${entity.name}": orientation must be one of ${ORIENTATIONS.join(', ')}`);
  if (entity.aliases != null && !Array.isArray(entity.aliases)) throw new Error(`Entity "${entity.name}": aliases must be a list`);
  if (entity.version != null && (!Number.isInteger(entity.version) || entity.version < 1)) throw new Error(`Entity "${entity.name}": version must be a whole number of 1 or more`);
  if (entity.approvedAt != null && typeof entity.approvedAt !== 'number') throw new Error(`Entity "${entity.name}": approvedAt must be a timestamp or null`);

  const refs = entity.refs ?? [];
  if (!Array.isArray(refs)) throw new Error(`Entity "${entity.name}": refs must be a list`);
  const seen = new Set();
  for (const ref of refs) {
    if (!isMediaId(ref?.mediaId)) {
      throw new Error(`A reference must be a Flow media id (locked), got ${JSON.stringify(ref?.mediaId)}; a local path is provenance, not a locked reference`);
    }
    if (seen.has(ref.mediaId)) throw new Error(`Entity "${entity.name}": the reference ${ref.mediaId} is listed twice`);
    seen.add(ref.mediaId);
    if (ref.role != null && !ROLES[kind].includes(ref.role)) {
      throw new Error(`Entity "${entity.name}" (${kind}): role must be one of ${ROLES[kind].join(', ')}, got ${JSON.stringify(ref.role)}`);
    }
    if (ref.label != null && (typeof ref.label !== 'string' || ref.label.trim() === '')) throw new Error(`Entity "${entity.name}": a reference label must be a non-empty string`);
  }
  if (entity.primaryRefMediaId != null) {
    if (!isMediaId(entity.primaryRefMediaId)) throw new Error(`Entity "${entity.name}": primaryRefMediaId must be a media id, never a path`);
    if (!seen.has(entity.primaryRefMediaId)) throw new Error(`Entity "${entity.name}": primaryRefMediaId is not one of its refs`);
  }
  return true;
}

export function normalizeLibrary(raw, projectId = raw?.projectId) {
  if (!raw || typeof raw !== 'object') throw new Error('A library must be an object');
  if (!Array.isArray(raw.entities)) throw new Error('A library must have an entities list');
  if (typeof projectId !== 'string' || projectId === '') throw new Error('A library needs a projectId');
  const entities = raw.entities.map((e) => {
    const entity = { history: [], aliases: [], refs: [], version: 1, ...e };
    validateEntity(entity);
    return entity;
  });
  const styleId = raw.styleId ?? null;
  if (styleId != null && !entities.some((e) => e.id === styleId)) throw new Error(`The library's styleId ${styleId} is not one of its entities`);
  const names = new Set();
  for (const e of entities) {
    const key = e.name.trim().toLowerCase();
    if (names.has(key)) throw new Error(`The library has two entities named "${e.name}"`);
    names.add(key);
  }
  return { schema: 1, projectId, styleId, entities, updatedAt: raw.updatedAt ?? 0 };
}

// ---- pure composer pieces -------------------------------------------------------------------

// One entity → the canonical block inserted into every prompt that uses it, verbatim, plus its
// sha256. The block carries the description only: negatives feed the negative section, refs feed
// the picker.
export function entityBlock(entity) {
  validateEntity({ refs: [], history: [], aliases: [], version: 1, ...entity, refs: entity?.refs ?? [] });
  const text = `${kindOf(entity).toUpperCase()} — ${entity.name.trim().toUpperCase()} (identical in every shot): ${entity.description.trim()}`;
  return { text, sha256: sha256Hex(text) };
}

// The prompt's Negative: line: the template's base negatives first, then each entity's, then the
// style lock's own — deduplicated case-insensitively, first spelling and order kept.
export function mergeNegative(base = [], entities = [], style = null) {
  const out = [];
  const seen = new Set();
  const add = (raw) => {
    for (const item of String(raw ?? '').split(',')) {
      const text = item.trim().replace(/\.$/, '');
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(text);
    }
  };
  add(Array.isArray(base) ? base.join(', ') : base);
  for (const e of entities ?? []) add(e?.negative);
  add(Array.isArray(style) ? style.join(', ') : (style?.negative ?? style));
  return out.join(', ');
}

// names/ids/aliases → the library's entities, in the requested order. Fails closed: an unknown
// name, a name that matches two entities, the same entity twice, or an unapproved entity all throw,
// so a job can never be composed around a subject the person has not approved.
export function resolveEntities(library, names = []) {
  const list = library?.entities ?? [];
  const key = (n) => (typeof n === 'string' ? n : (n?.entityId ?? n?.name ?? ''));
  const matches = (name) => {
    const wanted = String(name).trim().toLowerCase();
    return list.filter((e) => e.id === name || e.name.trim().toLowerCase() === wanted
      || (e.aliases ?? []).some((a) => String(a).trim().toLowerCase() === wanted));
  };
  const out = [];
  const used = new Set();
  for (const entry of names) {
    const name = key(entry);
    const found = matches(name);
    if (found.length === 0) throw new Error(`Unknown entity "${name}": add it to this project's library first`);
    if (found.length > 1) throw new Error(`The entity name "${name}" is ambiguous in this library (${found.map((e) => e.id).join(', ')}); use the entity id`);
    const entity = found[0];
    if (used.has(entity.id)) throw new Error(`Entity "${entity.name}" is listed twice in the same composition`);
    if (entity.approvedAt == null) throw new Error(`Entity "${entity.name}" is not approved; approve it in the dashboard (or \`flowpilot entity approve\`) before using it`);
    used.add(entity.id);
    out.push(entity);
  }
  return out;
}

// The motion section: a line from the motion library ("anticipation+timing-weight") or prose used
// verbatim. Tokens that are not library ids are kept as written so nothing the caller asked for is
// silently dropped.
export function motionLine(motion, template) {
  const text = String(motion ?? '').trim();
  if (!text) return null;
  if (!/^[a-z0-9-]+(\+[a-z0-9-]+)*$/.test(text)) return text;
  const byId = new Map((template?.motionLibrary ?? []).map((m) => [m.id, m]));
  return text.split('+').map((id) => byId.get(id)?.keywords ?? id).join('; ');
}

// The camera sentence: one move from the camera library, its own sentence, with the shot type in
// front ("wide: smooth tracking shot alongside"). `note` appends the caller's tail.
export function cameraSentence(camera, template) {
  if (!camera) return null;
  if (typeof camera === 'string') return camera.trim();
  const move = (template?.cameraLibrary ?? []).find((m) => m.id === camera.moveId);
  const sentence = [camera.shotType, move?.keywords ?? camera.note].filter(Boolean).join(' ').trim();
  const withNote = move && camera.note ? `${sentence}, ${camera.note}` : sentence;
  return withNote || null;
}

function sectionText(section, input, ctx) {
  const { styleEntity, template, entities } = ctx;
  switch (section) {
    case 'shot': {
      const n = input.scene ?? input.shot;
      if (n == null) return null;
      const duration = input.durationS ?? template.durationS;
      return `[SHOT ${n} — ${duration}s]`;
    }
    case 'beat': return input.beat ? `"${input.beat}"` : null;
    case 'action': return input.action ? `ACTION: ${input.action}` : null;
    case 'motion': { const line = motionLine(input.motion, template); return line ? `MOTION: ${line}` : null; }
    case 'setting': return input.setting ? `SETTING: ${input.setting}` : null;
    case 'camera': { const line = cameraSentence(input.camera, template); return line ? `CAMERA: ${line}` : null; }
    case 'entities': return null; // one part per entity; the caller emits them
    case 'style': return null;    // its own part kind; the caller emits it
    case 'audio': return input.audio ? template.audioLine.replace('{audio}', input.audio) : null;
    case 'negative': {
      const merged = mergeNegative(template.negativeBase, entities, styleEntity);
      return merged ? `Negative: ${merged}` : null;
    }
    default: return input[section] ?? null;
  }
}

// Input → the prompt parts Flow will receive. `input` is a shot (scene/beat/action/motion/setting/
// camera/audio/entities) or a plain job (prompt/entities); both may carry a base `prompt`, which is
// written first, verbatim. Returns `{ parts, text, sha256 }` where `text` is the parts joined by one
// blank line and each part carries its own sha256 (report §2.7/§2.8).
export function composePrompt(input = {}, library = emptyLibrary(null), template = DEFAULT_TEMPLATE) {
  const entities = resolveEntities(library, input.entities ?? []);
  const styleEntity = (library?.entities ?? []).find((e) => e.id === library.styleId) ?? null;

  const part = (kind, ref, text) => {
    const t = String(text ?? '').trim();
    return t ? { kind, ref, sha256: sha256Hex(t), text: t } : null;
  };

  const parts = [];
  const base = part('base', 'prompt', input.prompt);
  if (base) parts.push(base);

  const ctx = { entities, styleEntity, template };
  for (const section of template?.sections ?? DEFAULT_SECTIONS) {
    if (section === 'entities') {
      for (const e of entities) {
        const block = entityBlock(e);
        parts.push({ kind: 'entity', ref: e.id, sha256: block.sha256, text: block.text });
      }
      continue;
    }
    if (section === 'style') {
      // The style lock goes in VERBATIM (style_lock.md's own rule): no label, no trimming, so the
      // text Flow receives is byte-identical to the file.
      if (styleEntity?.description) {
        const text = styleEntity.description;
        parts.push({ kind: 'style', ref: library.styleId, sha256: sha256Hex(text), text });
      }
      continue;
    }
    const text = sectionText(section, input, ctx);
    if (text) parts.push(part('base', section, text));
  }

  const kept = parts.filter(Boolean);
  const text = kept.map((p) => p.text).join('\n\n');
  return { parts: kept, text, sha256: sha256Hex(text) };
}

// The frozen hash of sections 1–10: every part except an appended consistency block. A QC fix adds
// a block and leaves this identical, which is what makes the fix auditable (report §2.2, §2.8).
export function promptBaseHash(parts = []) {
  const base = parts.filter((p) => p.kind !== 'consistency');
  return sha256Hex(base.map((p) => `${p.ref}\u0000${p.sha256}`).join('\n'));
}

// Append-only: returns new parts with the block appended; the input array and its parts are
// untouched, so the base hashes cannot move.
export function appendConsistencyBlock(parts = [], block = {}) {
  const text = typeof block === 'string' ? block : String(block?.text ?? '');
  if (!text.trim()) throw new Error('A consistency block needs text');
  const ref = typeof block === 'string' ? 'consistency' : (block.id ?? block.ref ?? 'consistency');
  return [...parts, { kind: 'consistency', ref, sha256: sha256Hex(text.trim()), text: text.trim() }];
}

// ---- versioning -----------------------------------------------------------------------------

const snapshot = (entity, { reason, by, at }) => ({
  version: entity.version ?? 1,
  name: entity.name,
  kind: entity.kind,
  description: entity.description,
  negative: entity.negative ?? null,
  refs: entity.refs ?? [],
  primaryRefMediaId: entity.primaryRefMediaId ?? null,
  approvedAt: entity.approvedAt ?? null,
  approvedBy: entity.approvedBy ?? null,
  reason: reason ?? null,
  by: by ?? null,
  supersededAt: at,
});

// Any change is a new version: the old set lands in history, the current set is replaced.
export function reviseEntity(entity, patch, { reason = null, by = null, at = Date.now() } = {}) {
  const next = { ...entity, ...patch };
  if (patch.refs != null) {
    const ids = new Set(patch.refs.map((r) => r?.mediaId));
    if (next.primaryRefMediaId != null && !ids.has(next.primaryRefMediaId)) {
      next.primaryRefMediaId = patch.refs[0]?.mediaId ?? null;
    }
  }
  next.version = (entity.version ?? 1) + 1;
  next.history = [...(entity.history ?? []), snapshot(entity, { reason, by, at })];
  validateEntity(next);
  return next;
}

// Drop one locked reference and record why, as a new version (report §2.1: no silent replacement).
export function supersedeRef(entity, refId, reason, at = Date.now(), by = null) {
  const refs = entity.refs ?? [];
  if (!refs.some((r) => r.mediaId === refId)) {
    throw new Error(`Entity "${entity.name}" has no reference ${refId}`);
  }
  return reviseEntity(entity, { refs: refs.filter((r) => r.mediaId !== refId) }, { reason, by, at });
}

// ---- templates ------------------------------------------------------------------------------

export function validateTemplate(template) {
  const problems = [];
  const t = template ?? {};
  if (!Array.isArray(t.sections)) problems.push('sections must be a list');
  else {
    for (const want of DEFAULT_SECTIONS) {
      if (!t.sections.includes(want)) problems.push(`the ${want} section is missing`);
    }
    const order = t.sections.filter((s) => DEFAULT_SECTIONS.includes(s));
    if (order.join(',') !== DEFAULT_SECTIONS.filter((s) => t.sections.includes(s)).join(',')) {
      problems.push('sections are out of the composition order');
    }
  }
  if (!Array.isArray(t.allowedDurationsS) || t.allowedDurationsS.length === 0) {
    problems.push('allowedDurationsS must be a non-empty list');
  } else if (t.allowedDurationsS.some((d) => !DEFAULT_TEMPLATE.allowedDurationsS.includes(d))) {
    problems.push(`allowedDurationsS must be within ${DEFAULT_TEMPLATE.allowedDurationsS.join('/')}s (Flow's durations)`);
  }
  if (!DEFAULT_TEMPLATE.allowedDurationsS.includes(t.durationS)) {
    problems.push(`durationS must be one of ${DEFAULT_TEMPLATE.allowedDurationsS.join('/')}s`);
  }
  if (typeof t.audioLine !== 'string' || !t.audioLine.includes('{audio}')) problems.push('audioLine must be a string containing {audio}');
  if (!Array.isArray(t.negativeBase)) problems.push('negativeBase must be a list');
  if (!Array.isArray(t.cameraLibrary)) problems.push('cameraLibrary must be a list');
  if (!Array.isArray(t.motionLibrary)) problems.push('motionLibrary must be a list');
  return problems;
}

// ---- stores ---------------------------------------------------------------------------------

// `area` has the chrome.storage.local contract: get(key) → { [key]: value }, set({ [key]: value }).
// Every write is serialized (like createJobStore), validated, and announced through onChange so the
// service worker can mirror the library to the helper's file.
export function createEntityStore(area, { now = () => Date.now(), newId = () => `ent_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`, onChange = () => {} } = {}) {
  let chain = Promise.resolve();

  const update = (fn) => {
    const run = chain.then(async () => {
      const all = (await area.get(ENTITIES_KEY))[ENTITIES_KEY] ?? { schema: 1, projects: {} };
      const result = fn(all);
      await area.set({ [ENTITIES_KEY]: all });
      if (result?.library) onChange(result.library);
      return result?.value;
    });
    chain = run.catch(() => {});
    return run;
  };

  async function readAll() {
    return (await area.get(ENTITIES_KEY))[ENTITIES_KEY] ?? { schema: 1, projects: {} };
  }

  const libraryIn = (all, projectId) => all.projects[projectId] ?? emptyLibrary(projectId);
  const find = (lib, idOrName) => {
    if (idOrName == null) return -1;
    const wanted = String(idOrName).trim().toLowerCase();
    return lib.entities.findIndex((e) => e.id === idOrName || e.name.trim().toLowerCase() === wanted);
  };

  const apply = (projectId, mutate) => update((all) => {
    const lib = libraryIn(all, projectId);
    lib.updatedAt = now();
    const value = mutate(lib);
    all.projects[projectId] = lib;
    all.schema = 1;
    return { value: value ?? lib, library: lib };
  });

  const labelsOf = (lib, exceptId) => {
    const labels = new Set();
    for (const e of lib.entities) {
      if (e.id === exceptId) continue;
      for (const r of e.refs ?? []) if (r.label) labels.add(r.label.toLowerCase());
    }
    return labels;
  };

  function specToEntity(spec, existing) {
    const kind = kindOf(spec) || existing?.kind;
    const name = String(spec.name ?? existing?.name ?? '').trim();
    const entity = {
      history: [], aliases: [], refs: [], orientation: kind === 'style' ? 'none' : 'portrait',
      ...(existing ?? {}),
      ...pick(spec, ['description', 'negative', 'aliases', 'orientation', 'kind', 'name', 'sourcePhoto', 'flowCharacter', 'primaryRefMediaId']),
      id: existing?.id ?? spec.id ?? newId(),
      kind,
      name,
      version: existing?.version ?? 1,
      approvedAt: existing?.approvedAt ?? null,
      approvedBy: existing?.approvedBy ?? null,
      updatedAt: now(),
    };
    if (spec.refs != null) entity.refs = spec.refs.map((r) => ({ addedAt: now(), ...r }));
    // The primary ref is the first locked media id unless the caller named one that is still there.
    if (!(entity.primaryRefMediaId != null && entity.refs.some((r) => r.mediaId === entity.primaryRefMediaId))) {
      entity.primaryRefMediaId = entity.refs[0]?.mediaId ?? null;
    }
    if (spec.approvedAt === true || spec.approved === true) { entity.approvedAt = now(); entity.approvedBy = spec.approvedBy ?? 'dashboard'; }
    validateEntity(entity);
    return entity;
  }

  return {
    async library(projectId) { return libraryIn(await readAll(), projectId); },
    async list(projectId) { return (await this.library(projectId)).entities; },
    async get(projectId, idOrName) {
      const lib = await this.library(projectId);
      const i = find(lib, idOrName);
      return i < 0 ? null : lib.entities[i];
    },

    // Create, or revise the entity the name/id already points at. A new version, never an in-place
    // edit; a name held by a different kind is refused rather than silently rewritten.
    upsert(projectId, spec) {
      return apply(projectId, (lib) => {
        const byId = spec.id != null ? lib.entities.findIndex((e) => e.id === spec.id) : -1;
        const byName = find(lib, spec.name);
        if (byId < 0 && byName >= 0 && kindOf(spec) && kindOf(spec) !== kindOf(lib.entities[byName])) {
          throw new Error(`"${lib.entities[byName].name}" is already in this project as a ${lib.entities[byName].kind}; pick another name or change that entity's kind`);
        }
        const at = byId >= 0 ? byId : byName;
        const existing = at >= 0 ? lib.entities[at] : null;
        const entity = specToEntity(spec, existing);
        const clash = [...labelsOf(lib, existing?.id)].find((l) => (entity.refs ?? []).some((r) => r.label?.toLowerCase() === l));
        if (clash) throw new Error(`The reference label "${clash}" is already used in this project; the asset picker finds tiles by name, so labels must be unique (report §4.1)`);
        if (existing) {
          lib.entities[at] = { ...existing, ...entity, version: (existing.version ?? 1) + 1, history: [...(existing.history ?? []), snapshot(existing, { reason: spec.reason ?? 'updated', by: spec.by ?? null, at: now() })] };
          validateEntity(lib.entities[at]);
          return lib.entities[at];
        }
        lib.entities.push(entity);
        return entity;
      });
    },

    approve(projectId, idOrName, { by = 'dashboard', at = now() } = {}) {
      return apply(projectId, (lib) => {
        const i = find(lib, idOrName);
        if (i < 0) throw new Error(`Unknown entity "${idOrName}" in project ${projectId}`);
        lib.entities[i] = { ...lib.entities[i], approvedAt: at, approvedBy: by, updatedAt: now() };
        return lib.entities[i];
      });
    },

    // Approval is withdrawn as a revision too: an approved entity is never silently edited.
    unapprove(projectId, idOrName, { reason = 'approval withdrawn', by = null } = {}) {
      return apply(projectId, (lib) => {
        const i = find(lib, idOrName);
        if (i < 0) throw new Error(`Unknown entity "${idOrName}" in project ${projectId}`);
        lib.entities[i] = reviseEntity({ ...lib.entities[i], approvedAt: null }, {}, { reason, by, at: now() });
        return lib.entities[i];
      });
    },

    addRef(projectId, idOrName, ref, { reason = 'reference added', by = null } = {}) {
      return apply(projectId, (lib) => {
        const i = find(lib, idOrName);
        if (i < 0) throw new Error(`Unknown entity "${idOrName}" in project ${projectId}`);
        const existing = lib.entities[i];
        const next = reviseEntity(existing, {
          refs: [...(existing.refs ?? []), { addedAt: now(), ...ref }],
          primaryRefMediaId: existing.primaryRefMediaId ?? ref?.mediaId ?? null,
        }, { reason, by, at: now() });
        const clash = [...labelsOf(lib, existing.id)].find((l) => (next.refs ?? []).some((r) => r.label?.toLowerCase() === l));
        if (clash) throw new Error(`The reference label "${clash}" is already used in this project`);
        lib.entities[i] = next;
        return next;
      });
    },

    supersedeRef(projectId, idOrName, refId, { reason = 'reference replaced', by = null } = {}) {
      return apply(projectId, (lib) => {
        const i = find(lib, idOrName);
        if (i < 0) throw new Error(`Unknown entity "${idOrName}" in project ${projectId}`);
        lib.entities[i] = supersedeRef(lib.entities[i], refId, reason, now(), by);
        return lib.entities[i];
      });
    },

    // The project's one style entity: the canonical style lock as an approved entity (report §2.1).
    setStyle(projectId, { name = 'Style lock', description, negative, by = 'dashboard' } = {}) {
      return apply(projectId, (lib) => {
        const current = lib.entities.find((e) => e.id === lib.styleId) ?? null;
        const spec = { name, kind: 'style', description, negative, refs: current?.refs ?? [] };
        if (!current) {
          const entity = specToEntity({ ...spec, approved: true, approvedBy: by });
          lib.entities.push(entity);
          lib.styleId = entity.id;
          return entity;
        }
        const next = reviseEntity(current, { name, description, negative: negative ?? null, approvedAt: now(), approvedBy: by }, { reason: 'style lock updated', by, at: now() });
        lib.entities[lib.entities.indexOf(current)] = next;
        lib.styleId = next.id;
        return next;
      });
    },

    remove(projectId, idOrName) {
      return apply(projectId, (lib) => {
        const i = find(lib, idOrName);
        if (i < 0) throw new Error(`Unknown entity "${idOrName}" in project ${projectId}`);
        const [gone] = lib.entities.splice(i, 1);
        if (lib.styleId === gone.id) lib.styleId = null;
        return gone;
      });
    },

    async exportLibrary(projectId) {
      return structuredClone(await this.library(projectId));
    },

    // `replace` (the default) takes the file as the library; `merge` keeps local entities and adds
    // or overwrites by id. Both validate every row first, so a bad file changes nothing.
    async importLibrary(projectId, raw, { mode = 'replace' } = {}) {
      if (!['replace', 'merge'].includes(mode)) throw new Error(`Unknown import mode: ${mode} (replace or merge)`);
      const incoming = normalizeLibrary({ ...raw, projectId }, projectId);
      return apply(projectId, (lib) => {
        if (mode === 'replace') {
          lib.entities = incoming.entities;
          lib.styleId = incoming.styleId;
          return lib;
        }
        const byId = new Map(lib.entities.map((e) => [e.id, e]));
        for (const e of incoming.entities) byId.set(e.id, e);
        lib.entities = [...byId.values()];
        if (incoming.styleId) lib.styleId = incoming.styleId;
        return lib;
      });
    },
  };
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}

// A project's template: the asset-derived default with the project's edits on top.
export function createTemplateStore(area, { defaults = DEFAULT_TEMPLATE, now = () => Date.now() } = {}) {
  let chain = Promise.resolve();
  const update = (fn) => {
    const run = chain.then(async () => {
      const all = (await area.get(TEMPLATES_KEY))[TEMPLATES_KEY] ?? {};
      const result = fn(all);
      await area.set({ [TEMPLATES_KEY]: all });
      return result;
    });
    chain = run.catch(() => {});
    return run;
  };
  return {
    defaults,
    async get(projectId) {
      const all = (await area.get(TEMPLATES_KEY))[TEMPLATES_KEY] ?? {};
      return { ...structuredClone(defaults), ...(all[projectId] ?? {}) };
    },
    set(projectId, template) {
      return update((all) => {
        const problems = validateTemplate(template);
        if (problems.length) throw new Error(`That template cannot be used: ${problems.join('; ')}`);
        all[projectId] = { ...template, updatedAt: now() };
        return all[projectId];
      });
    },
    reset(projectId) {
      return update((all) => { delete all[projectId]; return null; });
    },
  };
}
