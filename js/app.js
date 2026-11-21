// The Price of Pace: state, polling, routing and rendering.
// Every local file is requested with the same ?v= release number, so a browser or CDN can never pair one release's
// page with another's scripts. Bump it everywhere on release; tests/release.test.mjs fails if the numbers disagree.

import { createModel, RULES, clockLabel, isClockGlitch, gapStats, signalNow } from './model.js?v=21';
import { urls, getJSON, parseEvent, parseOdds, parseSummary } from './espn.js?v=21';
import { rangePlot, histogram, trendPanel, gameChart, unitsChart, fmt } from './charts.js?v=21';
import { SITE, dataBase, safeLink, safeMail, coinbaseOn } from './site.js?v=21';
import { fetchTotals, fetchTitles, matchGame, priceLadder, bestOn, nearest, entryOf, quoteWords, fmtC } from './coinbase.js?v=21';
import { boardWords, signalWords, agoWords } from './words.js?v=21';

const { f1, signed } = fmt;
const $ = (s) => document.querySelector(s);
const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const POLL_MS = 20000;
const RECORDED_EVERY = 9; // polls between reloads of the recorder's files
// Recorded tracks live on the repo's `data` branch. js/site.js says where; ?data=<url> overrides, for local work.
const DATA = dataBase();

// ESPN files a late tip under the Eastern date it started on, so a slate rolls over at 5 AM Eastern.
const slateOf = (ms) => new Date(ms - 10 * 36e5).toISOString().slice(0, 10).replace(/-/g, '');
const toUTC = (d) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
const shiftDay = (d, n) => new Date(toUTC(d) + n * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
const dayLabel = (d) => new Date(toUTC(d)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const timeLabel = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const today = () => slateOf(Date.now());

const S = {
  view: 'board', date: today(), sel: null, market: 'total', only: false, cursor: -1,
  games: new Map(), recorded: new Map(), recordedAt: null, ledger: [], index: [],
  model: null, scoresAt: 0, error: null, polls: 0, busy: false, memo: new Map(), histKey: null, yardDay: null, ladder: [],
  mode: (() => { try { return localStorage.getItem('csl.mode') === 'table' ? 'table' : 'trend'; } catch { return 'trend'; } })(),
  allDone: false, allFeed: false, allLedger: false, // show every finished game's chart, every signal in the feed, the whole ledger
  led: { result: 'all', market: 'all' }, // the ledger's filters
};
const isToday = () => S.date === today();

/* ---------- Coinbase prices (off unless switched on; see js/site.js) ---------- */
const CB = {
  on: coinbaseOn(), cfg: SITE.coinbase || {}, ladders: new Map(), titles: null, titlesAt: 0, at: 0, error: null,
  alerts: (() => { try { return localStorage.getItem('csl.alerts') === '1'; } catch { return false; } })(),
  fired: new Set((() => { try { return JSON.parse(sessionStorage.getItem('csl.fired') || '[]'); } catch { return []; } })()),
};
async function loadCoinbase() {
  if (!CB.on || !isToday() || ![...S.games.values()].some((g) => g.state === 'in')) return;
  try {
    if (!CB.titles || Date.now() - CB.titlesAt > 30 * 60000) { CB.titles = await fetchTitles(getJSON); CB.titlesAt = Date.now(); }
    CB.ladders = await fetchTotals(getJSON, Date.now(), CB.titles);
    CB.at = Date.now(); CB.error = null;
  } catch (err) { CB.error = err.message || 'error'; }
}
/** A live game's Coinbase ladder priced against the model now: the strike nearest the sportsbook, the best on each side, and an entry if the rule holds. */
function cbQuote(g, st) {
  if (!CB.on || !CB.at || g.state !== 'in' || !st || !st.fresh || !S.model) return null;
  const key = `${g.id}:cb`;
  if (S.memo.has(key)) return S.memo.get(key);
  const ladder = matchGame(CB.ladders, S.date, { away: g.away.names || [g.away.name], home: g.home.names || [g.home.name] });
  let out = null;
  const m = st.markets.total;
  if (ladder && m && m.fair != null) {
    const overAt = (line) => 1 - S.model.cdf((line - m.fair) / m.sd);
    const priced = priceLadder(ladder, overAt, CB.cfg.fee);
    out = { ladder, priced, near: m.line == null ? null : nearest(priced, m.line), Over: bestOn(priced, 'Over'), Under: bestOn(priced, 'Under'),
      entry: entryOf(m, st.eligible, priced, { dev: CB.cfg.dev, margin: CB.cfg.margin }) };
  }
  S.memo.set(key, out);
  return out;
}

/* ---------- storage: this browser's own readings survive a reload ---------- */
const store = {
  key: (d) => `csl.readings.${d}`,
  load(d) { try { return JSON.parse(localStorage.getItem(this.key(d)) || '{}'); } catch { return {}; } },
  save() {
    try {
      const out = {};
      for (const g of S.games.values()) if (g.r.length) out[g.id] = g.r.slice(-400);
      localStorage.setItem(this.key(S.date), JSON.stringify(out));
      const keep = new Set([0, -1, -2].map((n) => this.key(shiftDay(today(), n))));
      for (let i = localStorage.length - 1; i >= 0; i -= 1) { const k = localStorage.key(i); if (k && k.startsWith('csl.readings.') && !keep.has(k)) localStorage.removeItem(k); }
    } catch { /* private mode or full: the page works without it */ }
  },
};

/* ---------- data ---------- */
async function loadBoard() {
  const date = S.date;
  const d = await getJSON(urls.board(date));
  if (date !== S.date) return;
  const saved = S.games.size ? null : store.load(date);
  const seen = new Set();
  for (const e of d.events || []) {
    const n = parseEvent(e);
    if (!n) continue;
    const g = S.games.get(n.id) || { r: (saved && saved[n.id]) || [], timeline: null, timelineAt: 0, pre: null, live: null };
    Object.assign(g, n);
    if (!g.pre && n.boardPre) g.pre = n.boardPre;
    S.games.set(n.id, g);
    seen.add(n.id);
  }
  for (const k of [...S.games.keys()]) if (!seen.has(k)) S.games.delete(k);
  S.scoresAt = Date.now();
  S.error = null;
}

async function loadOdds(g) {
  const o = parseOdds(await getJSON(urls.odds(g.id), { retries: 0 }));
  if (o.pre) g.pre = o.pre;
  if (g.state !== 'in') return;
  g.live = o.live ? { ...o.live, at: Date.now() } : null;
  if (g.period > 2) return; // overtime: the model stops at 40 minutes
  const reading = [Math.round(Date.now() / 1000), Number(g.minute.toFixed(2)), g.away.pts, g.home.pts,
    o.live ? o.live.total : null, o.live ? o.live.spread : null, o.live ? o.live.over : null, o.live ? o.live.under : null];
  const last = g.r[g.r.length - 1];
  if (isClockGlitch(last, reading)) return;
  if (!last || reading.slice(1).join() !== last.slice(1).join()) g.r.push(reading);
}

async function inBatches(items, size, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) { const it = queue.shift(); try { await fn(it); } catch { /* one game failing must not stop the rest */ } }
  }));
}

async function loadRecorded() {
  const minute = Math.floor(Date.now() / 60000);
  try {
    const d = await getJSON(`${DATA}tracks/${S.date}.json?_=${minute}`, { retries: 0 });
    S.recorded = new Map((d.games || []).map((g) => [String(g.id), g]));
    S.recordedAt = d.updated || null;
    S.yardDay = d.yardstick && d.yardstick.unit === 'points' && d.yardstick.total && d.yardstick.team ? d.yardstick : null;
  } catch { S.recorded = new Map(); S.recordedAt = null; S.yardDay = null; }
  try { S.ledger = await getJSON(`${DATA}ledger.json?_=${minute}`, { retries: 0 }); } catch { S.ledger = []; }
  try { S.index = await getJSON(`${DATA}index.json?_=${minute}`, { retries: 0 }); } catch { S.index = []; }
  try { S.ladder = await getJSON(`${DATA}ladder.json?_=${minute}`, { retries: 0 }); } catch { S.ladder = []; }
}

async function loadTimeline(g) {
  const s = parseSummary(await getJSON(urls.summary(g.id)));
  g.timeline = s.timeline;
  g.timelineAt = Date.now();
  if (!g.pre && s.pre) g.pre = s.pre;
}

const preOf = (g) => g.pre || (S.recorded.get(g.id) || {}).pre || null;

/** The recorder's readings and this browser's, merged on time, with clock glitches dropped. */
function readingsOf(g) {
  const rec = (S.recorded.get(g.id) || {}).r || [];
  // A reading at the end of regulation is either stale or already the overtime line: neither is a read on a 40-minute total.
  const all = rec.concat(g.r).filter((r) => r[4] != null && r[5] != null && r[1] < 40).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of all) { const last = out[out.length - 1]; if (!last || (r[0] - last[0] >= 20 && !isClockGlitch(last, r))) out.push(r); }
  return out;
}

/** Where a live game stands right now: the model's view, and whether a buy has held for two readings. */
/** The yardstick this slate is judged with: the one the recorder stored with the day, else the one shipped with the model. */
const yard = () => S.yardDay || S.model.yardstick;
const dev1 = (v) => (v == null || !Number.isFinite(v) ? '–' : signed(v)); // in deviations; the label beside it says so

/** A game's readings judged on the rolling average. For a live game with a fresh line, the last row is "now". */
function tracked(g) {
  const key = `${g.id}:track`;
  if (S.memo.has(key)) return S.memo.get(key);
  const pre = preOf(g);
  let out = [];
  if (pre && S.model) {
    const rows = readingsOf(g), last = rows[rows.length - 1], fresh = g.state === 'in' && g.live && Date.now() - g.live.at < RULES.staleMs;
    const now = Math.floor(Date.now() / 1000);
    if (fresh && g.live.total != null && g.live.spread != null && (!last || now - last[0] >= 20)) rows.push([now, g.minute, g.away.pts, g.home.pts, g.live.total, g.live.spread, g.live.over, g.live.under]);
    out = S.model.track(pre, rows.filter((r) => r[1] < 40), { yard: yard() });
  }
  S.memo.set(key, out);
  return out;
}

