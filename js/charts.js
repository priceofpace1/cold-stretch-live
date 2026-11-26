// Drawing. d3 is loaded as a global by index.html. Colours come from the CSS custom properties in css/app.css.

const d3 = globalThis.d3;
const f1 = (v) => (v == null || !Number.isFinite(v) ? '–' : v.toFixed(1));
const signed = (v) => { if (v == null || !Number.isFinite(v)) return '–'; const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1); };
const tick = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : '0');

/**
 * One row of the board: fair minus book in deviations, on a fixed scale.
 * The dot is the latest reading, the bar is the range seen so far, the tinted ends start at the signal threshold.
 */
export function rangePlot({ gap, lo, hi, signal = false, span = 4, threshold = 2, unit = '' }) {
  const at = (v) => `${((Math.max(-span, Math.min(span, v)) + span) / (2 * span)) * 100}%`;
  const plot = document.createElement('span');
  plot.className = 'plot';
  plot.setAttribute('role', 'img');
  plot.setAttribute('aria-label', gap == null ? 'No line to measure' : `Fair minus book ${signed(gap)}${unit}${lo != null && hi != null ? `, range ${signed(lo)} to ${signed(hi)}` : ''}`);
  if (lo != null && hi != null && hi > lo) {
    const range = document.createElement('i');
    range.className = 'range';
    range.style.left = at(lo);
    range.style.width = `${parseFloat(at(hi)) - parseFloat(at(lo))}%`;
    plot.append(range);
  }
  if (gap != null) {
    const dot = document.createElement('i');
    dot.className = `dot${gap >= threshold ? ' is-over' : gap <= -threshold ? ' is-under' : ''}${signal ? ' is-signal' : ''}`;
    dot.style.left = at(gap);
    plot.append(dot);
  }
  return plot;
}

/**
 * A small multiple: fair minus book by game minute, in deviations, on the same scale in every panel.
 * The thin line is every reading and the bold line is the three-minute rolling average the signal is judged on.
 * The shaded band is "no trade". Where the average leaves it, the space is filled, above for a book that is low and below for one that is high.
 */
