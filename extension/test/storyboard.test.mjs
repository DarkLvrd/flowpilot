import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchResponse } from '../lib/rpc.js';
import { parseCatalog } from '../lib/catalog.js';
import { detectFormat, parseStoryboard, parseCsv, parseRows, planImport } from '../lib/storyboard.js';
import { fixture } from './helpers.mjs';

const recipes = parseCatalog(parseBatchResponse(fixture('HTrJv'), 'HTrJv').data);
const PID = '78d6e0a5-3e82-4491-9f47-6755a6b4c173';
const REF = '1037d045-1d92-4e1e-a0f7-b695b9ed1372';

const plan = (text, opts = {}) => planImport({ text, projectId: PID, recipes, ...opts });

// ---- format detection ------------------------------------------------------------------------

test('detectFormat uses the extension or the first meaningful character', () => {
  assert.equal(detectFormat('[{"prompt":"x"}]', ''), 'json');
  assert.equal(detectFormat('prompt,scene\nx,y', ''), 'csv');
  assert.equal(detectFormat('', 'story.json'), 'json');
  assert.equal(detectFormat('', 'story.csv'), 'csv');
  assert.equal(detectFormat('', 'story.txt'), null);
});

// ---- CSV -------------------------------------------------------------------------------------

test('parseCsv reads a header and quoted fields, including commas and newlines in quotes', () => {
  const rows = parseCsv('scene,prompt,count\r\n"fox, the red",  a red fox,2\n"two\nlines",x,1\n');
  assert.deepEqual(rows, [
    { scene: 'fox, the red', prompt: '  a red fox', count: '2' }, // values stay raw; parseRows trims
    { scene: 'two\nlines', prompt: 'x', count: '1' },
  ]);
});

test('parseCsv unescapes doubled quotes and tolerates blank lines and a trailing comma', () => {
  const rows = parseCsv('scene,prompt\n"say ""hi""",now,\n\n');
  assert.deepEqual(rows, [{ scene: 'say "hi"', prompt: 'now' }]);
});

test('parseCsv refuses a CSV with no header row', () => {
  assert.throws(() => parseCsv('   '), /empty/i);
});

test('a CSV storyboard needs a prompt or scene column', () => {
  assert.throws(() => parseStoryboard('name,count\nx,2', { filename: 'a.csv' }), /prompt|scene/i);
});

// ---- JSON ------------------------------------------------------------------------------------

test('parseStoryboard accepts a JSON array, a {scenes} wrapper and a {jobs} wrapper', () => {
  assert.equal(parseStoryboard('[{"prompt":"a"}]').rows.length, 1);
  assert.equal(parseStoryboard('{"scenes":[{"prompt":"a"},{"prompt":"b"}]}').rows.length, 2);
  assert.equal(parseStoryboard('{"jobs":[{"prompt":"a"}]}').rows.length, 1);
});

test('a JSON string entry is shorthand for a prompt', () => {
  assert.deepEqual(parseStoryboard('["a red fox"]').rows, [{ prompt: 'a red fox' }]);
});

test('parseStoryboard refuses empty text, bad JSON and the wrong JSON shape', () => {
  assert.throws(() => parseStoryboard('  '), /empty/i);
  assert.throws(() => parseStoryboard('[{"prompt":]'), /JSON/i);
  assert.throws(() => parseStoryboard('{"prompt":"a"}'), /array|scenes|jobs/i);
  assert.throws(() => parseStoryboard('[1,2]'), /row/i);
  assert.throws(() => parseStoryboard('[]'), /no rows/i);
});

// ---- field mapping ---------------------------------------------------------------------------

test('parseRows normalizes aliases and numbers, and splits a CSV refs cell', () => {
  const [row] = parseRows([{ scene: 's', prompt: 'p', mode: 'ingredients', duration: '6s', res: '360P', 'first frame': REF, refs: `${REF}|/pics/a.png`, count: '2' }]);
  assert.equal(row.input, 'ingredients');
  assert.equal(row.durationS, 6);
  assert.equal(row.resolution, '360p');
  assert.equal(row.firstFrame, REF);
  assert.deepEqual(row.refs, [REF, '/pics/a.png']);
  assert.equal(row.count, 2);
});

test('parseRows keeps a JSON array of refs as-is and normalizes kind aliases', () => {
  const [row] = parseRows([{ prompt: 'p', kind: 'Clip', refs: [REF] }]);
  assert.equal(row.kind, 'video');
  assert.deepEqual(row.refs, [REF]);
});

