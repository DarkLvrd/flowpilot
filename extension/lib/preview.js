// Preview-first: check the look for free before paying for video.
//
// Flow charges 0 credits for Nano Banana stills (recon/FINDINGS.md: every image recipe — NARWHAL,
// GEM_PIX_2, HARBOR_SEAL — costs 0) while video costs credits. So a video job can be created as a
// free still first: the person sees the frame, approves it, and only then does the video job run,
// with that still attached as its first frame through the existing Frames path (no new reference
// kind, no new RPC).
//
// The jobs themselves are built by the one validation path (lib/jobspec.js buildJob — the still as
// an ordinary image job, the video with `holdFirstFrame`); this module holds the two pieces that
// are specific to preview-first: the guarantee that a preview is free, and the promote patch.
import { classifyRef } from './refs.js';

export const isPreviewJob = (job) => job?.role === 'preview';
export const isAwaitingPreview = (job) => job?.state === 'awaiting-preview';

// How many video jobs are held on a still that has not been approved yet.
export function awaitingPreviewCount(jobs) {
  return (jobs ?? []).filter(isAwaitingPreview).length;
}

// A preview must be free: refuse to create one when the image model Flow would run is not 0 credits
// (or its cost is unknown). This is what makes "a preview never spends" true by construction.
export function assertFreePreview(unitCost, recipe) {
  if (unitCost !== 0) {
    const what = unitCost == null ? 'an unknown cost' : `${unitCost} credits`;
    throw new Error(`Preview-first needs a 0-credit still, but ${recipe} reports ${what}`);
  }
}

// The fields to write on a held video job once the person approves its still. The still itself
// hangs on the existing Frames path, so the pre-spend check verifies it by media id like any frame.
export function promotePatch(job, mediaId) {
  const firstFrame = classifyRef(mediaId);
  if (firstFrame.kind !== 'mediaId') throw new Error('A still preview must be a Flow media id, not a path');
  return {
    referencePlan: {
      input: 'frames',
      ingredients: [],
      firstFrame,
      lastFrame: job?.referencePlan?.lastFrame ?? null,
    },
    settings: { ...job.settings, kind: 'video', input: 'frames', firstFrame: firstFrame.mediaId },
  };
}
