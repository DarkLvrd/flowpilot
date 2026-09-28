// Magic-byte checks: a download counts only when its bytes match its type (docs/SPEC.md).

const ascii = (bytes, at, text) => [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

export function sniffType(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (ascii(bytes, 4, 'ftyp')) return 'mp4';
  if (bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'webp';
  if (ascii(bytes, 0, 'GIF8')) return 'gif';
  return null;
}

const ACCEPTED = { video: ['mp4'], image: ['png', 'jpeg', 'webp'] };
export const EXTENSION = { mp4: 'mp4', png: 'png', jpeg: 'jpg', webp: 'webp' };

// Returns { ok: true, type } or { ok: false, reason }.
export function acceptDownload(bytes, kind) {
  const type = sniffType(bytes);
  const allowed = ACCEPTED[kind] ?? [];
  if (allowed.includes(type)) return { ok: true, type };
  return { ok: false, reason: `expected ${allowed.join(' or ')} for a ${kind}, got ${type ?? 'unknown bytes'}` };
}
