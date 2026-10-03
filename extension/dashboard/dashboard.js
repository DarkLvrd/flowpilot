// Dashboard: cap, halt, agents, storyboard/batch import, presets, the folder picker, and the queue.
import { send, renderChecks } from '../ui.js';
import { setFolderHandle, getFolderHandle, folderGranted } from '../lib/folder.js';
import { applyNameTemplate } from '../lib/naming.js';

const $ = (id) => document.getElementById(id);
const show = (id, e) => { const el = $(id); el.hidden = !e; el.textContent = e?.message ?? ''; };
const act = (fn, errId = 'error') => async (...a) => { try { show(errId, null); await fn(...a); } catch (e) { show(errId, e); } };

let shownCap; // the saved cap last written into the box; the box is only refreshed when it changes
let importFilename = ''; // the chosen file's name, so format detection can use the extension
let preview = null; // the last previewImport result
let presets = []; // the saved presets, for the select and Load

async function render() {
  const s = await send('status');
  $('halt').hidden = !s.session.halted;
  $('haltReason').textContent = `⛔ All jobs halted: ${s.session.haltReason}`;
  $('summary').textContent = `${s.workTab ? `Work tab: project ${s.workTab.projectId}` : 'No work tab: open a Flow project and click "Use this tab" in the popup.'}`
    + ` · Credits this session: ${s.session.spent} / ${s.session.cap ?? 'no cap'}`
    + (s.selfCheck?.balance != null ? ` · Balance: ${s.selfCheck.balance}` : '')
    + (s.lastTick?.waiting ? ` · ⏳ ${s.lastTick.waiting}` : '');
  if (s.session.cap !== shownCap) { shownCap = s.session.cap; $('cap').value = s.session.cap ?? ''; }
  renderChecks($('checks'), s.selfCheck);
  $('helper').textContent = s.helper?.connected
    ? '✅ Helper running: agents can use Flow Pilot.'
    : '⚪ Helper not running (only needed for agents): start it with `npx flowpilot serve`.';
  $('pair').disabled = !s.helper?.connected;

  // A batch cannot run without a work tab; say that plainly instead of failing silently.
  const active = s.jobs.some((j) => ['queued', 'approved', 'submitting', 'submitted', 'rendering', 'downloading'].includes(j.state));
  $('waiting').textContent = s.workTab
    ? (s.lastTick?.waiting ? `⏳ ${s.lastTick.waiting}` : '')
    : (active ? 'Pick a work tab in the popup before a batch can run.' : '');

  presets = await send('listPresets').catch(() => []);
  renderPresets(presets);
  await renderFolder();

  const rows = s.jobs.slice().reverse().map((j) => {
    const tr = document.createElement('tr');
    const cell = (t) => { const td = document.createElement('td'); td.textContent = t; tr.append(td); return td; };
    cell(j.name);
    cell(j.state + (j.error ? ` — ${j.error}` : '') + (j.file ? ` → ${j.file.path}` : ''));
    cell(j.cost ?? (j.expectedCost == null ? '?' : `~${j.expectedCost}`));
    cell(j.prompt);
    const actions = cell('');
    const btn = (label, cmd) => { const b = document.createElement('button'); b.className = 'inline'; b.textContent = label; b.onclick = act(() => send(cmd, { id: j.id })); actions.append(b); };
    if (j.state === 'queued') btn('Approve', 'approve');
    if (['queued', 'approved', 'halted'].includes(j.state)) btn('Cancel', 'cancel');
    if (j.state === 'failed' && j.clickedAt == null && !j.mayHaveSubmitted) btn('Re-queue', 'requeue');
    if (j.state === 'failed' && j.mediaId) btn('Retry download', 'retryDownload');
    return tr;
  });
  $('jobs').replaceChildren(...rows);
}

// ---- Storyboard import ------------------------------------------------------------------------

