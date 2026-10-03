// The dated "Flow compatibility" note (report §9.3).
//
// Every serious tool in this category dies the same way: Flow ships, the tool breaks, and the user
// finds out from a failed batch. Flow Pilot's answer is to say out loud which Flow build it was last
// proven against, what it knows is broken, and what it has never tested — the one visible
// reliability promise in the category.
//
// HOW TO UPDATE THIS FILE (the weekly loop in the teardown report §8.2-8.3):
//   1. Run the read-only self-check (`flowpilot doctor`, or open Flow and look at the popup) — zero
//      credits, never Generate.
//   2. Set `provenThrough` to the date of that run and `build`/`buildSeenAt` to the build string the
//      page served (`bl=` in Flow's own batchexecute URL, or the frontend build in the page source).
//   3. Move anything newly proven into `proven`; anything that broke goes into `knownIssues`, in the
//      words of whatever error the user would see; anything still untested stays in `unverified`.
//   4. Bump `noteUpdated` and move on. The note is only worth anything if the date is real.
//
// Facts below are from `recon/FINDINGS.md` (read-only captures and the two live proofs) — not
// claims about Flow in general.
export const FLOW_COMPAT = {
  noteUpdated: '2026-10-03',
  provenThrough: '2026-10-01',
  build: 'boq_labs-ai-sandbox-frontend_20260925.00_p0',
  buildSeenAt: '2026-09-27',
  proven: [
    'a full video job end to end on 2026-09-28: submit through Flow\'s own Generate, track, download, byte-check (360p 4 s, 4 credits; the account balance went 269 → 265)',
    'uploads and references on 2026-10-01: an image uploaded through Flow\'s own Upload media control, then attached as an Ingredient and as Frames, each read back by media id (0 credits)',
    'image mode and image references on 2026-10-03 (read-only, 0 credits): Image mode\'s own cost line read 0 credits, and an image job\'s Ingredients attached through the composer\'s own Add ingredients picker + Add to prompt without opening the image editor, the id read back from flow-ingredient-bar',
    'the self-check and the pre-spend checks (tab, project, mode, verbatim prompt, cost, cap) on every submit since 2026-09-28',
  ],
  changed: [
    'Flow builds move every few days: the first research pass saw ..._20260922.00_p0, the capture two days later saw ..._20260925.00_p0',
    'the Agent panel gained its own composer; a typed line break there submits, so the driver refuses to run while the panel is open (2026-09-28)',
    'Flow stopped re-rendering in background tabs, so the work tab must be the front tab while a job is prepared and submitted (2026-09-28)',
    'the media reader had to switch from the workflow title to the record\'s own prompt, and from the first signed URL to the kind-matching one (2026-09-28)',
  ],
  knownIssues: [
    'the work tab must be the front tab of its window while a job is prepared and submitted; otherwise the job waits and the dashboard says so (docs/LESSONS.md #23)',
    'a fresh upload can take a while to appear in the project, so Flow Pilot reads the new media id from Flow\'s own project-media call instead of waiting for the grid (docs/LESSONS.md #13)',
    'an open Agent panel blocks generation: the driver only uses the main composer and refuses to run while the panel is open (docs/LESSONS.md #22)',
    'when Flow changes a response shape, jobs fail closed with "Flow changed" instead of spending credits on a guess (docs/SPEC.md decision 13)',
    'loading the extension unpacked gives it a new id; the helper refuses to talk to a new id until the pin is cleared with `flowpilot serve --forget-extension`',
  ],
  unverified: [
    'an image job (Nano Banana) end to end: image recipes are priced and can be queued, but no live image run has been done yet',
    'a batch of more than a handful of rows in one day: pacing and the halt are designed for it, but the field evidence only covers single jobs and one burst',
    'the 2K/4K upsample and the image *edit* flow — deliberately out of scope',
    'anything on a Flow build newer than the one above, and anything on an account other than the practice account',
  ],
  howToUpdate: 'Update this note as part of the weekly loop (the teardown report §8.2-8.3): date it, move what is newly proven up, and add what broke to knownIssues. A note that does not move is worse than none.',
};

export function compatNote(compat = FLOW_COMPAT) {
  return `Flow compatibility: last proven against the Flow build of ${compat.provenThrough} (build ${compat.build}, seen ${compat.buildSeenAt}); note updated ${compat.noteUpdated}. `
    + `${compat.knownIssues.length} known ${compat.knownIssues.length === 1 ? 'issue' : 'issues'}, ${compat.unverified.length} things not yet verified.`;
}

const bullets = (title, lines) => [`${title}`, ...lines.map((l) => `- ${l}`), ''];

export function compatReport(compat = FLOW_COMPAT) {
  return [
    compatNote(compat),
    '',
    `What was proven, and when (read-only checks and live runs; every capture in recon/FINDINGS.md):`,
    ...compat.proven.map((l) => `- ${l}`),
    '',
    ...bullets(`What changed under us (Flow builds drift; these are the changes that broke something here):`, compat.changed),
    ...bullets('Known issues you may hit today:', compat.knownIssues),
    ...bullets('Not verified yet — Flow Pilot says so instead of pretending:', compat.unverified),
    `How to update this note: ${compat.howToUpdate}`,
  ].join('\n');
}
