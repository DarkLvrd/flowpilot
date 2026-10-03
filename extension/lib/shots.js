// Shot plans, the still→anchor gate and materialisation (report §2.3, §2.4, §2.5, §2.7, §2.8).
//
// A *shot* is the unit of consistency. It carries the scene's text sections, the subjects that are
// in frame, and one plan for how Flow gets that frame's references:
//
//   * anchored   (mode: "frames")       — the approved still is the video's first frame
//   * referenced (mode: "ingredients")  — up to three entity photos carry the subjects' identity
//
// The two are mutually exclusive (Frames and Ingredients are exclusive composer modes, report §2.4),
// so `planReferences` refuses a shot that asks for both. When more than three subjects are in frame
// the still is the merge point: the plan refuses Ingredients and says to use Frames.
//
// The gate (report §2.5, SHOW-BEFORE-SPEND): a video job for a shot is *never created* until that
// shot's still is approved. Approval is a ledger entry { shotId, frame, mediaId, jobId, approvedAt,
// approvedBy, note }; `materializeShot` refuses without one, so no blocked video job ever exists and
// the job state machine (lib/jobs.js TRANSITIONS/TERMINAL) is untouched. A regenerated still
// supersedes the old approval instead of silently carrying it forward.
//
// Pure first (validateShot, planReferences, stillReferences, characterMentions, shotComposeInput,
// stillJobSpec, videoJobSpec, stillGate, approveStill, supersedeStill, materializeShot,
// normalizeShotRow, planShotImport), then one serialized store over a chrome.storage-like area.
//
// Flow Characters (report §2.4 consequence 3): an entity that carries `flowCharacter: { name }` is
// text-prefixed with `@Name` and its description block is left out of the prompt (the server holds
// it). Attaching a Character through Flow's picker is UNVERIFIED and belongs to Phase 3 — this
// module only encodes the text consequence, and nothing here clicks anything.

import { buildJob } from './jobspec.js';
import { classifyRef, MAX_INGREDIENTS } from './refs.js';
import { composePrompt, appendConsistencyBlock } from './entities.js';
import { uniquify } from './naming.js';
import { detectFormat, parseStoryboard, parseCsv } from './storyboard.js';

export const SHOT_ROLES = ['inFrame', 'context'];
export const SHOT_MODES = ['frames', 'ingredients'];
export const FRAMES = ['start', 'end'];

export const SHOTS_KEY = 'flowpilot.shots';
const DURATIONS = [4, 6, 8, 10];
const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isMediaId = (v) => typeof v === 'string' && MEDIA_ID.test(v);
const mediaIdOf = (v) => {
  if (v == null || v === '') return null;
  const ref = classifyRef(v);
  if (ref.kind !== 'mediaId') throw new Error(`A shot anchor must be a Flow media id, not a path: ${JSON.stringify(v)}`);
  return ref.mediaId;
};
const roleOf = (ref) => ref?.role ?? 'inFrame';
const inFrameOf = (shot) => (shot?.entities ?? []).filter((e) => roleOf(e) === 'inFrame');
const composedEntity = (e) => ({ entityId: e.entityId, version: e.version ?? 1, mediaId: e.mediaId ?? null, role: roleOf(e) });

// ---- validation ----------------------------------------------------------------------------

export function validateShot(shot) {
  if (!shot || typeof shot !== 'object') throw new Error('A shot must be an object');
  if (typeof shot.id !== 'string' || shot.id.trim() === '') throw new Error('A shot needs an id');
  if (shot.mode != null && !SHOT_MODES.includes(shot.mode)) throw new Error(`Shot ${shot.id}: mode must be one of ${SHOT_MODES.join(', ')}`);
  if (shot.durationS != null && !DURATIONS.includes(shot.durationS)) throw new Error(`Shot ${shot.id}: duration must be one of ${DURATIONS.join('/')}s, got ${shot.durationS}`);
  if (shot.entities != null && !Array.isArray(shot.entities)) throw new Error(`Shot ${shot.id}: entities must be a list`);
  const seen = new Set();
  for (const e of shot.entities ?? []) {
    if (typeof e?.entityId !== 'string' || e.entityId === '') throw new Error(`Shot ${shot.id}: every entity needs an entityId`);
    if (!SHOT_ROLES.includes(roleOf(e))) throw new Error(`Shot ${shot.id}: entity role must be one of ${SHOT_ROLES.join(', ')}, got ${JSON.stringify(e.role)}`);
    if (seen.has(e.entityId)) throw new Error(`Shot ${shot.id}: the entity ${e.entityId} is listed twice`);
    seen.add(e.entityId);
  }
  for (const field of ['startFrameMediaId', 'endFrameMediaId']) {
    const v = shot.anchor?.[field];
    if (v != null && !isMediaId(v)) throw new Error(`Shot ${shot.id}: ${field} must be a Flow media id or null, got ${JSON.stringify(v)}`);
  }
  return true;
}

