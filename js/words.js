// The board's headline and the line under it, in plain words. Pure functions, so every state of a slate can be tested.

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const settled = (s) => `${s.won} won, ${s.lost} lost${s.pushed ? `, ${s.pushed} pushed` : ''}`;

/**
 * d: { loaded, today, weekday, games, live, ahead, nextTip, anyFinal, readings, apart, firstMinute, afterFact,
 *      signals: { n, open, on, won, lost, pushed } } (on: open signals that still pass on the quote showing)
 * The headline says what there is to act on; the standfirst says what a signal is and how close the two numbers ran.
 */
export function boardWords(d) {
  const s = d.signals || { n: 0, open: 0, won: 0, lost: 0, pushed: 0 };
  if (!d.loaded) return { head: 'Loading the slate.', sub: '' };
  if (!d.games) return { head: 'No games on this date.', sub: '' };
  const from = `Signals can fire from minute ${d.firstMinute} of each game.`;
  if (!d.readings) {
    if (d.today && d.live) return { head: `${plural(d.live, 'game')} in progress. The first lines are coming in.`, sub: from };
    if (d.ahead && !d.anyFinal) return { head: `${plural(d.ahead, 'game')} on the slate. The first tips at ${d.nextTip}.`, sub: `The board fills in at tip-off. ${from}` };
    if (d.today && d.ahead) return { head: `${plural(d.ahead, 'game')} still to tip. The next is at ${d.nextTip}.`, sub: `No live line has been recorded yet today. ${from}` };
    return { head: 'No live lines were recorded for this slate.', sub: 'ESPN drops the live line at the final whistle, so a slate can only be measured while the recorder is running.' };
  }
  const apart = `Across ${plural(d.readings, 'reading')} the sportsbook and the fair number have been ${d.apart.toFixed(1)} points apart on average.`;
  const done = s.won + s.lost + s.pushed;
  if (d.today && d.live) {
    // What can be done right now leads. A signal whose edge has gone is still open, but there is nothing to do about it.
    const on = s.on || 0, waiting = s.open - on, games = d.live === 1 ? 'One game is' : `${d.live} games are`;
    const head = on ? `${on === 1 ? 'One signal' : `${on} signals`} can be bet right now.`
      : s.open ? 'Nothing to bet right now.'
        : `No signal is open right now. ${games} live.`;
    const today = done || waiting ? ` Today so far: ${settled(s)}${waiting ? `, ${waiting} waiting on a result` : ''}.` : '';
    return { head, sub: `${on || s.open ? `${games} live.` : ''}${today}${d.record ? '' : ` ${apart}`}`.trim() };
  }
  const when = d.today ? 'today' : `on ${d.weekday}`;
  const head = s.n ? `${plural(s.n, 'signal')} ${when}: ${settled(s)}${s.open ? `, ${s.open} open` : ''}.` : `No signals ${when}.`;
  const what = 'A signal is logged when the sportsbook’s live total stays well away from the fair number, at a price that pays.';
  const next = d.today && d.ahead ? ` ${d.ahead === 1 ? 'One game is' : `${d.ahead} games are`} still to tip; the next is at ${d.nextTip}.` : '';
  const scored = d.afterFact && s.n ? ' This slate was scored after the fact, under a rule set later.' : '';
  return { head, sub: `${what} ${apart.replace('have been', d.today ? 'have been' : 'were')}${next}${scored}` };
}

const price = (p) => `${p > 0 ? '+' : '−'}${Math.abs(p)}`;

/**
 * An open signal against the quote showing now, in a few words. `now` is model.signalNow()'s answer;
 * limits: { lastMinute, lead } from the rules. Returns { text, on }: `on` is true only while the bet can still be made.
 */
export function signalWords(now, limits) {
  if (!now || now.state === 'none') return { text: 'No live line right now', on: false };
  if (now.state === 'off') return { text: now.why === 'stalled' ? 'The score feed has stalled' : now.why === 'late' ? `Past minute ${limits.lastMinute}, where signals stop` : `Lead of ${limits.lead} or more, where signals are off`, on: false };
  const line = now.line.toFixed(1);
  // The line named is the one showing now; the row above it carries the line the signal fired at.
  if (now.state === 'on') return { text: `Still on at ${line}${now.quoted ? ` (${price(now.price)})` : ''}`, on: true };
  return { text: `Edge gone at ${line}`, on: false };
}

