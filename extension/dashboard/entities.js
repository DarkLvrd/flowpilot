// The Entities panel (report §2.1, §3 Phase 1): the per-project consistency library in the
// dashboard, with no browser interaction and no way to spend credits.
//
// A card per entity: kind, version, approved pill, its locked Flow media ids and the canonical text
// block that goes into every prompt verbatim. References are shown as id + role + label: a thumbnail
// needs a signed flow-content.google URL, which is a later phase's read-only media-detail call. The person can add an entity by pasting a locked media
// id (a photo dropped here is recorded as provenance only — the browser cannot know a file's path,
// and a path is not a locked reference), approve it, replace a reference (a new version, with the
// old set kept in history) or remove it. The canonical style lock from pixar-studio's style_lock.md
// is installed as the project's style entity with one button.
//
// `entityNames` resolves a job's `entities` to names for the Queue's "Uses: …" line.

import { send } from '../ui.js';

const KINDS = ['character', 'product', 'vehicle', 'location', 'style'];
const ROLES = {
  character: ['sheet', 'front', 'three-quarter', 'profile', 'back', 'full-body', 'expression'],
  product: ['sheet', 'front', 'side', 'three-quarter', 'detail'],
  vehicle: ['sheet', 'front', 'side', 'three-quarter', 'detail'],
  location: ['wide', 'medium', 'detail', 'sign'],
  style: ['sheet'],
};

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};

const sha256Hex = async (buffer) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
};

// One cache per project for the Queue's "Uses: …" line; dropped whenever a library is written.
const nameCache = new Map();
chrome.storage.onChanged.addListener((changes) => {
  if (changes['flowpilot.entities']) nameCache.clear();
});

export async function entityNames(projectId, entityRefs = []) {
  if (!entityRefs.length) return [];
  try {
    if (!nameCache.has(projectId)) {
      const { library } = await send('entities', { projectId });
      nameCache.set(projectId, library);
    }
    const library = nameCache.get(projectId);
    return entityRefs.map((ref) => library.entities.find((e) => e.id === ref.entityId)?.name ?? ref.entityId);
  } catch {
    return entityRefs.map((ref) => ref.entityId); // never hide the queue because the library failed to load
  }
}

