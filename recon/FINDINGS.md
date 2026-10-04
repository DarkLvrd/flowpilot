# Recon findings — Flow as of 2026-09-27

Read-only capture on a practice account; zero credits spent by the capture. Frontend build
`boq_labs-ai-sandbox-frontend_20260925.00_p0` (research report saw `20260922.00_p0`, so builds
move every few days). Re-run with `node recon/capture.mjs --port <cdp-port>` against a Chrome
started with `--remote-debugging-port` and signed in by hand (a tool-launched Chrome is refused
at Google sign-in). Raw captures stay in `recon/raw/` (gitignored).

## Transport

`POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=<id>&source-path=…&bl=<build>&f.sid=…&hl=…&_reqid=…&rt=c`
Form body: `f.req=[[["<rpcid>","<inner JSON as string>",null,"generic"]]]` plus the page's `at`
token. Response: `)]}'` prefix, then length-prefixed chunks; the payload is the `wrb.fr` entry
whose third element is the inner JSON as a string.

## RPCs the page calls on its own when a project opens

| rpcid | Request inner | What it returns | Flow Pilot use |
|---|---|---|---|
| `nzlxg` | `[]` | `[261,1,2,2,null,261]` — first number is most likely the **credit balance** (to confirm against the Account-details popover) | Credit guard, self-check |
| `HTrJv` | `[]` | **Model catalog**: every model/recipe, display names, and **credit cost per recipe** at slot `[4]` (`abra_i2v_4s` → 7, `abra_*_360p` → 4, `GEM_PIX_2` → 0) | Cost preview, model picker |
| `yBhWQ` | `[]` | Video model availability: `veo_3_1_fast`, `veo_3_1_lite`, `abra`, `veo_3_1_quality` | Self-check |
| `ngNC2` | `["tools/PINHOLE/projects/<pid>"]` | Project id + title + default settings | Project resolve |
| `Zzl0ze` | `["projects/<pid>",null,null,null,[1]]` | **Project media**: per generation — workflow id, prompt, timestamps, media id, recipe, ingredient media ids, size; also the voice list | Job tracking, prompt verification |
| `as29s` | `["<mediaId>"]` | Media detail incl. **signed `flow-content.google/<image\|video>/<mediaId>?Expires…&Signature…` URL** | Download |
| `mrlkwd` | `["<pid>"]` | Agent conversations in the project | Ignore |
| `GN0Bre` | `["<conversationId>"]` | One Agent conversation's transcript | Ignore |
| `o30O0e` | people API `["me"]…` | Signed-in account (id, name, email, photo) | Show which account is active |
| `cPZSdc`, `tRARke` | `[]` | Announcements; community tools gallery | Ignore |
| `NfrxTb`, `KV2T2d`, `LPzVkd`, `qJcgMc`, `ve2Lsc`, `DTaVef`, `Yizz8d`, `WuwhI` | small | Feature flags / onboarding state | Ignore |

Not seen (they need a real click; `YhhmEf` and `jwpduf` since seen, see "First live job"): the generate RPCs (`eb1hJf`, `nprQif`, `MZZa6b`, `YhhmEf`,
`ogiZ0b` per the research report), upload `maseQ`, and operation status `jwpduf`. Flow Pilot
learns their response shapes from the first real job (spec decision 13).

## Media record examples (from `Zzl0ze`)

- Image: prompt `a boy on a horse`, 1376×768, model shown in UI as `🍌 Nano Banana 2`.
- Video: prompt `he is riding his house`, recipe **`abra_r2v_4s_360p`** (Omni reference-to-video,
  4 s, 360p), ingredient = the image's media id. Tile shows `Omni 1.1 Flash · 360p · 4s · 16:9`.
- Every record carries its own media id and the verbatim prompt, so jobs can be matched by id
  and prompt — never by grid position.

## Recipe families (from `HTrJv`)

- Omni Flash (`abra`): `abra_t2v_{4,6,8,10}s[_360p]` text→video, `abra_i2v_*` first frame,
  `abra_r2v_*` references (Ingredients), `omni_flash_i2v_*_first_last[_360p]` first+last frame,
  `abra_edit[_360p]`, `omni_upsampler_360p`.
