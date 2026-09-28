// One pass of the job engine: track what's rendering, download what's ready, then submit at most
// one approved job. Called on alarms and events; every step reads and writes the job store, so a
// pass can stop at any point and the next one carries on (docs/LESSONS.md #18).
//
// Dependencies (all injected, so this is testable without a browser):
//   store    lib/jobs.js store
//   flow     { call(rpcKey, inner) → parseBatchResponse-style result } bound to the work tab
//   driver   { prepare(job) → page observation, clickGenerate() → { ok, blocked?, error? } }
//   files    { fetchBytes(url) → Uint8Array, save(job, bytes, ext) → saved path }
//   workTab  { get() → { tabId, projectId } | null }

import { RPC } from './rpc.js';
import { parseProjectMedia, parseMediaDetail, findResult } from './media.js';
import { checkBeforeSpend } from './preflight.js';
import { acceptDownload, EXTENSION } from './magic.js';

const CLOCK_SLACK_MS = 2 * 60_000;       // Flow's timestamps vs our clock
const RESULT_TIMEOUT_MS = 30 * 60_000;   // no matching record by then → fail, never retry
const RENDER_TIMEOUT_MS = 60 * 60_000;

class Blocked extends Error {}

export function createRunner({ store, flow, driver, files, workTab, settings, now = () => Date.now() }) {
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
      if (detail.ok) {
        parseMediaDetail(detail.data); // throws "Flow changed" if there is no signed URL
        await store.apply(job.id, { type: 'ready', mediaId: job.mediaId });
      } else if (now() - job.clickedAt > RENDER_TIMEOUT_MS) {
        await store.apply(job.id, { type: 'fail', reason: `Still not ready after 60 min: ${detail.message}` });
      }
    }
  }

  async function download(jobs) {
    for (const job of jobs.filter((j) => j.state === 'downloading')) {
      const detail = await rpc('mediaDetail', [job.mediaId]);
      if (!detail.ok) continue;
      const { url } = parseMediaDetail(detail.data);
      const bytes = await files.fetchBytes(url);
      const check = acceptDownload(bytes, job.settings.kind);
      if (!check.ok) {
        await store.apply(job.id, { type: 'fail', reason: `Download rejected: ${check.reason}` });
        continue;
      }
      const path = await files.save(job, bytes, EXTENSION[check.type]);
      await store.apply(job.id, { type: 'saved', path, fileType: check.type });
    }
  }

  async function submitNext(tab, jobs) {
    if (jobs.some((j) => j.state === 'submitting')) return;
    const inFlight = jobs.filter((j) => ['submitted', 'rendering'].includes(j.state)).length;
    if (inFlight >= settings.maxInFlight) return;
    const next = jobs.find((j) => j.state === 'approved' && j.projectId === tab.projectId);
    if (!next) return;

    const job = await store.apply(next.id, { type: 'start', tabId: tab.tabId });
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
    if (!check.ok) {
      await store.apply(job.id, { type: 'fail', reason: `Not submitted: ${check.problems.join('; ')}` });
      return;
    }
    // Write-ahead: from here on this job can never be clicked again.
    await store.apply(job.id, { type: 'clicked', at: now(), cost: page.cost ?? 0 });
    const click = await driver.clickGenerate();
    if (click.blocked) throw new Blocked(click.blocked);
    if (!click.ok) await store.apply(job.id, { type: 'fail', reason: `Click may not have happened: ${click.error}. Check Flow; not retried.` });
  }

  return {
    // Returns { error } when a pass stopped early; the store holds everything else.
    async tick() {
      if ((await store.session()).halted) return {};
      const tab = await workTab.get();
      if (!tab) return {};
      try {
        await track(tab, await store.list());
        await download(await store.list());
        await submitNext(tab, await store.list());
        return {};
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
