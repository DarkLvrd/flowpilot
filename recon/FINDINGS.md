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

Not seen (they need a real click): the generate RPCs (`eb1hJf`, `nprQif`, `MZZa6b`, `YhhmEf`,
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
- Images: `GEM_PIX_2` (Nano Banana 2), `nano_banana_pro`, upsample 2K/4K.

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

## Loaded by the page itself (do not touch)

`www.google.com/recaptcha/enterprise.js` and its anchor iframe load on every project page;
Flow mints its own tokens when Generate is clicked. Flow Pilot never calls or wraps them.
