import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SERVER_NAME, defaultConfigPath, buildServerEntry, checkNode, mergeServerEntry, inspectConfig,
  installClaudeDesktop,
} from '../lib/claude-desktop.js';
import { main } from '../lib/cli.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fp-claude-'));
const entry = (node = '/usr/local/bin/node') => ({ command: node, args: ['/repo/helper/bin/flowpilot.js', 'mcp'] });

test('the config path is Claude Desktop\'s own per platform, and FLOWPILOT_CLAUDE_CONFIG wins', () => {
  assert.equal(defaultConfigPath({ platform: 'darwin', home: '/Users/me', env: {} }),
    '/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
  assert.equal(defaultConfigPath({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } }),
    join('C:\\Users\\me\\AppData\\Roaming', 'Claude', 'claude_desktop_config.json'));
  assert.equal(defaultConfigPath({ platform: 'linux', home: '/home/me', env: {} }),
    '/home/me/.config/Claude/claude_desktop_config.json');
  assert.equal(defaultConfigPath({ platform: 'darwin', home: '/Users/me', env: { FLOWPILOT_CLAUDE_CONFIG: '/tmp/forced.json' } }), '/tmp/forced.json');
});

test('the server entry runs this Node by absolute path, points at this install, and carries a custom home/port through', () => {
  const e = buildServerEntry({ script: '/repo/helper/bin/flowpilot.js', node: '/opt/node/bin/node', env: {} });
  assert.deepEqual(e, { command: '/opt/node/bin/node', args: ['/repo/helper/bin/flowpilot.js', 'mcp'] });
  const withEnv = buildServerEntry({ script: '/repo/helper/bin/flowpilot.js', node: '/opt/node/bin/node', env: { FLOWPILOT_HOME: '/tmp/fp', FLOWPILOT_PORT: '49999', UNRELATED: 'x' } });
  assert.deepEqual(withEnv.env, { FLOWPILOT_HOME: '/tmp/fp', FLOWPILOT_PORT: '49999' });
});

test('a missing or too-old Node is refused with a message a person can act on', () => {
  assert.throws(() => checkNode({ execPath: '' }), /install Node\.js 20 or newer.*nodejs\.org/i);
  assert.throws(() => checkNode({ execPath: '/opt/node/bin/node', version: '18.20.0' }), /too old.*nodejs\.org/i);
  assert.equal(checkNode({ execPath: '/opt/node/bin/node', version: '20.11.0' }), '/opt/node/bin/node');
});

test('merge adds flowpilot without clobbering preferences or other MCP servers', () => {
  const config = { preferences: { theme: 'dark' }, mcpServers: { other: { command: 'npx', args: ['other'] } } };
  const { config: next, changed, previous } = mergeServerEntry(config, entry());
  assert.equal(changed, true);
  assert.equal(previous, null);
  assert.deepEqual(next.preferences, { theme: 'dark' });
  assert.deepEqual(next.mcpServers.other, { command: 'npx', args: ['other'] });
  assert.deepEqual(next.mcpServers[SERVER_NAME], entry());
  assert.equal(config.mcpServers[SERVER_NAME], undefined); // the input is not mutated
});

test('merge creates mcpServers when the config has none, and reports an identical entry as unchanged', () => {
  const first = mergeServerEntry({}, entry());
  assert.equal(first.changed, true);
  assert.deepEqual(first.config.mcpServers, { [SERVER_NAME]: entry() });
  const again = mergeServerEntry(first.config, entry());
  assert.equal(again.changed, false);
  assert.deepEqual(again.previous, entry());
});

test('merge updates a stale flowpilot entry and hands back what it replaced', () => {
  const old = { command: 'node', args: ['/old/flowpilot.js', 'mcp'] };
  const config = { mcpServers: { [SERVER_NAME]: old, other: { command: 'x' } } };
  const { config: next, changed, previous } = mergeServerEntry(config, entry());
  assert.equal(changed, true);
  assert.deepEqual(previous, old);
  assert.deepEqual(next.mcpServers[SERVER_NAME], entry());
  assert.deepEqual(next.mcpServers.other, { command: 'x' });
});

