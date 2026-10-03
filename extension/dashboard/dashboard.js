// Dashboard: cap, halt, agents, storyboard/batch import, presets, the folder picker, the queue,
// preview-first, the front-tab rule and the Flow health screen.
import { send, renderChecks, frontTabNotice } from '../ui.js';
import { FLOW_CHANGED_HINT } from '../lib/health.js';
import { describePlannedJob } from '../lib/storyboard.js';
import { setFolderHandle, getFolderHandle, folderGranted } from '../lib/folder.js';
import { applyNameTemplate } from '../lib/naming.js';
import { createEntitiesPanel, entityNames } from './entities.js';
import { createShotsPanel } from './shots.js';
import { createReviewPanel } from './review.js';

const $ = (id) => document.getElementById(id);
const show = (id, e) => { const el = $(id); el.hidden = !e; el.textContent = e?.message ?? ''; };
const act = (fn, errId = 'error') => async (...a) => { try { show(errId, null); await fn(...a); } catch (e) { show(errId, e); } };
// The consistency entity library (report §2.1): rendered from this dashboard's own render().
const entitiesPanel = createEntitiesPanel($('entities'));
// The Shots panel and the still→anchor gate (report §2.5, Phase 2).
const shotsPanel = createShotsPanel($('shots'));
// The Review panel (report §2.6, Phase 3): the QC loop on finished clips. Recording a verdict and
// taking a fix are job-data writes, so the same render() refreshes the queue below.
const reviewPanel = createReviewPanel($('review'), { onChange: () => render() });

let shownCap; // the saved cap last written into the box; the box is only refreshed when it changes
let importFilename = ''; // the chosen file's name, so format detection can use the extension
let preview = null; // the last previewImport result
let presets = []; // the saved presets, for the select and Load
let grantedFolderName = null; // the name of the folder granted for this session, if any

// A job that is not finished: with no work tab, these are the jobs a person is waiting on.
const ACTIVE_STATES = ['queued', 'approved', 'submitting', 'submitted', 'rendering', 'downloading', 'awaiting-preview'];

// What a row's state cell says. A held video names its free still, so "waiting" is never a mystery;
// the still's own row says what it is.
function stateText(job, byId) {
  if (job.state === 'awaiting-preview') {
    const still = job.previewJobId ? byId.get(job.previewJobId) : null;
    const stillState = !still ? 'its free still is missing'
      : still.state === 'failed' ? `the free still failed — ${still.error ?? 'see its row'}`
      : still.state === 'done' ? `free still ready (${still.mediaId ?? 'no media id'})`
      : `waiting for the free still (${still.state})`;
    return `⏳ awaiting preview — ${stillState}${job.error ? ` — ${job.error}` : ''}`;
  }
  const label = job.role === 'preview' ? `${job.state} (free still)` : job.state;
  return label + (job.error ? ` — ${job.error}` : '') + (job.file ? ` → ${job.file.path}` : '');
}

// Cost is always shown; a still is unmistakably free, and a held video shows its eventual price
// before it can be approved.
function costText(job) {
  if (job.cost != null) return job.cost === 0 ? '0 (free)' : String(job.cost);
  if (job.expectedCost == null) return '?';
  return job.expectedCost === 0 ? '0 (free)' : `~${job.expectedCost}`;
}

// A receipt and a diagnostic bundle are local files. The dashboard writes them with the downloads
// API and `saveAs`, so the person chooses where they land; nothing is uploaded, ever.
async function saveText(filename, text, mime = 'text/markdown') {
  await chrome.downloads.download({ url: `data:${mime};charset=utf-8,${encodeURIComponent(text)}`, filename, saveAs: true });
}

