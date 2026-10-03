// Shared helpers for extension pages (popup, dashboard, promptset).
import { healthLines } from './lib/health.js';

export async function send(cmd, args = {}) {
  const r = await chrome.runtime.sendMessage({ cmd, ...args });
  if (!r?.ok) throw new Error(r?.error ?? 'No answer from the service worker');
  return r.value;
}

// The self-check, each check with a plain-language line and its own detail.
export function renderChecks(list, selfCheck) {
  list.replaceChildren();
  for (const c of healthLines(selfCheck)) {
    const li = document.createElement('li');
    li.textContent = `${c.ok ? '✅' : '❌'} ${c.name} — ${c.plain}${c.detail ? ` (${c.detail})` : ''}`;
    list.append(li);
  }
}

// The plain-words front-tab rule, with how many jobs are waiting on it. Null when none wait.
// Flow is zoneless Angular and only re-renders in the front tab (docs/LESSONS.md #23), so an
// approved job stays put until the person brings the Flow tab forward — the extension never
// switches tabs for them.
export function frontTabNotice(waitingFor) {
  const count = waitingFor?.count ?? 0;
  if (!count) return null;
  const jobs = `${count} job${count === 1 ? '' : 's'}`;
  if (waitingFor.reason === 'no-work-tab') {
    return `No work tab yet: ${jobs} waiting. Open a Flow project and press "Use this tab".`;
  }
  return `${jobs} waiting: keep the Flow tab in front while jobs submit.`;
}
