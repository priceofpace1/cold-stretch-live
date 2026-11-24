#!/usr/bin/env python3
"""Records live college basketball scores and DraftKings live lines (as published by ESPN) every 30 seconds,
writes one track file per slate date, and keeps a ledger of model signals with their results.

  python recorder/record.py --out store --minutes 335          # live recorder (used by the GitHub Action)
  python recorder/record.py --out store --import-jsonl f.jsonl  # convert an older raw capture
  python recorder/record.py --out store --rebuild               # re-judge every stored slate with the current rules

Standard library only. ESPN's endpoints are unofficial and can change without notice.
"""
import argparse, bisect, datetime, json, os, subprocess, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SB = "https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=%s&groups=50&limit=400&_=%d"
OD = "https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/events/%s/competitions/%s/odds?limit=20&_=%d"
# Thresholds are in deviations: (fair minus book) / (yardstick x the model's rest-of-game standard deviation at that minute).
# The signal: the three-minute rolling average of (fair minus book) is BUY_DEV deviations from zero, at a price the chance clears.
# One deviation is the standard deviation of that average, in points, measured on completed slates (about 1.2 for a game total).
# It does not shrink as the game runs out; what a point is worth does, and the chance test covers that.
# Readings from minute A0 feed the average; signals fire between minutes T0 and T1.
BUY_DEV, MARGIN, A0, T0, T1, BLOW_LEAD, BLOW_SPREAD = 2.0, 0.05, 2, 4, 34, 15, 20
WINDOW, CARRY = 180, 60   # seconds averaged; how old the reading before the window may be and still be carried into the average
# An average exists only when the window itself holds this many readings and they reach back over all but 30 seconds of
# it. One fresh reading and a stale one carried forward are not a three-minute average: a page that had just opened used
# to fire on exactly that.
MIN_READINGS = 3
# A signal waits for its gap to hold: the average must stay BUY_DEV deviations out, on one side, at every judged reading for
# HOLD seconds (less HOLD_SLACK, since readings are not exactly 30 seconds apart). A hole of RUN_BREAK seconds in the
# readings starts the count again. On the slates recorded through November 24, signals that had held two minutes won 22 of
# 31; the rule's other signals were close to break-even.
HOLD, HOLD_SLACK, RUN_BREAK = 120, 15, 150
STALL_SEC, STALL_PTS, STALL_LINE, JUMP_SEC, JUMP_MIN = 300, 4, 4.0, 150, 3.0   # the score feed is taken as stalled past these (see stalled_at)
# Seconds between stored readings: every 30-second poll is kept, changed or not. A stretch with no readings then always
# means the line was not being read, never that nothing moved, and halftime is a run of readings like any other.
EVERY = 25
MARKETS = ('total',)   # a signal fires on the game total alone, the one market with a posted line and price
LATER = (30, 60, 120)   # seconds after a signal at which the line a late bettor would have found is logged
M0, M1, MIN_YARD_READINGS = 4, 34, 300
# Every rule is run on every slate so the choice can be judged on results:
# (id, deviations, seconds averaged (0 = a single reading), deviations the previous reading must already show (None = not needed)).
VARIANTS = (('signal', BUY_DEV, WINDOW, None), ('avg3-1.5', 1.5, WINDOW, None), ('avg3-2.5', 2.5, WINDOW, None), ('avg3-3', 3.0, WINDOW, None),
            ('avg2-2', 2.0, 120, None), ('avg5-2', 2.0, 300, None), ('one-2', 2.0, 0, None), ('one-3', 3.0, 0, None), ('one-2-after-1.5', 2.0, 0, 1.5))
SHADOW = ('lopsided', BUY_DEV, WINDOW, None)   # the signal, judged only where it is switched off (wide spread or big lead): tracked, not counted
# Ideas under test: each is the signal with one thing changed, tracked beside the record and never in it.
# (name, extra arguments for signals_for, filter on the signals it returns)
IDEAS = (('signal-teams', {'markets': ('away', 'home')}, None),           # team totals, dropped on November 22: implied lines at an assumed price
         ('signal-to-38', {'last': 38}, None),                             # the rule before November 22: signals through minute 38
         ('signal-unguarded', {'guard': False}, None),                     # the rule before November 25: readings on a stalled score feed judged too
         ('signal-at-once', {'hold': 0}, None),                            # the rule before November 25: logged the moment the average reaches two deviations
         ('signal-2.25', {'k': 2.25}, None),                               # the hold at 2.25 deviations
         ('signal-hold-3', {'hold': 180}, None),                           # a three-minute hold
         ('signal-repeat', {'again': 1.0}, None),                          # let a market fire again after its gap has closed
         ('cold-over', {}, lambda s: s['spot'] == 'Cold spot'),            # the original thesis: the over when scoring is well behind pace
         ('cold-over-lopsided', {'lopsided': True}, lambda s: s['spot'] == 'Cold spot'))
