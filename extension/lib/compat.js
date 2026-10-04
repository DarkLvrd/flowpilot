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
  provenThrough: '2026-10-03',
  build: 'boq_labs-ai-sandbox-frontend_20261002.00_p0',
  buildSeenAt: '2026-10-03',
  proven: [
    'a full video job end to end on 2026-09-28: submit through Flow\'s own Generate, track, download, byte-check (360p 4 s, 4 credits; the account balance went 269 → 265)',
    'uploads and references on 2026-10-01: an image uploaded through Flow\'s own Upload media control, then attached as an Ingredient and as Frames, each read back by media id (0 credits)',
    'Image mode\'s own settings chip and cost line on 2026-10-03, read-only (0 credits): " 🍌 Nano Banana 2 crop_16_9 x1 " with `Generating will use 0 credits`, so a still really is free today',
    'one free still generated on 2026-10-03 (0 credits, the cost line read first) and attached again as a video\'s first frame by the picker, matched by the workflow title Flow shows on the tile (id read back off the composer)',
    'a still job end to end on 2026-10-03 (0 credits): Flow\'s Image-mode Generate ran from a real pointer click, and Flow Pilot tracked it submitted → rendering → downloading → done, downloaded it and byte-checked the JPEG (809 742 bytes, the number the browser and Flow\'s own signed URL both report)',
    'the picker\'s own `Close` control, the backdrop and the composer\'s Add ingredients button on 2026-10-03 (0 credits, no submission): on the Frames picker only the first of the three closes it',
    'the self-check and the pre-spend checks (tab, project, mode, verbatim prompt, cost, cap) on every submit since 2026-09-28',
  ],
  changed: [
    'Flow builds move every few days: the first research pass saw ..._20260922.00_p0, then ..._20260925.00_p0, and ..._20261002.00_p0 is the build of 2026-10-03',
    'the Agent panel gained its own composer; a typed line break there submits, so the driver refuses to run while the panel is open (2026-09-28)',
    'Flow stopped re-rendering in background tabs, so the work tab must be the front tab while a job is prepared and submitted (2026-09-28)',
    'the media reader had to switch from the workflow title to the record\'s own prompt, and from the first signed URL to the kind-matching one (2026-09-28)',
    'the picker labels a generated media with the workflow title Flow wrote, not with the prompt the record keeps (2026-10-03), and several media can share one title',
    'Image mode\'s settings chip carries the image model\'s name where a video chip writes the word `Video`, so there is no kind word to read in that mode (2026-10-03)',
  ],
  knownIssues: [
    'the work tab must be the front tab of its window while a job is prepared and submitted; otherwise the job waits and the dashboard says so (docs/LESSONS.md #23)',
    'Flow\'s Image-mode Submit ignores clicks that are not real user gestures: its own code runs the generate only when the event is trusted (`a == null || !a.isTrusted` in its submit path, live 2026-10-03). A still therefore has to be started by a real click — Flow Pilot can prepare the composer and verify it, but not click for you',
    'a fresh upload can take a while to appear in the project, so Flow Pilot reads the new media id from Flow\'s own project-media call instead of waiting for the grid (docs/LESSONS.md #13)',
    'an open Agent panel blocks generation: the driver only uses the main composer and refuses to run while the panel is open (docs/LESSONS.md #22)',
    'when Flow changes a response shape, jobs fail closed with "Flow changed" instead of spending credits on a guess (docs/SPEC.md decision 13)',
    'a composer that still holds a reference (a job that failed after attaching) leaves the Frames Start slot unclickable, so the next Frames job fails with "The Start frame slot is not clickable" until the chip is detached by hand (live 2026-10-03; not fixed yet)',
    'loading the extension unpacked gives it a new id; the helper refuses to talk to a new id until the pin is cleared with `flowpilot serve --forget-extension`',
  ],
  unverified: [
    'an image job end to end from Flow Pilot\'s own click: the pre-spend check, the picker attach and a whole still run are proven live (2026-10-03) and a still costs 0 credits, but Flow\'s Image-mode submit ignores synthetic clicks, so a real gesture (a person\'s, or a real pointer click) still starts the still',
    'a shot\'s video end to end: approving the still built and anchored the video job live (2026-10-03; its first frame the approved still, 4 credits) but no video job has run end to end yet',
    'a chip-only Flow Character job with no typed mention: the paid capture cannot separate the two signals',
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
