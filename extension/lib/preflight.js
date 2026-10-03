// The check that runs immediately before every credit-spending click (docs/SPEC.md hard rules):
// correct tab, correct project, correct mode, verbatim prompt, cost known, cap not exceeded.
// Pure: the driver gathers what the page shows, this decides.

// The Settings trigger's summary, read off the trigger's own text. Two shapes are real on the live
// page (captured 2026-10-03, recon/FINDINGS.md "Settings chip shapes"):
//   video  " Video · 360p · 4s crop_16_9 x1 "   — the word `Video` first
//   image  " 🍌 Nano Banana 2 crop_16_9 x1 "    — the image model's name where a video chip writes
//                                                 its kind word, and no resolution and no duration
// `mode` is the settings panel's own checked mode radio, which the driver reads while the panel is
// open: Flow's own statement of the mode, and the only kind word an image chip has. The chip's own
// word wins when Flow writes one, then the radio, then the chip's shape — an image chip is the only
// chip with a crop and a count and neither a resolution nor a duration. A chip that reads as none
// of them keeps `kind` null, and `checkBeforeSpend` refuses it before any credit moves.
// "Video · 360p · 4s crop_16_9 x1" → { kind: 'video', resolution: '360p', durationS: 4, aspect: '16:9', count: 1 }
export function parseSettingsSummary(text = '', { mode = null } = {}) {
  const word = text.match(/^\s*(Video|Image)\b/i)?.[1].toLowerCase() ?? null;
  const aspect = text.match(/crop_(\d+)_(\d+)/);
  const resolution = text.match(/\b(\d{3,4}p)\b/)?.[1] ?? null;
  const durationS = numberOr(text.match(/\b(\d+)s\b/)?.[1]);
  const count = numberOr(text.match(/\bx(\d)\b/)?.[1]);
  const shape = resolution == null && durationS == null && (aspect || count != null) ? 'image' : null;
  return {
    kind: word ?? mode ?? shape,
    resolution,
    durationS,
    aspect: aspect ? `${aspect[1]}:${aspect[2]}` : null,
    count,
  };
}

// "Generating will use 4 credits" → 4
export function parseCostLine(text = '') {
  return numberOr(text.match(/Generating will use\s+(\d+)\s+credits?/i)?.[1]);
}

// job:    { tabId, projectId, prompt, settings, expectedCost (number | null), modelFamily (catalog name | null),
//           references? { input, ingredients: [mediaId], firstFrame: mediaId|null, lastFrame: mediaId|null,
//                         characters: [{ entityId, name }] } }
// page:   { tabId, url, prompt, summary, modeKind, input, model, cost, generateEnabled, overlayOpen,
//           attached? { ingredients: [mediaId], firstFrame: mediaId|null, lastFrame: mediaId|null,
//                       characters: [/asb/ thumbnail token] },
//           characterTokens? { [name]: token }, mentions? [{ entityId, referenceType, valid }] }
// budget: { cap, spent, halted }
// Returns { ok, problems: [human-readable strings] }.
// The reference check (docs/SPEC.md hard rules, now also: the right references are attached,
// verified by media id) compares what the driver attached in the composer, id for id, to what the
// job asked for. A job with no resolved references expects nothing attached.
export function checkBeforeSpend(job, page, budget) {
  const problems = [];
  const s = job.settings;

  if (budget.halted) problems.push('queue is halted');
  if (page.tabId !== job.tabId) problems.push(`wrong tab: ${page.tabId}, job is bound to ${job.tabId}`);
  if (page.url !== `https://flow.google.com/project/${job.projectId}`) problems.push(`wrong project page: ${page.url}`);
  if (page.prompt !== job.prompt) problems.push('prompt in the box does not match the job verbatim');

  const shown = page.summary ?? {};
  if (shown.kind !== s.kind) problems.push(`kind is ${shown.kind}, job wants ${s.kind}`);
  if (shown.aspect !== s.aspect) problems.push(`aspect is ${shown.aspect}, job wants ${s.aspect}`);
  if (shown.count !== s.count) problems.push(`count is ${shown.count}, job wants ${s.count}`);
  // The model decides the price; the catalog's family name is what the model button shows.
  if (job.modelFamily == null) problems.push('the job has no known model (the catalog could not be read when it was added)');
  else if (page.model !== job.modelFamily) problems.push(`model is ${page.model}, job wants ${job.modelFamily}`);
  if (s.kind === 'video') {
    if (shown.resolution !== s.resolution) problems.push(`resolution is ${shown.resolution}, job wants ${s.resolution}`);
    if (shown.durationS !== s.durationS) problems.push(`duration is ${shown.durationS}s, job wants ${s.durationS}s`);
    const wantInput = s.input === 'frames' ? 'frames' : 'ingredients';
    if (page.input !== wantInput) problems.push(`input mode is ${page.input}, job wants ${wantInput}`);
  }

  checkReferences(job.references, page.attached, problems);
  checkCharacters(job.references, page, problems);

  const cost = spendCost(job, page, problems);
  if (budget.cap == null) problems.push('no session credit cap is set');
  else if (cost != null && budget.spent + cost > budget.cap) {
    problems.push(`cap: ${budget.spent} spent + ${cost} would pass the cap of ${budget.cap}`);
  }

  if (!page.generateEnabled) problems.push('Generate button is disabled');
  if (page.overlayOpen) problems.push('an overlay is open over the page');
  return { ok: problems.length === 0, problems };
}

