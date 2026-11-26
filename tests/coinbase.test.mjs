// Coinbase prices: Kalshi's ladders parsed, matched to scoreboard games, and priced against the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTotals, eventDate, matchGame, nameScore, feeOf, priceLadder, bestOn, nearest, entryOf, quoteWords, totalsUrl } from '../js/coinbase.js';
import { createModel } from '../js/model.js';
import { coinbaseOn, SITE } from '../js/site.js';

// Shaped like Kalshi's /markets and /events answers (field names from its public API reference). Prices are examples.
const mk = (ev, line, yb, ya, nb, na) => ({ ticker: `${ev}-${Math.ceil(line)}`, event_ticker: ev, floor_strike: line, strike_type: 'greater',
  yes_bid_dollars: yb, yes_ask_dollars: ya, no_bid_dollars: nb, no_ask_dollars: na, last_price_dollars: ya, volume_fp: '12.00' });
const EV = 'KXNCAAMBTOTAL-26NOV21MSUTENN';
const markets = { markets: [
  mk(EV, 141.5, '0.6800', '0.7000', '0.3000', '0.3200'),
  mk(EV, 144.5, '0.5500', '0.5700', '0.4300', '0.4500'),
  mk(EV, 147.5, '0.4000', '0.4300', '0.5700', '0.6000'),
  mk('KXNCAAMBTOTAL-26NOV21UALRUNF', 150.5, '0.5000', '0.5200', '0.4800', '0.5000'),
  { ticker: 'odd', event_ticker: EV, floor_strike: null },
] };
const events = { events: [
  { event_ticker: EV, title: 'Michigan St. vs Tennessee: Point Total' },
  { event_ticker: 'KXNCAAMBTOTAL-26NOV21UALRUNF', title: 'Little Rock vs North Florida: Point Total', sub_title: 'UALR vs UNF (Nov 21)' },
] };

test('a ticker carries its slate date', () => {
  assert.equal(eventDate(EV), '20261121');
  assert.equal(eventDate('nothing'), null);
});

test('ladders are grouped by game, named from the event, sorted by line', () => {
  const l = parseTotals(markets, events);
  assert.equal(l.size, 2);
  const ev = l.get(EV);
  assert.deepEqual(ev.teams, ['Michigan St.', 'Tennessee']);
  assert.deepEqual(ev.strikes.map((s) => s.line), [141.5, 144.5, 147.5]);
  assert.equal(ev.strikes[1].yesAsk, 0.57);
  assert.equal(ev.strikes[1].noAsk, 0.45);
});

test('scoreboard names find their ladder, in either order, and only on the right date', () => {
  const l = parseTotals(markets, events);
  const msu = { away: ['Michigan St', 'Michigan State', 'MSU'], home: ['Tennessee', 'TENN'] };
  assert.equal(matchGame(l, '20261121', msu).event, EV);
  assert.equal(matchGame(l, '20261121', { away: msu.home, home: msu.away }).event, EV);
  assert.equal(matchGame(l, '20261122', msu), null);
  assert.equal(matchGame(l, '20261121', { away: ['Michigan'], home: ['Tennessee Tech'] }), null, 'a near name is not a match');
  assert.equal(matchGame(l, '20261121', { away: ['Arkansas-Little Rock', 'UALR'], home: ['UNF'] }).event, 'KXNCAAMBTOTAL-26NOV21UALRUNF', 'short codes match abbreviations');
  assert.equal(nameScore('Saint Mary\'s', "St. Mary's"), 1);
  assert.equal(nameScore('Little Rock', 'Little Rock'), 1);
});

test('fees: Kalshi\'s 7% of p(1-p), rounded up to the cent, plus the Coinbase estimate', () => {
  assert.equal(feeOf(0.5, 0), 0.02);
  assert.equal(feeOf(0.5, 0.02), 0.04);
  assert.equal(feeOf(0.05, 0), 0.01);
});

test('each strike is priced against the model, and the best and nearest are found', () => {
  const l = parseTotals(markets, events).get(EV);
  const model = createModel(JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')));
  const fair = 150, sd = 10, overAt = (line) => 1 - model.cdf((line - fair) / sd);
  const priced = priceLadder(l, overAt, 0.02);
  const p = priced[1];
  assert.ok(p.pOver > 0.6 && p.pOver < 0.75, `over 144.5 with fair 150: ${p.pOver}`);
  assert.ok(Math.abs(p.over.edge - (p.pOver - 0.57 - feeOf(0.57, 0.02))) < 1e-9);
  assert.ok(Math.abs(p.under.chance + p.over.chance - 1) < 1e-9);
  assert.equal(bestOn(priced, 'Over').line, 147.5, 'with fair above every strike, the dearest over has the biggest edge');
  assert.equal(nearest(priced, 145).line, 144.5);
  assert.equal(bestOn([], 'Over'), null);
});

test('the entry rule needs both the three-minute average and a Coinbase price that pays', () => {
  const l = parseTotals(markets, events).get(EV);
  const model = createModel(JSON.parse(readFileSync(new URL('../model.json', import.meta.url), 'utf8')));
  const priced = priceLadder(l, (line) => 1 - model.cdf((line - 152) / 10), 0.02);
  const m = { avgDev: 2.3 };
  const e = entryOf(m, true, priced);
  assert.equal(e.side, 'Over');
  assert.ok(e.edge >= 0.05);
  assert.equal(entryOf({ avgDev: 1.9 }, true, priced), null, 'below two deviations');
  assert.equal(entryOf(m, false, priced), null, 'outside the window or lopsided');
  const flat = priceLadder(l, () => 0.5, 0.02);
  assert.equal(entryOf(m, true, flat), null, 'no contract beats its price by five cents');
  assert.match(quoteWords('Over', e), /^Coinbase: over 147\.5 at 43¢, model \d+%, \+\d+¢ after fees$/);
});

test('the price request asks only for this slate\'s ladders', () => {
  const u = totalsUrl(Date.UTC(2026, 10, 21));
  assert.match(u, /^https:\/\/api\.elections\.kalshi\.com\/trade-api\/v2\/markets\?series_ticker=KXNCAAMBTOTAL&status=open/);
  assert.match(u, /min_close_ts=\d+&max_close_ts=\d+/);
});

test('prediction-market prices are switched off for everyone until the site allows them', () => {
  assert.equal(SITE.coinbase.allowed, false);
  assert.equal(SITE.coinbase.on, false);
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };
  // as shipped: no query string and nothing a browser remembers can turn them on
  const st = mem();
  assert.equal(coinbaseOn({ search: '' }, SITE, st), false);
  assert.equal(coinbaseOn({ search: '?coinbase=1' }, SITE, st), false);
  st.setItem('csl.coinbase', '1');
  assert.equal(coinbaseOn({ search: '' }, SITE, st), false, 'a choice remembered from before the switch does nothing');
  // once allowed, a visitor turns them on for one browser
  const open = { ...SITE, coinbase: { ...SITE.coinbase, allowed: true } }, s2 = mem();
  assert.equal(coinbaseOn({ search: '' }, open, s2), false);
  assert.equal(coinbaseOn({ search: '?coinbase=1' }, open, s2), true);
  assert.equal(coinbaseOn({ search: '' }, open, s2), true, 'remembered');
  assert.equal(coinbaseOn({ search: '?coinbase=0' }, open, s2), false);
});
