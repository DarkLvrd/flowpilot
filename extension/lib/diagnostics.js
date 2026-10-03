// The local diagnostic bundle (report §9.3): one file a person can read and send to whoever helps
// them, without leaking anything about themselves.
//
// Redaction is by construction, twice over:
//   1. an allow-list — only the fields named below are ever read, so a rogue or future field on a
//      job or self-check record cannot ride along;
//   2. a redaction pass — every free-text value that does get read (self-check details, errors, halt
//      reasons) is scrubbed of anything shaped like a credential, because Flow's own error text
//      sometimes carries a signed URL or a token parameter.
//
// Prompt text and saved paths are deliberately absent: the receipt is where those live, and only
// when the person asks for them. Nothing here is uploaded by Flow Pilot, ever.

import { FLOW_COMPAT, compatNote, compatReport } from './compat.js';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (at) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Anything that looks like a credential, replaced rather than dropped, so the reader can see that
// something was there and that it was removed.
const REDACTIONS = [
  [/\bya29\.[\w.\-~+/=]+/g, '[redacted token]'],
  [/\bBearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi, 'Bearer [redacted]'],
  [/\bAuthorization\s*[:=]\s*\S+/gi, 'Authorization: [redacted]'],
  [/\bCookie\s*[:=]\s*[^\n;]*/gi, 'Cookie: [redacted]'],
  [/\b(?:SID|HSID|SSID|APISID|SAPISID|LSID|OSID|NID|AEC|__Secure-[0-9A-Za-z_-]+)\s*[:=]\s*[^;,\s"']+/g, '[redacted cookie]'],
  [/[?&](?:at|f\.sid|bl|Signature|Expires|X-Goog-[A-Za-z-]+)=[^&\s"']+/g, '[redacted parameter]'],
  [/\b\d+:[A-Za-z0-9_-]{15,}:[A-Za-z0-9_-]{15,}\b/g, '[redacted hash]'],
];

export function redact(value) {
  let s = value == null ? '' : String(value);
  for (const [pattern, replacement] of REDACTIONS) s = s.replace(pattern, replacement);
  // Collapse a run of adjacent removals (a signed URL carries several parameters) into one mark.
  return s.replace(/(\[redacted[^\]]*\])(?:\s*\[redacted[^\]]*\])+/g, '$1');
}

const field = (label, value) => `- ${label}: ${value}`;

export function buildDiagnostics({
  version = '', compat = FLOW_COMPAT, selfCheck = null, jobs = [], session = {},
  lastTick = null, workTab = null, now = Date.now(),
} = {}) {
  // Only these job fields are read — never the prompt, never the file path, never `references`.
  const recent = jobs.slice(-20).map((j) => ({
    name: j.name ?? j.id, state: j.state ?? '?', charged: j.cost ?? null, quoted: j.expectedCost ?? null,
    clickedAt: j.clickedAt ?? null, mayHaveSubmitted: !!j.mayHaveSubmitted,
    saved: !!j.file?.path, error: redact(j.error), history: (j.history ?? []).map((h) => `${h.state}${h.reason ? ` (${redact(h.reason)})` : ''}`),
  }));
  const halts = [
    ...(session.lastHalt ? [session.lastHalt] : []),
    ...recent.flatMap((j, i) => (j.history.some((h) => h.includes('halted')) ? [{ job: j.name, i }] : [])),
  ];

  const out = [];
  const say = (line = '') => out.push(line);

  say('Flow Pilot — local diagnostic bundle');
  say(`Written on this machine at ${stamp(now)}. Nothing here was uploaded: Flow Pilot never sends`);
  say('anything, and this file is only written when you press the button.');
  say('It contains no cookies, no sign-in tokens, no Authorization headers, no prompt text and no');
  say('file paths. Anything that even looked like a credential was replaced with [redacted].');
  say();

  say('## Versions');
  say(field('Flow Pilot', version || '(version unknown)'));
  say(field('Flow build this was proven against', `${compat.build} (capture ${compat.buildSeenAt})`));
  say(field('Compatibility note updated', compat.noteUpdated));
  say(field('Last proven', compat.provenThrough));
  say();

  say('## Work tab and queue');
  say(field('Work tab', workTab ? 'bound to a Flow project' : 'no work tab is bound'));
  say(field('Jobs in the queue', jobs.length));
  say(field('Credit cap in force', session.cap == null ? 'none set (nothing may be submitted without one)' : `${session.cap} credits`));
  say(field('Recorded spend', `${session.spent ?? 0} credits`));
  say(field('Halted', session.halted ? `yes — ${redact(session.haltReason)}` : 'no'));
  say(field('Cool-down hold (waiting for a Resume press)', session.awaitingResume ? 'yes' : 'no'));
  if (session.haltedAt) say(field('Halted at', stamp(session.haltedAt)));
  if (session.lastHalt) say(field('Last halt (exact wording)', `"${redact(session.lastHalt.reason)}" at ${stamp(session.lastHalt.at)}`));
  say(field('Last engine tick', lastTick ? `${stamp(lastTick.at)}${lastTick.error ? ` — error: ${redact(lastTick.error)}` : ''}${lastTick.waiting ? ` — waiting: ${redact(lastTick.waiting)}` : ''}` : 'no tick yet'));
  say();

  say('## Self-check');
  if (!selfCheck) {
    say('- no self-check has run yet (open a Flow project and press "Use this tab as the work tab" in the popup)');
  } else {
    say(field('Verdict', selfCheck.ok ? 'all checks passed' : 'FAILED — see the failing step below'));
    say(field('Ran at', stamp(selfCheck.at ?? now)));
    for (const c of selfCheck.checks ?? []) say(`- ${c.ok ? 'OK' : 'FAILED'} ${c.name}${c.detail ? `: ${redact(c.detail)}` : ''}`);
  }
  say();

  say('## Recent job states (newest last, no prompt text, no paths)');
  if (!recent.length) {
    say('- no jobs in the queue');
  } else {
    for (const j of recent) {
      const money = j.charged != null ? `${j.charged} credits recorded at the click` : 'nothing charged';
      say(`- ${j.name}: ${j.state} — ${money}${j.quoted != null ? ` (quoted ${j.quoted})` : ''}`
        + `${j.mayHaveSubmitted ? ' — MAY have been submitted; cannot be proven' : ''}`
        + `${j.saved ? ' — a file was saved (path shown in the receipt, not here)' : ''}`
        + (j.error ? ` — error: ${j.error}` : ''));
      if (j.history.length) say(`    steps: ${j.history.join(' → ')}`);
    }
  }
  say();

  if (halts.length) {
    say('## Halts');
    say('Flow Pilot does not retry after a block; every halt above needs a person to look at Flow and');
    say('press Resume. Exact wording is kept so it can be matched against Flow\'s own messages.');
    say();
  }

  say('## What Flow compatibility says today');
  for (const line of compatReport(compat).split('\n')) say(line);
  say();

  say('---');
  say(`${compatNote(compat)}`);
  say('Local file, nothing uploaded. Send it to whoever helps you, or delete it.');

  return {
    filename: `flowpilot-diagnostics-${stamp(now).replace(' ', '-').replace(':', '')}.txt`,
    fields: { at: now, version, jobs: jobs.length, selfCheckOk: selfCheck ? !!selfCheck.ok : null, halts: halts.length },
    text: out.join('\n'),
  };
}