export function createEntitiesPanel(root) {
  let project = null; // the project the panel is showing; follows the work tab until a person types one
  let followWorkTab = true;
  let data = null; // { projectId, library, template, style, warnings }
  let error = null;

  const showError = (e) => { error = e?.message ?? null; render(); };

  async function load() {
    try {
      data = await send('entities', project ? { projectId: project } : {});
      if (!project) project = data.projectId;
      error = null;
    } catch (e) { error = e.message; }
  }

  const act = (fn) => async (...a) => {
    try { showError(null); await fn(...a); await load(); render(); } catch (e) { showError(e); }
  };

  function projectRow() {
    const input = el('input', { value: project ?? '', placeholder: 'Flow project id (defaults to the work tab)', style: 'width:38ch' });
    const use = el('button', { textContent: 'Use project', style: 'display:inline;width:auto' });
    use.onclick = act(async () => {
      const v = input.value.trim();
      if (!/^[0-9a-f-]{36}$/.test(v)) throw new Error('A Flow project id is a uuid (open the project and bind the work tab instead)');
      followWorkTab = false;
      project = v;
      nameCache.clear();
    });
    return el('p', {}, input, ' ', use);
  }

  function card(entity) {
    const row = el('div', { style: 'border:1px solid #ddd;border-radius:6px;padding:8px;margin:6px 0;max-width:900px' });
    row.append(el('div', {},
      el('strong', { textContent: `${entity.kind === 'style' ? '🎨' : '📌'} ${entity.name}` }),
      ' ',
      el('span', {
        textContent: entity.approvedAt ? `✅ approved (v${entity.version})` : `🟡 not approved (v${entity.version})`,
        style: entity.approvedAt ? 'color:#1e8e3e' : 'color:#b06000',
      }),
      entity.approvedBy ? el('span', { textContent: ` by ${entity.approvedBy}` }) : null,
    ));
    row.append(el('pre', { textContent: entity.description, style: 'white-space:pre-wrap;margin:4px 0;font:12px/1.4 ui-monospace,monospace' }));
    if (entity.negative) row.append(el('div', { textContent: `Negative: ${entity.negative}`, style: 'font-size:12px;color:#5f6368' }));
    for (const ref of entity.refs ?? []) {
      const reason = el('input', { placeholder: 'reason (e.g. flat bronze rear half)', style: 'width:28ch' });
      const replace = el('button', { textContent: 'Supersede…', style: 'display:inline;width:auto' });
      replace.onclick = act(() => send('entitySupersede', { projectId: project, name: entity.id, ref: ref.mediaId, reason: reason.value || 'reference replaced' }));
      row.append(el('div', {},
        el('code', { textContent: `${ref.role ?? 'ref'} · ${ref.mediaId}${ref.label ? ` · ${ref.label}` : ''}` }),
        entity.primaryRefMediaId === ref.mediaId ? el('span', { textContent: ' (primary)' }) : null, ' ',
        reason, ' ', replace,
      ));
    }
    if (!(entity.refs ?? []).length) row.append(el('div', { textContent: 'No locked reference yet — add a Flow media id.', style: 'font-size:12px;color:#b06000' }));
    if (entity.sourcePhoto) row.append(el('div', { textContent: `Source photo: ${entity.sourcePhoto.path ?? entity.sourcePhoto.name} (sha256 ${String(entity.sourcePhoto.sha256).slice(0, 12)}…)`, style: 'font-size:12px;color:#5f6368' }));

    const buttons = el('div', {});
    const btn = (label, fn) => { const b = el('button', { textContent: label, style: 'display:inline;width:auto;margin-right:6px' }); b.onclick = fn; buttons.append(b); };
    if (entity.approvedAt) btn('Un-approve', act(() => send('entityUnapprove', { projectId: project, name: entity.id, reason: 'withdrawn in the dashboard' })));
    else btn('Approve', act(() => send('entityApprove', { projectId: project, name: entity.id })));
    btn('Remove', act(async () => {
      if (!window.confirm(`Remove ${entity.name} from this project's library? Its history is lost.`)) return;
      await send('entityRemove', { projectId: project, name: entity.id });
    }));
    for (const h of entity.history ?? []) row.append(el('div', { textContent: `v${h.version} superseded: ${h.reason ?? ''}`, style: 'font-size:12px;color:#5f6368' }));
    row.append(buttons);
    return row;
  }

  function addForm() {
    const form = el('form', { style: 'max-width:900px' });
    const name = el('input', { name: 'name', required: true });
    const kind = el('select', { name: 'kind' }, ...KINDS.map((k) => el('option', { value: k, textContent: k })));
    const description = el('textarea', { name: 'description', required: true, placeholder: 'CHARACTER — RUDY (identical in every shot): a heavyset man in his 30s…' });
    const negative = el('input', { name: 'negative', placeholder: 'realistic skin, different outfit (comma separated)' });
    const mediaId = el('input', { name: 'mediaId', placeholder: 'a Flow media id from this project (locked reference)' });
    const role = el('select', { name: 'role' }, ...ROLES.character.map((r) => el('option', { value: r, textContent: r })));
    const label = el('input', { name: 'label', placeholder: 'rudy_sheet_v1 (unique per project: the picker finds tiles by name)' });
    const aliases = el('input', { name: 'aliases', placeholder: 'the guy, Rudy 2 (comma separated)' });
    const approve = el('input', { name: 'approve', type: 'checkbox' });
    const photo = el('input', { name: 'photo', type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const photoPath = el('input', { name: 'photoPath', placeholder: 'and/or its absolute path, e.g. /Users/me/pics/rudy.jpg (provenance only)' });
    const note = el('div', { textContent: 'A dropped photo is provenance: the browser cannot read its path and a path is not a locked reference. Paste a media id to lock one.', style: 'grid-column:2;font-size:12px;color:#5f6368' });
    kind.onchange = () => role.replaceChildren(...(ROLES[kind.value] ?? []).map((r) => el('option', { value: r, textContent: r })));

    const submit = el('button', { textContent: 'Add entity' });
    form.append(
      el('label', { textContent: 'Name' }), name,
      el('label', { textContent: 'Kind' }), kind,
      el('label', { textContent: 'Description (inserted verbatim)' }), description,
      el('label', { textContent: 'Negatives' }), negative,
      el('label', { textContent: 'Reference media id' }), mediaId,
      el('label', { textContent: 'Reference role' }), role,
      el('label', { textContent: 'Reference label' }), label,
      el('label', { textContent: 'Aliases' }), aliases,
      el('label', { textContent: 'Photo (provenance)' }), photo,
      el('label', { textContent: 'Photo path' }), photoPath,
      el('label', { textContent: 'Approve now' }), approve,
      note,
      submit,
    );
    form.onsubmit = act(async (ev) => {
      ev.preventDefault();
      const entity = { name: name.value, kind: kind.value, description: description.value };
      if (negative.value.trim()) entity.negative = negative.value.trim();
      if (mediaId.value.trim()) entity.refs = [{ mediaId: mediaId.value.trim(), role: role.value, ...(label.value.trim() ? { label: label.value.trim() } : {}) }];
      if (aliases.value.trim()) entity.aliases = aliases.value.split(',').map((s) => s.trim()).filter(Boolean);
      if (approve.checked) entity.approved = true;
      const file = photo.files?.[0];
      if (file || photoPath.value.trim()) {
        entity.sourcePhoto = { name: file?.name ?? photoPath.value.trim().split(/[\\/]/).pop(), ...(photoPath.value.trim() ? { path: photoPath.value.trim() } : {}) };
        if (file) entity.sourcePhoto.sha256 = await sha256Hex(await file.arrayBuffer());
      }
      await send('entityUpsert', { projectId: project, entity });
      ev.target.reset();
    });
    return form;
  }

  function render() {
    root.replaceChildren();
    root.append(projectRow());
    if (error) { root.append(el('p', { className: 'banner', textContent: error })); return; }
    if (!data) { root.append(el('p', { textContent: 'Loading…' })); return; }

    const tools = el('p', {});
    const addStyle = el('button', { textContent: 'Use the canonical style lock as this project’s style entity', style: 'display:inline;width:auto' });
    addStyle.onclick = act(() => send('entitySetStyle', { projectId: project }));
    const exportBtn = el('button', { textContent: 'Export library', style: 'display:inline;width:auto' });
    exportBtn.onclick = act(async () => {
      const { library } = await send('entities', { projectId: project });
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(library, null, 2)}\n`], { type: 'application/json' }));
      const a = el('a', { href: url, download: `flowpilot-entities-${project}.json` });
      a.click();
      URL.revokeObjectURL(url);
    });
    const importFile = el('input', { type: 'file', accept: 'application/json', style: 'display:inline;width:auto' });
    importFile.onchange = act(async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      const library = JSON.parse(await file.text());
      await send('entityImport', { projectId: project, library, mode: 'merge' });
    });
    tools.append(addStyle, ' ', exportBtn, ' ', importFile);
    root.append(tools);

    const warnings = el('ul', {});
    for (const w of data.warnings ?? []) warnings.append(el('li', { textContent: `⚠️ ${w}` }));
    root.append(warnings);

    const list = el('div', {});
    for (const entity of data.library.entities) list.append(card(entity));
    if (!data.library.entities.length) list.append(el('p', { textContent: 'No entities yet for this project. Add one below — a character, vehicle, location, product or the style lock.' }));
    root.append(list);
    root.append(el('h3', { textContent: 'Add an entity' }), addForm());
  }

  return {
    render(workTabProjectId) {
      if (followWorkTab && workTabProjectId) project = workTabProjectId;
      load().then(render).catch(showError);
    },
    renderNow: render,
  };
}
