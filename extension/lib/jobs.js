// Job model and state machine, persisted in chrome.storage (docs/LESSONS.md #18: the MV3 service
// worker dies when idle, so nothing lives only in memory).
//
//   queued → approved → submitting → submitted → rendering → downloading → done
//                          │ (clicked is written BEFORE the real click: write-ahead)
//   any active → failed | halted;  queued/approved/halted/awaiting-preview → cancelled
//   failed (with a result) → downloading
//
// Preview-first: a video job may start held in `awaiting-preview`, waiting on a free still
// (0 credits — Flow charges nothing for Nano Banana images). It can never be submitted in that
// state; the person promotes it with the approved still's media id, which moves it to `approved`
// with the still attached as its first frame. Promoting never clicks and never spends.
//
// The write-ahead click is what makes the machine safe to resume: a job that reached `submitted`
// is never clicked again, even if the click itself never happened. It can only be matched to a
// result or failed. A failed job may be re-queued only if it never clicked.
//
// A halt adds one more hold on top of that: clearing a halt puts the interrupted jobs back to where
// they were, but `session.awaitingResume` keeps any row that never clicked from being submitted
// until a person presses Resume (report §9.2). The engine reads that flag; only `resume()` clears
// it, and only the dashboard calls that.

import { validateQcRecord } from './qc.js';

const KEY = 'flowpilot';
const TERMINAL = new Set(['done', 'failed', 'cancelled']);

const TRANSITIONS = {
  approve: { from: ['queued', 'approved'], to: 'approved' },
  start: { from: ['approved'], to: 'submitting' },
  clicked: { from: ['submitting'], to: 'submitted' },
  matched: { from: ['submitted'], to: 'rendering' },
  ready: { from: ['submitted', 'rendering'], to: 'downloading' },
  saved: { from: ['downloading'], to: 'done' },
  fail: { from: ['queued', 'approved', 'submitting', 'submitted', 'rendering', 'downloading', 'halted', 'awaiting-preview'], to: 'failed' },
  cancel: { from: ['queued', 'approved', 'halted', 'awaiting-preview'], to: 'cancelled' },
  requeue: { from: ['failed'], to: 'queued' },
  retryDownload: { from: ['failed'], to: 'downloading' }, // fetches the finished result again; never clicks
  // The free still was approved: the video may now run from it (the pre-spend check and the cap
  // still gate the actual click). Never spends by itself.
  promote: { from: ['awaiting-preview'], to: 'approved' },
};

// Pure: returns the next job or throws. `session` is read for the cap and halt checks.
export function transition(job, event, session, now = Date.now()) {
  const rule = TRANSITIONS[event.type];
  if (!rule) throw new Error(`Unknown event: ${event.type}`);
  if (job.state === 'halted' && !['fail', 'cancel'].includes(event.type)) {
    throw new Error(`Job ${job.id} is halted; clear the halt from the dashboard first`);
  }
  if (!rule.from.includes(job.state)) throw new Error(`Cannot ${event.type} a job that is ${job.state}`);

  const next = { ...job, state: rule.to, updatedAt: now };
  switch (event.type) {
    case 'start':
      next.tabId = event.tabId;
      break;
    case 'clicked':
      if (session.halted) throw new Error('Queue is halted');
      if (session.cap == null) throw new Error('No session credit cap is set');
      if (session.spent + event.cost > session.cap) {
        throw new Error(`Click refused: ${session.spent} + ${event.cost} credits would pass the cap of ${session.cap}`);
      }
      next.clickedAt = event.at;
      next.cost = event.cost;
      break;
    case 'matched':
      next.mediaId = event.mediaId;
      // Report §5: whether the finished generation really used the Flow Character, read from the
      // record Flow itself returns. Metadata, exactly like `references` — no state change.
      if (event.characterUsed !== undefined) next.characterUsed = event.characterUsed;
      break;
    case 'ready':
      next.mediaId = event.mediaId;
      break;
    case 'saved':
      next.file = { path: event.path, type: event.fileType };
      break;
    case 'fail':
      next.error = event.reason;
      if (event.mayHaveSubmitted) next.mayHaveSubmitted = true;
      break;
    case 'requeue':
      if (job.clickedAt != null) throw new Error(`Job ${job.id} already clicked once; add a new job instead`);
      if (job.mayHaveSubmitted) throw new Error(`Job ${job.id} may have been submitted already; check Flow and add a new job instead`);
      next.error = null;
      break;
    case 'promote':
      next.settings = event.settings;
      next.referencePlan = event.referencePlan;
      next.error = null;
      break;
    case 'retryDownload':
      if (!job.mediaId) throw new Error(`Job ${job.id} has no result in Flow to download`);
      next.error = null;
      // During a halt every active job waits as halted; clearing it resumes the download.
      if (session.halted) Object.assign(next, { state: 'halted', haltedFrom: 'downloading' });
      break;
  }
  next.history = [...job.history, { state: next.state, at: now, ...(event.reason ? { reason: event.reason } : {}) }];
  return next;
}