- Veo 3.1 Fast / Lite / Quality and older Veo 2/3 recipes, upsamplers 1080p / 4K.
- Images (catalog family → recipe): `🍌 Nano Banana 2` → `NARWHAL`, `🍌 Nano Banana Pro` → `GEM_PIX_2`,
  `🍌 Nano Banana 2 Lite` → `HARBOR_SEAL`; upsample 2K/4K. All cost 0 today. (Corrected 2026-09-28:
  this line used to say `GEM_PIX_2` was Nano Banana 2.)
- The settings panel's model button shows the catalog family name, e.g. `Omni 1.1 Flash`
  (plus an `arrow_drop_down` icon ligature).

## Composer DOM (accessible names — stable hooks)

- Prompt box: the editable region under "What do you want to create?"
- Buttons: `Add ingredients to the prompt box`, `Agent` (toggle), `Settings trigger`,
  `Start generation` (disabled until there is a prompt).
- Settings panel radios: `Image` | `Video`; `Frames` | `Ingredients`; `16:9` | `9:16`;
  `360p` | `720p`; `4s` | `6s` | `8s` | `10s`; `x1`–`x4`; button `Select model family`.
- The panel states the price: `Generating will use <N> credits`.
- Header: `Account details` button whose label includes the account name/email.
- Project nav: `All media`, `Images`, `Videos`, `Characters`, `Scenes`, `Tools`, `Bin`.

## Agent mode (seen 2026-09-28)

- When the Agent panel is open (`flow-agent-panel` › `flow-creative-agent-prompt-box`), the main
  composer is not rendered: the only `flow-base-prompt-box`, ProseMirror editor and
  `Start generation` button are the Agent's. Its toolbar adds `Agent instructions`
  (`aria-pressed`), `Settings`; the header has `Open session history`, `Close`.
- The panel state persists across page loads (it was open on return, with no action taken).
- The prompt box is ProseMirror (`flow-rich-text-editor .ProseMirror`). Enter submits; an
  inserted line break counts as Enter. Paste goes through ProseMirror's paste handling instead.
- The page holds a hidden `textarea#g-recaptcha-response-*` (reCAPTCHA badge). Never touch it.
- Agent mode also lives in the main composer: with the side panel closed, the composer's `Agent`
  toggle can still be on (`aria-pressed="true"`). Then the composer is wrapped in
  `flow-creative-agent-prompt-box`, shows `Agent instructions` and `Settings`, and its settings
  summary is empty. With the toggle off the wrapper is gone (`flow-prompt-box` › … ›
  `flow-base-prompt-box`). So `flow-creative-agent-prompt-box` anywhere = Agent mode.

## Composer behaviour (dry run, 2026-09-28)

- A multi-line paste lands as **one** `<p>` with `<br>` between lines (hard breaks), not one `<p>`
  per line. An empty box is `<p><br class="ProseMirror-trailingBreak"></p>`.
- ProseMirror picks up a script-set selection only on the next `selectionchange` event; pasting
  before it fires appends to the old text instead of replacing it.
- Settings panel radios are `button[role=radio]` (`mat-button-toggle`) with no `aria-label`;
  their text includes the icon ligature (`videocamVideo`, `crop_16_916:9`, `360pinfo`). The
  accessible name skips the `mat-icon`. The panel is `flow-prompt-box-settings`; the trigger opens
  and closes it on `click` and has no `aria-expanded`.
- Flow is zoneless Angular (`window.Zone` undefined). In a background tab (`visibilityState:
  hidden`) a click on `Settings trigger` runs but the page never re-renders; in the front tab it
  opens at once. ProseMirror edits still apply in the background.

## First live job (2026-09-28, 4 credits, capture `recon/raw/generate-1790654318959`)

