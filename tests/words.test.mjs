// The board's headline in every state of a slate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardWords, signalWords, agoWords, lastedWords } from '../js/words.js';

const base = { loaded: true, today: true, weekday: 'Wednesday', games: 60, live: 0, ahead: 0, nextTip: '6:00 PM', anyFinal: false, readings: 0, apart: 1.4, firstMinute: 4, signals: { n: 0, open: 0, won: 0, lost: 0, pushed: 0 } };
const say = (over) => boardWords({ ...base, ...over });

test('before anything is known, and on an empty date', () => {
  assert.equal(say({ loaded: false }).head, 'Loading the slate.');
  assert.equal(say({ games: 0 }).head, 'No games on this date.');
});

test('before the first tip it gives the count and the time', () => {
  const w = say({ ahead: 60 });
  assert.equal(w.head, '60 games on the slate. The first tips at 6:00 PM.');
  assert.match(w.sub, /minute 4/);
});

test('with games live it leads with what can be bet now', () => {
  const live = { live: 14, readings: 300 };
  assert.equal(say({ ...live, signals: { n: 5, open: 2, on: 1, won: 2, lost: 1, pushed: 0 } }).head, 'One signal can be bet right now.');
  assert.equal(say({ ...live, signals: { n: 5, open: 3, on: 2, won: 2, lost: 0, pushed: 0 } }).head, '2 signals can be bet right now.');
  assert.equal(say({ ...live, signals: { n: 5, open: 2, on: 0, won: 2, lost: 1, pushed: 0 } }).head, 'Nothing to bet right now. 2 open signals are waiting on a result.');
  assert.equal(say({ ...live, live: 1, signals: { n: 1, open: 1, won: 0, lost: 0, pushed: 0 } }).head, 'Nothing to bet right now. One open signal is waiting on a result.');
  assert.equal(say(live).head, 'No signal is open right now. 14 games are live.');
  assert.match(say({ ...live, signals: { n: 5, open: 2, on: 1, won: 2, lost: 1, pushed: 0 } }).sub, /^14 games are live\. Today so far: 2 won, 1 lost, 1 waiting on a result\. Across 300 readings .* 1\.4 points apart/);
  assert.doesNotMatch(say(live).sub, /Today so far/);
});

test('a finished slate leads with its record', () => {
  const w = say({ today: false, anyFinal: true, readings: 2646, signals: { n: 77, open: 0, won: 40, lost: 35, pushed: 2 } });
  assert.equal(w.head, '77 signals on Wednesday: 40 won, 35 lost, 2 pushed.');
  assert.match(w.sub, /were 1\.4 points apart on average\.$/);
  assert.equal(say({ today: false, anyFinal: true, readings: 500 }).head, 'No signals on Wednesday.');
  assert.match(say({ today: false, anyFinal: true, readings: 2646, afterFact: true, signals: { n: 77, open: 0, won: 42, lost: 32, pushed: 3 } }).sub, /scored after the fact, under a rule set later\.$/);
  assert.doesNotMatch(w.sub, /after the fact/);
});

test('between sessions on the same day it says what is still to come', () => {
  const w = say({ anyFinal: true, ahead: 12, readings: 400, signals: { n: 3, open: 0, won: 2, lost: 1, pushed: 0 } });
  assert.equal(w.head, '3 signals today: 2 won, 1 lost.');
  assert.match(w.sub, /12 games are still to tip; the next is at 6:00 PM\.$/);
});

test('lines not yet recorded while games are live, or never recorded', () => {
  assert.equal(say({ live: 3 }).head, '3 games in progress. The first lines are coming in.');
  assert.equal(say({ today: false, anyFinal: true }).head, 'No live lines were recorded for this slate.');
});

test('an open signal says whether it can still be bet', () => {
  const lim = { lastMinute: 38, lead: 15 }, say2 = (now) => signalWords(now, lim);
  assert.deepEqual(say2({ state: 'on', line: 147.5, price: -118, quoted: true, moved: false }), { text: 'Still on at 147.5 (−118)', on: true });
  assert.equal(say2({ state: 'on', line: 146.5, price: 105, quoted: true, moved: true }).text, 'Still on at 146.5 (+105)');
  assert.equal(say2({ state: 'on', line: 71, price: -115, quoted: false, moved: false }).text, 'Still on at 71.0', 'an estimated price is not shown as a quote');
  assert.deepEqual(say2({ state: 'gone', line: 144.5, moved: true }), { text: 'Edge gone at 144.5', on: false });
  assert.equal(say2({ state: 'off', why: 'late' }).text, 'Past minute 38, where signals stop');
  assert.equal(say2({ state: 'off', why: 'lopsided' }).text, 'Lead of 15 or more, where signals are off');
  assert.equal(say2({ state: 'none' }).on, false);
  assert.equal(say2(null).text, 'No live line right now');
});

test('how long a signal lasted', () => {
  assert.equal(lastedWords(20), 'after 20 sec');
  assert.equal(lastedWords(44), 'after 40 sec');
  assert.equal(lastedWords(200), 'after 3 min');
});

test('how long ago a signal fired', () => {
  assert.equal(agoWords(20), 'just now');
  assert.equal(agoWords(150), '2 min ago');
  assert.equal(agoWords(4000), '');
});

test('with the record beside the headline, the live standfirst stays to the day', async () => {
  const { boardWords, watchWords } = await import('../js/words.js');
  const base = { loaded: true, today: true, weekday: 'Tuesday', games: 40, live: 3, ahead: 20, nextTip: '6:00 PM', anyFinal: true, readings: 200, apart: 1.1, firstMinute: 4, afterFact: false, signals: { n: 2, open: 1, won: 1, lost: 0, pushed: 0 } };
  assert.equal(boardWords({ ...base, record: true }).sub, '3 games are live. Today so far: 1 won, 0 lost, 1 waiting on a result.');
  assert.match(boardWords({ ...base, record: false }).sub, /1\.1 points apart/);
  assert.deepEqual(watchWords({ dev: 1.72, lean: 1.5, book: 142.5, fair: 145.6 }), { side: 'over', on: true, text: 'On watch for the over: book 142.5, fair 145.6' });
  assert.deepEqual(watchWords({ dev: -1.2, lean: 1.5, book: 150.5, fair: 148.9 }), { side: 'under', on: false, text: 'Leaning to the under: book 150.5, fair 148.9' });
});
