// Coinbase prices for game totals. Coinbase's prediction markets route to Kalshi: the same contracts, the same prices and
// the same settlement, with Coinbase's own fee on top. Kalshi publishes those prices without a login, so the page reads
// Kalshi's public market data and labels it as the Coinbase price. Pure functions apart from fetchTotals, so every case
// can be tested under `node --test`.
//
// A Kalshi total is a ladder of yes/no contracts per game, "Over 145.5 points" and so on. Overtime counts, as it does
// for the sportsbook's total. Prices are dollars a contract pays $1 on, so a price is also the market's chance.

const API = 'https://api.elections.kalshi.com/trade-api/v2';
export const SERIES = 'KXNCAAMBTOTAL'; // Men's College Basketball Total Points

/** Markets that close within the next four days: today's slate, never the old ladders still listed as open. */
export function totalsUrl(nowMs, cursor = '') {
  const now = Math.floor(nowMs / 1000);
  return `${API}/markets?series_ticker=${SERIES}&status=open&limit=1000&min_close_ts=${now}&max_close_ts=${now + 4 * 86400}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
}

const dollars = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

/** "KXNCAAMBTOTAL-26NOV21UALRUNF" -> "20261121". Null if the ticker carries no date. */
export function eventDate(eventTicker) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})/.exec(eventTicker || '');
  return m && MONTHS[m[2]] ? `20${m[1]}${MONTHS[m[2]]}${m[3]}` : null;
}

/**
 * Kalshi's /markets answer, grouped by game. Returns Map eventTicker -> { event, date, title, teams: [a, b], strikes }.
 * A strike is { ticker, line, yesBid, yesAsk, noBid, noAsk, last, volume }, prices in dollars, sorted by line.
 * Only "greater than" contracts with a half-point line are kept: those are the over/under ladder.
 */
export function parseTotals(json, events) {
  const out = new Map();
  // Event titles ("Little Rock vs North Florida: Point Total") name the teams; a market's own title is deprecated.
  const titles = new Map(((events && events.events) || []).map((e) => [e.event_ticker, e.title]));
  // Sub-titles carry short codes ("UALR vs UNF (Nov 21)"), which often equal the scoreboard's abbreviations.
  const codes = new Map(((events && events.events) || []).map((e) => [e.event_ticker, String(e.sub_title || '').replace(/\s*\(.*$/, '').split(/\s+vs\.?\s+/i)]));
  for (const m of (json && json.markets) || []) {
    const line = dollars(m.floor_strike);
    if (!m.event_ticker || line == null || (m.strike_type && m.strike_type !== 'greater')) continue;
    let ev = out.get(m.event_ticker);
    if (!ev) {
      const title = String(titles.get(m.event_ticker) || m.title || '').replace(/:.*$/, '');
      const teams = title.split(/\s+(?:vs\.?|at|@)\s+/i).map((s) => s.trim()).filter(Boolean);
      const alt = codes.get(m.event_ticker) || [];
      ev = { event: m.event_ticker, date: eventDate(m.event_ticker), title, teams: teams.length === 2 ? teams : [], codes: alt.length === 2 ? alt : [], strikes: [] };
      out.set(m.event_ticker, ev);
    }
    ev.strikes.push({
      ticker: m.ticker, line,
      yesBid: dollars(m.yes_bid_dollars), yesAsk: dollars(m.yes_ask_dollars),
      noBid: dollars(m.no_bid_dollars), noAsk: dollars(m.no_ask_dollars),
      last: dollars(m.last_price_dollars), volume: dollars(m.volume_fp),
    });
  }
  for (const ev of out.values()) ev.strikes.sort((a, b) => a.line - b.line);
  return out;
}

export const eventsUrl = (cursor = '') => `${API}/events?series_ticker=${SERIES}&status=open&limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;

/** Fetch every open total on the slate, following Kalshi's cursor for at most five pages. */
export async function fetchTotals(getJSON, nowMs = Date.now(), titles = null) {
  const all = { markets: [] };
  let cursor = '';
  for (let page = 0; page < 5; page += 1) {
    const d = await getJSON(totalsUrl(nowMs, cursor), { retries: 0 });
    all.markets.push(...((d && d.markets) || []));
    cursor = d && d.cursor;
    if (!cursor || !(d.markets || []).length) break;
  }
  return parseTotals(all, titles);
}

/** Event titles change once a day, so they are fetched apart from the prices and kept. */
export async function fetchTitles(getJSON) {
  const all = { events: [] };
  let cursor = '';
  for (let page = 0; page < 5; page += 1) {
    const d = await getJSON(eventsUrl(cursor), { retries: 0 });
    all.events.push(...((d && d.events) || []));
    cursor = d && d.cursor;
    if (!cursor || !(d.events || []).length) break;
  }
  return all;
}

/* ---------- matching a scoreboard game to a Kalshi ladder ---------- */

// Words that carry no identity in a team name, and the spellings the two sources disagree on.
const DROP = new Set(['the', 'of', 'university', 'univ', 'college', 'at']);
const SAME = { state: 'st', saint: 'st', 'st.': 'st', mount: 'mt', 'mt.': 'mt', fort: 'ft', northern: 'n', southern: 's', eastern: 'e', western: 'w', north: 'n', south: 's', east: 'e', west: 'w', central: 'c', 'int\'l': 'international' };
export function words(name) {
  return String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[()'’]/g, '').replace(/[-–.,/]/g, ' ')
    .split(/\s+/).filter(Boolean).map((w) => SAME[w] || w).filter((w) => !DROP.has(w));
}

/**
 * How well two names agree, 0 to 1: shared words over the longer name's words, so "Michigan" is half of "Michigan St."
 * and never mistaken for it. "UConn" and "Connecticut" do not match; such a game shows no Coinbase price.
 */
export function nameScore(a, b) {
  const x = words(a), y = words(b);
  if (!x.length || !y.length) return 0;
  const ys = new Set(y);
  return x.filter((w) => ys.has(w)).length / Math.max(x.length, y.length);
}

/**
 * The Kalshi ladder for a scoreboard game, or null. names: { away: [names...], home: [names...] } (short name, location,
 * full name: anything the scoreboard gives). Both teams have to agree, in either order, on the slate's date.
 */
export function matchGame(ladders, date, names) {
  let best = null, bestScore = 0;
  const top = (list, ev, i) => Math.max(0, ...list.map((n) => Math.max(nameScore(n, ev.teams[i]), ev.codes[i] ? nameScore(n, ev.codes[i]) : 0)));
  for (const ev of ladders.values()) {
    if (ev.date && date && ev.date !== date) continue;
    if (ev.teams.length !== 2) continue;
    const straight = Math.min(top(names.away, ev, 0), top(names.home, ev, 1));
    const swapped = Math.min(top(names.away, ev, 1), top(names.home, ev, 0));
    const s = Math.max(straight, swapped);
    if (s > bestScore) { best = ev; bestScore = s; }
  }
  return bestScore >= 0.99 ? best : null; // every word of both teams, under one of the scoreboard's names
}

/* ---------- prices against the model ---------- */

/**
 * Fee per contract, in dollars, at price p. Kalshi's taker fee is 7% of p × (1 − p), rounded up to the cent on an
 * order; Coinbase adds its own, reported at one to two cents a contract and not published. `extra` is that estimate.
 */
export function feeOf(p, extra = 0.02) {
  return Math.ceil(0.07 * p * (1 - p) * 100 - 1e-9) / 100 + extra;
}

/**
 * Each strike of a ladder against the model. overAt(line) is the model's chance the final total goes over the line.
 * Buying the over costs the yes ask; buying the under costs the no ask. edge = chance − price − fee, in dollars,
 * so +0.06 is six cents a contract. Strikes with no ask on a side carry null for that side.
 */
export function priceLadder(ladder, overAt, extra) {
  return ladder.strikes.map((s) => {
    const pOver = overAt(s.line);
    const side = (ask, chance) => (ask == null || ask <= 0 || ask >= 1 ? null : { price: ask, chance, fee: feeOf(ask, extra), edge: chance - ask - feeOf(ask, extra) });
    return { ...s, pOver, over: side(s.yesAsk, pOver), under: side(s.noAsk, 1 - pOver) };
  });
}

/** The best contract on one side ('Over' or 'Under') of a priced ladder: the largest edge. Null if none is quoted. */
export function bestOn(priced, side) {
  const k = side === 'Over' ? 'over' : 'under';
  let best = null;
  for (const s of priced) if (s[k] && (!best || s[k].edge > best[k].edge)) best = s;
  return best ? { line: best.line, ticker: best.ticker, ...best[k] } : null;
}

/** The strike nearest a line, for showing the Coinbase price beside the sportsbook's number. */
export function nearest(priced, line) {
  let best = null;
  for (const s of priced) if (!best || Math.abs(s.line - line) < Math.abs(best.line - line)) best = s;
  return best;
}

/**
 * The proposed entry rule, for an alert. A game total is an entry when the site's own signal test holds on the
 * three-minute average (|avgDev| at least `dev` deviations, inside the signal window, not lopsided) and a Coinbase
 * contract on that side beats its price plus fees by `margin` (the site's own five points over break-even).
 * m: the total market of the game's latest tracked reading; eligible: that reading's eligibility.
 * Returns { side, line, price, chance, edge } or null.
 */
export function entryOf(m, eligible, priced, { dev = 2, margin = 0.05 } = {}) {
  if (!m || !eligible || m.avgDev == null || Math.abs(m.avgDev) < dev) return null;
  const side = m.avgDev > 0 ? 'Over' : 'Under';
  const best = bestOn(priced, side);
  return best && best.edge >= margin ? { side, ...best } : null;
}

const cents = (p) => `${Math.round(p * 100)}¢`;
const signedCents = (e) => `${e >= 0 ? '+' : '−'}${Math.abs(Math.round(e * 100))}¢`;

/** "Coinbase: over 145.5 at 52¢, model 61%, +7¢ after fees" for one side of one strike. */
export function quoteWords(side, q) {
  if (!q) return '';
  return `Coinbase: ${side.toLowerCase()} ${q.line.toFixed(1)} at ${cents(q.price)}, model ${Math.round(q.chance * 100)}%, ${signedCents(q.edge)} after fees`;
}
export const fmtC = { cents, signedCents };
