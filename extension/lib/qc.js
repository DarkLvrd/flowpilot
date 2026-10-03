// The QC loop for finished clips (report §2.6, §2.8): the six checks, the failure policy as DATA,
// the pure verdict, and the record written on the job.
//
// The design's rule shapes everything here: `technical` is automatic (the extension already checks
// bytes, recipe vs settings, resolution, duration bucket, aspect and non-empty before a download is
// accepted), and the other five need eyes — so this module SURFACES them, RECORDS the verdict and
// OFFERS the fix. It never auto-approves or auto-fails a clip on a machine score, and the policy
// never regenerates anything by itself: every action it returns is a click a person or an agent
// takes, through the ordinary job paths.
//
// Pure and offline: no storage, no network, no clock of its own (callers pass `at`). The service
// worker, the CLI, the MCP server and the dashboard all read the same table.

import { recipeFor } from './catalog.js';
import { sha256Hex } from './sha256.js';

export const QC_CHECKS = ['technical', 'identity', 'wardrobe', 'location', 'artefacts', 'style'];
// What a person (or an agent looking at frames) has to decide. `technical` is computed, never asked.
export const QC_VISIBLE = ['identity', 'wardrobe', 'location', 'artefacts', 'style'];
export const QC_RESULTS = ['pass', 'fail'];
export const QC_VERDICTS = ['approved', 'regen', 'blocked'];
export const QC_WHO = ['human', 'agent'];

// The failure policy, straight from the report's table (§2.6), as data: which failure maps to which
// action, what that action does, whether it needs a new still, and what it costs in credits. A still
// is free today; a video is not, so every video row says so before any click.
//
// One deliberate reading of the design: the hard rule "never rewrite a base prompt — append a block
// and keep the old hashes" beats the table's shorthand "append negatives to section 10". Rewriting
// section 10 would move the frozen base hash, so the artefacts fix appends the negatives as a
// consistency block instead; the report's own auditability rule is the one that must survive.
export const QC_POLICY = [
  {
    check: 'identity',
    action: 'regenStillWithEntityBlock',
    label: 'Regenerate the still with the entity block',
    what: 'Build the frame again from the shot\'s approved entity references, then re-anchor it and make a new video. The failed take stays on disk.',
    still: true,
    credits: { stills: 0, videos: 1 },
    block: 'The subject stays identical to its approved entity reference in every frame: same face, hair, build and proportions.',
  },
  {
    check: 'wardrobe',
    action: 'appendConsistencyBlock',
    label: 'Append a consistency block for that entity',
    what: 'Append the fix as a consistency block (the car_consistency_block pattern), regenerate the still, re-anchor and make a new video. Nothing already approved is rewritten.',
    still: true,
    credits: { stills: 0, videos: 1 },
    block: 'Wardrobe, props and paint stay continuous with the approved reference in every frame.',
  },
  {
    check: 'location',
    action: 'addLocationOrFixSetting',
    label: 'Pin the location (entity slot, or an appended block)',
    what: 'Add the location entity to the shot\'s in-frame subjects when a slot is free; otherwise append the location as a consistency block. Either way the still is regenerated and re-anchored.',
    still: true,
    credits: { stills: 0, videos: 1 },
    block: 'The place stays the same approved location in every shot: same geography, light and landmarks.',
  },
  {
    check: 'artefacts',
    action: 'appendNegatives',
    label: 'Append the negatives and make a new video',
    what: 'Append the unwanted-text/hands negatives as a consistency block and make a new video from the still that is already approved. No new still is needed.',
    still: false,
    credits: { stills: 0, videos: 1 },
    block: 'No text, watermark, logo, extra characters or distorted hands anywhere in frame.',
  },
  {
    check: 'style',
    action: 'strengthenStyleBlock',
    label: 'Strengthen the style block and make a new video',
    what: 'Append a stronger style lock as a consistency block and make a new video from the still that is already approved. The project style entity itself is not edited here.',
    still: false,
    credits: { stills: 0, videos: 1 },
    block: 'The whole clip stays in the project\'s 3D Pixar/Disney style from the first frame to the last: no photoreal drift.',
  },
  {
    check: 'technical',
    action: 'none',
    label: 'Nothing to fix — the job failed its own byte check',
    what: 'A download whose bytes, recipe or settings do not match is rejected before the job reaches done, so there is no clip to review and no credits are needed.',
    still: false,
    credits: { stills: 0, videos: 0 },
    automatic: true,
    block: null,
  },
];

export function policyFor(check) {
  const row = QC_POLICY.find((p) => p.check === check);
  if (!row) throw new Error(`Unknown check: ${JSON.stringify(check)}; the checklist is ${QC_CHECKS.join(', ')}`);
  return row;
}

const isResult = (v) => QC_RESULTS.includes(v);