STAGES = (('all', 0, 41), ('4 to 20', 0, 20), ('20 to 34', 20, 34), ('34 to 38', 34, 41))
RULES_VERSION = '2026-11-25.1'   # change this whenever a rule, window or variant changes, and add it to RULE_STARTS
# The first slate each rule was scored live on, oldest first. A slate scored live keeps the signals logged that day for
# good: when the rule changes they are settled and annotated, never judged again. Slates from before the first entry
# were recorded before the record began and are judged again under the current rule, after the fact.
RULE_STARTS = (('20261119', '2026-11-19.2', 'A signal must still carry its edge on the quote showing when it fires, not only on the three-minute average.'),
               ('20261122', '2026-11-22.1', 'Signals stop at minute 34, not 38: the model knows nothing of fouling and clock play. An average needs three readings of its own covering two and a half minutes, and the recorder keeps a reading every 30 seconds. Team totals are dropped: their lines were implied from the total and spread, and their price was an estimate.'),
               ('20261125', '2026-11-25.1', 'No signal on a stalled score feed: when the game clock has stood for five minutes, when four points have gone up or the sportsbook total has moved four points while it stood, or when a game is first seen already standing still. Signals logged on such readings before this date are marked and left out of the headline record. A signal now waits for its gap to hold: the three-minute average must stay two deviations out for a further two minutes, and the signal is logged at the line and price showing then. On the slates recorded through November 24, signals that had held two minutes won 22 of 31, and the others were close to break-even.'))
def rule_of(date):
    """The rule a slate was scored live under, or None for a slate from before the record began."""
    return next((v for d, v, _ in reversed(RULE_STARTS) if date >= d), None)
MODEL = json.load(open(os.path.join(ROOT, 'model.json')))
ROWS = {r['minute']: r for r in MODEL['rows']}; CDF = MODEL['cdf']; YARD = {k: MODEL['yardstick'][k] for k in ('total', 'team')}

def get(u):
    with urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=15) as r:
        return json.load(r)
def num(x):
    try: return float(x)
    except Exception: return None
def coef(t):
    t = min(38, max(2, t)); lo = min(37, int(t)); w = t - lo; a, b = ROWS[lo], ROWS[lo + 1]
    return {k: a[k] + (b[k] - a[k]) * w for k in a}
def rest(c, tt0, ott0, p, o):
    e = tt0 * c['share']; short = e - p; osh = ott0 * c['share'] - o; lead = p - o
    r = (c['b0'] + c['b_erem'] * (tt0 - e) + c['b_short'] * short + c['b_oshort'] * osh + c['b_lead'] * max(lead, 0)
         + c['b_trail'] * max(-lead, 0) + c['b_lead12'] * max(lead - 12, 0) + c['b_trail12'] * max(-lead - 12, 0))
    return max(0, r), short
def fair(total, hsp, t, a, h):
    """total, hsp = closing total and home spread (negative = home favoured); a, h = away and home points at elapsed minute t."""
    ht0 = total / 2 - hsp / 2; at0 = total / 2 + hsp / 2; c = coef(t); k = 1.0 if t <= 38 else max(0, (40 - t) / 2)
    hr, hshort = rest(c, ht0, at0, h, a); ar, ashort = rest(c, at0, ht0, a, h)
    return dict(fh=h + hr * k, fa=a + ar * k, hshort=hshort, ashort=ashort, sd_team=c['sd_team'], sd_total=c['sd_total'])
def cdf(z):
    zs = [r[0] for r in CDF]
    if z <= zs[0]: return CDF[0][1]
    if z >= zs[-1]: return CDF[-1][1]
    i = bisect.bisect_right(zs, z); a, b = CDF[i - 1], CDF[i]
    return a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0])
def break_even(price):
    """The win rate an American price needs to break even: -110 needs 52.4%."""
    return -price / (-price + 100) if price < 0 else 100 / (price + 100)
