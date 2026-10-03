// One pass of the job engine: track what's rendering, download what's ready, then submit at most
// one approved job. Called on alarms and events; every step reads and writes the job store, so a
// pass can stop at any point and the next one carries on (docs/LESSONS.md #18).
//
// Dependencies (all injected, so this is testable without a browser):
//   store    lib/jobs.js store
//   flow     { call(rpcKey, inner) → parseBatchResponse-style result } bound to the work tab
//   driver   { prepare(job) → page observation,
//              clickGenerate(tabId, expect) → { ok, blocked?, error?, notClicked? },
//              inFront(tabId) → whether the tab is visible (Flow only renders in front, LESSONS #23) }
//              (the driver re-checks `expect` in the page and refuses without clicking if it changed)
//   files    { fetchBytes(url) → Uint8Array, save(job, bytes, ext) → saved path }
//   workTab  { get() → { tabId, projectId } | null }
//   refs     { resolve(job) → { ingredients:[mediaId], firstFrame:mediaId|null, lastFrame:mediaId|null } }
//              resolves a job's referencePlan to media ids, uploading any local paths through Flow's
//              own Upload media control (id read from Zzl0ze). Throws to fail the job; sets err.blocked
//              to halt everything. Only called for jobs that have references.

import { RPC } from './rpc.js';
import { parseProjectMedia, parseMediaDetail, findResult } from './media.js';
import { checkBeforeSpend } from './preflight.js';
import { acceptDownload, EXTENSION } from './magic.js';

const CLOCK_SLACK_MS = 2 * 60_000;       // Flow's timestamps vs our clock
const RESULT_TIMEOUT_MS = 30 * 60_000;   // no matching record by then → fail, never retry
const RENDER_TIMEOUT_MS = 60 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000; // since the job last entered `downloading`

class Blocked extends Error {}

// The job's own kind of URL, or null while only other signed URLs are listed (a rendering video may
// have just its poster). Still throws "Flow changed" when the detail has no signed URL at all.
function readyUrl(detail, kind) {
  try {
    return parseMediaDetail(detail, kind).url;
  } catch (e) {
    parseMediaDetail(detail);
    return null;
  }
}

// A job needs a resolution pass only when its plan names real references (Ingredients or Frames).
function needsReferences(job) {
  const p = job.referencePlan;
  return !!p && ((p.ingredients?.length ?? 0) > 0 || !!p.firstFrame || !!p.lastFrame);
}

