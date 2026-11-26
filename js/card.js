// A settled game as a picture to pass on: the call, where it was logged, how it ended, and the two numbers through the
// game. cardModel() is plain data and words (tested); drawCard() paints it on a canvas in the site's own type and colour.

const price = (p) => `${p > 0 ? '+' : '−'}${Math.abs(Math.round(p))}`;
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);

/**
 * d: { site, host, day, away, home, awayPts, homePts, signals: [{ side, line, price, priced, minute, score, result, final }],
 *      points: [{ t, book, fair }] (to the minute signals stop), record: { won, lost, since }, sinceLabel, clockLabel }
 * Every game-total signal in the game goes on the card, won or lost: a card cannot show one and leave out another.
 * Returns null when nothing in the game has settled.
 */
export function cardModel(d) {
  const settled = (d.signals || []).filter((s) => s.result === 'Won' || s.result === 'Lost' || s.result === 'Push');
  if (!settled.length) return null;
  const total = d.awayPts + d.homePts;
  const calls = settled.map((s) => ({
    call: `${s.side} ${f1(s.line)}${s.priced === 'assumed' || s.price == null ? '' : ` at ${price(s.price)}`}`,
    result: s.result === 'Push' ? 'Pushed' : s.result,
    when: `Logged at ${d.clockLabel(s.minute)} with the score ${String(s.score).replace('-', '–')}`,
    won: s.result === 'Won', t: s.minute, line: s.line, side: s.side,
  }));
  const r = d.record;
  return {
    site: d.site, host: d.host, day: d.day, game: `${d.away} at ${d.home}`, calls,
    final: `Final ${d.awayPts}–${d.homePts}, a total of ${total}.`, total,
    proof: r && r.won + r.lost ? `Every signal is logged before the result. ${r.won}–${r.lost} since ${d.sinceLabel}, wins and losses alike.` : 'Every signal is logged before the result, wins and losses alike.',
    points: (d.points || []).filter((p) => p.book != null && p.fair != null && p.t <= 40),
    alt: `${d.away} at ${d.home}: ${calls.map((c) => `${c.call}, ${c.result.toLowerCase()}`).join('; ')}. Final total ${total}.`,
  };
}

const INK = '#000000', SUB = '#444444', RULE = '#D6D6D6', GROUND = '#FFFFFF', PANEL = '#FFFFFF', BOOK = '#000000', FAIR = '#6B6B6B'; // the site's black, white and greys
const SANS = '"IBM Plex Sans", "Helvetica Neue", Arial, sans-serif', SERIF = '"Inria Serif", Georgia, serif';

/** Lines of text no wider than `max`, broken at spaces. */
function wrap(ctx, text, max) {
  const out = []; let line = '';
  for (const w of text.split(' ')) { const next = line ? `${line} ${w}` : w; if (line && ctx.measureText(next).width > max) { out.push(line); line = w; } else line = next; }
  if (line) out.push(line);
  return out;
}