def units(price): return 100 / -price if price < 0 else price / 100
def rolled(g, window=WINDOW, guard=True):
    """Every reading with a line from minute A0 on, with each market's gap (fair minus book) averaged over the last
    `window` seconds: the readings inside the window plus the one just before it, carried forward. `avg` is None until
    the window holds MIN_READINGS readings reaching back over most of it. window=0 gives the single reading. Markets are
    total, away, home.
    `stalled` marks a reading taken while the score feed was not following the game (see stalled_at). Such a reading has
    no average and empties the window, so nothing is judged on it and the average starts again once the feed moves."""
    out = []; hist = []; tot, hsp = g['pre']; cover = max(0, window - 30); run = None; prev = None
    for ts, t, a, h, bt, bs, op, up in g['r']:
        # Every reading keeps the clock's history, with a line or without one, so a game followed from the tip is known
        # to have been moving before its first live line appears.
        if run is None or abs(t - run['t']) > 1e-6:   # the clock has moved: a new run of readings at one game minute begins
            run = dict(t=t, ts=ts, pts=a + h, lo=None, hi=None, seen=prev is not None and ts - prev[0] <= JUMP_SEC and -0.5 <= t - prev[1] <= JUMP_MIN)
        prev = (ts, t)
        if bt is not None: run['lo'] = bt if run['lo'] is None else min(run['lo'], bt); run['hi'] = bt if run['hi'] is None else max(run['hi'], bt)
        if bt is None or bs is None or t < A0: continue
        f = fair(tot, hsp, t, a, h)
        gaps = (f['fa'] + f['fh'] - bt, f['fa'] - (bt / 2 + bs / 2), f['fh'] - (bt / 2 - bs / 2))
        if guard and stalled_at(run, ts, t, a + h):
            hist = []; out.append(dict(ts=ts, t=t, a=a, h=h, bt=bt, bs=bs, op=op, up=up, f=f, gaps=gaps, avg=None, stalled=True)); continue
        hist.append((ts, gaps))
        first = next(i for i, x in enumerate(hist) if ts - x[0] <= window)
        carried = window > 0 and first > 0 and (ts - window) - hist[first - 1][0] <= CARRY
        use = hist[first - 1 if carried else first:]
        ready = window == 0 or (len(hist) - first >= MIN_READINGS and ts - hist[first][0] >= cover)
        hist = hist[max(0, first - 1):]
        avg = tuple(sum(x[1][i] for x in use) / len(use) for i in range(3)) if ready else None
        out.append(dict(ts=ts, t=t, a=a, h=h, bt=bt, bs=bs, op=op, up=up, f=f, gaps=gaps, avg=avg, stalled=False))
    return out
def stalled_at(run, ts, t, pts):
    """Whether a reading was taken on a score feed that had stopped following the game. `run` is the stretch of readings
    at one game minute that this reading belongs to: when it began, the points then, and whether the clock was seen to
    tick into it (`seen`: the reading before was at most JUMP_SEC seconds and JUMP_MIN game minutes earlier), and the
    lowest and highest sportsbook total read in it. Four signs, none of them at halftime: the clock has stood for
    STALL_SEC seconds, longer than an ordinary stoppage; STALL_PTS points have gone up while it stood; the sportsbook's
    total has moved STALL_LINE points while it stood, so the book is following a game the feed is not showing; or the
    stretch began with no reading just before it, so the game was first seen, or seen again after a hole, already
    standing still."""
    if abs(t - 20) < 1e-6 or t >= 40: return False
    return (ts - run['ts'] >= STALL_SEC or pts - run['pts'] >= STALL_PTS or (run['lo'] is not None and run['hi'] - run['lo'] >= STALL_LINE)
            or (not run['seen'] and ts > run['ts']))
def devs_of(g):
    """For every reading where a signal could fire (inside the measuring window, three-minute average available, not a
    lopsided game): the averaged total, away and home gaps in points, and the single-reading total gap. The yardstick and
    the daily summary are measured on these, so one deviation describes the games the rule is actually applied to."""
    if not g.get('pre') or abs(g['pre'][1]) >= BLOW_SPREAD: return []
    return [(r['avg'][0], r['avg'][1], r['avg'][2], r['gaps'][0])
            for r in rolled(g) if r['avg'] is not None and M0 <= r['t'] <= M1 and abs(r['a'] - r['h']) < BLOW_LEAD]
