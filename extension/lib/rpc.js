// Flow's batchexecute transport: RPC id table, request body builder, tolerant response reader.
// Flow ships weekly and ids drift (docs/LESSONS.md #20), so every id lives in RPC below and
// every reader fails closed with kind 'flow-changed' instead of guessing.

export const RPC = {
  credits: 'nzlxg',        // [] → [balance?, …]
  catalog: 'HTrJv',        // [] → model families, recipes, credit cost per tier
  videoModels: 'yBhWQ',    // [] → [[[modelKey, enabled], …]]
  project: 'ngNC2',        // ["tools/PINHOLE/projects/<pid>"] → project id, title, defaults
  projectMedia: 'Zzl0ze',  // ["projects/<pid>", null, null, null, [1]] → workflows + media records
  mediaDetail: 'as29s',    // ["<mediaId>"] → media record incl. signed flow-content.google URL
};

export const BATCHEXECUTE_PATH = '/_/AiSandboxAngularFrontend/data/batchexecute';

// Any of these anywhere in a response halts every job (docs/SPEC.md hard rules).
const BLOCK_MARKERS = /UNUSUAL_ACTIVITY|PUBLIC_ERROR_ABUSE|RECAPTCHA_(?:FAILED|INVALID)/;

export function buildFReq(rpcid, inner) {
  return JSON.stringify([[[rpcid, JSON.stringify(inner), null, 'generic']]]);
}

// Returns { ok: true, data } or { ok: false, kind: 'blocked' | 'rpc-error' | 'flow-changed', message }.
// Chunk length prefixes are not trusted; every line that parses as a JSON array is an entry list.
export function parseBatchResponse(text, rpcid) {
  if (typeof text !== 'string' || !text.startsWith(")]}'")) {
    return fail('flow-changed', `${rpcid}: response is not batchexecute`);
  }
  const blocked = text.match(BLOCK_MARKERS);
  if (blocked) return fail('blocked', `${rpcid}: Flow reported ${blocked[0]}`);

  const entries = [];
  for (const line of text.slice(4).split('\n')) {
    if (!line.startsWith('[')) continue;
    try {
      const chunk = JSON.parse(line);
      if (Array.isArray(chunk)) entries.push(...chunk.filter(Array.isArray));
    } catch {
      // A line that isn't JSON is a length prefix or noise; skip it.
    }
  }
  const entry = entries.find((e) => e[0] === 'wrb.fr' && e[1] === rpcid);
  if (!entry) return fail('flow-changed', `${rpcid}: no result for this rpc in the response`);

  if (typeof entry[2] !== 'string') {
    const code = Array.isArray(entry[5]) ? entry[5][0] : 'unknown';
    return fail('rpc-error', `${rpcid}: Flow returned error code ${code}`);
  }
  try {
    return { ok: true, data: JSON.parse(entry[2]) };
  } catch {
    return fail('flow-changed', `${rpcid}: payload is not JSON`);
  }
}

function fail(kind, message) {
  return { ok: false, kind, message };
}