// ---- the Flow Character seam ----------------------------------------------------------------

// `{ characters: [{ entityId, name, mention }], omitEntityBlocks: [entityId] }`. Pure; the mention
// is text only, and the attach (Flow's own Character picker) is deliberately not wired.
//
// The id here is Flow's own entity id (`flowCharacter.entityId`), never the library id: Flow's
// picker attaches by it, `lib/refs.js` classifyCharacter requires a uuid Flow echoes back after a
// generation, and a job that carried the library id could never be submitted (BUG-2). The prompt
// blocks live under the *library* id, so `omitEntityBlocks` keeps that one — they are two different
// identifiers for the same subject and this is the one place both are in hand.
export function characterMentions(shot, library = null) {
  const characters = [];
  const omitEntityBlocks = [];
  for (const ref of shot?.entities ?? []) {
    const e = resolveShotEntity(shot, ref, entitiesOf(library));
    const character = e.flowCharacter;
    if (!character?.name) continue;
    characters.push({ entityId: character.entityId, name: character.name, mention: `@${character.name}` });
    omitEntityBlocks.push(e.entityId);
  }
  return { characters, omitEntityBlocks };
}

// One frozen shot record + the library (when it is still there) → the entity the plan works from.
// The shot's own record wins: it was frozen at import, so a superseded reference cannot quietly
// change what an existing shot will send. A supplied library must still know the entity.
function resolveShotEntity(shot, ref, list) {
  const id = ref?.entityId;
  if (typeof id !== 'string' || id === '') throw new Error(`Shot ${shot?.id}: a shot entity needs an entityId`);
  const frozen = {
    entityId: id,
    name: ref.name ?? null,
    version: ref.version ?? null,
    mediaId: isMediaId(ref.mediaId) ? ref.mediaId : null,
    approvedAt: ref.approvedAt ?? null,
    flowCharacter: ref.flowCharacter ?? null,
  };
  if (!list) return frozen;
  const live = list.find((e) => e.id === id);
  if (!live) throw new Error(`Unknown entity "${id}" in this project's library; add it, or remove it from shot ${shot?.id}`);
  return {
    entityId: id,
    name: frozen.name ?? live.name,
    version: frozen.version ?? live.version ?? 1,
    mediaId: frozen.mediaId ?? (isMediaId(live.primaryRefMediaId) ? live.primaryRefMediaId : null),
    approvedAt: frozen.approvedAt ?? live.approvedAt ?? null,
    flowCharacter: frozen.flowCharacter ?? live.flowCharacter ?? null,
  };
}

const entitiesOf = (library) => (Array.isArray(library) ? library : library?.entities ?? null);

const requireComposable = (shot, e) => {
  if (e.approvedAt == null) throw new Error(`Entity "${e.name ?? e.entityId}" is not approved; approve it in the dashboard before planning shot ${shot.id}`);
  // A linked Flow Character needs no locked media id: Flow holds the face, the prompt names it and
  // the picker attaches it by entity id (report §8.1 step 2). The approval rule above is unchanged.
  if (isMediaId(e.mediaId) || e.flowCharacter?.entityId) return e;
  throw new Error(`Entity "${e.name ?? e.entityId}" has no locked reference media id; a shot's plan needs a Flow media id, never a path`);
};

// ---- reference planning (report §2.4) -------------------------------------------------------

// The shot's reference plan: { input, ingredients, firstFrame, lastFrame, inFrame, context,
// characters, omitEntityBlocks }. Throws a human-readable Error on anything that would send Flow a
// reference set it cannot honour.
export function planReferences(shot, library = null) {
  validateShot(shot);
  const list = entitiesOf(library);
  const inFrame = [];
  const context = [];
  for (const ref of shot.entities ?? []) {
    const e = resolveShotEntity(shot, ref, list);
    (roleOf(ref) === 'inFrame' ? inFrame : context).push(e);
  }
  const { characters, omitEntityBlocks } = characterMentions(shot, list);
  const shared = { inFrame, context, characters, omitEntityBlocks };

  if (shot.mode === 'frames') {
    // Anchored: the still is the identity. Ingredients would be the other path — never both.
    if ((shot.refs?.length ?? 0) > 0 || (shot.ingredients?.length ?? 0) > 0) {
      throw new Error(`Shot ${shot.id} is anchored (Frames) and cannot also carry Ingredients references: a shot is either anchored or referenced (report §2.4)`);
    }
    const start = mediaIdOf(shot.anchor?.startFrameMediaId);
    if (!start) throw new Error(`Shot ${shot.id} has no approved still yet: queue its still (\`flowpilot still ${shot.id}\`) and approve it first`);
    return { input: 'frames', ingredients: [], firstFrame: start, lastFrame: mediaIdOf(shot.anchor?.endFrameMediaId), ...shared };
  }

  if (shot.mode === 'ingredients') {
    if (shot.anchor?.startFrameMediaId) {
      throw new Error(`Shot ${shot.id} is referenced (Ingredients) and cannot also be pinned to an approved still: a shot is either anchored or referenced (report §2.4)`);
    }
    if (inFrame.length === 0) throw new Error(`Shot ${shot.id} is an Ingredients shot with no in-frame entity; mark a subject inFrame or anchor the shot with a still`);
    // Characters and photos share the one ingredient bar, so they are counted together: Flow
    // refuses extras either way, and Flow Pilot fails closed rather than let one be dropped.
    if (inFrame.length > MAX_INGREDIENTS) {
      throw new Error(`Shot ${shot.id}: ${inFrame.length} entities are inFrame but Flow takes ${MAX_INGREDIENTS}: generate a composed still (which merges them) and use mode:frames, or mark some as role:context (text only)`);
    }
    // A flowCharacter entity contributes a chip, not an id: only real media ids reach `ingredients`.
    const usable = inFrame.map((e) => requireComposable(shot, e));
    return { input: 'ingredients', ingredients: usable.map((e) => e.mediaId).filter(isMediaId), firstFrame: null, lastFrame: null, ...shared };
  }

  throw new Error(`Shot ${shot.id}: mode must be one of ${SHOT_MODES.join(', ')}`);
}