// Every reference the job resolved (media ids for id-refs, the ids its path-refs uploaded to) must
// be the exact set attached in the composer — never more, never fewer, never a different id.
function checkReferences(want, attached, problems) {
  // A plain job stores references: null (addJob); null does not trigger a default param, so read
  // both as "nothing" here rather than crash on `.ingredients` and wedge the job in submitting.
  want = want ?? {};
  attached = attached ?? {};
  const wantIng = want.ingredients ?? [];
  const gotIng = attached.ingredients ?? [];
  const same = wantIng.length === gotIng.length && [...wantIng].sort().join() === [...gotIng].sort().join();
  if (!same) problems.push(`attached references ${list(gotIng)}, job wants ${list(wantIng)}`);
  if ((want.firstFrame ?? null) !== (attached.firstFrame ?? null)) problems.push(`first frame is ${attached.firstFrame ?? 'none'}, job wants ${want.firstFrame ?? 'none'}`);
  if ((want.lastFrame ?? null) !== (attached.lastFrame ?? null)) problems.push(`last frame is ${attached.lastFrame ?? 'none'}, job wants ${want.lastFrame ?? 'none'}`);
}

const list = (ids) => (ids.length ? ids.join(', ') : 'none');

// The character-attached check (report §8.1 step 4). A Flow Character exposes no id in the DOM, so
// the only honest proof is: the chip is in the composer AND its thumbnail token is the byte-identical
// one of the picker tile the driver picked for that character. A mention chip in the prompt is
// verified by entity id, and Flow's own "this mention will be sent as plain text" marker
// (`mention-chip-invalid`) fails the job rather than letting it spend on a degraded prompt (§3a).
// Everything here is fail-closed: a missing chip, an unread token, an unasked-for chip or a mention
// naming another entity all stop the click before the credits move.
function checkCharacters(want, page, problems) {
  const chars = want?.characters ?? [];
  const attached = page.attached?.characters ?? [];
  const tokens = page.characterTokens ?? {};
  for (const c of chars) {
    const token = tokens[c?.name];
    if (!token) problems.push(`the character "${c?.name ?? c?.entityId}" was not attached through Flow's picker`);
    else if (!attached.includes(token)) problems.push(`the composer has no character chip for "${c.name}" (the chip and its picker tile must match)`);
  }
  if (attached.length !== chars.length) {
    problems.push(`the composer has ${attached.length} character chip(s), job wants ${chars.length}`);
  }
  for (const m of page.mentions ?? []) {
    if (!m?.entityId) continue; // a mention chip the page did not label is not something to trust
    if (m.valid === false) problems.push(`the prompt's @ mention for entity ${m.entityId} is invalid (Flow would send plain text: mention-chip-invalid)`);
    else if (!chars.some((c) => c?.entityId === m.entityId)) problems.push(`the prompt mentions entity ${m.entityId}, which is not one of the job's characters`);
  }
}

// The credits this click will spend, or null (with a problem recorded) when it can't be trusted.
function spendCost(job, page, problems) {
  if (page.cost == null) {
    if (job.expectedCost === 0) return 0;
    problems.push('cost line not found on the page');
    return null;
  }
  if (job.expectedCost != null && page.cost !== job.expectedCost) {
    problems.push(`cost is ${page.cost} credits, expected ${job.expectedCost}`);
  }
  return page.cost;
}

function numberOr(v, fallback = null) {
  return v == null ? fallback : Number(v);
}
