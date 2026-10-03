# Copied canonical prompt assets — verbatim, do not paraphrase

These four files are byte-verbatim copies of `/Users/mac/pixar-studio/prompts/` (taken 2026-10-02,
pixar-studio at `ed35bad`). The text is the asset: Flow Pilot re-reads it, splits it into the
project style entity, the shot-template section order and the camera/motion libraries, and inserts
the resulting blocks into prompts **byte-for-byte**. Paraphrasing any of it breaks the guarantee the
consistency system is built on, so edits here are deliberate content changes, not refactors.

| File | Flow Pilot use (report §1.4, §2.2, §2.3) |
|---|---|
| `style_lock.md` | the default project **style entity** (video block = description + merged negatives); the image block is kept as `imageStyleText` for stills |
| `scene_template.md` | the **shot template** section order, the audio line shape and the default `negativeBase` |
| `camera_moves.md` | the **camera library** (shot types + 15 dynamic movements, keyed by id) |
| `animation_principles.md` | the **motion library** (10 promptable principles, keyed by id) |

`extension/lib/prompt-assets.js` parses these files; `extension/test/prompt-assets.test.mjs` pins
their sha256 so a paraphrase fails the suite. The files are user-editable data: edit them here and
every new composition picks the change up (existing jobs keep the text they were composed with).