// ---- planImport ------------------------------------------------------------------------------

test('a JSON batch plans every row through the real job model with a cost each', () => {
  const p = plan(JSON.stringify([
    { scene: 'opening', prompt: 'a red fox', kind: 'video', resolution: '360p', duration: 4 },
    { scene: 'closing', prompt: 'a blue fox', kind: 'video', resolution: '360p', duration: 4, count: 2 },
  ]));
  assert.equal(p.rows.length, 2);
  assert.ok(p.rows.every((r) => r.ok), JSON.stringify(p.rows));
  assert.equal(p.rows[0].job.recipe, 'abra_t2v_4s_360p');
  assert.equal(p.rows[0].cost, 4);
  assert.equal(p.rows[1].cost, 8);
  assert.equal(p.totalCost, 12);
  assert.equal(p.anyError, false);
});

test('a CSV batch plans rows and applies the naming template with a zero-padded index', () => {
  const csv = 'scene,prompt,kind,resolution,duration\nopening,a red fox,video,360p,4\nclosing,a blue fox,video,360p,4\n';
  const p = plan(csv, { filename: 'story.csv', template: '{project}/{scene}-{index}' });
  assert.deepEqual(p.rows.map((r) => r.job.relativePath), [`${PID}/opening-1`, `${PID}/closing-2`]);
  assert.deepEqual(p.rows.map((r) => r.job.name), ['opening', 'closing']);
});

test('one bad row fails only itself and is reported per row, never skipped silently', () => {
  const p = plan(JSON.stringify([
    { scene: 'good', prompt: 'a red fox', resolution: '360p', duration: 4 },
    { scene: 'bad', kind: 'image', prompt: 'x', refs: ['/pics/face.png'] },
    { scene: 'noprompt' },
  ]));
  assert.equal(p.anyError, true);
  assert.equal(p.rows[0].ok, true);
  assert.equal(p.rows[1].ok, false);
  assert.match(p.rows[1].error, /video/i);
  assert.equal(p.rows[2].ok, false);
  assert.match(p.rows[2].error, /Prompt is empty/);
});

test('a reference row and a frames row build correctly from the storyboard fields', () => {
  const p = plan(JSON.stringify([
    { scene: 'ref', prompt: 'x', mode: 'ingredients', refs: [REF], resolution: '360p', duration: 4 },
    { scene: 'frames', prompt: 'y', mode: 'frames', firstFrame: REF, resolution: '360p', duration: 4 },
  ]));
  assert.ok(p.rows.every((r) => r.ok), JSON.stringify(p.rows));
  assert.equal(p.rows[0].job.recipe, 'abra_r2v_4s_360p');
  assert.equal(p.rows[1].job.recipe, 'abra_i2v_4s_360p');
});

test('duplicate scene names are made unique so a batch never overwrites itself', () => {
  const p = plan(JSON.stringify([
    { prompt: 'a', scene: 'shot' },
    { prompt: 'b', scene: 'shot' },
    { prompt: 'c', scene: 'shot' },
  ]));
  assert.deepEqual(p.rows.map((r) => r.job.name), ['shot', 'shot-2', 'shot-3']);
});

test('a template with {scene} also gets unique paths for duplicate scenes', () => {
  const p = plan(JSON.stringify([{ prompt: 'a', scene: 'shot' }, { prompt: 'b', scene: 'shot' }]), { template: '{scene}' });
  assert.deepEqual(p.rows.map((r) => r.job.relativePath), ['shot', 'shot-2']);
});

test('an unknown catalog still plans rows, with the total reported as unknown', () => {
  const p = plan(JSON.stringify([{ prompt: 'a' }, { prompt: 'b' }]), { recipes: null });
  assert.equal(p.anyError, false);
  assert.equal(p.knownCost, 0);
  assert.equal(p.totalCost, null);
  assert.deepEqual(p.unknownCostRows, [1, 2]);
});

test('an absolute output path from the storyboard is carried onto the job', () => {
  const p = plan(JSON.stringify([{ prompt: 'a', outputPath: '/Users/me/film/fox.mp4' }]));
  assert.equal(p.rows[0].job.outputPath, '/Users/me/film/fox.mp4');
});

test('a pasted CSV list with no filename is detected and planned', () => {
  const p = plan('scene,prompt\nopening,a red fox\nclosing,a blue fox\n');
  assert.equal(p.format, 'csv');
  assert.equal(p.rows.length, 2);
  assert.ok(p.rows.every((r) => r.ok));
});