// `area` has the chrome.storage.local contract: get(key) → { [key]: value }, set({ [key]: value }).
export function createJobStore(area, { now = () => Date.now(), newId = () => crypto.randomUUID() } = {}) {
  let chain = Promise.resolve();

  // Every read-modify-write runs one at a time so concurrent callers never lose writes.
  const update = (fn) => {
    const run = chain.then(async () => {
      const state = await load();
      const result = fn(state);
      await area.set({ [KEY]: state });
      return result;
    });
    chain = run.catch(() => {});
    return run;
  };

  async function load() {
    const stored = (await area.get(KEY))[KEY];
    return stored ?? { jobs: [], session: { cap: null, spent: 0, halted: false, haltReason: null, haltedAt: null, lastHalt: null, awaitingResume: false } };
  }

  const find = (state, id) => {
    const i = state.jobs.findIndex((j) => j.id === id);
    if (i < 0) throw new Error(`No job ${id}`);
    return i;
  };

  return {
    async list() { return (await load()).jobs; },
    async get(id) { return (await load()).jobs.find((j) => j.id === id) ?? null; },
    async session() { return (await load()).session; },

    add(spec) {
      return update((state) => {
        const t = now();
        // `initialState` lets a preview-first video start held (`awaiting-preview`) instead of
        // `queued`; it is not stored on the job.
        const initial = spec.initialState ?? 'queued';
        const state0 = state.session.halted ? 'halted' : initial;
        const job = {
          ...spec,
          id: newId(),
          state: state0,
          haltedFrom: state.session.halted ? initial : undefined,
          tabId: null, clickedAt: null, cost: null, mediaId: null, file: null, error: null,
          createdAt: t, updatedAt: t,
          history: [{ state: state0, at: t }],
        };
        delete job.initialState;
        state.jobs.push(job);
        return job;
      });
    },

    apply(id, event) {
      return update((state) => {
        const i = find(state, id);
        const next = transition(state.jobs[i], event, state.session, now());
        if (event.type === 'clicked') state.session.spent += event.cost;
        state.jobs[i] = next;
        return next;
      });
    },

    // Records the media ids a submitting job's references resolved to (after any local paths were
    // uploaded). Metadata only: the job stays in its current state; the pre-spend check reads it.
    setReferences(id, references) {
      return update((state) => {
        const i = find(state, id);
        state.jobs[i] = { ...state.jobs[i], references, updatedAt: now() };
        return state.jobs[i];
      });
    },

    // The QC verdict on a finished clip (report §2.6): job metadata, written exactly like
    // `references` above — the state machine, its history and the spend never move. The record is
    // validated here (the store is the only writer), and `technical` was computed from the job by
    // the caller, never taken on trust from a person or an agent.
    setQc(id, qc) {
      return update((state) => {
        validateQcRecord(qc);
        const i = find(state, id);
        state.jobs[i] = { ...state.jobs[i], qc, updatedAt: now() };
        return state.jobs[i];
      });
    },

    // Only the dashboard may call this (docs/SPEC.md decision 8); the caller enforces who.
    setCap(cap) {
      return update((state) => { state.session.cap = cap; return state.session; });
    },

    halt(reason) {
      return update((state) => {
        state.session.halted = true;
        state.session.haltReason = reason;
        state.session.haltedAt = now();
        state.session.lastHalt = { reason, at: state.session.haltedAt };
        // A halt supersedes any earlier hold: the rows about to be interrupted decide the next one.
        state.session.awaitingResume = false;
        const t = now();
        state.jobs = state.jobs.map((j) => (TERMINAL.has(j.state) || j.state === 'halted' ? j : {
          ...j, state: 'halted', haltedFrom: j.state, updatedAt: t,
          history: [...j.history, { state: 'halted', at: t, reason }],
        }));
        return state.session;
      });
    },

    clearHalt() {
      return update((state) => {
        state.session.halted = false;
        state.session.haltReason = null;
        const t = now();
        state.jobs = state.jobs.map((j) => {
          if (j.state !== 'halted') return j;
          // A submit that was interrupted before its write-ahead click never clicked.
          const back = j.haltedFrom === 'submitting' ? 'approved' : j.haltedFrom;
          return { ...j, state: back, haltedFrom: undefined, updatedAt: t, history: [...j.history, { state: back, at: t }] };
        });
        // Any row that never reached Flow waits for a deliberate Resume instead of running off the
        // next alarm tick. Rows already on Flow's side carry on to their result as before.
        state.session.awaitingResume = state.jobs.some((j) => j.clickedAt == null && !j.mayHaveSubmitted && ['queued', 'approved'].includes(j.state));
        return state.session;
      });
    },

    // The dashboard's Resume press: release the hold. It never submits anything itself and never
    // re-submits a row that already clicked — the engine's ordinary checks do the rest.
    resume() {
      return update((state) => {
        state.session.awaitingResume = false;
        return state.session;
      });
    },

    // Call once when the service worker starts.
    recover() {
      return update((state) => {
        const t = now();
        state.jobs = state.jobs.map((j) => (j.state !== 'submitting' ? j : {
          ...j, state: 'approved', updatedAt: t, history: [...j.history, { state: 'approved', at: t, reason: 'restart before click' }],
        }));
      });
    },
  };
}
