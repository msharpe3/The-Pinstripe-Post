/* The Pinstripe Post — push alert settings.
   Talks to the alert service (Cloudflare Worker) whose address is in config.js. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const SERVICE = (window.PP_ALERTS_URL || "").replace(/\/$/, "");
  const PREFS = [
    ["start", "Game starting soon", "30 minutes before first pitch, with the channel"],
    ["lineup", "Lineup posted", "The Yankees batting order"],
    ["runs", "Yankees score", "Every Yankees run, with the play"],
    ["lead", "Other team ties or takes the lead", ""],
    ["final", "Final score", "Plus the series score in the playoffs"],
  ];
  const dlg = $("alertsDlg"), body = $("alBody");
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  let reg = null;

  function loadPrefs() {
    try { return Object.assign({ start: true, lineup: true, runs: true, lead: true, final: true }, JSON.parse(localStorage.getItem("pp-alert-prefs") || "{}")); }
    catch (e) { return { start: true, lineup: true, runs: true, lead: true, final: true }; }
  }
  function savePrefs(p) { try { localStorage.setItem("pp-alert-prefs", JSON.stringify(p)); } catch (e) { /* not saved locally */ } }

  async function call(path, data) {
    const res = await fetch(SERVICE + path, data ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) } : {});
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || "The alert service returned an error (" + res.status + ").");
    return out;
  }

  function b64ToBytes(s) {
    const p = (s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(p), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function registration() {
    if (reg) return reg;
    reg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    return reg;
  }

  async function currentSub() {
    if (!supported) return null;
    try { return await (await registration()).pushManager.getSubscription(); } catch (e) { return null; }
  }

  function setBtn(on) {
    $("alertsBtnText").textContent = on ? "Alerts on" : "Game alerts";
    $("alertsBtn").classList.toggle("on", !!on);
  }

  function msg(text, kind) { const el = $("alMsg"); if (el) { el.textContent = text; el.className = "al-msg " + (kind || ""); } }

  function steps(html) { body.innerHTML = html; }

  async function render() {
    if (!SERVICE) {
      return steps(`<div class="notice">Alerts are almost ready. The alert service hasn't been connected yet. Check back after setup is finished.</div>`);
    }
    if (isIOS && !standalone) {
      return steps(`<p>On iPhone, alerts only work when the site is opened from your Home Screen:</p>
        <ol class="al-steps"><li>In Safari, tap the <b>Share</b> button.</li><li>Tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
        <li>Open The Pinstripe Post from the new icon, then tap <b>Game alerts</b> again.</li></ol>
        <p class="al-fine">Requires iOS 16.4 or later.</p>`);
    }
    if (!supported) return steps(`<div class="notice">This browser doesn't support notifications. Try Safari on iPhone (from the Home Screen icon), or Chrome or Edge on a computer.</div>`);
    if (Notification.permission === "denied") {
      return steps(`<div class="notice">Notifications are blocked for this site. On iPhone, go to <b>Settings → Notifications → The Pinstripe Post</b> and turn on <b>Allow Notifications</b>, then come back here.</div>`);
    }
    const sub = await currentSub();
    setBtn(!!sub);
    if (!sub) {
      return steps(`<button type="button" class="btn" id="alOn">Turn on alerts</button><p class="al-msg" id="alMsg" role="status"></p>
        <p class="al-fine">Your phone will ask for permission. You can pick which alerts you want next.</p>`);
    }
    const prefs = loadPrefs();
    steps(`<fieldset class="al-prefs"><legend>Send me</legend>
        ${PREFS.map(([k, label, hint]) => `<label class="al-row" for="al-${k}"><span><b>${label}</b>${hint ? `<small>${hint}</small>` : ""}</span>
          <input type="checkbox" class="switch" id="al-${k}" data-k="${k}" ${prefs[k] ? "checked" : ""}></label>`).join("")}
      </fieldset>
      <div class="row" style="margin-top:14px"><button type="button" class="btn" id="alTest">Send test alert</button><button type="button" class="btn ghost" id="alOff">Turn off alerts</button></div>
      <p class="al-msg" id="alMsg" role="status"></p>`);
  }

  async function turnOn() {
    const btn = $("alOn"); if (btn) btn.disabled = true;
    msg("Asking for permission…");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { msg("Notifications weren't allowed, so alerts stay off.", "bad"); await render(); return; }
      const { publicKey } = await call("/vapid");
      const r = await registration();
      let sub = await r.pushManager.getSubscription();
      if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
      await call("/subscribe", { subscription: sub.toJSON(), prefs: loadPrefs() });
      await render();
      msg("Alerts are on. Tap Send test alert to try one.", "good");
    } catch (e) {
      msg("Couldn't turn on alerts: " + e.message, "bad");
      if (btn) btn.disabled = false;
    }
  }

  async function turnOff() {
    try {
      const sub = await currentSub();
      if (sub) { await call("/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
      setBtn(false);
      await render();
      msg("Alerts are off on this phone.", "good");
    } catch (e) { msg("Couldn't turn off alerts: " + e.message, "bad"); }
  }

  async function test() {
    const b = $("alTest"); b.disabled = true; msg("Sending…");
    try {
      const sub = await currentSub();
      const out = await call("/test", { endpoint: sub.endpoint });
      msg(out.ok ? "Sent. It should appear in a few seconds. If it doesn't, check Settings → Notifications → The Pinstripe Post." : "The push service didn't accept it (code " + out.status + "). Try turning alerts off and on.", out.ok ? "good" : "bad");
    } catch (e) { msg("Couldn't send a test: " + e.message, "bad"); }
    b.disabled = false;
  }

  let saveTimer = null;
  async function changePref(input) {
    const p = loadPrefs(); p[input.dataset.k] = input.checked; savePrefs(p);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try { const sub = await currentSub(); await call("/prefs", { endpoint: sub.endpoint, prefs: loadPrefs() }); msg("Saved.", "good"); }
      catch (e) { msg("Couldn't save: " + e.message, "bad"); }
    }, 400);
  }

  body.addEventListener("click", (e) => {
    if (e.target.id === "alOn") turnOn();
    else if (e.target.id === "alOff") turnOff();
    else if (e.target.id === "alTest") test();
  });
  body.addEventListener("change", (e) => { if (e.target.matches("input[data-k]")) changePref(e.target); });

  $("alertsBtn").addEventListener("click", async () => {
    steps(`<p class="empty">Checking…</p>`);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    await render();
  });
  $("alClose").addEventListener("click", () => (dlg.close ? dlg.close() : dlg.removeAttribute("open")));
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

  // Show "Alerts on" in the header if this phone is already signed up.
  if (supported && SERVICE && (!isIOS || standalone)) currentSub().then((s) => setBtn(!!s));
})();
