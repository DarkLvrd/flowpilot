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
   prepared and submitted with the work tab in front — see LESSONS #23.)
3. **Start the helper** (only needed for agents). From the repo:

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
- **Dashboard** — the self-check summary, an **Agents** section with the **Pair an agent** button,
  the **Session credit cap** (set or raise it here; nothing is submitted past it), an **Add a job**
  form (name, prompt, kind image/video, resolution, duration, aspect), and the **Queue** table.
- **Approvals** — each queued job shows an **Approve** button; jobs wait as `queued` until approved,
  then run from the work tab. Queued/approved/halted jobs can be **Cancel**led; a failed job that
  was never clicked can be **Re-queue**d, and one whose render finished can **Retry download**.
- **Credit cap** — cost is shown per job before it runs, and the session cap is a hard ceiling.
  **Only the dashboard can set or raise the cap** — agents cannot.
- **Halts** — any `UNUSUAL_ACTIVITY` (or similar block) stops the whole queue and shows a banner
  with a **Clear halt** button; there is no automatic retry.

Storyboard import (JSON/CSV bulk queueing) and the folder picker are planned in
[`docs/SPEC.md`](docs/SPEC.md) decisions 3 and 5; the current dashboard adds jobs one at a time.

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
flowpilot approve|cancel|requeue|retry-download <id>
flowpilot doctor                       Check the setup
flowpilot mcp                          Run as an MCP server on stdio
```

Add `--json` to any command for raw JSON. The credit cap, clearing a halt and choosing the work
tab are dashboard-only. (Invoke as `node helper/bin/flowpilot.js <command>` if `flowpilot` is not
on your `PATH`.)

### MCP server

`flowpilot mcp` runs an MCP server on stdio with seven job tools: `flowpilot_status`,
`flowpilot_job`, `flowpilot_add_job`, `flowpilot_approve`, `flowpilot_cancel`, `flowpilot_requeue`
and `flowpilot_retry_download`. There is nothing for the cap, the halt or the work tab — those stay
with the person in the dashboard.

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
- A downloaded file is accepted only after its bytes match its type.

MIT licensed. Loaded unpacked; no Chrome Web Store for now.
