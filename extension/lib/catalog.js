// Model catalog (HTrJv) → recipes and credit costs, plus the recipe a job's settings map to.
// Reader is shape-based, not index-based: a recipe is any array [id, …, costs] whose slot [4]
// is a list of [tier, [[null, credits]] | [null, []]] pairs; its family is the enclosing
// [name, [recipes…], …] array.

const DURATIONS = [4, 6, 8, 10];
const RESOLUTIONS = ['360p', '720p'];
const IMAGE_RECIPES = { 'nano-banana-2': 'NARWHAL', 'nano-banana-pro': 'GEM_PIX_2' };

// Returns Map<recipeId, { id, family, durationS, costByTier: { [tier]: credits | null } }>.
export function parseCatalog(inner) {
  const recipes = new Map();
  walk(inner, (node) => {
    if (!isFamily(node)) return;
    for (const r of node[1]) {
      if (!isRecipe(r)) continue;
      recipes.set(r[0], { id: r[0], family: node[0], durationS: durationOf(r[0]), costByTier: costsOf(r[4]) });
    }
  });
  if (recipes.size === 0) throw new Error('Flow changed: model catalog has no recipes');
  return recipes;
}

// Credits for one generation of `recipe`, or null when unknown (caller must then rely on the
// cost line Flow itself shows). Without a tier, a cost is known only if every tier agrees.
export function creditCost(catalog, recipe, tier) {
  const r = catalog.get(recipe);
  if (!r) return null;
  if (tier != null) return r.costByTier[tier] ?? null;
  const costs = Object.values(r.costByTier);
  return costs.length > 0 && costs.every((c) => c !== null && c === costs[0]) ? costs[0] : null;
}

// The recipe Flow should run for these job settings. Flow's own UI picks the real recipe; this is
// the expectation used for the cost preview and for matching the result record afterwards.
export function recipeFor({ kind, model = 'nano-banana-2', input, durationS, resolution, refs = [], characters = [], firstFrame, lastFrame }) {
  if (kind === 'image') {
    const recipe = IMAGE_RECIPES[model];
    if (!recipe) throw new Error(`Unknown image model: ${model}`);
    return recipe;
  }
  if (kind !== 'video') throw new Error(`Unknown kind: ${kind}`);
  if (!DURATIONS.includes(durationS)) throw new Error(`Unsupported duration: ${durationS}s (Flow offers ${DURATIONS.join('/')}s)`);
  if (!RESOLUTIONS.includes(resolution)) throw new Error(`Unsupported resolution: ${resolution}`);
  const suffix = resolution === '360p' ? '_360p' : '';

  if (input === 'frames') {
    if (!firstFrame) throw new Error('Frames mode needs a first frame');
    return lastFrame
      ? `omni_flash_i2v_${durationS}s_first_last${suffix}`
      : `abra_i2v_${durationS}s${suffix}`;
  }
  // Ingredients with no references is plain text-to-video (inferred; same cost either way). A Flow
  // Character is a reference too (it travels as a structured mention plus its chip, report §3c), so
  // a character-only job is reference-to-video, not text-to-video.
  if (input === 'ingredients' && (refs.length > 0 || characters.length > 0)) return `abra_r2v_${durationS}s${suffix}`;
  if (input === 'text' || input === 'ingredients') return `abra_t2v_${durationS}s${suffix}`;
  throw new Error(`Unknown video input: ${input}`);
}

function isFamily(node) {
  return typeof node[0] === 'string' && Array.isArray(node[1]) && node[1].some(isRecipe);
}

function isRecipe(node) {
  return Array.isArray(node) && typeof node[0] === 'string' && Array.isArray(node[4])
    && node[4].length > 0 && node[4].every((t) => Array.isArray(t) && typeof t[0] === 'number' && Array.isArray(t[1]));
}

function costsOf(slot) {
  const out = {};
  for (const [tier, entry] of slot) {
    // [[null, 7]] → 7; [null, []] → not offered on this tier.
    const credits = Array.isArray(entry[0]) ? entry[0][1] : null;
    out[tier] = typeof credits === 'number' ? credits : null;
  }
  return out;
}

function durationOf(id) {
  const m = id.match(/_(\d+)s(?:_|$)/);
  return m ? Number(m[1]) : null;
}

function walk(node, visit) {
  if (!Array.isArray(node)) return;
  visit(node);
  for (const child of node) walk(child, visit);
}