Text-to-video, 360p 4 s, Ingredients mode, no references. Order after the click:
`recaptcha/enterprise/reload` (Flow's own) → **`YhhmEf`** (generate) → `jwpduf` every few seconds
→ `Zzl0ze` refresh → `as29s` once done. All HTTP 200.

- `YhhmEf` request: `[[[[null,null,[[["<prompt>"]]]], "<recipe>", 2, null, [.., <2 uuids>], null, null, [4]]],
  [null, 22, …, "<projectId>", …, ["<reCAPTCHA token>", 1]], ["<clientRequestId>", 2]]`. Flow Pilot
  never builds this; it is Flow's own button.
- `YhhmEf` response: `[null, <new balance>, [[<workflowId>, …, [<title>, [ts], …, <mediaId>, …]]],
  [<media record>]]`. The balance went 269 → **265** (the 4 credits the cost line promised) and the
  media id (`6a2d2214-…`) is in it from the first response.
- `jwpduf` (`[null,null,[["<mediaId>"]]]`) returns the media record; its status slot went `[2]`
  (rendering) → `[3]` (done, plus `492274` = the MP4 size in bytes, matching the saved file) in under a minute.
- **Flow titles the workflow itself** ("Red fox trotting through snow"); the workflow text is no
  longer the prompt. The verbatim prompt is inside the media record (`[[["<prompt>"]]]` and after
  the timestamp). Matching by the workflow text missed the job; the reader now prefers the
  record's own prompt (fixture `Zzl0ze-first-job.txt`).
- Thumbnails/previews are `/asb/<token>` links on `contribution.fife.usercontent.google.com`
  too, not only `lh3.googleusercontent.com`; fixtures redact `/asb/` on any host.
- `as29s` for a video lists **two** signed URLs: the poster `flow-content.google/image/<mediaId>?…`
  first, then `flow-content.google/video/<mediaId>?Expires=…&Signature=…`. Taking the first one
  downloaded a JPEG; the magic-byte check rejected it. The reader now asks for the job's kind.

## Image mode and image references (2026-10-03, read-only, 0 credits, CDP port 9333)

Practice project `78d6e0a5-…`, one Flow tab, no Generate clicked, no credits spent. Read through the
page's own DOM (the same controls the driver uses); the composer was restored (Video + Ingredients,
settings panel closed, no attached reference, project root URL) afterwards.

- **Image mode quotes 0 credits**: with Settings open and `Image` selected, Flow's own cost line
  read `Generating will use 0 credits`. `Video` in the same panel read `4 credits` (360p, 4 s,
  Ingredients). This is the confirmation the still step needs: a still is free today.
- **An image job can take Ingredients.** In Image mode the composer still shows
  `Add ingredients to the prompt box`, and the asset picker (`flow-add-menu-popover-content` ›
  `flow-add-menu-asset-list`, confirm button `Add to prompt`) attaches a tile exactly as it does for
  Video. After `Add to prompt` the page stayed on `/project/<pid>` — **no `flow-image-editor`, no
  `flow-edit-image-prompt-box`, no `/edit/<workflowId>` URL** — and the attached media id was
  readable from `flow-ingredient-bar` (`690eeca2-253d-4387-a2e7-941aa8592827`, the synthetic
  `flowpilot-synth-ref.png`, the same id the ref test used). The chip's own remove control clears it.
- **Correction to the 2026-10-01 note below.** "Image + reference traps the image editor" was
  dependent on how the tile was selected (a bare tile click in the grid) or on a Flow build since
  changed: attaching through the composer's own `Add ingredients` picker and `Add to prompt` in
  **Image** mode does not open the editor on this build (Chrome 154, 2026-10-03). The driver still
  checks the page URL before any click, so if a future build does route into the editor the job fails
  before spending.

## Uploads and references (Ingredients + Frames, 2026-10-01, one synthetic image uploaded, 0 credits)

Proven on the practice account by uploading one plain 16×16 teal PNG (never a photo of a person)
and attaching it; no Generate, no credits. The composer was restored to the project root after.