// The still's own Ingredients: the in-frame entity photos, in order, capped at Flow's three. A
// missing media id is left out (the still can still be generated text-only); an unapproved entity
// is refused outright. This is the merge point for a shot with more than three subjects.
export function stillReferences(shot, library = null) {
  validateShot(shot);
  const list = entitiesOf(library);
  const source = (shot.stillEntities?.length ? shot.stillEntities : inFrameOf(shot));
  const ids = [];
  for (const ref of source) {
    const e = resolveShotEntity(shot, ref, list);
    if (e.approvedAt == null) throw new Error(`Entity "${e.name ?? e.entityId}" is not approved; approve it before queueing a still for shot ${shot.id}`);
    if (isMediaId(e.mediaId) && !ids.includes(e.mediaId)) ids.push(e.mediaId);
    if (ids.length === MAX_INGREDIENTS) break;
  }
  return ids;
}

// ---- prompt and job specs -------------------------------------------------------------------

// The composePrompt input for a shot: the base sections plus one block per subject, with a
// flowCharacter entity's description block left out and its `@Name` mention written first.
export function shotComposeInput(shot, library = null) {
  validateShot(shot);
  const { characters, omitEntityBlocks } = characterMentions(shot, library);
  return {
    prompt: [characters.map((c) => c.mention).join(' '), shot.prompt].filter(Boolean).join('\n'),
    scene: shot.scene, durationS: shot.durationS,
    beat: shot.beat, action: shot.action, motion: shot.motion, setting: shot.setting,
    camera: shot.camera, audio: shot.audio,
    entities: (shot.entities ?? []).map((e) => e.entityId),
    omitEntityBlocks,
  };
}

const shotName = (shot, suffix = '') => `${shot.name ?? shot.id}${suffix}`;

// The still job's spec: a free Nano Banana image of the same frame, carrying the shot's refs.
// Callers run it through lib/jobspec.js buildJob (the one validation path) and the catalog.
export function stillJobSpec(shot, { library = null } = {}) {
  validateShot(shot);
  const refs = stillReferences(shot, library);
  return {
    name: shotName(shot, '-still'),
    kind: 'image',
    prompt: shot.prompt,
    promptParts: shot.promptParts,
    entities: (shot.entities ?? []).map(composedEntity),
    ...(refs.length ? { refs } : {}),
    ...(shot.resolution ? { resolution: shot.resolution } : {}),
    ...(shot.aspect ? { aspect: shot.aspect } : {}),
    ...(shot.count ? { count: shot.count } : {}),
    ...(shot.stillOutputPath ? { outputPath: shot.stillOutputPath } : {}),
  };
}

// The video job's spec for a plan: Frames uses the approved start/end frame; Ingredients uses the
// in-frame entity media ids. `hold` prices the Frames recipe before the still exists (preview-first).
export function videoJobSpec(shot, plan, { hold = false } = {}) {
  validateShot(shot);
  const base = {
    name: shotName(shot),
    kind: 'video',
    prompt: shot.prompt,
    promptParts: shot.promptParts,
    entities: (shot.entities ?? []).map(composedEntity),
    durationS: shot.durationS,
    resolution: shot.resolution,
    aspect: shot.aspect,
    count: shot.count,
    ...(shot.outputPath ? { outputPath: shot.outputPath } : {}),
  };
  // The plan carries the characters when it was built from an Entities shot; the frozen shot record
  // is the fallback (`hold` prices a Frames video before its plan exists).
  const characters = (plan?.characters ?? characterMentions(shot).characters).map((c) => ({ entityId: c.entityId, name: c.name }));
  const withCharacters = (spec) => (characters.length ? { ...spec, characters } : spec);
  if (plan?.input === 'frames' || hold) {
    // In Frames Flow replaces the ingredient bar with the start/end slots, so a character chip
    // cannot be attached and nothing could verify it (report §6). Refuse the job — a silent drop
    // here would spend 4 credits on a clip that never used the character.
    if (characters.length) {
      throw new Error(`Shot ${shot.id} carries the Flow Character ${characters.map((c) => c.name).join(', ')} and runs in Frames: Flow's Frames composer has no character chip, so the attach could never be verified. Use mode:ingredients, or drop the character (report §6)`);
    }
    return { ...base, input: 'frames', firstFrame: plan?.firstFrame ?? null, lastFrame: plan?.lastFrame ?? null };
  }
  return withCharacters({ ...base, input: 'ingredients', refs: plan?.ingredients ?? [] });
}

