// The Shots panel (report §2.3-§2.5, §3 Phase 2): one row per shot, its still, whether that still is
// approved, and the video it unlocks. This is the SHOW-BEFORE-SPEND gate made visible: a shot's
// video job does not exist until its still is approved, so "Approve video" is disabled until the
// still row shows 🟢 — and the still's own button is the only thing that creates the video job.
//
// Every button here is a person's click on job data: importing queues free stills, approving a still
// records the approval and materialises the video job (still `queued`), and the video's own approve
// button is what would let credits move — behind the dashboard's cap, like any other job.

import { send } from '../ui.js';

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};

// Signed flow-content.google URLs, one per media id, kept for the session. A thumbnail is a read
// (as29s); a failed read leaves the media id text instead of breaking the row.
const thumbs = new Map();

export function createShotsPanel(root) {
  let project = null;
  let followWorkTab = true;
  let data = null;
  let error = null;
  let note = null;

  const showError = (e) => { error = e?.message ?? null; render(); };
  const status = (text) => { note = text; render(); };

  async function load() {
    try {
      data = await send('shots', project ? { projectId: project } : {});
      if (!project) project = data.projectId;
      error = null;
    } catch (e) { error = e.message; }
  }

  const act = (fn) => async (...args) => {
    try { showError(null); await fn(...args); await load(); render(); } catch (e) { showError(e); }
  };

  function projectRow() {
    const input = el('input', { value: project ?? '', placeholder: 'Flow project id (defaults to the work tab)', style: 'width:38ch' });
    const use = el('button', { textContent: 'Use project', style: 'display:inline;width:auto' });
    use.onclick = act(async () => {
      const v = input.value.trim();
      if (!/^[0-9a-f-]{36}$/.test(v)) throw new Error('A Flow project id is a uuid (open the project and bind the work tab instead)');
      followWorkTab = false;
      project = v;
    });
    return el('p', {}, input, ' ', use);
  }

  const idText = (mediaId) => el('code', { textContent: mediaId, style: 'font-size:11px' });

  function stillPicture(url, mediaId) {
    const img = el('img', { src: url, alt: `still ${mediaId}`, loading: 'lazy', style: 'max-width:96px;max-height:60px;border-radius:4px' });
    // A signed URL can expire or fail; fall back to the id text rather than a broken-image icon.
    const fallback = idText(mediaId);
    img.onerror = () => img.replaceWith(fallback);
    return el('a', { href: url, target: '_blank', rel: 'noreferrer' }, img);
  }

  // The cell gets a node *now* and the picture lands inside it when the read resolves: the read is a
  // round trip, and appending the promise it returns is what put the text `[object Promise]` on the
  // card where an approved still's thumbnail belongs (report §10 fault C). Until it lands the media
  // id is the honest placeholder, and a failed read leaves it there instead of breaking the row.
  function thumbnail(mediaId) {
    if (!mediaId) return null;
    const holder = el('span', {});
    if (thumbs.has(mediaId)) {
      const url = thumbs.get(mediaId);
      holder.append(url ? stillPicture(url, mediaId) : idText(mediaId));
      return holder;
    }
    thumbs.set(mediaId, null);
    holder.append(idText(mediaId));
    send('stillThumb', { projectId: project, mediaId })
      .then(({ url }) => {
        thumbs.set(mediaId, url ?? null);
        if (url) holder.replaceChildren(stillPicture(url, mediaId));
      })
      .catch(() => { /* the id text stays; a failed read never breaks the panel */ });
    return holder;
  }

  function stillCell(shot) {
    const cell = el('div', {});
    const job = shot.stillJob;
    if (shot.still?.mediaId) cell.append(thumbnail(shot.still.mediaId));
    else if (job) cell.append(el('span', { textContent: `${job.state} (${job.id.slice(0, 8)}…)` }));
    else cell.append(el('span', { textContent: 'none queued' }));
    if (job?.state === 'failed') cell.append(el('div', { textContent: `⚠️ ${job.error ?? 'failed'}`, style: 'color:#d93025;font-size:12px' }));
    if (shot.stillEntities?.length) cell.append(el('div', { textContent: `refs: ${shot.stillEntities.map((e) => e.name ?? e.entityId).join(', ')}`, style: 'font-size:11px;color:#5f6368' }));
    return cell;
  }

  function card(shot) {
    const row = el('div', { style: 'border:1px solid #ddd;border-radius:6px;padding:8px;margin:6px 0;max-width:1100px' });
    const anchor = shot.gate?.ok;
    row.append(el('div', {},
      el('strong', { textContent: `${shot.id} · scene ${shot.scene}` }),
      ' ',
      el('span', { textContent: anchor ? '🟢 anchored to the approved still' : '🟡 still not approved', style: anchor ? 'color:#1e8e3e' : 'color:#b06000' }),
      el('span', { textContent: ` · ${shot.mode}`, style: 'color:#5f6368' }),
      el('span', { textContent: shot.entities?.length ? ` · uses: ${shot.entities.map((e) => `${e.name ?? e.entityId}${e.flowCharacter ? ' (@character)' : ''}`).join(', ')}` : ' · no subjects', style: 'color:#5f6368' }),
    ));
    if (shot.beat) row.append(el('div', { textContent: shot.beat, style: 'font-size:12px;color:#5f6368' }));
    row.append(el('div', {}, stillCell(shot)));
    if (!anchor) row.append(el('div', { textContent: `🚧 ${(shot.gate?.problems ?? []).join(' ')}`, style: 'font-size:12px;color:#b06000' }));

    const videoPrice = shot.videoJob?.expectedCost ?? shot.videoCost;
    const price = videoPrice == null ? 'cost shown in Flow' : `${videoPrice} credit${videoPrice === 1 ? '' : 's'}`;
    row.append(el('div', { textContent: `video: ${shot.videoJob ? `${shot.videoJob.state} (${shot.videoJob.id}) — ${price}` : shot.videoCostProblem ? `cannot be built — ${shot.videoCostProblem}` : `not created yet — ${price}`}`, style: 'font-size:12px' }));
    if (shot.videoJob) row.append(el('div', { textContent: `prompt: ${shot.videoJob.prompt?.slice(0, 160) ?? ''}${(shot.videoJob.prompt?.length ?? 0) > 160 ? '…' : ''}`, style: 'font-size:11px;color:#5f6368' }));

    const buttons = el('div', {});
    const btn = (label, fn, enabled = true) => { const b = el('button', { textContent: label, style: 'display:inline;width:auto;margin-right:6px' }); b.disabled = !enabled; b.onclick = fn; buttons.append(b); };
    btn(shot.still?.jobId ? 'Queue a new still' : 'Queue still', act(() => send('queueStill', { projectId: project, shotId: shot.id })));
    const stillReady = shot.stillJob?.state === 'done' && !!shot.stillJob.mediaId;
    const alreadyApproved = shot.gate?.start?.mediaId === shot.stillJob?.mediaId;
    btn('Approve still', act(async () => {
      if (!window.confirm(`Approve this still for ${shot.id}? That creates its video job (${price}); the video still needs its own approval before it can spend.`)) return;
      await send('approveAnchor', { projectId: project, shotId: shot.id });
    }), stillReady && !alreadyApproved);
    btn(`Approve video (${price})`, act(async () => {
      if (!window.confirm(`Approve ${shot.videoJob?.id} (${price})? The session cap still gates the actual click.`)) return;
      await send('approve', { id: shot.videoJob.id });
    }), shot.videoJob?.state === 'queued');
    if (shot.videoJob?.state === 'failed' && shot.videoJob.clickedAt == null && !shot.videoJob.mayHaveSubmitted) btn('Re-queue video', act(() => send('requeue', { id: shot.videoJob.id })));
    row.append(buttons);
    return row;
  }

  function importBox() {
    const box = el('div', {});
    const area = el('textarea', { placeholder: 'scene,name,beat,action,motion,setting,camera.shotType,camera.moveId,audio,entities,mode,outputPath\n4,scene_4,driving home,the Charger drives,anticipation,quiet street,wide,tracking-glide,V8 note,Rudy;Hellcat,ingredients,/tmp/clips/scene_4.mp4', rows: 4 });
    const file = el('input', { type: 'file', accept: '.json,.csv,application/json,text/csv', style: 'display:inline;width:auto' });
    let filename = '';
    file.onchange = act(async () => {
      const f = file.files?.[0];
      if (!f) return;
      filename = f.name;
      area.value = await f.text();
    });
    const run = el('button', { textContent: 'Import shots (one free still each)', style: 'display:inline;width:auto' });
    run.onclick = act(async () => {
      if (area.value.trim() === '') throw new Error('Paste a shot list or choose a .json/.csv file first');
      const r = await send('importShots', { projectId: project, text: area.value, filename });
      area.value = '';
      filename = '';
      status(`Queued ${r.shots} free still job(s)${r.totalCost == null ? '' : ` · videos will total ~${r.totalCost} credits`}. Approve the stills below; a video job appears only after that.`);
    });
    box.append(el('p', { textContent: 'A shot row asks for a still (free) now and a video (credits) later. mode:ingredients references up to three subjects; mode:frames anchors the video to the approved still; with more than three subjects the still is the merge point, so use frames.', style: 'font-size:12px;color:#5f6368' }));
    box.append(el('p', {}, file, ' ', run));
    box.append(area);
    return box;
  }

  function render() {
    root.replaceChildren();
    root.append(projectRow());
    if (error) { root.append(el('p', { className: 'banner', textContent: error })); return; }
    if (!data) { root.append(el('p', { textContent: 'Loading…' })); return; }
    if (note) root.append(el('p', { textContent: note, style: 'color:#1e8e3e' }));
    root.append(importBox());
    const shots = data.shots ?? [];
    for (const shot of shots) root.append(card(shot));
    if (!shots.length) root.append(el('p', { textContent: 'No shots yet for this project. Import a shot list above, or `flowpilot shots import --project P --file shots.json`.' }));
  }

  return {
    render(workTabProjectId) {
      if (followWorkTab && workTabProjectId) project = workTabProjectId;
      load().then(render).catch(showError);
    },
    renderNow: render,
  };
}
