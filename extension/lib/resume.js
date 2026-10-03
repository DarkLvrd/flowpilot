// Guided cool-down and one-click resume after a halt (report §9.2).
//
// The rule this file exists to keep: a halt stops everything, and NOTHING runs again until a person
// presses Resume in the dashboard. There is no timer here that resumes anything, and no path that
// re-submits a row Flow may already have seen. Resume only clears the hold on rows that were never
// submitted, in their original order; each one still goes through the ordinary pre-spend checks and
// the ordinary credit cap, exactly like a fresh job.
//
// Evidence for the wait: gflow-cli's field data (#241, quoted in report §4.2) is the only measured
// number in the category — a burst of ~14 submissions in ~10 minutes produced a 403, and after a
// ~30-minute cooldown 4/4 individually paced calls passed. Its own policy is "it must not
// auto-retry, because retrying only inflates per-profile heat". FlowKit's #67 is the other outcome:
// two accounts blocked, manual Flow blocked too.

export const COOL_DOWN_MINUTES = 60;      // recommended: what the field data supports
export const MIN_COOL_DOWN_MINUTES = 30;  // the shortest wait the same data saw succeed
const MIN = 60_000;

// The single definition of "never submitted", shared with the receipt: no write-ahead click, and
// nothing that suggests one may have happened happened.
export function isNeverSubmitted(job) {
  return job.clickedAt == null && !job.mayHaveSubmitted;
}

// Which rows a Resume may touch, and why each other row is left alone. Pure and order-preserving.
export function resumePlan(jobs = []) {
  const ready = [];
  const waiting = [];
  const skipped = [];
  const skip = (j, why) => skipped.push({ id: j.id, name: j.name, state: j.state, why });

  for (const j of jobs) {
    const from = j.state === 'halted' ? j.haltedFrom : j.state;
    if (j.clickedAt != null) {
      skip(j, 'already submitted once — Flow Pilot never clicks it again');
    } else if (j.mayHaveSubmitted) {
      skip(j, 'may have been submitted before the halt — check Flow; Resume will not run it');
    } else if (j.state === 'done') {
      skip(j, 'already finished');
    } else if (j.state === 'cancelled') {
      skip(j, 'you cancelled it');
    } else if (j.state === 'failed') {
      skip(j, 'failed before it clicked; use Re-queue if you want it back');
    } else if (j.state === 'awaiting-preview') {
      // Preview-first (lib/preview.js): this video is held on a free still, not on a halt. It runs
      // when the person approves the look, and a Resume must not shortcut that.
      skip(j, 'held on an unapproved still — approve the free preview (or cancel it) instead');
    } else if (from === 'approved' || from === 'submitting') {
      // `submitting` halted before the write-ahead click, so it never reached Flow; clearing the
      // halt puts it back to `approved` (lib/jobs.js clearHalt).
      ready.push(j);
    } else if (from === 'queued') {
      waiting.push(j);
    } else {
      skip(j, `nothing to resume from "${j.state}"`);
    }
  }
  return { ready, waiting, skipped };
}

const plainCause = (reason = '') => (/unusual.?activity/i.test(reason)
  ? "Flow's own unusual-activity check refused the request. That is Flow telling you to stop, not an error to retry."
  : 'Flow Pilot stopped the queue. The reason below is everything it recorded.');

// What to show a person after a halt: why, how long to wait, and what to check before resuming.
// Pure and advisory — it never decides anything, and nothing schedules itself off it.
export function coolDown({ haltReason = '', haltedAt = null, now = Date.now() } = {}) {
  const start = haltedAt ?? now;
  const earliestAt = start + COOL_DOWN_MINUTES * MIN;
  const remainingMinutes = Math.max(0, Math.ceil((earliestAt - now) / MIN));
  return {
    haltReason,
    why: `${plainCause(haltReason)} Flow Pilot's own words: "${haltReason}".`,
    waitMinutes: COOL_DOWN_MINUTES,
    minMinutes: MIN_COOL_DOWN_MINUTES,
    haltedAt: start,
    earliestAt,
    remainingMinutes,
    evidence: 'Measured in the field (gflow-cli #241): a burst of ~14 submissions in ~10 minutes was refused, and after a ~30-minute cooldown 4 of 4 paced calls went through. Retrying sooner is what got two FlowKit accounts blocked.',
    checklist: [
      'Open Flow yourself in this browser and check the project still loads and shows your media.',
      'Check your credit balance in Flow and compare it with the receipt (Save receipt file below).',
      `Leave the queue stopped for about ${COOL_DOWN_MINUTES} minutes (at least ${MIN_COOL_DOWN_MINUTES}) — and use Flow normally in the meantime, exactly as you would without Flow Pilot.`,
      'Re-run the self-check (popup → "Use this tab as the work tab") and fix anything marked ❌ before you resume.',
      'If Flow still shows a block, wait longer. Pressing Resume sooner does not help, and Flow Pilot will not do it for you.',
    ],
    note: 'Waiting is advice, not a lock: pressing Resume is always your choice, and Flow Pilot never resumes by itself.',
  };
}

// Whether a Resume may go ahead right now. Blockers are the things the report says must hold; the
// cool-down is only a warning, because the decision is the person's.
export function resumeGate({ session = {}, selfCheck = null, workTab = null, plan = {}, now = Date.now(), coolDown: cool = null } = {}) {
  const blockers = [];
  const warnings = [];
  const ready = plan.ready ?? [];
  const waiting = plan.waiting ?? [];

  if (session.halted) {
    blockers.push(`The halt is still set ("${session.haltReason}"). Clear it first — after the cool-down and after you have looked at Flow.`);
  }
  if (!selfCheck) {
    blockers.push('No self-check has run yet. Open your Flow project, press "Use this tab as the work tab" in the popup, then try again.');
  } else if (selfCheck.ok === false) {
    const failed = (selfCheck.checks ?? []).filter((c) => !c.ok).map((c) => c.name).join(', ');
    blockers.push(`The self-check is still failing${failed ? `: ${failed}` : ''}. Flow may have changed; fix that before resuming.`);
  } else if (workTab && selfCheck.tabId !== workTab.tabId) {
    blockers.push('The self-check was run on a different tab than the current work tab. Run it again on the work tab.');
  }

  const advice = cool ?? coolDown({ haltReason: session.haltReason ?? session.lastHalt?.reason ?? '', haltedAt: session.haltedAt ?? session.lastHalt?.at ?? null, now });
  if (advice.remainingMinutes > 0) {
    warnings.push(`The cool-down you were shown has about ${advice.remainingMinutes} min left. Resuming early is your choice — Flow Pilot never resumes by itself.`);
  }
  if (ready.length === 0) {
    warnings.push(`No never-submitted rows are ready to run${waiting.length ? ` (${waiting.length} still waiting for your approval)` : ''}. Nothing will be submitted.`);
  }

  return { ok: blockers.length === 0, blockers, warnings, coolDown: advice, ready: ready.map((j) => ({ id: j.id, name: j.name })), waiting: waiting.length };
}
