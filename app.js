/* The Pinstripe Post — live Yankees hub
   Data: MLB Stats API (statsapi.mlb.com), fetched directly in the browser. */
(function () {
  "use strict";

  const API = "https://statsapi.mlb.com";
  const NYY = 147;
  const AL_EAST = 201;
  const TZ = "America/New_York";

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Streaming services that carry each TV network's games.
  const STREAMS = {
    "YES": "Gotham Sports app",
    "NBC": "Peacock",
    "Peacock": "Peacock",
    "FOX": "Fox One",
    "FS1": "Fox One",
    "ESPN": "ESPN app",
    "ESPN2": "ESPN app",
    "TBS": "HBO Max",
    "truTV": "HBO Max",
    "Apple TV": "Apple TV",
    "Netflix": "Netflix",
    "MLB Network": "MLB.TV (out of market)",
    "Amazon Prime Video": "Prime Video",
    "Prime Video": "Prime Video",
  };

  /* ---------------- Helpers ---------------- */
  function ymd(d) { return d.toLocaleDateString("en-CA", { timeZone: TZ }); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function fmtDateTime(iso) {
    return new Date(iso).toLocaleString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
  }
  function fmtTime(iso) { return new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) + " ET"; }
  function fmtShort(iso) { return new Date(iso).toLocaleDateString("en-US", { timeZone: TZ, month: "short", day: "numeric" }); }

  async function api(path) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(API + path, { signal: ctrl.signal });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } finally { clearTimeout(t); }
  }

  const side = (g) => (g.teams.home.team.id === NYY ? "home" : "away");
  const other = (s) => (s === "home" ? "away" : "home");
  const isOff = (g) => /Postponed|Cancelled|Suspended/i.test(g.status.detailedState || "");
  const state = (g) => (isOff(g) ? "off" : g.status.abstractGameState); // Preview | Live | Final | off

  /* ---------------- Tabs ---------------- */
  const TABS = ["game", "scores", "roster", "news"];
  function showTab(name) {
    TABS.forEach((t) => { $("t-" + t).setAttribute("aria-selected", String(t === name)); $("p-" + t).hidden = t !== name; });
    try { localStorage.setItem("pp-tab", name); } catch (e) { /* storage unavailable */ }
  }
  TABS.forEach((t) => $("t-" + t).addEventListener("click", () => { showTab(t); history.replaceState(null, "", "#" + t); }));
  let startTab = location.hash.slice(1);
  if (!TABS.includes(startTab)) { try { startTab = localStorage.getItem("pp-tab") || "game"; } catch (e) { startTab = "game"; } }
  showTab(TABS.includes(startTab) ? startTab : "game");

  /* ---------------- State ---------------- */
  let games = [];          // all games in the schedule window
  let focus = null;        // live, else next, else last game
  let lastFinal = null;
  let pitcherCache = {};
  let cdTimer = null, liveTimer = null, schedTimer = null;

  /* ---------------- Schedule ---------------- */
  async function loadSchedule() {
    const now = new Date();
    const q = `/api/v1/schedule?sportId=1&teamId=${NYY}&startDate=${ymd(addDays(now, -12))}&endDate=${ymd(addDays(now, 14))}` +
      `&hydrate=team,linescore,broadcasts(all),probablePitcher,decisions,seriesStatus`;
    const data = await api(q);
    games = (data.dates || []).flatMap((d) => d.games || []).sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate));

    const live = games.find((g) => state(g) === "Live");
    const upcoming = games.filter((g) => state(g) === "Preview");
    const finals = games.filter((g) => state(g) === "Final");
    lastFinal = finals[finals.length - 1] || null;
    focus = live || upcoming[0] || lastFinal;

    renderGame();
    renderList();
    renderLast();
    if (focus) loadLineup(focus);
    scheduleNext(!!live);
  }

  function scheduleNext(isLive) {
    clearTimeout(schedTimer); clearInterval(liveTimer);
    if (isLive) {
      liveTimer = setInterval(refreshLive, 15000);
      schedTimer = setTimeout(safeLoad, 60000);
    } else {
      // Check more often when first pitch is close.
      let wait = 5 * 60000;
      if (focus && state(focus) === "Preview") {
        const ms = new Date(focus.gameDate) - Date.now();
        if (ms < 20 * 60000) wait = 60000;
      }
      schedTimer = setTimeout(safeLoad, wait);
    }
  }

  async function refreshLive() {
    if (!focus || document.hidden) return;
    try {
      const ls = await api(`/api/v1/game/${focus.gamePk}/linescore`);
      focus.linescore = ls;
      focus.teams.home.score = ls.teams?.home?.runs ?? focus.teams.home.score;
      focus.teams.away.score = ls.teams?.away?.runs ?? focus.teams.away.score;
      renderGame(true);
      stamp();
    } catch (e) { /* keep last good data; next tick retries */ }
  }

  /* ---------------- Game card ---------------- */
  function oppName(g) { return g.teams[other(side(g))].team; }

  function titleFor(g) {
    const s = side(g), opp = oppName(g);
    if (g.gameType && g.gameType !== "R" && g.seriesDescription) {
      return `${g.seriesDescription}${g.seriesGameNumber ? " · Game " + g.seriesGameNumber : ""}`;
    }
    return `${s === "home" ? "vs." : "at"} ${opp.teamName || opp.name}`;
  }

  async function pitcherLine(p) {
    if (!p) return { name: "TBD", line: "" };
    if (pitcherCache[p.id]) return pitcherCache[p.id];
    let line = "";
    try {
      const d = await api(`/api/v1/people/${p.id}?hydrate=stats(group=[pitching],type=[season])`);
      const st = d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
      if (st) line = `${st.wins}-${st.losses}, ${st.era} ERA, ${st.strikeOuts} K`;
    } catch (e) { /* stats optional */ }
    return (pitcherCache[p.id] = { name: p.fullName, line });
  }

  function diamondSVG(ls) {
    const o = ls.offense || {};
    const b = (on, x, y) => `<rect class="base${on ? " on" : ""}" x="${x}" y="${y}" width="18" height="18" transform="rotate(45 ${x + 9} ${y + 9})"/>`;
    return `<svg class="diamond" viewBox="0 0 112 96" role="img" aria-label="Runners on base">
      ${b(!!o.second, 47, 8)}${b(!!o.third, 14, 40)}${b(!!o.first, 80, 40)}
      <path class="home" d="M49 74h14v8l-7 7-7-7z"/></svg>`;
  }

  function dots(label, n, max) {
    let s = `<div class="dots"><b>${label}</b>`;
    for (let i = 0; i < max; i++) s += `<span class="${i < n ? "on" : ""}"></span>`;
    return s + "</div>";
  }

  async function renderGame(liveOnly) {
    const g = focus;
    const card = $("gameCard");
    if (!g) {
      card.innerHTML = `<span class="pill">Offseason</span><h2 style="margin-top:10px">No games scheduled</h2>
        <p class="empty" style="margin-top:6px">Check back when the schedule is set. Roster moves and news are still updating.</p>`;
      $("watchCard").hidden = true; $("lineupCard").hidden = true;
      return;
    }
    $("watchCard").hidden = false;
    const s = side(g), o = other(s), st = state(g);
    const opp = oppName(g);
    const nyyR = g.teams[s].score ?? 0, oppR = g.teams[o].score ?? 0;
    const ls = g.linescore || {};

    let pill;
    if (st === "Live") pill = `<span class="pill live">Live · ${esc((ls.inningState || "") + " " + (ls.currentInningOrdinal || ""))}</span>`;
    else if (st === "Final") pill = `<span class="pill ${nyyR > oppR ? "win" : "loss"}">Final · ${nyyR > oppR ? "Yankees win" : "Yankees lose"}</span>`;
    else if (st === "off") pill = `<span class="pill">${esc(g.status.detailedState)}</span>`;
    else pill = `<span class="pill">Next game</span>`;

    const mid = st === "Preview" || st === "off" ? `<div class="vs">${s === "home" ? "VS" : "AT"}</div>` : `<div class="score num">${nyyR}–${oppR}</div>`;
    const series = g.seriesStatus?.description ? `<span class="pill">${esc(g.seriesStatus.description)}</span>` : "";
    const nyyRec = g.teams[s].leagueRecord, oppRec = g.teams[o].leagueRecord;

    let liveBlock = "";
    if (st === "Live" && ls.inningState) {
      const batter = ls.offense?.batter?.fullName, pitcher = ls.defense?.pitcher?.fullName;
      liveBlock = `<div class="live-wrap">${diamondSVG(ls)}<div class="count">
        ${dots("Balls", ls.balls || 0, 4)}${dots("Strikes", ls.strikes || 0, 3)}${dots("Outs", ls.outs || 0, 3)}
        ${batter ? `<div class="matchup-now">AB <b>${esc(batter)}</b>${pitcher ? ` vs. <b>${esc(pitcher)}</b>` : ""}</div>` : ""}
      </div></div>`;
    }

    card.innerHTML = `
      <div class="row" style="justify-content:space-between">${pill}${series}</div>
      <h2 style="margin-top:10px">${esc(titleFor(g))}</h2>
      <div class="eyebrow" style="margin-top:4px">${esc(fmtDateTime(g.gameDate))} · ${esc(g.venue?.name || "")}</div>
      <div class="matchup">
        <div class="team"><b>NYY</b><span>Yankees${nyyRec ? " · " + nyyRec.wins + "-" + nyyRec.losses : ""}</span></div>
        ${mid}
        <div class="team r"><b>${esc(opp.abbreviation || "")}</b><span>${esc(opp.teamName || opp.name)}${oppRec ? " · " + oppRec.wins + "-" + oppRec.losses : ""}</span></div>
      </div>
      ${liveBlock}
      ${st === "Preview" ? `<div class="countdown" id="cd"></div>` : ""}
      <div class="probables" id="probables"></div>`;

    $("gamedayBtn").href = `https://www.mlb.com/gameday/${g.gamePk}`;
    startCountdown(g);
    if (!liveOnly) renderWatch(g);

    // Probable starters (before the game) or decisions (after)
    const pp = $("probables");
    if (st === "Preview") {
      const [a, b] = await Promise.all([pitcherLine(g.teams[s].probablePitcher), pitcherLine(g.teams[o].probablePitcher)]);
      if (!$("probables")) return;
      pp.innerHTML = `<div class="prob"><div class="eyebrow">Yankees starter</div><div class="n">${esc(a.name)}</div><div class="l">${esc(a.line)}</div></div>
        <div class="prob opp"><div class="eyebrow">${esc(opp.abbreviation || "Opp")} starter</div><div class="n">${esc(b.name)}</div><div class="l">${esc(b.line)}</div></div>`;
    } else if (st === "Final" && g.decisions) {
      const d = g.decisions;
      pp.innerHTML = `<div class="prob"><div class="eyebrow">Win</div><div class="n">${esc(d.winner?.fullName || "—")}</div></div>
        <div class="prob opp"><div class="eyebrow">Loss</div><div class="n">${esc(d.loser?.fullName || "—")}</div></div>`;
    } else pp.remove();
  }

  function startCountdown(g) {
    clearInterval(cdTimer);
    if (state(g) !== "Preview") return;
    const tick = () => {
      const el = $("cd"); if (!el) return clearInterval(cdTimer);
      const ms = new Date(g.gameDate) - Date.now();
      if (ms <= 0) { el.innerHTML = `<div style="flex:1"><b>First pitch</b><small>Updating shortly</small></div>`; return; }
      const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, sec = Math.floor(ms / 1e3) % 60;
      el.innerHTML = [["Days", d], ["Hrs", h], ["Min", m], ["Sec", sec]]
        .map(([k, v]) => `<div><b class="num">${String(v).padStart(2, "0")}</b><small>${k}</small></div>`).join("");
    };
    tick(); cdTimer = setInterval(tick, 1000);
  }

  /* ---------------- Where to watch ---------------- */
  function renderWatch(g) {
    const s = side(g);
    const list = (g.broadcasts || []).filter((b) => b.isNational || b.homeAway === s);
    const uniq = (arr) => [...new Set(arr)];
    const tvEn = uniq(list.filter((b) => b.type === "TV" && b.language !== "es").map((b) => b.name));
    const tvEs = uniq(list.filter((b) => b.type === "TV" && b.language === "es").map((b) => b.name));
    const radioEn = uniq(list.filter((b) => (b.type === "AM" || b.type === "FM") && b.language !== "es").map((b) => b.name));
    const radioEs = uniq(list.filter((b) => (b.type === "AM" || b.type === "FM") && b.language === "es").map((b) => b.name));
    const streams = uniq(tvEn.flatMap((n) => Object.keys(STREAMS).filter((k) => n.includes(k)).map((k) => STREAMS[k])));

    const box = (k, v, d) => (v ? `<div class="w"><span class="k">${k}</span><span class="v">${esc(v)}</span>${d ? `<span class="d">${esc(d)}</span>` : ""}</div>` : "");
    const html =
      box("TV", tvEn.join(" · "), list.some((b) => b.isNational && b.type === "TV") ? "National broadcast" : "") +
      box("Stream", streams.join(" · ") || (tvEn.length ? "" : ""), "Subscription may be required") +
      box("Radio", radioEn.join(" · "), "") +
      box("En español", [...tvEs, ...radioEs].join(" · "), "");
    $("watch").innerHTML = html || `<p class="empty">Broadcasts haven't been posted yet. They usually appear a few days before the game.</p>`;
    $("watchWhen").textContent = state(g) === "Preview" ? fmtTime(g.gameDate) : "";
  }

  /* ---------------- Lineup + performers ---------------- */
  async function loadLineup(g) {
    const st = state(g);
    if (st !== "Preview" && st !== "Live") { $("lineupCard").hidden = true; return; }
    try {
      const box = await api(`/api/v1/game/${g.gamePk}/boxscore`);
      const t = box.teams[side(g)];
      const order = t.battingOrder || [];
      if (!order.length) { $("lineupCard").hidden = true; return; }
      $("lineup").innerHTML = order.map((id) => {
        const p = t.players["ID" + id];
        return `<li>${esc(p?.person?.fullName)}<em>${esc(p?.position?.abbreviation)}</em></li>`;
      }).join("");
      $("lineupCard").hidden = false;
    } catch (e) { $("lineupCard").hidden = true; }
  }

  async function renderLast() {
    const g = lastFinal;
    if (!g) { $("lastCard").hidden = true; return; }
    $("lastCard").hidden = false;
    const s = side(g), o = other(s);
    const opp = oppName(g);
    const nyyR = g.teams[s].score, oppR = g.teams[o].score;
    $("lastTitle").textContent = `Last game · ${fmtShort(g.gameDate)} · ${nyyR > oppR ? "W" : "L"} ${nyyR}-${oppR} ${s === "home" ? "vs." : "at"} ${opp.abbreviation}`;

    const ls = g.linescore || {};
    const inn = ls.innings || [];
    const n = Math.max(9, inn.length);
    const cells = (key) => Array.from({ length: n }, (_, i) => {
      const x = inn[i]?.[key];
      return `<td>${x && x.runs != null ? x.runs : i < inn.length ? "X" : ""}</td>`;
    }).join("");
    const row = (key, abbr, us) => {
      const tt = ls.teams?.[key] || {};
      return `<tr class="${us ? "us" : ""}"><td>${esc(abbr)}</td>${cells(key)}<td class="rhe">${tt.runs ?? ""}</td><td class="rhe">${tt.hits ?? ""}</td><td class="rhe">${tt.errors ?? ""}</td></tr>`;
    };
    const awayAbbr = g.teams.away.team.abbreviation, homeAbbr = g.teams.home.team.abbreviation;
    $("lineTbl").innerHTML = `<tr><th></th>${Array.from({ length: n }, (_, i) => `<th>${i + 1}</th>`).join("")}<th>R</th><th>H</th><th>E</th></tr>` +
      row("away", awayAbbr, s === "away") + row("home", homeAbbr, s === "home");

    const d = g.decisions || {};
    $("decisions").innerHTML = [["W", d.winner], ["L", d.loser], ["SV", d.save]]
      .filter(([, p]) => p).map(([k, p]) => `<span class="pill">${k}: ${esc(p.fullName)}</span>`).join("");

    try {
      const box = await api(`/api/v1/game/${g.gamePk}/boxscore`);
      const players = Object.values(box.teams[s].players || {});
      const hitters = players.filter((p) => p.stats?.batting?.atBats != null && (p.stats.batting.atBats > 0 || p.stats.batting.baseOnBalls > 0))
        .map((p) => { const b = p.stats.batting; return { p, b, score: b.hits + 2 * b.homeRuns + b.rbi + b.runs * 0.5 }; })
        .sort((a, b) => b.score - a.score).slice(0, 2);
      const pitchers = players.filter((p) => p.stats?.pitching?.inningsPitched)
        .map((p) => { const x = p.stats.pitching; return { p, x, score: parseFloat(x.inningsPitched) * 1.5 + x.strikeOuts - x.earnedRuns * 2 }; })
        .sort((a, b) => b.score - a.score).slice(0, 1);
      const lines = [
        ...hitters.map(({ p, b }) => ({ name: p.person.fullName, line: `${b.hits}-${b.atBats}${b.homeRuns ? `, ${b.homeRuns} HR` : ""}${b.rbi ? `, ${b.rbi} RBI` : ""}${b.runs ? `, ${b.runs} R` : ""}` })),
        ...pitchers.map(({ p, x }) => ({ name: p.person.fullName, line: `${x.inningsPitched} IP, ${x.hits} H, ${x.earnedRuns} ER, ${x.strikeOuts} K` })),
      ];
      $("perf").innerHTML = lines.map((l) => `<div><b>${esc(l.name)}</b><span>${esc(l.line)}</span></div>`).join("");
    } catch (e) { $("perf").innerHTML = `<p class="empty">Box score unavailable.</p>`; }
  }

  /* ---------------- Results & schedule list ---------------- */
  function renderList() {
    const past = games.filter((g) => state(g) === "Final").slice(-6).reverse();
    const next = games.filter((g) => state(g) === "Preview" || state(g) === "Live").slice(0, 5);
    const item = (g) => {
      const s = side(g), o = other(s), st = state(g), opp = oppName(g);
      let res;
      if (st === "Final") { const a = g.teams[s].score, b = g.teams[o].score; res = `<span class="res ${a > b ? "w" : "l"}">${a > b ? "W" : "L"} ${a}-${b}</span>`; }
      else if (st === "Live") res = `<span class="pill live">Live</span>`;
      else if (st === "off") res = `<span class="res">${esc(g.status.detailedState)}</span>`;
      else res = `<span class="res">${esc(fmtTime(g.gameDate).replace(" ET", ""))}</span>`;
      const sub = g.gameType !== "R" && g.seriesDescription ? g.seriesDescription + (g.seriesGameNumber ? " · G" + g.seriesGameNumber : "") : (g.venue?.name || "");
      return `<div class="gi"><span class="d">${esc(fmtShort(g.gameDate))}</span><span class="o">${s === "home" ? "vs." : "at"} ${esc(opp.teamName || opp.name)}<small>${esc(sub)}</small></span>${res}</div>`;
    };
    const html = [...next.reverse().map(item), ...past.map(item)].join("");
    $("glist").innerHTML = html || `<p class="empty">No games in the last two weeks or the next two.</p>`;
  }

  /* ---------------- Standings ---------------- */
  async function loadStandings() {
    const now = new Date();
    const season = now.getMonth() < 2 ? now.getFullYear() - 1 : now.getFullYear();
    const d = await api(`/api/v1/standings?leagueId=103&season=${season}&standingsTypes=regularSeason&hydrate=team`);
    const div = (d.records || []).find((r) => r.division?.id === AL_EAST);
    if (!div) return;
    const rows = div.teamRecords;
    $("standTbl").innerHTML = `<tr><th>Team</th><th>W</th><th>L</th><th>GB</th><th>L10</th></tr>` + rows.map((t) => {
      const l10 = t.records?.splitRecords?.find((r) => r.type === "lastTen");
      return `<tr class="${t.team.id === NYY ? "us" : ""}"><td>${esc(t.team.teamName || t.team.name)}${t.clinchIndicator ? ` <small>(${esc(t.clinchIndicator)})</small>` : ""}</td><td>${t.wins}</td><td>${t.losses}</td><td>${esc(t.gamesBack)}</td><td>${l10 ? l10.wins + "-" + l10.losses : ""}</td></tr>`;
    }).join("");
    const me = rows.find((t) => t.team.id === NYY);
    if (me) {
      const rank = me.divisionRank ? ordinal(+me.divisionRank) + " AL East" : "";
      $("heroRec").innerHTML = `<div class="num">${me.wins}-${me.losses}<small>${season} record</small></div>` +
        (rank ? `<div>${esc(rank.split(" ")[0])}<small>AL East</small></div>` : "") +
        (me.streak?.streakCode ? `<div>${esc(me.streak.streakCode)}<small>Streak</small></div>` : "");
    }
  }
  const ordinal = (n) => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

  /* ---------------- Roster ---------------- */
  async function loadRoster() {
    const [active, forty] = await Promise.all([
      api(`/api/v1/teams/${NYY}/roster?rosterType=active&hydrate=person`),
      api(`/api/v1/teams/${NYY}/roster?rosterType=40Man`),
    ]);
    const groups = { Pitchers: [], Catchers: [], Infielders: [], Outfielders: [], "Designated hitters": [] };
    for (const r of active.roster || []) {
      const t = r.position?.type;
      const key = t === "Pitcher" ? "Pitchers" : t === "Catcher" ? "Catchers" : t === "Infielder" ? "Infielders" : t === "Outfielder" ? "Outfielders" : "Designated hitters";
      groups[key].push(r);
    }
    $("groups").innerHTML = Object.entries(groups).filter(([, l]) => l.length).map(([name, l]) =>
      `<div><h3>${name} · ${l.length}</h3><ul>${l.sort((a, b) => a.person.fullName.localeCompare(b.person.fullName))
        .map((r) => `<li><span class="num" style="color:var(--ink-2);font-family:var(--f-mono);font-size:12px;display:inline-block;width:2.2em">${esc(r.jerseyNumber || "")}</span>${esc(r.person.fullName)} <small style="color:var(--ink-2)">${esc(r.position.abbreviation)}</small></li>`).join("")}</ul></div>`
    ).join("") || `<p class="empty">Roster unavailable.</p>`;

    const il = (forty.roster || []).filter((r) => /^D/.test(r.status?.code || ""));
    $("inj").innerHTML = il.length ? il.map((r) =>
      `<div><span class="tag">${esc((r.status.code || "").replace("D", "") + "-day")}</span><p><b>${esc(r.person.fullName)}</b>${esc(r.position?.abbreviation || "")} · ${esc(r.status.description)}</p></div>`
    ).join("") : `<p class="empty">No one on the injured list.</p>`;
  }

  async function loadMoves() {
    const now = new Date();
    const d = await api(`/api/v1/transactions?teamId=${NYY}&startDate=${ymd(addDays(now, -30))}&endDate=${ymd(now)}`);
    const list = (d.transactions || []).filter((t) => t.description).sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 12);
    $("moves").innerHTML = list.length ? list.map((t) =>
      `<div><span>${esc(fmtShort(t.date + "T12:00:00"))}</span><p style="margin:0">${esc(t.description)}</p></div>`
    ).join("") : `<p class="empty">No roster moves in the last 30 days.</p>`;
  }

  /* ---------------- News (best effort) ---------------- */
  async function loadNews() {
    try {
      const res = await fetch("https://www.mlb.com/yankees/feeds/news/rss.xml");
      if (!res.ok) throw new Error();
      const xml = new DOMParser().parseFromString(await res.text(), "text/xml");
      const items = [...xml.querySelectorAll("item")].slice(0, 10).map((it) => ({
        title: it.querySelector("title")?.textContent,
        link: it.querySelector("link")?.textContent,
        date: it.querySelector("pubDate")?.textContent,
      })).filter((i) => i.title && i.link && /^https:\/\//.test(i.link));
      if (!items.length) throw new Error();
      $("news").innerHTML = items.map((i) =>
        `<a href="${esc(i.link)}" target="_blank" rel="noopener"><small>MLB.com · ${esc(i.date ? fmtShort(i.date) : "")}</small><b>${esc(i.title)}</b></a>`
      ).join("");
    } catch (e) {
      $("news").innerHTML = `<p class="empty">Headlines can't be pulled in directly right now. Use the sources below for the latest stories.</p>`;
    }
  }

  /* ---------------- Boot + refresh ---------------- */
  function stamp() {
    $("updated").textContent = "Updated " + new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit", second: "2-digit" }) + " ET";
  }

  async function safeLoad() {
    try {
      await loadSchedule();
      stamp();
    } catch (e) {
      $("gameCard").innerHTML = `<div class="notice">Couldn't reach MLB's game data. Check your connection, then tap <b>Refresh now</b>. Live play-by-play is always on MLB Gameday.</div>`;
      $("updated").textContent = "Last update failed";
      clearTimeout(schedTimer); schedTimer = setTimeout(safeLoad, 60000);
    }
  }

  async function loadAll() {
    await Promise.allSettled([
      safeLoad(),
      loadStandings().catch(() => { $("standTbl").innerHTML = `<tr><td class="empty">Standings unavailable.</td></tr>`; }),
      loadRoster().catch(() => { $("groups").innerHTML = $("inj").innerHTML = `<p class="empty">Roster unavailable right now.</p>`; }),
      loadMoves().catch(() => { $("moves").innerHTML = `<p class="empty">Transactions unavailable right now.</p>`; }),
      loadNews(),
    ]);
  }

  $("refreshBtn").addEventListener("click", loadAll);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) safeLoad(); });
  setInterval(() => { if (!document.hidden) { loadStandings().catch(() => {}); loadMoves().catch(() => {}); } }, 30 * 60000);

  loadAll();
})();