def sd(xs):
    m = sum(xs) / len(xs); return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5
def yardstick(out, before):
    """One deviation: the standard deviation, in points, of the three-minute average gap, from every slate recorded
    before `before` (so a slate is never judged with its own data). Falls back to model.json until enough readings exist."""
    tot, team, slates = [], [], []
    tdir = os.path.join(out, 'tracks')
    for name in sorted(os.listdir(tdir)) if os.path.isdir(tdir) else []:
        if not name.endswith('.json') or name[:-5] >= before: continue
        try: games = json.load(open(os.path.join(tdir, name)))['games']
        except Exception: continue
        rows = [d for g in games for d in devs_of(g)]
        if rows: slates.append(name[:-5]); tot += [d[0] for d in rows]; team += [d[1] for d in rows] + [d[2] for d in rows]
    if len(tot) < MIN_YARD_READINGS: return dict(YARD, unit='points', source='model.json')
    return dict(total=round(sd(tot), 3), team=round(sd(team), 3), unit='points', readings=len(tot), slates=len(slates), through=slates[-1], source='recorded')
def elapsed(period, clock):
    try:
        mm, ss = str(clock).split(':'); left = int(mm) + float(ss) / 60
    except Exception:
        left = (num(clock) or 0) / 60
    return 40.0 if (period or 0) >= 3 else ((period or 1) - 1) * 20 + (20 - left)
def slate_date(now=None):
    """ESPN files late tips under the US Eastern date they started on; a slate rolls over at 5 AM Eastern."""
    now = now or datetime.datetime.now(datetime.timezone.utc)
    return (now - datetime.timedelta(hours=10)).strftime('%Y%m%d')

def signals_for(g, yard=None, k=BUY_DEV, window=WINDOW, arm=None, lopsided=False, again=None, last=T1, markets=MARKETS, guard=True, hold=HOLD):
    """First reading per market and side whose averaged gap has sat k deviations from zero for `hold` seconds, at a price
    the chance clears on that reading. hold=0 fires on the first reading at k, the rule before November 25.
    arm: if given, the reading before it must already have been that many deviations out on the same side.
    Signals are off in lopsided spots (a pregame spread of BLOW_SPREAD or a lead of BLOW_LEAD). lopsided=True judges only
    those spots instead: it is kept beside the record, never in it, to show what leaving them out costs or saves.
    again: if given, a market and side that has fired may fire once more after its average has come back inside that many
    deviations or crossed to the other side. Left out, each market and side fires once a game.
    last: the last elapsed minute a signal may fire at.
    markets: the markets a signal may fire in. The rule is the game total alone; team totals are kept as a comparison.
    Team totals, where asked for, are implied from the live total and spread and priced at an estimate.
    guard: False judges readings taken on a stalled score feed as well (see stalled_at), kept as a comparison."""
    yard = yard or YARD
    if not g.get('pre'): return []
    tot, hsp = g['pre']; out = []; fired = set(); count = {}; fin = g.get('final'); prev_ok = {}; wide = abs(hsp) >= BLOW_SPREAD; since = {}; last_ts = None
    if wide and not lopsided: return []
    for r in rolled(g, window, guard):
        t, a, h, f, bt, bs = r['t'], r['a'], r['h'], r['f'], r['bt'], r['bs']
        if r['avg'] is None or not (T0 <= t <= last) or (wide or abs(a - h) >= BLOW_LEAD) != lopsided: prev_ok = {}; since = {}; last_ts = None; continue
        if last_ts is not None and r['ts'] - last_ts > RUN_BREAK: since = {}   # a hole in the readings: the hold starts again
        last_ts = r['ts']; now_ok = {}
        mk = [('total', 'Game total', f['fa'] + f['fh'], bt, f['sd_total'], yard['total'], (f['ashort'] + f['hshort']) >= 5, r['op'], r['up'], None if not fin else fin[0] + fin[1]),
              ('away', g['away'] + ' team total', f['fa'], bt / 2 + bs / 2, f['sd_team'], yard['team'], f['ashort'] >= 3, None, None, None if not fin else fin[0]),
              ('home', g['home'] + ' team total', f['fh'], bt / 2 - bs / 2, f['sd_team'], yard['team'], f['hshort'] >= 3, None, None, None if not fin else fin[1])]
        for i, (key, market, fv, line, sd_rest, y, cold, o_price, u_price, final) in enumerate(mk):
            # The averaged gap decides whether there is a signal and on which side. The chance is worked out on this
            # reading's own gap, because the line and price being logged are the ones on screen now: a three-minute
            # disagreement the book has just closed is not a bet.
            gap = r['avg'][i]; sigma = y; dev = gap / sigma; p_over = 1 - cdf(-r['gaps'][i] / sd_rest)
            side, p, price = ('Over', p_over, o_price) if gap >= 0 else ('Under', 1 - p_over, u_price)
            if key not in markets: continue
            paid = price if price is not None else -115; size = abs(dev)
            # since: when this market's average first reached k on this side, in the unbroken run it is in now
            if size >= k: since[key] = since[key] if since.get(key, (None,))[0] == side else (side, r['ts'])
            else: since.pop(key, None)
            held = hold <= 0 or (key in since and r['ts'] - since[key][1] >= hold - HOLD_SLACK)
            if again is not None:   # the gap has closed, or flipped: this market can be bought again
                for held in ('Over', 'Under'):
                    if (key, held) in fired and (held != side or size < again): fired.discard((key, held))
            if size <= 0 or p < break_even(paid) + MARGIN: continue
            now_ok[(key, side)] = size
            if size >= k and held and (arm is None or prev_ok.get((key, side), 0) >= arm) and (key, side) not in fired:
                fired.add((key, side)); count[(key, side)] = nth = count.get((key, side), 0) + 1
                res = 'Pending' if final is None else 'Push' if final == line else 'Won' if (final > line) == (side == 'Over') else 'Lost'
                out.append(dict(id=f"{g['id']}|{key}|{side}" + (f'|{nth}' if nth > 1 else ''), date=g['date'], game=g['id'], matchup=f"{g['away']} at {g['home']}", mkt=key, market=market, side=side,
                                spot='Cold spot' if (cold and side == 'Over') else 'Book below fair' if side == 'Over' else 'Book above fair',
                                ts=r['ts'], t=round(t, 1), score=f'{a}-{h}', line=line, price=paid, priced='DraftKings' if price is not None else 'Assumed',
                                fair=round(fv, 1), edge=round(gap, 1), dev=round(dev, 2), sigma=round(sigma, 2), chance=round(100 * p), final=final, result=res))
        prev_ok = now_ok
    return out