function importInput() {
  return {
    text: $('importText').value,
    filename: importFilename,
    template: $('template').value.trim(),
    presetId: $('presetSelect').value,
  };
}

async function doPreview() {
  if ($('importText').value.trim() === '') throw new Error('Paste a storyboard or choose a .json/.csv file first');
  preview = await send('previewImport', importInput());
  renderPreview(preview);
}

function renderPreview(p) {
  if (!p) {
    $('previewTable').hidden = true;
    $('previewRows').replaceChildren();
    $('importSummary').textContent = '';
    $('import').disabled = true;
    return;
  }
  $('previewTable').hidden = false;
  const rows = p.rows.map((r) => {
    const tr = document.createElement('tr');
    const cell = (t) => { const td = document.createElement('td'); td.textContent = t; tr.append(td); return td; };
    cell(String(r.index));
    cell(r.scene ?? '');
    cell(r.spec?.prompt ?? '');
    cell(r.ok ? describe(r.spec) : '');
    cell(r.cost == null ? (r.ok ? 'priced at click' : '') : `~${r.cost}`);
    cell(r.error ?? '');
    return tr;
  });
  $('previewRows').replaceChildren(...rows);

  const bad = p.rows.filter((r) => !r.ok).length;
  const total = p.totalCost == null ? (p.knownCost ? `at least ${p.knownCost}` : 'unknown') : p.totalCost;
  let summary = `${p.rows.length} row(s) · total ${total} credit(s)`;
  summary += p.cap == null
    ? ' · no session cap set: nothing submits until you set one'
    : ` · cap ${p.cap}, ${p.spent} spent (${p.cap - p.spent} left)`;
  if (p.unknownCostRows.length) summary += ` · ${p.unknownCostRows.length} row(s) priced by Flow at click time`;
  $('importSummary').textContent = bad ? `${summary} · ${bad} row(s) need fixing before the import can run` : summary;
  $('import').disabled = bad > 0 || p.rows.length === 0;
}

const describe = (spec) => spec?.kind === 'video'
  ? `video ${spec.resolution} ${spec.durationS}s ${spec.aspect} x${spec.count}`
  : `${spec?.kind ?? 'video'}`;

async function loadFile(file) {
  if (!file) return;
  importFilename = file.name;
  $('importText').value = await file.text();
  await doPreview();
}

// ---- Presets and the output folder ------------------------------------------------------------

function renderPresets(list) {
  const select = $('presetSelect');
  const current = select.value;
  select.replaceChildren(new Option('(none)', ''), ...list.map((p) => new Option(p.name, p.id)));
  if (list.some((p) => p.id === current)) select.value = current;
}

