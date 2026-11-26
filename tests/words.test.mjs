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
  assert.equal(w.head, 'No games are underway. Sixty are on today’s board, the first at 6:00 PM.');
  assert.equal(say({ ahead: 1 }).head, 'No games are underway. One is on today’s board, the first at 6:00 PM.');
  assert.match(w.sub, /minute 4/);
});

test('with games live it leads with the totals that stand out of line, and says what that is', () => {
  const live = { live: 14, readings: 300 }, g = (name, dev = 2.4, min = 3) => ({ name, dev, min });
  const one = say({ ...live, on: [g('LSU at Arizona St')], signals: { n: 5, open: 2, won: 2, lost: 1, pushed: 0 } });
  assert.equal(one.head, 'One total is out of line with the model: LSU at Arizona St.');
  assert.match(one.sub, /^The sportsbook’s live total there has stood 2\.4 deviations from the model’s fair number for 3 minutes\. That is a disagreement between a model and a market, logged before the result is known\. It does not mean the market is wrong\. Today so far: 2 won, 1 lost, 1 waiting on a result\.$/);
  assert.equal(say({ ...live, on: [g('A at B'), g('C at D')] }).head, 'Two totals are out of line with the model: A at B and C at D.');
  assert.equal(say({ ...live, on: [g('A at B'), g('C at D'), g('E at F'), g('G at H')] }).head, 'Four games meet the signal criteria, led by A at B.');
  assert.equal(say({ ...live, near: { name: 'Georgia St at FGCU', dev: 1.7 } }).head, 'A gap is building at Georgia St at FGCU.');
  assert.equal(say({ ...live, near: { name: 'Georgia St at FGCU', dev: 1.1 } }).head, 'No material gaps across fourteen live games.');
  assert.match(say({ ...live, near: { name: 'Georgia St at FGCU', dev: 1.1 } }).sub, /^A signal needs the three-minute average 2 deviations from fair, held for two minutes\. The closest game is Georgia St at FGCU, at 1\.1\./);
  assert.equal(say({ ...live, live: 1 }).head, 'No material gap in the one live game.');
  assert.doesNotMatch(say(live).sub, /Today so far/);
  for (const w of [one, say(live), say({ ...live, near: { name: 'X at Y', dev: 1.7 } })]) assert.doesNotMatch(w.head + w.sub, /mispriced|wrong number|the market is wrong\b(?!\.)|lock|guarantee/i);
});

test('a finished slate leads with its record', () => {
  const w = say({ today: false, anyFinal: true, readings: 2646, signals: { n: 77, open: 0, won: 40, lost: 35, pushed: 2 } });
  assert.equal(w.head, 'Wednesday’s slate: 77 signals, 40 won, 35 lost, 2 pushed.');
  assert.match(w.sub, /were 1\.4 points apart on average\.$/);
  assert.equal(say({ today: false, anyFinal: true, readings: 500 }).head, 'No signal was logged on Wednesday.');
  assert.equal(say({ anyFinal: true, readings: 500, signals: { n: 8, open: 0, won: 5, lost: 3, pushed: 0 } }).head, 'The slate is final: 8 signals, 5 won, 3 lost.');
  assert.equal(say({ anyFinal: true, readings: 500 }).head, 'The slate is final. No signal was logged.');
  assert.match(say({ today: false, anyFinal: true, readings: 2646, afterFact: true, signals: { n: 77, open: 0, won: 42, lost: 32, pushed: 3 } }).sub, /scored after the fact, under a rule set later\.$/);
  assert.doesNotMatch(w.sub, /after the fact/);
});

test('between sessions on the same day it says what is still to come', () => {
  const w = say({ anyFinal: true, ahead: 12, readings: 400, signals: { n: 3, open: 0, won: 2, lost: 1, pushed: 0 } });
  assert.equal(w.head, 'Three signals so far today: 2 won, 1 lost.');
  assert.match(w.sub, /12 games are still to tip; the next is at 6:00 PM\.$/);
});

