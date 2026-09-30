// The check that runs immediately before every credit-spending click (docs/SPEC.md hard rules):
// correct tab, correct project, correct mode, verbatim prompt, cost known, cap not exceeded.
// Pure: the driver gathers what the page shows, this decides.

// "Video · 360p · 4s crop_16_9 x1" → { kind, resolution, durationS, aspect, count }
export function parseSettingsSummary(text = '') {
  const kind = text.match(/^\s*(Video|Image)\b/i)?.[1].toLowerCase() ?? null;
  const aspect = text.match(/crop_(\d+)_(\d+)/);
  return {
    kind,
    resolution: text.match(/\b(\d{3,4}p)\b/)?.[1] ?? null,
    durationS: numberOr(text.match(/\b(\d+)s\b/)?.[1]),
    aspect: aspect ? `${aspect[1]}:${aspect[2]}` : null,
    count: numberOr(text.match(/\bx(\d)\b/)?.[1]),
  };
}

// "Generating will use 4 credits" → 4
export function parseCostLine(text = '') {
  return numberOr(text.match(/Generating will use\s+(\d+)\s+credits?/i)?.[1]);
}

// job:    { tabId, projectId, prompt, settings, expectedCost (number | null), modelFamily (catalog name | null),
//           references? { input, ingredients: [mediaId], firstFrame: mediaId|null, lastFrame: mediaId|null } }
// page:   { tabId, url, prompt, summary, input, model, cost, generateEnabled, overlayOpen,
//           attached? { ingredients: [mediaId], firstFrame: mediaId|null, lastFrame: mediaId|null } }
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
function checkReferences(want = {}, attached = {}, problems) {
  const wantIng = want.ingredients ?? [];
  const gotIng = attached.ingredients ?? [];
  const same = wantIng.length === gotIng.length && [...wantIng].sort().join() === [...gotIng].sort().join();
  if (!same) problems.push(`attached references ${list(gotIng)}, job wants ${list(wantIng)}`);
  if ((want.firstFrame ?? null) !== (attached.firstFrame ?? null)) problems.push(`first frame is ${attached.firstFrame ?? 'none'}, job wants ${want.firstFrame ?? 'none'}`);
  if ((want.lastFrame ?? null) !== (attached.lastFrame ?? null)) problems.push(`last frame is ${attached.lastFrame ?? 'none'}, job wants ${want.lastFrame ?? 'none'}`);
}

const list = (ids) => (ids.length ? ids.join(', ') : 'none');

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
