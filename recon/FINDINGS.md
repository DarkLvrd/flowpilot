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
