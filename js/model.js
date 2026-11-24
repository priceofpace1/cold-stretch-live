// Fair-total model. Pure functions, no DOM: the same file runs in the browser and under `node --test`.
// The Python recorder (recorder/record.py) implements the same arithmetic; tests/fixtures/parity.json keeps the two honest.

export const RULES = Object.freeze({
  // The signal is judged on a rolling three-minute average of fair minus book, not on a single reading: ordinary scoring
  // moves the fair number 2.3 points a minute, so a single reading is mostly timing.
  // One deviation is the standard deviation of that average in points (about 1.2 for a game total), measured on
  // completed slates. It does not shrink late in the game; what a point is worth does, and the chance test covers that.
  buyDev: 2, // deviations the average needs for a signal
  leanDev: 1.5, // the watch tier
  margin: 0.05, // and the chance must beat the price's break-even by this much
  windowSec: 180, // seconds averaged
  carrySec: 60, // the reading just before the window is carried forward if it is no older than this
  // An average exists only when the window itself holds this many readings, reaching back over all but 30 seconds of it.
  // One fresh reading and a stale one carried forward are not a three-minute average.
  minReadings: 3,
  // A signal waits for its gap to hold: the average must stay buyDev deviations out, on one side, at every judged reading
  // for holdSec seconds (less holdSlackSec, since readings are not exactly 30 seconds apart). A hole of runBreakSec in the
  // readings starts the count again.
  holdSec: 120, holdSlackSec: 15, runBreakSec: 150,
  averageFrom: 2, // readings from this minute on feed the average
  // The score feed is taken as stalled, and nothing is judged, when the game clock has stood this long outside halftime,
  // when this many points have gone up or the sportsbook's total has moved this far while it stood, or when a stretch at
  // one game minute began with no reading in the jumpSec seconds and jumpMin game minutes before it.
  stallSec: 300, stallPts: 4, stallLine: 4, jumpSec: 150, jumpMin: 3,
  // The first slate scored live. Signals logged from then on stand as logged, under the rule of their day (see
  // RULE_HISTORY). Earlier slates were recorded before the record began and are scored after the fact.
  liveSince: '20261119',
  markets: Object.freeze(['total']), // a signal fires on the game total alone
  firstMinute: 4, // signals only between these elapsed minutes
  lastMinute: 34,
  blowoutLead: 15, // no signals at or beyond this lead
  blowoutSpread: 20, // or this pregame spread
  staleMs: 100000, // a live line older than this is not acted on
  measureFrom: 4, // the slate summary and the yardstick count readings between these minutes (the recorder uses the same window)
  measureTo: 34,
});

/**
 * Every version of the signal rule, oldest first: the first slate it was scored live on, and what changed.
 * The recorder holds the same list (RULE_STARTS in recorder/record.py); a test keeps the two in step.
 */
export const RULE_HISTORY = Object.freeze([
  { since: '20261119', version: '2026-11-19.2', change: 'A signal must still carry its edge on the quote showing when it fires, not only on the three-minute average.' },
  { since: '20261122', version: '2026-11-22.1', change: 'Signals stop at minute 34, not 38: the model knows nothing of fouling and clock play. An average needs three readings of its own covering two and a half minutes, and the recorder keeps a reading every 30 seconds. Team totals are dropped: their lines were implied from the total and spread, and their price was an estimate.' },
  { since: '20261125', version: '2026-11-25.1', change: 'No signal on a stalled score feed: when the game clock has stood for five minutes, when four points have gone up or the sportsbook total has moved four points while it stood, or when a game is first seen already standing still. Signals logged on such readings before this date are marked and left out of the headline record. A signal now waits for its gap to hold: the three-minute average must stay two deviations out for a further two minutes, and the signal is logged at the line and price showing then. On the slates recorded through November 24, signals that had held two minutes won 22 of 31, and the others were close to break-even.' },
]);

