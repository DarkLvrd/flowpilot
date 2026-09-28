// Flow Pilot service worker: wires the pure modules to Chrome. Holds no state in memory that
// matters; everything lives in chrome.storage.local (see lib/jobs.js).

import { RPC, buildFReq, parseBatchResponse } from './lib/rpc.js';
import { pageRpc } from './lib/page-rpc.js';
import { createJobStore } from './lib/jobs.js';
import { createRunner } from './lib/runner.js';
import { parseCatalog, creditCost, recipeFor } from './lib/catalog.js';
import { parseProjectMedia } from './lib/media.js';
import { parseSettingsSummary, parseCostLine } from './lib/preflight.js';

const PROJECT_URL = /^https:\/\/flow\.google\.com\/project\/([0-9a-f-]{36})$/;
const CONTENT_ORIGIN = 'https://flow-content.google/';
const TICK_ALARM = 'flowpilot-tick';
const DEFAULT_SETTINGS = { maxInFlight: 2 };

const store = createJobStore(chrome.storage.local);
const local = {
  async get(key, fallback) { return (await chrome.storage.local.get(key))[key] ?? fallback; },
  set(key, value) { return chrome.storage.local.set({ [key]: value }); },
};

// ---- Flow tab access ----------------------------------------------------------------------

async function projectTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const m = tab?.url && new URL(tab.url).origin + new URL(tab.url).pathname;
  const pid = m && m.match(PROJECT_URL)?.[1];
  return pid ? { tabId, projectId: pid } : null;
}

const workTab = {
  async get() {
    const bound = await local.get('flowpilot.workTab', null);
    return bound ? projectTab(bound.tabId) : null;
  },
};

async function callInTab(tabId, key, inner) {
  const rpcid = RPC[key];
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, world: 'MAIN', func: pageRpc, args: [rpcid, buildFReq(rpcid, inner)],
  });
  if (result.error) return { ok: false, kind: 'rpc-error', message: result.error };
  return parseBatchResponse(result.text, rpcid);
}

const flow = {
  async call(key, inner) {
    const tab = await workTab.get();
    if (!tab) return { ok: false, kind: 'rpc-error', message: 'No work tab' };
    return callInTab(tab.tabId, key, inner);
  },
};