// ---- the approval ledger and the gate (report §2.5) -----------------------------------------

const liveApprovals = (approvals, shotId) => (approvals ?? []).filter((a) => a?.shotId === shotId && !a.supersededAt);
const lastOf = (list, frame) => [...list].reverse().find((a) => (a.frame ?? 'start') === frame) ?? null;

// { ok, start, end, problems }. `ok` means: this shot's current still (and its end frame, when one
// is declared) is approved, so a video job may be built from it.
export function stillGate(shot, approvals = []) {
  validateShot(shot);
  const live = liveApprovals(approvals, shot.id);
  const start = lastOf(live, 'start');
  const end = lastOf(live, 'end');
  const current = shot.still?.mediaId ?? null;
  const declared = shot.anchor?.startFrameMediaId ?? null;
  const problems = [];

  if (current == null && declared == null) problems.push(`Shot ${shot.id} has no still yet: queue one with \`flowpilot still ${shot.id}\``);
  if (!start) problems.push(`The still for shot ${shot.id} is not approved yet`);
  else if (current != null && start.mediaId !== current) {
    problems.push(`The approved still ${start.mediaId} has been replaced by a new still ${current}; approve the new one`);
  } else if (declared != null && start.mediaId !== declared) {
    problems.push(`The declared anchor ${declared} is not the approved still ${start.mediaId}`);
  }
  if (shot.anchor?.endFrameMediaId && (!end || end.mediaId !== shot.anchor.endFrameMediaId)) {
    problems.push(`The end frame ${shot.anchor.endFrameMediaId} is not approved yet`);
  }
  return { ok: problems.length === 0, start, end, problems };
}

// Records the approval: { shotId, frame, mediaId, jobId, approvedAt, approvedBy, note }. Sets the
// shot's anchor (start or end) so the plan and the dashboard read the same fact. The ledger keeps
// every entry, so a re-anchor is visible rather than replacing history.
export function approveStill(shot, approvals = [], { mediaId, frame = 'start', jobId = null, approvedBy = 'dashboard', note = null, at = Date.now() } = {}) {
  validateShot(shot);
  const id = mediaIdOf(mediaId);
  if (!id) throw new Error('An approval needs the still\'s Flow media id');
  if (!FRAMES.includes(frame)) throw new Error(`An approval frame must be one of ${FRAMES.join(', ')}`);
  const entry = { shotId: shot.id, frame, mediaId: id, jobId: jobId ?? null, approvedAt: at, approvedBy, note: note ?? null };
  const history = [...(shot.history ?? [])];
  const next = { ...shot };
  if (frame === 'start') {
    const previous = lastOf(liveApprovals(approvals, shot.id), 'start');
    if (previous && previous.mediaId !== id) history.push({ at, reason: `re-anchored to still ${id}`, from: previous.mediaId });
    else if (!previous && shot.anchor?.startFrameMediaId && shot.anchor.startFrameMediaId !== id) history.push({ at, reason: `anchored to still ${id}`, from: shot.anchor.startFrameMediaId });
    // Only a Frames shot is *pinned* to its still; an Ingredients shot records the approval in the
    // ledger and its still, and stays referenced (a shot is either anchored or referenced).
    next.anchor = {
      startFrameMediaId: shot.mode === 'frames' ? id : (shot.anchor?.startFrameMediaId ?? null),
      endFrameMediaId: shot.anchor?.endFrameMediaId ?? null,
    };
    next.still = { jobId: jobId ?? shot.still?.jobId ?? null, mediaId: id };
  } else {
    next.anchor = { startFrameMediaId: shot.anchor?.startFrameMediaId ?? null, endFrameMediaId: id };
  }
  next.history = history;
  return { shot: next, approvals: [...(approvals ?? []), entry], entry };
}

// A new still was queued (or a still failed): every live approval for the shot is superseded, so
// nothing silently carries an old approval onto a new image.
export function supersedeStill(shot, approvals = [], { reason = 'a new still was queued', at = Date.now() } = {}) {
  validateShot(shot);
  const next = (approvals ?? []).map((a) => (a?.shotId === shot.id && !a.supersededAt ? { ...a, supersededAt: at, supersededReason: reason } : a));
  return { shot, approvals: next };
}

