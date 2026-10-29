# Flow Pilot

[![CI](https://github.com/DarkLvrd/flowpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/DarkLvrd/flowpilot/actions/workflows/ci.yml)

Flow Pilot queues image and video jobs in [Google Flow](https://flow.google.com) for one signed-in
Google account. A person drives it from a dashboard in the browser. An AI agent drives it through a
CLI, an MCP server or a local HTTP API. Both use the same queue, and nothing that costs credits runs
until a person has approved it and the spend fits under a cap that only the dashboard can set.

It is a Chromium extension (Manifest V3, loaded unpacked, no build step) plus a small Node.js helper.
The extension works on its own. The helper adds agent access and can write finished files to any path.

## Why it exists

Earlier Flow automation extensions got accounts blocked. They minted their own reCAPTCHA tokens and
sent fake telemetry to look human, and Flow's backend answered with `UNUSUAL_ACTIVITY`. Flow Pilot
does neither: every generation goes through Flow's own buttons, so the page behaves as it would for a
person. It also puts a price check and a human approval step in front of every paid generation, so
an agent can queue work without spending credits on clips nobody looked at.
[`docs/LESSONS.md`](docs/LESSONS.md) lists each earlier failure and the rule that answers it.

## How it works

```
 person ──► dashboard / popup ─┐
                               ├──► extension service worker ──► content script in the Flow tab
 agent ──► CLI / MCP / HTTP ──► helper (127.0.0.1) ──┘                  (Flow's own buttons)
```

- The **extension** keeps the job queue in browser storage and works inside one Flow tab that you
  choose. It fills in Flow's own composer and presses Flow's own Generate button. It never opens,
  reloads or closes tabs, never touches cookies or auth headers, and never calls reCAPTCHA.
- Before any click that could spend credits, a **pre-spend check** reads Flow's cost line and the
  selected model and references, and compares them with the job. If anything differs, the job fails
  closed and nothing is charged.
- The **helper** listens on `127.0.0.1:47615` only. Agents pair once with a one-time code from the
  dashboard and then send a bearer key. Only job specs and results cross this bridge. The helper
  talks to a single extension id, pinned the first time it connects.
- If Flow returns `UNUSUAL_ACTIVITY`, every job stops. Nothing resumes until a person presses
  Resume, and only the rows that never reached Flow run again.

## Features

- Queue jobs one at a time, or import a whole storyboard from JSON or CSV. An import is checked and
  priced row by row first, and a file with one bad row is refused as a whole.
- Preview first: a scene runs as a free still image, and its video is created only after a person
  approves that still. The video's price is shown on the approve button.
- Consistency library: characters, vehicles and locations are saved per project with locked
  reference images, and every prompt that uses them includes the same canonical description.
  Changing an entity creates a new version instead of editing the old one.
- Review loop for finished clips: six checks per clip, a recorded verdict, and a fix action for each
  failure with its cost shown before it runs.
- A spend receipt per session in Markdown, listing every charge Flow Pilot recorded, the cap in
  force, and anything it could not prove was charged.
- A diagnostics file for support with tokens, cookies, prompt text and file paths scrubbed out.

## Quick start

Requirements: a Chromium browser (Chrome, Arc or similar, version 120 or later) and Node.js 20+.

1. Open the browser's extensions page, turn on Developer mode, choose **Load unpacked** and select
   the `extension/` folder.
2. Sign in at <https://flow.google.com>, open a project, then click the Flow Pilot icon and choose
   **Use this tab as the work tab**.
3. To let an agent drive it, start the helper and check the setup:

   ```bash
   npm install
   node helper/bin/flowpilot.js serve
   node helper/bin/flowpilot.js doctor
   ```

4. In the dashboard, click **Pair an agent** and run `node helper/bin/flowpilot.js pair <code>`.

Queue a job from the command line:

```bash
node helper/bin/flowpilot.js add --prompt "a red fox trots through snow" --resolution 360p --duration 4
node helper/bin/flowpilot.js status
```

The job waits as `queued` until someone approves it in the dashboard or with `flowpilot approve <id>`.

## Agent interfaces

| Interface | How to use it |
|---|---|
| CLI | `node helper/bin/flowpilot.js <command>`; add `--json` for machine-readable output |
| MCP server | `flowpilot mcp` on stdio, 17 tools; `flowpilot install-claude` adds it to Claude Desktop |
| HTTP API | `http://127.0.0.1:47615` with `Authorization: Bearer <key>` |

Agents can queue, approve, cancel and review jobs. The credit cap, clearing a halt and choosing the
work tab are reserved for the person at the dashboard. The full command list, the HTTP routes and the
storyboard format are in [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md).

## Tests

```bash
npm test
```

502 tests run on Node's built-in test runner with no network and no browser. They cover the job
state machine, the pre-spend check, storyboard parsing, the prompt composer, the consistency library,
the review loop, the HTTP API, pairing and the MCP server. GitHub Actions runs them on every push and
pull request.

## Project layout

```
extension/            Chromium extension (Manifest V3)
  sw.js               service worker: queue runner, bridge to the helper
  content/driver.js   runs inside the Flow tab and operates Flow's own controls
  lib/                job store, pre-spend check, composer, entities, shots, QC, receipts
  dashboard/  popup/  the two screens people use
  test/               extension tests and recorded Flow fixtures
helper/               Node.js helper
  lib/server.js       local HTTP API
  lib/mcp.js          MCP server
  lib/cli.js          CLI
  test/               helper tests
recon/                read-only scripts and notes on how Flow's page and data calls behave
docs/                 SPEC (decisions and hard rules), LESSONS (past failures), USER-GUIDE
```

## Design documents

- [`docs/SPEC.md`](docs/SPEC.md) lists the settled decisions and the rules the code must not break.
- [`docs/LESSONS.md`](docs/LESSONS.md) records the failures of earlier Flow automation attempts that
  those rules respond to.
- [`recon/FINDINGS.md`](recon/FINDINGS.md) is the dated log of what was observed in Flow's live page.

## Status

Developed between 27 September and 3 October 2026 against the Flow builds live at the time. Flow
changes often, so the dashboard shows the last Flow build Flow Pilot was proven against. On the current build, Flow ignores
a scripted click in Image mode, so a still has to be started with Flow's own button by hand; video
jobs are not affected.

## License

MIT