/**
 * Summary of a set of fair-minus-book gaps: how far apart the two numbers ran, and how often the book
 * was at least `threshold` points low (the over side) or high (the under side). Shares are percentages;
 * `sd` is the sample standard deviation of the gap, the yardstick for how unusual a reading is.
 */
export function gapStats(gaps, threshold = RULES.buyDev) {
  const n = gaps.length;
  if (!n) return { n: 0, abs: null, low: null, high: null, mean: null, sd: null };
  let abs = 0, low = 0, high = 0, sum = 0, squares = 0;
  for (const g of gaps) { abs += Math.abs(g); sum += g; squares += g * g; if (g >= threshold) low += 1; else if (g <= -threshold) high += 1; }
  const mean = sum / n;
  return { n, abs: abs / n, low: (100 * low) / n, high: (100 * high) / n, mean, sd: n > 1 ? Math.sqrt(Math.max(0, squares - n * mean * mean) / (n - 1)) : null };
}

/** The win rate an American price needs to break even: -110 needs 52.4%. */
export function breakEven(price) {
  return price < 0 ? -price / (-price + 100) : 100 / (price + 100);
}

/**
 * Where an open signal stands on the quote showing now. `row` is the game's latest tracked reading (the last row of
 * track()), or null when there is no fresh line. The test is the one a new signal has to pass at the price: the chance
 * on this quote must still beat break-even by the margin. The three-minute average is not asked again, because the
 * question is whether the bet as logged can still be made, not whether it would fire a second time.
 * Returns { state, line, price, quoted, chance, need, moved }. state: 'on', 'gone' (the line or the game has moved),
 * 'off' (the rule would not fire here now: `why` is 'late', 'lopsided' or 'stalled'), or 'none' (no fresh line).
 */
export function signalNow(s, row) {
  const m = row ? row.markets[s.market] : null;
  if (!m || m.line == null || m.over == null) return { state: 'none' };
  if (row.stalled) return { state: 'off', why: 'stalled', line: m.line };
  const quoted = s.market === 'total' && row.quote ? row.quote[s.side === 'Over' ? 0 : 1] : null;
  // A game total showing a line but no price is off the board for the moment: nothing can be bet, so nothing is claimed.
  if (s.market === 'total' && quoted == null) return { state: 'none' };
  const price = quoted == null ? -115 : quoted, chance = s.side === 'Over' ? m.over : 1 - m.over, need = breakEven(price) + RULES.margin;
  const base = { line: m.line, price, quoted: quoted != null, chance, need, moved: m.line !== s.line };
  if (!row.eligible) return { ...base, state: 'off', why: row.t > RULES.lastMinute ? 'late' : 'lopsided' };
  return { ...base, state: chance >= need ? 'on' : 'gone' };
}

/**
 * How long an open signal stayed bettable: the seconds from the signal to the first later reading on which it no longer
 * passed (signalNow not 'on'). rows are the game's tracked readings. Null while it has passed on every reading since.
 */
export function lastedSec(s, rows) {
  for (const row of rows) if (row.ts > s.at && signalNow(s, row).state !== 'on') return row.ts - s.at;
  return null;
}

/**
 * The public record in three figures: game totals scored live since `since` (a slate date), from the recorder's ledger.
 * units are at the price quoted when each signal fired; `late` is the same bets graded at the line showing a minute on.
 * Signals logged on a stalled score feed (marked `fault` by the recorder) are left out.
 */
export function recordOf(ledger, since) {
  const rows = (ledger || []).filter((s) => s.date >= since && !s.fault && ((s.mkt || '') === 'total' || s.market === 'Game total'));
  const out = { n: rows.length, won: 0, lost: 0, units: 0, late: { won: 0, lost: 0 }, since };
  for (const s of rows) {
    if (s.result === 'Won') { out.won += 1; out.units += s.price > 0 ? s.price / 100 : 100 / -s.price; }
    else if (s.result === 'Lost') { out.lost += 1; out.units -= 1; }
    const l = s.later && s.later['60'];
    if (l && l[2] != null && s.final != null && s.final !== l[1] && (s.result === 'Won' || s.result === 'Lost' || s.result === 'Push')) out.late[(s.final > l[1]) === (s.side === 'Over') ? 'won' : 'lost'] += 1;
  }
  return out;
}