export function trendPanel(host, d) {
  const W = Math.max(220, host.clientWidth || 300), H = 172, m = { t: 8, r: 44, b: 20, l: 30 }, thr = d.threshold, span = d.span || 2 * thr, unit = d.unit || '';
  const show = (v) => signed(v) + unit;
  const x = d3.scaleLinear([0, 40], [m.l, W - m.r]), y = d3.scaleLinear([-span, span], [H - m.b, m.t]).clamp(true);
  const pts = d.series, last = pts[pts.length - 1] || null;
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', last ? `${d.label}: fair minus book by game minute, in deviations` : `${d.label}: no line recorded`);
  // plot paper: a line every point and every five minutes
  svg.append('g').selectAll('line').data(d3.range(-span, span + 1)).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y).attr('stroke', 'var(--rule-soft)');
  svg.append('g').selectAll('line').data(d3.range(0, 41, 5)).join('line').attr('x1', x).attr('x2', x).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--rule-soft)');
  svg.append('rect').attr('x', m.l).attr('width', W - m.l - m.r).attr('y', y(thr)).attr('height', y(-thr) - y(thr)).attr('fill', 'var(--band)');
  for (const v of [-thr, 0, thr]) svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v)).attr('stroke', 'var(--rule-strong)');
  svg.append('line').attr('x1', x(20)).attr('x2', x(20)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--rule-strong)').attr('stroke-dasharray', '2 4');
  svg.append('g').selectAll('text').data([[thr, tick(thr)], [0, '0'], [-thr, tick(-thr)]]).join('text').attr('x', m.l - 6).attr('y', (v) => y(v[0])).attr('dy', '0.32em').attr('text-anchor', 'end').text((v) => v[1]);
  svg.append('g').selectAll('text').data([[0, 'Tip', 'start'], [20, 'Half', 'middle'], [40, 'Final', 'end']]).join('text').attr('x', (v) => x(v[0])).attr('y', H - 5).attr('text-anchor', (v) => v[2]).text((v) => v[1]);
  if (pts.length) {
    // thin line: every reading. Bold line: the rolling average the signal is judged on (falls back to a local mean if none is supplied).
    const hasAvg = pts.some((p) => p.avg != null);
    const bold = hasAvg ? pts.filter((p) => p.avg != null).map((p) => ({ t: p.t, gap: p.avg, off: !!p.off })) : pts.map((p) => ({ t: p.t, gap: d3.mean(pts.filter((q) => Math.abs(q.t - p.t) <= 1.5), (q) => q.gap) }));
    const joined = (rows) => (p, i) => i === 0 || p.t - rows[i - 1].t <= 3; // a break in the line where the recording has a hole
    svg.append('path').attr('d', d3.line().defined(joined(pts)).x((p) => x(p.t)).y((p) => y(p.gap))(pts)).attr('fill', 'none').attr('stroke', 'var(--rule-strong)').attr('stroke-width', 1).attr('stroke-linejoin', 'round');
    if (bold.length) {
      // Beyond the band: coloured where a signal can fire, grey where signals are off (a lopsided game or lead).
      // Readings are grouped into runs of one kind; each run starts from the reading before it so the fills meet.
      const runs = [];
      bold.forEach((p, i) => {
        const hole = i > 0 && p.t - bold[i - 1].t > 3, cur = runs[runs.length - 1];
        if (!cur || hole || cur.off !== !!p.off) runs.push({ off: !!p.off, rows: i > 0 && !hole ? [bold[i - 1], p] : [p] });
        else cur.rows.push(p);
      });
      for (const run of runs) {
        const fill = (colour) => (run.off ? 'var(--rule-strong)' : colour), xs = (p) => x(p.t);
        svg.append('path').attr('d', d3.area().x(xs).y0(y(thr)).y1((p) => y(Math.max(p.gap, thr)))(run.rows)).attr('fill', fill('var(--fair)')).attr('opacity', run.off ? 0.45 : 0.5);
        svg.append('path').attr('d', d3.area().x(xs).y0(y(-thr)).y1((p) => y(Math.min(p.gap, -thr)))(run.rows)).attr('fill', fill('var(--book)')).attr('opacity', run.off ? 0.45 : 0.5);
      }
      svg.append('path').attr('d', d3.line().defined(joined(bold)).x((p) => x(p.t)).y((p) => y(p.gap))(bold)).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
      const tone = (p) => (Math.abs(p.gap) < thr ? 'var(--ink)' : p.off ? 'var(--faint)' : p.gap > 0 ? 'var(--fair)' : 'var(--book)');
      const end = bold[bold.length - 1], peak = bold.reduce((b, p) => (Math.abs(p.gap) > Math.abs(b.gap) ? p : b), bold[0]);
      if (Math.abs(peak.gap) >= thr && !(end.t - peak.t < 1.5 && Math.abs(peak.gap - end.gap) < 0.05)) {
        svg.append('circle').attr('cx', x(peak.t)).attr('cy', y(peak.gap)).attr('r', 3).attr('fill', tone(peak));
        svg.append('text').attr('class', 'lbl').attr('x', Math.max(m.l + 14, Math.min(W - m.r - 14, x(peak.t)))).attr('y', y(peak.gap) + (peak.gap > 0 || y(peak.gap) + 15 > H - m.b - 3 ? -7 : 15)).attr('text-anchor', 'middle').style('fill', tone(peak)).text(show(peak.gap));
      }
      svg.append('g').selectAll('path').data(d.signals || []).join('path').attr('d', d3.symbol(d3.symbolTriangle, 60))
        .attr('transform', (s) => `translate(${x(s.minute)},${s.side === 'Over' ? H - m.b - 7 : m.t + 7}) rotate(${s.side === 'Over' ? 0 : 180})`).attr('fill', (s) => (s.side === 'Over' ? 'var(--fair)' : 'var(--book)'));
      svg.append('circle').attr('cx', x(end.t)).attr('cy', y(end.gap)).attr('r', 4.5).attr('fill', tone(end)).attr('stroke', 'var(--panel)').attr('stroke-width', 1.5);
      svg.append('text').attr('class', 'lbl').attr('x', W - m.r + 7).attr('y', y(end.gap)).attr('dy', '0.32em').style('fill', tone(end)).text(show(end.gap));
    }
  }
  host.replaceChildren(svg.node());
}

