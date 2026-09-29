import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFReq, parseBatchResponse } from '../lib/rpc.js';
import { fixture } from './helpers.mjs';

test('builds f.req the way the page does', () => {
  // Captured request body for nzlxg: f.req=[[["nzlxg","[]",null,"generic"]]]
  assert.equal(buildFReq('nzlxg', []), '[[["nzlxg","[]",null,"generic"]]]');
  assert.equal(
    buildFReq('Zzl0ze', ['projects/p1', null, null, null, [1]]),
    '[[["Zzl0ze","[\\"projects/p1\\",null,null,null,[1]]",null,"generic"]]]',
  );
});

test('reads the inner payload of a real response', () => {
  const r = parseBatchResponse(fixture('nzlxg'), 'nzlxg');
  assert.deepEqual(r, { ok: true, data: [261, 1, 2, 2, null, 261] });
});

test('reads a large real response (catalog)', () => {
  const r = parseBatchResponse(fixture('HTrJv'), 'HTrJv');
  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.data));
});

test('fails closed when the rpc id is missing from the response', () => {
  const r = parseBatchResponse(fixture('nzlxg'), 'HTrJv');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'flow-changed');
});

test('fails closed on text that is not a batchexecute response', () => {
  for (const text of ['', '<html>Sign in</html>', ")]}'\n\nnot json\n"]) {
    const r = parseBatchResponse(text, 'nzlxg');
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'flow-changed');
  }
});

test('reports a server error entry as an rpc error', () => {
  const text = `)]}'\n\n60\n[["wrb.fr","as29s",null,null,null,[5],"generic"]]\n`;
  const r = parseBatchResponse(text, 'as29s');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'rpc-error');
  assert.match(r.message, /5/);
});

test('any UNUSUAL_ACTIVITY anywhere means blocked, even with a payload', () => {
  const inner = JSON.stringify([null, 'PUBLIC_ERROR_UNUSUAL_ACTIVITY']);
  const text = `)]}'\n\n99\n${JSON.stringify([['wrb.fr', 'x', inner, null, null, null, 'generic']])}\n`;
  const r = parseBatchResponse(text, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'blocked');
});

test('rate limits and refusals count as blocks, whatever the body says', () => {
  const ok = fixture('nzlxg');
  assert.equal(parseBatchResponse(ok, 'nzlxg', 429).kind, 'blocked');
  assert.equal(parseBatchResponse('', 'nzlxg', 403).kind, 'blocked');
  assert.equal(parseBatchResponse(ok, 'nzlxg', 200).ok, true);
  assert.equal(parseBatchResponse(ok, 'nzlxg').ok, true); // status unknown: judge the body only
});

test('a RESOURCE_EXHAUSTED (8) error entry is a block, other codes are plain errors', () => {
  const entry = (code) => `)]}'\n\n[["wrb.fr","nzlxg",null,null,null,[${code}],"generic"]]`;
  assert.equal(parseBatchResponse(entry(8), 'nzlxg').kind, 'blocked');
  assert.equal(parseBatchResponse(entry(3), 'nzlxg').kind, 'rpc-error');
});