/**
 * Whether a reading was taken on a score feed that had stopped following the game. Four signs, none of them at halftime:
 * the clock has stood longer than an ordinary stoppage; points have gone up while it stood; the sportsbook's total has
 * moved while it stood, so the book is following a game the feed is not showing; or the stretch began with no reading
 * just before it, so the game was first seen, or seen again after a hole, already standing still. Mirrors the recorder.
 */
export function stalledAt(run, ts, t, pts) {
  if (Math.abs(t - 20) < 1e-6 || t >= 40) return false;
  return ts - run.ts >= RULES.stallSec || pts - run.pts >= RULES.stallPts || (run.lo != null && run.hi - run.lo >= RULES.stallLine) || (!run.seen && ts > run.ts);
}

/** Elapsed game minutes (0-40) from ESPN's period and "MM:SS" clock. Overtime clamps to 40. */
export function elapsed(period, clock) {
  const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(clock || '');
  const left = m ? Number(m[1]) + Number(m[2]) / 60 : (parseFloat(clock) || 0) / 60;
  if (period >= 3) return 40;
  return ((period || 1) - 1) * 20 + (20 - left);
}

/** "2H 12:14" for an elapsed minute. */
export function clockLabel(t) {
  const half = t <= 20 ? 1 : 2;
  const left = Math.max(0, half * 20 - t);
  const sec = Math.round((left % 1) * 60) % 60;
  return `${half}H ${Math.floor(left)}:${String(sec).padStart(2, '0')}`;
}

/**
 * ESPN's clock occasionally jumps (7:30, then 5:07, then 7:01). A game clock cannot run faster than the wall clock,
 * and cannot run backwards, so a reading that does either is dropped.
 * Readings are [unixSeconds, elapsedMinutes, ...].
 */
export function isClockGlitch(prev, next) {
  if (!prev) return false;
  return (next[1] - prev[1]) * 60 > next[0] - prev[0] + 15 || next[1] < prev[1] - 0.05;
}