// Builds the video job from an approved shot. Throws when the gate is not open, so no video job can
// exist for an unapproved still — there is no blocked job state to clear.
export function materializeShot(shot, approvals, { projectId, recipes = null, template = null, library = null } = {}) {
  const gate = stillGate(shot, approvals);
  if (!gate.ok) throw new Error(`Cannot build the video for ${shot.id}: ${gate.problems.join('; ')}`);
  const plan = planReferences(shot, library);
  const anchor = { shotId: shot.id, startFrameMediaId: gate.start.mediaId, endFrameMediaId: gate.end?.mediaId ?? null, approvedAt: gate.start.approvedAt };
  return buildJob({ ...videoJobSpec(shot, plan, { template }), anchor }, { projectId, recipes, template });
}

// ---- import rows (report §2.7 "Batch import row") -------------------------------------------

const KEY_ALIASES = {
  scene: 'scene', shot: 'scene', shotnumber: 'scene',
  name: 'name', job: 'name', title: 'name',
  beat: 'beat', action: 'action',
  motion: 'motion', motionid: 'motion',
  setting: 'setting', audio: 'audio',
  mode: 'mode', input: 'mode',
  entities: 'entities', entity: 'entities', subjects: 'entities',
  'anchor.startframe': 'anchor.startFrame', startframe: 'anchor.startFrame', firstframe: 'anchor.startFrame',
  'anchor.endframe': 'anchor.endFrame', endframe: 'anchor.endFrame', lastframe: 'anchor.endFrame',
  'still.refs': 'still.refs', stillrefs: 'still.refs',
  'still.outputpath': 'still.outputPath', stilloutput: 'still.outputPath',
  'settings.resolution': 'resolution', 'settings.durations': 'durationS', 'settings.durationsec': 'durationS',
  'settings.aspect': 'aspect', 'settings.count': 'count',
  resolution: 'resolution', res: 'resolution',
  duration: 'durationS', durations: 'durationS', durationsec: 'durationS', seconds: 'durationS', secs: 'durationS',
  aspect: 'aspect', ratio: 'aspect', count: 'count', n: 'count',
  outputpath: 'outputPath', output: 'outputPath', out: 'outputPath', path: 'outputPath',
  'camera.shottype': 'camera.shotType', 'camera.moveid': 'camera.moveId', 'camera.note': 'camera.note',
  camera: 'camera', shottype: 'camera.shotType', moveid: 'camera.moveId',
  qc: 'qc',
};

const normKey = (k) => String(k).toLowerCase().replace(/[\s_-]+/g, '');
const splitList = (v) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean) : String(v ?? '').split(/[\n;|]+/).map((s) => s.trim()).filter(Boolean));

function setPath(out, dotted, value) {
  const [head, tail] = dotted.split('.');
  if (!tail) { out[head] = value; return; }
  out[head] = { ...(out[head] ?? {}), [tail]: value };
}

// A JSON or CSV import row → the canonical row fields. Dotted CSV columns (camera.shotType,
// anchor.startFrame, still.refs) and nested JSON objects both land in the same shape.
export function normalizeShotRow(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value == null) continue;
    const nk = normKey(key);
    // Nested JSON: anchor.startFrame, still.refs, camera.shotType, settings.resolution.
    if (CONTAINERS.includes(nk) && typeof value === 'object' && !Array.isArray(value)) {
      for (const [inner, innerValue] of Object.entries(value)) {
        if (innerValue == null) continue;
        const canon = KEY_ALIASES[`${nk}.${normKey(inner)}`];
        if (canon) applyCanon(out, canon, innerValue);
      }
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') continue;
    const canon = KEY_ALIASES[nk];
    if (!canon) continue;
    applyCanon(out, canon, value);
  }
  if (out.qc != null) out.qc = splitList(out.qc);
  return out;
}

const CONTAINERS = ['anchor', 'still', 'camera', 'settings'];

function applyCanon(out, canon, value) {
  switch (canon) {
    case 'entities': out.entities = splitList(value); break;
    case 'still.refs': setPath(out, canon, splitList(value)); break;
    case 'mode': out.mode = String(value).trim().toLowerCase(); break;
    case 'durationS': out.durationS = Number(String(value).trim().replace(/s(ec(onds)?)?$/i, '')); break;
    case 'count': out.count = Number(value); break;
    case 'resolution': out.resolution = String(value).trim().toLowerCase(); break;
    case 'camera': if (typeof value === 'string') out.camera = { shotType: value.trim() }; else setPath(out, canon, { ...value }); break;
    default: setPath(out, canon, typeof value === 'string' ? value.trim() : value);
  }
}

