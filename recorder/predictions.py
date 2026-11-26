"""Coinbase Predictions quotes for the live games, read from the Kalshi exchange that Coinbase's markets run on.

Research data only. Nothing in this file is read by the signal rule: it records what a second market said, contract by
contract, so that agreement and disagreement between the sportsbook, the prediction market and the model can be studied
later on data collected before the results were known.

What is kept, per game, in markets/<date>.json:
  the exchange's event and its settlement terms, once;
  each listed contract near the live total (its ticker and its strike);
  quotes as they change: bid, ask and the size at each, last trade, volume, open interest and the exchange's own timestamp;
  each contract's result once the game is final.
A short row per minute also goes on the game in the day's track (see row()), for the page.

Two kinds of number are kept apart everywhere. A quote is what the exchange listed for a contract. The estimated total is
ours: the total at which the over would cost 50 cents, read between the two listed contracts either side of it."""
import datetime, difflib, json, os, re, time, urllib.request

KX = 'https://api.elections.kalshi.com/trade-api/v2'
SERIES = 'KXNCAAMBTOTAL'
EVERY, REST, FAILS = 55, 600, 3        # seconds between pulls; how long to stand down after FAILS failures in a row
RANGE, FULL = 10.5, 300                # contracts kept within RANGE points of the live total; every one re-stored each FULL seconds
SPREAD = 12.0                          # a quote wider than this, in cents, is not used for the estimated total
TAKER = 0.07                           # exchange taker fee: TAKER x multiplier x price x (1 - price) a contract, before rounding up per order
AGREE = 1.0                            # points the estimated total must sit from the sportsbook's to count as taking a side
DROP = {'university', 'the', 'of'}
ALIAS = {'state': 'st', 'saint': 'st', 'mount': 'mt', 'ft': 'fort'}