/** Every reading on the slate, fair minus book in deviations. The tails beyond the threshold are the ones that matter. */
export function histogram(host, gaps, { threshold = 2, span = 4, bin = 0.25 } = {}) {
  const W = Math.max(260, host.clientWidth || 360), H = 232, m = { t: 52, r: 6, b: 44, l: 6 };
  const x = d3.scaleLinear([-span, span], [m.l, W - m.r]);
  const bins = Array.from({ length: Math.round((2 * span) / bin) }, (_, i) => ({ v0: -span + i * bin, n: 0 }));
  for (const g of gaps) bins[Math.max(0, Math.min(bins.length - 1, Math.floor((g + span) / bin)))].n += 1;
  const y = d3.scaleLinear([0, d3.max(bins, (b) => b.n) || 1], [H - m.b, m.t]);
  const share = (test) => (gaps.length ? `${((100 * gaps.filter(test).length) / gaps.length).toFixed(1)}%` : '–');
  const high = share((g) => g <= -threshold), low = share((g) => g >= threshold);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', `Fair minus book in deviations across ${gaps.length} readings. The book was ${threshold} or more high on ${high} and ${threshold} or more low on ${low}.`);
  const bw = x(bin) - x(0);
  svg.append('g').selectAll('rect').data(bins.filter((b) => b.n)).join('rect')
    .attr('x', (b) => x(b.v0) + 1).attr('width', Math.max(1, bw - 2)).attr('y', (b) => y(b.n)).attr('height', (b) => H - m.b - y(b.n))
    .attr('fill', (b) => (b.v0 + bin <= -threshold ? 'var(--book)' : b.v0 >= threshold ? 'var(--fair)' : 'var(--rule-strong)'));
  svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', H - m.b).attr('y2', H - m.b).attr('stroke', 'var(--ink)');
  for (const v of [-threshold, threshold]) svg.append('line').attr('x1', x(v)).attr('x2', x(v)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--faint)').attr('stroke-dasharray', '3 4');
  svg.append('g').selectAll('text').data([-2 * threshold, -threshold, 0, threshold, 2 * threshold]).join('text').attr('x', x).attr('y', H - m.b + 17).attr('text-anchor', 'middle').text(tick);
  svg.append('text').attr('x', W / 2).attr('y', H - 4).attr('text-anchor', 'middle').text('Fair minus book, in deviations');
  svg.append('text').attr('class', 'big').attr('x', m.l).attr('y', 20).attr('fill', 'var(--book)').style('fill', 'var(--book)').text(high);
  svg.append('text').attr('x', m.l).attr('y', 38).text(`book ${threshold}+ deviations high`);
  svg.append('text').attr('class', 'big').attr('x', W - m.r).attr('y', 20).attr('text-anchor', 'end').style('fill', 'var(--fair)').text(low);
  svg.append('text').attr('x', W - m.r).attr('y', 38).attr('text-anchor', 'end').text(`book ${threshold}+ deviations low`);
  host.replaceChildren(svg.node());
}

/**
 * Two panes on one time axis: the projected final (book, fair, pregame) above the score flow.
 * The shaded band around fair is the signal distance: when the book's line leaves it, the gap is big enough to matter.
 * A crosshair runs through both and reports through onScrub; nothing floats over the chart.
 */