export function createRunner({ store, flow, driver, files, workTab, refs, settings, now = () => Date.now() }) {
  async function rpc(key, inner) {
    const r = await flow.call(key, inner);
    if (!r.ok && r.kind === 'blocked') throw new Blocked(r.message);
    return r;
  }

  async function track(tab, jobs) {
    const active = jobs.filter((j) => j.projectId === tab.projectId && ['submitted', 'rendering'].includes(j.state));
    if (active.length === 0) return;

    const r = await rpc('projectMedia', [`projects/${tab.projectId}`, null, null, null, [1]]);
    if (!r.ok) throw new Error(`${RPC.projectMedia}: ${r.message}`);
    const media = parseProjectMedia(r.data);
    const claimed = jobs.map((j) => j.mediaId).filter(Boolean);

    for (let job of active) {
      if (job.state === 'submitted') {
        const hit = findResult(media, { prompt: job.prompt, since: job.clickedAt - CLOCK_SLACK_MS, exclude: claimed });
        if (!hit) {
          if (now() - job.clickedAt > RESULT_TIMEOUT_MS) {
            await store.apply(job.id, { type: 'fail', reason: 'No result found in the project within 30 min. Check Flow before re-running; not retried.' });
          }
          continue;
        }
        claimed.push(hit.mediaId);
        job = await store.apply(job.id, { type: 'matched', mediaId: hit.mediaId });
      }
      const detail = await rpc('mediaDetail', [job.mediaId]);
      if (detail.ok && readyUrl(detail.data, job.settings.kind)) {
        await store.apply(job.id, { type: 'ready', mediaId: job.mediaId });
      } else if (now() - job.clickedAt > RENDER_TIMEOUT_MS) {
        await store.apply(job.id, { type: 'fail', reason: `Still not ready after 60 min: ${detail.message ?? `no ${job.settings.kind} URL yet`}` });
      }
    }
  }

  async function download(jobs) {
    for (const job of jobs.filter((j) => j.state === 'downloading')) {
      const detail = await rpc('mediaDetail', [job.mediaId]);
      if (!detail.ok) {
        const since = job.history.findLast((h) => h.state === 'downloading').at;
        if (now() - since > DOWNLOAD_TIMEOUT_MS) {
          await store.apply(job.id, { type: 'fail', reason: `Not downloadable after 15 min: ${detail.message}` });
        }
        continue;
      }
      const { url } = parseMediaDetail(detail.data, job.settings.kind);
      const bytes = await files.fetchBytes(url);
      const check = acceptDownload(bytes, job.settings.kind);
      if (!check.ok) {
        await store.apply(job.id, { type: 'fail', reason: `Download rejected: ${check.reason}` });
        continue;
      }
      let path;
      try {
        path = await files.save(job, bytes, EXTENSION[check.type]);
      } catch (e) {
        // Retrying every tick would re-download the whole result each time; a person can Retry download.
        await store.apply(job.id, { type: 'fail', reason: `Could not save: ${e.message}` });
        continue;
      }
      await store.apply(job.id, { type: 'saved', path, fileType: check.type });
    }
  }

  async function submitNext(tab, jobs) {
    if (jobs.some((j) => j.state === 'submitting')) return;
    const inFlight = jobs.filter((j) => ['submitted', 'rendering'].includes(j.state)).length;
    if (inFlight >= settings.maxInFlight) return;
    const next = jobs.find((j) => j.state === 'approved' && j.projectId === tab.projectId);
    if (!next) return;
    // Approving happens in the dashboard, so the Flow tab is usually behind it at that moment.
    // Wait (job stays approved) until the person brings Flow to the front; never switch tabs for them.
    if (!(await driver.inFront(tab.tabId))) {
      const count = jobs.filter((j) => j.state === 'approved' && j.projectId === tab.projectId).length;
      return {
        waiting: `${count} job${count === 1 ? '' : 's'} waiting: keep the Flow tab in front to submit`,
        waitingCount: count,
        waitingReason: 'front-tab',
      };
    }

    let job = await store.apply(next.id, { type: 'start', tabId: tab.tabId });
    // Resolve and record the job's references before the composer is prepared, so the driver can
    // attach them and the pre-spend check can verify, id for id, that the right ones are attached.
    if (needsReferences(job)) {
      let references;
      try {
        references = await refs.resolve(job);
      } catch (e) {
        if (e.blocked) throw new Blocked(e.blocked);
        await store.apply(job.id, { type: 'fail', reason: `Could not attach references: ${e.message}` });
        return;
      }
      job = await store.setReferences(job.id, references);
    }
    let page;
    try {
      page = await driver.prepare(job);
    } catch (e) {
      await store.apply(job.id, { type: 'fail', reason: `Could not prepare the composer: ${e.message}` });
      return;
    }
    if (page.blocked) throw new Blocked(page.blocked);
    if (page.halt) {
      // Something may have been submitted outside the pre-spend check: record the job as failed
      // (never re-queueable) and stop everything until a person has looked at Flow.
      await store.apply(job.id, { type: 'fail', reason: page.halt, mayHaveSubmitted: true });
      throw new Blocked(page.halt);
    }

    const check = checkBeforeSpend(job, page, await store.session());
    const bound = await workTab.get();
    if (bound?.tabId !== job.tabId || bound?.projectId !== job.projectId) {
      check.ok = false;
      check.problems.push('the work tab changed while the job was being prepared');
    }
    if (!check.ok) {
      await store.apply(job.id, { type: 'fail', reason: `Not submitted: ${check.problems.join('; ')}` });
      return;
    }
    // Write-ahead: from here on this job can never be clicked again.
    await store.apply(job.id, { type: 'clicked', at: now(), cost: page.cost ?? 0 });
    const click = await driver.clickGenerate(job.tabId, { url: page.url, prompt: job.prompt, summaryText: page.summaryText });
    if (click.blocked) throw new Blocked(click.blocked);
    if (click.notClicked) await store.apply(job.id, { type: 'fail', reason: `Not clicked: ${click.error}` });
    else if (!click.ok) await store.apply(job.id, { type: 'fail', reason: `Click may not have happened: ${click.error}. Check Flow; not retried.` });
  }

  return {
    // Returns { error } when a pass stopped early, { waiting } when a job waits for the person;
    // the store holds everything else.
    async tick() {
      const session = await store.session();
      if (session.halted) return {};
      const tab = await workTab.get();
      if (!tab) return {};
      try {
        await track(tab, await store.list());
        await download(await store.list());
        // After a halt that a person cleared, nothing is submitted again until they press Resume:
        // this is the hold that makes "no automatic retry after a block" true for the whole queue,
        // not just for the row that hit the block (report §9.2). Time passing changes nothing.
        if (session.awaitingResume) {
          return { waiting: 'Cool-down: press “Resume rows that were never submitted” in the dashboard when you are ready' };
        }
        return (await submitNext(tab, await store.list())) ?? {};
      } catch (e) {
        if (e instanceof Blocked) {
          await store.halt(e.message);
          return { error: `Halted: ${e.message}` };
        }
        return { error: e.message };
      }
    },
  };
}