test('lines not yet recorded while games are live, or never recorded', () => {
  assert.equal(say({ live: 3 }).head, 'Three games are underway. The first lines are coming in.');
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
  assert.equal(boardWords({ ...base, record: true }).sub, 'A signal needs the three-minute average 2 deviations from fair, held for two minutes. Today so far: 1 won, 0 lost, 1 waiting on a result.');
  assert.match(boardWords({ ...base, record: false }).sub, /1\.1 points apart/);
  assert.deepEqual(watchWords({ dev: 1.72, lean: 1.5, book: 142.5, fair: 145.6 }), { side: 'over', on: true, text: 'On watch for the over: book 142.5, fair 145.6' });
  assert.deepEqual(watchWords({ dev: -1.2, lean: 1.5, book: 150.5, fair: 148.9 }), { side: 'under', on: false, text: 'Leaning to the under: book 150.5, fair 148.9' });
  // two deviations out: what is left is the two-minute hold
  const far = { dev: 2.3, lean: 1.5, buy: 2, hold: 105, book: 142.5, fair: 146.0 };
  assert.equal(watchWords({ ...far, run: 60 }).text, 'Building on the over, 1 of 2 minutes: book 142.5, fair 146.0');
  assert.equal(watchWords({ ...far, run: 0 }).text, 'Building on the over, 0 of 2 minutes: book 142.5, fair 146.0');
  assert.equal(watchWords({ ...far, dev: -2.3, run: 250 }).text, 'Held 4 min on the under, not a bet at this line and price: book 142.5, fair 146.0');
  assert.equal(watchWords({ ...far, run: null }).text, 'On watch for the over: book 142.5, fair 146.0');
});

test('the bet button says the bet, and how far the line can move against it', async () => {
  const { betWords } = await import('../js/words.js');
  const book = { key: 'book', name: 'Sportsbook' };
  assert.deepEqual(betWords(book, 'Over', { line: 142.5, price: -110, goodTo: 143.5 }), { label: 'Bet over 142.5 at −110', note: 'Worth taking up to 143.5 at that price.' });
  assert.deepEqual(betWords(book, 'Under', { line: 150.5, price: 105, goodTo: 150.5 }), { label: 'Bet under 150.5 at +105', note: 'Not worth taking at a worse line.' });
  assert.equal(betWords({ key: 'coinbase', name: 'Coinbase' }, 'Over', { line: 141.5, price: 0.52 }).label, 'Buy over 141.5 at 52¢ on Coinbase');
});

test('the rule is said in one line, for the rule of the slate in view', async () => {
  const { ruleLine, RULE_BRIEF } = await import('../js/words.js');
  const { RULE_HISTORY } = await import('../js/model.js');
  const now = RULE_HISTORY[RULE_HISTORY.length - 1];
  for (const r of RULE_HISTORY) { assert.ok(RULE_BRIEF[r.version], `a table line for ${r.version}`); assert.ok(ruleLine({ version: r.version, since: 'x' }), `a board line for ${r.version}`); }
  assert.equal(ruleLine({ version: now.version, since: 'Nov 25', current: true, dev: 1.337 }),
    'Signal rule since Nov 25: three-minute average gap of 2 deviations (2.7 points today), held 2 minutes, minutes 4 to 34, and the model’s chance at least 5 points over the price’s break-even.');
  assert.equal(ruleLine({ version: '2026-11-22.1', since: 'Nov 22', dev: 1.46 }),
    'Signal rule on this slate (since Nov 22): three-minute average gap of 2 deviations (2.9 points that day), logged when first reached, minutes 4 to 34, and the model’s chance at least 5 points over the price’s break-even.');
  assert.match(ruleLine({ version: now.version, since: 'Nov 25', before: true }), /^From before the record began, and judged afterwards under the rule now in force: three-minute average gap of 2 deviations, held 2 minutes/);
  assert.equal(ruleLine({ version: 'nope' }), '');
});
