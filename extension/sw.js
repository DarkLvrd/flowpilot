// Flow Pilot service worker: wires the pure modules to Chrome. Holds no state in memory that
// matters; everything lives in chrome.storage.local (see lib/jobs.js).

import { RPC, buildFReq, parseBatchResponse } from './lib/rpc.js';
import { pageRpc } from './lib/page-rpc.js';
import { createJobStore } from './lib/jobs.js';
import { createRunner } from './lib/runner.js';
import { parseCatalog, creditCost } from './lib/catalog.js';
import { buildJob, safeName } from './lib/jobspec.js';
import { parseProjectMedia } from './lib/media.js';
import { newlyUploadedId, referenceNames } from './lib/refs.js';
import { promotePatch, assertFreePreview, awaitingPreviewCount } from './lib/preview.js';
import { parseSettingsSummary, parseCostLine } from './lib/preflight.js';
import { createBridge, HELPER_PORT } from './lib/bridge.js';
import { planImport } from './lib/storyboard.js';
import { normalizePreset } from './lib/presets.js';
import * as folder from './lib/folder.js';
import { buildReceipt } from './lib/receipt.js';
import { resumePlan, resumeGate, coolDown } from './lib/resume.js';
import { buildDiagnostics } from './lib/diagnostics.js';
import { FLOW_COMPAT, compatNote, compatReport } from './lib/compat.js';
import { createEntityStore, createTemplateStore, resolveEntities, composePrompt as compose, libraryWarnings } from './lib/entities.js';
import { loadDefaults } from './lib/prompt-assets.js';

const VERSION = chrome.runtime.getManifest().version;

const PROJECT_URL = /^https:\/\/flow\.google\.com\/project\/([0-9a-f-]{36})$/;
const CONTENT_ORIGIN = 'https://flow-content.google/';
const TICK_ALARM = 'flowpilot-tick';
const DEFAULT_SETTINGS = { maxInFlight: 2 };

const store = createJobStore(chrome.storage.local);
const local = {
  async get(key, fallback) { return (await chrome.storage.local.get(key))[key] ?? fallback; },
  set(key, value) { return chrome.storage.local.set({ [key]: value }); },
};

// ---- Entity library (report §2.1) ----------------------------------------------------------

// The helper mirrors the library to ~/.flowpilot/projects/<projectId>/entities.json so a reinstall
// does not lose it (report §4.8). Mirroring is best-effort: without the helper the library still
// lives in chrome.storage.local, and a mirror failure must never fail the write.
async function mirrorLibrary(library) {
  if (!bridge.connected) return;
  try { await bridge.request('writeEntities', { projectId: library.projectId, library }); } catch { /* helper went away; the next write tries again */ }
}

const entityStore = createEntityStore(chrome.storage.local, { onChange: (library) => { mirrorLibrary(library); } });
let templateStore = createTemplateStore(chrome.storage.local);

// The asset-derived template (section order, audio line, negatives, camera/motion libraries) is the
// default; a project override, once one exists, replaces it for that project.
loadDefaults().then((d) => { templateStore = createTemplateStore(chrome.storage.local, { defaults: d.template }); }).catch(() => {});

const projectIdOf = async (projectId) => {
  if (projectId != null && projectId !== '') {
    if (!/^[0-9a-f-]{36}$/.test(projectId)) throw new Error('Bad project id');
    return projectId;
  }
  const tab = await workTab.get();
  if (!tab) throw new Error('No work tab: open a Flow project in the tab you bound, or pass a project id');
  return tab.projectId;
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
  return parseBatchResponse(result.text, rpcid, result.status);
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
      summaryText: p.summaryText,
      input: p.input,
      model: p.model,
      cost: parseCostLine(p.costText ?? ''),
      generateEnabled: p.generateEnabled,
      overlayOpen: p.overlayOpen || p.agentPanelOpen,
      attached: p.attached,
      blocked: p.blocked,
      halt: p.halt,
    };
  },
  clickGenerate: (tabId, expect) => driverCall(tabId, 'clickGenerate', expect),
  inFront: (tabId) => driverCall(tabId, 'inFront'),
  uploadFile: (tabId, data, name, type) => driverCall(tabId, 'uploadFile', data, name, type),
  closePicker: (tabId) => driverCall(tabId, 'closePicker'),
};