export function gameChart(host, d) {
  const W = Math.max(300, host.clientWidth), narrow = W < 620;
  const topH = narrow ? 220 : 280, botH = narrow ? 140 : 170, gap = 52;
  const m = { t: 26, r: narrow ? 46 : 104, b: 24, l: 34 }, H = m.t + topH + gap + botH + m.b;
  const x = d3.scaleLinear([0, 40], [m.l, W - m.r]);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', 'Projected final by game minute, with the score flow underneath');
  const name = (label, value) => (narrow ? value : `${label} ${value}`);

  // ---- top pane: projected final
  const vals = [d.pregame, ...d.fair.map((p) => p.v), ...d.book.map((p) => p.v)].concat(d.final == null ? [] : [d.final]);
  const lo = d3.min(vals), hi = d3.max(vals), pad = Math.max(3, (hi - lo) * 0.12);
  const y = d3.scaleLinear([lo - pad, hi + pad], [m.t + topH, m.t]);
  const yt = y.ticks(5);
  svg.append('text').attr('class', 'ttl').attr('x', m.l).attr('y', 12).text('Projected final');
  svg.append('g').selectAll('line').data(yt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y).attr('stroke', 'var(--rule-soft)');
  svg.append('g').selectAll('text').data(yt).join('text').attr('x', m.l - 7).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text((v) => v);
  const clip = `clip-${Math.random().toString(36).slice(2, 8)}`;
  svg.append('clipPath').attr('id', clip).append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', topH);
  const top = svg.append('g').attr('clip-path', `url(#${clip})`);
  if (d.fair.length && d.fair[0].band != null) top.append('path').attr('d', d3.area().x((p) => x(p.t)).y0((p) => y(p.v - p.band)).y1((p) => y(p.v + p.band))(d.fair)).attr('fill', 'var(--band)');
  top.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(d.pregame)).attr('y2', y(d.pregame)).attr('stroke', 'var(--faint)').attr('stroke-width', 1.5).attr('stroke-dasharray', '6 5');
  for (let i = 0; i + 1 < d.book.length; i += 1) { // the space between book and fair, tinted by which number is higher
    const a = d.book[i], b = d.book[i + 1];
    if (b.t <= a.t || b.t - a.t > 3) continue;
    top.append('path').attr('d', `M${x(a.t)},${y(a.v)}L${x(b.t)},${y(a.v)}L${x(b.t)},${y(b.fair)}L${x(a.t)},${y(a.fair)}Z`).attr('fill', a.fair >= a.v ? 'var(--fair)' : 'var(--book)').attr('opacity', 0.13);
  }
  top.append('path').attr('d', d3.line().x((p) => x(p.t)).y((p) => y(p.v))(d.fair)).attr('fill', 'none').attr('stroke', 'var(--fair)').attr('stroke-width', 2.25).attr('stroke-linejoin', 'round');
  top.append('path').attr('d', d3.line().defined((p, i) => i === 0 || p.t - d.book[i - 1].t <= 3).curve(d3.curveStepAfter).x((p) => x(p.t)).y((p) => y(p.v))(d.book)).attr('fill', 'none').attr('stroke', 'var(--book)').attr('stroke-width', 2.25);
  svg.append('g').selectAll('path').data(d.signals).join('path').attr('d', d3.symbol(d3.symbolTriangle, 80))
    .attr('transform', (s) => `translate(${x(s.minute)},${y(s.line) + (s.side === 'Over' ? 13 : -13)}) rotate(${s.side === 'Over' ? 0 : 180})`)
    .attr('fill', (s) => (s.side === 'Over' ? 'var(--fair)' : 'var(--book)')).attr('stroke', 'var(--panel)');
  // each signal named where it fired: the side and the line it was logged at
  // An over is named below its marker and an under above. The name goes to the right of an over and the left of an under,
  // so two that fire together stay apart, unless the lines are still being drawn there (a signal a few minutes old in a
  // live game) or there is no room: then it goes to the left, over what has already happened.
  const lastX = d.book.length ? x(d.book[d.book.length - 1].t) : m.l, tagW = 80;
  const tags = d.signals.map((s) => {
    const sx = x(s.minute), over = s.side === 'Over';
    const right = over ? sx + tagW <= W - m.r && (d.final != null || lastX - sx > tagW + 10) && sx + tagW <= W - m.r : sx - tagW < m.l;
    return { s, right, x: sx + (right ? 9 : -9), y: Math.max(m.t + 10, Math.min(m.t + topH - 6, y(s.line) + (over ? 27 : -19))) };
  });
  if (tags.length === 2 && tags[0].right === tags[1].right && Math.abs(tags[0].x - tags[1].x) < tagW && Math.abs(tags[0].y - tags[1].y) < 14) {
    const [hi, lo] = tags[0].y <= tags[1].y ? tags : [tags[1], tags[0]];
    lo.y = Math.min(m.t + topH - 6, hi.y + 14); if (lo.y - hi.y < 14) hi.y = lo.y - 14;
  }
  const ends = [{ y: y(d.pregame), x: W - m.r, text: name('Pregame', f1(d.pregame)), fill: 'var(--sub)', dot: null }];
  if (d.fair.length && d.final == null) { const p = d.fair[d.fair.length - 1]; ends.push({ y: y(p.v), x: x(p.t), text: name('Fair', f1(p.v)), fill: 'var(--fair)', dot: 'var(--fair)' }); }
  if (d.book.length) { const p = d.book[d.book.length - 1]; ends.push({ y: y(p.v), x: x(p.t), text: name('Book', f1(p.v)), fill: 'var(--book)', dot: 'var(--book)' }); }
  if (d.final != null) {
    svg.append('rect').attr('x', x(40) - 4).attr('y', y(d.final) - 4).attr('width', 8).attr('height', 8).attr('fill', 'var(--ink)');
    ends.push({ y: y(d.final), x: x(40), text: name('Final', String(d.final)), fill: 'var(--ink)', dot: null });
  }
  for (const e of ends) if (e.dot) svg.append('circle').attr('cx', e.x).attr('cy', e.y).attr('r', 4).attr('fill', e.dot).attr('stroke', 'var(--panel)').attr('stroke-width', 1.5);
  ends.sort((a, b) => a.y - b.y).forEach((e, i, arr) => { if (i && e.y - arr[i - 1].y < 15) e.y = arr[i - 1].y + 15; });
  for (const e of ends) svg.append('text').attr('class', 'lbl').attr('x', W - m.r + 9).attr('y', e.y).attr('dy', '0.32em').style('fill', e.fill).text(e.text);
  // drawn last, over the lines and their end dots
  svg.append('g').selectAll('text').data(tags).join('text').attr('class', 'lbl sig').attr('text-anchor', (t) => (t.right ? 'start' : 'end')).attr('x', (t) => t.x).attr('y', (t) => t.y)
    .style('fill', (t) => (t.s.side === 'Over' ? 'var(--fair)' : 'var(--book)')).text((t) => `${t.s.side} ${f1(t.s.line)}`);

  // ---- bottom pane: score flow against pregame pace
  const by0 = m.t + topH + gap;
  svg.append('text').attr('class', 'ttl').attr('x', m.l).attr('y', by0 - 14).text('Score, with the pregame pace dashed');
  const maxPts = Math.max(d.preAway, d.preHome, d3.max(d.flow, (p) => Math.max(p.a, p.h)) || 0) * 1.06;
  const yb = d3.scaleLinear([0, maxPts], [by0 + botH, by0]);
  const ybt = yb.ticks(3);
  svg.append('g').selectAll('line').data(ybt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yb).attr('y2', yb).attr('stroke', 'var(--rule-soft)');
  svg.append('g').selectAll('text').data(ybt).join('text').attr('x', m.l - 7).attr('y', yb).attr('dy', '0.32em').attr('text-anchor', 'end').text((v) => v);
  for (const [k, total, colour] of [['a', d.preAway, 'var(--away)'], ['h', d.preHome, 'var(--home)']]) {
    svg.append('path').attr('d', d3.line().x((s) => x(s[0])).y((s) => yb(total * s[1]))(d.share)).attr('fill', 'none').attr('stroke', colour).attr('stroke-width', 1.25).attr('stroke-dasharray', '4 4').attr('opacity', 0.7);
    svg.append('path').attr('d', d3.line().curve(d3.curveStepAfter).x((p) => x(p.t)).y((p) => yb(p[k]))(d.flow)).attr('fill', 'none').attr('stroke', colour).attr('stroke-width', 2);
  }
  const lastFlow = d.flow[d.flow.length - 1];
  const fl = [{ y: yb(lastFlow.a), text: name(d.awayName || '', String(lastFlow.a)), fill: 'var(--away)' }, { y: yb(lastFlow.h), text: name(d.homeName || '', String(lastFlow.h)), fill: 'var(--home)' }].sort((a, b) => a.y - b.y);
  if (fl[1].y - fl[0].y < 15) fl[1].y = fl[0].y + 15;
  for (const e of fl) svg.append('text').attr('class', 'lbl').attr('x', W - m.r + 9).attr('y', e.y).attr('dy', '0.32em').style('fill', e.fill).text(e.text.trim());

  // ---- shared axis and crosshair
  for (const yy of [m.t + topH, by0 + botH]) svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', yy).attr('y2', yy).attr('stroke', 'var(--rule-strong)');
  for (const [a, b] of [[m.t, m.t + topH], [by0, by0 + botH]]) svg.append('line').attr('x1', x(20)).attr('x2', x(20)).attr('y1', a).attr('y2', b).attr('stroke', 'var(--rule-strong)').attr('stroke-dasharray', '2 4');
  svg.append('g').selectAll('text').data([[0, 'Tip'], [10, '10 min'], [20, 'Half'], [30, '30 min'], [40, 'Final']]).join('text')
    .attr('x', (v) => x(v[0])).attr('y', H - 6).attr('text-anchor', (v, i) => (i === 0 ? 'start' : i === 4 ? 'end' : 'middle')).text((v) => (narrow && v[0] % 20 ? '' : v[1]));
  const hair = svg.append('line').attr('y1', m.t).attr('y2', by0 + botH).attr('stroke', 'var(--ink)').attr('opacity', 0.45).style('display', 'none');
  const nearest = (rows, t) => rows.reduce((best, r) => (best == null || Math.abs(r.t - t) < Math.abs(best.t - t) ? r : best), null);
  const at = (ev) => {
    const t = Math.max(0, Math.min(40, x.invert(d3.pointer(ev, svg.node())[0])));
    const book = nearest(d.book, t), fair = nearest(d.fair, t), pace = nearest(d.pace, t);
    const useBook = book && Math.abs(book.t - t) <= 1.5;
    const tt = useBook ? book.t : fair ? fair.t : t;
    const past = d.flow.filter((p) => p.t <= tt), score = past.length ? past[past.length - 1] : d.flow[0];
    hair.attr('x1', x(tt)).attr('x2', x(tt)).style('display', null);
    d.onScrub({ t: tt, a: score.a, h: score.h, book: useBook ? book.v : null, fair: useBook ? book.fair : fair ? fair.v : null, pace: pace && Math.abs(pace.t - tt) <= 1.5 ? pace.v : null });
  };
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', topH + gap + botH).attr('fill', 'transparent')
    .on('pointermove pointerdown', at).on('pointerleave', () => { hair.style('display', 'none'); d.onScrub(null); });
  host.replaceChildren(svg.node());
}