/**
 * A live game nearing a signal, for the board's watch list. d: { dev, lean, book, fair }, dev being the three-minute
 * average in deviations. Returns { side, on, text }: `on` from the watch tier up.
 */
export function watchWords(d) {
  const side = d.dev > 0 ? 'over' : 'under', on = Math.abs(d.dev) >= d.lean, nums = `book ${d.book.toFixed(1)}, fair ${d.fair.toFixed(1)}`;
  if (d.run != null && d.buy != null && Math.abs(d.dev) >= d.buy) { // far enough out: what is left is the hold
    const need = Math.round(d.hold / 60), had = Math.floor(d.run / 60);
    return { side, on: true, text: d.run < d.hold ? `Building on the ${side}, ${had} of ${need} minutes: ${nums}` : `Held ${had} min on the ${side}, not a bet at this line and price: ${nums}` };
  }
  return { side, on, text: `${on ? 'On watch for the' : 'Leaning to the'} ${side}: book ${d.book.toFixed(1)}, fair ${d.fair.toFixed(1)}` };
}

const american = (p) => `${p > 0 ? '+' : '−'}${Math.abs(Math.round(p))}`;

/**
 * The words on the bet button of an open signal. venue: { key, name }. For the sportsbook, q is { line, price, goodTo }
 * on the quote showing now; for a prediction market, q is the best contract on the signal's side { line, price } with
 * price in dollars. Returns { label, note }.
 */
export function betWords(venue, side, q) {
  const s = side.toLowerCase();
  if (venue.key === 'book') {
    const further = q.goodTo != null && q.goodTo !== q.line;
    return { label: `Bet ${s} ${q.line.toFixed(1)} at ${american(q.price)}`, note: further ? `Worth taking ${side === 'Over' ? 'up' : 'down'} to ${q.goodTo.toFixed(1)} at that price.` : 'Not worth taking at a worse line.' };
  }
  return { label: `Buy ${s} ${q.line.toFixed(1)} at ${Math.round(q.price * 100)}¢ on ${venue.name}`, note: '' };
}

/** How long ago a signal fired, for the minutes it is fresh. */
export function agoWords(seconds) {
  if (seconds < 60) return 'just now';
  const m = Math.floor(seconds / 60);
  return m < 60 ? `${m} min ago` : '';
}

/** How long a signal stayed bettable before its edge went, to tack on after "Edge gone at 125.5". */
export function lastedWords(seconds) {
  return seconds < 90 ? `after ${Math.max(10, Math.round(seconds / 10) * 10)} sec` : `after ${Math.round(seconds / 60)} min`;
}

/**
 * Each rule there has been, in a line a reader can hold in mind. Keyed by the rule's version (js/model.js RULE_HISTORY);
 * shown beside the signals on the board and the game page and against each rule's own record. `dev` is one deviation in
 * points as a string, where it is known.
 */
export const RULE_BRIEF = Object.freeze({
  '2026-11-19.2': 'the three-minute average gap 2 deviations out, logged the moment it got there, minutes 4 to 38, game and team totals',
  '2026-11-22.1': 'the three-minute average gap 2 deviations out, logged the moment it got there, minutes 4 to 34, game totals only',
  '2026-11-25.1': 'the three-minute average gap 2 deviations out and held there 2 minutes, minutes 4 to 34, game totals only, nothing on a stalled score feed',
});
/** The same rules as the board says them: shorter, with the distance in points where the day's deviation is known. */
const RULE_SHORT = Object.freeze({
  '2026-11-19.2': (pts) => `three-minute average gap of 2 deviations${pts}, logged when first reached, minutes 4 to 38`,
  '2026-11-22.1': (pts) => `three-minute average gap of 2 deviations${pts}, logged when first reached, minutes 4 to 34`,
  '2026-11-25.1': (pts) => `three-minute average gap of 2 deviations${pts}, held 2 minutes, minutes 4 to 34`,
});
export function ruleLine(d) {
  const short = RULE_SHORT[d.version];
  if (!short) return '';
  const said = `${short(d.dev ? ` (${(2 * d.dev).toFixed(1)} points ${d.current ? 'today' : 'that day'})` : '')}, at a price that pays.`;
  if (d.before) return `From before the record began, and judged afterwards under the rule now in force: ${said}`;
  return `${d.current ? `Signal rule since ${d.since}` : `Signal rule on this slate (since ${d.since})`}: ${said}`;
}
