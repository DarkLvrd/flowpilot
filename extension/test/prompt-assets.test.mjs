import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../lib/sha256.js';
import { recipeFor } from '../lib/catalog.js';
import {
  ASSET_FILES, parseStyleLock, parseCameraMoves, parseAnimationPrinciples, parseSceneTemplate,
  buildDefaults, loadAssetTexts, loadDefaults,
} from '../lib/prompt-assets.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'prompts');
const read = (name) => readFileSync(join(dir, `${name}.md`), 'utf8');
const texts = Object.fromEntries(ASSET_FILES.map((n) => [n, read(n)]));

// The sha256 of each file in /Users/mac/pixar-studio/prompts/ when it was copied (2026-10-02,
// pixar-studio ed35bad). A paraphrase or a stray edit here fails loudly.
const SOURCE_SHA = {
  style_lock: '5307b3f018b829aec54d722743ec493018ff0496081f2aed987a6c0d7d936ab4',
  scene_template: 'dc3247c998fa1883bfd75375bed5854f318cfcd5c377da61fe9654cdb3919f4a',
  camera_moves: 'd5fb42bd45d7f37e8f3e0584469f1f02c6f5f67a50ee344c3d75678448df6189',
  animation_principles: '6527ed2e06b590652915bd0a59cd04ff5241815e7020fd901ad1711404430412',
};

test('the copied assets are byte-verbatim from pixar-studio/prompts', () => {
  for (const name of ASSET_FILES) assert.equal(sha256Hex(texts[name]), SOURCE_SHA[name], `${name}.md changed`);
});

test('the style lock splits into description and negatives, both byte-verbatim', () => {
  const lock = parseStyleLock(texts.style_lock);
  // The exact video style text from style_lock.md's first fence, up to its Negative: line.
  assert.equal(lock.video.text, 'The whole video stays in this 3D Pixar/Disney animation style from the first frame to the last:\n'
    + 'toy-like proportions, exaggerated cartoon features, big stylized eyes, smooth plastic-like skin,\n'
    + 'stylized hair clumps, soft studio shading, saturated clean colors. The style NEVER changes —\n'
    + 'no drift, no transition toward realistic at any point.\n'
    + 'NOT photorealistic, NOT a realistic human, no realistic skin texture, no skin pores, no realistic\n'
    + 'hair strands, no realistic lighting, no real-life photograph look. Animated cartoon only.');
  assert.ok(texts.style_lock.includes(lock.video.text), 'description is not a verbatim slice of the file');
  assert.ok(texts.style_lock.includes(lock.image.text), 'image style is not a verbatim slice of the file');
  assert.deepEqual(lock.video.negative, ['photorealistic', 'realism', 'realistic skin', 'photograph', '8k photo',
    'real-life human', 'realistic hair', 'cinematic realism', 'style drift', 'realistic eyes']);
  assert.match(lock.image.text, /^3D Pixar\/Disney animation style/);
  assert.equal(lock.video.text.includes('Negative:'), false);
});

test('the camera library is the movements table, keyed by id, keywords verbatim', () => {
  const cam = parseCameraMoves(texts.camera_moves);
  assert.equal(cam.moves.length, 15);
  assert.equal(cam.shotTypes[0], 'Extreme wide (EWS)');
  assert.ok(cam.shotTypes.includes('Over-the-shoulder (OTS)'));
  const tracking = cam.moves.find((m) => m.id === 'tracking-glide');
  assert.deepEqual(tracking, { id: 'tracking-glide', name: 'Tracking glide', keywords: 'smooth tracking shot alongside', useFor: 'driving, walking, motion' });
  const crane = cam.moves.find((m) => m.id === 'crane');
  assert.equal(crane.keywords, 'crane up revealing the scene / crane down onto the subject'); // both alternatives, verbatim
  assert.equal(cam.moves.find((m) => m.id === 'push-and-hold').useFor, 'anger, quiet fury');
  assert.deepEqual(cam.moves.map((m) => m.id), ['arc-orbit', 'crane', 'dolly-in-push', 'dolly-out', 'tracking-glide',
    'whip-pan', 'handheld-prowl', 'rack-focus', 'pan-tilt', 'dutch-tilt', 'low-angle-glide', 'overhead', 'pov',
    'worm-s-eye', 'push-and-hold']);
});

test('the motion library is the principles table, keyed by id, star kept out of the id', () => {
  const motion = parseAnimationPrinciples(texts.animation_principles);
  assert.equal(motion.principles.length, 10);
  assert.deepEqual(motion.principles.map((p) => p.id), ['squash-stretch', 'anticipation', 'staging',
    'follow-through-overlap', 'slow-in-slow-out', 'arcs', 'secondary-action', 'timing-weight', 'exaggeration', 'appeal']);
  const anticipation = motion.principles.find((p) => p.id === 'anticipation');
  assert.equal(anticipation.highValue, true);
  assert.equal(anticipation.keywords, 'he tenses/inhales briefly before… / the car dips slightly before the turn / the gang gathers its breath before the sprint');
  assert.match(anticipation.fixes, /robotic snap/);
  assert.equal(motion.principles.find((p) => p.id === 'staging').highValue, true);
  assert.equal(motion.principles.find((p) => p.id === 'arcs').highValue, false);
  assert.match(motion.motionLineShape, /^Motion: \[anticipation\] \+ \[primary motion/);
});

test('the scene template gives the section order, the audio line and the negative base', () => {
  const t = parseSceneTemplate(texts.scene_template);
  assert.equal(t.durationS, 4);
  assert.deepEqual(t.sections, ['shot', 'beat', 'action', 'motion', 'setting', 'camera', 'style', 'audio', 'negative']);
  assert.equal(t.audioLine, 'Audio: {audio} — natural ambient only, no background music, no narration');
  assert.deepEqual(t.negativeBase, ['subtitles', 'watermark', 'text on screen', 'logo', 'blurry faces',
    'distorted hands', 'realistic drift']);
});

test('the built defaults carry the design composition order and the asset content', () => {
  const d = buildDefaults(texts);
  // The composer's order (report §2.2): entity blocks sit between CAMERA and the style lock.
  assert.deepEqual(d.template.sections, ['shot', 'beat', 'action', 'motion', 'setting', 'camera', 'entities', 'style', 'audio', 'negative']);
  assert.equal(d.style.description, parseStyleLock(texts.style_lock).video.text);
  assert.deepEqual(d.style.negative, parseStyleLock(texts.style_lock).video.negative);
  assert.equal(d.template.cameraLibrary.length, 15);
  assert.equal(d.template.motionLibrary.length, 10);
  // Every duration the template allows is one Flow's recipes are built for (catalog.js).
  assert.deepEqual(d.template.allowedDurationsS, [4, 6, 8, 10]);
  for (const durationS of d.template.allowedDurationsS) {
    assert.ok(recipeFor({ kind: 'video', input: 'text', durationS, resolution: '720p' }), `${durationS}s has no recipe`);
  }
  assert.equal(d.template.durationS, 4);
});

test('the loader reads the packaged assets (Node path) and returns the same defaults', async () => {
  const loaded = await loadDefaults();
  assert.deepEqual(loaded.template.sections, buildDefaults(await loadAssetTexts()).template.sections);
  assert.equal(loaded.style.description, buildDefaults(texts).style.description);
});