function presetFromForm() {
  const f = Object.fromEntries(new FormData($('add')));
  const preset = {
    name: $('presetName').value.trim(),
    kind: f.kind,
    resolution: f.resolution,
    durationS: Number(f.durationS),
    aspect: f.aspect,
    count: Number(f.count),
    template: $('template').value.trim(),
    refs: (f.refs ?? '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean),
  };
  if (f.firstFrame?.trim()) preset.firstFrame = f.firstFrame.trim();
  if (f.lastFrame?.trim()) preset.lastFrame = f.lastFrame.trim();
  return preset;
}

function loadPresetIntoForm(p) {
  const form = $('add');
  form.kind.value = p.kind;
  form.resolution.value = p.resolution;
  form.durationS.value = String(p.durationS);
  form.aspect.value = p.aspect;
  form.count.value = String(p.count);
  form.refs.value = (p.refs ?? []).join('\n');
  form.firstFrame.value = p.firstFrame ?? '';
  form.lastFrame.value = p.lastFrame ?? '';
  if (p.template != null) $('template').value = p.template;
  $('presetName').value = p.name;
  updateTemplateExample();
}

async function renderFolder() {
  const handle = await getFolderHandle();
  if (!handle) { $('folderName').textContent = 'Downloads/FlowPilot (browser download)'; return; }
  const granted = await folderGranted(handle);
  $('folderName').textContent = granted ? `${handle.name}/` : `${handle.name} (permission expired — choose it again)`;
}

function updateTemplateExample() {
  try {
    $('templateExample').textContent = `Example: ${applyNameTemplate($('template').value, { project: 'my-film', scene: 'opening shot', index: 1, total: 1 })}.mp4`;
  } catch (e) {
    $('templateExample').textContent = e.message;
  }
}

// ---- Wiring -----------------------------------------------------------------------------------

$('setCap').onclick = act(async () => {
  // Number('') is 0: an empty box must not silently become a cap of 0.
  if ($('cap').value.trim() === '') throw new Error('Type a number of credits first');
  await send('setCap', { cap: Number($('cap').value) });
});
$('clearHalt').onclick = act(() => send('clearHalt'));
$('pair').onclick = act(async () => {
  const { code, expiresAt } = await send('pairCode');
  const until = new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('pairCode').textContent = `flowpilot pair ${code}   (one use, until ${until})`;
});

$('importFile').onchange = act(() => loadFile($('importFile').files[0]), 'importError');
for (const type of ['dragenter', 'dragover']) $('drop').addEventListener(type, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const type of ['dragleave', 'drop']) $('drop').addEventListener(type, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
$('drop').addEventListener('drop', (e) => act(() => loadFile(e.dataTransfer?.files?.[0]), 'importError')());
$('preview').onclick = act(doPreview, 'importError');
$('import').onclick = act(async () => {
  const r = await send('importJobs', importInput());
  importFilename = '';
  $('importText').value = '';
  preview = null;
  renderPreview(null);
  $('importSummary').textContent = `Queued ${r.added.length} job(s)${r.totalCost == null ? '' : ` · ~${r.totalCost} credits`}. Approve them below (or use Approve all queued).`;
  await render();
}, 'importError');

$('loadPreset').onclick = act(async () => {
  const p = presets.find((x) => x.id === $('presetSelect').value);
  if (!p) throw new Error('Choose a preset first');
  loadPresetIntoForm(p);
}, 'importError');
$('savePreset').onclick = act(async () => { await send('savePreset', { preset: presetFromForm() }); await render(); }, 'importError');
$('deletePreset').onclick = act(async () => {
  const id = $('presetSelect').value;
  if (!id) throw new Error('Choose a preset first');
  await send('deletePreset', { id });
  await render();
}, 'importError');
$('pickFolder').onclick = act(async () => {
  if (typeof globalThis.showDirectoryPicker !== 'function') throw new Error('This browser has no folder picker; finished files go to Downloads/FlowPilot.');
  const handle = await globalThis.showDirectoryPicker({ mode: 'readwrite' });
  await setFolderHandle(handle);
  await renderFolder();
}, 'importError');
$('template').oninput = updateTemplateExample;

$('approveAll').onclick = act(async () => {
  const s = await send('status');
  for (const j of s.jobs.filter((x) => x.state === 'queued')) await send('approve', { id: j.id });
  await render();
});

$('add').onsubmit = act(async (ev) => {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  // References: ingredient refs one per line/comma; first/last frame single. The service worker
  // infers the input mode (Ingredients vs Frames vs plain text) and validates the references.
  const refs = (f.refs ?? '').split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
  const spec = { name: f.name, prompt: f.prompt, kind: f.kind, resolution: f.resolution, durationS: Number(f.durationS), aspect: f.aspect, count: Number(f.count) };
  if (refs.length) spec.refs = refs;
  if (f.firstFrame?.trim()) spec.firstFrame = f.firstFrame.trim();
  if (f.lastFrame?.trim()) spec.lastFrame = f.lastFrame.trim();
  await send('addJob', { spec });
  ev.target.reset();
});

chrome.storage.onChanged.addListener(() => render());
updateTemplateExample();
render().catch((e) => show('error', e));
