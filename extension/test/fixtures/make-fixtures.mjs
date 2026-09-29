#!/usr/bin/env node
// Rebuild the committed test fixtures from a fresh recon capture (recon/raw/capture, gitignored).
// Keeps the raw batchexecute response text, but redacts every URL token and signature and
// trims long lists. Usage: node extension/test/fixtures/make-fixtures.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const capture = join(here, '../../../recon/raw/capture');
const files = readdirSync(capture);
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
// Raw responses with nothing to redact stay byte-for-byte, so the envelope parser sees the real format.
for (const id of ['nzlxg', 'HTrJv', 'yBhWQ', 'ngNC2']) out[id] = load(id).response;
const scrub = (inner) => JSON.parse(redact(JSON.stringify(inner)));
out.as29s = envelope('as29s', scrub(innerOf(load('as29s').response)));
const media = scrub(innerOf(load('Zzl0ze').response));
media[3] = media[3].slice(0, 2); // voice list: keep two
out.Zzl0ze = envelope('Zzl0ze', media);
for (const [id, text] of Object.entries(out)) writeFileSync(join(here, `${id}.txt`), text);
console.log('wrote', Object.keys(out).join(', '));