// Before any job is planned: the row must describe one coherent shot.
export function validateShotRow(row) {
  const problems = [];
  if (row.scene == null && !row.name) problems.push('a row needs a scene or a name');
  if (row.mode != null && !SHOT_MODES.includes(row.mode)) problems.push(`mode must be one of ${SHOT_MODES.join(', ')}`);
  if (row.mode === 'ingredients' && row.anchor?.startFrame) problems.push('mode:ingredients and anchor.startFrame are mutually exclusive (Frames vs Ingredients)');
  if (row.mode === 'ingredients' && row.anchor?.endFrame) problems.push('mode:ingredients and anchor.endFrame are mutually exclusive (Frames vs Ingredients)');
  if (row.durationS != null && !DURATIONS.includes(row.durationS)) problems.push(`durationS must be one of ${DURATIONS.join('/')}s`);
  return problems;
}

// The mode a row without one gets: anchored when it declares a frame or has nothing to reference,
// referenced when it has 1-3 in-frame subjects, and anchored again when there are more than three
// (the still is the merge point — report §2.4 consequence 2).
export function defaultShotMode(row, inFrameCount) {
  if (row.mode) return row.mode;
  if (row.anchor?.startFrame) return 'frames';
  if (inFrameCount === 0 || inFrameCount > MAX_INGREDIENTS) return 'frames';
  return 'ingredients';
}

// ---- import planning ------------------------------------------------------------------------

// Plans a shot storyboard without queueing anything (the sw/CLI then add the shots and their still
// jobs). Rows are JSON objects or a storyboard text with the namespaced columns above. `knownStill`
// maps a local path to the media id a finished still job already produced (report §2.7: an anchor
// may be a media id or a path that is itself a done still job's output).
export function planShotImport({ text, filename = '', rows: given = null, projectId, library = null, template = null, recipes = null, knownStill = {}, taken = [] }) {
  const parsed = given ? { format: 'rows', rows: given } : parseShotRows(text, { filename });
  const usedIds = new Set(taken);
  const rows = [];
  let knownCost = 0;
  const unknownCostRows = [];

  parsed.rows.forEach((raw, i) => {
    const index = i + 1;
    const row = normalizeShotRow(raw);
    try {
      const problems = validateShotRow(row);
      if (problems.length) throw new Error(problems.join('; '));
      const warnings = [];
      const entities = resolveRowEntities(row, library, warnings, 'entities');
      const stillSource = resolveRowEntities(row, library, warnings, 'still.refs', entities);
      const inFrameCount = entities.filter((e) => roleOf(e) === 'inFrame').length;
      const mode = defaultShotMode(row, inFrameCount);
      if (row.mode !== mode) warnings.push(`mode defaulted to ${mode} (${inFrameCount} in-frame subject${inFrameCount === 1 ? '' : 's'})`);
      const id = uniquify(String(row.id ?? `shot_${row.scene ?? index}`).replace(/[^\w.-]+/g, '_'), usedIds);
      usedIds.add(id);
      const startFrame = anchorFrom(row.anchor?.startFrame, row, knownStill);
      const shot = {
        id, projectId, scene: row.scene ?? index, name: row.name ?? `shot_${row.scene ?? index}`,
        beat: row.beat ?? null, action: row.action ?? null, motion: row.motion ?? null,
        setting: row.setting ?? null, camera: row.camera ?? null, audio: row.audio ?? null,
        durationS: row.durationS ?? template?.durationS ?? 4,
        resolution: row.resolution ?? '720p', aspect: row.aspect ?? '16:9', count: row.count ?? 1,
        entities, stillEntities: stillSource.length ? stillSource : entities.filter((e) => roleOf(e) === 'inFrame'),
        mode, anchor: { startFrameMediaId: startFrame, endFrameMediaId: anchorFrom(row.anchor?.endFrame, row, knownStill) },
        still: { jobId: null, mediaId: null }, videoJobIds: [], qc: row.qc ?? null,
        outputPath: row.outputPath ?? null, stillOutputPath: row.still?.outputPath ?? null,
        history: [],
      };
      validateShot(shot);
      const composed = composePrompt(shotComposeInput(shot, library), library ?? { schema: 1, projectId, styleId: null, entities: [] }, template ?? undefined);
      shot.prompt = composed.text;
      shot.promptParts = composed.parts;

      const stillJob = buildJob(stillJobSpec(shot, { library }), { projectId, recipes, template: null });
      const { cost, unknown } = estimateShotCredits(shot, { library, recipes, projectId });
      if (unknown) unknownCostRows.push(index);
      else knownCost += cost;
      if (stillJob.expectedCost !== 0) throw new Error(`A still must be free: ${stillJob.recipe} reports ${stillJob.expectedCost} credits`);
      if (startFrame) warnings.push(`the declared start frame ${startFrame} is not approved yet; the video is created only after you approve a still for this shot`);
      rows.push({ index, scene: shot.scene, name: shot.name, ok: true, error: null, warnings, shot, stillJob, cost, videoCost: cost, stillCost: 0 });
    } catch (e) {
      rows.push({ index, scene: row.scene ?? row.name ?? null, name: row.name ?? null, ok: false, error: e.message, warnings: [], shot: null, stillJob: null, cost: null });
    }
  });

  return {
    format: parsed.format,
    rows,
    anyError: rows.some((r) => !r.ok),
    knownCost,
    totalCost: unknownCostRows.length ? null : knownCost,
    unknownCostRows,
  };
}