async function driverCall(tabId, cmd, ...args) {
  let reply = await chrome.tabs.sendMessage(tabId, { to: 'driver', cmd, args }).catch(() => null);
  if (!reply) {
    // Tab loaded before the extension was installed/reloaded: inject the driver once, retry.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/driver.js'] });
    reply = await chrome.tabs.sendMessage(tabId, { to: 'driver', cmd, args });
  }
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

const driver = {
  async prepare(job) {
    const p = await driverCall(job.tabId, 'prepare', job);
    return {
      tabId: job.tabId,
      url: p.url,
      prompt: p.prompt,
      summary: parseSettingsSummary(p.summaryText),
      input: p.input,
      cost: parseCostLine(p.costText ?? ''),
      generateEnabled: p.generateEnabled,
      overlayOpen: p.overlayOpen || p.agentPanelOpen,
      blocked: p.blocked,
      halt: p.halt,
    };
  },
  async clickGenerate() {
    const tab = await workTab.get();
    return driverCall(tab.tabId, 'clickGenerate');
  },
};

// ---- Files --------------------------------------------------------------------------------

const safeName = (s) => String(s).replace(/[^\w.\- ]+/g, '_').trim().slice(0, 120) || 'untitled';

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const MIME = { mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

const files = {
  async fetchBytes(url) {
    if (!url.startsWith(CONTENT_ORIGIN)) throw new Error(`Refusing to download from ${new URL(url).origin}`);
    const res = await fetch(url, { credentials: 'omit' }); // signed URL: no cookies needed or sent
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
  // Default location: Downloads/FlowPilot/<project>/<job-name>.<ext> (docs/SPEC.md decision 5).
  async save(job, bytes, ext) {
    const filename = `FlowPilot/${safeName(job.projectName ?? job.projectId)}/${safeName(job.name)}.${ext}`;
    const id = await chrome.downloads.download({
      url: `data:${MIME[ext]};base64,${toBase64(bytes)}`, filename, conflictAction: 'uniquify', saveAs: false,
    });
    const item = await new Promise((resolve, reject) => {
      const listener = async (delta) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'in_progress') return;
        chrome.downloads.onChanged.removeListener(listener);
        const [done] = await chrome.downloads.search({ id });
        delta.state.current === 'complete' ? resolve(done) : reject(new Error(`Save failed: ${done?.error ?? 'interrupted'}`));
      };
      chrome.downloads.onChanged.addListener(listener);
    });
    return item.filename;
  },
};

// ---- Engine -------------------------------------------------------------------------------

let ticking = null;
async function tick() {
  if (ticking) return ticking;
  ticking = (async () => {
    const settings = { ...DEFAULT_SETTINGS, ...(await local.get('flowpilot.settings', {})) };
    const runner = createRunner({ store, flow, driver, files, workTab, settings });
    const result = await runner.tick();
    await local.set('flowpilot.lastTick', { at: Date.now(), error: result.error ?? null });
    await guardWorkTab();
  })().finally(() => { ticking = null; });
  return ticking;
}

// The work tab must not be discarded while jobs run (docs/LESSONS.md #10).
async function guardWorkTab() {
  const tab = await workTab.get();
  if (!tab) return;
  const busy = (await store.list()).some((j) => ['submitting', 'submitted', 'rendering', 'downloading'].includes(j.state));
  await chrome.tabs.update(tab.tabId, { autoDiscardable: !busy }).catch(() => {});
}

// ---- Self-check ---------------------------------------------------------------------------

async function selfCheck(tabId) {
  const tab = await projectTab(tabId);
  if (!tab) return null;
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(detail != null ? { detail: String(detail) } : {}) });

  try {
    for (const c of await driverCall(tabId, 'selfCheck')) add(c.name, c.ok);
  } catch (e) {
    add('Page driver', false, e.message);
  }

  const rpc = (key, inner) => callInTab(tabId, key, inner).catch((e) => ({ ok: false, kind: 'rpc-error', message: e.message }));
  const credits = await rpc('credits', []);
  const balance = credits.ok && typeof credits.data?.[0] === 'number' ? credits.data[0] : null;
  add('Credit balance', balance != null, balance ?? credits.message);

  const catalog = await rpc('catalog', []);
  let omniCost = null;
  if (catalog.ok) {
    try { omniCost = creditCost(parseCatalog(catalog.data), 'abra_t2v_4s_360p'); } catch (e) { add('Model catalog', false, e.message); }
  }
  add('Model catalog', omniCost != null, omniCost != null ? `Omni Flash 4s 360p = ${omniCost} credits` : catalog.message);

  const models = await rpc('videoModels', []);
  add('Omni Flash available', models.ok && JSON.stringify(models.data).includes('"abra",1'));

  const media = await rpc('projectMedia', [`projects/${tab.projectId}`, null, null, null, [1]]);
  let count = null;
  if (media.ok) { try { count = parseProjectMedia(media.data).length; } catch (e) { add('Project media', false, e.message); } }
  add('Project media', count != null, count != null ? `${count} items` : media.message);

  const blocked = [credits, catalog, models, media].find((r) => r.kind === 'blocked');
  if (blocked) await store.halt(blocked.message);

  const result = { tabId, projectId: tab.projectId, at: Date.now(), ok: checks.every((c) => c.ok), checks, balance };
  await local.set('flowpilot.selfCheck', result);
  await chrome.action.setBadgeText({ tabId, text: result.ok ? '✓' : '!' });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: result.ok ? '#1e8e3e' : '#d93025' });
  return result;
}

// ---- Jobs from people and agents ------------------------------------------------------------