test('merge refuses a malformed mcpServers block rather than overwriting it', () => {
  assert.throws(() => mergeServerEntry({ mcpServers: ['not', 'an', 'object'] }, entry()), /mcpServers.*not an object.*refusing/i);
  assert.throws(() => mergeServerEntry({ mcpServers: 'oops' }, entry()), /refusing/i);
  assert.throws(() => mergeServerEntry(null, entry()), /not a JSON object/i);
});

test('install creates the config owner-only, adds a backup only when a file was there, and never touches other servers', () => {
  const home = tmp();
  const file = join(home, 'nested', 'claude_desktop_config.json');
  const first = installClaudeDesktop({ file, entry: entry(), now: () => new Date('2026-10-03T10:15:00') });
  assert.equal(first.changed, true);
  assert.equal(first.backup, null);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).mcpServers[SERVER_NAME], entry());

  const withOther = { preferences: { keep: true }, mcpServers: { other: { command: 'npx', args: ['other'] } } };
  writeFileSync(file, JSON.stringify(withOther, null, 2));
  const second = installClaudeDesktop({ file, entry: entry(), now: () => new Date('2026-10-03T10:16:07') });
  assert.equal(second.changed, true);
  assert.equal(second.backup, `${file}.bak-20261003-101607`);
  assert.deepEqual(JSON.parse(readFileSync(second.backup, 'utf8')), withOther); // the backup is the untouched original
  const merged = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(merged.preferences, { keep: true });
  assert.deepEqual(merged.mcpServers.other, { command: 'npx', args: ['other'] });
  assert.deepEqual(merged.mcpServers[SERVER_NAME], entry());
  assert.deepEqual(readdirSync(join(home, 'nested')).filter((f) => f.includes('.bak-')), ['claude_desktop_config.json.bak-20261003-101607']);
});

test('install is a no-op when the entry already matches: no rewrite, no backup', () => {
  const file = join(tmp(), 'claude_desktop_config.json');
  installClaudeDesktop({ file, entry: entry() });
  const before = readFileSync(file, 'utf8');
  const old = new Date('2000-01-01T00:00:00');
  utimesSync(file, old, old);
  const r = installClaudeDesktop({ file, entry: entry(), now: () => new Date('2026-10-03T10:20:00') });
  assert.equal(r.changed, false);
  assert.equal(r.backup, null);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(statSync(file).mtimeMs, old.getTime());
});

test('inspect says whether the config points at this install', () => {
  const file = join(tmp(), 'claude_desktop_config.json');
  assert.equal(inspectConfig({ file, entry: entry() }).reason, 'missing');
  writeFileSync(file, '{ not json');
  assert.equal(inspectConfig({ file, entry: entry() }).reason, 'unreadable');
  writeFileSync(file, JSON.stringify({ preferences: {} }));
  assert.equal(inspectConfig({ file, entry: entry() }).reason, 'no-server');
  writeFileSync(file, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command: 'node', args: ['/somewhere/else.js', 'mcp'] } } }));
  assert.equal(inspectConfig({ file, entry: entry() }).reason, 'different');
  writeFileSync(file, JSON.stringify({ mcpServers: { [SERVER_NAME]: entry() } }));
  const ok = inspectConfig({ file, entry: entry() });
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, 'ok');
});