/**
 * Cumulative units, signal by signal. steps: [{ all, date }] in the order the signals fired, with `totals` beside it when
 * a second, thinner line is wanted. A dashed rule marks where each slate begins.
 */
export function unitsChart(host, steps, { dayLabel = (d) => d } = {}) {
  const W = Math.max(300, host.clientWidth), narrow = W < 620, H = narrow ? 220 : 260, two = steps.some((s) => s.totals != null), m = { t: 14, r: two ? (narrow ? 120 : 132) : 56, b: 26, l: 34 };
  const n = steps.length, pts = [{ i: 0, all: 0, totals: 0 }].concat(steps.map((s, i) => ({ i: i + 1, all: s.all, totals: two ? s.totals : s.all })));
  const lo = Math.min(0, d3.min(pts, (p) => Math.min(p.all, p.totals))), hi = Math.max(0, d3.max(pts, (p) => Math.max(p.all, p.totals))), pad = Math.max(1, (hi - lo) * 0.12);
  const x = d3.scaleLinear([0, n], [m.l, W - m.r]), y = d3.scaleLinear([lo - pad, hi + pad], [H - m.b, m.t]);
  const end = pts[n];
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', `Cumulative units over ${n} settled signals: ${signed(end.all)}${two ? ` on all of them, ${signed(end.totals)} on game totals alone` : ''}.`);
  const yt = y.ticks(5);
  svg.append('g').selectAll('line').data(yt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y).attr('stroke', (v) => (v === 0 ? 'var(--rule-strong)' : 'var(--rule-soft)'));
  svg.append('g').selectAll('text').data(yt).join('text').attr('x', m.l - 7).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text(tick);
  // where each slate begins; with many slates only as many are named as fit
  const starts = steps.map((s, i) => ({ i, date: s.date })).filter((s, k, arr) => k === 0 || s.date !== steps[s.i - 1].date);
  let named = -Infinity; // a slate is named only where its name clears the one before it
  for (const s of starts) {
    if (s.i) svg.append('line').attr('x1', x(s.i)).attr('x2', x(s.i)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--rule-strong)').attr('stroke-dasharray', '2 4');
    if (x(s.i) - named < 58 || x(s.i) + 44 > W - m.r) continue;
    svg.append('text').attr('x', x(s.i)).attr('y', H - 7).attr('text-anchor', 'start').text(dayLabel(s.date));
    named = x(s.i);
  }
  const line = (key) => d3.line().curve(d3.curveStepAfter).x((p) => x(p.i)).y((p) => y(p[key]))(pts);
  if (two) svg.append('path').attr('d', line('totals')).attr('fill', 'none').attr('stroke', 'var(--faint)').attr('stroke-width', 1.25);
  svg.append('path').attr('d', line('all')).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 2.25).attr('stroke-linejoin', 'round');
  const ends = (two ? [{ y: y(end.all), text: `${narrow ? 'All' : 'All signals'} ${signed(end.all)}`, fill: 'var(--ink)' }, { y: y(end.totals), text: `Game totals ${signed(end.totals)}`, fill: 'var(--faint)' }]
    : [{ y: y(end.all), text: signed(end.all), fill: 'var(--ink)' }]).sort((a, b) => a.y - b.y);
  if (two && ends[1].y - ends[0].y < 16) ends[1].y = ends[0].y + 16;
  svg.append('circle').attr('cx', x(n)).attr('cy', y(end.all)).attr('r', 4).attr('fill', 'var(--ink)').attr('stroke', 'var(--panel)').attr('stroke-width', 1.5);
  for (const e of ends) svg.append('text').attr('class', 'lbl').attr('x', W - m.r + 9).attr('y', e.y).attr('dy', '0.32em').style('fill', e.fill).text(e.text);
  host.replaceChildren(svg.node());
}