def settle(s, g):
    """Grade a logged signal against its game's final score, in place."""
    fin = g.get('final') if g else None
    if not fin: return s
    final = fin[0] + fin[1] if s['mkt'] == 'total' else fin[0] if s['mkt'] == 'away' else fin[1]
    s['final'] = final; s['result'] = 'Push' if final == s['line'] else 'Won' if (final > s['line']) == (s['side'] == 'Over') else 'Lost'
    return s

def later_of(g, s, rows=None):
    """What a bettor arriving late would have found. For each delay in LATER: the first reading at least that many seconds
    after the signal and no more than 90 seconds beyond it, as [seconds after, line, price, still on], or None when the
    line was not read in that stretch. Still on means the signal's side still clears the price test on that quote. A
    game total with a line but no price is off the board: its price is None and it is not on."""
    rows = rolled(g) if rows is None else rows
    i = ('total', 'away', 'home').index(s['mkt']); out = {}
    for wait in LATER:
        r = next((r for r in rows if wait <= r['ts'] - s['ts'] <= wait + 90), None)
        if r is None: out[str(wait)] = None; continue
        bt, bs, f = r['bt'], r['bs'], r['f']
        line = bt if i == 0 else bt / 2 + bs / 2 if i == 1 else bt / 2 - bs / 2
        p_over = 1 - cdf(-r['gaps'][i] / (f['sd_total'] if i == 0 else f['sd_team'])); p = p_over if s['side'] == 'Over' else 1 - p_over
        price = (r['op'] if s['side'] == 'Over' else r['up']) if i == 0 else -115
        out[str(wait)] = [r['ts'] - s['ts'], line, price, bool(price is not None and p >= break_even(price) + MARGIN)]
    return out

