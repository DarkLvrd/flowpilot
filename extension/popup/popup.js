import { send, renderChecks, frontTabNotice } from '../ui.js';
import { FLOW_CHANGED_HINT } from '../lib/health.js';

const $ = (id) => document.getElementById(id);
const [active] = await chrome.tabs.query({ active: true, currentWindow: true });

async function render() {
  const s = await send('status');
  const counts = {};
  for (const j of s.jobs) counts[j.state] = (counts[j.state] ?? 0) + 1;
  const parts = [
    s.session.halted ? `⛔ Halted: ${s.session.haltReason}` : null,
    s.workTab ? `Work tab: project ${s.workTab.projectId.slice(0, 8)}…` : 'No work tab yet.',
    s.session.cap == null ? 'No credit cap set (set it in the dashboard).' : `Credits: ${s.session.spent} / ${s.session.cap} this session`,
    Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || 'Queue is empty.',
  ];
  $('summary').innerText = parts.filter(Boolean).join('\n');
  const waiting = frontTabNotice(s.waitingFor);
  $('waiting').hidden = !waiting;
  $('waitingText').textContent = waiting ?? '';
  renderChecks($('checks'), s.selfCheck);
  $('healthHint').textContent = FLOW_CHANGED_HINT;
  $('use').hidden = s.workTab?.tabId === active?.id;
}

// Bringing the Flow tab forward is the person's own action (Flow re-renders only in the front tab).
$('focusTab').onclick = async () => {
  try { await send('focusWorkTab'); } catch (e) { $('summary').innerText = e.message; return; }
  render();
};
$('use').onclick = async () => {
  try { await send('useTab', { tabId: active.id }); } catch (e) { $('summary').innerText = e.message; return; }
  render();
};
$('prompts').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('promptset/index.html') });
$('dashboard').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
render().catch((e) => { $('summary').innerText = e.message; });