/** Where a game stands right now: each market against the three-minute average, and the strongest read among them. */
function standing(g) {
  const pre = preOf(g);
  if (!pre || !S.model) return null;
  const fresh = g.state === 'in' && !!g.live && Date.now() - g.live.at < RULES.staleMs;
  const rows = fresh ? tracked(g) : [], row = rows[rows.length - 1];
  const j = row && Math.abs(row.t - g.minute) < 1.5 ? row : S.model.judge(pre, g.minute, g.away.pts, g.home.pts, null, null, { yard: yard() });
  let best = null;
  for (const k of ['total', 'away', 'home']) {
    const m = j.markets[k], weight = m.signal === 'buy' ? 3 : m.signal === 'lean' ? 1 : 0;
    if (weight && (!best || weight > best.weight || (weight === best.weight && Math.abs(m.avgDev) > Math.abs(best.avgDev)))) best = { ...m, key: k, weight };
  }
  return { ...j, pre, fresh, best };
}

/** The status column: a signal, or the plain reason there cannot be one. */
function word(g, st) {
  if (g.state === 'post') return [`Total ${g.away.pts + g.home.pts}`, ''];
  if (!st) return ['No pregame line', ''];
  if (!st.fresh) return [g.live ? 'Line is stale' : 'No live line', ''];
  const b = st.best, where = b && b.key !== 'total' ? `, ${g[b.key].abbr}` : '';
  if (b && b.weight === 3) return [`${b.side}${where}`, b.side === 'Over' ? 'is-over' : 'is-under'];
  if (Math.abs(st.pre[1]) >= RULES.blowoutSpread) return [`Spread over ${RULES.blowoutSpread}`, ''];
  if (g.minute < RULES.firstMinute) return [`Before minute ${RULES.firstMinute}`, ''];
  if (g.minute > RULES.lastMinute) return [`Past minute ${RULES.lastMinute}`, ''];
  if (Math.abs(g.away.pts - g.home.pts) >= RULES.blowoutLead) return [`Lead over ${RULES.blowoutLead}`, ''];
  if (b) return [`Watch, ${b.side.toLowerCase()}${where}`, 'is-live'];
  return ['In window', 'is-live'];
}

/* ---------- routing ---------- */
function route() {
  const [view, a, b, c] = location.hash.replace(/^#\/?/, '').split('/');
  if (view === 'game') return { view: 'game', date: /^\d{8}$/.test(a || '') ? a : S.date, sel: b || S.sel, market: ['total', 'away', 'home'].includes(c) ? c : S.market };
  if (view === 'record') return { view: 'record', date: S.date };
  if (view === 'about') return { view: 'about', date: S.date };
  return { view: 'board', date: /^\d{8}$/.test(a || '') ? a : S.view === 'board' ? today() : S.date };
}
function go(hash) { if (location.hash === hash) applyRoute(); else location.hash = hash; }
const boardHash = (d) => (d === today() ? '#/board' : `#/board/${d}`);
const gameHash = (id, market = S.market, date = S.date) => `#/game/${date}/${id}/${market}`;

async function applyRoute() {
  const r = route();
  const dateChanged = r.date !== S.date;
  Object.assign(S, { view: r.view, date: r.date, sel: r.sel || (r.view === 'game' ? S.sel : null), market: r.market || S.market });
  if (dateChanged) { S.games.clear(); S.recorded = new Map(); S.yardDay = null; S.cursor = -1; S.histKey = null; }
  for (const b of document.querySelectorAll('.nav button')) b.toggleAttribute('aria-current', false);
  const cur = $(`.nav button[data-view="${S.view}"]`); if (cur) cur.setAttribute('aria-current', 'page');
  for (const v of ['board', 'game', 'record', 'about']) $(`#view-${v}`).hidden = v !== S.view;
  render();
  if (dateChanged || !S.games.size) await refresh(true);
  if (S.view === 'game') openSelected();
  window.scrollTo(0, 0);
}

async function openSelected() {
  const g = S.games.get(S.sel);
  if (!g) return;
  const jobs = [];
  if (!g.timeline || (g.state === 'in' && Date.now() - g.timelineAt > 60000)) jobs.push(loadTimeline(g));
  if (!g.pre || (g.state === 'in' && isToday())) jobs.push(loadOdds(g));
  if (!jobs.length) return;
  await Promise.all(jobs.map((p) => p.catch(() => {})));
  if (S.view === 'game' && S.sel === g.id) renderGame();
}

/* ---------- board ---------- */
/** Book against fair at every reading of a game: each reading's gap, and the three-minute average the signal is judged on. */
function series(g, k = 'total') {
  const key = `${g.id}:${k}`;
  if (S.memo.has(key)) return S.memo.get(key);
  const out = tracked(g).map((row) => { const m = row.markets[k]; return { t: row.t, gap: m.edge, dev: m.dev, avgGap: m.avgEdge, avg: m.avgDev, sigma: m.sigma, book: m.line, fair: m.fair, over: m.over, off: row.lopsided }; });
  S.memo.set(key, out);
  return out;
}

/**
 * A market's readings up to the minute signals stop. Past it the fair number means little (fouling, the clock, and a book
 * that starts pricing overtime in a tied game), so the small charts and their summaries end there.
 */
const inWindow = (g, k = 'total') => series(g, k).filter((p) => p.t <= RULES.lastMinute);

/** True when no signal can fire in this game at all: the pregame spread is past the limit. */
const wideSpread = (g) => { const pre = preOf(g); return !!pre && Math.abs(pre[1]) >= RULES.blowoutSpread; };

/** What the rule would have logged where it is switched off (a wide spread or a big lead). Shown beside the record, never in it. */
function shadowOf(g) {
  const key = `${g.id}:shadow`;
  if (S.memo.has(key)) return S.memo.get(key);
  const pre = preOf(g);
  const out = pre && S.model ? S.model.signalsFor(pre, readingsOf(g), g.state === 'post' ? { away: g.away.pts, home: g.home.pts } : null, { yard: yard(), lopsided: true }) : [];
  S.memo.set(key, out);
  return out;
}

function signalsOf(g) {
  const key = `${g.id}:signals`;
  if (S.memo.has(key)) return S.memo.get(key);
  const pre = preOf(g);
  const out = pre && S.model && Math.abs(pre[1]) < RULES.blowoutSpread ? S.model.signalsFor(pre, readingsOf(g), g.state === 'post' ? { away: g.away.pts, home: g.home.pts } : null, { yard: yard() }) : [];
  S.memo.set(key, out);
  return out;
}

/** What the three-minute average did, in a sentence: how often it went past the signal distance, and how far. */
function excursion(s, g) {
  const a = s.filter((p) => p.avg != null);
  if (!a.length) return s.length ? 'Not yet three minutes of line to average.' : 'No line recorded.';
  const far = a.filter((p) => Math.abs(p.avg) >= RULES.buyDev), out = far.length;
  const peak = a.reduce((b, p) => (Math.abs(p.avg) > Math.abs(b.avg) ? p : b), a[0]);
  if (g && wideSpread(g)) {
    const spread = `Signals are off in this game: the pregame spread was ${f1(Math.abs(preOf(g)[1]))}, and the rule stops at ${RULES.blowoutSpread}.`;
    return out ? `${spread} The average peaked at ${dev1(peak.avg)} deviations, or ${f1(Math.abs(peak.avgGap))} points.` : spread;
  }
  if (!out) return `Stayed inside ${RULES.buyDev} deviations.`;
  const off = far.filter((p) => p.off).length;
  const lead = off === out ? ` All with the lead at ${RULES.blowoutLead} or more, where signals are off.` : off ? ` ${off} with the lead at ${RULES.blowoutLead} or more, where signals are off.` : '';
  return `Beyond ${RULES.buyDev} deviations on ${out} of ${a.length} readings. Peak ${dev1(peak.avg)}, or ${f1(Math.abs(peak.avgGap))} points.${lead}`;
}

/** One game as a small multiple. Returns the card and a function that draws its chart once the card is in the page. */
function trendCard(g, i) {
  const st = g.state === 'in' ? standing(g) : null, s = inWindow(g), now = s[s.length - 1] || null;
  const [text, cls] = word(g, st);
  const card = h('a', `tp${g.state === 'post' ? ' is-final' : ''}${i === S.cursor ? ' is-cursor' : ''}`);
  card.href = gameHash(g.id, st && st.best ? st.best.key : 'total');
  card.dataset.id = g.id;
  const head = h('span', 'tp-head'), teams = h('span', 'tp-teams'), side = h('span', 'tp-side');
  teams.append(teamLine(g.away, g.home, true), teamLine(g.home, g.away, true));
  side.append(h('span', '', clockText(g)), h('span', `c-status ${cls}`, text));
  head.append(teams, side);
  const plot = h('span', 'tp-plot'), nums = h('span', 'tp-nums');
  const num = (label, value, kind) => { const c = h('span'); c.append(document.createTextNode(`${label} `), h('b', kind, value)); return c; };
  nums.append(num('Book', now ? f1(now.book) : '–', 'book'), num('Fair', now ? f1(now.fair) : '–', 'fair'), num('Gap', now ? signed(now.gap) : '–', 'gap'), num('3-min average', now && now.avg != null ? dev1(now.avg) : '–', 'gap'));
  if (now && now.avg != null) nums.lastChild.append(' deviations');
  card.append(head, plot, nums, h('span', 'tp-say', excursion(s, g)));
  return [card, () => trendPanel(plot, { series: s.map((p) => ({ t: p.t, gap: p.dev, avg: p.avg, off: p.off })), threshold: RULES.buyDev, label: `${g.away.name} at ${g.home.name}`, signals: signalsOf(g).filter((x) => x.market === 'total') })];
}

const clockText = (g) => (g.state === 'post' ? 'Final' : g.detail.replace(' - ', ' ').replace('Halftime', 'Half'));

function teamLine(t, other, played) {
  const row = h('span', `tm${played && t.pts > other.pts ? ' is-ahead' : ''}`), nm = h('span', 'nm');
  nm.append(document.createTextNode(t.name));
  if (t.rank) nm.append(h('span', 'rk', String(t.rank)));
  row.append(nm, h('span', 'pt', played ? t.pts : ''));
  return row;
}

function standRow(g, i) {
  const st = g.state === 'in' ? standing(g) : null, s = series(g), now = s[s.length - 1] || null;
  const [text, cls] = word(g, st);
  const row = h('a', `stand-row${g.state === 'post' ? ' is-final' : ''}${i === S.cursor ? ' is-cursor' : ''}`);
  row.href = gameHash(g.id, st && st.best ? st.best.key : 'total');
  row.dataset.id = g.id;
  const game = h('span', 'c-game'); game.append(teamLine(g.away, g.home, true), teamLine(g.home, g.away, true));
  const gaps = s.filter((p) => p.avg != null).map((p) => p.avg);
  const plot = h('span', 'c-plot');
  plot.append(rangePlot({ gap: now ? now.avg : null, lo: gaps.length ? Math.min(...gaps) : null, hi: gaps.length ? Math.max(...gaps) : null, signal: !!(st && st.best && st.best.weight === 3 && st.best.key === 'total'), threshold: RULES.buyDev, span: 2 * RULES.buyDev, unit: ' deviations' }));
  const nums = h('span', 'c-nums');
  const num = (label, value, kind) => { const c = h('span', `c-num ${kind}`, value); c.dataset.l = label; return c; };
  nums.append(num('Book', now ? f1(now.book) : '–', 'book'), num('Fair', now ? f1(now.fair) : '–', 'fair'), num('Gap', now ? signed(now.gap) : '–', 'gap'), num('Avg', now && now.avg != null ? signed(now.avg) : '–', 'over'));
  row.append(game, h('span', 'c-clock', clockText(g)), plot, nums, h('span', `c-status ${cls}`, text));
  return row;
}

const heat = (g) => { const st = standing(g); if (!st) return -1; const big = Math.max(...['total', 'away', 'home'].map((k) => Math.abs(st.markets[k].avgDev || 0))); return (st.best ? st.best.weight * 100 : 0) + (st.eligible ? 50 : 0) + big; };

/** The rows of the board, in order: live games with a line by how much is going on, then finished games whose line was recorded. */
function standGames() {
  const all = [...S.games.values()];
  const live = all.filter((g) => g.state === 'in' && preOf(g)).sort((a, b) => heat(b) - heat(a));
  if (S.only) return live.filter((g) => { const st = standing(g); return st && st.best; });
  // Finished games: the ones that fired a signal first, then by how far the average ever got.
  const peak = (g) => Math.max(0, ...series(g).filter((p) => !p.off && p.avg != null).map((p) => Math.abs(p.avg)));
  const done = all.filter((g) => g.state === 'post' && series(g).length).sort((a, b) => signalsOf(b).length - signalsOf(a).length || peak(b) - peak(a));
  return live.concat(done);
}

function schedRow(g, right) {
  const b = h('button'); b.type = 'button';
  const who = `${g.away.rank ? g.away.rank + ' ' : ''}${g.away.name} at ${g.home.rank ? g.home.rank + ' ' : ''}${g.home.name}`;
  b.append(h('span', 'when', g.state === 'pre' ? timeLabel(g.start) : 'Final'), h('span', 'who', who), h('span', 'what', right));
  b.addEventListener('click', () => go(gameHash(g.id, 'total')));
  return b;
}

/** The slate in one finding: how far the book ran from fair, which way it missed, and whether anything held. */
function renderLead(all) {
  const gaps = [], devs = [];
  let signals = 0, measured = 0;
  for (const g of all) {
    const s = series(g).filter((p) => p.t >= RULES.measureFrom && p.t <= RULES.measureTo && !p.off); // only where a signal can fire
    if (!s.length) continue;
    measured += 1;
    for (const p of s) { gaps.push(p.gap); if (p.avg != null) devs.push(p.avg); }
    signals += signalsOf(g).length;
  }
  const st = { ...gapStats(devs, RULES.buyDev), abs: gapStats(gaps).abs }, live = all.filter((g) => g.state === 'in').length, ahead = all.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.start) - new Date(b.start));
  // The headline says what there is to act on; js/words.js holds the wording for every state of a slate.
  const sig = all.flatMap((g) => signalsOf(g)), count = (r) => sig.filter((x) => x.result === r).length;
  const { head, sub } = boardWords({
    loaded: !!S.scoresAt, today: isToday(), weekday: new Date(toUTC(S.date)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    games: all.length, live, ahead: ahead.length, nextTip: ahead.length ? timeLabel(ahead[0].start) : '', anyFinal: all.some((g) => g.state === 'post'),
    readings: st.n, apart: st.abs || 0, firstMinute: RULES.firstMinute, afterFact: S.date < RULES.ruleSince,
    signals: { n: sig.length, open: count('Pending'), won: count('Won'), lost: count('Lost'), pushed: count('Push') },
  });
  $('#view-board').classList.toggle('no-lines', !st.n); // before any line is recorded the schedule leads and the empty figures step aside
  $('#lead-head').textContent = head;
  $('#lead-sub').textContent = sub; $('#lead-sub').hidden = !sub;
  $('#fig-abs').textContent = st.n ? st.abs.toFixed(1) : '–';
  $('#fig-low').textContent = st.n ? `${st.low.toFixed(1)}%` : '–';
  $('#fig-high').textContent = st.n ? `${st.high.toFixed(1)}%` : '–';
  $('#fig-sig').textContent = st.n ? String(signals) : '–';
  const y = yard();
  $('#sigma-note').textContent = `The bold line is the three-minute rolling average of fair minus book, and the signal is judged on it. One deviation is ${y.total.toFixed(1)} points, the usual spread of that average. A signal needs ${RULES.buyDev}, about ${(RULES.buyDev * y.total).toFixed(1)} points, at a price the chance clears.${y.readings ? ` Measured on ${y.readings} readings through ${dayLabel(y.through)}.` : ''} Each small chart ends at minute ${RULES.lastMinute}, where signals stop.`;
  $('#hist-title').textContent = st.n ? `All ${plural(st.n, 'reading')}` : 'All readings';
  $('#hist-note').textContent = st.n ? `The three-minute average at every reading between minute ${RULES.measureFrom} and minute ${RULES.measureTo}, across ${plural(measured, 'game')}. Lopsided spots are left out, because signals are off there.` : 'The distribution fills in as lines are recorded.';
  return devs;
}