class Store:
    def __init__(self, out):
        self.out = out; os.makedirs(os.path.join(out, 'tracks'), exist_ok=True); self.days = {}; self.yards = {}
    def path(self, date): return os.path.join(self.out, 'tracks', date + '.json')
    def day(self, date):
        if date not in self.days:
            try: d = json.load(open(self.path(date)))
            except Exception: d = {'date': date, 'games': []}
            self.days[date] = {g['id']: g for g in d['games']}
            if d.get('yardstick'): self.yards[date] = d['yardstick']
        return self.days[date]
    def add(self, date, ev_id, away, home, ar, hr, pre, status, final, reading):
        g = self.day(date).setdefault(ev_id, dict(id=ev_id, date=date, away=away, home=home, ar=ar, hr=hr, pre=None, status='', final=None, r=[]))
        if pre and pre[0] is not None and pre[1] is not None: g['pre'] = pre
        g['status'] = status
        if final: g['final'] = final
        if reading:
            last = g['r'][-1] if g['r'] else None
            if last is not None and ((reading[1] - last[1]) * 60 > (reading[0] - last[0]) + 15 or reading[1] < last[1] - 0.05): return   # game clock cannot outrun the wall clock: ESPN glitch
            if last is None or reading[0] - last[0] >= EVERY: g['r'].append(reading)
    def save(self):
        ledger_path = os.path.join(self.out, 'ledger.json'); index_path = os.path.join(self.out, 'index.json'); ladder_path = os.path.join(self.out, 'ladder.json')
        try: ledger = json.load(open(ledger_path))
        except Exception: ledger = []
        try: index = {d['date']: d for d in json.load(open(index_path))}
        except Exception: index = {}
        try: ladder = json.load(open(ladder_path))
        except Exception: ladder = []
        for date, games in self.days.items():
            gl = sorted(games.values(), key=lambda g: g['id'])
            if (self.yards.get(date) or {}).get('unit') != 'points': self.yards[date] = yardstick(self.out, date)   # fixed the first time a slate is saved
            yard = self.yards[date]
            json.dump({'date': date, 'updated': int(time.time()), 'yardstick': yard, 'games': gl}, open(self.path(date), 'w'), separators=(',', ':'))
            live_rule = rule_of(date)
            if live_rule and live_rule != RULES_VERSION:   # scored live under an earlier rule: those signals stand as logged
                fresh = [settle(s, games.get(s['game'])) for s in ledger if s['date'] == date]
            else:
                fresh = [s for g in gl for s in signals_for(g, yard)]
            rows = {}
            for s in fresh:
                s['rule'] = s.get('rule') or live_rule or RULES_VERSION; g = games.get(s['game'])
                if g and g.get('pre'):
                    if g['id'] not in rows: rows[g['id']] = rolled(g)
                    s['later'] = later_of(g, s, rows[g['id']])
                    # A signal logged on a reading the guard now rejects stays in the ledger, marked, and out of the headline record.
                    at = next((r for r in rows[g['id']] if r['ts'] == s['ts']), None)
                    if at is not None and at['stalled']: s['fault'] = 'stalled'
                    else: s.pop('fault', None)
            ledger = [s for s in ledger if s['date'] != date] + fresh
            ladder = [r for r in ladder if r['date'] != date]
            runs = [(rule, [s for g in gl for s in signals_for(g, yard, k, window, arm, rule == SHADOW[0], hold=HOLD if rule in ('signal', SHADOW[0]) else 0)]) for rule, k, window, arm in VARIANTS + (SHADOW,)]   # the comparison rules fire at once, as they always have
            runs += [(rule, [s for g in gl for s in signals_for(g, yard, **extra) if keep is None or keep(s)]) for rule, extra, keep in IDEAS]
            for rule, every in runs:   # what each rule or idea would have done, overall and by stage of the game
                for stage, lo, hi in STAGES:
                    sig = [s for s in every if lo <= s['t'] < hi]; res = [s['result'] for s in sig]
                    ladder.append(dict(date=date, rule=rule, stage=stage, n=len(sig), won=res.count('Won'), lost=res.count('Lost'), push=res.count('Push'), open=res.count('Pending'),
                                       units=round(sum(units(s['price']) if s['result'] == 'Won' else -1 if s['result'] == 'Lost' else 0 for s in sig), 2)))
            rows = [d for g in gl for d in devs_of(g)]; n = len(rows)
            index[date] = dict(date=date, games=sum(1 for g in gl if g['r']), readings=sum(len(g['r']) for g in gl), total_readings=n,
                               gap_abs=round(sum(abs(d[3]) for d in rows) / n, 2) if n else None, gap_mean=round(sum(d[3] for d in rows) / n, 2) if n else None,
                               dev_low=round(100 * sum(d[0] / yard['total'] >= BUY_DEV for d in rows) / n, 1) if n else None,
                               dev_high=round(100 * sum(d[0] / yard['total'] <= -BUY_DEV for d in rows) / n, 1) if n else None, yard_total=yard['total'])
        json.dump(sorted(ladder, key=lambda r: r['date']), open(ladder_path, 'w'), separators=(',', ':'))
        json.dump(sorted(ledger, key=lambda s: (s['date'], s['ts'])), open(ledger_path, 'w'), separators=(',', ':'))
        json.dump(sorted(index.values(), key=lambda d: d['date']), open(index_path, 'w'), separators=(',', ':'))

