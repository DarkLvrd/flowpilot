// References for a job: Ingredients (reference photos that shape the whole video) and Frames (a
// start photo and an optional end photo, with the video generated in between). Each reference is
// either an existing Flow media id (a uuid already in the project) or an absolute local path. The
// helper reads a path's bytes, magic-checks them, and the driver uploads it through Flow's own
// "Upload media" control, then reads the new media id from Zzl0ze (docs/LESSONS.md #13) — never by
// waiting for the grid, never by navigating while an upload is in flight.
//
// Pure: this validates and classifies; the upload/attach lives in the driver, the id diff below.

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ABS_PATH = /^(\/|[A-Za-z]:[\\/])/;

// Flow's Ingredients composer offers three reference slots (recon 2026-09-27; confirm live before
// raising). Fail closed above it rather than let Flow silently drop extras.
export const MAX_INGREDIENTS = 3;

// Flow Characters share that same ingredient bar as a fifth chip kind (report §3b). Flow has its
// own per-kind cap ("Maximum character ingredients reached") whose number is UNVERIFIED, so Flow
// Pilot fails closed at its own conservative number rather than let Flow drop an extra silently.
export const MAX_CHARACTERS = 3;
const CHARACTER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One Flow Character → { entityId, name }. Pure. The entity id is what Flow's own record echoes
// back after a generation (report §5), so it is required: a character attached on its name alone
// could never be verified, and the credits would be spent either way. Throws otherwise.
export function classifyCharacter(character) {
  const entityId = typeof character?.entityId === 'string' ? character.entityId.trim() : '';
  if (!CHARACTER_ID.test(entityId)) {
    throw new Error(`A Flow Character needs the entity id Flow gave it (a uuid), got ${JSON.stringify(character?.entityId)}; the name alone cannot be verified after the fact`);
  }
  const name = typeof character?.name === 'string' ? character.name.trim() : '';
  if (name === '') throw new Error(`The character ${entityId} needs the name Flow shows on its picker tile`);
  return { entityId, name };
}

// One reference → { kind: 'mediaId', mediaId } | { kind: 'path', path }. Throws on anything else.
export function classifyRef(ref) {
  const v = typeof ref === 'string' ? ref.trim() : '';
  if (v && MEDIA_ID.test(v)) return { kind: 'mediaId', mediaId: v };
  if (v && ABS_PATH.test(v)) return { kind: 'path', path: v };
  throw new Error(`A reference must be a Flow media id or an absolute path, got: ${JSON.stringify(ref)}`);
}

// Validates a job's reference fields for its video input mode and returns the normalized shape
// { input, ingredients: [classified…], firstFrame: classified|null, lastFrame: classified|null }.
// Throws a human-readable error otherwise. `input` is one of 'text' | 'ingredients' | 'frames'.
export function validateReferences({ input, refs = [], firstFrame, lastFrame, characters = [] } = {}) {
  const has = (v) => v != null && v !== '';
  const raw = Array.isArray(characters) ? characters : (characters == null ? [] : [characters]);
  const chars = raw.map(classifyCharacter);
  if (chars.length > MAX_CHARACTERS) throw new Error(`Flow Pilot attaches at most ${MAX_CHARACTERS} Flow Characters per job, got ${chars.length}`);
  if (new Set(chars.map((c) => c.entityId)).size !== chars.length) throw new Error('The same Flow Character is listed twice in this job');
  // The plan keeps its old shape when no character is asked for, so nothing downstream has to know
  // about characters unless a job really uses one.
  const withChars = (plan) => (chars.length ? { ...plan, characters: chars } : plan);

  if (input === 'text') {
    if ((refs?.length ?? 0) > 0 || has(firstFrame) || has(lastFrame)) {
      throw new Error('Text input takes no references; use the Ingredients or Frames input');
    }
    return withChars({ input, ingredients: [], firstFrame: null, lastFrame: null });
  }

  if (input === 'ingredients') {
    if (has(firstFrame) || has(lastFrame)) throw new Error('Ingredients input has no first/last frame; use the Frames input for those');
    const list = Array.isArray(refs) ? refs : [];
    // A character is a reference Flow already holds, so a character-only job is a valid Ingredients
    // job with an empty photo list; the driver attaches the chip through the picker.
    if (list.length === 0 && chars.length === 0) throw new Error('Ingredients input needs at least one reference image');
    if (list.length > MAX_INGREDIENTS) throw new Error(`Flow's Ingredients takes at most ${MAX_INGREDIENTS} reference images, got ${list.length}`);
    const ingredients = list.map(classifyRef);
    const ids = ingredients.filter((r) => r.kind === 'mediaId').map((r) => r.mediaId);
    const paths = ingredients.filter((r) => r.kind === 'path').map((r) => r.path);
    if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) throw new Error('Duplicate reference in the ingredients list');
    return withChars({ input, ingredients, firstFrame: null, lastFrame: null });
  }

  if (input === 'frames') {
    if ((refs?.length ?? 0) > 0) throw new Error('Frames input takes a first/last frame, not an ingredients reference list');
    // Frames replaces the ingredient bar with the start/end slots, so there is no character chip to
    // attach and nothing the pre-spend check could confirm (report §6). Refuse instead of spending
    // on a job whose character would silently degrade to plain text.
    if (chars.length) {
      throw new Error(`Frames takes no Flow Character (${chars.map((c) => c.name).join(', ')}): Flow's Frames composer has no character chip, so the attach could never be verified. Use the Ingredients input for a character job`);
    }
    if (!has(firstFrame)) throw new Error('Frames input needs a first frame');
    const first = classifyRef(firstFrame);
    const last = has(lastFrame) ? classifyRef(lastFrame) : null;
    if (last && ((first.mediaId && first.mediaId === last.mediaId) || (first.path && first.path === last.path))) {
      throw new Error('The first and last frame are the same reference');
    }
    return { input, ingredients: [], firstFrame: first, lastFrame: last };
  }

  throw new Error(`Unknown video input mode: ${JSON.stringify(input)}`);
}

// Maps resolved reference media ids to the names Flow shows on their picker tiles (each media's
// prompt / uploaded filename, from Zzl0ze). The picker grid has no media id — thumbnails are /asb/
// tokens (recon 2026-10-01) — so the driver finds a tile by this name. Ids with no known name are
// omitted, so the driver fails closed rather than attach the wrong media.
export function referenceNames(media, ids) {
  const byId = new Map(media.map((m) => [m.mediaId, m.prompt]));
  const names = {};
  for (const id of ids) {
    const n = byId.get(id);
    if (n != null && n !== '') names[id] = n;
  }
  return names;
}

// After an upload the new media appears in Zzl0ze under its file name as an image record that was
// not there before. Given the media lists (from parseProjectMedia) captured before and after and
// the uploaded file's `name`, return that upload's media id, or fail closed. Matching by name and
// image kind (not "exactly one new record") means a shared project staying busy — another worker's
// upload or a render finishing mid-upload — no longer over-counts and fails the job (docs/LESSONS.md
// #13). Still fails closed when the name is ambiguous (several fresh images share it) or absent.
export function newlyUploadedId(before, after, name) {
  const had = new Set(before.map((m) => m.mediaId));
  const fresh = after.filter((m) => !had.has(m.mediaId));
  const matches = fresh.filter((m) => m.kind === 'image' && m.prompt === name);
  if (matches.length > 1) throw new Error(`Several new media are named "${name}"; the upload is ambiguous, cannot tell which to attach`);
  if (matches.length === 0) throw new Error(`Upload not visible yet: no new image named "${name}" in the project`);
  return matches[0].mediaId;
}