// Resolves a list of entity names/ids against the project library. Unknown names are an error; an
// unapproved entity is a warning and is left out of the shot (nothing is composed around a subject
// the person has not approved). `fallback` supplies the list when the row named none.
function resolveRowEntities(row, library, warnings, field, fallback = []) {
  const raw = field === 'entities' ? (row.entities ?? []) : (row.still?.refs ?? []);
  const list = raw.length ? raw : fallback;
  const out = [];
  const used = new Set();
  const add = (frozen, role) => {
    if (used.has(frozen.entityId)) return;
    used.add(frozen.entityId);
    out.push({ ...frozen, role: role ?? frozen.role });
  };
  for (const item of list) {
    if (item && typeof item === 'object' && item.entityId) {
      const known = fallback.find((e) => e.entityId === item.entityId);
      if (known) { add(known, item.role); continue; }
    }
    const name = typeof item === 'object' ? item.entityId : item;
    const wanted = String(name).trim().toLowerCase();
    const found = (library?.entities ?? []).filter((e) => e.id === name || e.name.trim().toLowerCase() === wanted || (e.aliases ?? []).some((a) => String(a).trim().toLowerCase() === wanted));
    if (found.length === 0) throw new Error(`Unknown entity "${name}": add it to this project's library first`);
    if (found.length > 1) throw new Error(`The entity name "${name}" is ambiguous in this library; use the entity id`);
    const e = found[0];
    if (e.approvedAt == null) { warnings.push(`${e.name} is not approved and is left out of this shot; approve it and re-import`); continue; }
    if (used.has(e.id)) throw new Error(`Entity "${e.name}" is listed twice in the same shot`);
    add({ entityId: e.id, name: e.name, version: e.version ?? 1, mediaId: e.primaryRefMediaId ?? null, approvedAt: e.approvedAt, flowCharacter: e.flowCharacter ?? null });
  }
  return out;
}

// A row's anchor: a media id passes through; a local path must be the output of a still job that
// already finished, whose media id is then used. Anything else fails closed.
function anchorFrom(value, row, knownStill) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  if (isMediaId(v)) return v;
  const mediaId = knownStill?.[v];
  if (mediaId) return mediaId;
  throw new Error(`anchor.startFrame/endFrame must be a Flow media id, or an absolute path from a finished still job (row ${row.scene ?? row.name ?? '?'}): ${v}`);
}

// The stills are free today (recon: every image recipe costs 0), so only the video is priced. The
// Frames recipe is priced before its still exists (hold), exactly as the eventual job will be.
export function estimateShotCredits(shot, { library = null, recipes = null, projectId } = {}) {
  if (!recipes) return { cost: 0, unknown: true };
  const spec = shot.mode === 'frames'
    ? videoJobSpec(shot, { input: 'frames' }, { hold: true })
    : videoJobSpec(shot, planReferences(shot, library));
  const job = buildJob(spec, { projectId, recipes, holdFirstFrame: shot.mode === 'frames' });
  return { cost: job.expectedCost ?? 0, unknown: job.expectedCost == null };
}

// ---- parsing -------------------------------------------------------------------------------

// The shot storyboard's own reader: JSON rows (an array, or {shots|scenes}) or a CSV whose header
// uses the namespaced columns from report §2.7. Reuses the storyboard module for both formats.
export function parseShotRows(text, { filename = '' } = {}) {
  const format = detectFormat(text, filename);
  if (format === 'json') return { format, rows: parseStoryboard(text, { filename }).rows };
  if (format === 'csv') {
    const rows = parseCsv(text);
    const keys = Object.keys(rows[0] ?? {}).map(normKey);
    if (!keys.some((k) => ['scene', 'shot', 'name'].includes(k))) throw new Error('A shot CSV needs a "scene" or "name" column in its header row');
    return { format, rows };
  }
  throw new Error('Cannot tell whether this shot list is JSON or CSV; name the file .json or .csv, or start JSON with [ or {');
}

// ---- the shot's fix history: append a block, never rewrite the base (report §2.2, §2.6) --------

// A QC fix appends one consistency block to the shot's composed prompt. The block is the only thing
// that changes: sections 1-10 keep their hashes byte-identically (`appendConsistencyBlock` is
// append-only), so the base prompt a person approved is provably the same text afterwards. Pure —
// the shot passed in is untouched.
export function shotWithConsistencyBlock(shot, block, { reason = null, at = Date.now() } = {}) {
  validateShot(shot);
  const parts = appendConsistencyBlock(shot.promptParts ?? [], block);
  const appended = parts.at(-1);
  return {
    ...shot,
    prompt: parts.map((p) => p.text).join('\n\n'),
    promptParts: parts,
    history: [...(shot.history ?? []), { at, reason: reason ?? `consistency block ${appended.ref} appended`, ref: appended.ref, sha256: appended.sha256 }],
  };
}

