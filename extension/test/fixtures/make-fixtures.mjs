#!/usr/bin/env node
// Rebuild the committed test fixtures from a fresh recon capture (recon/raw/capture, gitignored).
// Keeps the raw batchexecute response text, but redacts every URL token and signature and
// trims long lists. Usage: node extension/test/fixtures/make-fixtures.mjs
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const capture = join(here, '../../../recon/raw/capture');
const files = existsSync(capture) ? readdirSync(capture) : [];
const has = (rpcid) => files.some((f) => f.endsWith(`-${rpcid}.json`));
const load = (rpcid) => JSON.parse(readFileSync(join(capture, files.find((f) => f.endsWith(`-${rpcid}.json`))), 'utf8'));

const redact = (s) => s
  // /asb/<token> links open the media for anyone holding them; Flow serves them from several hosts.
  .replace(/https:\/\/[\w.-]+\/asb\/[A-Za-z0-9_\-=]+/g, 'https://lh3.googleusercontent.com/asb/REDACTED')
  .replace(/Signature=[A-Za-z0-9_\-]+/g, 'Signature=REDACTED');

// Re-wrap an inner payload as a batchexecute response (lengths are not trusted by the parser).
function envelope(rpcid, inner) {
  const line = JSON.stringify([['wrb.fr', rpcid, JSON.stringify(inner), null, null, null, 'generic'], ['di', 100], ['af.httprm', 100, '0', 1]]);
  return `)]}'\n\n${line.length}\n${line}\n25\n[["e",4,null,null,${line.length + 30}]]\n`;
}
const innerOf = (resp) => JSON.parse(JSON.parse(resp.match(/\[\["wrb\.fr".*\n/)[0])[0][2]);

const out = {};
const scrub = (inner) => JSON.parse(redact(JSON.stringify(inner)));
// Raw responses with nothing to redact stay byte-for-byte, so the envelope parser sees the real
// format. A fixture whose capture is not on disk is left as it is rather than rebuilt from nothing.
for (const id of ['nzlxg', 'HTrJv', 'yBhWQ', 'ngNC2']) if (has(id)) out[id] = load(id).response;
if (has('as29s')) out.as29s = envelope('as29s', scrub(innerOf(load('as29s').response)));
if (has('Zzl0ze')) {
  const media = scrub(innerOf(load('Zzl0ze').response));
  media[3] = media[3].slice(0, 2); // voice list: keep two
  out.Zzl0ze = envelope('Zzl0ze', media);
}

// The picker's tile labels (live 2026-10-03, recon/raw/live-media.mjs + live-picker.mjs): a
// generated media's tile shows the workflow's own title, not the prompt the record stores. Four of
// the character project's records plus the workflow nodes that title them — including two records
// that share a title, which is why an ambiguous tile must be refused rather than guessed at.
// Frozen here so the reader is tested against the ids and titles this account really produced.
const liveMedia = join(here, '../../../recon/raw/media.json');
const TITLED = [
  'b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca', // image, title "Woman in racing outfit posing"
  'aba6cb9c-2c26-4aed-b41f-b36d13c1d751', // image, the same title
  '53a922e2-e516-4984-bc61-f3168a7a672b', // video, title "Person in Formula One car"
  '279f9435-8c17-42e7-9773-a81f6bd09f93', // video, title "Person standing on rooftop balcony"
];
if (existsSync(liveMedia)) {
  const inner = innerOf(readFileSync(liveMedia, 'utf8'));
  const records = [];
  const workflows = [];
  const walk = (node, visit) => { if (!Array.isArray(node)) return; if (visit(node) === false) return; for (const c of node) walk(c, visit); };
  walk(inner, (node) => {
    if (Array.isArray(node) && TITLED.includes(node[0])) {
      records.push(node);
      // The workflow node that titles this record lives in the same payload.
      walk(inner, (w) => { if (Array.isArray(w) && w[0] === node[2] && Array.isArray(w[3])) workflows.push(w); return true; });
      return false;
    }
    return true;
  });
  if (records.length === TITLED.length) {
    out['Zzl0ze-project-titles'] = envelope('Zzl0ze', scrub([null, workflows, records, [], null, []]));
  }
}
// The paid character job (2026-10-03, 4 credits): the generate response already carries the finished
// media record, so the fixture is that record plus the project's entity list. It is the shape a
// character video really produces — the mention-form prompt with a null first element and the
// entity-reference list inside the recipe entry — and it is what the reader is tested against.
const paid = readdirSync(join(here, '../../../recon/raw')).filter((d) => d.startsWith('generate-')).sort().reverse()
  .map((d) => join(here, '../../../recon/raw', d))
  .find((d) => existsSync(join(d, '02-MZZa6b.json')) && existsSync(join(d, '00-reload.json')));
if (paid) {
  const gen = JSON.parse(readFileSync(join(paid, '02-MZZa6b.json'), 'utf8'));
  const inner = innerOf(gen.response);
  const workflow = inner[2][0];   // the generate response is [null, <balance>, [workflow], [record]]
  const record = inner[3][0];
  const charProject = 'de7baa89-1896-4825-bf06-ab0853619277';
  const entity = [charProject, '0bfec740-409e-42f5-80d1-82baac3349f3', null, [1, 'nancy', [[['e3696fd0-eb73-4b82-a8a2-096fa4cb0dde']]]], 'b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca', [1376, 768], [1789233954, 151166000], [1789233973, 168948000]];
  out['Zzl0ze-character-video'] = envelope('Zzl0ze', scrub([null, [workflow], [record], [], null, [entity]]));
}

for (const [id, text] of Object.entries(out)) writeFileSync(join(here, `${id}.txt`), text);
console.log('wrote', Object.keys(out).join(', '));
