// The Review panel (report §2.6, §3 Phase 3): one card per finished clip, with the six checks, the
// verdict, the note, and a Fix button per failed check.
//
// The rules it makes visible:
//   * `technical` is automatic — read from the job (bytes, duration bucket, resolution, aspect,
//     non-empty, recipe vs settings) and never a tick a person places.
//   * The five that need eyes are the person's; the verdict follows from them (`qcVerdict`), and
//     `technical: fail` blocks the verdict instead of approving a clip the machine rejected.
//   * Nothing is auto-approved or auto-failed on a machine score, and no fix runs on its own: each
//     Fix is a click that queues the next job through the same paths as everything else, showing its
//     cost first. A fix appends a consistency block (the base hashes cannot move), never rewrites an
//     approved still or an output file, and keeps the failed take on disk.

import { send } from '../ui.js';
import { QC_VISIBLE, reviewView } from '../lib/qc.js';

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};

const TICK = { pass: '✅', fail: '❌' };

// A fix is never taken without a deliberate yes. In the browser that is the real confirm dialog; in
// any environment without one, the answer is no (nothing is queued by surprise).
const confirmFix = (message) => (typeof confirm === 'function' ? confirm(message) : false);

export function createReviewPanel(root, { onChange = () => {} } = {}) {
  let error = null;
  let note = null;
  // The ticks a person has placed but not recorded yet, per job id. A re-render keeps them.
  const drafts = new Map();

  const showError = (e) => { error = e?.message ?? null; renderLast(); };
  const status = (text) => { note = text; renderLast(); };
  const act = (fn) => async (...args) => {
    try { showError(null); note = null; await fn(...args); await onChange(); } catch (e) { showError(e); }
  };

  let lastJobs = [];
  const renderLast = () => render(lastJobs);

  function draftOf(job) {
    if (!drafts.has(job.id)) {
      drafts.set(job.id, {
        checks: Object.fromEntries(QC_VISIBLE.map((c) => [c, job.qc?.checks?.[c] ?? ''])),
        note: job.qc?.note ?? '',
      });
    }
    return drafts.get(job.id);
  }

  function checkRow(check, draft, refresh) {
    const select = el('select', { style: 'display:inline;width:auto' });
    for (const [value, label] of [['', '— pick —'], ['pass', 'pass'], ['fail', 'fail']]) {
      const option = el('option', { value, textContent: label });
      if (draft.checks[check] === value) option.selected = true;
      select.append(option);
    }
    select.onchange = () => { draft.checks[check] = select.value; refresh(); };
    return el('div', { style: 'font-size:13px' }, el('span', { textContent: `${check} `, style: 'display:inline-block;width:10ch' }), select);
  }

  function card(job) {
    const draft = draftOf(job);
    const view = reviewView(job);
    const row = el('div', { style: 'border:1px solid #ddd;border-radius:6px;padding:8px;margin:6px 0;max-width:1100px' });

    row.append(el('div', {},
      el('strong', { textContent: job.name ?? job.id }),
      ' ',
      el('span', { textContent: `(${job.id.slice(0, 8)}…, done)`, style: 'color:#5f6368' }),
      job.anchor?.shotId ? el('span', { textContent: ` · anchored from ${job.anchor.shotId}`, style: 'color:#5f6368' }) : null,
      view.reviewed
        ? el('span', { textContent: ` · verdict ${view.verdict}`, style: view.verdict === 'approved' ? 'color:#1e8e3e' : 'color:#b06000' })
        : el('span', { textContent: ' · not reviewed yet', style: 'color:#b06000' }),
    ));
    if (job.file?.path) row.append(el('div', { textContent: job.file.path, style: 'font-size:11px;color:#5f6368' }));
    row.append(el('div', { textContent: `prompt: ${(job.prompt ?? '').split('\n')[0].slice(0, 160)}`, style: 'font-size:11px;color:#5f6368' }));

    // The automatic check first, in plain words. It never decides anything by itself.
    const auto = job.qc?.checks?.technical ?? null;
    row.append(el('div', { style: 'font-size:13px' },
      el('span', { textContent: ' technical' }),
      el('span', { textContent: auto === 'pass'
        ? ' ✅ automatic: bytes, duration bucket, resolution, aspect and recipe all match the job'
        : auto === 'fail'
          ? ' ❌ automatic: this job failed its own byte/settings check before it was done'
          : ' ✅ automatic — read from the job; record a verdict to see it written down' }),
    ));

    const verdictLine = el('p', { textContent: '', style: 'font-size:12px;color:#5f6368;margin:4px 0' });
    const record = el('button', { textContent: view.reviewed ? 'Record a new verdict' : 'Record verdict', style: 'display:inline;width:auto;margin-right:6px' });
    const refresh = () => {
      const ready = QC_VISIBLE.every((c) => ['pass', 'fail'].includes(draft.checks[c]));
      const wouldBe = job.qc?.checks?.technical === 'fail'
        ? 'blocked — the automatic technical check failed'
        : Object.values(draft.checks).includes('fail')
          ? 'regen (a fix is offered once you record it)'
          : 'approved';
      verdictLine.textContent = ready ? `this would be: ${wouldBe}` : 'pick pass or fail for all five, then record the verdict';
      record.disabled = !ready;
    };
    for (const check of QC_VISIBLE) row.append(checkRow(check, draft, refresh));

    const noteInput = el('input', { value: draft.note, placeholder: 'what you saw (this text becomes the appended consistency block for a fix)', style: 'width:70%' });
    noteInput.oninput = () => { draft.note = noteInput.value; };
    row.append(el('div', { style: 'font-size:13px' }, 'note ', noteInput));
    // The recorded note is shown as text too, so the card reads like a review even before a re-render.
    if (job.qc?.note) row.append(el('div', { textContent: `note (recorded): ${job.qc.note}`, style: 'font-size:12px;color:#5f6368' }));
    row.append(verdictLine);

    const buttons = el('div', {});
    record.onclick = act(async () => {
      const checks = { ...draft.checks };
      if (QC_VISIBLE.some((c) => !['pass', 'fail'].includes(checks[c]))) throw new Error('Pick pass or fail for all five checks first');
      await send('qcSet', { id: job.id, checks, note: draft.note.trim() || null });
      drafts.delete(job.id);
      status(`Recorded the verdict on ${job.name ?? job.id}. A fix below queues the next job; nothing regenerates on its own.`);
    });
    buttons.append(record);
    refresh();
    row.append(buttons);

    // One Fix button per failure that has been recorded. Each shows its cost before it is taken.
    if (job.qc?.verdict === 'blocked') {
      row.append(el('div', { textContent: 'A machine-rejected clip has no fix to offer: it failed before it was done. Look at the Queue row for the reason.', style: 'font-size:12px;color:#b06000' }));
    } else if (view.reviewed && view.actions.length) {
      row.append(el('div', { textContent: 'Fixes offered (each is a click; the failed take stays on disk):', style: 'font-size:12px;margin-top:6px' }));
      for (const action of view.actions.filter((a) => !a.automatic)) {
        const label = `Fix ${action.check} — ${action.label} (${action.cost})`;
        const fix = el('button', { textContent: label, style: 'display:inline;width:auto;margin:4px 6px 0 0' });
        fix.disabled = action.automatic;
        fix.onclick = act(async () => {
          if (!confirmFix(`${label}\n\n${action.what}\n\nTake it?`)) return;
          const r = await send('qcFix', { id: job.id, check: action.check });
          const made = r.still
            ? `still job ${r.still.id} (free)`
            : `video job ${r.video.id} (${r.video.expectedCost == null ? 'price shown in Flow' : `${r.video.expectedCost} credits`})`;
          status(r.still
            ? `Queued ${made}. Approve the still in the Shots panel; the video job is created only after that.`
            : `Queued ${made}. It is not started: approve it in the Queue when the credits are yours to spend.`);
        });
        row.append(fix);
      }
    }
    return row;
  }

  function render(jobs = []) {
    lastJobs = jobs;
    root.replaceChildren();
    if (error) { root.append(el('p', { className: 'banner', textContent: error })); return; }
    if (note) root.append(el('p', { textContent: note, style: 'color:#1e8e3e' }));
    const clips = jobs.filter((j) => j.state === 'done' && j.settings?.kind === 'video');
    for (const job of clips) root.append(card(job));
    if (!clips.length) {
      root.append(el('p', { textContent: 'No finished clips yet for this project. A clip appears here after it is done; its free still and its shot live in the Shots panel.' }));
    }
  }

  return { render };
}