// ---- the store -----------------------------------------------------------------------------

// `area` has the chrome.storage.local contract. Every write is serialized and validated, like
// createJobStore. Shape: { schema: 1, projects: { [projectId]: { shots, approvals, updatedAt } } }.
export function createShotStore(area, { now = () => Date.now(), onChange = () => {} } = {}) {
  let chain = Promise.resolve();
  const empty = () => ({ schema: 1, projects: {} });

  const update = (fn) => {
    const run = chain.then(async () => {
      const all = (await area.get(SHOTS_KEY))[SHOTS_KEY] ?? empty();
      const result = fn(all);
      await area.set({ [SHOTS_KEY]: all });
      if (result?.projectId) onChange(result.projectId, result.value);
      return result?.value;
    });
    chain = run.catch(() => {});
    return run;
  };

  const bucket = (all, projectId) => (all.projects[projectId] ??= { shots: [], approvals: [], updatedAt: 0 });
  const withProject = (projectId, mutate) => update((all) => {
    const project = bucket(all, projectId);
    project.updatedAt = now();
    return { projectId, value: mutate(project) };
  });
  const find = (project, shotId) => {
    const i = project.shots.findIndex((s) => s.id === shotId);
    if (i < 0) throw new Error(`No shot ${shotId} in project ${project.shots.length ? 'this project' : 'an empty project'}`);
    return i;
  };

  return {
    async list(projectId) {
      const project = (await area.get(SHOTS_KEY))[SHOTS_KEY]?.projects?.[projectId];
      return { shots: project?.shots ?? [], approvals: project?.approvals ?? [] };
    },
    async get(projectId, shotId) {
      const { shots, approvals } = await this.list(projectId);
      const shot = shots.find((s) => s.id === shotId) ?? null;
      return shot ? { shot, approvals } : null;
    },

    // Shots are added by import and changed through the approval ledger; there is no in-place edit.
    addMany(projectId, shots) {
      return withProject(projectId, (project) => {
        for (const shot of shots) {
          validateShot(shot);
          if (project.shots.some((s) => s.id === shot.id)) throw new Error(`The shot ${shot.id} is already in this project`);
          project.shots.push({ history: [], videoJobIds: [], ...shot });
        }
        return shots;
      });
    },

    // A still image job was queued for the shot. Any live approval is superseded first: a new still
    // is visibly a new one, and the old approval can never silently carry onto it.
    recordStill(projectId, shotId, { jobId, mediaId = null, at = now() } = {}) {
      return withProject(projectId, (project) => {
        const i = find(project, shotId);
        const shot = project.shots[i];
        project.approvals = supersedeStill(shot, project.approvals, { reason: 'a new still was queued', at }).approvals;
        project.shots[i] = {
          ...shot,
          still: { jobId, mediaId },
          videoJobIds: shot.videoJobIds ?? [],
          history: [...(shot.history ?? []), { at, reason: mediaId ? `still ${jobId} finished` : `still job ${jobId} queued` }],
        };
        return project.shots[i];
      });
    },

    approve(projectId, shotId, entry) {
      return withProject(projectId, (project) => {
        const i = find(project, shotId);
        const result = approveStill(project.shots[i], project.approvals, entry);
        project.shots[i] = result.shot;
        project.approvals = result.approvals;
        return result.shot;
      });
    },

    // A QC fix's appended consistency block (report §2.6): the shot's prompt grows by one block and
    // its base hashes cannot move. Metadata plus the new parts; no approval, no job, no spend.
    appendBlock(projectId, shotId, block, { reason = null, at = now() } = {}) {
      return withProject(projectId, (project) => {
        const i = find(project, shotId);
        project.shots[i] = shotWithConsistencyBlock(project.shots[i], block, { reason, at });
        return project.shots[i];
      });
    },

    attachVideo(projectId, shotId, jobId, { at = now() } = {}) {
      return withProject(projectId, (project) => {
        const i = find(project, shotId);
        const shot = project.shots[i];
        project.shots[i] = {
          ...shot,
          videoJobIds: [...(shot.videoJobIds ?? []), jobId],
          videoJobId: jobId,
          history: [...(shot.history ?? []), { at, reason: `video job ${jobId} created from the approved still` }],
        };
        return project.shots[i];
      });
    },

    remove(projectId, shotId) {
      return withProject(projectId, (project) => {
        const i = find(project, shotId);
        const [gone] = project.shots.splice(i, 1);
        project.approvals = project.approvals.filter((a) => a.shotId !== shotId);
        return gone;
      });
    },
  };
}
