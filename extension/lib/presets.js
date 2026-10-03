// Reusable per-project presets: kind, resolution, duration, aspect, count, the output folder and
// naming template, and a default reference set — so a batch can be repeated without re-entering
// settings (brief: presets). Pure: lib/jobspec.js still validates each job; this only validates the
// preset itself and fills defaults a storyboard row left out.

import { validateReferences } from './refs.js';
import { applyNameTemplate, DEFAULT_TEMPLATE } from './naming.js';

const DURATIONS = [4, 6, 8, 10];
const SAMPLE_TOKENS = { project: 'project', scene: 'scene', name: 'scene', prompt: 'prompt', index: 1, total: 1 };

export const PRESET_DEFAULTS = Object.freeze({
  name: '',
  kind: 'video',
  resolution: '720p',
  durationS: 4,
  aspect: '16:9',
  count: 1,
  template: DEFAULT_TEMPLATE,
  folder: '',
  refs: [],
  firstFrame: null,
  lastFrame: null,
});

export const defaultPreset = (overrides = {}) => ({ ...PRESET_DEFAULTS, ...overrides, refs: overrides.refs ? [...overrides.refs] : [] });

export function normalizePreset(input = {}) {
  const p = { ...PRESET_DEFAULTS, ...input };

  const kind = p.kind ?? 'video';
  if (!['video', 'image'].includes(kind)) throw new Error(`Unknown preset kind: ${kind}`);
  if (!['360p', '720p'].includes(p.resolution)) throw new Error(`Unsupported preset resolution: ${p.resolution}`);
  if (!['16:9', '9:16'].includes(p.aspect)) throw new Error(`Unsupported preset aspect: ${p.aspect}`);
  const count = Number(p.count);
  if (![1, 2, 3, 4].includes(count)) throw new Error(`Preset count must be 1-4, got ${p.count}`);
  const durationS = kind === 'video' ? Number(p.durationS ?? 4) : 4;
  if (kind === 'video' && !DURATIONS.includes(durationS)) throw new Error(`Unsupported preset duration: ${p.durationS}s (Flow offers ${DURATIONS.join('/')}s)`);

  const template = p.template == null ? DEFAULT_TEMPLATE : String(p.template);
  if (template !== '') applyNameTemplate(template, SAMPLE_TOKENS); // throws on an unknown token

  // A preset holds either Ingredients references or Frames, never both (Flow's modes are exclusive).
  const refs = Array.isArray(p.refs) ? p.refs.filter((r) => r != null && r !== '').map((r) => String(r).trim()) : [];
  const firstFrame = p.firstFrame == null || p.firstFrame === '' ? null : String(p.firstFrame).trim();
  const lastFrame = p.lastFrame == null || p.lastFrame === '' ? null : String(p.lastFrame).trim();

  if (kind === 'image' && (refs.length > 0 || firstFrame || lastFrame)) {
    throw new Error('References (Ingredients and Frames) are for video presets; an image preset has none');
  }
  if (refs.length > 0 && (firstFrame || lastFrame)) throw new Error('A preset has either Ingredients references or Frames, not both');
  if (refs.length > 0) validateReferences({ input: 'ingredients', refs });
  if (firstFrame || lastFrame) validateReferences({ input: 'frames', firstFrame, lastFrame });

  return {
    name: String(p.name ?? '').trim(),
    kind,
    resolution: p.resolution,
    durationS,
    aspect: p.aspect,
    count,
    template,
    folder: String(p.folder ?? '').trim(),
    refs,
    firstFrame,
    lastFrame,
  };
}

// Fills a storyboard row's spec from the preset, but only where the row left the field out: the
// row always wins. An explicit text row keeps its plain text-to-video input rather than inheriting
// the preset's reference set. The naming template is not a job field; the caller applies it.
export function applyPresetToSpec(preset, spec = {}) {
  const out = { ...spec };
  const absent = (k) => out[k] == null || out[k] === '';
  if (absent('kind')) out.kind = preset.kind;
  if (absent('resolution')) out.resolution = preset.resolution;
  if (absent('durationS')) out.durationS = preset.durationS;
  if (absent('aspect')) out.aspect = preset.aspect;
  if (absent('count')) out.count = preset.count;

  const rowHasRefs = (out.refs?.length ?? 0) > 0 || out.firstFrame != null || out.lastFrame != null;
  if (!rowHasRefs && out.input !== 'text') {
    if (out.refs == null && preset.refs.length > 0) out.refs = [...preset.refs];
    if (absent('firstFrame') && preset.firstFrame) out.firstFrame = preset.firstFrame;
    if (absent('lastFrame') && preset.lastFrame) out.lastFrame = preset.lastFrame;
  }
  return out;
}