/** Drawn last, once the layout around it has settled, so the chart is built at the width it will be shown at. */
function renderHistogram(gaps) {
  const host = $('#hist'), key = `${S.date}:${gaps.length}:${host.clientWidth}`;
  if (!gaps.length) { host.replaceChildren(); S.histKey = null; return; }
  if (S.histKey === key) return;
  histogram(host, gaps, { threshold: RULES.buyDev, span: 2 * RULES.buyDev, bin: 0.25 });
  S.histKey = key;
}

const DONE_SHOWN = 8, FEED_SHOWN = 6, GAME_FEED_SHOWN = 3, LEDGER_SHOWN = 20, UNITS_FROM = 10; // the units chart waits for ten settled signals
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The latest reading of a live game with a fresh line, or null. An open signal is checked against it. */
function nowRow(g) {
  if (g.state !== 'in' || g.period > 2 || !g.live || Date.now() - g.live.at >= RULES.staleMs) return null;
  const rows = tracked(g), row = rows[rows.length - 1];
  return row && Math.abs(row.t - g.minute) < 1.5 ? row : null;
}

const NEW_SEC = 180; // a signal reads "New" for this long after it fires
const openFirst = (a, b) => (a.s.result === 'Pending' ? 0 : 1) - (b.s.result === 'Pending' ? 0 : 1) || b.s.at - a.s.at;

/**
 * One signal as a row: its result, what was bought and where, and how it ended. While it is open in a live game the
 * row also says whether the bet can still be made on the line showing now. withGame names the matchup (the board's list).
 */
function signalRow(g, s, withGame) {
  const b = h('button'); b.type = 'button';
  const name = s.market === 'total' ? 'Game total' : `${(s.market === 'away' ? g.away : g.home).name} total`;
  const open = s.result === 'Pending', live = open && g.state === 'in' && isToday(), age = Date.now() / 1000 - s.at;
  const ago = live ? agoWords(age) : '';
  const who = h('span', 'who');
  who.append(h('span', '', `${name}, ${s.side.toLowerCase()} ${f1(s.line)}`),
    h('span', 'feed-sub', `${withGame ? `${g.away.name} at ${g.home.name}, ` : ''}${clockLabel(s.minute)}${withGame ? '' : `, score ${s.score}`}${ago ? `, ${ago}` : ''}`));
  if (live) { const w = signalWords(signalNow(s, nowRow(g)), { lastMinute: RULES.lastMinute, lead: RULES.blowoutLead }); who.append(h('span', `feed-now${w.on ? ' is-on' : ''}`, w.text)); }
  const cb = live && s.market === 'total' ? cbQuote(g, standing(g)) : null;
  if (cb && cb[s.side]) who.append(h('span', `feed-now cb-now${cb[s.side].edge >= (CB.cfg.margin || 0.05) ? ' is-on' : ''}`, quoteWords(s.side, cb[s.side])));
  const res = !open ? s.result : live && age < NEW_SEC ? 'New' : 'Open';
  b.append(h('span', `when ${s.result === 'Won' ? 'won' : s.result === 'Lost' ? 'lost' : open ? 'is-open' : ''}`, res), who, h('span', 'what', s.final == null ? `fair ${f1(s.fair)}` : `final ${s.final}`));
  b.addEventListener('click', () => go(gameHash(g.id, s.market)));
  return b;
}