// ---- References: resolve a job's referencePlan to media ids --------------------------------

const IMAGE_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };

async function projectMediaList(projectId) {
  const r = await flow.call('projectMedia', [`projects/${projectId}`, null, null, null, [1]]);
  if (r.kind === 'blocked') throw Object.assign(new Error(r.message), { blocked: r.message });
  if (!r.ok) throw new Error(`${RPC.projectMedia}: ${r.message}`);
  return parseProjectMedia(r.data);
}

// Polls Zzl0ze until the uploaded media shows up (LESSONS #13: read the id from Zzl0ze, never wait
// for the grid). No fixed sleep before an action — this waits on real Zzl0ze responses.
async function pollNewMediaId(projectId, before, name, { tries = 40, everyMs = 3000 } = {}) {
  for (let i = 0; i < tries; i++) {
    await new Promise((res) => setTimeout(res, everyMs));
    const after = await projectMediaList(projectId);
    try { return newlyUploadedId(before, after, name); } catch { /* not visible yet, or name ambiguous */ }
  }
  throw new Error(`The uploaded reference "${name}" did not appear in the project in time`);
}

// Turns a job's classified referencePlan into media ids: existing ids pass through; a local path is
// read by the helper (bytes magic-checked there), uploaded through Flow's own Upload media control,
// and its new id read from Zzl0ze. Throws to fail the job; err.blocked halts everything.
const refs = {
  async resolve(job) {
    const tab = await workTab.get();
    if (!tab) throw new Error('No work tab');
    const resolveOne = async (ref) => {
      if (ref.kind === 'mediaId') return ref.mediaId;
      if (!bridge.connected) throw new Error(`The helper is not connected, so it cannot read the reference file ${ref.path} (start it with \`npx flowpilot serve\`)`);
      const media = await bridge.request('readMedia', { path: ref.path });
      const before = await projectMediaList(tab.projectId);
      await driver.uploadFile(tab.tabId, media.data, media.name, IMAGE_MIME[media.type] ?? `image/${media.type}`);
      const id = await pollNewMediaId(tab.projectId, before, media.name);
      await driver.closePicker(tab.tabId).catch(() => {});
      return id;
    };
    const plan = job.referencePlan ?? { ingredients: [], firstFrame: null, lastFrame: null };
    const ingredients = [];
    for (const ref of plan.ingredients ?? []) ingredients.push(await resolveOne(ref));
    const firstFrame = plan.firstFrame ? await resolveOne(plan.firstFrame) : null;
    const lastFrame = plan.lastFrame ? await resolveOne(plan.lastFrame) : null;
    // The picker grid shows no media id, so the driver finds each tile by the media's name; look
    // the names up from Zzl0ze (uploads land there under their filename).
    const media = await projectMediaList(tab.projectId);
    const names = referenceNames(media, [...ingredients, firstFrame, lastFrame].filter(Boolean));
    return { ingredients, firstFrame, lastFrame, names };
  },
};

