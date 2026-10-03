# Style Lock — canonical, verbatim, non-negotiable

**Rule: append this block VERBATIM at the END of every image prompt AND every video prompt.**
Never paraphrase. Never rely on one style sentence at the start of a prompt — video models
drift toward realism mid-clip when style is only mentioned once up front.

## Video style lock (append to every clip prompt)

```
The whole video stays in this 3D Pixar/Disney animation style from the first frame to the last:
toy-like proportions, exaggerated cartoon features, big stylized eyes, smooth plastic-like skin,
stylized hair clumps, soft studio shading, saturated clean colors. The style NEVER changes —
no drift, no transition toward realistic at any point.
NOT photorealistic, NOT a realistic human, no realistic skin texture, no skin pores, no realistic
hair strands, no realistic lighting, no real-life photograph look. Animated cartoon only.
Negative: photorealistic, realism, realistic skin, photograph, 8k photo, real-life human,
realistic hair, cinematic realism, style drift, realistic eyes.
```
(*The `Negative:` line is for the Flow prompt text; keep it in the prompt string.*)

## Image style lock (append to every still / reference / sheet prompt)

```
3D Pixar/Disney animation style, toy-like proportions, exaggerated cartoon features, big
stylized eyes, smooth clean stylized skin, soft studio shading. NOT photorealistic, NOT a
realistic human, no realistic skin texture, no realistic hair strands.
```

## Why this exists (client lessons)

- Client1 and Memphis both produced stills + clips that started 3D-Pixar and **drifted to
  realistic humans mid-clip**. The drift gets worse when the prompt describes motion/emotion
  and only opens with a style sentence.
- FlowKit's prompt builder (`_build_video_prompt`) adds audio + negative instructions only —
  it does **not** inject the material style. The agent must inject the lock itself.
- The direct `/api/flow/generate-video` (omni_flash duration path) also sends the prompt raw:
  the style lock must be inside the prompt string.
