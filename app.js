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

  // A tappable player name that opens the player card.
  const pl = (id, name) => (id ? `<button type="button" class="plink" data-player="${id}">${esc(name)}</button>` : esc(name));
  const seasonYear = () => { const n = new Date(); return n.getMonth() < 2 ? n.getFullYear() - 1 : n.getFullYear(); };

  const side = (g) => (g.teams.home.team.id === NYY ? "home" : "away");
  const other = (s) => (s === "home" ? "away" : "home");
  const isOff = (g) => /Postponed|Cancelled|Suspended/i.test(g.status.detailedState || "");
  const state = (g) => (isOff(g) ? "off" : g.status.abstractGameState); // Preview | Live | Final | off

  /* ---------------- Tabs ---------------- */
  const TABS = ["game", "playoffs", "scores", "roster", "highlights", "news"];
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
  let post = [];           // postseason series
  let feed = null;         // live game feed for the focus game

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
    renderHighlightGames();
    if (focus) loadLineup(focus);
    if (focus && (state(focus) === "Live" || state(focus) === "Final")) loadFeed(focus);
    else { $("pitchCard").hidden = true; $("boxCard").hidden = true; }
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
    await loadFeed(focus, true);
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
    if (!p) return { id: null, name: "TBD", line: "" };
    if (pitcherCache[p.id]) return pitcherCache[p.id];
    let line = "";
    try {
      const d = await api(`/api/v1/people/${p.id}?hydrate=stats(group=[pitching],type=[season])`);
      const st = d.people?.[0]?.stats?.[0]?.splits?.[0]?.stat;
      if (st) line = `${st.wins}-${st.losses}, ${st.era} ERA, ${st.strikeOuts} K`;
    } catch (e) { /* stats optional */ }
    return (pitcherCache[p.id] = { id: p.id, name: p.fullName, line });
  }

  function diamondSVG(ls) {
    const o = ls.offense || {};
    const b = (on, x, y) => `<rect class="base${on ? " on" : ""}" x="${x}" y="${y}" width="18" height="18" transform="rotate(45 ${x + 9} ${y + 9})"/>`;
    return `<svg class="diamond" viewBox="0 0 112 96" role="img" aria-label="Runners on base">
      ${b(!!o.second, 47, 8)}${b(!!o.third, 14, 40)}${b(!!o.first, 80, 40)}
      <path class="home" d="M49 74h14v8l-7 7-7-7z"/></svg>`;
  }

  function dots(label, n, max) {
    let s = `<div class="dots ${label.toLowerCase()}"><b>${label}</b>`;
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
      const bt = ls.offense?.batter, pt = ls.defense?.pitcher;
      const batter = bt?.fullName, pitcher = pt?.fullName;
      liveBlock = `<div class="live-wrap">${diamondSVG(ls)}<div class="count">
        ${dots("Balls", ls.balls || 0, 4)}${dots("Strikes", ls.strikes || 0, 3)}${dots("Outs", ls.outs || 0, 3)}
        ${batter ? `<div class="matchup-now">AB <b>${pl(bt.id, batter)}</b>${pitcher ? ` vs. <b>${pl(pt.id, pitcher)}</b>` : ""}</div>` : ""}
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
      <div id="seriesTrack"></div>
      ${liveBlock}
      ${st === "Preview" ? `<div class="countdown" id="cd"></div>` : ""}
      <div class="probables" id="probables"></div>`;

    $("gamedayBtn").href = `https://www.mlb.com/gameday/${g.gamePk}`;
    renderSeriesTrack();
    startCountdown(g);
    if (!liveOnly) renderWatch(g);

    // Probable starters (before the game) or decisions (after)
    const pp = $("probables");
    if (st === "Preview") {
      const [a, b] = await Promise.all([pitcherLine(g.teams[s].probablePitcher), pitcherLine(g.teams[o].probablePitcher)]);
      if (!$("probables")) return;
      pp.innerHTML = `<div class="prob"><div class="eyebrow">Yankees starter</div><div class="n">${pl(a.id, a.name)}</div><div class="l">${esc(a.line)}</div></div>
        <div class="prob opp"><div class="eyebrow">${esc(opp.abbreviation || "Opp")} starter</div><div class="n">${pl(b.id, b.name)}</div><div class="l">${esc(b.line)}</div></div>`;
    } else if (st === "Final" && g.decisions) {
      const d = g.decisions;
      pp.innerHTML = `<div class="prob"><div class="eyebrow">Win</div><div class="n">${d.winner ? pl(d.winner.id, d.winner.fullName) : "—"}</div></div>
        <div class="prob opp"><div class="eyebrow">Loss</div><div class="n">${d.loser ? pl(d.loser.id, d.loser.fullName) : "—"}</div></div>`;
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
        return `<li>${pl(id, p?.person?.fullName)}<em>${esc(p?.position?.abbreviation)}</em></li>`;
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
      .filter(([, p]) => p).map(([k, p]) => `<span class="pill">${k}: ${pl(p.id, p.fullName)}</span>`).join("");

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
        ...hitters.map(({ p, b }) => ({ id: p.person.id, name: p.person.fullName, line: `${b.hits}-${b.atBats}${b.homeRuns ? `, ${b.homeRuns} HR` : ""}${b.rbi ? `, ${b.rbi} RBI` : ""}${b.runs ? `, ${b.runs} R` : ""}` })),
        ...pitchers.map(({ p, x }) => ({ id: p.person.id, name: p.person.fullName, line: `${x.inningsPitched} IP, ${x.hits} H, ${x.earnedRuns} ER, ${x.strikeOuts} K` })),
      ];
      $("perf").innerHTML = lines.map((l) => `<div><b>${pl(l.id, l.name)}</b><span>${esc(l.line)}</span></div>`).join("");
      renderBox($("lastBox"), box, s);
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
      heroRegular = `<div class="num">${me.wins}-${me.losses}<small>${season} record</small></div>` +
        (rank ? `<div>${esc(rank.split(" ")[0])}<small>AL East</small></div>` : "") +
        (me.streak?.streakCode ? `<div>${esc(me.streak.streakCode)}<small>Streak</small></div>` : "");
      renderHero();
    }
  }
  /* ---------------- Header record: regular season, or postseason when the Yankees are in it ---------------- */
  let heroRegular = "";
  const ROUND_NAME = { F: "Wild Card", D: "ALDS", L: "ALCS", W: "World Series" };

  function renderHero() {
    const mine = post.filter((x) => x.A?.id === NYY || x.B?.id === NYY);
    if (!mine.length) { $("heroRec").innerHTML = heroRegular; return; }

    // Every finished Yankees playoff game, oldest first.
    const results = mine.flatMap((x) => x.games)
      .filter((g) => state(g) === "Final")
      .sort((a, b) => new Date(a.gameDate) - new Date(b.gameDate))
      .map((g) => (g.teams[side(g)].isWinner ? "W" : "L"));
    const w = results.filter((r) => r === "W").length, l = results.length - w;
    let streak = "";
    if (results.length) {
      const last = results[results.length - 1];
      let n = 0;
      for (let i = results.length - 1; i >= 0 && results[i] === last; i--) n++;
      streak = last + n;
    }

    // The Yankees' most recent series.
    const cur = mine[mine.length - 1];
    const us = cur.A?.id === NYY ? cur.wa : cur.wb, them = cur.A?.id === NYY ? cur.wb : cur.wa;
    const round = ROUND_NAME[cur.round] || "Series";
    let seriesLabel;
    if (cur.winner) seriesLabel = cur.winner.id === NYY ? (cur.round === "W" ? "Champions" : `Won ${round}`) : `Out in ${round}`;
    else if (us > them) seriesLabel = `Lead ${round}`;
    else if (us < them) seriesLabel = `Trail ${round}`;
    else seriesLabel = us ? `${round} tied` : round;

    $("heroRec").innerHTML =
      `<div class="num">${w}-${l}<small>Postseason</small></div>` +
      `<div class="num">${us}-${them}<small>${esc(seriesLabel)}</small></div>` +
      (streak ? `<div>${esc(streak)}<small>Streak</small></div>` : "");
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
        .map((r) => `<li><span class="num" style="color:var(--ink-2);font-family:var(--f-mono);font-size:12px;display:inline-block;width:2.2em">${esc(r.jerseyNumber || "")}</span>${pl(r.person.id, r.person.fullName)} <small style="color:var(--ink-2)">${esc(r.position.abbreviation)}</small></li>`).join("")}</ul></div>`
    ).join("") || `<p class="empty">Roster unavailable.</p>`;

    const il = (forty.roster || []).filter((r) => /^D/.test(r.status?.code || ""));
    $("inj").innerHTML = il.length ? il.map((r) =>
      `<div><span class="tag">${esc((r.status.code || "").replace("D", "") + "-day")}</span><p><b>${pl(r.person.id, r.person.fullName)}</b>${esc(r.position?.abbreviation || "")} · ${esc(r.status.description)}</p></div>`
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

  /* ---------------- Team abbreviations ---------------- */
  const ABBR = { 108: "LAA", 109: "AZ", 110: "BAL", 111: "BOS", 112: "CHC", 113: "CIN", 114: "CLE", 115: "COL", 116: "DET", 117: "HOU",
    118: "KC", 119: "LAD", 120: "WSH", 121: "NYM", 133: "ATH", 134: "PIT", 135: "SD", 136: "SEA", 137: "SF", 138: "STL",
    139: "TB", 140: "TEX", 141: "TOR", 142: "MIN", 143: "PHI", 144: "ATL", 145: "CWS", 146: "MIA", 147: "NYY", 158: "MIL" };
  const abbrOf = (t) => (t && (t.abbreviation || ABBR[t.id])) || (t?.name ? t.name.split(" ").pop() : "");

  /* ---------------- Postseason: bracket + series tracker ---------------- */
  const ROUNDS = [["F", 2], ["D", 2], ["L", 1]];
  const ROUND_RANK = { F: 1, D: 2, L: 3, W: 4 };
  let bracketLeague = "AL";

  const knownTeam = (t) => (t && t.id && abbrOf(t) && abbrOf(t) !== "TBD" ? t : null);

  function summarizeSeries(s) {
    const id = s.series?.id || "";
    const [round, n] = id.split("_");
    const num = +n || 1;
    const gs = (s.games || []).slice().sort((a, b) => (a.seriesGameNumber || 0) - (b.seriesGameNumber || 0) || new Date(a.gameDate) - new Date(b.gameDate));
    if (!gs.length || !ROUND_RANK[round]) return null;
    const g0 = gs[0];
    const A = knownTeam(g0.teams.away.team), B = knownTeam(g0.teams.home.team);
    const lgId = A?.league?.id || B?.league?.id;
    const desc = g0.description || g0.seriesDescription || "";
    let lg = round === "W" ? "WS" : lgId === 103 ? "AL" : lgId === 104 ? "NL" : null;
    if (!lg) lg = /^AL|American/.test(desc) ? "AL" : /^NL|National/.test(desc) ? "NL" : num <= (round === "L" ? 1 : 2) ? "AL" : "NL";
    const total = g0.gamesInSeries || gs.length;
    const need = Math.floor(total / 2) + 1;
    const wins = {};
    for (const g of gs) {
      if (state(g) !== "Final") continue;
      for (const k of ["away", "home"]) if (g.teams[k].isWinner) wins[g.teams[k].team.id] = (wins[g.teams[k].team.id] || 0) + 1;
    }
    const wa = A ? wins[A.id] || 0 : 0, wb = B ? wins[B.id] || 0 : 0;
    const winner = wa >= need ? A : wb >= need ? B : null;
    return { id, round, num, lg, games: gs, A, B, wa, wb, need, total, winner, name: g0.seriesDescription || "" };
  }

  async function loadPostseason() {
    const d = await api(`/api/v1/schedule/postseason/series?sportId=1&season=${seasonYear()}&hydrate=team`);
    post = (d.series || []).map(summarizeSeries).filter(Boolean).sort((a, b) => ROUND_RANK[a.round] - ROUND_RANK[b.round] || a.num - b.num);
    $("t-playoffs").hidden = !post.length;
    if (!post.length && !$("p-playoffs").hidden) showTab("game");
    renderBracket();
    renderHero();
  }

  function nextGameText(g) {
    return g.status?.startTimeTBD
      ? new Date(g.gameDate).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }) + ", time TBD"
      : fmtDateTime(g.gameDate);
  }

  function seriesStatus(x) {
    if (!x.A || !x.B) return "Matchup to be decided";
    if (x.winner) return `${abbrOf(x.winner)} wins ${x.need}-${x.winner === x.A ? x.wb : x.wa}`;
    const live = x.games.find((g) => state(g) === "Live");
    if (live) return `Game ${live.seriesGameNumber} live now`;
    if (x.wa || x.wb) {
      if (x.wa === x.wb) return `Series tied ${x.wa}-${x.wb}`;
      return `${abbrOf(x.wa > x.wb ? x.A : x.B)} leads ${Math.max(x.wa, x.wb)}-${Math.min(x.wa, x.wb)}`;
    }
    const next = x.games.find((g) => state(g) === "Preview");
    return next ? `Game 1 · ${nextGameText(next)}` : "";
  }

  // One dot per game. With `me`, dots read W/L for that team; otherwise they show the winner.
  function seriesDots(x, me) {
    let html = "";
    for (const g of x.games) {
      const st = state(g), n = g.seriesGameNumber || "";
      if (st === "off" || (x.winner && st !== "Final")) continue;
      let cls = "sd", txt = "G" + n, label = `Game ${n}`;
      if (st === "Final") {
        const w = g.teams.away.isWinner ? g.teams.away.team : g.teams.home.team;
        const sc = `${g.teams.away.score}-${g.teams.home.score}`;
        if (me) { const won = w.id === me; cls += won ? " w" : " l"; txt = won ? "W" : "L"; label += won ? " won " : " lost "; label += sc; }
        else { cls += " f" + (w.id === NYY ? " us" : ""); txt = abbrOf(w); label += ` won by ${abbrOf(w)}`; }
      } else if (st === "Live") { cls += " live"; label += " live"; }
      else if (g.ifNecessary === "Y") { cls += " maybe"; label += " if necessary"; }
      else label += " " + nextGameText(g);
      html += `<span class="${cls}" title="${esc(label)}" aria-label="${esc(label)}">${esc(txt)}</span>`;
    }
    return `<div class="sdots">${html}</div>`;
  }

  function renderSeriesTrack() {
    const el = $("seriesTrack");
    if (!el) return;
    const x = focus && post.find((s) => s.games.some((g) => g.gamePk === focus.gamePk));
    if (!x || !x.A || !x.B) { el.innerHTML = ""; return; }
    el.innerHTML = `<div class="strack"><div class="strack-h"><span class="eyebrow">${esc(x.name || "Series")} · Best of ${x.total}</span><b>${esc(seriesStatus(x))}</b></div>${seriesDots(x, NYY)}</div>`;
  }

  function teamRow(t, w, isWin, done) {
    if (!t) return `<div class="bt tbd"><span class="ab">TBD</span><span class="nm">To be decided</span><span class="w"></span></div>`;
    const cls = ["bt", t.id === NYY ? "us" : "", isWin ? "win" : "", done && !isWin ? "out" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}"><span class="ab">${esc(abbrOf(t))}</span><span class="nm">${esc(t.teamName || t.clubName || t.name)}</span><span class="w num">${w}</span></div>`;
  }

  function seriesCard(x) {
    if (!x) return `<div class="bs">${teamRow(null)}${teamRow(null)}<div class="bs-s">Matchup to be decided</div></div>`;
    const ours = x.A?.id === NYY || x.B?.id === NYY;
    return `<div class="bs${ours ? " ours" : ""}">${teamRow(x.A, x.wa, x.winner === x.A, !!x.winner)}${teamRow(x.B, x.wb, x.winner === x.B, !!x.winner)}
      <div class="bs-s">${esc(seriesStatus(x))}</div>${x.A && x.B && x.games.some((g) => state(g) !== "Preview") ? seriesDots(x) : ""}</div>`;
  }

  function renderBracket() {
    if (!post.length) return;
    $("bracketTitle").textContent = `${seasonYear()} Postseason`;
    const lg = bracketLeague;
    const label = { F: "Wild Card Series", D: "Division Series", L: lg === "AL" ? "ALCS" : "NLCS" };
    $("bracket").innerHTML = ROUNDS.map(([r, count]) => {
      const list = post.filter((x) => x.round === r && x.lg === lg);
      while (list.length < count) list.push(null);
      return `<div class="round"><h3>${label[r]}</h3><div class="round-grid${count === 1 ? " one" : ""}">${list.map(seriesCard).join("")}</div></div>`;
    }).join("");
    $("bracketWS").innerHTML = seriesCard(post.find((x) => x.round === "W") || null);
    const mine = post.filter((x) => x.A?.id === NYY || x.B?.id === NYY).pop();
    let note = "";
    if (mine) {
      if (!mine.winner) note = `Yankees · ${seriesStatus(mine)}`;
      else if (mine.winner.id !== NYY) note = "Yankees eliminated";
      else note = mine.round === "W" ? "World Series champions" : "Yankees advance";
    }
    $("bracketNote").textContent = note;
    $("bracketNote").hidden = !note;
  }

  $("bracketLeague").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-lg]");
    if (!b) return;
    bracketLeague = b.dataset.lg;
    $("bracketLeague").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderBracket();
  });

  /* ---------------- Live feed: pitch tracker + box score ---------------- */
  async function loadFeed(g, isRefresh) {
    try {
      const f = await api(`/api/v1.1/game/${g.gamePk}/feed/live`);
      if (g !== focus) return;
      feed = f;
      const ls = f.liveData?.linescore;
      if (ls) {
        g.linescore = ls;
        g.teams.home.score = ls.teams?.home?.runs ?? g.teams.home.score;
        g.teams.away.score = ls.teams?.away?.runs ?? g.teams.away.score;
      }
      const st = f.gameData?.status?.abstractGameState;
      if (isRefresh) {
        if (st && st !== "Live") { safeLoad(); return; } // game just ended: reload everything
        renderGame(true);
        stamp();
      }
      renderPitches(f, st === "Live");
      const box = f.liveData?.boxscore;
      if (box?.teams) {
        $("boxCard").hidden = false;
        $("boxState").textContent = st === "Live" ? "Live" : "Final";
        $("boxState").className = "pill" + (st === "Live" ? " live" : "");
        renderBox($("liveBox"), box, side(g));
      }
    } catch (e) { /* keep last good data; next tick retries */ }
  }

  const kind = (p) => { const d = p.details || {}; return d.isInPlay ? "play" : d.isBall ? "ball" : "strike"; };

  function renderPitches(f, isLive) {
    const card = $("pitchCard");
    if (!isLive) { card.hidden = true; return; }
    const plays = f.liveData?.plays || {};
    let play = plays.currentPlay, label = "At bat";
    let pitches = (play?.playEvents || []).filter((e) => e.isPitch);
    if (!pitches.length) {
      const all = plays.allPlays || [];
      for (let i = all.length - 1; i >= 0; i--) {
        const pe = (all[i].playEvents || []).filter((e) => e.isPitch);
        if (pe.length) { play = all[i]; pitches = pe; label = "Last at-bat"; break; }
      }
    }
    if (!play || !pitches.length) { card.hidden = true; return; }
    if (play.about?.isComplete) label = "Last at-bat";
    card.hidden = false;
    $("pitchLabel").textContent = label;

    const m = play.matchup || {};
    const bats = { L: "bats left", R: "bats right", S: "switch hitter" }[m.batSide?.code] || "";
    const result = play.about?.isComplete && play.result?.description ? `<span class="pt-result">${esc(play.result.description)}</span>` : "";
    $("pitchMatchup").innerHTML = `${pl(m.pitcher?.id, m.pitcher?.fullName)} <span>to</span> ${pl(m.batter?.id, m.batter?.fullName)}${bats ? ` <span>(${bats})</span>` : ""}${result}`;

    // Zone drawing: 50 units per foot. x spans -2..2 ft, height spans 0.5..5.3 ft.
    const first = pitches.find((p) => p.pitchData?.strikeZoneTop);
    const top = first?.pitchData.strikeZoneTop || 3.4, bot = first?.pitchData.strikeZoneBottom || 1.6;
    const X = (px) => 100 + px * 50, Y = (pz) => 240 - (pz - 0.5) * 50;
    const half = 17 / 24; // half the plate width (17 in) in feet
    const zl = X(-half), zr = X(half), zt = Y(top), zb = Y(bot), zw = zr - zl;
    let svg = `<rect class="z-bg" x="0" y="0" width="200" height="240" rx="8"/>`;
    for (let i = 1; i < 3; i++) {
      const x = zl + (zw * i) / 3, y = zt + ((zb - zt) * i) / 3;
      svg += `<line class="z-grid" x1="${x}" y1="${zt}" x2="${x}" y2="${zb}"/><line class="z-grid" x1="${zl}" y1="${y}" x2="${zr}" y2="${y}"/>`;
    }
    svg += `<rect class="z-box" x="${zl}" y="${zt}" width="${zw}" height="${zb - zt}"/>`;
    svg += `<path class="z-plate" d="M${zl} 224h${zw}v6l-${zw / 2} 7l-${zw / 2} -7z"/>`;
    pitches.forEach((p, i) => {
      const c = p.pitchData?.coordinates;
      if (!c || c.pX == null || c.pZ == null) return;
      const x = Math.max(10, Math.min(190, X(c.pX))), y = Math.max(10, Math.min(214, Y(c.pZ)));
      svg += `<g class="pt ${kind(p)}${i === pitches.length - 1 ? " last" : ""}"><circle cx="${x}" cy="${y}" r="9"/><text x="${x}" y="${y}" dy="0.35em">${i + 1}</text></g>`;
    });
    $("zone").innerHTML = svg;

    $("pitchList").innerHTML = pitches.map((p, i) => {
      const d = p.details || {}, sp = p.pitchData?.startSpeed;
      const cnt = p.count ? ` · ${p.count.balls}-${p.count.strikes}` : "";
      return `<li class="${kind(p)}"><span class="pn">${i + 1}</span><span class="pd"><b>${esc(d.type?.description || "Pitch")}</b>${sp ? `<em>${sp.toFixed(1)} mph</em>` : ""}<small>${esc(d.call?.description || d.description || "")}${cnt}</small></span></li>`;
    }).reverse().join("");
  }

  function renderBox(el, box, mySide) {
    if (!el || !box?.teams) return;
    el._box = box;
    if (!el.dataset.side) el.dataset.side = mySide;
    const pick = el.dataset.side;
    const t = box.teams[pick];
    const P = (id) => t.players?.["ID" + id] || {};
    const n = (v) => (v == null ? 0 : v);

    const toggle = ["away", "home"].map((k) =>
      `<button type="button" data-side="${k}" aria-pressed="${k === pick}">${esc(abbrOf(box.teams[k].team))}</button>`).join("");

    const batters = (t.batters || []).map(P).filter((p) => p.person && (p.battingOrder || p.stats?.batting?.atBats != null));
    const bRows = batters.map((p) => {
      const b = p.stats?.batting || {}, sub = p.battingOrder && +p.battingOrder % 100 !== 0;
      return `<tr class="${sub ? "sub" : ""}"><td>${pl(p.person.id, p.person.fullName)} <small>${esc(p.position?.abbreviation || "")}</small></td>
        <td>${n(b.atBats)}</td><td>${n(b.runs)}</td><td>${n(b.hits)}</td><td>${n(b.rbi)}</td><td>${n(b.baseOnBalls)}</td><td>${n(b.strikeOuts)}</td></tr>`;
    }).join("");
    const tb = t.teamStats?.batting || {};
    const bTot = `<tr class="tot"><td>Totals</td><td>${n(tb.atBats)}</td><td>${n(tb.runs)}</td><td>${n(tb.hits)}</td><td>${n(tb.rbi)}</td><td>${n(tb.baseOnBalls)}</td><td>${n(tb.strikeOuts)}</td></tr>`;

    const pRows = (t.pitchers || []).map(P).filter((p) => p.person).map((p) => {
      const x = p.stats?.pitching || {};
      return `<tr><td>${pl(p.person.id, p.person.fullName)}</td><td>${x.inningsPitched ?? "0.0"}</td><td>${n(x.hits)}</td><td>${n(x.runs)}</td><td>${n(x.earnedRuns)}</td><td>${n(x.baseOnBalls)}</td><td>${n(x.strikeOuts)}</td><td>${n(x.numberOfPitches ?? x.pitchesThrown)}</td></tr>`;
    }).join("");

    el.innerHTML = `<div class="chips box-toggle" role="group" aria-label="Choose a team">${toggle}</div>
      ${bRows ? `<div class="tbl"><table class="bx"><tr><th>Batters</th><th>AB</th><th>R</th><th>H</th><th>RBI</th><th>BB</th><th>K</th></tr>${bRows}${bTot}</table></div>` : `<p class="empty">Lineup not posted yet.</p>`}
      ${pRows ? `<div class="tbl"><table class="bx"><tr><th>Pitchers</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th>PC</th></tr>${pRows}</table></div>` : ""}`;
    if (!el._wired) {
      el._wired = true;
      el.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-side]");
        if (!b) return;
        el.dataset.side = b.dataset.side;
        renderBox(el, el._box, mySide);
      });
    }
  }

  /* ---------------- Player cards ---------------- */
  const dlg = $("playerDlg");
  const headshot = (id) => `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_240,q_auto:best/v1/people/${id}/headshot/67/current`;
  let pcToken = 0;

  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-player]");
    if (!b) return;
    e.preventDefault();
    openPlayer(+b.dataset.player);
  });
  $("pcClose").addEventListener("click", () => closePlayerCard());
  dlg.addEventListener("click", (e) => { if (e.target === dlg) closePlayerCard(); }); // tap the dimmed backdrop
  function closePlayerCard() { if (dlg.close) dlg.close(); else dlg.removeAttribute("open"); }

  function statSplits(p, type, group) {
    const s = (p.stats || []).find((x) => x.type?.displayName === type && x.group?.displayName === group);
    return s?.splits || [];
  }

  async function openPlayer(id) {
    if (!id) return;
    const tok = ++pcToken;
    $("pcBody").innerHTML = `<p class="empty" style="padding:28px 0">Loading player…</p>`;
    if (!dlg.open) { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", ""); }
    const yr = seasonYear();
    try {
      const d = await api(`/api/v1/people/${id}?hydrate=currentTeam,stats(group=[hitting,pitching],type=[season,gameLog],season=${yr})`);
      if (tok !== pcToken) return;
      const p = d.people?.[0];
      if (!p) throw new Error("no player");
      const isP = p.primaryPosition?.abbreviation === "P";
      const isTwo = p.primaryPosition?.abbreviation === "TWP";
      let group = isP ? "pitching" : "hitting";
      if (!statSplits(p, "season", group).length && (isTwo || statSplits(p, "season", isP ? "hitting" : "pitching").length)) group = isP ? "hitting" : "pitching";
      const season = statSplits(p, "season", group)[0]?.stat;
      const log = statSplits(p, "gameLog", group).slice().sort((a, b) => (b.date || "").localeCompare(a.date || "")).slice(0, 5);

      const bio = [
        p.primaryNumber ? "#" + p.primaryNumber : "",
        p.primaryPosition?.name,
        p.batSide && p.pitchHand ? `Bats ${p.batSide.code} / Throws ${p.pitchHand.code}` : "",
      ].filter(Boolean).join(" · ");
      const body = [p.height, p.weight ? p.weight + " lb" : "", p.currentAge ? "Age " + p.currentAge : ""].filter(Boolean).join(" · ");

      let tiles = "", more = "", logHead = "", logRows = "";
      if (season && group === "hitting") {
        tiles = [["AVG", season.avg], ["HR", season.homeRuns], ["RBI", season.rbi], ["OPS", season.ops]];
        more = `${season.gamesPlayed} G · ${season.hits} H · ${season.doubles} 2B · ${season.baseOnBalls} BB · ${season.stolenBases} SB · ${season.strikeOuts} K`;
        logHead = `<th>Date</th><th>Opp</th><th>AB</th><th>H</th><th>HR</th><th>RBI</th>`;
        logRows = log.map((s) => `<tr><td>${esc(fmtShort(s.date + "T12:00:00"))}</td><td>${s.isHome ? "" : "@"}${esc(abbrOf(s.opponent))}</td><td>${s.stat.atBats}</td><td>${s.stat.hits}</td><td>${s.stat.homeRuns}</td><td>${s.stat.rbi}</td></tr>`).join("");
      } else if (season) {
        tiles = [["ERA", season.era], ["W-L", `${season.wins}-${season.losses}`], ["K", season.strikeOuts], ["WHIP", season.whip]];
        more = `${season.gamesPlayed} G · ${season.gamesStarted} GS · ${season.inningsPitched} IP · ${season.saves} SV · ${season.baseOnBalls} BB`;
        logHead = `<th>Date</th><th>Opp</th><th>IP</th><th>H</th><th>ER</th><th>K</th>`;
        logRows = log.map((s) => `<tr><td>${esc(fmtShort(s.date + "T12:00:00"))}</td><td>${s.isHome ? "" : "@"}${esc(abbrOf(s.opponent))}</td><td>${s.stat.inningsPitched}</td><td>${s.stat.hits}</td><td>${s.stat.earnedRuns}</td><td>${s.stat.strikeOuts}</td></tr>`).join("");
      }

      $("pcBody").innerHTML = `
        <div class="pc-head">
          <img src="${headshot(p.id)}" alt="" width="96" height="96" onerror="this.style.visibility='hidden'">
          <div class="min"><h2 id="pcName">${esc(p.fullName)}</h2><p class="pc-bio">${esc(bio)}</p><p class="pc-bio">${esc(body)}</p></div>
        </div>
        ${season ? `<div class="eyebrow" style="margin-top:14px">${yr} regular season</div>
          <div class="pc-tiles">${tiles.map(([k, v]) => `<div><b class="num">${esc(v)}</b><small>${k}</small></div>`).join("")}</div>
          <p class="pc-more">${esc(more)}</p>` : `<p class="empty" style="margin-top:14px">No ${yr} stats yet.</p>`}
        ${logRows ? `<h3 style="margin-top:14px">Last ${log.length} games</h3><div class="tbl"><table>${"<tr>" + logHead + "</tr>"}${logRows}</table></div>` : ""}
        <a class="btn ghost" style="margin-top:14px" href="https://www.mlb.com/player/${p.id}" target="_blank" rel="noopener">Full profile on MLB.com ↗</a>`;
    } catch (e) {
      if (tok === pcToken) $("pcBody").innerHTML = `<h2 id="pcName">Player</h2><p class="empty" style="margin-top:8px">Couldn't load this player's stats. Check your connection and tap the name again.</p>`;
    }
  }

  /* ---------------- Highlights ---------------- */
  let hlGamePk = null, hlTimer = null, hlItems = [], hlPlaying = null;

  function hlCandidates() {
    const live = games.filter((g) => state(g) === "Live");
    const finals = games.filter((g) => state(g) === "Final").slice(-6).reverse();
    return [...live, ...finals];
  }

  function renderHighlightGames() {
    const list = hlCandidates();
    const wrap = $("hlGames");
    if (!list.length) { wrap.innerHTML = ""; $("hlList").innerHTML = `<p class="empty">No recent games with highlights.</p>`; return; }
    if (!hlGamePk || !list.some((g) => g.gamePk === hlGamePk)) hlGamePk = list[0].gamePk;
    wrap.innerHTML = list.map((g) => {
      const s = side(g), o = other(s), st = state(g), opp = oppName(g);
      const label = st === "Live" ? `Live · ${opp.abbreviation}` :
        `${fmtShort(g.gameDate)} ${s === "home" ? "vs" : "@"} ${opp.abbreviation} ${g.teams[s].score > g.teams[o].score ? "W" : "L"} ${g.teams[s].score}-${g.teams[o].score}`;
      return `<button type="button" data-pk="${g.gamePk}" aria-pressed="${g.gamePk === hlGamePk}">${esc(label)}</button>`;
    }).join("");
    wrap.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      hlGamePk = +b.dataset.pk;
      wrap.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      closePlayer();
      loadHighlights();
    }));
    loadHighlights();
  }

  function pickVideo(item) {
    const pb = item.playbacks || [];
    const byName = (n) => pb.find((p) => p.name === n && p.url);
    return (byName("mp4Avc") || byName("highBit") || pb.find((p) => /\.mp4(\?|$)/.test(p.url || "")) || byName("hlsCloud") || {}).url || "";
  }
  function pickThumb(item) {
    const cuts = (item.image?.cuts || []).filter((c) => c.src);
    if (!cuts.length) return "";
    const good = cuts.filter((c) => (c.width || 0) >= 320).sort((a, b) => (a.width || 0) - (b.width || 0));
    return (good[0] || cuts[cuts.length - 1]).src;
  }
  function dur(s) { return (s || "").replace(/^00:/, "").replace(/^0(\d:)/, "$1"); }

  async function loadHighlights() {
    clearTimeout(hlTimer);
    const pk = hlGamePk;
    if (!pk) return;
    const g = games.find((x) => x.gamePk === pk);
    const isLive = g && state(g) === "Live";
    $("hlState").textContent = isLive ? "Updating live" : "";
    try {
      const d = await api(`/api/v1/game/${pk}/content`);
      if (pk !== hlGamePk) return; // user switched games while loading
      hlItems = (d.highlights?.highlights?.items || [])
        .map((it) => ({ id: it.id || it.slug || it.headline, title: it.headline || it.title, blurb: it.blurb || it.description || "", date: it.date, duration: dur(it.duration), video: pickVideo(it), thumb: pickThumb(it) }))
        .filter((it) => it.title && it.video)
        .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
      renderClips();
    } catch (e) {
      $("hlList").innerHTML = `<p class="empty">Couldn't load highlights for this game. Try again in a moment.</p>`;
    }
    if (isLive) hlTimer = setTimeout(() => { if (!document.hidden && hlGamePk === pk) loadHighlights(); else hlTimer = setTimeout(loadHighlights, 120000); }, 120000);
  }

  function renderClips() {
    const list = $("hlList");
    if (!hlItems.length) { list.innerHTML = `<p class="empty">No highlights posted for this game yet. Clips usually appear within a few minutes of a big play.</p>`; return; }
    list.innerHTML = hlItems.map((it, i) => `<button type="button" class="clip${hlPlaying === it.id ? " now" : ""}" data-i="${i}">
        <div class="thumb">${it.thumb ? `<img src="${esc(it.thumb)}" alt="" loading="lazy">` : ""}${it.duration ? `<span>${esc(it.duration)}</span>` : ""}</div>
        <b>${esc(it.title)}</b></button>`).join("");
    list.querySelectorAll(".clip").forEach((b) => b.addEventListener("click", () => play(hlItems[+b.dataset.i])));
  }

  function play(it) {
    if (!it) return;
    hlPlaying = it.id;
    const v = $("hlVideo");
    v.src = it.video;
    if (it.thumb) v.poster = it.thumb;
    $("hlTitle").textContent = it.title;
    $("hlBlurb").textContent = it.blurb;
    $("hlPlayer").hidden = false;
    v.play().catch(() => {});
    $("hlPlayer").scrollIntoView({ behavior: "smooth", block: "start" });
    renderClips();
  }
  function closePlayer() {
    const v = $("hlVideo"); v.pause(); v.removeAttribute("src"); v.load();
    $("hlPlayer").hidden = true; hlPlaying = null;
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
      await Promise.all([loadSchedule(), loadPostseason().catch(() => {})]);
      renderSeriesTrack();
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
