// ESPN feeds. Unofficial endpoints: free, CORS-open, and liable to change, so every parser tolerates missing fields.
// DraftKings' numbers come through ESPN's odds feed: provider 100 is the pregame/closing line, 200 is the live line.

import { elapsed } from './model.js?v=34';

const SITE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';
const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball';
const bust = () => Math.floor(Date.now() / 1000); // ESPN's CDN can hold a response for minutes without this

export const urls = {
  board: (date) => `${SITE}/scoreboard?dates=${date}&groups=50&limit=400&_=${bust()}`,
  odds: (id) => `${CORE}/events/${id}/competitions/${id}/odds?limit=20&_=${bust()}`,
  summary: (id) => `${SITE}/summary?event=${id}&_=${bust()}`,
};

/** GET JSON with a timeout and one retry. Throws an Error whose message is short enough to show. */
export async function getJSON(url, { timeout = 9000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= retries) throw new Error(err.name === 'AbortError' ? 'timed out' : err.message || 'network error');
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

function team(c) {
  const t = c.team || {};
  const rank = c.curatedRank && c.curatedRank.current;
  return {
    name: t.shortDisplayName || t.location || t.abbreviation || 'Team',
    abbr: t.abbreviation || (t.shortDisplayName || '').slice(0, 4).toUpperCase(),
    rank: rank && rank <= 25 ? rank : null,
    pts: Math.round(num(c.score) || 0),
    // Every name the scoreboard gives, for matching the game on other markets (Coinbase's ladders).
    names: [t.shortDisplayName, t.location, t.displayName, t.abbreviation].filter(Boolean),
  };
}

/** One scoreboard event, reduced to what the board needs. Returns null if the event is malformed. */
export function parseEvent(e) {
  const c = e && e.competitions && e.competitions[0];
  const st = e && e.status;
  if (!c || !st || !st.type || !Array.isArray(c.competitors)) return null;
  const away = c.competitors.find((x) => x.homeAway === 'away');
  const home = c.competitors.find((x) => x.homeAway === 'home');
  if (!away || !home) return null;
  const o = (c.odds || [])[0];
  const pre = o && num(o.overUnder) != null && num(o.spread) != null ? [num(o.overUnder), num(o.spread)] : null;
  return {
    id: String(e.id),
    state: st.type.state, // 'pre' | 'in' | 'post'
    detail: st.type.shortDetail || '',
    period: st.period || 0,
    clock: st.displayClock || '',
    minute: elapsed(st.period || 0, st.displayClock || ''),
    start: e.date,
    away: team(away),
    home: team(home),
    boardPre: pre,
  };
}

/** {pre: [total, homeSpread] | null, live: {total, spread, over, under} | null} from the odds feed. */
/**
 * The sportsbook's own link for one side of the live total, from the odds item, or null. ESPN wraps the book's address in
 * a tracking redirect and carries the real one in `preurl`; the bare address is used, and only if it is an https link to
 * one of `hosts`.
 */
function betLink(item, rel, hosts) {
  const hit = ((item && item.links) || []).find((l) => Array.isArray(l.rel) && l.rel.includes(rel) && typeof l.href === 'string');
  if (!hit) return null;
  try {
    const outer = new URL(hit.href), u = new URL(outer.searchParams.get('preurl') || hit.href);
    return u.protocol === 'https:' && hosts.includes(u.hostname) ? u.href : null;
  } catch { return null; }
}

/**
 * Pregame line and live quote from the odds list. hosts: where a bet link may lead (js/site.js); with none given, or
 * none carried by the feed, the live quote has no `links`.
 */
export function parseOdds(d, hosts = []) {
  const out = { pre: null, live: null };
  for (const it of (d && d.items) || []) {
    const pid = String((it.provider || {}).id);
    const total = num(it.overUnder);
    const spread = num(it.spread);
    if (total == null || spread == null) continue;
    if (pid === '100') out.pre = [total, spread];
    if (pid === '200') {
      const cur = it.current || {};
      out.live = { total, spread, over: num((cur.over || {}).american), under: num((cur.under || {}).american) };
      const over = betLink(it, 'over', hosts), under = betLink(it, 'under', hosts);
      if (over || under) out.live.links = { over, under };
    }
  }
  return out;
}

/** Score timeline [{t, a, h}] from a game summary, plus the closing line if the summary carries one. */
export function parseSummary(d) {
  const timeline = [{ t: 0, a: 0, h: 0 }];
  for (const p of (d && d.plays) || []) {
    if (p.awayScore == null || p.homeScore == null || !p.period || !p.clock) continue;
    const t = elapsed(p.period.number, p.clock.displayValue);
    const last = timeline[timeline.length - 1];
    if (t < last.t - 0.05) continue; // out-of-order play
    if (p.awayScore !== last.a || p.homeScore !== last.h || t - last.t >= 1) timeline.push({ t, a: p.awayScore, h: p.homeScore });
  }
  const pc = ((d && d.pickcenter) || []).find((p) => num(p.overUnder) != null && num(p.spread) != null);
  return { timeline, pre: pc ? [num(pc.overUnder), num(pc.spread)] : null };
}
