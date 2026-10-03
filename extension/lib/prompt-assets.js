// The canonical prompt assets (report §1.4, §2.2, §2.3). pixar-studio's prompts/*.md are the asset:
// Flow Pilot copies them verbatim into `assets/prompts/` and parses them here into the project style
// entity, the shot-template section order, the camera library and the motion library. Nothing is
// paraphrased: the style block and every library keyword are sliced out of the file byte-for-byte,
// and the tests pin the files' sha256 so a paraphrase fails the suite.
//
// Pure: the parse functions take markdown text and return data. `loadAssetTexts`/`loadDefaults`
// read the packaged files — `fetch(chrome.runtime.getURL(...))` in the extension, `readFileSync`
// under `node --test` and in the helper — and cache the result.

export const ASSET_FILES = ['style_lock', 'scene_template', 'camera_moves', 'animation_principles'];

// The section order the composer writes in (report §2.2). The scene template supplies everything but
// `entities`; entity blocks sit between CAMERA and the style lock — the model reads the subject,
// then the medium.
const ENTITY_INSERT_BEFORE = 'style';

// ---- markdown helpers -----------------------------------------------------------------------

const lines = (md) => md.split(/\r?\n/);

// The contents of every ``` fence in the file, in order, without the fence lines.
function fencedBlocks(md) {
  const out = [];
  let current = null;
  for (const line of lines(md)) {
    if (/^\s*```/.test(line)) {
      if (current) out.push(current.join('\n'));
      current = current ? null : [];
      continue;
    }
    if (current) current.push(line);
  }
  return out;
}

function tableRows(md) {
  return lines(md)
    .filter((l) => /^\s*\|/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
}

export function kebab(name) {
  return String(name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

// The inner text of every `code span` in a cell, verbatim, joined in order.
function codeSpans(cell, join = ' / ') {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]).join(join);
}

// ---- the four parsers -----------------------------------------------------------------------

// style_lock.md → { video: { text, negative[] }, image: { text } }. The video fence carries the
// style text plus its own Negative: line (which the composer merges into the prompt's negative
// section); the image fence has no Negative line.
export function parseStyleLock(md) {
  const blocks = fencedBlocks(md);
  const split = (block) => {
    const ls = block.split('\n');
    const at = ls.findIndex((l) => /^Negative:/.test(l));
    const body = (at < 0 ? ls : ls.slice(0, at)).join('\n').replace(/\s+$/, '');
    const negative = at < 0 ? [] : ls.slice(at).join('\n').replace(/^Negative:\s*/, '')
      .split(',').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
    return { text: body, negative };
  };
  const videoBlock = blocks.find((b) => /^Negative:/m.test(b));
  const video = videoBlock ? split(videoBlock) : null;
  const imageBlock = blocks.find((b) => b !== videoBlock);
  if (!video?.text || !imageBlock) throw new Error('Flow changed? style_lock.md has no video/image style fence');
  return { video, image: { text: imageBlock.replace(/\s+$/, '') } };
}

// camera_moves.md → { shotTypes[], moves: [{ id, name, keywords, useFor }] }.
export function parseCameraMoves(md) {
  const shotTypes = (lines(md).find((l) => /^Extreme wide/.test(l)) ?? '')
    .split('·').map((s) => s.trim()).filter(Boolean);
  const rows = tableRows(md);
  const start = rows.findIndex((r) => /^movement$/i.test(r[0]));
  const moves = [];
  for (const r of rows.slice(start + 1)) {
    if (r.length < 3) continue;
    moves.push({ id: kebab(r[0]), name: r[0], keywords: codeSpans(r[1]), useFor: r[2] });
  }
  if (!moves.length) throw new Error('Flow changed? camera_moves.md has no movements table');
  return { shotTypes, moves };
}

// animation_principles.md → { principles: [{ id, name, highValue, keywords, fixes }], motionLineShape }.
export function parseAnimationPrinciples(md) {
  const rows = tableRows(md);
  const start = rows.findIndex((r) => /^principle$/i.test(r[1] ?? ''));
  const principles = [];
  for (const r of rows.slice(start + 1)) {
    if (r.length < 5 || !/^\d+$/.test(r[0])) continue;
    const highValue = r[1].includes('★');
    const name = r[1].replace(/[★\s]+/g, ' ').trim();
    principles.push({ id: kebab(name), name, highValue, keywords: codeSpans(r[3]), fixes: r[4] });
  }
  if (!principles.length) throw new Error('Flow changed? animation_principles.md has no principles table');
  const shape = fencedBlocks(md).map((b) => b.trim()).find((b) => /^Motion:/.test(b));
  if (!shape) throw new Error('Flow changed? animation_principles.md has no Motion: line shape');
  return { principles, motionLineShape: shape };
}

// scene_template.md → the composition section order, the audio line shape, the default negatives
// and the default duration.
export function parseSceneTemplate(md) {
  const block = fencedBlocks(md).find((b) => /\[SHOT N/.test(b));
  if (!block) throw new Error('Flow changed? scene_template.md has no video template fence');
  const ls = block.split('\n');
  const sections = [];
  for (const line of ls) {
    // [SHOT N — 4s] → 'shot'; [STYLE LOCK — …] → 'style'.
    const label = line.match(/^\[([A-Z][A-Z ]*)/)?.[1]?.trim().toLowerCase().split(/\s+/)[0];
    if (label) { sections.push(label); continue; }
    if (/^<Script beat/.test(line)) sections.push('beat');
    else if (/^Audio:/i.test(line)) sections.push('audio');
    else if (/^Negative:/i.test(line)) sections.push('negative');
  }
  const durationS = Number(md.match(/Duration default:\s*(\d+)/)?.[1] ?? 4);
  const audioRaw = ls.find((l) => /^Audio:/i.test(l));
  const audioLine = audioRaw ? audioRaw.replace(/<[^>]*>/, '{audio}') : 'Audio: {audio} — no music, no narration';
  const negativeAt = ls.findIndex((l) => /^Negative:/i.test(l));
  const negativeRaw = negativeAt < 0 ? '' : ls.slice(negativeAt).join('\n');
  // 'Negative: <style lock negative + subtitles, watermark, …>' — the leading pointer to the
  // style lock's own negatives is not itself a negative; the rest is the template's base list.
  const negativeBase = negativeRaw.replace(/^Negative:\s*/i, '').replace(/[<>]/g, '')
    .replace(/^style lock negative\s*\+\s*/i, '')
    .split(/[,\n]/).map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
  return { sections, durationS, audioLine, negativeBase };
}

// ---- defaults -------------------------------------------------------------------------------

// Everything the composer needs that is not the entity library: the project template (sections,
// durations, audio line, negative base, camera and motion libraries), the canonical style lock as
// a style entity, and the image style text for still prompts.
export function buildDefaults(texts) {
  const lock = parseStyleLock(texts.style_lock);
  const camera = parseCameraMoves(texts.camera_moves);
  const motion = parseAnimationPrinciples(texts.animation_principles);
  const scene = parseSceneTemplate(texts.scene_template);

  const sections = [...scene.sections];
  const at = sections.indexOf(ENTITY_INSERT_BEFORE);
  if (at >= 0 && !sections.includes('entities')) sections.splice(at, 0, 'entities');

  return {
    // The style entity's description/negative come from style_lock.md verbatim.
    style: { description: lock.video.text, negative: lock.video.negative },
    imageStyleText: lock.image.text,
    template: {
      sections,
      durationS: scene.durationS,
      // Flow's own durations (extension/lib/catalog.js DURATIONS and Flow's settings radios).
      allowedDurationsS: [4, 6, 8, 10],
      negativeBase: scene.negativeBase,
      audioLine: scene.audioLine,
      motionLineShape: motion.motionLineShape,
      shotTypes: camera.shotTypes,
      cameraLibrary: camera.moves,
      motionLibrary: motion.principles,
    },
  };
}

export function assetsDirUrl() {
  return new URL('../assets/prompts/', import.meta.url);
}

let textsPromise = null;
let defaultsPromise = null;

// The packaged markdown as text, read the way this runtime can read it.
export function loadAssetTexts() {
  textsPromise ??= (async () => {
    if (typeof chrome !== 'undefined' && chrome?.runtime?.getURL) {
      const pairs = await Promise.all(ASSET_FILES.map(async (name) => {
        const res = await fetch(chrome.runtime.getURL(`assets/prompts/${name}.md`));
        if (!res.ok) throw new Error(`Cannot read the packaged prompt asset ${name}.md (HTTP ${res.status})`);
        return [name, await res.text()];
      }));
      return Object.fromEntries(pairs);
    }
    const { readFileSync } = await import('node:fs');
    return Object.fromEntries(ASSET_FILES.map((name) => [name, readFileSync(new URL(`${name}.md`, assetsDirUrl()), 'utf8')]));
  })();
  return textsPromise;
}

export function loadDefaults() {
  defaultsPromise ??= loadAssetTexts().then(buildDefaults);
  return defaultsPromise;
}