// A working setup can name Node in any of the forms that start the same program: the absolute path
// install-claude writes, a different Node install, or the bare name on PATH. Only a command that
// cannot start Node, or args pointing at another script, is broken.
test('inspect accepts a working config whatever form its Node command takes, and still fails a broken one', () => {
  const file = join(tmp(), 'claude_desktop_config.json');
  const args = entry().args;
  const withCommand = (command, a = args) => {
    writeFileSync(file, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args: a } } }));
    return inspectConfig({ file, entry: entry() });
  };
  const absolute = withCommand('/opt/node/bin/node');
  assert.equal(absolute.ok, true, absolute.reason);
  const bare = withCommand('node');
  assert.equal(bare.ok, true, bare.reason);
  const otherInstall = withCommand('/usr/local/bin/node');
  assert.equal(otherInstall.ok, true, otherInstall.reason);
  // Anything that is not Node is still a broken config, and so is the right command with the wrong script.
  assert.equal(withCommand('/usr/bin/python3').ok, false);
  assert.equal(withCommand(undefined).ok, false);
  assert.equal(withCommand('node', ['/somewhere/else.js', 'mcp']).ok, false);
});

test('inspect accepts the same install reached from another checkout, and still fails a wrong script', () => {
  // The script in `args` identifies the install, and an install can be reached by more than one
  // path: another worktree or clone writes its own absolute path, which `doctor` used to report as
  // "points elsewhere" (report §10 fault F). A script that is not this program, or one that is no
  // longer there, is still a broken config.
  const file = join(tmp(), 'claude_desktop_config.json');
  const other = join(tmp(), 'helper', 'bin', 'flowpilot.js');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, '#!/usr/bin/env node\n// the flowpilot helper\n');
  const write = (command, args) => {
    writeFileSync(file, JSON.stringify({ mcpServers: { [SERVER_NAME]: { command, args } } }));
    return inspectConfig({ file, entry: entry() });
  };

  const elsewhere = write('node', [other, 'mcp']);
  assert.equal(elsewhere.ok, true, elsewhere.reason);
  assert.equal(elsewhere.reason, 'ok');

  const foreign = write('node', [join(dirname(other), 'other.js'), 'mcp']);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'different');
  assert.equal(write('node', [join(tmp(), 'helper', 'bin', 'flowpilot.js'), 'mcp']).ok, false, 'a deleted checkout is still broken');
  assert.equal(write('node', [other, 'mcp', '--port', '1']).ok, false, 'a different command line is still a different entry');
});

test('install-claude writes the config, says exactly what changed, and explains the one manual step', async () => {
  const file = join(tmp(), 'claude_desktop_config.json');
  const env = { FLOWPILOT_HOME: '/tmp/fp-home' }; // what a custom home/port would be copied into the entry
  const run = async (...argv) => {
    const out = [];
    const code = await main(argv, { env, out: (s) => out.push(s), err: (s) => out.push(s) });
    return { code, text: out.join('\n') };
  };
  const first = await run('install-claude', '--config', file);
  assert.equal(first.code, 0, first.text);
  assert.match(first.text, /Claude Desktop config: .*claude_desktop_config\.json/);
  assert.match(first.text, /Added mcpServers\.flowpilot/);
  assert.match(first.text, /Pair an agent/);
  assert.match(first.text, /flowpilot pair/);
  assert.match(first.text, /extension/i); // honest about the browser side
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(written.mcpServers.flowpilot.env, { FLOWPILOT_HOME: '/tmp/fp-home' });
  assert.equal(written.mcpServers.flowpilot.args[1], 'mcp');

  const second = await run('install-claude', '--config', file);
  assert.equal(second.code, 0, second.text);
  assert.match(second.text, /already points at this install/);
  assert.match(second.text, /Flow Pilot needs the extension installed in your Chromium browser and a Flow work tab\s+chosen/);
});

test('install-claude --json prints the raw result for scripts', async () => {
  const file = join(tmp(), 'claude_desktop_config.json');
  const out = [];
  const code = await main(['install-claude', '--config', file, '--json'], { env: {}, out: (s) => out.push(s), err: (s) => out.push(s) });
  assert.equal(code, 0);
  const r = JSON.parse(out.join('\n'));
  assert.equal(r.changed, true);
  assert.equal(r.entry.args[1], 'mcp');
  assert.equal(r.backup, null);
});
