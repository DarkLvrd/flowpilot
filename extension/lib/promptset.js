// "Describe it once": turn one plain sentence into a small set of scene prompts.
//
// Template:  "<subject>, <shot>, <light>, <motion>, <style>"
//   subject — the sentence you typed, whitespace collapsed and trailing punctuation trimmed
//   shot    — one per scene, from SHOTS (the first scene is the widest, so the set reads as one scene)
//   light   — the first matching LIGHT_RULES pattern, else "soft natural light"
//   motion  — what you typed in Motion, else the first matching MOTION_RULES pattern, else nothing
//   style   — what you typed in Style, else nothing
//
// Pure and offline: no network, no model, no randomness — the same sentence always gives the same
// prompts. Every prompt is plain text meant to be edited before it is queued.
export const PROMPT_TEMPLATE = '<subject>, <shot>, <light>, <motion>, <style>';

// Wide first: scene 1 sets the place, the later scenes move in. This is the documented order.
const SHOTS = [
  { label: 'Establishing shot', shot: 'wide establishing shot' },
  { label: 'Medium shot', shot: 'medium shot' },
  { label: 'Close-up', shot: 'close-up shot' },
  { label: 'Over-the-shoulder shot', shot: 'over-the-shoulder shot' },
  { label: 'Low-angle shot', shot: 'low-angle shot' },
  { label: 'Tracking shot', shot: 'tracking shot' },
];
export const SHOT_LABELS = SHOTS.map((s) => s.label);

const DEFAULT_LIGHT = 'soft natural light';
const LIGHT_RULES = [
  [/\bnight\b|\bmidnight\b|\bdark\b|\bmoonlit\b|\bnight-time\b/i, 'moody low light'],
  [/\bsunrise\b|\bdawn\b|\bmorning\b/i, 'warm golden-hour light'],
  [/\bsunset\b|\bdusk\b|\bevening\b|\bgolden hour\b/i, 'warm sunset light'],
  [/\brain\b|\bstorm\b|\bovercast\b|\bfog\b|\bgrey\b|\bgray\b|\bmist\b/i, 'soft overcast light'],
  [/\bsnow\b|\bwinter\b|\bice\b|\bfrost\b/i, 'cool bright light'],
  [/\bneon\b|\bcity\b|\bcrowd\b|\bmarket\b|\bstreet\b/i, 'colourful ambient light'],
  [/\bstudio\b|\bportrait\b/i, 'clean studio lighting'],
];
const MOTION_RULES = [
  [/\bruns?\b|\brunning\b|\bsprints?\b|\bchases?\b|\brushes?\b/i, 'moving with energy'],
  [/\bwalks?\b|\bwalking\b|\bstrolls?\b|\bstrides?\b/i, 'walking steadily'],
  [/\bflies?\b|\bflying\b|\bsoars?\b|\bfloats?\b|\bdrifts?\b/i, 'drifting through the air'],
  [/\bturns?\b|\bturning\b|\blooks?\b|\bglances?\b|\bfaces?\b/i, 'turning towards the camera'],
  [/\bopens?\b|\bcloses?\b|\breaches?\b|\bpicks?\b|\bhands?\b/i, 'a small deliberate action'],
];

const firstMatch = (rules, text) => rules.find(([re]) => re.test(text))?.[1] ?? null;

// One sentence → [{ index, label, prompt }]. Throws on an empty sentence.
export function expandPromptSet(description, { scenes = 4, style = '', motion = '' } = {}) {
  const subject = normalizeSubject(description);
  if (!subject) throw new Error('Describe the scene in one sentence first');
  const light = firstMatch(LIGHT_RULES, subject) ?? DEFAULT_LIGHT;
  const move = String(motion ?? '').trim() || firstMatch(MOTION_RULES, subject) || '';
  const look = String(style ?? '').trim();
  return SHOTS.slice(0, clampScenes(scenes)).map((s, i) => ({
    index: i + 1,
    label: s.label,
    prompt: [subject, s.shot, light, move, look].filter((part) => part !== '').join(', '),
  }));
}

function normalizeSubject(description) {
  return String(description ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, '')
    .replace(/[.!?\u3002\uff01\uff1f]+$/g, '')
    .trim();
}

function clampScenes(scenes) {
  const n = Number(scenes);
  if (!Number.isFinite(n)) return 4;
  return Math.min(SHOTS.length, Math.max(1, Math.trunc(n)));
}