def kget(path, timeout=20):
    req = urllib.request.Request(KX + path, headers={'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def cents(x):
    try: return round(float(x) * 100, 2)
    except (TypeError, ValueError): return None


def size(x):
    try: return round(float(x), 2)
    except (TypeError, ValueError): return None


def epoch(s):
    try: return int(datetime.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp())
    except Exception: return None


def norm(name):
    s = re.sub(r"[.'’()]", '', (name or '').lower()); s = re.sub(r'[^a-z0-9]+', ' ', s)
    return ' '.join(ALIAS.get(w, w) for w in s.split() if w not in DROP)


def teams_of(title):
    """'Georgia vs Cincinnati: Point Total' gives ('georgia', 'cincinnati'), then the same two without anything in brackets."""
    head = (title or '').split(':')[0]
    parts = re.split(r'\s+vs\.?\s+|\s+at\s+', head)
    return (norm(parts[0]), norm(parts[1]), norm(re.sub(r'\(.*?\)', '', parts[0])), norm(re.sub(r'\(.*?\)', '', parts[1]))) if len(parts) == 2 else None


def codes(date):
    """The date codes an event ticker may carry for a slate date: the day itself and the days either side."""
    d = datetime.datetime.strptime(date, '%Y%m%d')
    return [(d + datetime.timedelta(days=k)).strftime('%y%b%d').upper() for k in (0, 1, -1)]


def sim(team, names):
    return max((1.0 if team == n else difflib.SequenceMatcher(None, team, n).ratio()) for n in names) if names else 0.0


def match(events, away, home, date):
    """The exchange event for a game, from every name the scoreboard gives each team. Both teams must match, in either
    order, on the same day or the day beside it, and no other event may come close. Returns (event, score) or None."""
    A, B = [norm(n) for n in away if n], [norm(n) for n in home if n]
    scored = []
    for e in events:
        if not any(c in e.get('event_ticker', '') for c in codes(date)): continue
        t = teams_of(e.get('title'))
        if not t: continue
        one = lambda i, names: max(sim(t[i], names), 0.9 * sim(t[i + 2], names))   # 'Miami (FL)' may be plain 'Miami' on the scoreboard: allowed, at a lower score
        scored.append((max(min(one(0, A), one(1, B)), min(one(0, B), one(1, A))), e))
    scored.sort(key=lambda x: -x[0])
    if not scored or scored[0][0] < 0.84: return None
    if len(scored) > 1 and scored[1][0] > scored[0][0] - 0.05: return None
    return scored[0][1], round(scored[0][0], 3)


def ladder(event):
    """The event's over contracts as rows sorted by strike: [strike, ticker, bid, ask, bid size, ask size, last, volume, open interest, exchange time]."""
    out = []
    for m in event.get('markets') or []:
        k = m.get('floor_strike')
        if k is None or m.get('strike_type') not in (None, 'greater') or m.get('status') not in (None, 'active', 'open'): continue
        out.append([float(k), m.get('ticker'), cents(m.get('yes_bid_dollars')), cents(m.get('yes_ask_dollars')), size(m.get('yes_bid_size_fp')), size(m.get('yes_ask_size_fp')),
                    cents(m.get('last_price_dollars')) or None, size(m.get('volume_fp')), size(m.get('open_interest_fp')), epoch(m.get('updated_time') or '')])
    return sorted(out, key=lambda r: r[0])


def two_sided(r):
    return r[2] is not None and r[3] is not None and r[2] > 0 and r[3] < 100 and 0 <= r[3] - r[2] <= SPREAD


def estimate(lad):
    """The total at which the over would cost 50 cents, read between the two listed contracts either side of it.
    Returns (total, lower row, upper row), or None when no such pair has a usable quote. An estimate, never a quote."""
    q = [r for r in lad if two_sided(r)]
    for a, b in zip(q, q[1:]):
        ma, mb = (a[2] + a[3]) / 2, (b[2] + b[3]) / 2
        if ma >= 50 >= mb and ma != mb: return round(a[0] + (ma - 50) / (ma - mb) * (b[0] - a[0]), 2), a, b
    return None


def fee(price, mult=1.0):
    """Exchange taker fee in cents for one contract bought at `price` cents, before the exchange rounds an order up to the cent.
    Coinbase's own charge is not published and is not in this number."""
    return None if price is None else round(TAKER * (mult or 1.0) * price * (100 - price) / 100, 2)


def row(now, lad, line):
    """The short row kept on the game in the day's track: [time, estimated total, lower strike, its bid, its ask, upper strike,
    its bid, its ask, bid and ask of the contract at the sportsbook's own total, if one is listed]."""
    est = estimate(lad); eq = next((r for r in lad if line is not None and abs(r[0] - line) < 0.01), None)
    lo, hi = (est[1], est[2]) if est else (None, None)
    if not est and not eq: return None
    return [now, est[0] if est else None] + (lo[0:1] + lo[2:4] if lo else [None] * 3) + (hi[0:1] + hi[2:4] if hi else [None] * 3) + (eq[2:4] if eq else [None, None])


def side_taken(side, line, est):
    """Where the prediction market stood against the sportsbook at a signal: 'model' when its estimated total is at least AGREE
    points on the signal's side of the sportsbook's total, 'against' when at least AGREE points the other way, else 'sportsbook'."""
    if est is None or line is None: return None
    a = (est - line) * (1 if side == 'Over' else -1)
    return 'model' if a >= AGREE else 'against' if a <= -AGREE else 'sportsbook'


def at_signal(g, s, break_even, mult=1.0):
    """What the prediction market showed when a signal was logged, from the game's short rows: the newest row in the two minutes
    before it. Costs are cents per dollar paid out; the Coinbase cost is the equivalent contract's ask plus the exchange fee."""
    rows = [c for c in g.get('c') or [] if s['ts'] - 120 <= c[0] <= s['ts']]
    if not rows: return None
    c = rows[-1]; out = dict(ts=c[0], est=c[1], between=[c[2], c[5]] if c[1] is not None else None, took=side_taken(s['side'], s['line'], c[1]), book=round(100 * break_even(s['price']), 1))
    if c[8] is not None and c[9] is not None:
        ask = c[9] if s['side'] == 'Over' else round(100 - c[8], 2)
        out.update(quote=[c[8], c[9]], fee=fee(ask, mult), cb=round(ask + fee(ask, mult), 1))
    return out


class Markets:
    def __init__(self, out):
        self.dir = os.path.join(out, 'markets'); os.makedirs(self.dir, exist_ok=True)
        self.days = {}; self.due = 0; self.rest_until = 0; self.fails = 0; self.series = None; self.series_day = None; self.last = {}; self.full = {}; self.tried = {}
    def path(self, date): return os.path.join(self.dir, date + '.json')
    def day(self, date):
        if date not in self.days:
            try: self.days[date] = json.load(open(self.path(date)))
            except Exception: self.days[date] = dict(date=date, about='Coinbase Predictions quotes from the Kalshi exchange. q rows: [time, strike, bid, ask, bid size, ask size, last, volume, open interest, exchange time]. Prices in cents for a contract paying 100.', series=None, games={})
        return self.days[date]
    def mult(self):
        try: return float((self.series or {}).get('fee_multiplier') or 1.0)
        except (TypeError, ValueError): return 1.0
    def pull(self, now):
        """Every open event of the series with its contracts, in one request; None while standing down or not yet due."""
        if now < self.due or now < self.rest_until: return None
        self.due = now + EVERY
        try:
            day = time.strftime('%Y%m%d', time.gmtime(now))
            if self.series is None or self.series_day != day:
                s = kget('/series/' + SERIES).get('series') or {}
                self.series = {k: s.get(k) for k in ('ticker', 'title', 'fee_type', 'fee_multiplier', 'contract_terms_url', 'contract_url', 'last_updated_ts')}; self.series_day = day
            ev = kget('/events?series_ticker=%s&status=open&with_nested_markets=true&limit=200' % SERIES).get('events') or []
            self.fails = 0; return ev
        except Exception as err:
            self.fails += 1; print('predictions error', str(err)[:80], flush=True)
            if self.fails >= FAILS: self.rest_until = now + REST; self.fails = 0; print('predictions resting', flush=True)
            return None
    def update(self, date, now, live, events=None):
        """Store the changed quotes for each live game and return {game id: short row}. `live` is a list of dicts with id,
        away and home (lists of names) and line (the sportsbook's live total, or the pregame one before a live line exists)."""
        events = self.pull(now) if events is None else events
        if events is None: return {}
        d = self.day(date); d['series'] = dict(self.series or {}, taker_fee=TAKER, note='Exchange fee only. Coinbase publishes no fee schedule; its charge appears on its order preview.'); out = {}
        for x in live:
            g = d['games'].get(x['id'])
            if g is None:
                m = match(events, x['away'], x['home'], date)
                if not m:
                    if x['id'] not in self.tried: self.tried[x['id']] = 1; d.setdefault('unmatched', {})[x['id']] = [x['away'][0], x['home'][0]]
                    continue
                e = m[0]; first = (e.get('markets') or [{}])[0]
                g = d['games'][x['id']] = dict(event=e.get('event_ticker'), title=e.get('title'), sub_title=e.get('sub_title'), matched=m[1], teams=[x['away'][0], x['home'][0]],
                                               settlement_sources=e.get('settlement_sources'), rules_example=first.get('rules_primary'), rules_secondary=first.get('rules_secondary'),
                                               can_close_early=first.get('can_close_early'), early_close_condition=first.get('early_close_condition'), settlement_timer_seconds=first.get('settlement_timer_seconds'),
                                               expected_expiration_time=first.get('expected_expiration_time'), contracts={}, q=[])
                d.get('unmatched', {}).pop(x['id'], None)
            e = next((e for e in events if e.get('event_ticker') == g['event']), None)
            if e is None: continue
            lad = ladder(e); line = x.get('line')
            if not lad: continue
            ref = line if line is not None else (estimate(lad) or [None])[0]
            full = now - self.full.get(x['id'], 0) >= FULL
            for r in lad:
                if ref is not None and abs(r[0] - ref) > RANGE: continue
                g['contracts'].setdefault(r[1], r[0]); key = (x['id'], r[1]); seen = (r[2], r[3], r[6])
                if full or self.last.get(key) != seen: g['q'].append([now, r[0]] + r[2:]); self.last[key] = seen
            if full: self.full[x['id']] = now
            c = row(now, lad, line)
            if c: out[x['id']] = c
        return out
    def final(self, date, ev_id, now):
        """Once a game is final, ask for its contracts' results. Tried a few times, a few minutes apart, then left."""
        g = self.day(date)['games'].get(ev_id)
        if g is None or g.get('results') is not None: return
        n, due = self.tried.get(('final', ev_id), (0, 0))
        if n >= 6 or now < due or now < self.rest_until: return
        self.tried[('final', ev_id)] = (n + 1, now + 300)
        try:
            ms = kget('/markets?event_ticker=%s&limit=200' % g['event']).get('markets') or []
            res = {m['ticker']: [m.get('floor_strike'), m.get('result'), m.get('expiration_value'), m.get('status')] for m in ms if m.get('ticker') in g['contracts']}
            if res and all(v[1] for v in res.values()): g['results'] = res
        except Exception as err:
            print('predictions result error', str(err)[:80], flush=True)
    def save(self):
        for date, d in self.days.items(): json.dump(d, open(self.path(date), 'w'), separators=(',', ':'))