export const fmt = { f1, signed };

/**
 * A game's three-minute average since the tip, small enough to sit in a table row. The rule's mark is drawn on both
 * sides so a line that crosses it reads at a glance; the dot is where the average stands now, and an upright line marks
 * the minute a signal was logged. Colour comes from the row.
 */
export function sparkline(points, { threshold = 2, from = 0, to = 40, w = 124, ht = 30, label = '', marks = [] } = {}) {
  const span = threshold * 1.6, x = (t) => 1 + ((Math.min(to, Math.max(from, t)) - from) / (to - from)) * (w - 5), y = (v) => ht / 2 - (Math.max(-span, Math.min(span, v)) / span) * (ht / 2 - 2);
  const svg = d3.create('svg').attr('viewBox', `0 0 ${w} ${ht}`).attr('class', 'spark').attr('role', 'img').attr('aria-label', label);
  svg.append('line').attr('class', 'sp-0').attr('x1', 0).attr('x2', w).attr('y1', y(0)).attr('y2', y(0));
  for (const v of [threshold, -threshold]) svg.append('line').attr('class', 'sp-t').attr('x1', 0).attr('x2', w).attr('y1', y(v)).attr('y2', y(v));
  for (const t of marks) svg.append('line').attr('class', 'sp-m').attr('x1', x(t)).attr('x2', x(t)).attr('y1', 0).attr('y2', ht); // the minute a signal was logged
  if (points.length) {
    // a break of more than three minutes between readings is a gap in the recording, not a straight line
    const parts = []; let cur = [];
    for (const p of points) { if (cur.length && p.t - cur[cur.length - 1].t > 3) { parts.push(cur); cur = []; } cur.push(p); }
    parts.push(cur);
    for (const part of parts) svg.append('path').attr('class', 'sp-l').attr('d', d3.line().x((p) => x(p.t)).y((p) => y(p.v))(part));
    const end = points[points.length - 1];
    svg.append('circle').attr('class', 'sp-e').attr('cx', x(end.t)).attr('cy', y(end.v)).attr('r', 2.6);
  }
  return svg.node();
}

