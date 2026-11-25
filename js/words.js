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
  const what = 'A signal is logged when the sportsbook’s live total sits well away from the fair number for three minutes, at a price that pays.';
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
  if (now.state === 'off') return { text: now.why === 'late' ? `Past minute ${limits.lastMinute}, where signals stop` : `Lead of ${limits.lead} or more, where signals are off`, on: false };
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
  const side = d.dev > 0 ? 'over' : 'under', on = Math.abs(d.dev) >= d.lean;
  return { side, on, text: `${on ? 'On watch for the' : 'Leaning to the'} ${side}: book ${d.book.toFixed(1)}, fair ${d.fair.toFixed(1)}` };
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