// After a halt: why it stopped (in Flow Pilot's own words), how long to wait, what to check, and
// one press to resume only the rows that never reached Flow. Everything shown here comes from the
// service worker's resume plan, so the dashboard never has to guess which rows are eligible.
function renderCoolDown(s) {
  const holding = !!(s.session.halted || s.session.awaitingResume);
  $('cooldown').hidden = !holding;
  if (!holding) return;
  const cool = s.coolDown;
  $('coolTitle').textContent = s.session.halted ? '⛔ All jobs stopped.' : '⏸ Cool-down — nothing is being submitted.';
  $('haltReason').textContent = s.session.halted
    ? `Flow Pilot's exact words: “${s.session.haltReason}”`
    : (s.session.lastHalt ? `Last halt: “${s.session.lastHalt.reason}” at ${new Date(s.session.lastHalt.at).toLocaleTimeString()}` : '');
  $('coolWhy').textContent = cool?.why ?? '';
  $('coolWait').textContent = cool
    ? (cool.remainingMinutes > 0
      ? `Wait about ${cool.remainingMinutes} more min (about ${cool.waitMinutes} in total; ${cool.minMinutes} is the shortest the field data saw work). ${cool.note}`
      : `The wait you were shown is over. ${cool.note}`)
    : '';
  $('coolChecks').replaceChildren(...(cool?.checklist ?? []).map((t) => { const li = document.createElement('li'); li.textContent = t; return li; }));
  const ready = s.resume?.ready ?? [];
  $('resumeInfo').textContent = [
    `${ready.length} ${ready.length === 1 ? 'row was' : 'rows were'} never submitted and can still run, in their original order.`,
    'Rows that already reached Flow keep their result and are never submitted again.',
    ...(s.resume?.blockers ?? []), ...(s.resume?.warnings ?? []),
  ].join(' ');
  $('resume').disabled = !s.resume?.ok;
  $('resume').textContent = `Resume ${ready.length} ${ready.length === 1 ? 'row' : 'rows'} that were never submitted`;
  $('clearHalt').hidden = !s.session.halted;
}

