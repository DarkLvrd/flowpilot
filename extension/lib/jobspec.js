// Turns a raw spec (from the dashboard form, the storyboard import, the helper or the MCP server)
// into the job record the store keeps. This is the single validation path for every job — the
// service worker's `addJob` and the batch importer both call it, so a batch can never be accepted
// on weaker terms than a hand-added job (docs/SPEC.md decisions 3, 8). Pure: storage, the catalog
// RPC and the store live in the caller.

import { recipeFor, creditCost, catalogImageModels, accountImageCost } from './catalog.js';
import { validateReferences, classifyRef } from './refs.js';
import { applyNameTemplate } from './naming.js';

const VIDEO_EXT = /\.mp4$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

// A preview-first video is created before its first frame exists; this stands in for the still only
// while the Frames recipe is priced. It is never stored on the job (the reference plan holds null).
const HELD_FIRST_FRAME = 'the approved still';

export const safeName = (s) => String(s).replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120) || 'untitled';

// `spec` is the raw input; `opts` is { projectId, recipes (a parsed catalog Map or null), template,
// index, total, scene, holdFirstFrame }. Returns every job field except the state-machine ones (id,
// state, times, history) — those belong to the store. Throws a human-readable Error for anything
// invalid. `holdFirstFrame` (preview-first, see lib/preview.js) builds a Frames video whose first
// frame is chosen later: it skips the "needs a first frame" check and prices the Frames recipe the
// job will run once the approved still is attached, leaving referencePlan.firstFrame null.
export function buildJob(spec = {}, { projectId, recipes = null, template = null, index = null, total = null, holdFirstFrame = false } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(String(projectId ?? ''))) throw new Error('Bad project id');

  const prompt = String(spec.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  if (!prompt) throw new Error('Prompt is empty');

  const kind = spec.kind ?? 'video';
  // A named model is an *image* model (Flow's own `Select model family` menu in Image mode). A video
  // runs on the video model Flow's settings imply, and Flow Pilot does not select that one, so a
  // model on a video job is refused rather than silently ignored.
  if (kind !== 'image' && spec.model != null && spec.model !== '') {
    throw new Error('A model can only be named on an image job; a video runs on the Flow video model for its settings (Omni Flash), which Flow Pilot does not choose');
  }
  if (holdFirstFrame) {
    if (kind !== 'video') throw new Error('Only a video job can be held for a still preview');
    if ((spec.refs?.length ?? 0) > 0) throw new Error('A still preview uses Frames, not ingredient references');
    if (spec.firstFrame != null) throw new Error('A still preview builds the first frame from the still; do not give a first frame');
    // The promoted job runs in Frames, where Flow has no character chip (report §6): a character
    // would be dropped silently and the credits spent on a clip that never used it.
    if ((spec.characters?.length ?? 0) > 0) throw new Error('A still preview runs in Frames and takes no Flow Character; queue the character job directly instead');
  }
  const hasFrameFields = spec.firstFrame != null || spec.lastFrame != null;
  const hasIngredientFields = (spec.refs?.length ?? 0) > 0;
  const hasCharacterFields = (spec.characters?.length ?? 0) > 0;
  // Image jobs take Ingredients (1-3 reference photos) exactly like a video job; Frames stay a
  // video mode (there is no first/last frame for a still). Both go through validateReferences, so
  // an image reference gets the same caps, dedup and media-id/path classification as a video's.
  if (kind !== 'video' && hasFrameFields) {
    throw new Error('Frames (a first/last frame) are for video jobs; an image job takes Ingredients references (--ref) instead');
  }
  // Infer the input when it isn't named: a frame field means Frames, references mean Ingredients,
  // otherwise plain text. validateReferences throws a clear error on a bad reference.
  // A character rides in the Ingredients bar, so it makes the job an Ingredients job even with no
  // photo reference at all (report §3b/§8.1 step 3).
  const rawInput = holdFirstFrame ? 'frames'
    : (spec.input ?? (hasFrameFields ? 'frames' : ((hasIngredientFields || hasCharacterFields) ? 'ingredients' : 'text')));
  const referencePlan = kind === 'video'
    ? (holdFirstFrame
        ? { input: 'frames', ingredients: [], firstFrame: null, lastFrame: spec.lastFrame == null || spec.lastFrame === '' ? null : classifyRef(spec.lastFrame) }
        : validateReferences({ input: rawInput, refs: spec.refs ?? [], firstFrame: spec.firstFrame, lastFrame: spec.lastFrame, characters: spec.characters }))
    : (hasIngredientFields || hasCharacterFields
        ? validateReferences({ input: 'ingredients', refs: spec.refs, characters: spec.characters })
        : { input: 'text', ingredients: [], firstFrame: null, lastFrame: null });

  const durationS = Number(spec.durationS ?? 4);
  if (kind === 'video' && !Number.isFinite(durationS)) throw new Error(`Unsupported duration: ${JSON.stringify(spec.durationS)}; Flow offers 4, 6, 8 or 10 s`);
  const settings = {
    kind,
    // Flow has no "text" radio: text and Ingredients both use the Ingredients tab (an empty
    // ingredients list is plain text-to-video); only Frames uses the Frames tab.
    input: referencePlan.input === 'frames' ? 'frames' : 'ingredients',
    resolution: spec.resolution ?? '720p',
    durationS,
    aspect: spec.aspect ?? '16:9',
    count: Number(spec.count ?? 1),
    model: spec.model,
    refs: spec.refs ?? [],
    firstFrame: spec.firstFrame ?? null,
    lastFrame: spec.lastFrame ?? null,
    // A Flow Character is a reference as far as the recipe is concerned (r2v: the paid capture,
    // recon/FINDINGS.md 2026-10-03); it is carried on the settings so the cost preview and the later
    // `technicalCheck` price the job the same way, from the stored record alone.
    ...(referencePlan.characters?.length ? { characters: referencePlan.characters } : {}),
  };

  const outputPath = spec.outputPath == null || spec.outputPath === '' ? undefined : String(spec.outputPath);
  if (outputPath) {
    if (!/^(\/|[A-Za-z]:[\\/])/.test(outputPath)) throw new Error(`Output path must be absolute: ${outputPath}`);
    const ext = settings.kind === 'video' ? VIDEO_EXT : IMAGE_EXT;
    if (!ext.test(outputPath)) throw new Error(`Output path for a ${settings.kind} must end in ${settings.kind === 'video' ? '.mp4' : '.png, .jpg or .webp'}: ${outputPath}`);
  }
  if (!['16:9', '9:16'].includes(settings.aspect)) throw new Error(`Unsupported aspect: ${settings.aspect}`);
  if (![1, 2, 3, 4].includes(settings.count)) throw new Error(`Count must be 1-4, got ${settings.count}`);

  const recipe = recipeFor(holdFirstFrame ? { ...settings, firstFrame: HELD_FIRST_FRAME } : settings);
  // An image job that names no model rides on Flow's own current image model (report §4a): its cost
  // is then the one every image model the catalog knows agrees on, and `modelFamily` stays null
  // because the page, not the job, decides the family. `modelAccountDefault` tells the pre-spend
  // check to accept and verify Flow's current image model instead of refusing a named one.
  const accountImageDefault = settings.kind === 'image' && settings.model == null;
  const unit = recipes
    ? (accountImageDefault ? accountImageCost(recipes) : creditCost(recipes, recipe))
    : null;
  const expectedCost = unit == null ? null : unit * settings.count;
  const modelFamily = recipe == null ? null : (recipes?.get(recipe)?.family ?? null);
  const imageModelFamilies = accountImageDefault && recipes ? catalogImageModels(recipes).map((m) => m.family) : [];

  // A row's scene is its label; when a row names only one of scene/name, the other falls back to
  // it. A template that asks for a token neither field provides is refused, never invented.
  const rawScene = spec.scene ?? spec.name;
  const name = safeName(spec.name ?? rawScene ?? `job-${Date.now()}`);
  // A storyboard's naming template decides where the file lands (decision 5); a single job with
  // no template keeps the service worker's default path.
  const relativePath = template
    ? applyNameTemplate(template, { project: projectId, scene: rawScene, name, index, prompt, total })
    : undefined;

  // referencePlan holds the classified references (media ids and/or absolute paths); `references`
  // is filled with the resolved media ids at submit, once any path has been uploaded, and is what
  // the pre-spend check verifies against what the composer actually has attached.
  //
  // `entities`/`promptParts` are the consistency library's record (report §2.7): the *composed*
  // subject list and the prompt parts with their hashes, already resolved and inserted by the
  // service worker's addJob. A raw name here (entities as strings, or a part without a sha256) is
  // refused rather than stored, so a job can never claim a subject its prompt did not compose.
  const composed = {};
  if (spec.entities != null) {
    if (!Array.isArray(spec.entities) || spec.entities.some((e) => typeof e?.entityId !== 'string')) {
      throw new Error('A job\'s entities must be composed records (entityId, version, mediaId, role): compose them through addJob/flowpilot_add_job, not as raw names');
    }
    composed.entities = spec.entities;
  }
  if (spec.promptParts != null) {
    if (!Array.isArray(spec.promptParts) || spec.promptParts.some((p) => typeof p?.text !== 'string' || typeof p?.sha256 !== 'string')) {
      throw new Error('A job\'s promptParts must be composed prompt parts (kind, ref, sha256, text)');
    }
    composed.promptParts = spec.promptParts;
  }
  // `anchor` is the approval a shot-built video was created from (report §2.7): metadata only, so
  // the job can always be traced to the still a person approved. Media ids only, never paths.
  if (spec.anchor != null) {
    const media = (v, what) => {
      const ref = classifyRef(v);
      if (ref.kind !== 'mediaId') throw new Error(`A job's anchor ${what} must be a Flow media id, never a path`);
      return ref.mediaId;
    };
    if (typeof spec.anchor?.shotId !== 'string' || spec.anchor.shotId === '') throw new Error("A job's anchor must name the shot it came from (shotId)");
    if (spec.anchor.startFrameMediaId == null) throw new Error("A job's anchor needs the approved still's media id (startFrameMediaId)");
    composed.anchor = {
      shotId: spec.anchor.shotId,
      startFrameMediaId: media(spec.anchor.startFrameMediaId, 'startFrameMediaId'),
      endFrameMediaId: spec.anchor.endFrameMediaId == null ? null : media(spec.anchor.endFrameMediaId, 'endFrameMediaId'),
      approvedAt: spec.anchor.approvedAt ?? null,
    };
  }
  return {
    name, projectId, prompt, settings, referencePlan, references: null, recipe,
    expectedCost, modelFamily, outputPath, ...(relativePath ? { relativePath } : {}), ...composed,
    ...(accountImageDefault ? { modelAccountDefault: true, ...(imageModelFamilies.length ? { imageModelFamilies } : {}) } : {}),
  };
}
