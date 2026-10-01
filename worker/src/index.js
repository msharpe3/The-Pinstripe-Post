// The Pinstripe Post alert service.
// A Worker that, once a minute, checks MLB for Yankees games and sends Web Push alerts.
// All state (subscribers, VAPID keys, what's been sent) lives in one Durable Object for consistency.

import { DurableObject } from "cloudflare:workers";
import { generateVapidKeys, sendPush } from "./webpush.js";
import { NYY, PREFS, DEFAULT_PREFS, detect, isRelevant, lastScoringPlay } from "./logic.js";

const API = "https://statsapi.mlb.com";
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

const etDate = (ms) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });

async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanPrefs(p) {
  const out = { ...DEFAULT_PREFS };
  for (const k of PREFS) if (p && typeof p[k] === "boolean") out[k] = p[k];
  return out;
}

function validSubscription(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname)) &&
      typeof sub.keys?.p256dh === "string" && typeof sub.keys?.auth === "string";
  } catch { return false; }
}

async function mlb(path) {
  const res = await fetch(API + path, { headers: { "User-Agent": "PinstripePost/1.0 (fan site alerts)" }, cf: { cacheTtl: 0 } });
  if (!res.ok) throw new Error(`MLB ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

export class Alerts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.storage = ctx.storage;
  }

  async vapid() {
    let v = await this.storage.get("vapid");
    if (!v) { v = await generateVapidKeys(); await this.storage.put("vapid", v); }
    return v;
  }

  async subscribers() {
    const map = await this.storage.list({ prefix: "sub:" });
    return [...map.entries()];
  }

  async push(key, rec, payload, opts) {
    const v = await this.vapid();
    try {
      const status = await sendPush(rec.subscription, payload, v, this.env.SITE_URL, opts);
      if (status === 404 || status === 410) await this.storage.delete(key); // phone unsubscribed or app removed
      return status;
    } catch (e) {
      return 0;
    }
  }

  async broadcast(ev) {
    const payload = { title: ev.title, body: ev.body, tag: ev.tag, url: this.env.SITE_URL };
    const subs = await this.subscribers();
    let sent = 0;
    await Promise.all(subs.map(async ([key, rec]) => {
      if (rec.prefs?.[ev.pref] === false) return;
      const st = await this.push(key, rec, payload, { topic: ev.tag });
      if (st >= 200 && st < 300) sent++;
    }));
    return sent;
  }

  async tick() {
    const now = Date.now();
    const data = await mlb(`/api/v1/schedule?sportId=1&teamId=${NYY}&startDate=${etDate(now - 864e5)}&endDate=${etDate(now)}` +
      `&hydrate=team,linescore,seriesStatus,broadcasts(all),probablePitcher,lineups`);
    const games = (data.dates || []).flatMap((d) => d.games || []).filter((g) => isRelevant(g, now));
    const log = [];
    for (const g of games) {
      const key = "game:" + g.gamePk;
      const prev = await this.storage.get(key);
      const { next, events, changed } = detect(g, prev, now);
      // Save first, so a crash mid-send can't cause a repeat alert next minute.
      if (changed) await this.storage.put(key, next);
      for (const ev of events) {
        if (ev.needsPlay) {
          try {
            const pbp = await mlb(`/api/v1/game/${g.gamePk}/playByPlay?fields=allPlays,result,description,awayScore,homeScore,about,halfInning,isScoringPlay`);
            const desc = lastScoringPlay(pbp.allPlays, ev.needsPlay);
            if (desc) ev.body = `${desc} ${ev.body}`;
          } catch { /* send without the play description */ }
        }
        const n = await this.broadcast(ev);
        log.push(`${ev.tag} → ${n}`);
      }
    }
    await this.storage.put("lastTick", { at: new Date(now).toISOString(), games: games.length, sent: log });
    return log;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

    switch (url.pathname) {
      case "/vapid":
        return json({ publicKey: (await this.vapid()).publicKey });

      case "/subscribe": {
        const sub = body.subscription;
        if (!validSubscription(sub)) return json({ error: "That doesn't look like a valid push subscription." }, 400);
        const key = "sub:" + (await sha(sub.endpoint));
        await this.storage.put(key, { subscription: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs: cleanPrefs(body.prefs), added: new Date().toISOString() });
        return json({ ok: true });
      }

      case "/prefs": {
        const key = "sub:" + (await sha(String(body.endpoint || "")));
        const rec = await this.storage.get(key);
        if (!rec) return json({ error: "This device isn't signed up for alerts." }, 404);
        rec.prefs = cleanPrefs(body.prefs);
        await this.storage.put(key, rec);
        return json({ ok: true, prefs: rec.prefs });
      }

      case "/unsubscribe": {
        await this.storage.delete("sub:" + (await sha(String(body.endpoint || ""))));
        return json({ ok: true });
      }

      case "/test": {
        const key = "sub:" + (await sha(String(body.endpoint || "")));
        const rec = await this.storage.get(key);
        if (!rec) return json({ error: "This device isn't signed up for alerts." }, 404);
        const status = await this.push(key, rec, { title: "The Pinstripe Post", body: "Test alert: you're all set for Yankees alerts. ⚾", tag: "test", url: this.env.SITE_URL }, { urgency: "high" });
        return json({ ok: status >= 200 && status < 300, status });
      }

      case "/status": {
        const subs = await this.subscribers();
        return json({ subscribers: subs.length, lastTick: (await this.storage.get("lastTick")) || null });
      }

      case "/tick":
        return json({ sent: await this.tick() });
    }
    return json({ error: "Not found" }, 404);
  }
}

function cors(env, res) {
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type");
  h.set("Vary", "Origin");
  return new Response(res.body, { status: res.status, headers: h });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(env, new Response(null, { status: 204 }));
    const path = new URL(request.url).pathname;
    if (path === "/tick") return cors(env, new Response("Not found", { status: 404 })); // only the schedule runs checks
    const stub = env.ALERTS.get(env.ALERTS.idFromName("main"));
    return cors(env, await stub.fetch(request));
  },

  async scheduled(event, env, ctx) {
    const stub = env.ALERTS.get(env.ALERTS.idFromName("main"));
    ctx.waitUntil(stub.fetch("https://alerts/tick"));
  },
};
