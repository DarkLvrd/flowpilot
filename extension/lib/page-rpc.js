// Runs INSIDE the Flow tab's main world via chrome.scripting.executeScript({ world: 'MAIN' }).
// It must stay self-contained: executeScript serialises the function, so no imports or closures.
//
// The request is the same same-origin batchexecute POST the page makes itself, with the page's
// own cookies. The page's XSRF form token (`at`) is read here, used for this one request, and
// never returned, stored or sent anywhere else. No cookies or Authorization headers are touched.
// Only read-only RPCs go through here; generate/upload only ever happen via Flow's own buttons.
export async function pageRpc(rpcid, fReq) {
  const wiz = window.WIZ_global_data || {};
  const at = wiz.SNlM0e;
  const bl = wiz.cfb2h;
  if (!at || !bl) return { status: 0, text: '', error: 'Flow page is not ready (no page config)' };

  const query = new URLSearchParams({
    rpcids: rpcid,
    'source-path': location.pathname,
    bl,
    hl: document.documentElement.lang || 'en',
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: 'c',
  });
  if (wiz.FdrFJe) query.set('f.sid', wiz.FdrFJe);

  try {
    const res = await fetch(`/_/AiSandboxAngularFrontend/data/batchexecute?${query}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
      body: new URLSearchParams({ 'f.req': fReq, at }).toString(),
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: '', error: String(e) };
  }
}