async function render() {
  const s = await send('status');
  renderCoolDown(s);
  $('summary').textContent = `${s.workTab ? `Work tab: project ${s.workTab.projectId}` : 'No work tab: open a Flow project and click "Use this tab" in the popup.'}`
    + ` · Credits this session: ${s.session.spent} / ${s.session.cap ?? 'no cap'}`
    + (s.selfCheck?.balance != null ? ` · Balance: ${s.selfCheck.balance}` : '')
    + (s.lastTick?.waiting ? ` · ⏳ ${s.lastTick.waiting}` : '');
  if (s.session.cap !== shownCap) { shownCap = s.session.cap; $('cap').value = s.session.cap ?? ''; }
  renderChecks($('checks'), s.selfCheck);
  $('healthHint').textContent = FLOW_CHANGED_HINT;
  // The dated compatibility note, and the local bundle a person can send to whoever helps them.
  $('compat').textContent = s.compat?.note ?? '';
  $('compatReport').textContent = s.compat?.report ?? '';
  $('diagInfo').textContent = s.diagnostics
    ? `Last diagnostics saved ${new Date(s.diagnostics.at).toLocaleString()}. Same file, nothing uploaded.`
    : 'One local text file: version, Flow build, the self-check, halt reasons and recent job states. No cookies, no tokens, no prompts, no paths.';
  $('helper').textContent = s.helper?.connected
    ? '✅ Helper running: agents can use Flow Pilot.'
    : '⚪ Helper not running (only needed for agents): start it with `npx flowpilot serve`.';
  $('pair').disabled = !s.helper?.connected;
  $('receiptInfo').textContent = s.receipt
    ? `Last receipt saved ${new Date(s.receipt.at).toLocaleString()} — ${s.receipt.summary.chargedRows} rows charged, `
      + `${s.receipt.summary.chargedTotal} credits. Save again any time.`
    : 'A receipt is one local file: every row, what was charged, what was halted and why, and where each file went.'
      + ' Nothing is uploaded and Flow Pilot never writes it on its own.';

  // The front-tab gate, in plain words and with the count, plus the button that clears it. Flow only
  // re-renders in the front tab (LESSONS #23), so approved jobs wait there. A batch cannot run
  // without a work tab; say that plainly instead of failing silently.
  const active = s.jobs.some((j) => ACTIVE_STATES.includes(j.state));
  const waiting = frontTabNotice(s.waitingFor)
    ?? (s.workTab ? (s.lastTick?.waiting ?? null) : (active ? 'No work tab: open a Flow project and press "Use this tab" in the popup.' : null));
  $('waiting').textContent = waiting ? `⏳ ${waiting}` : '';
  $('focusTab').hidden = s.waitingFor?.reason !== 'front-tab';

  presets = await send('listPresets').catch(() => []);
  renderPresets(presets);
  await renderFolder();

  const byId = new Map(s.jobs.map((j) => [j.id, j]));
  const rows = await Promise.all(s.jobs.slice().reverse().map(async (j) => {
    const tr = document.createElement('tr');
    const cell = (t) => { const td = document.createElement('td'); td.textContent = t; tr.append(td); return td; };
    cell(j.name);
    cell(stateText(j, byId));
    cell(costText(j));
    cell(j.prompt);
    // A job composed from the entity library says which subjects it used (report §3 Phase 1).
    cell((await entityNames(j.projectId, j.entities ?? [])).join(', '));
    const actions = cell('');
    const btn = (label, cmd, enabled = true) => {
      const b = document.createElement('button'); b.className = 'inline'; b.textContent = label; b.disabled = !enabled;
      b.onclick = act(() => send(cmd, { id: j.id })); actions.append(b);
    };
    if (j.state === 'queued') btn('Approve', 'approve');
    if (j.state === 'awaiting-preview') {
      const still = j.previewJobId ? byId.get(j.previewJobId) : null;
      const ready = still?.state === 'done' && !!still.mediaId;
      const price = j.expectedCost == null ? 'cost shown in Flow' : `${j.expectedCost} credit${j.expectedCost === 1 ? '' : 's'}`;
      // The one free-then-paid click: it approves the look and lets the video spend. Disabled until
      // the still exists, and it can never run on its own.
      btn(ready ? `Approve still → run video (${price})` : 'Approve still (still rendering)', 'promotePreview', ready);
    }
    if (['queued', 'approved', 'halted', 'awaiting-preview'].includes(j.state)) btn('Cancel', 'cancel');
    if (j.state === 'failed' && j.clickedAt == null && !j.mayHaveSubmitted) btn('Re-queue', 'requeue');
    if (j.state === 'failed' && j.mediaId) btn('Retry download', 'retryDownload');
    if (!j.promptParts?.length) return tr;

    // The exact text Flow will receive, with each composed part's hash. Revealed on demand; it is a
    // read of what is already stored, so it can never spend anything.
    const panel = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 6;
    td.hidden = true;
    const head = document.createElement('div');
    head.textContent = `parts: ${j.promptParts.map((p) => `${p.kind} ${String(p.ref).slice(0, 8)} ${p.sha256.slice(0, 12)}…`).join(' · ')}`;
    const pre = document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.textContent = j.prompt;
    td.append(head, pre);
    panel.append(td);
    const preview = document.createElement('button');
    preview.className = 'inline';
    preview.textContent = 'Preview prompt';
    preview.onclick = () => { td.hidden = !td.hidden; };
    actions.append(preview);
    return [tr, panel];
  }));
  $('jobs').replaceChildren(...rows.flat());
  entitiesPanel.render(s.workTab?.projectId ?? null);
  shotsPanel.render(s.workTab?.projectId ?? null);
  reviewPanel.render(s.jobs);
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
    cell(r.ok ? describePlannedJob(r.job) : '');
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
    folder: grantedFolderName ?? '',
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
  const granted = handle ? await folderGranted(handle) : false;
  grantedFolderName = handle && granted ? handle.name : null;
  const base = !handle
    ? 'Downloads/FlowPilot (browser download)'
    : (granted ? `${handle.name}/` : `${handle.name} (permission expired — choose it again)`);
  // A preset's folder is a name, not a live grant: the File System Access handle is session-only.
  const preset = presets.find((p) => p.id === $('presetSelect').value);
  const hint = preset?.folder && preset.folder !== grantedFolderName ? ` · preset folder “${preset.folder}” — choose it again for this session` : '';
  $('folderName').textContent = base + hint;
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
// The person's own click: bring the Flow tab forward so the queue can submit (Flow only renders in
// the front tab). The extension never does this on its own.
$('focusTab').onclick = act(() => send('focusWorkTab'));
$('prompts').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('promptset/index.html') });
$('resume').onclick = act(() => send('resumeUnsubmitted'));
$('saveDiagnostics').onclick = act(async () => {
  const doc = await send('diagnostics');
  await saveText(doc.filename, doc.text, 'text/plain');
});
$('saveReceipt').onclick = act(async () => {
  const doc = await send('receipt', { includePrompts: $('includePrompts').checked });
  await saveText(doc.filename, doc.text);
});
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
$('presetSelect').onchange = act(() => renderFolder(), 'importError');

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
  const spec = { name: f.name, prompt: f.prompt, resolution: f.resolution, durationS: Number(f.durationS), aspect: f.aspect, count: Number(f.count) };
  if (refs.length) spec.refs = refs;
  if (f.firstFrame?.trim()) spec.firstFrame = f.firstFrame.trim();
  if (f.lastFrame?.trim()) spec.lastFrame = f.lastFrame.trim();
  if (f.preview) {
    // Preview-first: a free still is queued first; the video is held until that still is approved.
    if (f.kind !== 'video') throw new Error('Preview first is for video jobs: it shows a free still of the frame the video starts from');
    await send('previewJob', { spec });
  } else {
    spec.kind = f.kind;
    await send('addJob', { spec });
  }
  ev.target.reset();
});

chrome.storage.onChanged.addListener(() => render());
updateTemplateExample();
render().catch((e) => show('error', e));
