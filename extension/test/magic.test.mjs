import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sniffType, acceptDownload } from '../lib/magic.js';

const bytes = (...parts) => new Uint8Array(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : p)));
const pad = (b, n = 64) => { const out = new Uint8Array(n); out.set(b); return out; };

const MP4 = pad(bytes([0, 0, 0, 0x20], 'ftypisom'));
const PNG = pad(bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a]));
const JPEG = pad(bytes([0xff, 0xd8, 0xff, 0xe0]));
const WEBP = pad(bytes('RIFF', [0x24, 0, 0, 0], 'WEBP'));
const HTML = pad(bytes('<!doctype html>'));

test('recognises the file types Flow returns', () => {
  assert.equal(sniffType(MP4), 'mp4');
  assert.equal(sniffType(PNG), 'png');
  assert.equal(sniffType(JPEG), 'jpeg');
  assert.equal(sniffType(WEBP), 'webp');
  assert.equal(sniffType(HTML), null);
  assert.equal(sniffType(new Uint8Array(3)), null);
});

test('a video is accepted only if it is an MP4', () => {
  assert.equal(acceptDownload(MP4, 'video').ok, true);
  assert.equal(acceptDownload(JPEG, 'video').ok, false); // the poster-image trap (LESSONS #15)
  assert.equal(acceptDownload(HTML, 'video').ok, false);
});

test('an image is accepted only if it is an image', () => {
  for (const img of [PNG, JPEG, WEBP]) assert.equal(acceptDownload(img, 'image').ok, true);
  assert.equal(acceptDownload(MP4, 'image').ok, false);
});

test('a rejection says what was found', () => {
  assert.match(acceptDownload(HTML, 'video').reason, /expected mp4/i);
});
