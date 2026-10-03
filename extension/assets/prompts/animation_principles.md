# Animation principles → prompt mapping (distilled for AI video)

Sources: *The Illusion of Life* (Johnston & Thomas, Disney, 1981) — the 12 principles;
*The Animator's Survival Kit* (Richard Williams, 2001) — the practical reference.
We cannot draw frames; these are prompt-language mappings only.

**Honest limits:** #4 straight-ahead/pose-to-pose and #11 solid drawing are
production techniques the video model executes internally — not promptable. Skip them.
Everything else below is usable, and the ★ high-value ones fix known failures
(stiff motion, dead accessories, robotic snap, unclear staging).

## The 10 usable principles

| # | Principle | What it means | Prompt phrasing to use | Fixes |
|---|-----------|---------------|------------------------|-------|
| 1 | Squash & stretch | Cartoon flexibility on impact | `soft cartoon squash on impact, exaggerated bounce` | stiffness |
| 2 | ★ Anticipation | Wind-up before the action | `he tenses/inhales briefly before…`, `the car dips slightly before the turn`, `the gang gathers its breath before the sprint` | robotic snap |
| 3 | ★ Staging | One clear focal point | `subject isolated in frame, clean silhouette, nothing competes with him` | unclear shots |
| 5 | ★ Follow-through & overlap | Parts keep moving after the body stops | `the iced-out chain and watch swing with follow-through as he stops, the bandana settles after him` | dead accessories |
| 6 | ★ Slow in/slow out | Ease into and out of motion | `the camera eases into position and settles softly`, `he starts slowly, accelerates, then softens the stop` | jerky AI motion |
| 7 | Arcs | Motion follows curves, not lines | `the motion travels in a smooth arc`, `the camera arcs around the corner of his jaw` | linear/dead motion |
| 8 | ★ Secondary action | Smaller supporting motion | `his jaw tightens, his fingers tap the wheel`, `her hair and chain drift a beat behind` | lifelessness |
| 9 | ★ Timing & weight | Heavy = slow, light = fast | `slow, heavy step`, `quick, light pop`, `he sets his shoulders before the push` | weightless motion |
| 10 | Exaggeration | Push past real for cartoon effect | `exaggerated cartoon anger, bigger-than-life glare`, `cartoon stretch on the wheel turn` | flat emotion |
| 12 | Appeal | Charming, likable, expressive | `appealing, expressive, warmly lit and friendly` | cold/freaky look |

## Motion beats line (add to every video prompt)

```
Motion: [anticipation] + [primary motion with timing/weight] + [easing] +
[follow-through/secondary on chain, watch, bandana, hair] + [arcs if any].
```

Example (emotion beat): `Motion: he takes a short breath first (anticipation), then his
shoulders drop slowly (timing); the camera eases in and settles (slow in/out); his chain and
watch swing a beat behind him (follow-through); his jaw tightens (secondary).`

## QC addition (advisory — frames only)

At the 25/50/75% frame check also ask: does the motion look ALIVE — is there anticipation
before moves, follow-through on the jewelry/bandana, easing on camera moves, clear staging?
Stiff/robotic or dead-accessory frames → regenerate with the Motion line strengthened.
(This check is frame-based and best-effort; the model decides the in-between frames.)