def migrate(out):
    """If the stored results were made under other rules, go through every stored slate again. Readings are never
    changed, and a slate keeps the yardstick it was first judged with (one stored in another unit is measured again).
    A slate scored live keeps the signals logged that day (see RULE_STARTS); slates from before the record began are
    judged again from their readings. The ladder and daily summaries are rebuilt for every slate. Returns True if it ran."""
    path = os.path.join(out, 'rules.json')
    try: current = json.load(open(path)).get('version')
    except Exception: current = None
    if current == RULES_VERSION: return False
    store = Store(out); tdir = os.path.join(out, 'tracks')
    for name in sorted(os.listdir(tdir)):
        if name.endswith('.json'): store.day(name[:-5])
    for stale in ('ladder.json', 'index.json'):   # never the ledger: it holds the signals logged live
        try: os.remove(os.path.join(out, stale))
        except OSError: pass
    store.save()
    json.dump({'version': RULES_VERSION, 'signal': {'deviations': BUY_DEV, 'average_seconds': WINDOW, 'hold_seconds': HOLD, 'margin': MARGIN, 'minutes': [T0, T1], 'stalled': {'clock_seconds': STALL_SEC, 'points': STALL_PTS, 'line_points': STALL_LINE}, 'readings': MIN_READINGS},
               'history': [{'since': d, 'version': v, 'change': why} for d, v, why in RULE_STARTS]}, open(path, 'w'))
    return True

def odds_for(ev_id):
    pre = live = None
    try:
        for it in get(OD % (ev_id, ev_id, int(time.time()))).get('items', []):
            pid = str((it.get('provider') or {}).get('id')); ou, sp = num(it.get('overUnder')), num(it.get('spread'))
            if pid == '100' and ou is not None and sp is not None: pre = [ou, sp]
            if pid == '200' and ou is not None and sp is not None:
                cur = it.get('current') or {}
                live = [ou, sp, num((cur.get('over') or {}).get('american')), num((cur.get('under') or {}).get('american'))]
    except Exception as e:
        print('odds error', ev_id, str(e)[:80], flush=True)
    return pre, live

def poll(store, pre_cache):
    now = int(time.time()); date = slate_date(); evs = get(SB % (date, now)).get('events', [])
    live_games = [e for e in evs if e['status']['type']['state'] == 'in']
    with ThreadPoolExecutor(8) as ex: odds = dict(zip([e['id'] for e in live_games], ex.map(odds_for, [e['id'] for e in live_games])))
    n_in = n_pre = 0
    for e in evs:
        st = e['status']; state = st['type']['state']; c = e['competitions'][0]; cs = {x['homeAway']: x for x in c['competitors']}
        n_pre += state == 'pre'
        if e['id'] not in store.day(date) and state != 'in': continue
        name = lambda s: cs[s]['team'].get('shortDisplayName') or cs[s]['team'].get('location') or cs[s]['team'].get('abbreviation')
        rank = lambda s: (lambda r: r if r and r <= 25 else None)((cs[s].get('curatedRank') or {}).get('current'))
        a, h = int(num(cs['away'].get('score')) or 0), int(num(cs['home'].get('score')) or 0)
        if state == 'in':
            n_in += 1; pre, live = odds.get(e['id'], (None, None))
            if pre: pre_cache[e['id']] = pre
            t = round(elapsed(st.get('period'), st.get('displayClock')), 2)
            reading = [now, t, a, h] + (live if live else [None, None, None, None]) if (st.get('period') or 0) <= 2 else None
            store.add(date, e['id'], name('away'), name('home'), rank('away'), rank('home'), pre_cache.get(e['id']), st['type'].get('shortDetail') or 'Live', None, reading)
        elif state == 'post':
            store.add(date, e['id'], name('away'), name('home'), rank('away'), rank('home'), pre_cache.get(e['id']), 'Final', [a, h], None)
    return n_in, n_pre

