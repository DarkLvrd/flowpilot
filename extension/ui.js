// Shared helpers for extension pages (popup, dashboard).
export async function send(cmd, args = {}) {
  const r = await chrome.runtime.sendMessage({ cmd, ...args });
  if (!r?.ok) throw new Error(r?.error ?? 'No answer from the service worker');
  return r.value;
}

export function renderChecks(list, selfCheck) {
  list.replaceChildren();
  for (const c of selfCheck?.checks ?? []) {
    const li = document.createElement('li');
    li.textContent = `${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
    list.append(li);
  }
}