/** Every signal on the slate in one list: open ones first, then the newest. The quickest read of what there is to act on. */
function renderFeed(all) {
  const rows = [];
  for (const g of all) for (const s of signalsOf(g)) rows.push({ g, s });
  rows.sort(openFirst);
  const block = $('#feed-block'), open = rows.filter((r) => r.s.result === 'Pending').length;
  block.hidden = !rows.length || S.only;
  if (block.hidden) return;
  const won = rows.filter((r) => r.s.result === 'Won').length, lost = rows.filter((r) => r.s.result === 'Lost').length;
  $('#feed-h').textContent = open ? 'Signals, open ones first' : 'Signals, newest first'; // the headline carries the count and the record
  const shown = S.allFeed ? rows : rows.slice(0, Math.max(FEED_SHOWN, open));
  $('#feed').replaceChildren(...shown.map(({ g, s }) => signalRow(g, s, true)));
  const moreBtn = $('#feed-more');
  moreBtn.hidden = shown.length === rows.length;
  moreBtn.textContent = `Show all ${rows.length} signals`;
}

function renderBoard() {
  $('#day').textContent = dayLabel(S.date);
  $('#only').setAttribute('aria-pressed', String(S.only));
  const all = [...S.games.values()], nLive = all.filter((g) => g.state === 'in').length, rows = standGames();
  const gaps = renderLead(all);
  const trend = S.mode === 'trend';
  for (const b of document.querySelectorAll('#mode button')) b.setAttribute('aria-pressed', String(b.dataset.mode === S.mode));
  $('#trend-key').hidden = !trend || !rows.length; $('#table-key').hidden = trend || !rows.length;
  $('#wall').hidden = !trend || !rows.length; $('#stand').hidden = trend || !rows.length;
  // A finished slate is sixty charts long. Live games always draw; finished ones show the first few until asked.
  const liveRows = rows.filter((g) => g.state === 'in'), doneRows = rows.filter((g) => g.state !== 'in');
  const shown = trend && !S.allDone ? liveRows.concat(doneRows.slice(0, DONE_SHOWN)) : rows;
  const more = $('#more-games');
  more.hidden = !trend || shown.length === rows.length;
  more.textContent = `Show all ${doneRows.length} finished games`;
  renderFeed(all);
  if (trend) {
    const cards = shown.map(trendCard);
    $('#wall').replaceChildren(...cards.map((c) => c[0]));
    for (const c of cards) c[1]();
    $('#stand-rows').replaceChildren();
  } else {
    $('#stand-rows').replaceChildren(...rows.map(standRow));
    $('#wall').replaceChildren();
  }
  const unlined = all.filter((g) => g.state === 'in' && !preOf(g)).length;
  $('#board-unlined').hidden = !unlined || S.only;
  $('#board-unlined').textContent = `${unlined} more in progress with no sportsbook line, so nothing to measure.`;
  const empty = $('#board-empty');
  empty.hidden = rows.length > 0;
  empty.textContent = !S.scoresAt ? 'Loading the scoreboard.' : S.only ? 'No signals right now. An empty board is a valid result.' : nLive ? 'Games are in progress, but none has a sportsbook line yet.' : isToday() ? 'No games in progress. The board fills in at tip-off.' : 'No lines were recorded on this date.';
  const next = all.filter((g) => g.state === 'pre').sort((a, b) => new Date(a.start) - new Date(b.start));
  $('#next-rows').replaceChildren(...next.map((g) => schedRow(g, g.pre ? `${g.pre[0]}, ${g.pre[1] <= 0 ? g.home.abbr : g.away.abbr} by ${Math.abs(g.pre[1])}` : 'No line')));
  $('#next').hidden = !next.length;
  const done = all.filter((g) => g.state === 'post' && !series(g).length);
  $('#final-rows').replaceChildren(...done.map((g) => schedRow(g, `${g.away.pts}–${g.home.pts}`)));
  $('#finals-sum').textContent = `${done.length} finished game${done.length === 1 ? '' : 's'} with no line recorded`;
  $('#finals').hidden = !done.length;
  renderBookLine();
  renderHistogram(gaps);
}

/* ---------- game ---------- */
function sentence(g, st, k, book) {
  const pre = preOf(g);
  if (!pre) return ['The sportsbook posted no line for this game, so there is no pace to measure it against.', ''];
  if (g.state === 'pre') return [`Tips at ${timeLabel(g.start)}. The sportsbook has the total at ${pre[0]} and ${pre[1] <= 0 ? g.home.name : g.away.name} by ${Math.abs(pre[1])}.`, ''];
  const name = k === 'total' ? 'the total' : `${g[k].name}’s team total`;
  if (g.state === 'post') {
    const final = k === 'total' ? g.away.pts + g.home.pts : g[k].pts;
    const preK = k === 'total' ? pre[0] : k === 'away' ? pre[0] / 2 + pre[1] / 2 : pre[0] / 2 - pre[1] / 2;
    return [`Final ${final} against a pregame ${f1(preK)}. ${book.length ? `The live line was recorded ${book.length} times.` : 'The live line was not recorded. ESPN drops it at the final whistle.'}`, ''];
  }
  const m = st.markets[k];
  if (!st.fresh || m.line == null) return ['The sportsbook is not showing a live line right now. No read without a fresh line.', ''];
  const low = (v) => `${f1(Math.abs(v))} ${v >= 0 ? 'low' : 'high'}`;
  const now = `The sportsbook has ${name} at ${f1(m.line)}${k === 'total' ? '' : ' (implied)'}. Fair is ${f1(m.fair)}, so the book is ${low(m.edge)} right now.`;
  if (m.avgDev == null) return [`${now} The three-minute average starts once the line has been followed for three minutes.`, ''];
  const lead = `${now} Over the last three minutes it has averaged ${low(m.avgEdge)}: ${Math.abs(m.avgDev).toFixed(1)} deviations.`;
  if (m.signal === 'buy') return [`${lead} The ${m.side.toLowerCase()} has a ${Math.round(m.chance * 100)}% chance. Signal: ${m.side.toLowerCase()}.`, m.side === 'Over' ? 'is-over' : 'is-under'];
  if (m.signal === 'lean') return [`${lead} On watch: a signal needs ${RULES.buyDev}.`, ''];
  if (!st.eligible) {
    const why = g.minute < RULES.firstMinute ? `before minute ${RULES.firstMinute}` : g.minute > RULES.lastMinute ? `after minute ${RULES.lastMinute}` : Math.abs(st.pre[1]) >= RULES.blowoutSpread ? `on a ${RULES.blowoutSpread}-point spread` : `at a ${RULES.blowoutLead}-point lead`;
    return [`${lead} No signals ${why}.`, ''];
  }
  return [`${lead} That is the usual back and forth.`, ''];
}