- **Upload control.** The asset picker's upload button has **no `aria-label`**; it carries
  `mattooltip="Upload media"` and class `sidebar-upload-btn`. Clicking it makes Flow append a hidden
  `<input type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.heif,.heic,.mp4,.m4v,.mov,.3gp,.avi"
  multiple style="display:none">` to the page (not inside the picker). No native file dialog is
  needed: set `input.files` from a `DataTransfer` built from the bytes and dispatch `input`+`change`
  (what a content script can do). `maseQ` then fires (HTTP 200) and the new media appears in
  `Zzl0ze` within ~10 s — read the new id from `Zzl0ze` (LESSONS #13), not from the grid.
- **One upload adds two uuids to `Zzl0ze`**: the media id and its workflow id. `parseProjectMedia`
  returns the real media id per record, so the `Zzl0ze` diff (`newlyUploadedId`) is authoritative;
  a raw uuid regex over the response over-counts.
- **Tiles carry the media id in their thumbnail**: `<img src="https://flow-content.google/image/<id>?…">`
  (video tiles use `/video/<id>`). So a tile is found by matching this id — solving LESSONS #14 for
  the picker (the main grid still has no `data-media-id`). The composer's attached references show
  the same `flow-content.google/<image|video>/<id>` thumbnails, so attached ids are read back the
  same way (scope the read to the prompt box — `flow-prompt-box` › `flow-ingredient-bar` — or the
  project-media grid thumbnails are caught too).
- **Ingredients attach.** Settings → Video + Ingredients, then `Add ingredients to the prompt box`
  (composer button, this aria-label) opens the picker; select each tile, then click **`Add to
  prompt`** (the picker's confirm button). The composer stays a video composer.
- **Image + reference traps the image editor.** Selecting a tile while the composer is in **Image**
  mode (Nano Banana) switches it to `flow-edit-image-prompt-box` / `flow-image-editor` and the URL
  to `/project/<pid>/edit/<workflowId>` — that is the out-of-scope *edit* flow. Set Video +
  Ingredients **before** attaching. (Superseded 2026-10-03: see the image-mode section above — this
  did not reproduce when the tile was chosen through the composer's own `Add ingredients` picker.)
  Leaving that editor needs navigating back to `/project/<pid>`.
- **Frames attach.** Settings → Video + Frames shows two slots labelled **`Start`** and **`End`**
  (plus a `Swap first and last frames` button) inside `flow-ingredient-bar`. Click a slot to open
  the same picker; select/upload, then `Add to prompt`. The filled slots show the
  `flow-content.google/image/<id>` thumbnails in DOM order (Start, then End).
- **Settings radios (confirmed):** `Image | Video`, `Frames | Ingredients`, `16:9 | 9:16`,
  `360p | 720p`, `4s | 6s | 8s | 10s`, `x1 | x2 | x3 | x4`.
- **reCAPTCHA stays Flow's own**: the upload triggered `recaptcha/enterprise/reload` and `/clr` on
  `www.google.com` — Flow minting its own token when its own control runs. Flow Pilot never touches it.

## Loaded by the page itself (do not touch)

`www.google.com/recaptcha/enterprise.js` and its anchor iframe load on every project page;
Flow mints its own tokens when Generate is clicked. Flow Pilot never calls or wraps them.

## 2026-10-03 — Phase 3 (QC loop): what was verified, and what could not be

Offline only; zero credits, nothing generated, nothing approved.

- The whole QC loop is covered by tests with no browser: the failure policy's every row, the verdict
  for one failure, several at once and none, the automatic `technical` check (a done clip passes;
  a non-done job, a missing media id, missing file, wrong bytes and a drifted recipe fail), the
  record's shape and validation, the append-only consistency block (base hashes byte-identical
  before and after, twice over), the shot store's append, and the service-worker flow end to end
  (record, a free-still fix, a video-only fix, a blocked machine-rejected clip, a plain clip's fix).
- **No live check was run, and none can be honestly claimed.** The practice Chrome on port 9333 is
  reachable and was read with `chrome-devtools-axi` (read-only, nothing clicked): its Flow tab is
  `flow.google.com/project/78d6e0a5-3e82-4491-9f47-6755a6b4c173` and the Flow Pilot dashboard tab
  and its service worker are both alive. `pages` exposes only the Flow tab, so the extension's own
  storage cannot be read through that surface, and the two ways around it are forbidden: navigating
  the work tab (it may be mid-job for another lane) or opening a new tab. The installed extension is
  the primary checkout's build in any case, which has no QC record to read. So the *tracking* claim
  rests on the fixture tests, not on a live record — said plainly rather than dressed up.
- What a future read-only check would need: an extension page exposed to the devtools tool (or a
  helper connected to the practice profile), then a `done` video job's record — `state`, `mediaId`,
  `file.type`, `recipe`, `settings` — to confirm `technicalCheck` reads real records as expected.

## 2026-10-03 — Flow Characters: the read side, the attach, and one paid capture

Wiring Flow's own Characters into Flow Pilot (report `data/flowpilot-flow-characters/report.md`
§8.1 steps 1-5). Flow build seen: `boq_labs-ai-sandbox-frontend_20261002.00_p0`, account
`darkboyy320@gmail.com`, practice project `78d6e0a5-…`. One paid job, 4 credits, exactly once.

### Zero credits first (CDP port 9333, read-only apart from Flow's own controls)

- **The account's characters, through the new parser.** A read-only same-origin `Zzl0ze`
  (`/FlowService.GetProjectContents`) for project `de7baa89-1896-4825-bf06-ab0853619277` returned
  the entity list at JSON index 5 and `parseEntities` decoded it: `nancy`,
  entity id `0bfec740-409e-42f5-80d1-82baac3349f3`, primary media
  `b7df06ca-68ed-46ad-8ce2-b3bf3c08e1ca`, reference workflow
  `e3696fd0-eb73-4b82-a8a2-096fa4cb0dde`. 10 media records in that project; two of them (images
  `010d55ad-…`, `a886589d-…`) already carried a mention segment and an entity reference, so the
  mention/ref readers are proven against data this account really produced, not just the report.
- **The attach, through Flow's own picker.** Clicking `Add ingredients to the prompt box` → the
  `Characters` rail item → the `nancy` tile attached the character. The picker tile's thumbnail and
  the chip's `img.chip-image` are **byte-identical** (both
  `https://lh3.googleusercontent.com/asb/ANqvLOafhQSOKW_4K7Ho0TWJy…`), which is the only identity a
  character chip exposes. On this build the tile click attaches and closes the picker (there is no
  `Add to prompt` to click on that route), exactly as `confirmIfPresent` assumes.
- **Scoping matters.** The page held **three** `flow-character-ingredient-chip` elements and two
  image chips, but only **one** chip was inside the composer's `flow-ingredient-bar`; the others sit
  in hidden page chrome. A document-wide read would have double-counted the attach, so the reader is
  scoped to `flow-prompt-box` › `flow-ingredient-bar` (as the existing media-id read already was).
- **The `@` mention.** A trusted `Input.dispatchKeyEvent({type:'char'})` `@` opens the add-menu
  popover (an untrusted event does not; the recon found the same). The Characters category listed
  **nothing** until the asset picker had been opened once in that session — after that it listed
  `nancy` (twice: the menu renders a duplicate entry). Choosing it inserted a real
  `span.mention-chip`. On this build the chip carries **`data-mention-id` but not
  `data-entity-id`** (the report recorded both), so the reader accepts either.
- **The pre-spend check.** On the live page (character chip + typed mention + Flow's own
  `Generating will use 4 credits` line), `checkBeforeSpend` returned `{ ok: true, problems: [] }`.
  It fails closed, in order, on: a mention naming another entity; no token read off the picker tile;
  no chip in the composer; and Flow marking the mention `mention-chip-invalid`. Each was reproduced
  against the same live snapshot.
- **Frames.** Switching to `Video + Frames` removed the `Add ingredients to the prompt box` button
  (the bar becomes `Start | swap_horiz | End`), so the *chip* route is unavailable. The `@` menu
  still offered `nancy`, but choosing it produced
  `class="mention-chip mention-chip-invalid"` — Flow's own marker that the id will be serialised as
  plain text. So Flow's Frames composer does **not** accept a character; a Frames job with one is
  refused before it is queued rather than silently degraded.

### The one paid job (`recon/raw/generate-1791066780422/`, 4 credits, balance 50 → 46)

360p 4 s, `abra_r2v_4s_360p`, character chip **plus** a typed `@` mention, prompt
`nancy  is in a Formula One car because this is her first time and she's looking kind of scared.`
Flow's own cost line read `Generating will use 4 credits` (≤ 5) and the session cap was raised in
the dashboard to exactly `spent 20 + 4 = 24` first. One click on Flow's own **Start generation**.
No retry; no block (`UNUSUAL_ACTIVITY` or otherwise) appeared. **The balance moved (50 → 46): this
paid run spent exactly what the cost line said.** The 4-credit question is therefore not "did it
spend" but "what did it send"; the capture answers that.

The job took the **`MZZa6b`** route (`/VideoFxService.BatchAsyncGenerateVideoReferenceImages`), not
`YhhmEf` — the Ingredients/reference recipe, as the report predicted for a reference job.

- **The mention's wire slot.** Inside the output message, the prompt travels as a structured content
  list in the same slot a plain job uses for its rich prompt:
  `[[[null,[null,null,["0bfec740-…","nancy"]]],["  is in a Formula One car…"]]]` — i.e. a segment
  whose first element is the mention node `[null, [null, null, [entityId, name]]]` and whose second
  is the text after the chip. So the entity id reaches the server as a **typed mention segment**, and
  the same id is repeated as an **entity-reference list** in the recipe block's last slot
  (`[["0bfec740-…"]]`). This is a *different* shape from the recon's code-read guess: the report
  (§3c) expected field 3 of the mention sub-message; the live request carries it in the prompt
  content list plus the entity-reference list, and it is the `MZZa6b` recipe that does it.
- **Is a chip-only attach recorded?** Not independently, on this evidence. The request carries no
  ingredient list at all (a photo reference job's `[[null, 4, "<mediaId>"]]` is absent), and the only
  character data on the wire is the mention segment and the entity-ref list. The chip contributed no
  reference entry of its own that this one job can be shown to separate from the mention — one spend
  cannot tell whether the entity-ref list would survive without a mention, so a **chip-only,
  no-mention** job remains unverified, and the reader treats both signals as evidence.
- **The stored record.** The generate response already carried the finished record
  (`53a922e2-e516-4984-bc61-f3168a7a672b`): recipe `abra_r2v_4s_360p`, the prompt with the double
  space the mention leaves, the mention segment, and the entity reference. `characterUsed` therefore
  resolves from `Zzl0ze` with no OCR and no guessing, and the Review card can say *verified in the
  generation record*.
- **Two live gaps the paid job exposed, both fixed.** On this record (a video job) the mention
  content list's first element is **null**, and the entity-reference list sits **inside the recipe
  block** — neither matched the readers as first written, so the record read the *workflow title*
  (`Person in Formula One car`) as its prompt and found no entity reference. That would have made a
  character job untrackable (nothing to match by prompt) and unverifiable. Both shapes now read, and
  the real record is the fixture `Zzl0ze-character-video.txt`.

### What is still unverified (stated plainly)

- **The extension's own new attach branch has not run live.** The extension loaded in the practice
  Chrome is the **primary checkout's** build, not this worktree's, so `driver.prepare`'s character
  branch could not execute without reloading the extension other lanes share. The live attach above
  was performed with the *same clicks* (`Add ingredients` → `Characters` → tile) through the page,
  and the check that decides the spend is this worktree's code — the driver branch itself rests on
  the unit tests and the shared-contract smoke test.
- **Frames on the wire.** The composer evidence above is decisive for Flow's own UI; whether a Frames
  recipe would accept an entity mention at all needs another spend, which was not approved.
- **The multi-character cap.** Flow's own message exists (`Maximum character ingredients reached`)
  but its number is unknown; Flow Pilot fails closed at three, its own conservative limit.
- **A chip-only job.** See above: whether a character attached *only* as a chip (no `@` mention) is
  recorded on the generation is still unverified. The QC reader accepts either signal.

### Housekeeping

- One work tab throughout; no tab was opened, closed or reloaded over a job. The tab was moved to
  `de7baa89-…` by URL for the attach and back to `78d6e0a5-…` afterwards, composer empty, no
  overlays, `Video · Ingredients · 16:9 · 360p · 4s · x1`.
- Session cap: raised in the dashboard to exactly 24 (spent 20 + the 4-credit cost) before the click,
  then **put back to 20**, the value the captain left. The extension's own `spent` counter still reads
  20 because the click was made outside it (it had to be: the mention must be typed by a person);
  the account's real balance is 46, four credits lower than the extension believes.
- Balance before/after read with the read-only `nzlxg`: **50 → 46**.
- No helper was started or stopped; `recon/capture.mjs --generate` recorded the job and is not
  running. `/tmp` probe scripts are deleted after this entry.

## 2026-10-03 — the still gate: the settings chip, the picker's labels, and Flow's own click gate

Fixing the three blockers the end-to-end test found (`data/flowpilot-e2e-test/report.md` §4, §5, §10).
Flow build seen: `boq_labs-ai-sandbox-frontend_20261002.00_p0` (`window.WIZ_global_data.cfb2h`, and the
same `bl=` in the page's own batchexecute URLs), account `darkboyy320@gmail.com`, practice Chrome on
CDP port **9333**, project `de7baa89-…`. **One still was generated, at 0 credits** (the cost line was
read first); nothing else was submitted, no video was approved or clicked, and every other experiment
below ran behind a request firewall that failed every non-read-only request inside the browser, so no
generate reached Google (probes: `recon/raw/live-*.mjs`, gitignored).

### The settings chip, read off the trigger itself (read-only, 0 credits)

The driver reads the Settings trigger's own `textContent`; the live chips are:

| mode | chip text (raw `textContent`) | cost line |
|---|---|---|
| Video | ` Video · 360p · 4s crop_16_9 x1 ` | `Generating will use 4 credits` |
| Image | ` 🍌 Nano Banana 2 crop_16_9 x1 ` | `Generating will use 0 credits` |
| Image, other aspects | ` 🍌 Nano Banana 2 crop_landscape x1 ` (4:3), `… crop_square x1 ` (1:1), `… crop_portrait x1 ` (3:4), `… crop_9_16 x1 ` | `0 credits` |
| Image, count | ` 🍌 Nano Banana 2 crop_16_9 x2 ` | `0 credits` |

So **Image mode writes the image model's name where a video chip writes the word `Video`**: there is no
kind word to read at all, and the old fixture `Image · crop_16_9 x1` was a string this page never
produces. With the panel open the mode radios are the authority (`Image`/`Video` checked state), and an
image chip is also the only chip with a crop and a count and **neither** a resolution nor a duration —
which is what `extension/lib/preflight.js` now uses, in that order, still failing closed on a chip that
reads as none of them. Only `crop_16_9`/`crop_9_16` become an aspect (Flow Pilot builds 16:9 and 9:16
only); `crop_landscape`/`crop_square`/`crop_portrait` stay null, so a job can never be submitted
against an aspect the parser guessed at.

### The picker's tile labels are the workflow titles (read-only + one attach, 0 credits)

Read-only `Zzl0ze` for the project, and the picker's own labels with the picker open (`live-picker.mjs`,
`live-media.mjs`). The project holds 12 media; the picker's `All` list read:

`Person standing on rooftop balcony` (video) · `Person in Formula One car` (video) ·
`Driver navigating Formula One race` (video) · `Woman driving Formula One car` (video **and** two
images) · `Woman in racing outfit posing` (image) · `Woman holding Formula One helmet` (image ×3) ·
`nancy` (Character) · `Upload media` · `Add to prompt`

Every one of those is the **workflow title**, never the prompt the record keeps: media
`b7df06ca-…` stores the prompt `So I would like to create an image of an African female …` and its tile
reads `Woman in racing outfit posing`. Three media share one title, and two of them share a title *and*
a prompt (the same still generated twice, 65 s apart) — so a label alone can never identify a media,
which is why the driver refuses an ambiguous label and the id read back off the composer stays the last
word before a click. `referenceNames` therefore returns the labels to try in order: the workflow title
first, the prompt as the fallback (an upload lands under its file name, which is also its prompt).

Proof the route works end to end (0 credits, one attach, no Generate):

- one still generated from `a brass compass on a weathered wooden table, soft window light` after the
  cost line read `Generating will use 0 credits`; Flow titled it `Brass compass on wooden table`
- a Frames video job was prepared with that still as its first frame; the driver attached it by the
  title and the composer **read back the still's own media id** (`b1241524-…`) as the first frame
- the old prompt-based matcher would have looked for `a brass compass on a weathered wooden table, soft
  window light`, a label no tile in that project shows — which is exactly the timeout the e2e test hit

### Closing the picker (0 credits)

The Frames picker is `flow-add-menu-popover-content` and carries its **own `Close` control**
(`mat-icon-button`, `aria-label="Close"`); clicking it closed the picker where a backdrop click did
nothing. The Ingredients picker has no close control at all and is dismissed by the composer's own
`Add ingredients` button. Reproduced twice: a failed attach with the picker left open made the *next*
`prepare` fail with `Settings trigger is not clickable` (a backdrop covered it); with the fix, the
failed attach closed the picker, the trigger stayed clickable, and the next `prepare` ran.

### NEW: Flow's Image-mode Generate ignores synthetic clicks (read-only + firewalled clicks)

Not a Flow Pilot bug, and the reason the extension cannot finish a still by its own click today.
Firewalled
experiments (`live-click-firewall.mjs`, `live-click-video.mjs`, `live-click-why.mjs`,
`live-click-commit.mjs`) prepared a real job in each mode with the worktree driver and watched whether
Flow's own handler ran (its first act is to have Flow mint its own reCAPTCHA token):

| mode | `button.click()` | pointer/mouse sequence | focus/blur then click | real (CDP) pointer click |
|---|---|---|---|---|
| Video | **handler runs** (`YhhmEf` attempted) | — | — | handler runs |
| Image | nothing | nothing | nothing | **handler runs** (`ogiZ0b` attempted) |

The button's markup is identical in both modes (`<button type="submit" aria-label="Start generation">`
inside `flow-generate-icon-button`), and the guard is in Flow's own bundle:

```
submit(a){this.Te()||this.ma.oa&&this.Ua.we.Xfa()&&(a==null||!a.isTrusted)||(Alb(...),this.eh.emit(a),...)}
```

`(a == null || !a.isTrusted)` — Flow runs the generate only for a trusted event in that mode. A content
script cannot mint one. So a still has to be started by a person's click (or by a route the owner
chooses; that is a product decision, not a patch here). `extension/lib/compat.js` and the README say so
rather than pretending. What *is* proven: the composer is prepared and verified (prompt verbatim, Image
mode, cost line 0, all pre-spend checks pass), and a real click at 0 credits generates the still.

