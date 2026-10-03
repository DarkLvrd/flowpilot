// Turns a raw spec (from the dashboard form, the storyboard import, the helper or the MCP server)
// into the job record the store keeps. This is the single validation path for every job — the
// service worker's `addJob` and the batch importer both call it, so a batch can never be accepted
// on weaker terms than a hand-added job (docs/SPEC.md decisions 3, 8). Pure: storage, the catalog
// RPC and the store live in the caller.

import { recipeFor, creditCost } from './catalog.js';
import { validateReferences } from './refs.js';
import { applyNameTemplate } from './naming.js';

const VIDEO_EXT = /\.mp4$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

export const safeName = (s) => String(s).replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120) || 'untitled';

// `spec` is the raw input; `opts` is { projectId, recipes (a parsed catalog Map or null), template,
// index, total, scene }. Returns every job field except the state-machine ones (id, state, times,
// history) — those belong to the store. Throws a human-readable Error for anything invalid.
export function buildJob(spec = {}, { projectId, recipes = null, template = null, index = null, total = null } = {}) {
  if (!/^[0-9a-f-]{36}$/.test(String(projectId ?? ''))) throw new Error('Bad project id');

  const prompt = String(spec.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  if (!prompt) throw new Error('Prompt is empty');

  const kind = spec.kind ?? 'video';
  const hasRefFields = (spec.refs?.length ?? 0) > 0 || spec.firstFrame != null || spec.lastFrame != null;
  if (kind !== 'video' && hasRefFields) {
    throw new Error('References (Ingredients and Frames) are for video jobs; image reference support is not wired yet');
  }
  // Infer the input when it isn't named: a frame field means Frames, references mean Ingredients,
  // otherwise plain text. validateReferences throws a clear error on a bad reference.
  const rawInput = spec.input ?? (spec.firstFrame != null || spec.lastFrame != null ? 'frames' : (spec.refs?.length ? 'ingredients' : 'text'));
  const referencePlan = kind === 'video'
    ? validateReferences({ input: rawInput, refs: spec.refs ?? [], firstFrame: spec.firstFrame, lastFrame: spec.lastFrame })
    : { input: 'text', ingredients: [], firstFrame: null, lastFrame: null };

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
  };

  const outputPath = spec.outputPath == null || spec.outputPath === '' ? undefined : String(spec.outputPath);
  if (outputPath) {
    if (!/^(\/|[A-Za-z]:[\\/])/.test(outputPath)) throw new Error(`Output path must be absolute: ${outputPath}`);
    const ext = settings.kind === 'video' ? VIDEO_EXT : IMAGE_EXT;
    if (!ext.test(outputPath)) throw new Error(`Output path for a ${settings.kind} must end in ${settings.kind === 'video' ? '.mp4' : '.png, .jpg or .webp'}: ${outputPath}`);
  }
  if (!['16:9', '9:16'].includes(settings.aspect)) throw new Error(`Unsupported aspect: ${settings.aspect}`);
  if (![1, 2, 3, 4].includes(settings.count)) throw new Error(`Count must be 1-4, got ${settings.count}`);

  const recipe = recipeFor(settings);
  const unit = recipes ? creditCost(recipes, recipe) : null;
  const expectedCost = unit == null ? null : unit * settings.count;
  const modelFamily = recipes?.get(recipe)?.family ?? null;

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
  return {
    name, projectId, prompt, settings, referencePlan, references: null, recipe,
    expectedCost, modelFamily, outputPath, ...(relativePath ? { relativePath } : {}),
  };
}