function renderGame() {
  const g = S.games.get(S.sel);
  $('#back').href = boardHash(S.date);
  $('#game-none').hidden = !!g;
  $('#game-body').hidden = !g;
  if (!g) { $('#game-none').textContent = S.sel && !S.scoresAt ? 'Loading the game.' : 'Pick a game from the board.'; return; }
  const k = S.market, pre = preOf(g), st = standing(g), book = readingsOf(g);
  const side = (id, t, short) => {
    const tm = h('div', 'tm'); if (t.rank) tm.append(h('span', 'rk', String(t.rank))); tm.append(document.createTextNode(t.name));
    $(id).replaceChildren(tm, h('div', 'beh', short == null || g.state === 'pre' ? '' : short >= 0 ? `${f1(short)} behind pace` : `${f1(-short)} ahead of pace`));
  };
  side('#side-away', g.away, st ? st.fair.awayShort : null);
  side('#side-home', g.home, st ? st.fair.homeShort : null);
  $('#pts-away').textContent = g.state === 'pre' ? '–' : g.away.pts;
  $('#pts-home').textContent = g.state === 'pre' ? '–' : g.home.pts;
  const [c1, c2] = g.state === 'pre' ? [timeLabel(g.start), dayLabel(S.date)] : g.state === 'post' ? ['Final', dayLabel(S.date)] : g.detail.split(' - ');
  $('#clock').replaceChildren(h('b', '', c1), document.createTextNode(c2 || ''));
  for (const b of document.querySelectorAll('#markets button')) b.setAttribute('aria-pressed', String(b.dataset.market === k));
  $('#mk-away').textContent = g.away.name; $('#mk-home').textContent = g.home.name;
  $('#lg-away').textContent = g.away.name; $('#lg-home').textContent = g.home.name;
  const [text, cls] = sentence(g, st, k, book);
  $('#read').textContent = text; $('#read').className = `read ${cls}`;
  // The signals lead the page: what fired, where, and for an open one whether it can still be bet.
  const lead = signalsOf(g).map((s) => ({ g, s })).sort(openFirst);
  const top = lead.slice(0, Math.max(GAME_FEED_SHOWN, lead.filter((x) => x.s.result === 'Pending').length)); // every open one, then the newest
  $('#game-feed').replaceChildren(...top.map(({ s }) => signalRow(g, s, false)));
  if (top.length < lead.length) {
    const more = h('button', 'feed-all', `All ${lead.length} signals in this game, in full`); more.type = 'button';
    more.addEventListener('click', () => $('#sig-block').scrollIntoView({ block: 'start' }));
    $('#game-feed').append(more);
  }
  $('#game-feed').hidden = !lead.length;
  renderBookLink(g, st);
  renderCoinbase(g, st);

  const m = st ? st.markets[k] : null;
  const rows = tracked(g), lastRec = rows.length ? rows[rows.length - 1].markets[k] : null;
  const shown = g.state === 'in' && m && m.line != null ? m : g.state !== 'pre' ? lastRec : null;
  const preK = pre ? (k === 'total' ? pre[0] : k === 'away' ? pre[0] / 2 + pre[1] / 2 : pre[0] / 2 - pre[1] / 2) : null;
  const lastLine = g.state === 'post' ? ', last line' : '';
  $('#f-book-l').textContent = (k === 'total' ? 'Sportsbook live' : 'Sportsbook, implied') + lastLine;
  $('#f-fair-l').textContent = g.state === 'post' ? 'Fair, at that reading' : 'Fair';
  $('#f-book').textContent = shown ? f1(shown.line) : '–';
  $('#f-fair').textContent = g.state === 'pre' ? f1(preK) : g.state === 'post' ? (lastRec ? f1(lastRec.fair) : '–') : m ? f1(m.fair) : '–';
  $('#f-gap').textContent = shown ? signed(shown.edge) : '–';
  $('#f-gap').className = '';
  $('#f-dev').textContent = shown && shown.avgDev != null ? signed(shown.avgDev) : '–';
  $('#f-dev').className = shown && shown.avgDev != null && Math.abs(shown.avgDev) >= RULES.buyDev ? (shown.avgDev > 0 ? 'is-over' : 'is-under') : '';
  $('#f-sigma').textContent = shown ? `Three-minute average, in deviations of ${f1(shown.sigma)} points` : 'Three-minute average, in deviations';
  $('#f-over').textContent = g.state === 'in' && m && m.over != null ? `${Math.round(m.over * 100)}%` : '–';
  $('#f-pre').textContent = f1(preK);
  const paceK = st && g.state === 'in' ? (k === 'total' ? st.fair.paceTotal : k === 'away' ? st.fair.paceAway : st.fair.paceHome) : null;
  $('#f-pace').textContent = f1(paceK);
  for (const id of ['#f-over', '#f-pace']) $(id).parentElement.hidden = g.state !== 'in';

  const host = $('#chart'), scrub = $('#scrub');
  const tl = (g.timeline || [{ t: 0, a: 0, h: 0 }]).filter((p) => p.t <= 40).slice();
  for (const r of g.r) { const last = tl[tl.length - 1]; if (r[1] > last.t && r[1] <= 40 && (r[2] !== last.a || r[3] !== last.h)) tl.push({ t: r[1], a: r[2], h: r[3] }); }
  if (g.state === 'in' && g.minute <= 40 && g.minute > tl[tl.length - 1].t) tl.push({ t: g.minute, a: g.away.pts, h: g.home.pts });
  if (!pre || !S.model || (tl.length < 2 && !book.length)) {
    host.replaceChildren(h('p', 'vacant', !pre ? 'No chart without a pregame line.' : g.state === 'pre' ? 'The chart starts at tip-off.' : 'Loading the play-by-play.'));
    scrub.textContent = ''; $('#mk-wall').replaceChildren(); $('#sig-rows').replaceChildren(); $('#sig-none').hidden = false; $('#sig-sheet').hidden = true; $('#sig-off').hidden = true; $('#shadow-sheet').hidden = true; return;
  }
  const paceKey = k === 'total' ? 'paceTotal' : k === 'away' ? 'paceAway' : 'paceHome';
  const fairPts = [], pacePts = [];
  for (const p of tl) { if (p.t < 2) continue; const f = S.model.fair(pre, p.t, p.a, p.h); fairPts.push({ t: p.t, v: f[k], band: RULES.buyDev * (k === 'total' ? yard().total : yard().team) }); if (f[paceKey] != null && p.t >= 6) pacePts.push({ t: p.t, v: f[paceKey] }); }
  const bookPts = rows.map((row) => ({ t: row.t, v: row.markets[k].line, fair: row.markets[k].fair }));
  const finals = g.state === 'post' ? { away: g.away.pts, home: g.home.pts } : null;
  const signals = S.model.signalsFor(pre, book, finals, { yard: yard() });
  const share = [[0, 0]]; for (let t = 2; t <= 38; t += 1) share.push([t, S.model.share(t)]); share.push([40, 1]);
  const idle = () => { scrub.textContent = 'Drag across the chart to read any minute.'; };
  gameChart(host, {
    pregame: preK, preAway: pre[0] / 2 + pre[1] / 2, preHome: pre[0] / 2 - pre[1] / 2, final: finals ? (k === 'total' ? finals.away + finals.home : finals[k]) : null,
    fair: fairPts, pace: pacePts, book: bookPts, flow: tl, share, signals: signals.filter((s) => s.market === k), awayName: g.away.name, homeName: g.home.name,
    onScrub(p) {
      if (!p) { idle(); return; }
      scrub.replaceChildren(h('b', '', `${clockLabel(p.t)}  ${p.a}-${p.h}`));
      if (p.book != null) scrub.append(h('b', 'v-book', `Book ${f1(p.book)}`));
      if (p.fair != null) scrub.append(h('b', 'v-fair', `Fair ${f1(p.fair)}`));
      if (p.book != null && p.fair != null) scrub.append(h('b', '', `Gap ${signed(p.fair - p.book)}`));
      if (p.pace != null) scrub.append(document.createTextNode(`Pace ${f1(p.pace)}`));
    },
  });
  idle();
  const cards = ['total', 'away', 'home'].map((mk) => {
    const sm = inWindow(g, mk), end = sm[sm.length - 1] || null, card = h('button', 'tp'), plot = h('span', 'tp-plot'), nums = h('span', 'tp-nums');
    card.type = 'button'; card.setAttribute('aria-pressed', String(mk === k));
    const title = mk === 'total' ? 'Game total' : `${g[mk].name} team total`;
    const num = (lb, value, kind) => { const c = h('span'); c.append(document.createTextNode(`${lb} `), h('b', kind, value)); return c; };
    nums.append(num(mk === 'total' ? 'Book' : 'Book, implied', end ? f1(end.book) : '–', 'book'), num('Fair', end ? f1(end.fair) : '–', 'fair'), num('Gap', end ? signed(end.gap) : '–', 'gap'));
    nums.append(num('3-min average', end && end.avg != null ? dev1(end.avg) : '–', 'gap'));
    if (end && end.avg != null) nums.lastChild.append(' deviations');
    card.append(h('span', 'tp-title', title), plot, nums, h('span', 'tp-say', excursion(sm, g)));
    card.addEventListener('click', () => go(gameHash(g.id, mk)));
    return [card, () => trendPanel(plot, { series: sm.map((p) => ({ t: p.t, gap: p.dev, avg: p.avg, off: p.off })), threshold: RULES.buyDev, label: title, signals: signals.filter((x) => x.market === mk) })];
  });
  $('#mk-wall').replaceChildren(...cards.map((c) => c[0]));
  for (const c of cards) c[1]();
  const label = (s) => (s.market === 'total' ? 'Game total' : `${g[s.market].name} team total`);
  const sigRow = (s) => {
    const tr = document.createElement('tr');
    for (const [v, c] of [[label(s)], [s.side], [clockLabel(s.minute)], [s.score], [f1(s.line), 'r'], [f1(s.fair), 'r'], [signed(s.dev), 'r'], [`${Math.round(s.chance * 100)}%`, 'r'], [s.final == null ? '' : s.final, 'r'], [s.result, s.result === 'Won' ? 'won' : s.result === 'Lost' ? 'lost' : '']]) tr.append(h('td', c || '', v));
    forPhone(tr, [0, 4, 8, 9], `${s.side}, ${clockLabel(s.minute)}`);
    return tr;
  };
  $('#sig-rows').replaceChildren(...signals.map(sigRow));
  const wide = wideSpread(g), shadow = shadowOf(g), count = (r) => shadow.filter((s) => s.result === r).length;
  $('#sig-none').textContent = wide ? `None. Signals are off in this game: the pregame spread was ${f1(Math.abs(pre[1]))}, and the rule stops at ${RULES.blowoutSpread}.` : 'None. An empty list is a valid result.';
  $('#sig-none').hidden = signals.length > 0;
  $('#sig-sheet').hidden = !signals.length;
  // What the same rule would have logged where it is switched off. Shown so the choice to leave those spots out can be judged.
  const settled = count('Won') + count('Lost');
  $('#sig-off').textContent = `Had signals been on ${wide ? 'in this game' : `while the lead was ${RULES.blowoutLead} or more`}, the rule would have logged ${shadow.length}${settled ? `: ${count('Won')} won, ${count('Lost')} lost` : ''}. These are kept beside the record, not in it.`;
  $('#sig-off').hidden = !shadow.length;
  $('#shadow-rows').replaceChildren(...shadow.map(sigRow));
  $('#shadow-sheet').hidden = !shadow.length;
}