export function createModel(json) {
  const rows = new Map(json.rows.map((r) => [r.minute, r]));
  const dist = json.cdf;
  const baseYard = json.yardstick; // { total, team }: one deviation of the averaged gap, in points

  function coef(t) {
    const tt = Math.min(38, Math.max(2, t));
    const lo = Math.min(37, Math.floor(tt));
    const w = tt - lo;
    const a = rows.get(lo);
    const b = rows.get(lo + 1);
    const out = {};
    for (const k of Object.keys(a)) out[k] = a[k] + (b[k] - a[k]) * w;
    return out;
  }

  // Rest-of-game points for one team, and how far it is behind its pregame pace.
  function rest(c, teamTotal, oppTotal, pts, oppPts) {
    const expected = teamTotal * c.share;
    const short = expected - pts;
    const oppShort = oppTotal * c.share - oppPts;
    const lead = pts - oppPts;
    const r = c.b0 + c.b_erem * (teamTotal - expected) + c.b_short * short + c.b_oshort * oppShort
      + c.b_lead * Math.max(lead, 0) + c.b_trail * Math.max(-lead, 0)
      + c.b_lead12 * Math.max(lead - 12, 0) + c.b_trail12 * Math.max(-lead - 12, 0);
    return [Math.max(0, r), short];
  }

  /** P(standardised residual <= z), from the empirical distribution. */
  function cdf(z) {
    if (z <= dist[0][0]) return dist[0][1];
    const last = dist[dist.length - 1];
    if (z >= last[0]) return last[1];
    let i = 1;
    while (dist[i][0] < z) i += 1;
    const a = dist[i - 1];
    const b = dist[i];
    return a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0]);
  }

  /**
   * Fair finals at elapsed minute t.
   * pre = [closing total, home spread] (home spread negative when the home team is favoured).
   */
  function fair(pre, t, awayPts, homePts) {
    const homeTotal = pre[0] / 2 - pre[1] / 2;
    const awayTotal = pre[0] / 2 + pre[1] / 2;
    const c = coef(t);
    const fade = t <= 38 ? 1 : Math.max(0, (40 - t) / 2); // the last two minutes run the estimate down to the score
    const [homeRest, homeShort] = rest(c, homeTotal, awayTotal, homePts, awayPts);
    const [awayRest, awayShort] = rest(c, awayTotal, homeTotal, awayPts, homePts);
    const away = awayPts + awayRest * fade;
    const home = homePts + homeRest * fade;
    const pace = (p) => (t >= 4 ? p / c.share : null);
    return {
      away, home, total: away + home,
      awayShort, homeShort,
      paceAway: pace(awayPts), paceHome: pace(homePts), paceTotal: pace(awayPts + homePts),
      sdTeam: c.sd_team, sdTotal: c.sd_total,
      pregame: { total: pre[0], away: awayTotal, home: homeTotal },
    };
  }

  /**
   * One reading against the model. bookTotal and bookSpread are DraftKings' live total and home spread, or null.
   * Returns, per market, the line, the fair number, the edge (fair minus line) in points, `sd` (the model's rest-of-game
   * standard deviation), `sigma` (the points one deviation is worth), `dev` (this reading's edge in deviations) and
   * the chance of the over. Signals are not decided here: they need the rolling average (see track).
   * opts: { yard, lopsided }.
   */
  function judge(pre, t, awayPts, homePts, bookTotal, bookSpread, opts = {}) {
    const yard = opts.yard || baseYard;
    const f = fair(pre, t, awayPts, homePts);
    const hasBook = bookTotal != null && bookSpread != null;
    const lines = hasBook ? { total: bookTotal, away: bookTotal / 2 + bookSpread / 2, home: bookTotal / 2 - bookSpread / 2 } : null;
    // Lopsided: a pregame spread or a lead past the limits. Signals are off there, because across three seasons the fair
    // number ran about a point high in games with a 20-point spread. opts.lopsided judges only those readings instead,
    // which is how the "had signals been on" comparison is kept.
    const inWindow = t >= RULES.firstMinute && t <= RULES.lastMinute;
    const lopsided = Math.abs(awayPts - homePts) >= RULES.blowoutLead || Math.abs(pre[1]) >= RULES.blowoutSpread;
    const eligible = inWindow && (opts.lopsided ? lopsided : !lopsided);
    const markets = {};
    for (const k of ['total', 'away', 'home']) {
      const m = { fair: f[k], line: null, edge: null, dev: null, sd: k === 'total' ? f.sdTotal : f.sdTeam, sigma: k === 'total' ? yard.total : yard.team,
        over: null, side: null, chance: null, price: null, quoted: false, avgEdge: null, avgDev: null, reach: 0, signal: null };
      if (lines) {
        m.line = lines[k];
        m.edge = m.fair - m.line;
        m.dev = m.edge / m.sigma;
        m.over = 1 - cdf((m.line - m.fair) / m.sd);
        m.side = m.edge >= 0 ? 'Over' : 'Under';
        m.chance = m.side === 'Over' ? m.over : 1 - m.over;
      }
      markets[k] = m;
    }
    return { fair: f, markets, eligible, lopsided };
  }

  /**
   * A game's readings, each judged on the rolling average of its gap: the readings of the last `windowSec` seconds plus
   * the one just before them, carried forward. Per market this adds avgEdge (points), avgDev (deviations), the side,
   * chance and price that go with the average, `reach` (avgDev, or 0 when the game is not eligible or the price leaves
   * no room) and the signal: 'buy' at buyDev, 'lean' at leanDev, else null. No average exists until the window holds
   * minReadings readings reaching back over most of it.
   * readings: [[unixSeconds, elapsedMinutes, awayPts, homePts, bookTotal, bookSpread, overPrice, underPrice], ...]
   * opts: { yard, buyDev, windowSec }. windowSec 0 judges single readings.
   */
  function track(pre, readings, opts = {}) {
    const windowSec = opts.windowSec == null ? RULES.windowSec : opts.windowSec;
    const buyDev = opts.buyDev == null ? RULES.buyDev : opts.buyDev;
    const cover = Math.max(0, windowSec - 30);
    const keys = ['total', 'away', 'home'];
    let hist = [];
    const out = [];
    let run = null, prev = null;
    for (const r of readings) {
      // Every reading keeps the clock's history, with a line or without one: `run` is the stretch of readings at one
      // game minute, when it began, the points then, the book's lowest and highest total in it, and whether the clock
      // was seen to tick into it.
      if (!run || Math.abs(r[1] - run.t) > 1e-6) run = { t: r[1], ts: r[0], pts: r[2] + r[3], lo: null, hi: null, seen: !!prev && r[0] - prev[0] <= RULES.jumpSec && r[1] - prev[1] >= -0.5 && r[1] - prev[1] <= RULES.jumpMin };
      prev = r;
      if (r[4] != null) { run.lo = run.lo == null ? r[4] : Math.min(run.lo, r[4]); run.hi = run.hi == null ? r[4] : Math.max(run.hi, r[4]); }
      if (r[4] == null || r[5] == null || r[1] < RULES.averageFrom) continue;
      const j = judge(pre, r[1], r[2], r[3], r[4], r[5], opts);
      // A reading taken while the score feed was not following the game has no average and empties the window, so
      // nothing is judged on it and the average starts again once the feed moves.
      if (opts.guard !== false && stalledAt(run, r[0], r[1], r[2] + r[3])) {
        hist = [];
        out.push({ ts: r[0], t: r[1], away: r[2], home: r[3], ready: false, stalled: true, quote: [r[6] == null ? null : r[6], r[7] == null ? null : r[7]], ...j });
        continue;
      }
      hist.push({ ts: r[0], e: keys.map((k) => j.markets[k].edge) });
      const first = hist.findIndex((x) => r[0] - x.ts <= windowSec);
      const carried = windowSec > 0 && first > 0 && r[0] - windowSec - hist[first - 1].ts <= RULES.carrySec;
      const use = hist.slice(carried ? first - 1 : first);
      const ready = windowSec === 0 || (hist.length - first >= RULES.minReadings && r[0] - hist[first].ts >= cover);
      hist = hist.slice(Math.max(0, first - 1));
      keys.forEach((k, i) => {
        const m = j.markets[k];
        if (!ready) return;
        m.avgEdge = use.reduce((sum, x) => sum + x.e[i], 0) / use.length;
        m.avgDev = m.avgEdge / m.sigma;
        // The average decides whether there is a signal and on which side. The chance stays the one judge() worked out
        // on this reading's own gap, because the line and price shown are the ones on screen now.
        m.side = m.avgEdge >= 0 ? 'Over' : 'Under';
        m.chance = m.side === 'Over' ? m.over : 1 - m.over;
        const quoted = k === 'total' ? (m.side === 'Over' ? r[6] : r[7]) : null;
        m.price = quoted == null ? -115 : quoted;
        m.quoted = quoted != null;
        const size = Math.abs(m.avgDev);
        m.reach = j.eligible && size > 0 && m.chance >= breakEven(m.price) + RULES.margin ? size : 0;
        if (m.reach >= buyDev) m.signal = 'buy';
        else if (j.eligible && size >= RULES.leanDev) m.signal = 'lean';
      });
      out.push({ ts: r[0], t: r[1], away: r[2], home: r[3], ready, stalled: false, quote: [r[6] == null ? null : r[6], r[7] == null ? null : r[7]], ...j });
    }
    return out;
  }

  /**
   * Signals in a game's readings: the first reading per market and side whose rolling average is buyDev deviations out.
   * finals: {away, home} once the game is over, else null.
   * opts: { yard, buyDev, windowSec, armDev, lopsided, markets }. armDev, when given, also requires the reading before it to
   * have been that far out on the same side (only used by the single-reading comparison rules). markets: where a signal
   * may fire. The rule is the game total alone, the one market with a posted line and price.
   */
  function signalsFor(pre, readings, finals, opts = {}) {
    const fired = new Set();
    const out = [];
    const armDev = opts.armDev == null ? null : opts.armDev;
    const keys = opts.markets || RULES.markets;
    const buyDev = opts.buyDev == null ? RULES.buyDev : opts.buyDev, holdSec = opts.holdSec == null ? RULES.holdSec : opts.holdSec;
    let prev = {}, since = {}, lastTs = null;
    for (const row of track(pre, readings, opts)) {
      const cur = {};
      // The hold is counted over judged readings only: one with no average, on a stalled feed or outside the window
      // starts it again, and so does a hole in the readings.
      if (!row.ready || row.stalled || !row.eligible) { since = {}; lastTs = null; } else { if (lastTs != null && row.ts - lastTs > RULES.runBreakSec) since = {}; lastTs = row.ts; }
      for (const k of keys) {
        const m = row.markets[k];
        if (lastTs != null && m.avgDev != null && Math.abs(m.avgDev) >= buyDev) { if (!since[k] || since[k].side !== m.side) since[k] = { side: m.side, ts: row.ts }; } else delete since[k];
        if (!m.reach) continue;
        cur[k] = { side: m.side, reach: m.reach };
        const key = k + m.side;
        const armed = armDev == null || (prev[k] && prev[k].side === m.side && prev[k].reach >= armDev);
        const held = holdSec <= 0 || (since[k] && row.ts - since[k].ts >= holdSec - RULES.holdSlackSec);
        if (m.signal !== 'buy' || !held || !armed || fired.has(key)) continue;
        fired.add(key);
        const final = finals ? (k === 'total' ? finals.away + finals.home : finals[k]) : null;
        out.push({
          market: k, side: m.side, at: row.ts, minute: row.t, score: `${row.away}-${row.home}`,
          line: m.line, fair: m.fair, edge: m.avgEdge, dev: m.avgDev, sigma: m.sigma, chance: m.chance,
          price: m.price, priced: m.quoted ? 'DraftKings' : 'assumed',
          final,
          result: final == null ? 'Pending' : final === m.line ? 'Push' : (final > m.line) === (m.side === 'Over') ? 'Won' : 'Lost',
        });
      }
      prev = cur;
    }
    return out;
  }

  /**
   * The worst line still worth taking on one side at a price: the furthest half-point from the line showing at which the
   * chance still beats the price's break-even by the margin. m is a market of a tracked reading. Null when the line
   * showing does not pass, so there is nothing to take.
   */
  function goodTo(m, side, price) {
    if (!m || m.line == null || m.fair == null || !m.sd || price == null) return null;
    const need = breakEven(price) + RULES.margin, step = side === 'Over' ? 0.5 : -0.5;
    const chance = (line) => { const over = 1 - cdf((line - m.fair) / m.sd); return side === 'Over' ? over : 1 - over; };
    if (chance(m.line) < need) return null;
    let line = m.line;
    for (let i = 0; i < 12 && chance(line + step) >= need; i += 1) line += step;
    return line;
  }

  return { coef, cdf, fair, judge, track, signalsFor, goodTo, yardstick: baseYard, share: (t) => (t <= 0 ? 0 : t >= 40 ? 1 : coef(t).share) };
}
