# Flow Pilot

Flow Pilot is a Chromium extension plus a small local helper that queues image and video jobs in
[Google Flow](https://flow.google.com) for **one signed-in Google account**, driven by a person or
by any agent. The extension does all the work inside the Flow tab you point it at — it never mints
captcha tokens, never rewrites headers, never touches your cookies or auth tokens, and never opens,
reloads or closes tabs on its own. People drive it from a dashboard and a toolbar popup; agents
drive it through the helper's CLI, MCP server and local HTTP API. The extension works fully without
the helper; the helper only adds agent access and writes files to absolute paths.

See [`docs/SPEC.md`](docs/SPEC.md) for the settled decisions and hard rules, and
[`docs/LESSONS.md`](docs/LESSONS.md) for the past failures those rules answer.

## 2-minute setup

1. **Load the extension.** In a Chromium browser (Chrome, Arc, any Chromium ≥ 120), open the
   extensions page, turn on Developer mode, and **Load unpacked** → pick the `extension/` folder.
   There is no build step.
2. **Open Google Flow.** Go to <https://flow.google.com>, sign into the account you want to drive,
   and open a project. Bring that tab to the front, then click the Flow Pilot toolbar icon and
   press **Use this tab as the work tab**. (Flow only re-renders in the front tab, so jobs are
   prepared and submitted with the work tab in front — see LESSONS #23. If approved jobs are
   waiting for that, the popup and dashboard show it and a **Show the Flow tab** button brings the
   tab forward.)
3. **Start the helper** (only needed for CLI agents; the MCP server starts one itself — see
   **Use it from Claude Desktop**). From the repo:

   ```
   node helper/bin/flowpilot.js serve
   ```

   or, from inside the repo, `npx flowpilot serve`. It listens on `http://127.0.0.1:47615` and
   waits for the extension to connect (within ~30 s).
4. **Check the setup:**

   ```
   node helper/bin/flowpilot.js doctor
   ```

   `doctor` reports Node version, helper running, extension connected, the pinned extension id,
   whether you are paired, the work tab, the credit cap, and the halt state — each with a ✅/❌ and
   a hint for anything missing.
5. **Pair an agent.** Open the dashboard (from the popup's **Open dashboard** button), click
   **Pair an agent** to get a one-time code, then run `flowpilot pair <code>` (see below).

## How people use it

Everything for people lives in the **dashboard** (its own tab) and the **toolbar popup** — nothing
is overlaid on Flow's own page.

- **Popup** — shows status and self-check results, lets you set the current tab as the work tab,
  and opens the dashboard.
- **Dashboard** — the **Flow health** screen, an **Agents** section with the **Pair an agent**
  button, the **Session credit cap** (set or raise it here; nothing is submitted past it), a **Batch
  / storyboard import** section, an **Add a job** form (name, prompt, **Preview first**, kind
  image/video, resolution, duration, aspect, count, and references — Ingredients or Frames, below),
  the **Entities** panel (the consistency library, below), the **Shots** panel, the **Review** panel
  (the QC loop on finished clips, below) and the **Queue** table.
- **Entities** — the per-project consistency library: drop in a photo or paste a locked Flow media
  id, give the subject a name and a description, and **Approve** it. Every job whose prompt was
  composed from the library then shows "Uses: Rudy" and a **Preview prompt** button with the exact
  text Flow will receive. See [Consistency](#consistency-characters-vehicles-and-locations).
- **Shots (still first, video second)** — import a shot list in the **Shots** panel (or
  `flowpilot shots import`). Each row gets one **free** still image job and nothing else, so no
  credits can move for a shot you have not seen. When the still finishes it appears in the row;
  press **Approve still** to record who approved it and when — that is the click that *creates* the
  shot's video job, with its price shown before you press anything. The video's own approve button
  stays disabled until then, and approving the video is what would spend (still inside the session
  cap). **Queue a new still** supersedes the old approval first, so an approved still is never
  silently replaced and a regenerated one is visibly new. See
  [Consistency](#consistency-characters-vehicles-and-locations).
- **Review (the QC loop)** — each finished clip gets a card in the **Review** panel: six checks,
  with `technical` already ticked from the job and the other five waiting for you (pass/fail picks +
  a note). **Record verdict** writes the design's QC record on the job — metadata only, nothing
  spends. Every failure then gets a **Fix** button naming the action and its cost: a still fix
  queues a free still (which supersedes the approval, so the video follows only after you approve
  it), a video-only fix queues a new video from the still that is already approved. Nothing
  regenerates on its own, no base prompt or approved still is rewritten, and the failed take stays
  on disk. See [Consistency](#consistency-characters-vehicles-and-locations) and `flowpilot qc`.
- **Approvals** — each queued job shows an **Approve** button; jobs wait as `queued` until approved,
  then run from the work tab. Queued/approved/halted jobs can be **Cancel**led; a failed job that
  was never clicked can be **Re-queue**d, and one whose render finished can **Retry download**.
- **Preview first (free still, then video)** — tick **Preview first** in the **Add a job** form and
  Flow Pilot queues the scene as a **free still** (Nano Banana images cost 0 credits) plus a video
  job held as `awaiting-preview`. The still runs as an ordinary image job and spends nothing. When
  it finishes, the video's row offers one button, **Approve still → run video (N credits)** — the
  video's price is shown before you click it. That click attaches the still as the video's first
  frame through the ordinary **Frames** path and lets it run. A held video can never be approved or
  submitted before that, and only the dashboard can promote one, so the look is approved before any
  credits are spent.
- **A still may need your own click on today's Flow build.** Flow only runs an Image-mode
  generation when the click is a real user gesture — its own submit path checks `event.isTrusted`
  (live 2026-10-03, `boq_labs-ai-sandbox-frontend_20261002.00_p0`). Flow Pilot prepares the composer
  fully (prompt verbatim, Image mode, 0-credit cost line read first), but a click it makes itself is
  ignored there, so a still has to be started with Flow's own **Start generation** button by hand
  until this is decided. Video jobs are unaffected: Flow accepts Flow Pilot's click in those modes.
  The dashboard's **Flow compatibility** note and `recon/FINDINGS.md` say exactly what was proven.
- **Describe it once** — the **Describe it once → scene prompts** button (popup or dashboard) opens a
  page that turns one plain sentence into a set of scene prompts (wide establishing shot → medium →
  close-up → over-the-shoulder → low-angle → tracking) from a documented template, entirely
  offline. Each prompt is editable text with its own **Copy** button and a **Copy all prompts**
  button; paste the ones you like into the dashboard's prompt box or `flowpilot add --prompt`.
- **Keep the Flow tab in front** — Flow only re-renders in the front/visible tab (LESSONS #23), so
  jobs are submitted only while the work tab is in front. When approved jobs are waiting for it the
  popup and dashboard say so with the exact count — **"3 jobs waiting: keep the Flow tab in front
  while jobs submit."** — plus a **Show the Flow tab** button; bringing the tab forward resumes
  submission on its own. The extension never switches tabs by itself.
- **Flow health** — the popup and dashboard show the self-check as plain-language lines, one per
  check, and say where to look when a job fails with **"Flow changed"**: re-capture read-only with
  `node recon/capture.mjs --port 9333`, update `recon/FINDINGS.md`, and check the RPC ids in
  `extension/lib/rpc.js`.
- **Credit cap** — cost is shown per job before it runs, and the session cap is a hard ceiling.
  **Only the dashboard can set or raise the cap** — agents cannot.
- **Flow compatibility and diagnostics** — the dashboard shows a dated line saying which Flow build
  Flow Pilot was last *proven* against, with one click to read what has been proven, what Flow has
  changed since, what is known broken, and what has never been tested. **Save diagnostics file**
  writes one local text file for support: the version, the Flow build, the self-check with its
  failing steps, the last halt in Flow's own words, and recent job states. It contains no cookies,
  no tokens, no `Authorization` headers, no prompt text and no file paths, and Flow Pilot never
  uploads it. The note is updated in the weekly loop, so its date is real.
- **Spend-and-safety receipt** — press **Save receipt file** and Flow Pilot writes one local Markdown
  file for the batch or session: every row and its exact charge (a charge is only ever a Generate
  click it recorded, never a quote), the cap that was in force, everything that was never submitted
  or that Flow Pilot cannot prove was charged, each halt in Flow's own words, and where each file
  landed. Prompt text stays out unless you tick **include prompt text** (a short prompt fingerprint
  is always there). It is built from Flow Pilot's own records and is never uploaded — keep it, send
  it, or delete it.
- **Halts and cool-down** — any `UNUSUAL_ACTIVITY` (or similar block) stops the whole queue and
  shows a panel with the exact wording Flow Pilot got, what to check in Flow, how long to wait
  (about an hour; 30 minutes is the shortest wait the published field data ever saw work), and a
  **Resume** button. **Resume runs only the rows that were never submitted**, in their original
  order, under the same cap, each behind a fresh pre-spend check; a row that already reached Flow is
  never submitted again and keeps its result. Nothing is submitted after a halt until you press
  Resume yourself — time passing does nothing, and there is no automatic retry anywhere.

Storyboard import (JSON/CSV bulk queueing) and the folder picker are built (SPEC decisions 3 and
5): the dashboard now adds jobs one at a time *or* a whole batch at once. A **shot list** is the
consistency-aware sibling of that import — it queues a free still per shot and creates each video
only after its still is approved; see
[Consistency](#consistency-characters-vehicles-and-locations) and the **Shots** panel in the
dashboard.

### Batch / storyboard import

Fill the queue from a storyboard instead of typing jobs one at a time. Drop a `.json` or `.csv`
file, choose one, or paste a list; **Preview batch** validates and prices every row *before*
anything is queued, and **Import** queues the whole batch — or refuses all of it and lists the bad
rows by number, so a partial import can never happen. **Approve all queued** approves the batch in
one click.

A JSON storyboard is an array of rows (or `{ "scenes": [ … ] }`); a CSV needs a header row and a
`prompt` (or `scene`) column. Row fields, with common aliases:

| field | aliases | notes |
|---|---|---|
| `scene` | `shot` | the row's label; used by the naming template |
| `prompt` | `text` | required |
| `kind` | `type` | `video` (default) or `image` |
| `mode` | `input` | `text`, `ingredients` (with `refs`) or `frames` (with `firstFrame`) |
| `resolution` | `res` | `360p` or `720p` |
| `duration` | `durationS` | `4`, `6`, `8` or `10` (seconds) |
| `aspect` | `ratio` | `16:9` or `9:16` |
| `count` | `n` | `1`–`4` |
| `refs` | `references`, `ingredients` | Ingredients: media ids or absolute image paths, separated by `\|`, `;` or a newline |
| `firstFrame` / `lastFrame` | `startFrame` / `endFrame` | Frames: one media id or absolute image path each |
| `outputPath` | `output`, `path` | an absolute path for the helper to write |
| `name` | `title` | the job's label (defaults to the scene) |
| `model` | | image model (`nano-banana-pro` for Nano Banana Pro) |

```
scene,prompt,kind,resolution,duration,count
opening,"a red fox trots through snow",video,360p,4,1
closing,"the same fox curls up and sleeps",video,360p,8,2
```

### Output naming, folder picker and presets

- **Name template** — file names come from a documented token pattern, default
  `{project}/{scene}-{index}`. Tokens: `{project}`, `{scene}`, `{index}` (zero-padded to the batch
  width), `{name}` and `{prompt}`. Finished files land under `Downloads/FlowPilot/` unless you pick
  a folder, and an existing file is never overwritten (a collision becomes `-2`, `-3`, …).
- **Output folder** — **Choose folder** grants a folder for this session through the browser's File
  System Access API and writes finished files there; without it, or if the permission lapses, files
  go to the browser's `Downloads/FlowPilot`. With the helper, a job's absolute `outputPath` still
  writes anywhere.
- **Presets** — save the current Add-a-job settings (kind, resolution, duration, aspect, count, the
  name template and a default reference set) under a name, then pick that preset on the import
  section to repeat a batch without re-entering anything. Saving and deleting presets is
  dashboard-only, like the credit cap; agents may read and use them.

## Consistency: characters, vehicles and locations

Flow drifts on faces, cars and places across clips. Flow Pilot answers that with a per-project
**entity library** plus a **prompt composer** that inserts each subject's canonical text block
verbatim, and a **preview** that shows the exact text Flow will receive before any credit moves.
This is Phase 1 of the design: it needs no browser interaction and cannot spend credits.

- **An entity** is a character, product, vehicle, location or the project's one **style** entity.
  It carries a name, a description, optional negatives, and its **locked reference media ids** with a
  unique label each. A reference is always a Flow media id, never a path: a path would be re-uploaded
  as a new media id every time, which makes a *new* subject rather than a locked one. A photo dropped
  into the panel is recorded as *provenance* (name + sha256) only. Entities are **per Flow project**,
  because media ids are; a character used in two projects needs two libraries.
- **Nothing is edited in place.** Changing a reference, the description or the negatives creates a
  **new version** and moves the old set into the entity's history with the reason, so any clip can be
  traced to the reference set that produced it and a removed approval is visible, not silent.
- **Approval gates use.** Only an approved entity can be composed into a job; an unknown, ambiguous
  or unapproved name fails the job before anything is queued.
- **The composer** writes the prompt in the design's fixed order — the base text (verbatim), one
  block per entity (`CHARACTER — RUDY (identical in every shot): …`), the project style lock
  (verbatim, from pixar-studio's `style_lock.md`), the audio line and one merged `Negative:` line
  (the template's negatives + every entity's + the style lock's, deduplicated). Every part carries a
  `sha256`, and the sections 1-10 hash stays frozen so a QC fix can be appended later without
  rewriting the base.
- **The preview is that same text:** `Preview prompt` on a queued job, `flowpilot prompts <jobId>`,
  or `flowpilot compose` for a composition that was never queued. Looking never spends.
- **The library is mirrored** to `~/.flowpilot/projects/<projectId>/entities.json` through the helper
  whenever it changes, so a browser reinstall does not lose it, and `flowpilot entity export|import|
  restore` moves it in and out of a file.
- **Naming an entity in a job carries it, not just its text.** A job that names a library entity
  composes its block and records the entity; when that entity is a **linked Flow Character** the job
  also carries **Flow's own entity id**, so Flow's picker attaches it and the pre-spend check
  verifies it (`flowpilot add --entity`, the MCP `entities` list, and a shot row all take the same
  path). A job whose mode cannot carry a chip (Frames, and the Frames still preview) is **refused
  with the reason** instead of sending a prompt that names a subject the composer never attached.
- **Where the canonical text comes from.** `extension/assets/prompts/` holds byte-verbatim copies of
  `/Users/mac/pixar-studio/prompts/{style_lock,scene_template,camera_moves,animation_principles}.md`.
  They are user-editable data: the style lock becomes the project's style entity, the scene template
  gives the section order, and the camera and motion tables become the libraries the composer draws
  on. The test suite pins their sha256, so a paraphrase fails the build.
- **Shots and the still gate (Phase 2).** A **shot** is the unit of consistency: its scene text, its
  subjects, and one reference plan. A shot is either **anchored** (`mode: frames` — its approved
  still is the video's first frame) or **referenced** (`mode: ingredients` — up to three entity
  photos carry identity), never both. With more than three in-frame subjects the composed still is
  the merge point, and the plan says so. A video job for a shot is **never created** until its still
  is approved, so there is no blocked job to clear and no credits can be priced around a frame
  nobody looked at; approving a still *is* the action that builds the video job, and its price is
  shown first. Image jobs now take Ingredients references too, so a still can be generated from the
  same locked photos a video would use.
- **A shot list in, stills out.** `flowpilot shots import --project P --file shots.json` (or the
  Shots panel's import box) reads the design's storyboard rows — JSON or dotted CSV — resolves
  `entities` by name against the library, and queues one free still per shot. Unknown names fail the
  whole import; an unapproved entity is a warning and is left out. `flowpilot shots list` shows each
  shot with its gate and the video cost; `flowpilot still <shotId>` (re)queues a still; `flowpilot
  anchor <shotId> [--media <id>]` approves a finished still and creates the video job.
- **The QC loop (Phase 3).** Every finished clip can be reviewed on six checks: `technical` (bytes,
  duration bucket, resolution, aspect, non-empty, recipe vs settings) is **automatic**, read from the
  job; `identity`, `wardrobe`, `location`, `artefacts` and `style` need eyes. Flow Pilot never
  auto-approves or auto-fails a clip on a machine score: it **surfaces** the checks, **records** the
  verdict and **offers** the fix. The verdict is the design's record — `checkedAt`, `by` (human or
  agent), the six `checks`, the `verdict` and the `note`, plus `characterUsed` when the job ran with
  a Flow Character — written as job metadata exactly like a job's references: no state change, no
  click, no spend.
- **A fix is a click that appends, never a rewrite.** Every failure maps to one action in the
  design's table, shown with its cost before you take it: a still fix (`identity`, `wardrobe`,
  `location`) queues a **free still** — which supersedes the old approval, so the video comes only
  after you approve the new one — and a video-only fix (`artefacts`, `style`) queues a **new video**
  from the still that is already approved. `technical` offers nothing: that job failed its own byte
  check before it was done. Nothing regenerates on its own, an approved still and an existing output
  file are never overwritten, and the failed take stays on disk. The fix itself is an **appended
  consistency block** (the studio's `car_consistency_block` pattern, and why the reviewer's note
  becomes the block's text): sections 1-10 keep their hashes byte-identically, which is what makes a
  fix auditable.
- **Where you review it:** the dashboard's **Review** panel (one card per finished clip: the six
  ticks, the verdict, the note, and a **Fix** button per recorded failure), `flowpilot qc <jobId>`
  to read or record a verdict, and `flowpilot qc <jobId> --fix <check>` to take one.
- **Flow's own Characters.** Flow holds *characters* for a project (its Characters tile: an entity
  with an id, a face image and its own reference workflows). Flow Pilot reads that list —
  `flowpilot characters`, the HTTP `/characters` route, `flowpilot_characters` over MCP, or the
  dashboard's **Entities** panel — and an entity can carry the link:
  `flowCharacter: { name, entityId, primaryMediaId, referenceWorkflowIds }`. The entity id is what
  makes it verifiable (a name alone is not), and a linked character needs **no locked photo**: Flow
  holds the face, the prompt names it and Flow's own picker attaches it. Approving it is still
  required, like any other subject. `flowCharacter` is a link, not a locked reference: the primary
  image is Flow's, not an Ingredients tile, which is why it lives beside `refs` instead of in them.
- **A character is attached through the picker Flow Pilot already drives.** A character job is an
  **Ingredients** job (`abra_r2v_*`), even with no photo reference at all, and the character chip is
  attached by clicking the picker's **Characters** category and the tile, exactly as a photo is.
  Before spending, `character-attached` verifies it two ways: the composer's
  `flow-character-ingredient-chip` thumbnail must be byte-identical to the picker tile the driver
  picked, and every `@name` mention in the prompt must name that same entity id and not be
  `mention-chip-invalid` (Flow's own "I will send this as plain text" marker). Anything else fails
  the job closed rather than spending on a clip that never used the character.
- **A Frames job refuses a character.** In Frames Flow replaces the ingredient bar with the Start
  and End slots, so there is no chip to attach — verified live 2026-10-03: picking a character from
  the `@` menu in Frames yields `mention-chip-invalid` and would be sent as text. Instead of a
  silent drop, the job is refused with the reason and the way out (use `mode: ingredients`).
- **The QC card says whether the character was really used.** Flow echoes the character back in the
  same project-contents response Flow Pilot already reads — a mention segment plus an entity
  reference — so a finished job records `characterUsed: { entityId, name }` (or `null` when Flow did
  not confirm it), and the Review card prints *verified in the generation record* instead of guessing
  from the picture. The person still makes the verdict: this is evidence, not a machine score.

## How agents use it

Any agent (Pi, firstmate, Claude, others) drives Flow Pilot through the helper. First pair once:
click **Pair an agent** in the dashboard and run `flowpilot pair <code>`. The key is saved
owner-only in `~/.flowpilot/key`; only jobs and results cross the bridge — never cookies or tokens.

### CLI

```
flowpilot serve [--forget-extension]   Run the helper (--forget-extension re-pins the extension)
flowpilot pair <code> [--name N]       Pair this machine with the dashboard's one-time code
flowpilot status                       Credits, work tab and the queue
flowpilot job <id>                     One job
flowpilot add --prompt TEXT [--name N] [--kind video|image] [--resolution 360p|720p]
             [--duration 4|6|8|10] [--aspect 16:9|9:16] [--count 1-4]
             [--project ID] [--out /abs/path.mp4]
             [--ref REF ...] [--first-frame REF] [--last-frame REF] [--entity NAME ...]
flowpilot approve|cancel|requeue|retry-download <id>
flowpilot entity add --project P --kind character --name Rudy --desc-file block.txt
             [--negative-file neg.txt] [--alias A ...]
             [--ref <mediaId> ...] [--source-photo /abs/photo.jpg]
flowpilot entity list|show --project P [--name Rudy]
flowpilot entity set --project P --name Rudy [--desc-file f] [--negative-file f]
flowpilot entity approve|unapprove --project P --name Rudy [--reason R]
flowpilot entity ref --project P --name Rudy --ref <mediaId> [--role sheet] [--label rudy_sheet_v1]
flowpilot entity supersede --project P --name Rudy --ref <mediaId> --reason "flat bronze"
flowpilot entity remove|style --project P [--name Rudy]
flowpilot characters [--project P]      The project's own Flow Characters (read-only, no credits):
                                       the name, entity id and media id a flowCharacter link needs
flowpilot entity export|import --project P [--file lib.json] [--replace] | entity restore --project P
flowpilot shots import --project P --file shots.json|.csv
             One free still per row; approving a still creates the shot's video job
flowpilot shots list --project P       Each shot, its still gate and the video's cost
flowpilot still <shotId> [--project P] (Re)queue the shot's still image job (0 credits today)
flowpilot anchor <shotId> [--media MEDIA_ID] [--frame start|end] [--note TEXT] [--project P]
                                       Approve the still and create the video job (queued, not run)
flowpilot qc <jobId> [--identity pass|fail ...] [--note TEXT] [--fix CHECK]
                                       Review a finished clip: print its verdict and the fixes it
                                       offers (with their cost), record a verdict with all five
                                       visible checks (technical is automatic), or take one fix —
                                       which queues the next job and never rewrites the base prompt
flowpilot prompts <jobId>              the composed prompt parts and hashes (dry run)
flowpilot compose --prompt TEXT [--entity NAME ...] [--project P] [--audio A]
flowpilot doctor                       Check the setup
flowpilot install-claude [--config PATH]
                                       Add the MCP server to Claude Desktop (backup first)
flowpilot mcp                          Run as an MCP server on stdio (starts the helper if needed)
```

Add `--json` to any command for raw JSON. The credit cap, clearing a halt and choosing the work
tab are dashboard-only. (Invoke as `node helper/bin/flowpilot.js <command>` if `flowpilot` is not
on your `PATH`.)

**References (face-matched character work).** A job may carry reference photos, each a Flow media id
or an absolute image path (`.png`/`.jpg`/`.webp`); the helper reads a path's bytes and Flow Pilot
uploads it through Flow's own **Upload media** control, never sending cookies or tokens.
**Ingredients** shape the whole generation — `--ref` (repeat for up to three) makes a
reference-to-*video* generation for a video job and a reference-to-*image* one for a still
(`--kind image`), so an approved still can carry a character's identity forward. **Frames**
generate a video between a start and end photo — `--first-frame` (and an optional `--last-frame`).
Before it spends, Flow Pilot checks the right references are attached, verified by media id; the
picker finds each reference by the label Flow itself shows it under — the workflow title Flow gave a
generated media, or an upload's file name — and refuses a label that matches several tiles rather
than attach one of them. A failed attach closes the picker it opened, so it cannot wedge the next
job. Example:

```
flowpilot add --prompt "she turns to face the camera" --ref /Users/me/face.png --resolution 360p --duration 4
flowpilot add --prompt "she waits by the car" --entity Rudy --entity Hellcat --resolution 360p --duration 4
flowpilot add --prompt "a slow zoom in" --first-frame /Users/me/wide.png --last-frame /Users/me/close.png
```

### MCP server

`flowpilot_add_job` also takes `refs` (1-3 Ingredients reference photos), `firstFrame` and
`lastFrame` (Frames), each a Flow media id or an absolute image path — the same face-matched
character work as the CLI above.

`flowpilot mcp` runs an MCP server on stdio with seventeen tools: `flowpilot_status`, `flowpilot_job`,
`flowpilot_add_job` (which also takes `entities` — approved names from the project library, composed
into the prompt verbatim), `flowpilot_approve`, `flowpilot_cancel`, `flowpilot_requeue`,
`flowpilot_retry_download`, `flowpilot_entity_list`, `flowpilot_entity_upsert`,
`flowpilot_entity_approve` (with `approve: false` to un-approve), `flowpilot_entity_supersede`,
`flowpilot_characters` (the project's own Flow Characters, read-only),
`flowpilot_compose_prompt` (the exact text Flow will receive, with per-part hashes),
`flowpilot_shots` (each shot, its still gate and the video's cost), `flowpilot_import_shots` (queues
one free still per row, never a video), `flowpilot_anchor_still` (approve a finished still and
create its video job) and `flowpilot_review` (read a finished clip's QC record with the fixes it
offers and their cost, record a verdict with the five visible checks, or take one fix with
`fix: "<check>"`). There is nothing for the cap, the halt or the work tab — those stay with the
person in the dashboard.

You do not have to start the helper first: on the first tool call the MCP server starts a helper of
its own if none is listening, and stops only that one when it exits. A helper you started with
`flowpilot serve` is reused and left alone. See **Use it from Claude Desktop** below.

### HTTP API

The helper listens on `http://127.0.0.1:47615` only. All calls except `/health` and `/pair` need
`Authorization: Bearer <pairing key>`. Requests carrying a browser `Origin`, or a non-localhost
`Host`, are refused.

| Method | Path | What |
|--------|------|------|
| `GET`  | `/health` | `{ ok, extension }` — no key needed |
| `POST` | `/pair` | `{ code, name }` → `{ key }` — redeem a one-time code |
| `GET`  | `/status` | session cap and spend, halt, work tab, jobs |
| `POST` | `/jobs` | `{ spec }` — queue a job (`spec.entities` composes the library's blocks in) |
| `GET`  | `/jobs/<id>` | one job |
| `POST` | `/jobs/<id>/approve` \| `/cancel` \| `/requeue` \| `/retry-download` | act on a job |
| `GET`  | `/entities?projectId=` | the project's entity library, template and warnings |
| `GET`  | `/characters?projectId=` | the project's own Flow Characters (read-only, no credits) |
| `POST` | `/entities` | `{ projectId, entity }` — create or version an entity |
| `GET`  | `/entities/export?projectId=` | the library as JSON |
| `POST` | `/entities/approve` \| `/unapprove` \| `/ref` \| `/supersede` \| `/remove` \| `/style` \| `/import` \| `/restore` | act on the library |
| `POST` | `/prompts` | `{ projectId, spec }` — compose the exact prompt and part hashes (no spend) |
| `GET`  | `/shots?projectId=` | the project's shots with their still gate, jobs and video cost |
| `POST` | `/shots/import` | `{ projectId, text, filename }` — plan and queue one free still per row |
| `POST` | `/shots/still` | `{ projectId, shotId }` — (re)queue a shot's still image job |
| `POST` | `/shots/anchor` | `{ projectId, shotId, mediaId?, frame?, note? }` — approve the still, create the video job |
| `POST` | `/jobs/<id>/qc` | `{ checks, note? }` — record a QC verdict on a finished clip (technical is computed by the extension) |
| `POST` | `/jobs/<id>/qc-fix` | `{ check }` — queue the fix for one recorded failure (a free still, or a new video) |

`FLOWPILOT_HOME` overrides `~/.flowpilot`; `FLOWPILOT_PORT` overrides the port.

## Use it from Claude Desktop

[Claude Desktop](https://claude.ai/download) can drive Flow Pilot with its tools, so you ask for a
job in plain English and Claude queues it. Two things must be true first:

- The **extension is installed in your Chromium browser and a Flow work tab is chosen** — steps 1
  and 2 of the 2-minute setup above. Claude cannot do that part for you.
- **Node.js 20 or newer is installed** (<https://nodejs.org>). The installer says so if it is missing.

You do **not** need to keep a helper running, and you do **not** need a terminal after the two
commands below: the MCP server starts a helper itself when Claude first uses a tool, and stops it
when Claude exits.

1. **Add the server to Claude.** With Node 20 or newer installed, run:

   ```
   node helper/bin/flowpilot.js install-claude
   ```

   (or `npx flowpilot install-claude`). It backs up your existing Claude config first, prints
   exactly what it added, and never touches your other MCP servers. If you keep Flow Pilot's files
   in a custom place, the installer copies `FLOWPILOT_HOME`/`FLOWPILOT_PORT` into the entry for you.

2. **Restart Claude Desktop** so it loads the new server. Flow Pilot's tools then appear in
   Claude's tools list.

3. **Pair this machine once.** Open the Flow Pilot dashboard, click **Pair an agent**, copy the
   one-time code, and run:

   ```
   node helper/bin/flowpilot.js pair <CODE>
   ```

   The key is saved owner-only in `~/.flowpilot/key`. Only job specs and results cross the bridge —
   never your cookies or tokens.

4. **Check it.** Run `node helper/bin/flowpilot.js doctor`. The helper, pairing, MCP server, its
   tools and the Claude config should each show ✅.

Then, in Claude Desktop, type something like:

> Queue four 6-second videos of a golden retriever puppy running through autumn leaves, using
> `flowpilot_add_job`, then show me the queue with `flowpilot_status`.

Claude queues the jobs as `queued`; nothing is spent until a job is approved and the Flow tab is in
front. You approve in the dashboard (or ask Claude to call `flowpilot_approve`, which spends within
the session cap you set). The finished files land in `Downloads/FlowPilot/<project>/`. The credit
cap and clearing a halt stay yours in the dashboard — Claude cannot change them.

## The extension pin (trust-on-first-use)

The helper only talks to **one** extension. The first `chrome-extension://…` id that opens the
bridge is pinned in `~/.flowpilot/extension.json`; any other id is refused with `403` and never
pinned. `doctor` reports the pinned id. To pin a different extension (for example after a fresh
unpacked load gives it a new id), clear the pin and restart:

```
flowpilot serve --forget-extension
```

The next extension to connect is then pinned afresh.

## Guarantees (the SPEC hard rules)

These are non-negotiable — see [`docs/SPEC.md`](docs/SPEC.md):

- Never calls or wraps `grecaptcha`; generation and uploads happen only through Flow's own buttons.
- No synthetic telemetry, no header rewriting, no embedded API keys, no fingerprint tricks.
- Never reads, stores or transmits your cookies or `Authorization` headers.
- Host permissions are Google Flow hosts only, plus `127.0.0.1` for the helper.
- Any `UNUSUAL_ACTIVITY` halts **all** jobs, with no automatic retry.
- One work tab: it works only in the tab you point it at, and never opens, reloads or closes tabs
  on its own.
- A free preview stays free: Flow Pilot refuses to create a preview whose still is not reported at
  0 credits, and a held video cannot be submitted until a person approves its still from the
  dashboard.
- A downloaded file is accepted only after its bytes match its type.
- The dashboard says which Flow build Flow Pilot was last proven against and dates that claim;
  support files it writes are allow-listed and scrubbed, so a cookie, token or prompt cannot ride along.
- Every credit figure it shows comes from its own records: a spend is claimed only for a Generate
  click it recorded, and the receipt says so in plain words, including what it could not prove.

MIT licensed. Loaded unpacked; no Chrome Web Store for now.
