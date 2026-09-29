# Flow Pilot — spec

Settled in a grilling session on 2026-09-27. `docs/LESSONS.md` is the list of past failures this
design answers; read it first.

## What it is

A Chromium extension (Chrome, Arc, any Chromium browser) plus a local helper (`flowpilot`) that
generates images and videos in Google Flow (`flow.google.com`) for **one signed-in Google
account**, driven by a person or by any agent.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Output | Images (Nano Banana, with reference images) **and** video (Omni Flash; Frames or Ingredients; 4/6/8/10 s; aspect ratios Flow offers). |
| 2 | Human UI | A **dashboard page** in its own tab (queue, progress, history, settings) + a small **toolbar popup** (status, open dashboard). No side panel (Arc does not support it). Nothing overlaid on Flow's own page. |
| 3 | Input | A **queue**; jobs added one at a time or by **importing a storyboard** (JSON or CSV: scene, prompt, mode, refs, settings, output path). |
| 4 | Concurrency | Submissions are **serialized**; up to **N renders in flight** server-side. Default N = 2, user-configurable. |
| 5 | Files | Default `Downloads/FlowPilot/<project>/<job-name>.<ext>`; a **Choose folder** picker (File System Access API) for any folder; with the helper, a job may name **any absolute path**. |
| 6 | Agent access | Any agent (Pi, firstmate, Claude, others) drives it through the helper: **CLI**, **MCP server**, and **local HTTP API** on `127.0.0.1`. The extension works fully without the helper for people. |
| 7 | Approvals | **Step mode**: each job waits for approval after the previous result is shown. **Batch mode**: a list is approved once and crewmates run scenes in parallel. Agents may approve on the user's behalf. |
| 8 | Credit guard | Cost shown per job and per batch before starting. A **session credit cap**; nothing is submitted past it. **Only the dashboard can set or raise the cap** — agents cannot. |
| 9 | Bridge security | Helper listens on `127.0.0.1` only. Agents pair with a one-time code shown in the dashboard and then hold a key. Only jobs and results cross the bridge — never cookies or auth tokens. |
| 10 | Accounts | **One** Google account at a time; many crewmates share it. |
| 11 | Tabs | **One work tab.** The extension submits every job from that tab, navigating between projects only when no upload is in flight. Status and downloads go through Flow's API, so they need no extra tabs. The extension never opens more tabs, never reloads, never closes tabs it doesn't own; the work tab is marked non-discardable while jobs run. |
| 12 | Projects | Each job names its Flow project; crewmates may share one or use their own. Results are tracked by id, never by grid position. |
| 13 | Detection | On Flow open, a **self-check** verifies composer, mode controls, settings, Generate, and the page's own data calls, and shows ✅/❌. The generate-response shape is **learned from the first real job**; unknown shapes fail closed with "Flow changed". |
| 14 | Packaging | Its own repo, MIT. Extension loaded unpacked; helper via `npx flowpilot`; `flowpilot doctor` checks setup. Private GitHub until the owner says otherwise. No Chrome Web Store for now. |

## Hard rules (non-negotiable)

- Never call or wrap `grecaptcha`; generate and upload happen only through Flow's own buttons.
- No synthetic telemetry, no header rewriting, no embedded API keys, no fingerprint tricks.
- Never read, store or transmit cookies or `Authorization` headers.
- Host permissions: Google Flow hosts only (plus `127.0.0.1` for the helper).
- Any `UNUSUAL_ACTIVITY` (or similar block) halts **all** jobs; no automatic retry.
- No fixed sleeps; wait on real page or network events.
- Before every credit-spending click: correct tab, correct project, correct mode, prompt matches
  verbatim, cap not exceeded.
- A downloaded file is accepted only after its bytes match its type (`ftyp` for MP4, image magic
  for images).

## Build order

1. **Recon** (read-only, zero credits): capture today's Flow DOM and passive `batchexecute`
   traffic → `recon/FINDINGS.md`.
2. Extension core: job model + storage state machine, self-check, work-tab driver, submit,
   track, download. Unit tests for pure logic.
3. Dashboard + popup: queue, storyboard import, approvals, cap, history, folder picker.
4. Helper: pairing, HTTP API, CLI, MCP, file writes, `doctor`.
5. README (2-minute setup), first live job on the practice account.
