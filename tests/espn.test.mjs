// Parsers against trimmed real ESPN responses (Michigan State at Tennessee, Nov 17 2026, captured at halftime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEvent, parseOdds, parseSummary } from '../js/espn.js';

const fx = JSON.parse(readFileSync(new URL('fixtures/espn.json', import.meta.url)));

test('scoreboard event: teams, ranks, score and state', () => {
  const live = parseEvent(fx.events.find((e) => e.id === '401906851'));
  assert.equal(live.state, 'in');
  assert.equal(live.away.name, 'Michigan St');
  assert.equal(live.home.name, 'Tennessee');
  assert.equal(live.away.abbr, 'MSU');
  assert.equal(typeof live.away.pts, 'number');
  assert.ok(live.minute >= 0 && live.minute <= 40);
  const pre = parseEvent(fx.events.find((e) => e.id === '401925879'));
  assert.equal(pre.state, 'pre');
  assert.deepEqual(pre.boardPre, [152.5, -23.5], 'pregame line comes with the scoreboard before tip');
});

test('scoreboard event: malformed input returns null instead of throwing', () => {
  assert.equal(parseEvent({}), null);
  assert.equal(parseEvent({ status: { type: {} }, competitions: [{ competitors: [] }] }), null);
});

test('odds feed: provider 100 is the closing line, 200 is the live line', () => {
  const o = parseOdds(fx.odds);
  assert.deepEqual(o.pre, [149.5, 2.5]);
  assert.equal(o.live.total, 128.5);
  assert.equal(o.live.spread, 1.5);
  assert.equal(o.live.over, -125);
  assert.equal(o.live.under, -105);
  assert.deepEqual(parseOdds({}), { pre: null, live: null });
  assert.deepEqual(parseOdds({ items: [{ provider: { id: '200' }, overUnder: null, spread: 1.5 }] }), { pre: null, live: null });
});

test('summary: a score timeline that only moves forward, and the closing line', () => {
  const s = parseSummary(fx.summary);
  assert.deepEqual(s.timeline[0], { t: 0, a: 0, h: 0 });
  for (let i = 1; i < s.timeline.length; i += 1) assert.ok(s.timeline[i].t >= s.timeline[i - 1].t - 0.05);
  const last = s.timeline[s.timeline.length - 1];
  assert.deepEqual([last.a, last.h], [25, 27], 'ends on the halftime score');
  assert.ok(last.t > 19 && last.t <= 20);
  assert.deepEqual(s.pre, [149.5, 2.5]);
  assert.deepEqual(parseSummary({}).timeline, [{ t: 0, a: 0, h: 0 }]);
});

test('odds feed: the live line carries the sportsbook’s own bet links, unwrapped and checked', () => {
  const wrap = (path) => `https://book.example/gateway?wpsrc=413&preurl=${encodeURIComponent(`https://book.example${path}`)}`;
  const item = (links) => ({ items: [{ provider: { id: '200' }, overUnder: 143.5, spread: -6.5, current: { over: { american: '-115' }, under: { american: '-105' } }, links }] });
  const links = [{ rel: ['over', 'desktop', 'bets'], href: wrap('/event/1?outcomes=0OU2O14350_1') }, { rel: ['under', 'desktop', 'bets'], href: wrap('/event/1?outcomes=0OU2U14350_3') }, { rel: ['game'], href: wrap('/event/1') }];
  assert.deepEqual(parseOdds(item(links), ['book.example']).live.links, { over: 'https://book.example/event/1?outcomes=0OU2O14350_1', under: 'https://book.example/event/1?outcomes=0OU2U14350_3' });
  assert.equal(parseOdds(item(links)).live.links, undefined, 'no host is trusted unless the site names it');
  assert.equal(parseOdds(item(links), ['other.example']).live.links, undefined);
  assert.equal(parseOdds(item([{ rel: ['over'], href: 'http://book.example/event/1' }, { rel: ['under'], href: 'not a link' }]), ['book.example']).live.links, undefined, 'only https');
  assert.equal(parseOdds(item(undefined), ['book.example']).live.total, 143.5);
});
