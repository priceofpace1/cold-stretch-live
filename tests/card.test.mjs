// The share card's words and the public record's three figures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardModel } from '../js/card.js';
import { recordOf, clockLabel } from '../js/model.js';

const sig = (o) => ({ side: 'Over', line: 142.5, price: -110, priced: 'quoted', minute: 12.7, score: '23-18', result: 'Won', final: 150, ...o });
const base = { site: 'Site', host: 'example.com', day: 'Tue, Nov 24', away: 'Ohio', home: 'New Mexico St', awayPts: 72, homePts: 78, points: [{ t: 5, book: 149.5, fair: 150 }, { t: 6, book: null, fair: 150 }, { t: 41, book: 150, fair: 150 }],
  record: { won: 41, lost: 32 }, sinceLabel: 'November 19', clockLabel };

test('a card names the call, where it was logged, the result and the final', () => {
  const m = cardModel({ ...base, signals: [sig()] });
  assert.equal(m.game, 'Ohio at New Mexico St');
  assert.equal(m.calls[0].call, 'Over 142.5 at −110');
  assert.equal(m.calls[0].result, 'Won');
  assert.match(m.calls[0].when, /^Logged at 1H 7:1[89] with the score 23–18$/);
  assert.equal(m.final, 'Final 72–78, a total of 150.');
  assert.match(m.proof, /41–32 since November 19/);
  assert.equal(m.points.length, 1, 'readings without both numbers, or past regulation, are left off the chart');
});

test('a card carries every settled signal in the game, losses included, and none while all are open', () => {
  const m = cardModel({ ...base, signals: [sig(), sig({ side: 'Under', line: 151.5, price: 105, result: 'Lost' }), sig({ result: 'Pending', final: null })] });
  assert.deepEqual(m.calls.map((c) => `${c.call}: ${c.result}`), ['Over 142.5 at −110: Won', 'Under 151.5 at +105: Lost']);
  assert.equal(cardModel({ ...base, signals: [sig({ result: 'Pending', final: null })] }), null);
  assert.equal(cardModel({ ...base, signals: [sig({ priced: 'assumed' })] }).calls[0].call, 'Over 142.5', 'an estimated price is not printed as a quote');
});

test('the record counts game totals scored live, at the quoted price, and the same bets a minute on', () => {
  const row = (o) => ({ date: '20261120', mkt: 'total', side: 'Over', line: 140.5, price: -110, result: 'Won', final: 150, later: { 60: [61, 141.5, -115, true] }, ...o });
  const r = recordOf([row(), row({ result: 'Lost', final: 141, later: { 60: [58, 140.5, -110, false] } }), row({ price: 120 }), row({ mkt: 'home' }), row({ date: '20261118' }), row({ fault: 'stalled' }), row({ result: 'Pending', final: null })], '20261119');
  assert.equal(r.n, 4);
  assert.deepEqual([r.won, r.lost], [2, 1]);
  assert.ok(Math.abs(r.units - (100 / 110 - 1 + 1.2)) < 1e-9);
  assert.deepEqual(r.late, { won: 3, lost: 0 }, 'final 141 clears the 140.5 showing a minute later');
});
