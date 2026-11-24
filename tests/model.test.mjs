// node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createModel, elapsed, clockLabel, isClockGlitch, gapStats, breakEven, signalNow, lastedSec, RULES, RULE_HISTORY } from '../js/model.js';

const root = new URL('..', import.meta.url);
const model = createModel(JSON.parse(readFileSync(new URL('model.json', root))));
const parity = JSON.parse(readFileSync(new URL('tests/fixtures/parity.json', root)));
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: ${a} vs ${b}`);

test('matches the Python recorder on every fixture case', () => {
  for (const c of parity.cases) {
    const j = model.judge(c.pre, c.t, c.away, c.home, c.book_total, c.book_spread);
    close(j.fair.away, c.fair_away, 'fair away');
    close(j.fair.home, c.fair_home, 'fair home');
    close(j.fair.awayShort, c.away_short, 'away shortfall');
    close(j.fair.homeShort, c.home_short, 'home shortfall');
    close(j.markets.total.dev, c.dev_total, 'deviations, total');
    close(j.markets.away.dev, c.dev_away, 'deviations, away');
    close(j.markets.home.dev, c.dev_home, 'deviations, home');
    close(j.markets.total.over, c.over_total, 'over chance, total');
    close(j.markets.away.over, c.over_away, 'over chance, away');
    close(j.markets.home.over, c.over_home, 'over chance, home');
  }
});

test('break-even rates match the recorder', () => {
  for (const p of parity.prices) close(breakEven(p.price), p.break_even, `price ${p.price}`);
  close(breakEven(-110), 110 / 210, 'a -110 price needs 52.4%');
});

test('reads ESPN clocks', () => {
  for (const c of parity.clocks) close(elapsed(c.period, c.clock), c.minute, `${c.period} ${c.clock}`);
  assert.equal(clockLabel(12.5), '1H 7:30');
  assert.equal(clockLabel(27.77), '2H 12:14');
});

test('the fair number lands on the score at the final whistle', () => {
  const f = model.fair([149.5, -3.5], 40, 71, 78);
  assert.equal(f.away, 71);
  assert.equal(f.home, 78);
});

test('a team behind its pace is expected to finish under its pregame total, not catch up', () => {
  const pre = [150, 0];
  const cold = model.fair(pre, 20, 22, 35);
  assert.ok(cold.awayShort > 10);
  assert.ok(cold.away < 75 - 8, `cold team fair ${cold.away}`);
  assert.ok(cold.away > 22 + (75 - 35.2) * 0.9, 'but it scores at about its normal rate from here');
});

test('drops readings whose game clock outruns the wall clock or runs backwards', () => {
  const at730 = [1000, 12.5], at507 = [1030, 14.88], at701 = [1060, 12.98], next = [1090, 13.0];
  assert.equal(isClockGlitch(null, at730), false);
  assert.equal(isClockGlitch(at730, at507), true, '2.4 game minutes in 30 seconds');
  assert.equal(isClockGlitch(at730, at701), false);
  assert.equal(isClockGlitch(at507, at701), true, 'backwards');
  assert.equal(isClockGlitch(at701, next), false);
});

// A game where the book sits `gaps[i]` points under fair at reading i, one reading a minute from minute `start`.
const steady = (gaps, { pre = [150, 0], start = 20, a0 = 30, h0 = 32, price = -110, every = 60 } = {}) => gaps.map((gap, i) => {
  const t = start + (i * every) / 60, a = a0 + i, h = h0 + i;
  return [i * every, t, a, h, model.fair(pre, t, a, h).total - gap, a - h, price, price];
});
// The tests below look at each other part of the rule with the hold switched off; the hold has a test of its own.
const atOnce = (pre, rows, finals, opts = {}) => model.signalsFor(pre, rows, finals, { holdSec: 0, ...opts });
const totals = (rows, finals = null, opts = {}) => atOnce([150, 0], rows, finals, opts).filter((s) => s.market === 'total');
const sigma = model.yardstick.total;

test('the signal is judged on a three-minute rolling average, not on one reading', () => {
  const rows = model.track([150, 0], steady([0, 0, 0, 6, 0, 0, 0]));
  assert.equal(rows[1].markets.total.avgEdge, null, 'no average until the line has been followed for most of three minutes');
  close(rows[3].markets.total.avgEdge, 6 / 4, 'the readings of the last 180 seconds, each counted once');
  close(rows[3].markets.total.avgDev, 6 / 4 / sigma, 'in deviations');
  close(rows[6].markets.total.avgEdge, 6 / 5, 'plus the reading just before the window, carried forward');
  assert.deepEqual(totals(steady([0, 0, 0, 6, 0, 0, 0])), [], 'one six-point reading is not a signal');
  assert.equal(totals(steady([0, 3, 3, 3, 3, 3])).length, 1, 'three points that stay are');
});

test('a signal fires once, at 2 deviations of the average, and settles on the final', () => {
  const rows = steady([0, 3, 3, 3, 3, 3, 3]);
  const open = totals(rows);
  assert.equal(open.length, 1);
  assert.equal(open[0].side, 'Over');
  assert.ok(Math.abs(open[0].dev) >= RULES.buyDev && open[0].dev < 2.5, `fired at ${open[0].dev.toFixed(2)} deviations`);
  assert.equal(open[0].result, 'Pending');
  assert.equal(open[0].priced, 'DraftKings');
  const line = open[0].line;
  assert.equal(totals(rows, { away: Math.ceil(line / 2) + 1, home: Math.ceil(line / 2) + 1 })[0].result, 'Won');
  assert.equal(totals(rows, { away: Math.floor(line / 2) - 2, home: Math.floor(line / 2) - 2 })[0].result, 'Lost');
  assert.equal(totals(steady([0, -3, -3, -3, -3, -3]))[0].side, 'Under');
});

test('one deviation is a number of points, the same early and late; what it is worth is not', () => {
  const at = (start) => model.track([150, 0], steady([2.6, 2.6, 2.6, 2.6, 2.6], { start, a0: Math.round(start * 1.85), h0: Math.round(start * 1.85) })).at(-1).markets.total;
  const early = at(6), late = at(30);
  close(early.sigma, late.sigma, 'same points per deviation');
  close(early.avgDev, late.avgDev, 'so the same gap is the same number of deviations');
  assert.ok(late.chance > early.chance + 0.03, `but it is worth more with less game left: ${early.chance.toFixed(3)} then ${late.chance.toFixed(3)}`);
});

test('a steep price cancels a signal; other thresholds, windows and yardsticks can be asked for', () => {
  const rows = (price) => steady([2.7, 2.7, 2.7, 2.7, 2.7], { price });
  assert.equal(totals(rows(-110)).length, 1);
  assert.equal(totals(rows(-180)).length, 0, '-180 needs 64.3% plus the margin');
  assert.equal(model.track([150, 0], rows(-180)).at(-1).markets.total.signal, 'lean', 'it stays on watch');
  assert.equal(totals(rows(-110), null, { buyDev: 3 }).length, 0);
  assert.equal(totals(rows(-110), null, { yard: { total: 2, team: 2 } }).length, 0, 'a wider yardstick makes the same gap ordinary');
  assert.deepEqual(totals(steady([0, 0, 0, 6, 0]), null, { windowSec: 0 }).map((s) => s.minute), [23], 'the single-reading comparison rule');
  assert.deepEqual(totals(steady([0, 0, 2.5, 6, 0]), null, { windowSec: 0, armDev: 1.5 }).map((s) => s.minute), [23], 'single reading, after 1.5 the reading before');
  assert.deepEqual(totals(steady([0, 0, 0, 6, 0]), null, { windowSec: 0, armDev: 1.5 }), []);
});

test('no signals in blowouts, on huge spreads, or outside the window', () => {
  const held = [4, 4, 4, 4, 4, 4];
  const count = (opts, pre = [150, 0]) => atOnce(pre, steady(held, { ...opts, pre }), null).filter((s) => s.market === 'total').length;
  assert.equal(count({}), 1);
  assert.equal(count({ h0: 30 + RULES.blowoutLead }), 0);
  assert.equal(count({}, [150, -RULES.blowoutSpread]), 0);
  assert.equal(count({ start: RULES.lastMinute + 0.5, every: 20 }), 0, 'after the last minute');
  const early = atOnce([150, 0], steady(held, { start: 0, a0: 0, h0: 0, every: 30 }), null);
  assert.ok(early.every((s) => s.minute >= RULES.firstMinute), 'nothing before the first minute');
});

test('the quote on screen must still carry the edge', () => {
  assert.equal(totals(steady([5, 5, 5, 0.2])).length, 0, 'the average is far out, but the book has just closed the gap: nothing to buy');
  const s = totals(steady([5, 5, 5, 0.2, 5]));
  assert.equal(s.length, 1, 'it fires on the next reading that still offers the gap');
  assert.equal(s[0].minute, 24);
  const row = model.track([150, 0], steady([5, 5, 5, 0.2, 5]))[4].markets.total;
  close(s[0].chance, row.over, 'and the chance logged is the chance on that quote');
  assert.ok(row.avgEdge < row.edge, 'the average and the gap on the quote are different numbers');
});

test('one fresh reading and a stale one are not an average', () => {
  const early = steady([5, 5, 5, 5]), late = steady(new Array(12).fill(5)).slice(10); // 0 to 180 seconds, then nothing for ten minutes
  const rows = model.track([150, 0], [...early, ...late]);
  assert.notEqual(rows[3].markets.total.avgEdge, null, 'four readings across three minutes are an average');
  assert.equal(rows[4].markets.total.avgEdge, null, 'one reading after a long hole is not, even with the last one carried forward');
  assert.equal(rows[5].markets.total.avgEdge, null, 'nor are two');
  assert.deepEqual(model.track([150, 0], steady(new Array(7).fill(5), { every: 30 })).map((r) => r.ready), [false, false, false, false, false, true, true], 'two and a half minutes of readings are needed');
});

test('signals fire on the game total alone', () => {
  const rows = steady([5, 5, 5, 5, 5]);
  assert.deepEqual([...new Set(atOnce([150, 0], rows, null).map((s) => s.market))], ['total']);
  assert.ok(atOnce([150, 0], rows, null, { markets: ['away', 'home'] }).every((s) => s.market !== 'total'), 'team totals only when asked for');
});

test('signals stop at minute 34', () => {
  assert.equal(RULES.lastMinute, 34);
  assert.equal(totals(steady([5, 5, 5, 5, 5], { start: 34.2, every: 30 })).length, 0);
  assert.equal(totals(steady([5, 5, 5, 5, 5], { start: 30 })).length, 1);
});

test('the rule history ends with the rule in force and matches the recorder', () => {
  const py = readFileSync(new URL('../recorder/record.py', import.meta.url), 'utf8');
  const version = /RULES_VERSION = '([^']+)'/.exec(py)[1];
  assert.equal(RULE_HISTORY[RULE_HISTORY.length - 1].version, version);
  assert.equal(RULE_HISTORY[0].since, RULES.liveSince, 'the record begins with the first rule scored live');
  for (const h of RULE_HISTORY) assert.ok(py.includes(`('${h.since}', '${h.version}', '${h.change}')`), `the recorder carries ${h.version} in the same words`);
  assert.equal(Number(/T1, BLOW_LEAD, BLOW_SPREAD = [^\n]*?, (\d+), \d+, \d+\n/.exec(py)[1]), RULES.lastMinute, 'and stops at the same minute');
});

test('how long an open signal stayed bettable', () => {
  const s = totals(steady([5, 5, 5, 5]))[0];
  const rows = (gaps) => model.track([150, 0], steady(gaps));
  assert.equal(lastedSec(s, rows([5, 5, 5, 5, 5, 5])), null, 'still on at every reading since');
  assert.equal(lastedSec(s, rows([5, 5, 5, 5, 5, 0.2, 5])), 120, 'gone at the second reading after it, two minutes on');
  assert.equal(lastedSec(s, rows([5, 5, 5, 5])), null, 'nothing after it yet');
});

test('an open signal is checked against the quote showing now', () => {
  const held = steady([5, 5, 5, 5]), s = totals(held)[0];
  assert.ok(s && s.side === 'Over', 'a signal to check');
  const last = (rows) => { const t = model.track([150, 0], rows); return t[t.length - 1]; };
  const same = signalNow(s, last(held));
  assert.equal(same.state, 'on'); assert.equal(same.price, -110); assert.equal(same.quoted, true);
  const closed = signalNow(s, last(steady([5, 5, 5, 5, 0.2])));
  assert.equal(closed.state, 'gone', 'the book has closed the gap: the bet as logged is no longer there');
  assert.equal(closed.moved, true);
  assert.ok(closed.chance < closed.need);
  const flipped = signalNow({ ...s, side: 'Under' }, last(held));
  assert.equal(flipped.state, 'gone', 'the test is on the side the signal took, not the side the average favours');
  assert.equal(signalNow(s, last(steady([5, 5, 5, 5, 5], { h0: 30 + RULES.blowoutLead }))).state, 'off', 'a big lead: the rule would not fire here');
  assert.equal(signalNow(s, last(steady([5, 5, 5, 5, 5], { h0: 30 + RULES.blowoutLead }))).why, 'lopsided');
  assert.equal(signalNow(s, last(steady([5, 5, 5, 5, 5], { start: 38.2, every: 20 }))).why, 'late');
  assert.equal(signalNow(s, null).state, 'none', 'no fresh line, no read');
  const unpriced = last(held); unpriced.quote = [null, null];
  assert.equal(signalNow(s, unpriced).state, 'none', 'a game total with a line but no price is off the board');
  assert.equal(signalNow({ ...s, market: 'home' }, unpriced).state, 'on', 'a team total never had a quoted price to lose');
  const team = signalNow({ ...s, market: 'home' }, last(held));
  assert.equal(team.quoted, false); assert.equal(team.price, -115, 'team totals have no quoted price');
});

test('lopsided spots are judged apart: off in the record, on in the comparison', () => {
  const held = [4, 4, 4, 4, 4, 4];
  const shadow = (opts, pre = [150, 0]) => atOnce(pre, steady(held, { ...opts, pre }), null, { lopsided: true }).filter((s) => s.market === 'total');
  assert.equal(shadow({}).length, 0, 'a close game never appears in the comparison');
  assert.equal(shadow({ h0: 30 + RULES.blowoutLead }).length, 1, 'a big lead does');
  assert.equal(shadow({}, [150, -RULES.blowoutSpread]).length, 1, 'and so does a wide spread');
  assert.equal(shadow({}, [150, -RULES.blowoutSpread])[0].minute, totals(steady(held))[0].minute, 'it is the same rule, applied where the signal is off');
  const rows = model.track([150, -RULES.blowoutSpread], steady(held, { pre: [150, -RULES.blowoutSpread] }));
  assert.ok(rows.every((r) => r.lopsided && !r.eligible), 'every reading of a wide-spread game is marked');
});

test('a hole in the feed longer than the carry limit starts the average again', () => {
  const rows = steady([3, 3, 3, 3, 3]);
  const later = rows.map((r) => [r[0] + 2000, r[1] + 5, r[2] + 8, r[3] + 8, model.fair([150, 0], r[1] + 5, r[2] + 8, r[3] + 8).total - 3, r[5], r[6], r[7]]);
  const tracked = model.track([150, 0], rows.slice(0, 2).concat(later));
  assert.equal(tracked[2].markets.total.avgEdge, null, 'the first reading after a long hole has no average');
});

test('gap summary: average distance and the share of readings beyond the threshold on each side', () => {
  assert.deepEqual(gapStats([]), { n: 0, abs: null, low: null, high: null, mean: null, sd: null });
  const s = gapStats([0, 1, -1, 2.5, -2.5, -4, 3, -3], 2.5);
  assert.equal(s.n, 8);
  close(s.abs, 17 / 8, 'average distance');
  close(s.low, 25, 'book low: +2.5 and +3');
  close(s.high, 37.5, 'book high: -2.5, -4 and -3');
  close(s.mean, -0.5, 'mean');
  close(s.sd, Math.sqrt(46.5 / 7), 'sample standard deviation');
  assert.equal(gapStats([1.2]).sd, null, 'one reading has no spread');
});

// Readings 30 seconds apart with the book `gap(i)` points under fair; `minute(i)` and `pts(i)` give the feed's clock and score.
const feed = (n, { minute, pts = (i) => 40 + i, gap = () => 4, shift = () => 0 }) => Array.from({ length: n }, (_, i) => {
  const t = minute(i), p = pts(i), a = Math.floor(p / 2), h = p - a;
  return [i * 30, t, a, h, model.fair([150, 0], t, a, h).total - gap(i) + shift(i), a - h, -110, -110];
});
const moving = (i) => 10 + i * 0.4;

test('nothing is judged while the score feed is stalled', () => {
  assert.equal(totals(feed(14, { minute: moving })).length, 1, 'a held gap in running play fires');
  const stands = (i) => (i < 4 ? moving(i) : moving(3)), still = (i) => 40 + Math.min(i, 3); // the clock and the score stop at the fourth reading
  assert.equal(totals(feed(14, { minute: stands, pts: still })).length, 1, 'an ordinary stoppage does not block a signal');
  const late = { minute: stands, pts: still, gap: (i) => (i < 16 ? 0 : 4) }; // the gap opens only after the clock has stood five minutes
  assert.equal(totals(feed(24, late)).length, 0, 'a clock that has stood five minutes is a stalled feed');
  assert.equal(totals(feed(24, late), null, { guard: false }).length, 1, 'which the rule without the guard would have judged');
  assert.equal(totals(feed(14, { minute: stands, pts: (i) => 40 + (i < 4 ? i : 3 + 2 * (i - 3)) })).length, 0, 'points going up while the clock stands');
  assert.equal(totals(feed(14, { minute: stands, pts: still, shift: (i) => (i === 5 ? -4 : 0) })).length, 0, 'the book moving four points while the clock stands');
  assert.equal(totals(feed(14, { minute: () => 12.7, pts: () => 41 })).length, 0, 'a game first seen already standing still');
  const resumes = feed(24, { minute: (i) => (i < 6 ? 12.7 : 12.7 + (i - 5) * 0.4), pts: (i) => 41 + Math.max(0, i - 5) });
  assert.equal(totals(resumes).length, 1, 'once the clock moves the average starts again and a signal can fire');
  assert.ok(totals(resumes)[0].at >= 6 * 30 + 150, 'on readings of its own, two and a half minutes after the feed came back');
  assert.equal(totals(feed(14, { minute: (i) => (i < 2 ? 19.6 + i * 0.4 : 20), pts: (i) => 70 + Math.min(i, 2) })).length, 1, 'halftime is not a stall');
  const rows = model.track([150, 0], feed(14, { minute: () => 12.7, pts: () => 41 }));
  assert.ok(rows.slice(1).every((r) => r.stalled && r.markets.total.avgDev == null), 'a stalled reading carries no average');
  assert.equal(signalNow({ market: 'total', side: 'Over', line: 140 }, rows[5]).why, 'stalled');
});

test('a reading without a line still keeps the clock moving for the readings after it', () => {
  const rows = feed(16, { minute: moving }).map((r, i) => (i < 6 ? [r[0], r[1], r[2], r[3], null, null, null, null] : r));
  assert.equal(totals(rows).length, 1, 'a game followed from before its first live line is not taken as first seen standing');
  assert.equal(totals(rows.slice(6).map((r) => [r[0], 12.4, 21, 22, r[4], r[5], r[6], r[7]])).length, 0, 'the same readings with a clock that never moves are');
});

test('the worst line still worth taking moves with the price and stops where the chance no longer clears it', () => {
  const row = model.track([150, 0], steady([4, 4, 4, 4, 4]))[4], m = row.markets.total;
  const over = model.goodTo(m, 'Over', -110);
  assert.ok(over > m.line && over < m.fair, `good to ${over}, between the line ${m.line} and fair ${m.fair}`);
  assert.ok(Math.abs((((over - m.line) * 2) % 1)) < 1e-9, 'half-point steps from the line showing');
  assert.ok(model.goodTo(m, 'Over', -150) <= over, 'a worse price leaves less room');
  assert.equal(model.goodTo(m, 'Under', -110), null, 'nothing to take on the other side');
  assert.equal(model.goodTo(m, 'Over', null), null);
});

test('a signal waits for its gap to hold two minutes', () => {
  const held = (rows, opts = {}) => model.signalsFor([150, 0], rows, null, opts).filter((s) => s.market === 'total');
  const every30 = { every: 30 };
  // four points under fair from the first reading: the three-minute average exists at the sixth reading (150 s) and is two
  // deviations out from then; the signal is logged two minutes later, at the line showing then
  const rows = steady(Array(14).fill(4), every30);
  assert.deepEqual(atOnce([150, 0], rows, null).map((s) => s.at), [150]);
  assert.deepEqual(held(rows).map((s) => s.at), [270]);
  assert.equal(held(rows)[0].line, rows[9][4], 'the line of the reading it is logged on');
  assert.deepEqual(held(rows, { holdSec: 180 }).map((s) => s.at), [330], 'a longer hold can be asked for');
  // the gap closes before the two minutes are up: nothing is logged
  assert.deepEqual(held(steady([...Array(8).fill(4), ...Array(8).fill(0)], every30)), []);
  // it closes and opens again: the count starts over
  const again = steady([...Array(7).fill(4), ...Array(7).fill(-1), ...Array(12).fill(4)], every30);
  const first = atOnce([150, 0], again, null)[0].at, late = held(again);
  assert.equal(late.length, 1);
  assert.ok(late[0].at >= first + 14 * 30, `logged at ${late[0].at}, after the second run has held`);
  // a hole in the readings starts the count again
  const hole = steady(Array(22).fill(4), every30).map((r, i) => (i >= 8 ? [r[0] + 200, ...r.slice(1)] : r));
  assert.ok(held(hole)[0].at >= hole[8][0] + RULES.holdSec - RULES.holdSlackSec, 'the two minutes are counted from after the hole');
  // a minute apart, as the early slates were recorded: two minutes is the third reading at two deviations
  const minute = steady(Array(8).fill(4));
  assert.deepEqual(held(minute).map((s) => s.at - atOnce([150, 0], minute, null)[0].at), [120]);
});
