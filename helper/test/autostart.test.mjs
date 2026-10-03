import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createAutoStart, isHelperListening, startHelper } from '../lib/autostart.js';

const tick = () => new Promise((r) => setImmediate(r));

// A stand-in for a spawned helper: an EventEmitter with kill() that also emits 'exit'.
function fakeChild() {
  const c = new EventEmitter();
  c.exitCode = null;
  c.signalCode = null;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = (sig = 'SIGTERM') => {
    if (c.exitCode != null) return false;
    c.exitCode = 0;
    c.signalCode = sig;
    c.emit('exit', 0, sig);
    return true;
  };
  return c;
}

// probe() answers from a script; the last value repeats.
function scripted(...answers) {
  let i = 0;
  const fn = async () => answers[Math.min(i++, answers.length - 1)];
  fn.calls = () => i;
  return fn;
}

test('a helper already listening on the port is used as-is; nothing is spawned and nothing is stopped', async () => {
  let starts = 0;
  const probe = scripted(true);
  const auto = createAutoStart({ port: 47615, probe, start: () => { starts++; return fakeChild(); }, sleep: tick });
  const r = await auto.ensure();
  assert.equal(r.started, false);
  assert.equal(r.child, null);
  assert.equal(auto.started, false);
  assert.equal(starts, 0);
  assert.equal(probe.calls(), 1);
  await auto.stop(); // a helper we did not start is never touched
  assert.equal(starts, 0);
});

test('with no helper listening, one is started and then stopped with the MCP server', async () => {
  let starts = 0;
  const child = fakeChild();
  const auto = createAutoStart({
    port: 47615,
    probe: scripted(false, true),
    start: () => { starts++; return child; },
    sleep: tick,
  });
  const r = await auto.ensure();
  assert.equal(r.started, true);
  assert.equal(r.child, child);
  assert.equal(auto.started, true);
  assert.equal(starts, 1);
  await auto.stop();
  assert.equal(child.signalCode, 'SIGTERM');
  assert.equal(auto.started, false);
});

test('a second ensure() reuses a helper this MCP server already started (one owner, one process)', async () => {
  let starts = 0;
  const probe = scripted(false, true);
  const auto = createAutoStart({ port: 47615, probe, start: () => { starts++; return fakeChild(); }, sleep: tick });
  await auto.ensure();
  await auto.ensure();
  assert.equal(starts, 1);
  assert.equal(probe.calls(), 2); // once before starting, once to see it come up; never a third probe
  await auto.stop();
});

test('if our child dies but another helper won the port, that helper is adopted (never a second one)', async () => {
  const dead = fakeChild();
  dead.exitCode = 1;
  dead.signalCode = null;
  const probe = scripted(false, true);
  const auto = createAutoStart({ port: 47615, probe, start: () => dead, sleep: tick });
  const r = await auto.ensure();
  assert.equal(r.started, false);
  assert.equal(r.child, null);
  assert.equal(auto.started, false);
  await auto.stop();
});

test('if our child dies with no helper listening, ensure() fails with a clear message and leaves nothing running', async () => {
  const dead = fakeChild();
  dead.exitCode = 1;
  const auto = createAutoStart({
    port: 47615,
    probe: scripted(false, false),
    // emits after ensure() has attached its stderr listener (start() is called after the first probe)
    start: () => { queueMicrotask(() => dead.stderr.emit('data', 'Port 47615 is taken')); return dead; },
    sleep: tick,
  });
  await assert.rejects(() => auto.ensure(), /stops? right after it started|Port 47615 is taken/);
  assert.equal(auto.started, false);
});

test('a helper that never becomes healthy fails with an actionable message instead of hanging', async () => {
  const child = fakeChild();
  const auto = createAutoStart({ port: 47615, probe: scripted(false), start: () => child, tries: 2, sleep: tick });
  await assert.rejects(() => auto.ensure(), /did not start on 127\.0\.0\.1:47615.*flowpilot serve/s);
  assert.equal(child.signalCode, 'SIGTERM'); // the process it started is gone
  assert.equal(auto.started, false);
});

test('isHelperListening() is true only for a live helper on that port', async () => {
  const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  assert.equal(await isHelperListening(port), true);
  await new Promise((r) => server.close(r));
  assert.equal(await isHelperListening(port), false); // closed port, not a throw
  assert.equal(await isHelperListening(port), false);
});

test('startHelper() spawns this Node with `flowpilot.js serve` and routes its output away from stdout', () => {
  const calls = [];
  const child = startHelper({
    port: 1234,
    env: { FLOWPILOT_HOME: '/tmp/fp' },
    log: (m) => calls.push(['log', m]),
    spawnImpl: (cmd, args, opts) => { calls.push([cmd, args, opts]); return fakeChild(); },
  });
  const [cmd, args, opts] = calls[0];
  assert.equal(cmd, process.execPath);
  assert.match(args[0], /helper[/\\]bin[/\\]flowpilot\.js$/);
  assert.deepEqual(args.slice(1), ['serve']);
  assert.equal(opts.env.FLOWPILOT_PORT, '1234');
  assert.equal(opts.env.FLOWPILOT_HOME, '/tmp/fp');
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']); // never inherit stdout: that is the MCP channel
  child.stdout.emit('data', 'helper log line');
  assert.deepEqual(calls.at(-1), ['log', 'helper log line']);
});