def git(out, *args): return subprocess.run(['git', '-C', out] + list(args), capture_output=True, text=True)
WATCHED = ('recorder', 'model.json', '.github/recorder-start')

def superseded(repo=ROOT):
    """True when main has moved on and the recorder's own files differ from the ones this run started with. A run that
    finds this hands over, so a rule change takes effect within minutes even in the middle of a slate."""
    try:
        if git(repo, 'fetch', '-q', '--depth', '1', 'origin', 'main').returncode != 0: return False
        return git(repo, 'diff', '--quiet', 'HEAD', 'FETCH_HEAD', '--', *WATCHED).returncode == 1
    except Exception:
        return False

def push(out):
    git(out, 'add', '-A')
    if git(out, 'diff', '--cached', '--quiet').returncode == 0: return
    git(out, 'commit', '-q', '-m', 'recorder: ' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC'))
    r = git(out, 'push', '-q'); print('push', r.returncode, r.stderr.strip()[:120], flush=True)

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--out', default='store'); ap.add_argument('--minutes', type=float, default=335)
    ap.add_argument('--push', action='store_true'); ap.add_argument('--watch', action='store_true'); ap.add_argument('--import-jsonl'); ap.add_argument('--rebuild', action='store_true'); ap.add_argument('--reyard', default='')
    a = ap.parse_args(); store = Store(a.out)
    if a.rebuild:   # recompute the ledger, ladder and summaries of every stored slate with the current rules
        for name in sorted(os.listdir(os.path.join(a.out, 'tracks'))):
            if name.endswith('.json'): store.day(name[:-5])
        for date in a.reyard.split(','): store.yards.pop(date, None)   # --reyard DATE,DATE: measure those slates' yardsticks again
        store.save(); return
    if not a.import_jsonl and migrate(a.out): print('stored slates judged again under rules', RULES_VERSION, flush=True)
    if a.import_jsonl:
        for line in open(a.import_jsonl):
            s = json.loads(line); date = slate_date(datetime.datetime.fromtimestamp(s['ts'], datetime.timezone.utc))
            pre = next(([b['ou'], b['spread']] for b in s['books'] if str(b['pid']) == '100' and b.get('ou') is not None), None)
            lv = next(([b['ou'], b['spread'], b.get('over'), b.get('under')] for b in s['books'] if str(b['pid']) == '200' and b.get('ou') is not None and b.get('spread') is not None), [None] * 4)
            if (s.get('period') or 0) > 2: continue
            store.add(date, s['id'], s['away'], s['home'], None, None, pre, s.get('detail') or 'Live', None, [s['ts'], round(elapsed(s['period'], s['clock']), 2), int(s['as']), int(s['hs'])] + lv)
        store.save(); return
    end = time.time() + a.minutes * 60; last_save = last_push = 0; idle_since = None; pre_cache = {}; finished = False; last_watch = time.time()
    while time.time() < end:
        t0 = time.time()
        try:
            n_in, n_pre = poll(store, pre_cache)
            print(datetime.datetime.now(datetime.timezone.utc).strftime('%H:%M:%S'), 'live', n_in, 'to come', n_pre, flush=True)
            idle_since = None if n_in else (idle_since or t0)
            if n_in == 0 and n_pre == 0 and idle_since and t0 - idle_since > 900: finished = True
        except Exception as e:
            print('poll error', str(e)[:120], flush=True); n_in = 1
        if t0 - last_save >= 60: store.save(); last_save = t0
        if a.push and t0 - last_push >= 300: push(a.out); last_push = t0
        if finished: break
        if a.watch and t0 - last_watch >= 300:   # newer recorder code on main: save and hand over to a fresh run
            last_watch = t0
            if superseded(): print('NEWER_RECORDER', flush=True); break
        time.sleep(max(1, (30 if n_in else 120) - (time.time() - t0)))
    store.save()
    if a.push: push(a.out)
    print('SLATE_FINISHED' if finished else 'TIME_UP', flush=True)

if __name__ == '__main__': main()