/* ---------- record ---------- */
const RULE_LABELS = {
  signal: `Three-minute average at ${RULES.buyDev} deviations: the signal`,
  'avg3-1.5': 'Three-minute average at 1.5',
  'avg3-2.5': 'Three-minute average at 2.5',
  'avg3-3': 'Three-minute average at 3',
  'avg2-2': 'Two-minute average at 2',
  'avg5-2': 'Five-minute average at 2',
  'one-2': 'A single reading at 2',
  'one-3': 'A single reading at 3',
  'one-2-after-1.5': 'A single reading at 2, after 1.5 a minute earlier',
  lopsided: 'The signal where it is switched off: wide spreads and big leads',
};
// The signal with one thing changed. Tracked beside the record so a change to the rule is made on results.
const IDEA_LABELS = {
  signal: 'The signal as it stands',
  'signal-totals': 'Game totals only',
  'signal-teams': 'Team totals only (estimated prices)',
  'signal-to-34': 'Stopping at minute 34',
  'signal-repeat': 'Firing again after the gap closes',
  'cold-over': 'Cold-stretch overs: scoring well behind pace',
  'cold-over-lopsided': 'Cold-stretch overs in lopsided games',
};
function renderRecord() {
  const L = S.ledger.slice().sort((a, b) => b.ts - a.ts);
  const tally = (rows) => { const w = rows.filter((s) => s.result === 'Won').length, l = rows.filter((s) => s.result === 'Lost').length; return w + l ? `${w}–${l}` : '–'; };
  const pay = (s) => (s.result === 'Won' ? (s.price > 0 ? s.price / 100 : 100 / -s.price) : s.result === 'Lost' ? -1 : 0);
  // Signals scored as they happened under the current rule are the record. Slates from before the rule was last
  // changed are scored again under it after the fact, and are shown apart.
  const live = L.filter((s) => s.date >= RULES.ruleSince), back = L.filter((s) => s.date < RULES.ruleSince);
  const settled = live.filter((s) => s.result === 'Won' || s.result === 'Lost'), units = settled.reduce((u, s) => u + pay(s), 0);
  const won = settled.filter((s) => s.result === 'Won').length, pushed = live.filter((s) => s.result === 'Push').length, open = live.length - settled.length - pushed;
  const since = new Date(toUTC(RULES.ruleSince)).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }), games = new Set(live.map((s) => s.game)).size;
  $('#rec-head').textContent = live.length ? `${live.length} signal${live.length === 1 ? '' : 's'} in ${games} game${games === 1 ? '' : 's'} since ${since}: ${won} won, ${settled.length - won} lost${pushed ? `, ${pushed} pushed` : ''}${open ? `, ${open} still open` : ''}.`
    : back.length ? `No signal has been scored live under the current rule yet. It took effect on ${since}.` : 'No signal has fired yet.';
  document.querySelector('.sums').hidden = !live.length;
  $('#r-all').textContent = tally(live);
  $('#r-units').textContent = settled.length ? signed(units) : '–';
  $('#r-units').className = settled.length && units > 0 ? 'is-over' : settled.length && units < 0 ? 'is-under' : '';
  // By game: a game total and its team totals are one view of one game, so each game counts once, by its net units.
  const net = new Map();
  for (const s of live) if (s.result === 'Won' || s.result === 'Lost' || s.result === 'Push') net.set(s.game, (net.get(s.game) || 0) + pay(s));
  const ahead = [...net.values()].filter((u) => u > 0).length, behind = [...net.values()].filter((u) => u < 0).length;
  $('#r-games').textContent = net.size ? `${ahead}–${behind}` : '–';
  $('#r-totals').textContent = tally(live.filter((s) => (s.mkt || '') === 'total' || s.market === 'Game total'));
  const sides = [['Overs', tally(live.filter((s) => s.side === 'Over'))], ['Unders', tally(live.filter((s) => s.side === 'Under'))]].filter((x) => x[1] !== '–');
  $('#r-sides').textContent = sides.map((x) => `${x[0]} ${x[1]}.`).join(' ') + (net.size - ahead - behind ? ` ${plural(net.size - ahead - behind, 'game')} level.` : '');
  $('#r-sides').hidden = !sides.length;
  // Units signal by signal, in the order they fired: every live-scored signal, and game totals alone beside it.
  const run = live.filter((s) => s.result === 'Won' || s.result === 'Lost' || s.result === 'Push').sort((a, b) => a.ts - b.ts);
  let all = 0, tot = 0;
  const steps = run.map((s) => { all += pay(s); if ((s.mkt || '') === 'total' || s.market === 'Game total') tot += pay(s); return { all, totals: tot, date: s.date }; });
  $('#units-block').hidden = steps.length < UNITS_FROM;
  if (steps.length >= UNITS_FROM) unitsChart($('#units'), steps, { dayLabel: (d) => dayLabel(d).split(', ').pop() });
  const splitRow = (label, rows) => {
    const w = rows.filter((s) => s.result === 'Won').length, l = rows.filter((s) => s.result === 'Lost').length, tr = document.createElement('tr');
    const pending = rows.filter((s) => s.result !== 'Won' && s.result !== 'Lost' && s.result !== 'Push').length;
    for (const [v, c] of [[label], [rows.length, 'r'], [w + l ? `${w}–${l}` : '–', 'r'], [w + l ? `${Math.round((100 * w) / (w + l))}%` : '–', 'r'], [w + l ? signed(rows.reduce((u, s) => u + pay(s), 0)) : '–', 'r'], [pending || '', 'r']]) tr.append(h('td', c || '', v));
    return tr;
  };
  const isTotal = (s) => (s.mkt || '') === 'total' || s.market === 'Game total';
  const groups = [['Game totals at the quoted price, scored live', live.filter(isTotal)], ['Team totals at an estimated price, scored live', live.filter((s) => !isTotal(s))],
    ['Game totals, scored after the fact', back.filter(isTotal)], ['Team totals, scored after the fact', back.filter((s) => !isTotal(s))]].filter(([, rows]) => rows.length);
  $('#split-rows').replaceChildren(...groups.map(([label, rows]) => splitRow(label, rows)));
  $('#split-block').hidden = !groups.length;
  $('#split-note').textContent = `Game totals are settled at the price the sportsbook was quoting. Team totals are implied from the live total and spread and priced at an estimated −115, so they are the weaker claim. The rule was last changed on ${since}.${back.length ? ' Slates before that were scored again under it after the fact: they show what the rule would have done, and are not a test of it.' : ''}`;
  $('#days-rows').replaceChildren(...S.index.slice().reverse().map((d) => {
    const tr = document.createElement('tr'); tr.tabIndex = 0;
    for (const [v, c] of [[dayLabel(d.date)], [d.games, 'r'], [d.total_readings == null ? d.readings : d.total_readings, 'r'], [d.gap_abs == null ? '–' : d.gap_abs.toFixed(1), 'r'], [d.dev_low == null ? '–' : `${d.dev_low.toFixed(1)}%`, 'r'], [d.dev_high == null ? '–' : `${d.dev_high.toFixed(1)}%`, 'r']]) tr.append(h('td', c || '', v));
    const open = () => go(boardHash(d.date));
    tr.addEventListener('click', open); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return tr;
  }));
  $('#days-none').hidden = S.index.length > 0; $('#days-sheet').hidden = !S.index.length;
  const ladderRow = (label, rows) => {
    const sum = (f) => rows.reduce((t, r) => t + (r[f] || 0), 0), n = sum('n'), w = sum('won'), l = sum('lost'), tr = document.createElement('tr');
    for (const [v, c] of [[label], [n, 'r'], [w + l ? `${w}–${l}` : '–', 'r'], [w + l ? `${Math.round((100 * w) / (w + l))}%` : '–', 'r'], [w + l ? signed(sum('units')) : '–', 'r'], [sum('open') || '', 'r']]) tr.append(h('td', c || '', v));
    return tr;
  };
  const ladder = S.ladder.filter((r) => r.rule), have = (rule) => ladder.some((r) => r.rule === rule);
  $('#ladder-rows').replaceChildren(...Object.entries(RULE_LABELS).filter(([rule]) => have(rule)).map(([rule, label]) => ladderRow(label, ladder.filter((r) => r.rule === rule && r.stage === 'all'))));
  $('#ladder-none').hidden = ladder.length > 0; $('#ladder-sheet').hidden = !ladder.length;
  // What the model said against what happened: the stated chance of each settled signal, in bands.
  const judged = S.ledger.filter((s) => (s.result === 'Won' || s.result === 'Lost') && s.chance != null);
  const bands = [[0, 58, 'Under 58%'], [58, 61, '58 to 61%'], [61, 65, '61 to 65%'], [65, 101, '65% and up']].map(([lo, hi, label]) => [label, judged.filter((s) => s.chance >= lo && s.chance < hi)]).filter(([, rows]) => rows.length);
  const saidRow = (label, rows) => {
    const tr = document.createElement('tr'), won = rows.filter((s) => s.result === 'Won').length;
    for (const [v, c] of [[label], [rows.length, 'r'], [`${Math.round(rows.reduce((a, s) => a + s.chance, 0) / rows.length)}%`, 'r'], [`${Math.round(100 * won / rows.length)}%`, 'r']]) tr.append(h('td', c || '', v));
    return tr;
  };
  $('#said-rows').replaceChildren(...bands.map(([label, rows]) => saidRow(label, rows)), ...(judged.length ? [saidRow('Every settled signal', judged)] : []));
  $('#said-block').hidden = judged.length < 20; // fewer than that says nothing
  const ideas = Object.entries(IDEA_LABELS).filter(([rule]) => have(rule));
  $('#idea-rows').replaceChildren(...ideas.map(([rule, label]) => ladderRow(label, ladder.filter((r) => r.rule === rule && r.stage === 'all'))));
  $('#ideas-block').hidden = ideas.length < 2; // the baseline alone is not a comparison
  $('#stage-rows').replaceChildren(...['4 to 20', '20 to 34', '34 to 38'].map((stage) => ladderRow(`Minutes ${stage}`, ladder.filter((r) => r.rule === 'signal' && r.stage === stage))));
  $('#stage-block').hidden = !ladder.length;
  const settledNow = (s) => s.result === 'Won' || s.result === 'Lost' || s.result === 'Push';
  const F = L.filter((s) => (S.led.result === 'all' || (S.led.result === 'open' ? !settledNow(s) : s.result === S.led.result)) && (S.led.market === 'all' || (S.led.market === 'total') === isTotal(s)));
  for (const [id, k] of [['led-result', 'result'], ['led-market', 'market']]) for (const b of document.querySelectorAll(`#${id} button`)) b.setAttribute('aria-pressed', String(b.dataset.v === S.led[k]));
  const fw = F.filter((s) => s.result === 'Won').length, fl = F.filter((s) => s.result === 'Lost').length, fp = F.filter((s) => s.result === 'Push').length, fo = F.length - fw - fl - fp;
  $('#ledger-count').textContent = F.length ? `${plural(F.length, 'signal')}: ${fw} won, ${fl} lost${fp ? `, ${fp} pushed` : ''}${fo ? `, ${fo} open` : ''}.` : '';
  $('#ledger-count').hidden = !F.length;
  const ledgerShown = S.allLedger ? F : F.slice(0, LEDGER_SHOWN);
  $('#ledger-more').hidden = ledgerShown.length === F.length;
  $('#ledger-more').textContent = `Show all ${F.length} signals`;
  $('#ledger-rows').replaceChildren(...ledgerShown.map((s) => {
    const tr = document.createElement('tr'); tr.tabIndex = 0;
    const price = `${s.price > 0 ? '+' : ''}${s.price}${s.priced === 'Assumed' ? ' est.' : ''}`;
    for (const [v, c] of [[dayLabel(s.date).split(', ').pop()], [s.matchup], [s.market], [s.side], [clockLabel(s.t)], [s.score], [f1(s.line), 'r'], [price, 'r'], [f1(s.fair), 'r'], [s.dev == null ? '–' : signed(s.dev), 'r'], [`${s.chance}%`, 'r'], [s.final == null ? '' : s.final, 'r'], [s.result, s.result === 'Won' ? 'won' : s.result === 'Lost' ? 'lost' : '']]) tr.append(h('td', c || '', v));
    forPhone(tr, [1, 6, 11, 12], `${s.market}, ${s.side.toLowerCase()}, ${dayLabel(s.date).split(', ').pop()}`);
    const open = () => go(gameHash(s.game, s.mkt, s.date));
    tr.addEventListener('click', open); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return tr;
  }));
  $('#ledger-none').textContent = L.length ? 'No signal matches that choice.' : 'No signals logged yet.';
  $('#ledger-none').hidden = F.length > 0; $('#ledger-sheet').hidden = !F.length;
  document.querySelector('.filters').hidden = !L.length;
}