/**
 * The record signal by signal: the running balance in units as a stepped line, a dot for each signal (filled for a win,
 * open for a loss), a dotted line where each slate begins and a solid one where the rule changed. `onPick(step, n)` is
 * called with the signal under the pointer or the finger, and with null when it leaves.
 */
export function recordChart(host, steps, { dayLabel = (d) => d, marks = [], onPick = null } = {}) {
  const W = Math.max(300, host.clientWidth), narrow = W < 620, H = narrow ? 230 : 290, m = { t: 14, r: 54, b: 26, l: 34 };
  const n = steps.length, pts = [{ i: 0, all: 0 }].concat(steps.map((s, i) => ({ ...s, i: i + 1 })));
  const lo = Math.min(0, d3.min(pts, (p) => p.all)), hi = Math.max(0, d3.max(pts, (p) => p.all)), pad = Math.max(1, (hi - lo) * 0.12);
  const x = d3.scaleLinear([0, n], [m.l, W - m.r]), y = d3.scaleLinear([lo - pad, hi + pad], [H - m.b, m.t]), end = pts[n];
  const svg = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', `Cumulative units over ${n} graded signals: ${signed(end.all)}.`);
  const yt = y.ticks(5);
  svg.append('g').selectAll('line').data(yt).join('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y).attr('y2', y).attr('stroke', (v) => (v === 0 ? 'var(--rule-strong)' : 'var(--rule-soft)'));
  svg.append('g').selectAll('text').data(yt).join('text').attr('x', m.l - 7).attr('y', y).attr('dy', '0.32em').attr('text-anchor', 'end').text(tick);
  const starts = steps.map((s, i) => ({ i, date: s.date })).filter((s, k) => k === 0 || s.date !== steps[s.i - 1].date), ruled = new Set(marks.map((k) => k.i));
  let named = -Infinity;
  for (const s of starts) {
    if (s.i && !ruled.has(s.i)) svg.append('line').attr('x1', x(s.i)).attr('x2', x(s.i)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--rule-strong)').attr('stroke-dasharray', '1 4');
    if (x(s.i) - named < 58 || x(s.i) + 44 > W - m.r) continue;
    svg.append('text').attr('x', x(s.i)).attr('y', H - 7).attr('text-anchor', 'start').text(dayLabel(s.date));
    named = x(s.i);
  }
  for (const k of marks) svg.append('line').attr('x1', x(k.i)).attr('x2', x(k.i)).attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--ink)').attr('stroke-width', 1);
  svg.append('path').attr('d', d3.line().curve(d3.curveStepAfter).x((p) => x(p.i)).y((p) => y(p.all))(pts)).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.5).attr('stroke-linejoin', 'miter');
  const r = Math.max(1.6, Math.min(3.2, (W - m.l - m.r) / n / 2.6));
  svg.append('g').selectAll('circle').data(pts.slice(1)).join('circle').attr('cx', (p) => x(p.i)).attr('cy', (p) => y(p.all)).attr('r', r)
    .attr('fill', (p) => (p.result === 'Won' ? 'var(--ink)' : p.result === 'Lost' ? 'var(--panel)' : 'var(--rule-strong)')).attr('stroke', 'var(--ink)').attr('stroke-width', 1);
  svg.append('text').attr('class', 'lbl').attr('x', W - m.r + 9).attr('y', y(end.all)).attr('dy', '0.32em').style('fill', 'var(--ink)').text(signed(end.all));
  // one hit area for the whole plot: the nearest signal answers, so a finger does not have to land on a three-pixel dot
  const cross = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--ink)').attr('stroke-width', 0.75).attr('visibility', 'hidden');
  const ring = svg.append('circle').attr('r', r + 3).attr('fill', 'none').attr('stroke', 'var(--ink)').attr('stroke-width', 1.5).attr('visibility', 'hidden');
  const at = (ev) => { const [px] = d3.pointer(ev, svg.node()); return Math.max(1, Math.min(n, Math.round(x.invert(px)))); };
  const show = (i) => { const p = pts[i]; cross.attr('x1', x(i)).attr('x2', x(i)).attr('visibility', 'visible'); ring.attr('cx', x(i)).attr('cy', y(p.all)).attr('visibility', 'visible'); if (onPick) onPick(steps[i - 1], i); };
  const hide = () => { cross.attr('visibility', 'hidden'); ring.attr('visibility', 'hidden'); if (onPick) onPick(null, 0); };
  svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', H - m.t - m.b).attr('fill', 'transparent').style('cursor', 'crosshair')
    .on('pointermove', (ev) => show(at(ev))).on('pointerdown', (ev) => show(at(ev))).on('pointerleave', (ev) => { if (ev.pointerType === 'mouse') hide(); });
  host.replaceChildren(svg.node());
}