### NEW: a leftover attachment wedges the next Frames prepare

A composer that still holds a frame does not offer the `Start` slot any more, so the next Frames
`prepare` fails with `The Start frame slot is not clickable`. It happened here for real: after a
prepare whose attach had succeeded, the following rehearsal prepare hit it. Same user-visible symptom
as the picker wedge above, different cause (debris in the composer, not an overlay), and not fixed in
this change — it needs its own decision (clear leftovers at prepare time, which the composer's chips
do offer via their own `cancel` control). Worth an issue: after a job fails *after* attaching, the tab
is left wedged for the next job.

### Housekeeping

- One work tab throughout; no tab opened, closed or reloaded; the composer was left with `Video ·
  360p · 4s crop_16_9 x1`, no attachments and the picker closed. The e2e lane's own leftovers (a
  character chip and its prompt) were detached with Flow's own chip controls.
- Credits: the still's cost line read **0 credits** before the click and the account's own balance
  (`nzlxg`) read **42** after the run; the only media created in this project during the session is
  that one image (`b1241524-…`), and the extension's own session counter is unchanged at `24 / 24`
  (the day's balance read 46 in the e2e report, so the other 4 credits were spent outside this
  session and outside this project; nothing here approved or clicked a video).
- Firewalls were disabled and every probe's injected world left behind; probe scripts live in
  `recon/raw/` (gitignored) with their logs (`live-still-gate.log`, `live-attach.log`).