async function addJob(spec) {
  const tab = await workTab.get();
  if (!tab) throw new Error('Pick a work tab first');
  const prompt = String(spec.prompt ?? '').replace(/\r\n?/g, '\n').trim();
  if (!prompt) throw new Error('Prompt is empty');
  const projectId = spec.projectId ?? tab.projectId;
  if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error('Bad project id');

  const settings = {
    kind: spec.kind ?? 'video',
    input: spec.input ?? 'text',
    resolution: spec.resolution ?? '720p',
    durationS: Number(spec.durationS ?? 4),
    aspect: spec.aspect ?? '16:9',
    count: Number(spec.count ?? 1),
    model: spec.model,
    refs: spec.refs ?? [],
    firstFrame: spec.firstFrame,
    lastFrame: spec.lastFrame,
  };
  if (settings.input === 'text') settings.input = 'ingredients'; // text-only runs from the Ingredients tab
  if (settings.refs.length || settings.firstFrame || settings.lastFrame) {
    throw new Error('Reference images and frames are not supported yet (the driver cannot attach them)');
  }
  if (!['16:9', '9:16'].includes(settings.aspect)) throw new Error(`Unsupported aspect: ${settings.aspect}`);
  if (![1, 2, 3, 4].includes(settings.count)) throw new Error(`Count must be 1-4, got ${settings.count}`);
  const recipe = recipeFor(settings);
  const catalog = await flow.call('catalog', []);
  const unit = catalog.ok ? creditCost(parseCatalog(catalog.data), recipe) : null;
  const expectedCost = unit == null ? null : unit * settings.count;

  return store.add({ name: safeName(spec.name ?? `job-${Date.now()}`), projectId, prompt, settings, recipe, expectedCost });
}

// Messages from the popup and (step 3) the dashboard. Content scripts never send commands.
const fromDashboard = (sender) => sender.url?.startsWith(chrome.runtime.getURL('dashboard/'));

const handlers = {
  async status() {
    return {
      session: await store.session(),
      jobs: await store.list(),
      workTab: await workTab.get(),
      selfCheck: await local.get('flowpilot.selfCheck', null),
      lastTick: await local.get('flowpilot.lastTick', null),
    };
  },
  async useTab({ tabId }) {
    const tab = await projectTab(tabId);
    if (!tab) throw new Error('That tab is not a Flow project page');
    await local.set('flowpilot.workTab', { tabId });
    return selfCheck(tabId);
  },
  selfCheck: async ({ tabId }) => selfCheck(tabId),
  addJob: async ({ spec }) => addJob(spec),
  approve: async ({ id }) => store.apply(id, { type: 'approve' }),
  cancel: async ({ id }) => store.apply(id, { type: 'cancel' }),
  requeue: async ({ id }) => store.apply(id, { type: 'requeue' }),
  // Dashboard-only (docs/SPEC.md decision 8): agents and the popup cannot set the cap or un-halt.
  async setCap({ cap }, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can set the credit cap');
    if (!Number.isInteger(cap) || cap < 0) throw new Error('Cap must be a whole number of credits');
    return store.setCap(cap);
  },
  async clearHalt(_msg, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can clear a halt');
    return store.clearHalt();
  },
};

// Only extension pages (popup, dashboard) may send commands; content scripts run on Flow's origin.
const fromExtensionPage = (sender) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!fromExtensionPage(sender) || !handlers[msg?.cmd]) return false;
  handlers[msg.cmd](msg, sender)
    .then((value) => { reply({ ok: true, value }); tick(); })
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});

// ---- Lifecycle ----------------------------------------------------------------------------

// Each service-worker start is a fresh instance, so any job left in `submitting` belongs to a dead
// one and never reached its write-ahead click: put it back to `approved`.
store.recover();
chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === TICK_ALARM) tick(); });

// Re-check the work tab whenever it (re)loads; other Flow tabs are left alone.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const bound = await local.get('flowpilot.workTab', null);
  if (bound?.tabId === tabId) selfCheck(tabId);
});