// The block a fix appends: the reviewer's own note (the car_consistency_block pattern) when there is
// one, otherwise the policy's default line for that check. `null` for a check with no fix.
export function consistencyBlockFor(check, { note = null } = {}) {
  const row = policyFor(check);
  if (!row.block) return null;
  const text = String(note ?? '').trim();
  return text !== '' ? text : row.block;
}

// What the fix costs, in words, before it is taken. A still is free; a video is what costs.
export function fixCostText(action) {
  const videos = action?.credits?.videos ?? 0;
  const videosPart = videos === 0 ? '' : `, then +${videos} video${videos === 1 ? '' : 's'} once it is approved`;
  if (action?.still && action?.credits?.stills === 0) return `0 credits now: a still is free${videosPart}`;
  return videos === 0 ? '0 credits — no generation needed' : `+${videos} video credit${videos === 1 ? '' : 's'} when approved`;
}

// `checks` is the full six-id map (technical included). Returns the verdict, the failed ids in the
// checklist's order, and one action per failure in the policy table's order. Pure.
export function qcVerdict(checks, policy = QC_POLICY, { note = null } = {}) {
  if (checks == null || typeof checks !== 'object' || Array.isArray(checks)) throw new Error('A QC verdict needs a checks object');
  const unknown = Object.keys(checks).filter((k) => !QC_CHECKS.includes(k));
  if (unknown.length) throw new Error(`Unknown check(s): ${unknown.join(', ')}; the checklist is ${QC_CHECKS.join(', ')}`);
  const missing = QC_CHECKS.filter((c) => !isResult(checks[c]));
  if (missing.length) throw new Error(`Every check needs a "${QC_RESULTS.join('" or "')}" result; missing or malformed: ${missing.join(', ')}`);
  // The policy is data a caller may replace; an incomplete one would silently drop a failure.
  const uncovered = QC_CHECKS.filter((c) => !policy.some((p) => p.check === c));
  if (uncovered.length) throw new Error(`The failure policy has no action for ${uncovered.join(', ')}`);

  const failed = QC_CHECKS.filter((c) => checks[c] === 'fail');
  const actions = policy
    .filter((row) => row.check !== 'technical')
    .filter((row) => failed.includes(row.check))
    .map((row) => ({
      check: row.check,
      action: row.action,
      label: row.label,
      what: row.what,
      still: row.still,
      credits: { ...row.credits },
      block: consistencyBlockFor(row.check, { note }),
      automatic: false,
      verdict: 'regen',
    }));
  // A clip the machine itself rejected has no fix to offer, but the row is still reported so the
  // reason is visible instead of the failure being silently dropped.
  if (failed.includes('technical')) {
    const row = policyFor('technical');
    actions.push({ check: 'technical', action: row.action, label: row.label, what: row.what, still: row.still, credits: { ...row.credits }, block: null, automatic: true, verdict: 'blocked' });
  }

  // technical failing blocks approval outright: a job that never passed its own byte check has no
  // clip to judge, so no `regen` is offered for it.
  const verdict = failed.length === 0 ? 'approved' : (failed.includes('technical') ? 'blocked' : 'regen');
  return { verdict, failed, actions, ok: verdict === 'approved', note: String(note ?? '').trim() || null };
}

// The automatic `technical` check, from what the extension already verified (report §2.6): bytes
// kind, non-empty/saved, duration bucket, resolution, aspect, and recipe vs the job's settings.
// Pure — it reads the job record, not the page.
export function technicalCheck(job = {}) {
  const problems = [];
  const settings = job.settings ?? {};
  const kind = settings.kind ?? 'video';
  if (job.state !== 'done') problems.push(`the job is ${job.state ?? 'unknown'}, not done`);
  if (!job.mediaId) problems.push('Flow returned no media id');
  if (!job.file?.path) problems.push('no file was saved');
  const allowed = kind === 'video' ? ['mp4'] : ['png', 'jpeg', 'webp'];
  if (job.file?.type && !allowed.includes(job.file.type)) {
    problems.push(`the saved bytes are ${job.file.type}, not ${allowed.join(' or ')} for a ${kind}`);
  }
  try {
    const expected = recipeFor({ ...settings, kind });
    if (job.recipe && expected !== job.recipe) {
      problems.push(`the recipe ${job.recipe} no longer matches the job's settings (${expected}: duration, resolution or input drifted)`);
    }
  } catch (e) {
    problems.push(`the job's settings do not price: ${e.message}`);
  }
  return { check: 'technical', result: problems.length ? 'fail' : 'pass', problems };
}