/* ---------- about, and how the site pays for itself (js/site.js; every slot is off until it is filled in) ---------- */
const BOOK = safeLink(SITE.book.url) && SITE.book.name ? { name: SITE.book.name, url: safeLink(SITE.book.url) } : null;
const LIST = safeLink(SITE.newsletter.action);
const SUPPORT = safeLink(SITE.support.url);

/** A referral link, labelled as paid at the place it is clicked. */
function bookLink(host, lead, text) {
  const a = h('a', '', text);
  a.href = BOOK.url; a.target = '_blank'; a.rel = 'sponsored noopener';
  host.replaceChildren(document.createTextNode(lead), a, document.createTextNode(' (paid link)'));
  host.hidden = false;
}
function renderBookLine() {
  const el = $('#book-line');
  if (!BOOK || !isToday()) { el.hidden = true; return; }
  const live = [...S.games.values()].filter((g) => { if (g.state !== 'in') return false; const st = standing(g); return st && st.fresh && st.best && st.best.weight === 3; }).length;
  if (!live) { el.hidden = true; return; }
  bookLink(el, `${live === 1 ? 'One signal is' : `${live} signals are`} live right now. `, `Open ${BOOK.name}`);
}
function renderBookLink(g, st) {
  const el = $('#book-link');
  if (!BOOK || !g || g.state !== 'in' || !st || !st.fresh) { el.hidden = true; return; }
  bookLink(el, '', `Open this game at ${BOOK.name}`);
}

/** The game's Coinbase ladder: five strikes around the fair number, each side's price against the model's chance. */
function renderCoinbase(g, st) {
  const block = $('#cb-block');
  if (!CB.on || !g || g.state !== 'in') { block.hidden = true; return; }
  block.hidden = false;
  const q = cbQuote(g, st), note = $('#cb-note'), body = $('#cb-rows');
  $('#cb-alerts').textContent = CB.alerts ? 'Alerts on in this browser' : 'Alert me in this browser';
  $('#cb-alerts').setAttribute('aria-pressed', String(CB.alerts));
  if (CB.error) { note.textContent = `Could not read Coinbase prices (${CB.error}).`; body.replaceChildren(); return; }
  if (!CB.at) { note.textContent = 'Loading Coinbase prices.'; body.replaceChildren(); return; }
  if (!q) { note.textContent = st && st.fresh ? 'No Coinbase total found for this game.' : 'Coinbase prices show while the sportsbook line is fresh.'; body.replaceChildren(); return; }
  const fair = st.markets.total.fair;
  const rows = q.priced.slice().sort((a, b) => Math.abs(a.line - fair) - Math.abs(b.line - fair)).slice(0, 5).sort((a, b) => a.line - b.line);
  const cell = (side) => {
    const td = h('td');
    if (!side) { td.textContent = '–'; return td; }
    td.append(h('span', '', fmtC.cents(side.price)), h('span', `cb-edge ${side.edge >= (CB.cfg.margin || 0.05) ? 'is-on' : side.edge < 0 ? 'quiet' : ''}`, ` ${fmtC.signedCents(side.edge)}`));
    return td;
  };
  body.replaceChildren(...rows.map((r) => {
    const tr = h('tr'); tr.append(h('th', '', r.line.toFixed(1)), cell(r.over), h('td', 'quiet', `${Math.round(r.pOver * 100)}%`), cell(r.under));
    return tr;
  }));
  const e = q.entry, ago = Math.round((Date.now() - CB.at) / 1000);
  note.textContent = e ? `Entry: ${quoteWords(e.side, e)}.` : `No entry on Coinbase right now. Prices ${ago}s old; fees estimated.`;
  note.className = e ? `cb-note ${e.side === 'Over' ? 'is-over' : 'is-under'}` : 'cb-note';
}

/** Entries across the slate: one browser notification per game and side, while this page is open. */
function cbAlert() {
  if (!CB.on || !isToday()) return;
  const live = [];
  for (const g of S.games.values()) {
    if (g.state !== 'in') continue;
    const q = cbQuote(g, standing(g));
    if (q && q.entry) live.push({ g, e: q.entry });
  }
  const line = $('#cb-line');
  line.hidden = !live.length;
  if (live.length) line.textContent = `Coinbase ${live.length === 1 ? 'entry' : 'entries'} now: ${live.map(({ g, e }) => `${g.away.name} at ${g.home.name}, ${e.side.toLowerCase()} ${e.line.toFixed(1)} at ${fmtC.cents(e.price)}`).join('; ')}.`;
  for (const { g, e } of live) {
    const key = `${S.date}:${g.id}:${e.side}`;
    if (CB.fired.has(key)) continue;
    CB.fired.add(key);
    try { sessionStorage.setItem('csl.fired', JSON.stringify([...CB.fired])); } catch { /* fires again after a reload */ }
    if (CB.alerts && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      const n = new Notification(`${g.away.name} at ${g.home.name}: ${e.side.toLowerCase()} ${e.line.toFixed(1)}`, { body: `${quoteWords(e.side, e)}. ${clockLabel(g.minute)}, ${g.away.pts}-${g.home.pts}.`, tag: key });
      n.onclick = () => { window.focus(); go(gameHash(g.id, 'total')); };
    }
  }
}
async function toggleAlerts() {
  if (!CB.alerts && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
    const p = await Notification.requestPermission().catch(() => 'denied');
    if (p !== 'granted') { $('#cb-note').textContent = 'This browser did not allow notifications, so alerts stay off.'; return; }
  }
  CB.alerts = !CB.alerts;
  try { localStorage.setItem('csl.alerts', CB.alerts ? '1' : '0'); } catch { /* not remembered */ }
  renderGame();
}

function setupSite() {
  document.title = SITE.name;
  $('#wordmark').textContent = SITE.name;
  $('#tagline').textContent = SITE.tagline;
  const links = $('#foot-links'), source = safeLink(SITE.source);
  if (source) { const a = h('a', '', 'Source, model and recorded data'); a.href = source; links.append(a); }
  if (SUPPORT) { const a = h('a', '', SITE.support.label || 'Support the site'); a.href = SUPPORT; a.target = '_blank'; a.rel = 'noopener'; links.append(a); }
  if (LIST) {
    $('#signup-form').action = LIST;
    $('#signup-email').name = SITE.newsletter.field || 'email';
    $('#signup-pitch').textContent = SITE.newsletter.pitch;
    $('#signup').hidden = false;
  }
  if (/^[a-f0-9]{16,64}$/i.test(SITE.analytics)) { // Cloudflare Web Analytics: counts visits, sets no cookie
    const s = document.createElement('script');
    s.defer = true; s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
    s.setAttribute('data-cf-beacon', JSON.stringify({ token: SITE.analytics }));
    document.head.append(s);
  }
}

function renderAbout() {
  const host = $('#about');
  if (host.childElementCount) return;
  const y = S.model ? S.model.yardstick : null, dev = y ? f1(y.total) : '1.2';
  const p = (...parts) => { const e = h('p'); e.append(...parts.map((x) => (typeof x === 'string' ? document.createTextNode(x) : x))); return e; };
  const link = (text, href, out) => { const a = h('a', '', text); a.href = href; if (out) { a.target = '_blank'; a.rel = 'noopener'; } return a; };
  const row = (title, ...paras) => { const r = h('div', 'about-row'), body = h('div'); body.append(...paras); r.append(h('h2', '', title), body); return r; };
  const counted = /^[a-f0-9]{16,64}$/i.test(SITE.analytics), mail = safeMail(SITE.contact);
  const rows = h('div', 'about-rows');
  rows.append(
    row('The fair number',
      p('Fair is the current score plus an estimate of the points still to come. The estimate was fitted on 16,086 Division I games from 2022–23 through December 2025, with a separate fit for every minute of the game. It uses the pregame total and spread, the score and the time left.'),
      p('It knows nothing about injuries, foul trouble or who is on the floor.')),
    row('What counts as a signal',
      p(`One reading is mostly timing: a basket moves fair before the sportsbook reprices. So the gap is averaged over three minutes and measured in deviations, the usual size of that average on earlier slates, about ${dev} points for a game total.`),
      p(`A signal is the first time the average sits ${RULES.buyDev} or more deviations out between minute ${RULES.firstMinute} and minute ${RULES.lastMinute}, at a price the model’s chance beats by ${Math.round(RULES.margin * 100)} points. Signals are off when the pregame spread is ${RULES.blowoutSpread} or more or the lead is ${RULES.blowoutLead} or more, because the fair number runs high in those games.`)),
    row('The record',
      p('Every signal is logged when it fires and settled on the final score, wins and losses alike. Nothing is taken out afterwards. Game totals are settled at the sportsbook’s live price. Team totals are implied from the live total and spread and priced at an estimated −115.'),
      p('The record is short. It starts on November 18, 2026, and a few weeks of results prove very little. ', link('See the record', '#/record'), '.')),
    row('What this is not',
      p('It is not betting advice, and it does not predict that any bet will win. The sportsbook line is one book’s number as ESPN publishes it, and yours may show something else. The feeds behind the site are public and can lag, change or stop.')),
    row('Keep it a game',
      p('Betting is for adults of legal age where they live. Decide what you can afford to lose before the games start, and stop when you reach it.'),
      p('If it has stopped being fun, call or text 1-800-GAMBLER at any hour, or visit the ', link('National Council on Problem Gambling', 'https://www.ncpgambling.org/', true), '.')),
    row('Privacy',
      p(`There are no accounts and no advertising trackers. Your browser keeps its own copy of the lines it has seen, on your device, so a reload does not lose them. ${counted ? 'Visits are counted without cookies and without anything that identifies you.' : 'Visits are not counted.'}`),
      p(`Scores, lines and the record are fetched straight from ESPN and GitHub, which see your connection the way any site you visit does.${LIST ? ' If you join the email list, your address is held by the mailing service and used for that list only.' : ''}`)),
    row('How the site is paid for',
      p(BOOK ? `Links to ${BOOK.name} are paid referrals: the site receives a flat fee when a new customer opens an account through one. It is never paid a share of anyone’s losses, and no sportsbook sees or shapes the model, the signals or the record.` : 'The site carries no advertising and no paid links.'),
      ...(SUPPORT ? [p('Readers who find it useful can chip in through the support link at the foot of the page. It buys nothing extra: everything here stays open to everyone.')] : [])),
  );
  if (mail) rows.append(row('Contact', p('Questions and corrections: ', link(mail, `mailto:${mail}`), '.')));
  host.append(
    h('h1', 'headline', 'A second number for every live total.'),
    h('p', 'standfirst', 'During a game the sportsbook posts a total and keeps moving it. This site works out its own from the score and the clock, sets the two side by side, and logs a signal when they sit far apart for long enough. Then it keeps score on itself.'),
    rows,
  );
}

