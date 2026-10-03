// The spend-and-safety receipt: one local, exportable record of a batch or session, assembled from
// Flow Pilot's own job records and nothing else (report §9.1; docs/SPEC.md decision 8).
//
// The honesty rules this file follows:
//   * a cost is a charge only when the store recorded it at the write-ahead click (`job.cost`);
//     `job.expectedCost` is a quote and is never added to what was spent;
//   * a row that may have reached Flow before a halt is reported as unprovable, never as a spend;
//   * every halt and failure is quoted in Flow Pilot's own words, so a person can match it to Flow;
//   * prompt text is user content: it is left out unless the person asks for it.
//
// Pure: takes records in, returns text out. No network, no storage, no clock of its own.

import { isNeverSubmitted } from './resume.js';

const pad = (n) => String(n).padStart(2, '0');

// Local-time stamps: a person reads the receipt on their own machine, so local time is the honest
// label. `2026-10-04 09:12` for the body, `2026-10-04-0912` for the filename.
export function stamp(at) {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const fileStamp = (at) => stamp(at).replace(' ', '-').replace(':', '');

// A short, stable fingerprint of a prompt: enough to tell two rows apart in a receipt without
// showing the text. FNV-1a, 32-bit — it is a label, not a security hash.
export function promptFingerprint(prompt = '') {
  let h = 0x811c9dc5;
  for (const ch of String(prompt)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// Rows that never reached Flow: no write-ahead click, and nothing that suggests one may have
// happened. `isNeverSubmitted` in lib/resume.js is the single definition — the same rule that
// decides what a Resume may run decides what this receipt calls "not charged".
const charged = (j) => j.cost != null;

function settingsLine(job) {
  const s = job.settings;
  if (!s) return 'settings not recorded';
  const bits = [s.kind, s.resolution, s.durationS != null ? `${s.durationS}s` : null, s.aspect, s.count ? `x${s.count}` : null];
  return bits.filter(Boolean).join(' ') || 'settings not recorded';
}

const historyLine = (job) => (job.history ?? []).map((h) => h.state).join(' → ');

// Every halt Flow Pilot recorded, in order, deduped, with the wording intact and nowhere softened.
function haltLines(jobs, session) {
  const lines = [];
  const seen = new Set();
  if (session.haltReason) {
    const at = session.haltedAt ?? session.haltedAt === 0 ? session.haltedAt : null;
    const line = { reason: session.haltReason, at };
    lines.push(line);
    seen.add(session.haltReason);
  }
  for (const j of jobs) {
    for (const h of j.history ?? []) {
      if (h.state !== 'halted' || !h.reason || seen.has(h.reason)) continue;
      seen.add(h.reason);
      lines.push({ reason: h.reason, at: h.at ?? null, job: j.name });
    }
  }
  return lines;
}

export function buildReceipt({ jobs = [], session = {}, selfCheck = null, version = '', now = Date.now(), includePrompts = false } = {}) {
  const succeeded = jobs.filter(charged);
  const pending = jobs.filter(isNeverSubmitted);
  const unprovable = jobs.filter((j) => j.mayHaveSubmitted === true);
  const chargedTotal = succeeded.reduce((n, j) => n + (j.cost ?? 0), 0);
  const estimatedTotal = pending.reduce((n, j) => n + (j.expectedCost ?? 0), 0);
  const halts = haltLines(jobs, session);

  const out = [];
  const say = (line = '') => out.push(line);

  say('# Flow Pilot — spend and safety receipt');
  say();
  say(`Written on this machine on ${stamp(now)} (your local time). Flow Pilot never uploads this file:`);
  say('keep it, send it to someone, or delete it. Every number below comes from Flow Pilot\'s own job');
  say('records. A "charged" number is one Flow Pilot recorded when it clicked Flow\'s own Generate;');
  say('anything Flow Pilot could not see is called unproven, not spent.');
  say();
  say('Flow Pilot does not retry after a block: after a halt nothing runs again until a person presses a');
  say('button in the dashboard, and clearing a halt never restarts anything on its own.');
  say();

  say('## The money, in plain words');
  if (session.cap == null) {
    say('No credit cap was set for this session. Flow Pilot refuses to submit without one, so nothing');
    say('should have been submitted at all.');
  } else {
    say(`Flow Pilot was allowed to spend at most ${session.cap} credits this session (the cap you set in the dashboard).`);
  }
  say(`It recorded a Generate click, and so a charge, on ${succeeded.length} ${succeeded.length === 1 ? 'row' : 'rows'}: ${chargedTotal} credits in total.`);
  if (session.spent != null) {
    say(`Flow Pilot's own session counter says ${session.spent} credits, which is the number the cap is checked against.`);
    if (session.spent !== chargedTotal) {
      say(`The two disagree: the rows below only account for ${chargedTotal} credits, so treat the counter as the larger,`);
      say('safer number and check your balance in Flow before trusting either one.');
    }
  }
  if (pending.length) {
    say(`${pending.length} ${pending.length === 1 ? 'row was' : 'rows were'} never submitted, so nothing was charged for ${pending.length === 1 ? 'it' : 'them'} (${pending.length === 1 ? 'it had' : 'they had'} been estimated at ${estimatedTotal} credits).`);
  }
  if (unprovable.length) {
    say(`${unprovable.length} ${unprovable.length === 1 ? 'row' : 'rows'} may have been sent to Flow just before the queue stopped. Flow Pilot cannot prove whether Flow charged for ${unprovable.length === 1 ? 'it' : 'them'}, and ${unprovable.length === 1 ? 'it is' : 'they are'} NOT included in the ${chargedTotal} credits above. Check your balance in Flow.`);
  }
  if (!jobs.length) say('No jobs were in the queue, so there is nothing to report.');
  say();

  if (halts.length) {
    say('## Halts (exact words from Flow Pilot)');
    halts.forEach((h, i) => {
      say(`${i + 1}. ${h.reason}${h.at ? ` — ${stamp(h.at)}` : ''}${h.job ? ` (while running "${h.job}")` : ''}`);
    });
    say();
  }

  if (jobs.length) {
    say('## Rows at a glance');
    say();
    say('| # | Name | State | Charged | Saved to |');
    say('|---|---|---|---|---|');
    jobs.forEach((j, i) => {
      const money = charged(j) ? `${j.cost} credits` : isNeverSubmitted(j) ? 'nothing (never submitted)' : 'unproven';
      say(`| ${i + 1} | ${j.name ?? j.id} | ${j.state} | ${money} | ${j.file?.path ?? '—'} |`);
    });
    say();
    say('## Row by row');
    jobs.forEach((j, i) => {
      say();
      say(`### ${i + 1}. ${j.name ?? j.id} — ${j.state}`);
      say(`- Settings: ${settingsLine(j)}${j.recipe ? ` · catalog recipe ${j.recipe}` : ''}`);
      if (charged(j)) {
        say(`- Submitted: yes — ${j.cost} credits recorded at the click${j.clickedAt ? ` on ${stamp(j.clickedAt)}` : ''}.`);
      } else if (j.mayHaveSubmitted) {
        say('- Submitted: unknown — the click may have happened before the queue stopped. Flow Pilot cannot');
        say('  prove whether Flow charged for this row; check your balance in Flow.');
      } else {
        say('- Submitted: no — Flow Pilot never clicked Generate, so nothing was charged.');
      }
      if (j.file?.path) say(`- Saved to: ${j.file.path}`);
      if (j.error) say(`- Reported error: ${j.error}`);
      for (const h of j.history ?? []) if (h.reason && h.state !== 'halted') say(`- ${h.state}: ${h.reason}`);
      const fp = promptFingerprint(j.prompt ?? '');
      say(includePrompts
        ? `- Prompt: ${JSON.stringify(j.prompt ?? '')}`
        : `- Prompt: not included in this receipt — fingerprint ${fp} (turn on "include prompt text" to print it)`);
      if (j.history?.length) say(`- History: ${historyLine(j)}`);
    });
    say();
  }

  if (selfCheck?.checks?.length) {
    say('## The self-check that ran around this session');
    for (const c of selfCheck.checks) say(`- ${c.ok ? 'OK' : 'FAILED'} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
    say();
  }

  say('---');
  say(`Flow Pilot ${version || '(version unknown)'} · receipt generated ${stamp(now)} · local file, nothing uploaded.`);

  return {
    filename: `flowpilot-receipt-${fileStamp(now)}.md`,
    summary: {
      at: now, jobs: jobs.length, chargedTotal, chargedRows: succeeded.length,
      estimatedTotal, neverSubmitted: pending.length, mayHaveBeenCharged: unprovable.length,
      halts: halts.map((h) => h.reason), cap: session.cap ?? null, sessionSpent: session.spent ?? null,
    },
    text: out.join('\n'),
  };
}
