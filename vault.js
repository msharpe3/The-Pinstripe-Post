/* The Pinstripe Post — hidden "On this day in Yankees history".
   Tap the header logo 4 times (Gehrig's No. 4) for today's moment.
   Long-press the logo for 2 seconds for a random one. */
(function () {
  "use strict";
  const H = window.PP_HISTORY || [];
  const logo = document.querySelector(".logo-badge");
  const dlg = document.getElementById("vaultDlg");
  if (!logo || !dlg || !H.length) return;

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const card = dlg.querySelector(".vcard");
  const back = dlg.querySelector(".vback");

  let list = [], idx = 0, mode = "today";
  // The tap (or long-press release) that opens the card is followed by a click that lands on the
  // backdrop. Ignore backdrop clicks until shortly after that finger lifts.
  let ignoreUntil = 0, fingerDown = false;

  function todayET() {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "numeric", day: "numeric" }).formatToParts(new Date());
    return { m: +p.find((x) => x.type === "month").value, d: +p.find((x) => x.type === "day").value };
  }

  function shuffle(a) { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  function render() {
    const e = list[idx];
    const t = todayET();
    const label = mode === "today" ? "On this day" : "From the vault";
    const note = mode === "today" && e._fallback
      ? `<p class="v-note">Nothing big happened on ${MONTHS[t.m - 1]} ${t.d}. Here's a classic instead.</p>` : "";
    back.innerHTML = `
      <div class="v-top"><span>${label}</span><span>${esc(MONTHS[e.m - 1])} ${e.d}</span></div>
      <div class="v-year">${e.y}</div>
      <h2 class="v-title" id="vTitle">${esc(e.title)}</h2>
      ${note}
      <p class="v-text">${esc(e.text)}</p>
      <div class="v-foot">
        ${list.length > 1 ? `<button type="button" class="v-btn" data-v="next">${mode === "today" && !e._fallback ? `Next moment (${idx + 1} of ${list.length})` : "Another moment"}</button>` : ""}
        ${mode === "today" ? `<button type="button" class="v-btn ghost" data-v="random">Random moment</button>` : ""}
      </div>`;
  }

  function open(which) {
    mode = which;
    ignoreUntil = fingerDown ? Infinity : Date.now() + 500;
    if (which === "today") {
      const t = todayET();
      list = H.filter((e) => e.m === t.m && e.d === t.d).sort((a, b) => a.y - b.y);
      if (!list.length) list = shuffle(H).map((e) => ({ ...e, _fallback: true }));
    } else {
      list = shuffle(H);
    }
    idx = 0;
    render();
    card.classList.remove("flipped");
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
    if (navigator.vibrate) navigator.vibrate(15);
    // Flip after the card has appeared face-up, like turning over a baseball card.
    if (reduce) card.classList.add("flipped");
    else requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => card.classList.add("flipped"), 250)));
  }

  function close() { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }

  dlg.addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (b) {
      e.stopPropagation();
      if (b.dataset.v === "next") { idx = (idx + 1) % list.length; render(); }
      else if (b.dataset.v === "random") { mode = "random"; list = shuffle(H); idx = 0; render(); }
      else if (b.dataset.v === "close") close();
      return;
    }
    if (e.target === dlg && Date.now() > ignoreUntil) close(); // tap outside the card
  });

  // ---- Hidden triggers on the logo ----
  let taps = 0, tapTimer = null, pressTimer = null, longFired = false, startX = 0, startY = 0;

  document.addEventListener("pointerdown", () => { fingerDown = true; }, true);
  document.addEventListener("pointerup", () => {
    fingerDown = false;
    if (ignoreUntil === Infinity) ignoreUntil = Date.now() + 500;
  }, true);
  document.addEventListener("pointercancel", () => { fingerDown = false; if (ignoreUntil === Infinity) ignoreUntil = Date.now() + 500; }, true);

  logo.addEventListener("pointerdown", (e) => {
    longFired = false;
    startX = e.clientX; startY = e.clientY;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { longFired = true; taps = 0; open("random"); }, 2000);
  });
  logo.addEventListener("pointermove", (e) => {
    if (Math.abs(e.clientX - startX) > 12 || Math.abs(e.clientY - startY) > 12) clearTimeout(pressTimer); // scrolling, not pressing
  });
  ["pointerleave", "pointercancel"].forEach((ev) => logo.addEventListener(ev, () => clearTimeout(pressTimer)));
  logo.addEventListener("pointerup", () => {
    clearTimeout(pressTimer);
    if (longFired) return;
    taps++;
    clearTimeout(tapTimer);
    if (taps >= 4) { taps = 0; open("today"); return; }
    tapTimer = setTimeout(() => (taps = 0), 700); // taps must come in quick succession
  });
  logo.addEventListener("contextmenu", (e) => e.preventDefault());
})();