// ---- Files --------------------------------------------------------------------------------

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
  // Default location: Downloads/FlowPilot/<relative>.<ext> (docs/SPEC.md decision 5). A job with an
  // absolute outputPath goes through the helper instead. A folder the person picked for this session
  // is written directly with the File System Access API; otherwise the browser download runs, and
  // both never overwrite an existing file. `relative` is the job's naming-template path (or the
  // historical <project>/<name>), so a batch's files land exactly where its storyboard asked.
  async save(job, bytes, ext) {
    if (job.outputPath && bridge.connected) {
      const path = job.outputPath.replace(/\.[^./\\]+$/, '') + '.' + ext;
      return (await bridge.request('writeFile', { path, data: toBase64(bytes) })).path;
    }
    const relative = `${job.relativePath ?? `${safeName(job.projectName ?? job.projectId)}/${safeName(job.name)}`}.${ext}`;

    const root = await folder.getFolderHandle();
    if (root && await folder.folderGranted(root)) {
      const written = await folder.writeToFolder(root, relative, bytes);
      return `${root.name}/${written}`;
    }

    const filename = `FlowPilot/${relative}`;
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
    const runner = createRunner({ store, flow, driver, files, workTab, refs, settings });
    const result = await runner.tick();
    await local.set('flowpilot.lastTick', {
      at: Date.now(), error: result.error ?? null, waiting: result.waiting ?? null,
      waitingCount: result.waitingCount ?? null, waitingReason: result.waitingReason ?? null,
    });
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

async function addJob(spec, { recipes, projectId } = {}) {
  const tab = await workTab.get();
  if (!tab) throw new Error('Pick a work tab first');
  const pid = projectId ?? spec.projectId ?? tab.projectId;
  // The catalog is read once per batch (import passes its own) but validated through the one path.
  const cat = recipes === undefined ? await catalogRecipes() : recipes;
  return store.add(buildJob(await withComposedEntities(spec, pid), { projectId: pid, recipes: cat }));
}

// A job that names entities gets their canonical blocks, the style lock and the merged negatives
// composed into its prompt, byte-verbatim (report §2.2). A job that names none is returned untouched,
// so every existing path stays byte-for-byte what it was. Unknown, ambiguous or unapproved entities
// throw here: nothing is queued and no credits can be priced around a subject nobody approved.
async function withComposedEntities(spec, projectId) {
  const names = Array.isArray(spec.entities) ? spec.entities : (spec.entities ? [spec.entities] : []);
  if (!names.length) return spec;
  const [library, template] = await Promise.all([entityStore.library(projectId), templateStore.get(projectId)]);
  const resolved = resolveEntities(library, names);
  const composed = compose({ prompt: spec.prompt, entities: names, audio: spec.audio }, library, template);
  return {
    ...spec,
    prompt: composed.text,
    promptParts: composed.parts,
    // Frozen at add time: the job records the version of each subject it was composed with.
    entities: resolved.map((e) => ({ entityId: e.id, version: e.version, mediaId: e.primaryRefMediaId, role: 'inFrame' })),
  };
}

// Reads the model catalog for pricing. A blocked RPC halts everything and refuses the job rather
// than queueing blind (docs/SPEC.md hard rules; docs/LESSONS.md #19).
async function catalogRecipes() {
  const catalog = await flow.call('catalog', []);
  if (catalog.kind === 'blocked') {
    await store.halt(catalog.message);
    throw new Error(`Halted, job not added: ${catalog.message}`);
  }
  return catalog.ok ? parseCatalog(catalog.data) : null;
}

// ---- Storyboards and presets (decision 3) ----------------------------------------------------

const PRESETS_KEY = 'flowpilot.presets';
const listPresetsStored = () => local.get(PRESETS_KEY, []);

async function loadPreset(id) {
  if (!id) return null;
  const found = (await listPresetsStored()).find((p) => p.id === id);
  return found ? normalizePreset(found) : null;
}

// Plans a batch through the same buildJob validation addJob uses: per-row errors, per-row cost and
// the batch total, with a preset filling what a row left out. Never queues anything.
async function planBatch({ text, filename, template, presetId }) {
  const tab = await workTab.get();
  if (!tab) throw new Error('Pick a work tab first');
  const recipes = await catalogRecipes();
  const preset = await loadPreset(presetId);
  const taken = (await store.list()).map((j) => j.name);
  const result = planImport({ text, filename, projectId: tab.projectId, recipes, template: template ?? preset?.template ?? null, preset, taken });
  return { result, preset };
}

// Preview-first: a video job created as a free still (0-credit image) that the person approves
// before any video runs. The still is an ordinary image job built through the one validation path
// (buildJob); the video is held in `awaiting-preview` (buildJob's holdFirstFrame) and can never be
// submitted in that state. Promoting it (a dashboard action) attaches the approved still as the
// video's Frames first frame — the existing Frames path.
async function addPreviewJob(spec) {
  const tab = await workTab.get();
  if (!tab) throw new Error('Pick a work tab first');
  const projectId = spec.projectId ?? tab.projectId;
  const recipes = await catalogRecipes();
  const name = safeName(spec.name ?? `job-${Date.now()}`);

  // The still is the same scene at the same framing, built as an ordinary image job.
  const stillJob = buildJob(
    { name: `${name}-still`, prompt: spec.prompt, kind: 'image', resolution: spec.resolution, durationS: spec.durationS, aspect: spec.aspect, count: spec.count },
    { projectId, recipes },
  );
  // A preview must be free: refuse to create one whose still would cost credits (an unknown cost
  // fails closed here too), so the "free preview" step can never spend.
  assertFreePreview(stillJob.expectedCost, stillJob.recipe);

  // The held video: Frames, with the still as its first frame once the person approves it.
  const videoJob = buildJob({ ...spec, name, kind: 'video' }, { projectId, recipes, holdFirstFrame: true });

  const still = await store.add({ ...stillJob, role: 'preview' });
  const video = await store.add({ ...videoJob, role: 'video', previewJobId: still.id, initialState: 'awaiting-preview' });
  return { still, video };
}

// The person approved the still: attach it as the video's first frame and let it run (the pre-spend
// check and the session cap still gate the click). Dashboard-only — it is the free-then-paid step.
async function promotePreview(id) {
  const job = await store.get(id);
  if (!job) throw new Error(`No job ${id}`);
  if (job.state !== 'awaiting-preview') throw new Error(`${job.name} is ${job.state}, so there is no still to approve`);
  const still = job.previewJobId ? await store.get(job.previewJobId) : null;
  if (!still) throw new Error(`${job.name} has no still preview`);
  if (still.state === 'failed') throw new Error(`The still preview failed (${still.error ?? 'unknown error'}); cancel this video or re-queue the still`);
  if (still.state !== 'done' || !still.mediaId) throw new Error(`The still preview for ${job.name} is ${still.state}; approve it once it finishes`);
  return store.apply(id, { type: 'promote', ...promotePatch(job, still.mediaId) });
}

// The person's own action: bring the work tab (and its window) forward so Flow re-renders and the
// queue can submit (LESSONS #23). Never called by the extension on its own.
async function focusWorkTab() {
  const tab = await workTab.get();
  if (!tab) throw new Error('No work tab is set: open a Flow project and press "Use this tab"');
  const info = await chrome.tabs.get(tab.tabId).catch(() => null);
  await chrome.tabs.update(tab.tabId, { active: true });
  if (info?.windowId != null) await chrome.windows.update(info.windowId, { focused: true });
  return { tabId: tab.tabId };
}

// Messages from the popup and (step 3) the dashboard. Content scripts never send commands.
const fromDashboard = (sender) => !!sender?.url?.startsWith(chrome.runtime.getURL('dashboard/'));

const handlers = {
  async status() {
    const session = await store.session();
    const jobs = await store.list();
    const selfCheck = await local.get('flowpilot.selfCheck', null);
    const boundTab = await workTab.get();
    const approved = jobs.filter((j) => j.state === 'approved');
    const approvedHere = boundTab ? approved.filter((j) => j.projectId === boundTab.projectId) : [];
    // "Waiting" is what the person can act on: approved jobs that cannot submit until the Flow tab
    // is in front. With no work tab, every approved job is waiting for one.
    const waitingFor = !boundTab
      ? (approved.length ? { reason: 'no-work-tab', count: approved.length } : null)
      : (approvedHere.length ? { reason: 'front-tab', count: approvedHere.length } : null);
    const now = Date.now();
    // What a Resume would do, and whether it may go ahead — computed here so the dashboard never
    // has to guess, and pure so reading status still writes nothing (see the smoke test).
    const plan = resumePlan(jobs);
    const advice = coolDown({
      haltReason: session.halted ? session.haltReason : session.lastHalt?.reason ?? session.haltReason,
      haltedAt: session.haltedAt ?? session.lastHalt?.at ?? null,
      now,
    });
    return {
      session,
      jobs,
      workTab: boundTab,
      selfCheck,
      lastTick: await local.get('flowpilot.lastTick', null),
      receipt: await local.get('flowpilot.lastReceipt', null),
      helper: { connected: bridge.connected },
      counts: { awaitingPreview: awaitingPreviewCount(jobs), approved: approved.length },
      waitingFor,
      coolDown: advice,
      resume: resumeGate({ session, selfCheck, workTab: boundTab, plan, now, coolDown: advice }),
      // The dated "Flow compatibility" note, shown in the dashboard and carried in every bundle.
      compat: { ...FLOW_COMPAT, note: compatNote(FLOW_COMPAT), report: compatReport(FLOW_COMPAT) },
      diagnostics: await local.get('flowpilot.lastDiagnostics', null),
    };
  },
  async useTab({ tabId }) {
    const tab = await projectTab(tabId);
    if (!tab) throw new Error('That tab is not a Flow project page');
    await local.set('flowpilot.workTab', { tabId });
    return selfCheck(tabId);
  },
  selfCheck: async ({ tabId }) => selfCheck(tabId),

  // ---- Entities (report §2.7): job data, so agents may write these; the cap, the halt and the work
  // tab stay dashboard-only. Nothing here spends credits.
  async entities({ projectId }) {
    const pid = await projectIdOf(projectId);
    const [library, template, defaults] = await Promise.all([
      entityStore.library(pid), templateStore.get(pid), loadDefaults(),
    ]);
    return { projectId: pid, library, template, style: defaults.style, imageStyleText: defaults.imageStyleText, warnings: libraryWarnings(library) };
  },
  async entityUpsert({ projectId, entity }, sender) {
    const pid = await projectIdOf(projectId);
    return entityStore.upsert(pid, { by: fromDashboard(sender) ? 'dashboard' : 'agent', ...(entity ?? {}) });
  },
  async entityApprove({ projectId, name, by }, sender) {
    return entityStore.approve(await projectIdOf(projectId), name, { by: by ?? (fromDashboard(sender) ? 'dashboard' : 'agent') });
  },
  async entityUnapprove({ projectId, name, reason }, sender) {
    return entityStore.unapprove(await projectIdOf(projectId), name, { reason, by: fromDashboard(sender) ? 'dashboard' : 'agent' });
  },
  async entityAddRef({ projectId, name, ref, reason }, sender) {
    return entityStore.addRef(await projectIdOf(projectId), name, ref, { reason, by: fromDashboard(sender) ? 'dashboard' : 'agent' });
  },
  async entitySupersede({ projectId, name, ref, reason }, sender) {
    return entityStore.supersedeRef(await projectIdOf(projectId), name, ref, { reason, by: fromDashboard(sender) ? 'dashboard' : 'agent' });
  },
  async entityRemove({ projectId, name }) {
    return entityStore.remove(await projectIdOf(projectId), name);
  },
  // The project's one style entity, from the canonical style_lock.md asset (report §2.1).
  async entitySetStyle({ projectId, name }) {
    const pid = await projectIdOf(projectId);
    const defaults = await loadDefaults();
    return entityStore.setStyle(pid, { name: name ?? 'Style lock', description: defaults.style.description, negative: defaults.style.negative.join(', '), by: 'dashboard' });
  },
  async entityImport({ projectId, library, mode }) {
    return entityStore.importLibrary(await projectIdOf(projectId), library, { mode: mode ?? 'replace' });
  },
  async entityExport({ projectId }) {
    return entityStore.exportLibrary(await projectIdOf(projectId));
  },
  // Reinstall recovery: pull the helper's mirrored file back into chrome.storage (report §4.8).
  async entityRestore({ projectId, mode = 'merge' }) {
    const pid = await projectIdOf(projectId);
    if (!bridge.connected) throw new Error('The helper is not connected, so there is no mirrored library to restore from (start it with `npx flowpilot serve`)');
    const { library } = await bridge.request('readEntities', { projectId: pid });
    return { projectId: pid, mode, library: await entityStore.importLibrary(pid, library, { mode }) };
  },
  // Dry run: exactly the text Flow would receive for this composition, with per-part hashes.
  async composePrompt({ projectId, spec }) {
    const pid = await projectIdOf(projectId);
    const [library, template] = await Promise.all([entityStore.library(pid), templateStore.get(pid)]);
    const composed = compose({ ...(spec ?? {}) }, library, template);
    return {
      projectId: pid,
      ...composed,
      entities: resolveEntities(library, spec?.entities ?? []).map((e) => ({ entityId: e.id, name: e.name, version: e.version, mediaId: e.primaryRefMediaId })),
    };
  },
  addJob: async ({ spec }) => addJob(spec),
  previewJob: async ({ spec }) => addPreviewJob(spec),
  // Storyboard import: preview plans and prices; import validates all rows again and refuses the
  // whole batch on any bad row, so a partial import can never happen (decision 3).
  previewImport: async ({ text, filename, template, presetId }) => {
    const { result } = await planBatch({ text, filename, template, presetId });
    const session = await store.session();
    const tab = await workTab.get();
    return {
      format: result.format,
      rows: result.rows.map((r) => ({
        index: r.index, scene: r.scene, ok: r.ok, error: r.error, cost: r.cost,
        spec: r.spec, job: r.job, recipe: r.job?.recipe ?? null, relativePath: r.job?.relativePath ?? null,
      })),
      totalCost: result.totalCost,
      knownCost: result.knownCost,
      unknownCostRows: result.unknownCostRows,
      anyError: result.anyError,
      cap: session.cap,
      spent: session.spent,
      workTab: tab ? { tabId: tab.tabId, projectId: tab.projectId } : null,
    };
  },
  importJobs: async ({ text, filename, template, presetId }) => {
    const { result } = await planBatch({ text, filename, template, presetId });
    if (result.anyError) {
      const errors = result.rows.filter((r) => !r.ok).map((r) => `row ${r.index}: ${r.error}`).join('; ');
      throw new Error(`Import refused, nothing was queued — ${errors}`);
    }
    const added = [];
    for (const row of result.rows) added.push((await store.add(row.job)).id);
    return { added, totalCost: result.totalCost, format: result.format };
  },
  listPresets: async () => listPresetsStored(),
  // Presets are dashboard-only changes (like the cap): an agent may read them and use them to queue
  // jobs, but only a person may save or delete one.
  async savePreset({ preset }, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can save a preset');
    const clean = normalizePreset(preset ?? {});
    if (!clean.name) throw new Error('A preset needs a name');
    const list = await listPresetsStored();
    const id = preset?.id ?? crypto.randomUUID();
    const record = { id, ...clean };
    const i = list.findIndex((p) => p.id === id);
    if (i >= 0) list[i] = record;
    else list.push(record);
    await local.set(PRESETS_KEY, list);
    return record;
  },
  async deletePreset({ id }, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can delete a preset');
    await local.set(PRESETS_KEY, (await listPresetsStored()).filter((p) => p.id !== id));
    return { deleted: id };
  },
  approve: async ({ id }) => store.apply(id, { type: 'approve' }),
  cancel: async ({ id }) => store.apply(id, { type: 'cancel' }),
  requeue: async ({ id }) => store.apply(id, { type: 'requeue' }),
  retryDownload: async ({ id }) => store.apply(id, { type: 'retryDownload' }),
  // Bringing the work tab forward is the person's action (popup and dashboard), never an agent's.
  focusWorkTab: async () => focusWorkTab(),
  // The free-then-paid step: only the dashboard approves the still and lets the video spend.
  async promotePreview({ id }, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can approve a still preview');
    return promotePreview(id);
  },
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
  // A spend-and-safety receipt for this queue, built only from Flow Pilot's own records. The last
  // one is kept in local storage so it is a record on the machine, not just a download; exporting
  // it is a deliberate press in the dashboard (report §9.1).
  async receipt({ includePrompts }, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can export a receipt');
    const doc = buildReceipt({
      jobs: await store.list(), session: await store.session(),
      selfCheck: await local.get('flowpilot.selfCheck', null), version: VERSION,
      now: Date.now(), includePrompts: !!includePrompts,
    });
    await local.set('flowpilot.lastReceipt', { at: doc.summary.at, filename: doc.filename, summary: doc.summary });
    return doc;
  },
  // The Resume press (report §9.2): dashboard-only, one deliberate press per resume. It refuses
  // while the halt is still set or the self-check is still failing, decides nothing on a timer, and
  // releases only the rows that never reached Flow — each still goes through the pre-spend checks
  // and the cap like a fresh job. It never clicks anything itself; the engine does that, and only
  // after the hold is gone.
  async resumeUnsubmitted(_msg, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can resume the queue');
    const session = await store.session();
    const plan = resumePlan(await store.list());
    const gate = resumeGate({
      session, plan, selfCheck: await local.get('flowpilot.selfCheck', null),
      workTab: await workTab.get(), now: Date.now(),
    });
    if (!gate.ok) throw new Error(gate.blockers.join(' '));
    await store.resume();
    return { resumed: gate.ready.length, waiting: gate.waiting, warnings: gate.warnings, skipped: plan.skipped.length };
  },
  // One local file a person can read or send (report §9.3): version, the dated compatibility note,
  // the self-check with its failing steps, halt reasons, and recent job states. Built from an
  // allow-list and scrubbed, so no cookie, auth header, token, prompt or path can ride along.
  async diagnostics(_msg, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can save a diagnostic bundle');
    const doc = buildDiagnostics({
      version: VERSION,
      jobs: await store.list(), session: await store.session(), selfCheck: await local.get('flowpilot.selfCheck', null),
      lastTick: await local.get('flowpilot.lastTick', null), workTab: await workTab.get(), now: Date.now(),
    });
    await local.set('flowpilot.lastDiagnostics', { at: doc.fields.at, filename: doc.filename, fields: doc.fields });
    return doc;
  },
  // The one-time code a person gives an agent (docs/SPEC.md decision 9); the helper issues it.
  async pairCode(_msg, sender) {
    if (!fromDashboard(sender)) throw new Error('Only the dashboard can pair an agent');
    return bridge.request('pairCode');
  },
};

// ---- Helper bridge ------------------------------------------------------------------------

// What agents may do through the helper: the same as a dashboard click, minus the cap, the halt,
// the work tab and pairing (docs/SPEC.md decisions 7-9). Entity and prompt-composition commands are
// job data, so they are allowed (report §2.7).
const AGENT_COMMANDS = new Set([
  'status', 'addJob', 'previewImport', 'importJobs', 'listPresets', 'approve', 'cancel', 'requeue', 'retryDownload',
  'entities', 'entityUpsert', 'entityApprove', 'entityUnapprove', 'entityAddRef', 'entitySupersede',
  'entityRemove', 'entitySetStyle', 'entityImport', 'entityExport', 'entityRestore', 'composePrompt',
]);

const bridge = createBridge({
  url: `ws://127.0.0.1:${HELPER_PORT}/bridge`,
  async onCommand(cmd, args) {
    if (!AGENT_COMMANDS.has(cmd)) throw new Error(`Agents cannot ${cmd}; that is done in the dashboard`);
    const value = await handlers[cmd](args, null);
    if (!NO_TICK.has(cmd)) tick();
    return value;
  },
  onChange: (connected) => local.set('flowpilot.helper', { connected }),
});

// Only extension pages (popup, dashboard) may send commands; content scripts run on Flow's origin.
const fromExtensionPage = (sender) => sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(''));

