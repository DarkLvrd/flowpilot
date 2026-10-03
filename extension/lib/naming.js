// Output naming: one documented token pattern turns a scene into a predictable relative path,
// and a collision helper guarantees a batch never overwrites an existing file. Pure: the actual
// writes live in the service worker (chrome.downloads) and the folder-picker module (File System
// Access API). docs/SPEC.md decision 5.

export const DEFAULT_TEMPLATE = '{project}/{scene}-{index}';
export const TOKENS = Object.freeze(['project', 'scene', 'name', 'index', 'prompt']);

// Characters no common filesystem allows in a name. '/' and '\' are separators, handled first.
const ILLEGAL = /[<>:"|?*\u0000-\u001f]/g;

// A token's value is required: a missing one is a bad storyboard row, not a blank in a file name.
export function applyNameTemplate(template, tokens = {}) {
  if (typeof template !== 'string' || template.trim() === '') throw new Error('A name template is required');
  const filled = template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_, token) => {
    if (!TOKENS.includes(token)) throw new Error(`Unknown name template token {${token}}; use one of ${TOKENS.map((t) => `{${t}}`).join(', ')}`);
    const value = token === 'index' ? formatIndex(tokens.index, tokens.total) : tokens[token];
    if (value == null || String(value).trim() === '') throw new Error(`Name template token {${token}} has no value`);
    return String(value);
  });
  return sanitizePath(filled);
}

// Numbered names stay sorted by width: `{index}` in a 120-row batch is 001..120.
function formatIndex(index, total) {
  if (index == null || index === '') return index;
  const n = Number(index);
  if (!Number.isInteger(n) || n < 1) throw new Error(`Name template {index} must be a positive whole number, got ${JSON.stringify(index)}`);
  const width = total == null ? 1 : String(total).length;
  return String(n).padStart(width, '0');
}

// Relative path only: separators normalized, empty and `.`/`..` segments dropped (no traversal,
// no absolute paths), illegal characters replaced, repeated separators collapsed.
export function sanitizePath(path) {
  const segments = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim())
    .filter((s) => s !== '' && s !== '.' && s !== '..');
  const out = segments.join('/');
  if (out === '') throw new Error('The name template produced an empty file name');
  return out;
}

// First free name for `desired` given names already taken (case-insensitive — macOS and Windows
// treat Fox.png and fox.png as the same file). The counter goes on the last segment so the
// directory the storyboard asked for is kept.
export function uniquify(desired, taken = []) {
  const used = new Set([...taken].map((t) => String(t).toLowerCase()));
  if (!used.has(String(desired).toLowerCase())) return desired;
  const cut = String(desired).lastIndexOf('/');
  const dir = cut < 0 ? '' : String(desired).slice(0, cut + 1);
  const base = cut < 0 ? String(desired) : String(desired).slice(cut + 1);
  for (let n = 2; ; n++) {
    const candidate = `${dir}${base}-${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}