/* ---------- wide tables on a phone: keep the columns that answer "what, at what line, how did it end", fold the rest into a second line ---------- */
function forPhone(tr, keep, sub) {
  [...tr.children].forEach((cell, i) => { if (!keep.includes(i)) cell.classList.add('m-hide'); });
  tr.children[keep[0]].classList.add('m-first');
  tr.children[keep[0]].append(h('span', 'm-sub', sub));
}
for (const [id, keep] of [['ledger-rows', [1, 6, 11, 12]], ['sig-rows', [0, 4, 8, 9]], ['shadow-rows', [0, 4, 8, 9]]]) {
  const table = document.getElementById(id).closest('table');
  table.classList.add('is-phone');
  [...table.querySelectorAll('thead th')].forEach((th, i) => { if (!keep.includes(i)) th.classList.add('m-hide'); else if (i === keep[0]) th.classList.add('m-first'); });
}
// A first visit gets three lines on how to read the site. Dismissed once, it stays away on this device.
const seenPrimer = () => { try { return localStorage.getItem('csl.primer') === '1'; } catch { return false; } };
$('#primer').hidden = seenPrimer();
$('#primer-ok').addEventListener('click', () => { $('#primer').hidden = true; try { localStorage.setItem('csl.primer', '1'); } catch { /* private mode: it will show again next visit */ } });
$('#more-games').addEventListener('click', () => { S.allDone = true; render(); });
$('#feed-more').addEventListener('click', () => { S.allFeed = true; render(); });
$('#ledger-more').addEventListener('click', () => { S.allLedger = true; render(); });
for (const [id, k] of [['led-result', 'result'], ['led-market', 'market']]) for (const b of document.querySelectorAll(`#${id} button`)) b.addEventListener('click', () => { S.led[k] = b.dataset.v; S.allLedger = false; renderRecord(); });

/* ---------- sharing: the phone's share sheet where there is one, the clipboard where there is not ---------- */
function shareWords(kind) {
  const g = kind === 'game' ? S.games.get(S.sel) : null;
  if (g) return `${g.away.name} at ${g.home.name}: the sportsbook’s live total against a fair number.`;
  if (kind === 'record') return 'Every signal logged and settled, wins and losses alike.';
  return 'Every live college basketball total, measured against a fair number.';
}
for (const b of document.querySelectorAll('[data-share]')) {
  b.addEventListener('click', async () => {
    const data = { title: SITE.name, text: shareWords(b.dataset.share), url: location.href }, label = b.textContent;
    try {
      if (navigator.share) { await navigator.share(data); return; }
      await navigator.clipboard.writeText(data.url);
      b.textContent = 'Link copied';
      setTimeout(() => { b.textContent = label; }, 1800);
    } catch { /* the share sheet was closed, or the clipboard is not available */ }
  });
}

/* ---------- loop ---------- */
function renderPulse() {
  const p = $('#pulse'), live = [...S.games.values()].filter((g) => g.state === 'in').length;
  p.classList.toggle('is-down', !!S.error);
  if (S.error) { p.replaceChildren(h('b', '', 'ESPN is not responding'), document.createTextNode(` (${S.error}). Retrying.`)); return; }
  if (!S.scoresAt) { p.textContent = 'Loading'; return; }
  const age = Math.max(0, Math.round((Date.now() - S.scoresAt) / 1000));
  // The recorder only runs while games are on, so its age means something only then. Late, with games live, it is a warning.
  const mins = S.recordedAt ? Math.max(0, Math.round((Date.now() / 1000 - S.recordedAt) / 60)) : null;
  const rec = mins == null || !isToday() || !live ? '' : mins > 12 ? `, recorder last saved ${mins} min ago` : `, recorder ${mins} min ago`;
  p.replaceChildren(h('b', '', isToday() ? `${live} live` : dayLabel(S.date)), document.createTextNode(`, scores ${age}s ago`), h('span', 'wide', rec));
}
/** The browser tab carries the number of open signals, so a tab left in the background still says when one fires. */
function renderTitle() {
  const open = isToday() ? [...S.games.values()].filter((g) => g.state === 'in').reduce((n, g) => n + signalsOf(g).filter((s) => s.result === 'Pending').length, 0) : 0;
  const title = open ? `(${open}) ${SITE.name}` : SITE.name;
  if (document.title !== title) document.title = title;
}
function render() { S.memo.clear(); renderPulse(); if (S.view === 'board') renderBoard(); if (S.view === 'game') renderGame(); if (S.view === 'record') renderRecord(); if (S.view === 'about') renderAbout(); cbAlert(); renderTitle(); }

async function refresh(force) {
  if (S.busy && !force) return;
  S.busy = true;
  try {
    // The recorder's files do not depend on ESPN, so the record still loads when the scoreboard does not.
    let failed = null;
    try {
      await loadBoard();
      if (isToday()) await inBatches([...S.games.values()].filter((g) => g.state === 'in'), 6, loadOdds);
      await loadCoinbase();
    } catch (err) { failed = err; }
    if (force || S.polls % RECORDED_EVERY === 0) await loadRecorded();
    if (failed) throw failed;
    const sel = S.games.get(S.sel);
    if (sel && S.view === 'game' && sel.state === 'in' && Date.now() - sel.timelineAt > 90000) await loadTimeline(sel).catch(() => {});
    S.polls += 1;
    if (S.polls % 3 === 0) store.save();
  } catch (err) { S.error = err.message || 'error'; }
  S.busy = false;
  render();
}

/* ---------- wiring ---------- */
for (const b of document.querySelectorAll('.nav button')) b.addEventListener('click', () => go(b.dataset.view === 'board' ? boardHash(S.date) : b.dataset.view === 'record' ? '#/record' : b.dataset.view === 'about' ? '#/about' : S.sel ? gameHash(S.sel) : '#/game'));
for (const b of document.querySelectorAll('#markets button')) b.addEventListener('click', () => go(gameHash(S.sel, b.dataset.market)));
$('#prev').addEventListener('click', () => go(boardHash(shiftDay(S.date, -1))));
$('#next-day').addEventListener('click', () => go(boardHash(shiftDay(S.date, 1))));
$('#today').addEventListener('click', () => go(boardHash(today())));
$('#only').addEventListener('click', () => { S.only = !S.only; renderBoard(); });
for (const b of document.querySelectorAll('#mode button')) b.addEventListener('click', () => { S.mode = b.dataset.mode; try { localStorage.setItem('csl.mode', S.mode); } catch { /* the choice just will not persist */ } S.memo.clear(); renderBoard(); });
$('#cb-alerts').addEventListener('click', toggleAlerts);
window.addEventListener('hashchange', applyRoute);
let resizeTimer = 0;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.view === 'game') renderGame(); if (S.view === 'board') renderBoard(); if (S.view === 'record') renderRecord(); }, 120); });
document.addEventListener('visibilitychange', () => { if (document.hidden) store.save(); else refresh(); });
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (S.view === 'board') {
    const rows = standGames();
    if (e.key === 'j' || e.key === 'ArrowDown') { S.cursor = Math.min(rows.length - 1, S.cursor + 1); renderBoard(); e.preventDefault(); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { S.cursor = Math.max(0, S.cursor - 1); renderBoard(); e.preventDefault(); }
    else if (e.key === 'Enter' && rows[S.cursor] && e.target === document.body) go(gameHash(rows[S.cursor].id, 'total', S.date));
    else if (e.key === '[') go(boardHash(shiftDay(S.date, -1)));
    else if (e.key === ']') go(boardHash(shiftDay(S.date, 1)));
    else if (e.key === 't') go(boardHash(today()));
    else if (e.key === 's') { S.only = !S.only; renderBoard(); }
  } else if (S.view === 'game') {
    const mk = { 1: 'total', 2: 'away', 3: 'home' }[e.key];
    if (mk && S.sel) go(gameHash(S.sel, mk));
    else if (e.key === 'Escape' || e.key === 'b') go(boardHash(S.date));
  }
});

(async () => {
  try { S.model = createModel(await getJSON('model.json?v=21')); } catch { $('#pulse').textContent = 'Could not load the model file.'; return; }
  window.cslBooted = true;
  setupSite();
  await applyRoute();
  setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
  setInterval(renderPulse, 5000);
})();
