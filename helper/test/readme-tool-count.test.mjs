// The README's claim about how many MCP tools exist is a fact about this build, so it is checked
// against the published list (helper/lib/mcp.js TOOL_NAMES) instead of drifting. The count is
// stated exactly once — where the tools are listed — so no later paragraph can disagree with
// `flowpilot doctor`, which prints TOOL_NAMES.length at runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TOOL_NAMES } from '../lib/mcp.js';

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

test('the README states the MCP tool count once, and it is the published count', () => {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const stated = [...readme.matchAll(/([A-Za-z]+)\s+tools\b/g)]
    .map((m) => ({ word: m[1], count: NUMBER_WORDS[m[1].toLowerCase()] }))
    .filter((m) => m.count != null);
  assert.equal(stated.length, 1, `the README must state the tool count exactly once; found ${stated.length}: ${stated.map((s) => `${s.word} tools`).join(', ') || 'none'}`);
  assert.equal(stated[0].count, TOOL_NAMES.length, `the README says "${stated[0].word} tools" but the MCP server publishes ${TOOL_NAMES.length}`);
});
