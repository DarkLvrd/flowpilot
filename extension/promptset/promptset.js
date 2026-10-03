// "Describe it once" page. lib/promptset.js does the thinking (pure, offline); this page only
// reads the inputs and writes one editable textarea per scene, so the person can change any line
// before pasting it into the dashboard's prompt box or `flowpilot add --prompt`.
import { expandPromptSet, PROMPT_TEMPLATE } from '../lib/promptset.js';

const $ = (id) => document.getElementById(id);
const showError = (e) => { $('error').hidden = !e; $('error').textContent = e?.message ?? ''; };

$('template').textContent = `Template: ${PROMPT_TEMPLATE}`;
$('scenes').replaceChildren(...[1, 2, 3, 4, 5, 6].map((n) => {
  const o = document.createElement('option');
  o.value = String(n);
  o.textContent = String(n);
  if (n === 4) o.selected = true;
  return o;
}));

const prompts = () => [...$('out').querySelectorAll('textarea')];

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked: the text is still selectable */ }
}

function render() {
  let set;
  try {
    set = expandPromptSet($('describe').value, {
      scenes: Number($('scenes').value), style: $('style').value, motion: $('motion').value,
    });
  } catch (e) {
    showError(e);
    $('out').replaceChildren();
    return;
  }
  showError(null);
  $('out').replaceChildren(...set.map((s) => {
    const wrap = document.createElement('div');
    const label = document.createElement('label');
    label.className = 'block';
    label.textContent = `${s.index}. ${s.label} — edit freely`;
    const area = document.createElement('textarea');
    area.className = 'prompt';
    area.value = s.prompt;
    const copy = document.createElement('button');
    copy.className = 'inline';
    copy.textContent = 'Copy';
    copy.onclick = async () => { await copyText(area.value); copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1200); };
    const row = document.createElement('p');
    row.append(copy);
    wrap.append(label, area, row);
    return wrap;
  }));
}

$('make').onclick = render;
$('copyAll').onclick = () => copyText(prompts().map((t) => t.value.trim()).filter(Boolean).join('\n\n'));
$('dashboard').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/index.html') });
$('describe').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) render();
});