// The record, exactly the five fields the design stores (report §2.6): checkedAt, by, the six
// checks, the verdict and the note. `technical` is filled in from the job — never taken on trust —
// and a caller that states it anyway must agree with the automatic result.
export function buildQcRecord({ job = {}, checks = {}, by = 'human', note = null, at = Date.now(), policy = QC_POLICY } = {}) {
  if (!QC_WHO.includes(by)) throw new Error(`Who checked a job must be one of ${QC_WHO.join(' or ')}, got ${JSON.stringify(by)}`);
  const automatic = technicalCheck(job).result;
  if (checks.technical != null && checks.technical !== automatic) {
    throw new Error(`The technical check is automatic: the job reads "${automatic}", not ${JSON.stringify(checks.technical)}`);
  }
  const merged = { technical: automatic };
  for (const check of QC_VISIBLE) merged[check] = checks[check];
  const { verdict } = qcVerdict(merged, policy, { note });
  return { checkedAt: at, by, checks: merged, verdict, note: note == null ? null : String(note) };
}

// The parts a fix appends to. A job composed from the library already carries them; a plain job has
// only its prompt text, which becomes the base part verbatim (kind "base", exactly what the composer
// would have emitted), so a fix can never drop the text a person typed.
export function jobPromptParts(job = {}) {
  if (Array.isArray(job.promptParts) && job.promptParts.length) return job.promptParts;
  const text = String(job.prompt ?? '');
  return text ? [{ kind: 'base', ref: 'prompt', sha256: sha256Hex(text), text }] : [];
}

// The new job a fix creates for a clip that is NOT part of a shot. Same recipe, same references,
// the appended parts, and a fresh name; `buildJob` (the one validation path) turns this into a job,
// so a fix can never submit on weaker terms than a hand-added job. Pure; the input job is untouched.
export function fixJobSpec(job = {}, action = {}, parts = [], { name = null } = {}) {
  const settings = job.settings ?? {};
  const references = job.references ?? {};
  const plan = job.referencePlan ?? {};
  const refs = referenceIds(job);
  const spec = {
    name: name ?? `${job.name ?? job.id ?? 'job'}-${action.check}-fix`,
    kind: action.still ? 'image' : (settings.kind ?? 'video'),
    prompt: parts.map((p) => p.text).join('\n\n'),
    promptParts: parts,
    ...(job.entities?.length ? { entities: job.entities } : {}),
    ...(settings.resolution ? { resolution: settings.resolution } : {}),
    ...(Number.isFinite(settings.durationS) ? { durationS: settings.durationS } : {}),
    ...(settings.aspect ? { aspect: settings.aspect } : {}),
    ...(settings.count ? { count: settings.count } : {}),
  };
  // A still takes Ingredients (photo references), never Frames; a video keeps the mode it ran in.
  if (action.still) return refs.ingredients.length ? { ...spec, refs: refs.ingredients } : spec;
  const input = settings.input === 'frames' ? 'frames' : (refs.ingredients.length ? 'ingredients' : (settings.input ?? 'text'));
  return {
    ...spec,
    input,
    ...(input === 'ingredients' ? { refs: refs.ingredients } : {}),
    ...(input === 'frames' ? { firstFrame: refs.firstFrame ?? plan.firstFrame?.mediaId ?? null, lastFrame: refs.lastFrame ?? null } : {}),
  };
}

// Media ids only: the resolved references a finished job already carries, falling back to the ones
// the plan classified as media ids. Paths never reach a fix (they were uploaded once already).
function referenceIds(job = {}) {
  const resolved = job.references ?? {};
  const plan = job.referencePlan ?? {};
  const ids = (list) => (list ?? []).map((r) => (typeof r === 'string' ? r : r?.mediaId)).filter((v) => typeof v === 'string' && v !== '');
  const ingredients = ids(resolved.ingredients?.length ? resolved.ingredients : plan.ingredients);
  const firstFrame = resolved.firstFrame ?? plan.firstFrame?.mediaId ?? null;
  const lastFrame = resolved.lastFrame ?? plan.lastFrame?.mediaId ?? null;
  return { ingredients: [...new Set(ingredients)], firstFrame, lastFrame };
}

// The same validation the job store runs before writing a record, so a malformed verdict can never
// land in storage (the store is the only writer).
export function validateQcRecord(qc) {
  if (qc == null || typeof qc !== 'object' || Array.isArray(qc)) throw new Error('A QC record must be an object');
  if (!Number.isFinite(qc.checkedAt) || qc.checkedAt <= 0) throw new Error('A QC record needs a checkedAt timestamp');
  if (!QC_WHO.includes(qc.by)) throw new Error(`Who checked a job must be one of ${QC_WHO.join(' or ')}, got ${JSON.stringify(qc.by)}`);
  if (!QC_VERDICTS.includes(qc.verdict)) throw new Error(`A QC verdict must be one of ${QC_VERDICTS.join(', ')}, got ${JSON.stringify(qc.verdict)}`);
  if (qc.note != null && typeof qc.note !== 'string') throw new Error('A QC note must be text or null');
  const { verdict } = qcVerdict(qc.checks);
  if (verdict !== qc.verdict) throw new Error(`The QC record says "${qc.verdict}" but its checks say "${verdict}"`);
  return true;
}
