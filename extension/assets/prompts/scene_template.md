# Scene Prompt Template — beats verbatim + creativity + style lock + dynamic camera

This is the ONE template for every scene prompt (image prompt AND video prompt).
It exists so script beats are never dropped, cameras are never static, and the
style lock is never forgotten.

## Beat sheet first (before any generation)

1. Copy the client's script into a beat list, one continuous moment per line
   (see CONTEXT.md: scene = moment). Quote the script VERBATIM next to each beat.
2. Confirm every script element appears in at least one scene (checklist at the
   bottom of the beat sheet).
3. Only then write the scene prompts.

## Video prompt template

**Duration default: 4s per scene.** A longer moment is SPLIT into more 4s scenes (each with its
own camera move). 6s only for one unsplittable continuous moment the user approved on the board.

```
[SHOT N — 4s]
<Script beat, verbatim or tight paraphrase in quotes>.
[ACTION — subject + what happens, emotions in order, no camera words here]
[MOTION — ONE Motion line from prompts/animation_principles.md: anticipation + timing/weight + easing + follow-through/secondary on chain, watch, bandana, hair]
[SETTING — place, time, weather, life/people]
[CAMERA — one dynamic movement as its own sentence, from prompts/camera_moves.md]
[STYLE LOCK — verbatim from prompts/style_lock.md]
Audio: <SFX: ...> — natural ambient only, no background music, no narration
Negative: <style lock negative + subtitles, watermark, text on screen, logo,
blurry faces, distorted hands, realistic drift>
```

## Image prompt template (still)

```
[Shot type + subject + action]
[Setting]
[STYLE LOCK image variant verbatim]
```

## Creativity rules

- The agent must add creative interpretation (camera, pacing, staging) — but the
  client's beats always win. Never drop, merge, or reword away a beat.
- Emotion beats get their own camera grammar: sadness = slow push-in; anger =
  push-and-hold handheld; tension = handheld prowl + Dutch tilt; speed = low
  tracking glide.
- City/streets must feel ALIVE (people, traffic, activity) unless the script says empty.

## Script checklist (fill at beat-sheet time, re-check at storyboard gate)

- [ ] Every script sentence has a scene
- [ ] Every named entity in the script appears (vehicle, product, signs, people)
- [ ] No invented elements contradicting the script
- [ ] Beats in story order
- [ ] Adjacent scenes have different camera moves
