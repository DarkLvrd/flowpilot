// The Flow health screen: the extension's own self-check, said in plain words, plus where to look
// when a job fails with "Flow changed". No new telemetry — every line comes from a check the
// extension already ran (content/driver.js selfCheck and the page-RPC checks in sw.js).

// One plain sentence per check name, aimed at someone who has never seen Flow's DOM. A check the
// extension does not know yet still shows (with a neutral fallback), so a new check is never
// silently hidden.
export const CHECK_PLAIN = {
  // From the page driver (content/driver.js selfCheck).
  'Agent mode off': "Flow's Agent panel is closed (Flow Pilot never uses it)",
  'Prompt box': "Flow's prompt box is on the page",
  'Start generation button': "Flow's \"Start generation\" button is on the page",
  'Settings trigger': "Flow's settings panel opens",
  'Settings summary readable': "Flow's current mode, resolution and length are readable",
  'Add ingredients button': 'the button that opens the reference picker is on the page',
  'Agent toggle': 'the Agent toggle is on the page',
  'Account details': 'a Flow account is signed in',
  'On a project page': 'this tab is a Flow project page',
  // From the page RPCs and the bridge (sw.js selfCheck).
  'Page driver': "Flow Pilot's page driver is loaded in this tab",
  'Credit balance': 'Flow reports your credit balance',
  'Model catalog': "Flow's model list and credit prices are readable",
  'Omni Flash available': 'Flow offers the Omni Flash video model',
  'Project media': "Flow's project media list is readable",
};

// Shown under the health list. A "Flow changed" failure means Flow's page moved since it was
// captured, and the fix is a read-only re-capture, not a retry.
export const FLOW_CHANGED_HINT = 'If a job fails with "Flow changed", Flow\'s page no longer matches '
  + 'what the extension expects: re-run the read-only capture (node recon/capture.mjs --port 9333) '
  + 'against the practice Chrome, update recon/FINDINGS.md, and check the RPC ids in '
  + 'extension/lib/rpc.js. Do not retry the job first.';

const FALLBACK_PLAIN = 'a check the extension ran on the Flow page';

// [{ ok, name, plain, detail|null }] — the raw check plus its plain-language line.
export function healthLines(selfCheck) {
  return (selfCheck?.checks ?? []).map((c) => ({
    ok: !!c.ok,
    name: c.name,
    plain: CHECK_PLAIN[c.name] ?? FALLBACK_PLAIN,
    detail: c.detail ?? null,
  }));
}

// The whole screen: lines, whether everything passed (only when there was at least one check),
// when the last check ran, the balance it saw, and the failing lines.
export function healthSummary(selfCheck) {
  const lines = healthLines(selfCheck);
  const failing = lines.filter((l) => !l.ok);
  return {
    at: selfCheck?.at ?? null,
    checkedAt: selfCheck?.at ?? null,
    balance: selfCheck?.balance ?? null,
    lines,
    failing,
    ok: lines.length > 0 && failing.length === 0,
  };
}