### The still run end to end, from the re-test (2026-10-03 late, 0 credits)

The end-to-end re-test (`data/flowpilot-e2e-retest/report.md` §4c) closed the gap the section above
left open, with a gesture a content script cannot mint. The extension prepared the composer (prompt
verbatim, Image mode, `🍌 Nano Banana 2 crop_16_9 x1`, the 0-credit cost line read first) and wrote
the write-ahead click; a **real CDP pointer click** (`Input.dispatchMouseEvent`,
`mousePressed`+`mouseReleased`, so `event.isTrusted === true`) on Flow's own **Start generation**
started it. From there the extension did the whole run: `submitted → rendering → downloading →
done`, media id `72b2d6a5-8285-4189-9c24-90e03be0440b`, saved to
`~/Downloads/FlowPilot/de7baa89-…/shot_1_rooftop-still.jpg`. The file is byte-checked against Flow's
own CDN — 809 742 bytes and JPEG magic `ffd8ffe0` — and the browser's own `chrome.downloads` record
agrees (`mime: image/jpeg`, `state: complete`, the same byte count).

**An image run finished through the extension** — a still job, 0 credits, 2026-10-03. What stays
out of reach is the unattended version: Flow's Image-mode submit ignores a synthetic click (above),
so a person's gesture (or a real pointer click) still presses Start. `extension/lib/compat.js`
draws its image-run line from this paragraph, and a test keeps the two in step.
