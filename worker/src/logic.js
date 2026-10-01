// Decides which alerts a game update should produce. Pure functions, no I/O, so they can be tested.

export const NYY = 147;
export const PREFS = ["start", "lineup", "runs", "lead", "final"];
export const DEFAULT_PREFS = { start: true, lineup: true, runs: true, lead: true, final: true };

const TZ = "America/New_York";
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) + " ET";

export function sideOf(g) { return g.teams.home.team.id === NYY ? "home" : "away"; }
const otherSide = (s) => (s === "home" ? "away" : "home");
const nameOf = (t) => t.teamName || t.clubName || t.name || "Opponent";
const abbrOf = (t) => t.abbreviation || nameOf(t);

export function gameState(g) {
  if (/Postponed|Cancelled|Suspended/i.test(g.status?.detailedState || "")) return "off";
  return g.status?.abstractGameState || "Preview";
}

function runs(g, s) {
  return g.linescore?.teams?.[s]?.runs ?? g.teams[s].score ?? 0;
}

/** Is this game worth checking right now? */
export function isRelevant(g, now) {
  const st = gameState(g), start = Date.parse(g.gameDate);
  if (st === "Live") return true;
  if (st === "Preview" || st === "off") return start - now < 4 * 3600e3 && now - start < 3 * 3600e3;
  if (st === "Final") return now - start < 10 * 3600e3;
  return false;
}

function scoreLine(g) {
  const s = sideOf(g), o = otherSide(s), opp = g.teams[o].team;
  return `NYY ${runs(g, s)}, ${abbrOf(opp)} ${runs(g, o)}`;
}

function inningText(g) {
  const ls = g.linescore || {};
  return ls.inningState && ls.currentInningOrdinal ? `${ls.inningState} ${ls.currentInningOrdinal}` : "";
}

function matchupTitle(g) {
  const s = sideOf(g), opp = nameOf(g.teams[otherSide(s)].team);
  const label = g.gameType && g.gameType !== "R" && g.seriesDescription
    ? ` · ${g.seriesDescription}${g.seriesGameNumber ? " Game " + g.seriesGameNumber : ""}` : "";
  return `Yankees ${s === "home" ? "vs." : "at"} ${opp}${label}`;
}

/**
 * Compare a fresh game object with what we stored last time.
 * Returns { next, events, changed }. `next` is the state to store.
 * Each event: { pref, title, body, tag, needsPlay? }.
 */
export function detect(g, prev, now) {
  const st = gameState(g);
  const s = sideOf(g), o = otherSide(s);
  const opp = g.teams[o].team;
  const nyy = runs(g, s), them = runs(g, o);
  const start = Date.parse(g.gameDate);
  const events = [];
  const pk = g.gamePk;

  // First time we see a game that's already underway or over: record it without alerting,
  // so turning the service on mid-game doesn't replay old runs.
  if (!prev) {
    const fresh = { nyy: 0, opp: 0, sent: {} };
    if (st === "Live" || st === "Final") {
      return { next: { nyy, opp: them, sent: { start: true, lineup: true, final: st === "Final" } }, events: [], changed: true };
    }
    prev = fresh;
  }
  const next = { nyy: prev.nyy, opp: prev.opp, sent: { ...prev.sent } };

  if (st === "off" && !next.sent.off) {
    next.sent.off = true;
    events.push({ pref: "start", tag: `off-${pk}`, title: `${matchupTitle(g)}: ${g.status.detailedState}`,
      body: g.status.reason ? `Reason: ${g.status.reason}.` : "Check back for the new date and time." });
  }

  if (st === "Preview") {
    const mins = (start - now) / 60000;
    if (!next.sent.start && !g.status?.startTimeTBD && mins <= 30 && mins > -15) {
      next.sent.start = true;
      const tv = [...new Set((g.broadcasts || []).filter((b) => b.type === "TV" && b.language !== "es" && (b.isNational || b.homeAway === s)).map((b) => b.name))];
      const pp = [g.teams[s].probablePitcher?.fullName, g.teams[o].probablePitcher?.fullName];
      const bits = [`First pitch ${fmtTime(g.gameDate)}`];
      if (tv.length) bits.push(`on ${tv.join(" / ")}`);
      let body = bits.join(" ") + ".";
      if (pp[0] && pp[1]) body += ` ${pp[0]} vs. ${pp[1]}.`;
      events.push({ pref: "start", tag: `start-${pk}`, title: `${matchupTitle(g)} starts soon`, body });
    }
    const lineup = g.lineups?.[s === "home" ? "homePlayers" : "awayPlayers"] || [];
    if (!next.sent.lineup && lineup.length >= 9) {
      next.sent.lineup = true;
      const last = (name) => { const w = name.split(" ").filter((x) => !/^(Jr\.?|Sr\.?|II|III|IV)$/i.test(x)); return w[w.length - 1] || name; };
      const body = lineup.slice(0, 9).map((p, i) => `${i + 1}. ${last(p.fullName)} ${p.primaryPosition?.abbreviation || ""}`.trim()).join(" · ");
      events.push({ pref: "lineup", tag: `lineup-${pk}`, title: `Yankees lineup vs. ${nameOf(opp)}`, body });
    }
  }

  if (st === "Live" || st === "Final") {
    next.sent.start = true;
    next.sent.lineup = true;
    const inn = inningText(g);
    if (nyy > prev.nyy) {
      const n = nyy - prev.nyy;
      events.push({ pref: "runs", tag: `run-${pk}-${nyy}`, needsPlay: { half: s === "home" ? "bottom" : "top", side: s, score: nyy },
        title: n > 1 ? `Yankees score ${n}!` : "Yankees score!", body: `${scoreLine(g)}${inn ? " · " + inn : ""}` });
    }
    if (them > prev.opp) {
      const before = Math.sign(prev.nyy - prev.opp), after = Math.sign(nyy - them);
      if (after <= 0 && before > after) {
        events.push({ pref: "lead", tag: `lead-${pk}-${them}`, needsPlay: { half: s === "home" ? "top" : "bottom", side: o, score: them },
          title: after === 0 ? `${nameOf(opp)} tie it` : `${nameOf(opp)} take the lead`, body: `${scoreLine(g)}${inn ? " · " + inn : ""}` });
      }
    }
    next.nyy = nyy;
    next.opp = them;
  }

  if (st === "Final" && !next.sent.final) {
    next.sent.final = true;
    const won = nyy > them;
    const series = g.gameType && g.gameType !== "R" && g.seriesStatus?.description ? ` · ${g.seriesStatus.description}` : "";
    events.push({ pref: "final", tag: `final-${pk}`,
      title: won ? `Final: Yankees win ${nyy}-${them}` : `Final: Yankees lose ${them}-${nyy}`,
      body: `${s === "home" ? "vs." : "at"} ${nameOf(opp)}${series}` });
  }

  const changed = JSON.stringify(next) !== JSON.stringify(prev);
  return { next, events, changed };
}

/**
 * Find the scoring play that produced the current score, for an alert's detail line.
 * Only returns a play whose resulting score matches, so a lagging feed never attaches an old play.
 */
export function lastScoringPlay(allPlays, want) {
  const key = want.side === "home" ? "homeScore" : "awayScore";
  for (let i = (allPlays || []).length - 1; i >= 0; i--) {
    const p = allPlays[i];
    if (p.about?.isScoringPlay && p.about.halfInning === want.half && p.result?.description) {
      return p.result[key] === want.score ? p.result.description : "";
    }
  }
  return "";
}
