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
  and the **Queue** table.
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
- **Spend-and-safety receipt** — press **Save receipt file** and Flow Pilot writes one local Markdown
  file for the batch or session: every row and its exact charge (a charge is only ever a Generate
  click it recorded, never a quote), the cap that was in force, everything that was never submitted
  or that Flow Pilot cannot prove was charged, each halt in Flow's own words, and where each file
  landed. Prompt text stays out unless you tick **include prompt text** (a short prompt fingerprint
  is always there). It is built from Flow Pilot's own records and is never uploaded — keep it, send
  it, or delete it.
- **Halts** — any `UNUSUAL_ACTIVITY` (or similar block) stops the whole queue and shows a banner
  with a **Clear halt** button; there is no automatic retry.

Storyboard import (JSON/CSV bulk queueing) and the folder picker are built (SPEC decisions 3 and
5): the dashboard now adds jobs one at a time *or* a whole batch at once.

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
             [--ref REF ...] [--first-frame REF] [--last-frame REF]
flowpilot approve|cancel|requeue|retry-download <id>
flowpilot doctor                       Check the setup
flowpilot install-claude [--config PATH]
                                       Add the MCP server to Claude Desktop (backup first)
flowpilot mcp                          Run as an MCP server on stdio (starts the helper if needed)
```

Add `--json` to any command for raw JSON. The credit cap, clearing a halt and choosing the work
tab are dashboard-only. (Invoke as `node helper/bin/flowpilot.js <command>` if `flowpilot` is not
on your `PATH`.)

**References (face-matched character work).** A video job may carry reference photos, each a Flow
media id or an absolute image path (`.png`/`.jpg`/`.webp`); the helper reads a path's bytes and
Flow Pilot uploads it through Flow's own **Upload media** control, never sending cookies or tokens.
**Ingredients** shape the whole video — `--ref` (repeat for up to three) makes a reference-to-video
generation. **Frames** generate the video between a start and end photo — `--first-frame` (and an
optional `--last-frame`). Before it spends, Flow Pilot checks the right references are attached,
verified by media id. Example:

```
flowpilot add --prompt "she turns to face the camera" --ref /Users/me/face.png --resolution 360p --duration 4
flowpilot add --prompt "a slow zoom in" --first-frame /Users/me/wide.png --last-frame /Users/me/close.png
```

### MCP server

`flowpilot_add_job` also takes `refs` (1-3 Ingredients reference photos), `firstFrame` and
`lastFrame` (Frames), each a Flow media id or an absolute image path — the same face-matched
character work as the CLI above.

`flowpilot mcp` runs an MCP server on stdio with seven job tools: `flowpilot_status`,
`flowpilot_job`, `flowpilot_add_job`, `flowpilot_approve`, `flowpilot_cancel`, `flowpilot_requeue`
and `flowpilot_retry_download`. There is nothing for the cap, the halt or the work tab — those stay
with the person in the dashboard.

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
| `POST` | `/jobs` | `{ spec }` — queue a job |
| `GET`  | `/jobs/<id>` | one job |
| `POST` | `/jobs/<id>/approve` \| `/cancel` \| `/requeue` \| `/retry-download` | act on a job |

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

2. **Restart Claude Desktop** so it loads the new server. Flow Pilot's seven tools then appear in
   Claude's tools list.

3. **Pair this machine once.** Open the Flow Pilot dashboard, click **Pair an agent**, copy the
   one-time code, and run:

   ```
   node helper/bin/flowpilot.js pair <CODE>
   ```

   The key is saved owner-only in `~/.flowpilot/key`. Only job specs and results cross the bridge —
   never your cookies or tokens.

4. **Check it.** Run `node helper/bin/flowpilot.js doctor`. The helper, pairing, MCP server, its
   seven tools and the Claude config should each show ✅.

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
- Every credit figure it shows comes from its own records: a spend is claimed only for a Generate
  click it recorded, and the receipt says so in plain words, including what it could not prove.

MIT licensed. Loaded unpacked; no Chrome Web Store for now.
