// Minimal dashboard for build step 2: cap, halt, add/approve/cancel. Step 3 replaces it.
import { send, renderChecks } from '../ui.js';

const $ = (id) => document.getElementById(id);
const showError = (e) => { $('error').hidden = !e; $('error').textContent = e?.message ?? ''; };
const act = (fn) => async (...a) => { try { showError(null); await fn(...a); } catch (e) { showError(e); } render(); };

let shownCap; // the saved cap last written into the box; the box is only refreshed when it changes

async function render() {
  const s = await send('status');
  $('halt').hidden = !s.session.halted;
  $('haltReason').textContent = `⛔ All jobs halted: ${s.session.haltReason}`;
  $('summary').textContent = `${s.workTab ? `Work tab: project ${s.workTab.projectId}` : 'No work tab: open a Flow project and click "Use this tab" in the popup.'}`
    + ` · Credits this session: ${s.session.spent} / ${s.session.cap ?? 'no cap'}`
    + (s.selfCheck?.balance != null ? ` · Balance: ${s.selfCheck.balance}` : '');
  if (s.session.cap !== shownCap) { shownCap = s.session.cap; $('cap').value = s.session.cap ?? ''; }
  renderChecks($('checks'), s.selfCheck);

  const rows = s.jobs.slice().reverse().map((j) => {
    const tr = document.createElement('tr');
    const cell = (t) => { const td = document.createElement('td'); td.textContent = t; tr.append(td); return td; };
    cell(j.name);
    cell(j.state + (j.error ? ` — ${j.error}` : '') + (j.file ? ` → ${j.file.path}` : ''));
    cell(j.cost ?? (j.expectedCost == null ? '?' : `~${j.expectedCost}`));
    cell(j.prompt);
    const actions = cell('');
    const btn = (label, cmd) => { const b = document.createElement('button'); b.textContent = label; b.onclick = act(() => send(cmd, { id: j.id })); actions.append(b); };
    if (j.state === 'queued') btn('Approve', 'approve');
    if (['queued', 'approved', 'halted'].includes(j.state)) btn('Cancel', 'cancel');
    if (j.state === 'failed' && j.clickedAt == null && !j.mayHaveSubmitted) btn('Re-queue', 'requeue');
    return tr;
  });
  $('jobs').replaceChildren(...rows);
}

$('setCap').onclick = act(async () => {
  // Number('') is 0: an empty box must not silently become a cap of 0.
  if ($('cap').value.trim() === '') throw new Error('Type a number of credits first');
  await send('setCap', { cap: Number($('cap').value) });
});
$('clearHalt').onclick = act(() => send('clearHalt'));
$('add').onsubmit = act(async (ev) => {
  ev.preventDefault();
  const f = Object.fromEntries(new FormData(ev.target));
  await send('addJob', { spec: { ...f, durationS: Number(f.durationS), input: 'text' } });
  ev.target.reset();
});
chrome.storage.onChanged.addListener(() => render());
render().catch(showError);