// Reads must not tick: a tick writes storage, which makes the dashboard read status again (a loop),
// and entity/prompt commands never need a runner tick at all.
const NO_TICK = new Set([
  'status', 'selfCheck', 'previewImport', 'listPresets',
  'entities', 'composePrompt', 'entityExport',
  'entityUpsert', 'entityApprove', 'entityUnapprove', 'entityAddRef', 'entitySupersede', 'entityRemove',
  'entitySetStyle', 'entityImport', 'entityRestore',
]);

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!fromExtensionPage(sender) || !handlers[msg?.cmd]) return false;
  handlers[msg.cmd](msg, sender)
    .then((value) => { reply({ ok: true, value }); if (!NO_TICK.has(msg.cmd)) tick(); })
    .catch((e) => reply({ ok: false, error: e.message }));
  return true;
});

// ---- Lifecycle ----------------------------------------------------------------------------

// Each service-worker start is a fresh instance, so any job left in `submitting` belongs to a dead
// one and never reached its write-ahead click: put it back to `approved`.
store.recover();
chrome.alarms.create(TICK_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== TICK_ALARM) return;
  bridge.start(); // no-op while connected; retries a helper that was down
  tick();
});
bridge.start();

// A job approved in the dashboard waits for the person to bring Flow to the front: go as soon as they do.
// Only then: every tick asks Flow for status, which stays on the alarm's pace (LESSONS #16).
// A halt, or the cool-down hold that follows one, can never submit anything, so it never ticks
// here: otherwise the hold's "waiting" line would re-tick on every focus change for as long as the
// person takes to resume.
async function tickIfWaiting() {
  const session = await store.session();
  if (session.halted || session.awaitingResume) return;
  if ((await local.get('flowpilot.lastTick', null))?.waiting) tick();
}
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  if ((await local.get('flowpilot.workTab', null))?.tabId === tabId) tickIfWaiting();
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) tickIfWaiting();
});

// Re-check the work tab whenever it (re)loads; other Flow tabs are left alone.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  const bound = await local.get('flowpilot.workTab', null);
  if (bound?.tabId === tabId) selfCheck(tabId);
});
