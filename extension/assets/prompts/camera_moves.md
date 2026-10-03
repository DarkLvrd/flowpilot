# Dynamic Camera Library — one dynamic move per scene, never static

**Rules (hard):**

1. Every scene gets a **distinct shot type + ONE dynamic camera movement**, written as its own
   sentence in the prompt (per FlowKit camera guide: camera sentence separate from action).
2. **No locked-off static framing** anywhere. "Static/locked-off" is banned.
3. **No two adjacent scenes** may repeat the same movement or shot type.
4. Pick the movement that serves the beat — the beat explains the camera, not the other way.
5. If a shot would naturally be static (e.g., a sign close-up), give it motion anyway:
   tilt-up, rack focus, whip pan, handheld, dolly-by.

## Shot types

Extreme wide (EWS) · Wide (WS) · Medium (MS) · Close-up (CU) · Extreme close-up (ECU) · POV · Over-the-shoulder (OTS)

## Dynamic movements (pick one per scene)

| Movement | Keywords | Use for |
|----------|----------|---------|
| Arc orbit | `180-degree arc shot around the subject` | hero reveals, slow drama |
| Crane | `crane up revealing the scene` / `crane down onto the subject` | establishing, scale |
| Dolly-in push | `slow dolly-in to an extreme close-up` | emotion, realization |
| Dolly-out | `dolly-out from the face to the wide scene` | isolation, context |
| Tracking glide | `smooth tracking shot alongside` | driving, walking, motion |
| Whip pan | `whip pan from the sign to the car` | energy, transition |
| Handheld prowl | `handheld camera moving through the crowd` | presence, tension |
| Rack focus | `rack focus from background to face` | see-what-he-sees |
| Pan + tilt | `pan right then tilt up to the sign` | details, signs |
| Dutch tilt | `Dutch angle, off-axis, slowly drifting` | unease, wrongness |
| Low-angle glide | `low tracking shot skimming the street` | power, speed |
| Overhead | `top-down overhead, then tilt down into the scene` | pattern, scale |
| POV | `POV shot from the character's eyes` | first-person witness |
| Worm's-eye | `extreme low angle from the ground looking up` | menace, towering |
| Push-and-hold | `slow push-in, then hold with subtle handheld` | anger, quiet fury |

## Prompt shape per scene (camera sentence = own sentence)

```
[Camera sentence]. [Subject + action sentence(s)]. [Setting sentence].
[STYLE LOCK verbatim from prompts/style_lock.md]
Audio: ... Negative: ...
```

## Camera QA at storyboard time

For each panel, the annotation must show shot type + movement. The board reviewer checks:
- camera move present and dynamic (no "static", no "locked-off")
- no adjacent duplicate moves
- movement matches the beat's emotion