/** Paints the card. The canvas is sized here (1200 by 1500, four by five, which a phone shows whole in a message thread). */
export function drawCard(canvas, m) {
  const W = 1200, H = 1500, X = 84, R = W - 84;
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  c.fillStyle = GROUND; c.fillRect(0, 0, W, H);
  c.textBaseline = 'alphabetic';
  const text = (s, x, y, font, color = INK, align = 'left') => { c.font = font; c.fillStyle = color; c.textAlign = align; c.fillText(s, x, y); };
  const rule = (y, color = RULE, w = 2) => { c.strokeStyle = color; c.lineWidth = w; c.setLineDash([]); c.beginPath(); c.moveTo(X, y); c.lineTo(R, y); c.stroke(); };

  text(m.site, X, 124, `600 50px ${SERIF}`);
  text(m.day, R, 124, `400 30px ${SANS}`, SUB, 'right');
  rule(156, INK, 3);

  let y = 232;
  text(m.game, X, y, `500 38px ${SANS}`, SUB);
  const big = m.calls.length === 1;
  for (const call of m.calls) {
    y += big ? 124 : 96;
    const size = big ? 104 : 72;
    c.font = `500 ${size}px ${SERIF}`;
    const fits = c.measureText(`${call.call}. ${call.result}.`).width <= R - X;
    text(`${call.call}.`, X, y, `500 ${size}px ${SERIF}`);
    if (fits) text(`${call.result}.`, X + c.measureText(`${call.call}. `).width, y, `500 ${size}px ${SERIF}`, INK);
    else { y += size; text(`${call.result}.`, X, y, `500 ${size}px ${SERIF}`, INK); }
    y += big ? 56 : 46;
    text(`${call.when}.`, X, y, `400 30px ${SANS}`, SUB);
  }
  y += 52;
  text(m.final, X, y, `500 32px ${SANS}`);

  // The chart: the sportsbook's live total and the fair number through the game, the final as a level line.
  const top = y + 96, bottom = H - 250, left = X + 70, right = R - 8;
  const pts = m.points, vals = pts.flatMap((p) => [p.book, p.fair]).concat([m.total], m.calls.map((k) => k.line));
  const lo = Math.floor((Math.min(...vals) - 3) / 5) * 5, hi = Math.ceil((Math.max(...vals) + 3) / 5) * 5;
  const px = (t) => left + (right - left) * (t / 40), py = (v) => bottom - (bottom - top) * ((v - lo) / (hi - lo || 1));
  text('Sportsbook live total', left + 54, top - 40, `400 26px ${SANS}`, SUB);
  c.strokeStyle = BOOK; c.lineWidth = 5; c.beginPath(); c.moveTo(left, top - 49); c.lineTo(left + 40, top - 49); c.stroke();
  const second = left + 54 + c.measureText('Sportsbook live total').width + 44;
  text('Fair number', second + 54, top - 40, `400 26px ${SANS}`, SUB);
  c.strokeStyle = FAIR; c.beginPath(); c.moveTo(second, top - 49); c.lineTo(second + 40, top - 49); c.stroke();
  const step = hi - lo > 40 ? 10 : 5;
  for (let v = lo; v <= hi; v += step) {
    c.strokeStyle = RULE; c.lineWidth = 1.5; c.setLineDash([]); c.beginPath(); c.moveTo(left, py(v)); c.lineTo(right, py(v)); c.stroke();
    text(String(v), left - 16, py(v) + 9, `400 24px ${SANS}`, SUB, 'right');
  }
  c.strokeStyle = RULE; c.beginPath(); c.moveTo(px(20), top); c.lineTo(px(20), bottom); c.stroke();
  for (const [t, label, align] of [[0, 'Tip', 'left'], [20, 'Half', 'center'], [40, 'Final', 'right']]) text(label, px(t), bottom + 40, `400 24px ${SANS}`, SUB, align);
  c.strokeStyle = INK; c.lineWidth = 2.5; c.setLineDash([10, 8]); c.beginPath(); c.moveTo(left, py(m.total)); c.lineTo(right, py(m.total)); c.stroke(); c.setLineDash([]);
  const line = (key, color) => {
    c.strokeStyle = color; c.lineWidth = 5; c.lineJoin = 'round'; c.lineCap = 'round'; c.beginPath();
    pts.forEach((p, i) => { const fn = i && p.t - pts[i - 1].t <= 4 ? 'lineTo' : 'moveTo'; c[fn](px(p.t), py(p[key])); }); // a long hole in the readings is left as a hole
    c.stroke();
  };
  if (pts.length > 1) { line('fair', FAIR); line('book', BOOK); }
  // The final's label sits at the left end of its line, where the readings have usually not begun, over a halo in case they have.
  c.font = `600 26px ${SANS}`; c.textAlign = 'left'; c.lineWidth = 8; c.strokeStyle = GROUND; c.lineJoin = 'round';
  c.strokeText(`Final ${m.total}`, left + 10, py(m.total) - 14); c.fillStyle = INK; c.fillText(`Final ${m.total}`, left + 10, py(m.total) - 14);
  for (const k of m.calls) {
    const x = px(k.t), yy = py(k.line);
    c.fillStyle = PANEL; c.beginPath(); c.arc(x, yy, 15, 0, 7); c.fill();
    c.fillStyle = INK; c.beginPath(); c.arc(x, yy, 10, 0, 7); c.fill();
    const label = `${k.side} ${f1(k.line)}`, onRight = x < (left + right) / 2;
    c.font = `600 26px ${SANS}`; c.lineWidth = 8; c.strokeStyle = GROUND; c.textAlign = onRight ? 'left' : 'right';
    const ly = yy + (k.side === 'Over' ? 46 : -26);
    c.strokeText(label, x + (onRight ? 20 : -20), ly); c.fillStyle = INK; c.fillText(label, x + (onRight ? 20 : -20), ly);
  }

  rule(H - 172);
  c.font = `400 28px ${SANS}`;
  wrap(c, m.proof, R - X).slice(0, 2).forEach((s, i) => text(s, X, H - 122 + i * 38, `400 28px ${SANS}`, SUB));
  text(m.host, X, H - 40, `600 30px ${SANS}`);
}
