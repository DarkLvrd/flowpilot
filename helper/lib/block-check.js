// Jev second opinion on Flow's alert and snackbar messages that the driver's block regex didn't
// match: does this message mean the account is being limited or blocked? One Noul question per
// message, all in one TypeSafe request. Additive only (docs/SPEC.md hard rules): a sure "yes"
// halts; anything else, including a failed call, adds nothing and never clears a halt.
// The API key comes from the caller (TYPESAFE_API_KEY in the helper's env) and is only ever
// sent in the Authorization header.

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
// Chosen from helper/test/fixtures/flow-notices.json (scripts/calibrate-block-check.mjs, 2026-09-28):
// with this wording, account-limit messages scored 0.50-0.96 and everything else 0.26 or less,
// stable within 0.02 across runs. Low on purpose: a false halt only costs clearing it from the dashboard.
export const HALT_AT = 0.4;
const BUSY = new Set([429, 529]);
const TRIES = 4;                 // 1 call + 3 retries, waiting 1 s, 2 s, 4 s
const TIMEOUT_MS = 10_000;       // per call: the job engine waits on this, so a hung call must end

const STATE = { app: "Google Flow (Google's AI video and image generator), web app", source: 'an alert or snackbar shown on the page' };

// The message goes inside its own question: pointing at a shared list by index let Jev blur
// neighbouring messages.
function question(message) {
  return {
    type: 'noul',
    instructions: {
      message,
      question: "Is the Google Flow message `message` a warning that Google is limiting, throttling, flagging or blocking this account's use of Flow?",
    },
    criteria: {
      true: 'Account-level limit or flag: unusual or suspicious activity detected, too many requests or rate limited, a usage limit, quota or credits used up, a verification challenge, or the account restricted or suspended.',
      false: 'Anything else: status, progress, success, a warning that credits are running low, a problem with this one request (its prompt, file, or content policy), a network or server error, or a general failure that does not point at the account.',
    },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createBlockJudge({ fetch = globalThis.fetch, apiKey, threshold = HALT_AT, sleep = wait, timeoutMs = TIMEOUT_MS }) {
  async function post(body) {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!BUSY.has(res.status) || attempt === TRIES - 1) return res;
      await sleep(1000 * 2 ** attempt);
    }
  }

  return {
    // texts: message strings seen on the page. Returns { halt, message?, p?, scores?, error? }; `error`
    // means Jev gave no usable answer, which never counts as "not blocked".
    async check(texts) {
      const notices = [...new Set(texts.map((t) => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean))];
      if (notices.length === 0) return { halt: false };
      const questions = Object.fromEntries(notices.map((message, i) => [`n${i}`, question(message)]));
      let res;
      try {
        res = await post(JSON.stringify({ state: STATE, model: 'jev-latest', questions }));
      } catch (e) {
        return { halt: false, error: `Jev unreachable: ${e.message}` };
      }
      if (!res.ok) return { halt: false, error: `Jev answered HTTP ${res.status}` };
      const answers = (await res.json().catch(() => null))?.answers;
      const scored = notices.map((message, i) => ({ message, p: answers?.[`n${i}`]?.noul }));
      if (!scored.every(({ p }) => typeof p === 'number' && p >= 0 && p <= 1)) {
        return { halt: false, error: 'Jev gave no usable answer' };
      }
      const top = scored.reduce((a, b) => (b.p > a.p ? b : a));
      return top.p >= threshold
        ? { halt: true, message: top.message, p: top.p, scores: scored }
        : { halt: false, p: top.p, scores: scored };
    },
  };
}
