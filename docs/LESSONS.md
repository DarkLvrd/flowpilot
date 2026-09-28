# Flow Extension v2 — lessons from what broke before

Sources: the old extension (`flow-agent-src/flow-extension/`, a copy of kodelyx/flow-agent),
the local FlowKit clone (`flowkit/extension/`), `AGENTS.md`, and the research report
`~/firstmate/data/flow-tools-research/report.md` (2026-09-27).

Each lesson is stated as: **what went wrong → the rule v2 follows.**

---

## A. Why the old extensions died

1. **They minted their own reCAPTCHA tokens.** `injected.js` called
   `grecaptcha.enterprise.execute(SITE_KEY, …)` itself. Flow's 2026-09-22 build tags any token
   created outside its own code as `extension_hijack_detected`; the backend then returns
   `PUBLIC_ERROR_UNUSUAL_ACTIVITY`.
   → **v2 never touches `grecaptcha`.** Generate and upload happen only by clicking Flow's own
   buttons, so the page mints its own token.

2. **They faked telemetry to look human.** `background.js:1282-1310` posts synthetic
   `batchLog` / `batchLogFrontendEvents` "at random intervals (45-120s) to look organic".
   FlowKit v0.5.2 went further (a reCAPTCHA bypass) and accounts got blocked (flowkit#67).
   → **v2 sends no fake traffic and does no evasion.** Every request it makes is a real one.

3. **They targeted the retired API.** The old copy is built around `labs.google` tRPC
   (`trpc/media.getMediaUrlRedirect`, `/fx/api/upload-video`). Flow moved to
   `flow.google.com` + `batchexecute`.
   → **v2 targets `flow.google.com` `batchexecute` only**, with RPC ids kept in one table.

## B. Security problems

4. **Session tokens left the browser.** `background.js:135-155` scraped every `Bearer ya29.…`
   header, saved it in `chrome.storage`, and sent it to a local backend over WebSocket/HTTP.
   Anything on that port got a live Google token.
   → **v2 never reads, stores or sends auth headers or cookies.** RPCs run *inside* the Flow tab
   with the page's own credentials.

5. **A third-party host had permission.** `manifest.json` allowed `https://flow.kodelyx.in/*`.
   → **v2's host permissions are Google Flow hosts only.** No remote servers, no remote code.

6. **A hard-coded API key and header rewriting.** `API_KEY = 'AIza…'` and `rules.json`
   forging `Referer`/`Origin` on `aisandbox-pa.googleapis.com`.
   → **v2 has no `declarativeNetRequest` header rewriting and no embedded keys.**

7. **Opaque backend.** The old extension was only a bridge to a closed 19 MB binary engine.
   → **v2 is self-contained, readable JS.** No backend needed to generate or download.

## C. Tab problems (the "browser keeps refreshing" saga)

8. **It grabbed whichever tab came first.** `_getOrOpenFlowTab` used `tabs[0]` from a URL
   query; `open_flow_tab` *reloaded* `tabs[0]`. Same bug as the 172 `ctx.pages()[0]` scripts:
   it drove someone else's project and reloaded their page mid-render.
   → **v2 binds every job to one tab id + project id**, and re-checks the tab's URL right
   before any click that spends credits (same idea as `assertLane`).

9. **It opened and closed tabs on its own.** `tabs.create` when none matched, plus an alarm
   that closed "idle" tabs after 2 minutes. On 2026-09-16 tab churn reached 33-34 tabs,
   one project ×10, 2.4 GB free RAM, and Chrome began discarding/reloading tabs.
   → **v2 never opens, reloads or closes tabs by itself.** It works in the tab you point it at.

10. **Background tabs get discarded.** Under memory pressure Chrome reloads background tabs,
    which cancels uploads and resets the page.
    → **v2 marks its working tab non-discardable** (`chrome.tabs.update({autoDiscardable:false})`)
    while a job runs, and resumes cleanly if the page reloads anyway.

## D. Flow UI traps (learned from failed renders)

11. **Typing long prompts corrupts them** (1 ms/char interleaves words).
    → Insert the prompt in one go, then **read it back and compare verbatim** before Generate.

12. **Modes are exclusive and account-global.** `Image | Video | Frames | Ingredients`;
    Frames *or* Ingredients, never both; another session can flip them under you.
    → Set the mode, **re-check it immediately before Generate**, refuse to spend if it drifted.

13. **Uploads are slow and fragile** (~90 s to show in the grid; navigating/Escape cancels them;
    the sidebar "Add media" upload reports success but uploads nothing).
    → Use the asset picker's `Upload media` control; **don't wait for the grid** — read the new
    media id from the project-media RPC (`Zzl0ze`); never navigate while an upload is in flight.

14. **Clips can't be found by grid position.** Video tiles have no `data-media-id`; the grid is a
    virtual scroller; several workers share one project.
    → Identify a clip by **the operation/media id from Flow's own generate response**, confirmed
    against the verbatim prompt in `Zzl0ze`.

15. **Downloads were a mess.** `blob:` URLs Playwright can't save, `~/Downloads` blocked by macOS,
    `/image/`→`/video/` URL rewrite gives 403, the bare `/asb/` token returns the poster.
    → Get the signed `/video/<id>` URL from `as29s` and download that. **Check the bytes are an
    MP4** (`ftyp` at offset 4) before calling it done.

16. **Fixed sleeps were most of the runtime** (~290-665 s of `sleep()` per clip in old drivers).
    → **No fixed sleeps.** Wait on real events: Flow's own network responses and status RPC
    (`jwpduf`), polled every 15-30 s.

17. **Popovers swallow clicks.** The account/credits panel ignores Escape and eats the next click;
    the Settings chip sometimes needs a second click.
    → Before each click, assert the target exists and no overlay covers it; close overlays by
    their own X.

## E. Reliability

18. **MV3 service workers die after ~30 s idle**, losing in-memory state (the old one used
    keep-alive alarms and an outbox to cope).
    → **All job state lives in `chrome.storage`**; every step is resumable and idempotent.

19. **Blocks got retried.** Retrying after `UNUSUAL_ACTIVITY` makes things worse (FlowKit
    `0e0a94e`).
    → **Any `UNUSUAL_ACTIVITY` stops the whole queue** and shows a banner. No auto-retry.

20. **Flow ships weekly and RPC ids/payload slots drift** (FlowKit re-captured them 3× in Sept).
    → RPC ids live in one file; response readers are tolerant (search for the fields rather than
    fixed indexes) and **fail closed** with a clear "Flow changed" message.

21. **Nothing was tested offline.**
    → Pure logic (RPC envelope build/parse, job state machine, MP4 check) is unit-tested with
    fixtures, never against the live account.

22. **The Agent panel has its own composer, and a typed line break submits** (Flow Pilot's own
    first dry run, 2026-09-28). The Agent panel was open (restored from an earlier session). In
    that state the only prompt box and "Start generation" button on the page belong to the Agent.
    The driver matched them by label, filled the dry-run prompt, and its `insertText` fallback put
    in a line break. ProseMirror treats an inserted break as an Enter key, and Enter submits. The
    test prompt went to the Agent chat. No media was created. (A balance drop seen at the same
    time, 261 → 219, was the owner's own use of Flow, not this incident.)
    → **The driver only uses the main composer (never inside `flow-agent-panel`), refuses to run
    while the Agent panel is open, never types or uses `insertText` (one paste, lines as `<p>`),
    and halts everything if the composer empties or changes while filling.** Live driver tests
    run behind `recon/dry-run.mjs`, which blocks every non-read-only request in the browser.

---

## What v2 is, in one paragraph

A self-contained MV3 extension for `flow.google.com`. You open your Flow project, open the side
panel, and queue jobs (prompt + mode + refs + settings). For each job it fills the composer,
verifies prompt and mode, and clicks Flow's own Generate. It learns the job's id from Flow's own
response, tracks it via the status RPC, fetches the finished file via a signed URL, checks it,
and saves it. It never mints captcha tokens, never rewrites headers, never exports credentials,
never manages tabs on its own, and halts everything on the first `UNUSUAL_ACTIVITY`.
