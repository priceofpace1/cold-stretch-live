"""python -m unittest discover tests"""
import datetime, json, os, sys, tempfile, unittest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'recorder'))
import record  # noqa: E402


class Clock(unittest.TestCase):
    def test_elapsed(self):
        self.assertEqual(record.elapsed(1, '20:00'), 0)
        self.assertAlmostEqual(record.elapsed(1, '7:30'), 12.5)
        self.assertEqual(record.elapsed(2, '20:00'), 20)
        self.assertEqual(record.elapsed(2, '0:00'), 40)
        self.assertEqual(record.elapsed(3, '4:10'), 40)

    def test_slate_rolls_over_at_5am_eastern(self):
        utc = datetime.timezone.utc
        self.assertEqual(record.slate_date(datetime.datetime(2026, 11, 18, 5, 0, tzinfo=utc)), '20261117')   # midnight Eastern tip
        self.assertEqual(record.slate_date(datetime.datetime(2026, 11, 18, 9, 59, tzinfo=utc)), '20261117')
        self.assertEqual(record.slate_date(datetime.datetime(2026, 11, 18, 10, 0, tzinfo=utc)), '20261118')


class Model(unittest.TestCase):
    def test_fair_lands_on_the_score_at_the_whistle(self):
        f = record.fair(149.5, -3.5, 40, 71, 78)
        self.assertEqual((f['fa'], f['fh']), (71, 78))

    def test_cold_team_resumes_pace_without_catching_up(self):
        f = record.fair(150, 0, 20, 22, 35)
        self.assertGreater(f['ashort'], 10)
        self.assertLess(f['fa'], 75 - 8)

    def test_cdf_is_monotone(self):
        zs = [x / 10 for x in range(-40, 41)]
        ps = [record.cdf(z) for z in zs]
        self.assertEqual(ps, sorted(ps))
        self.assertLess(ps[0], 0.01)
        self.assertGreater(ps[-1], 0.99)


class Recording(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.store = record.Store(self.dir.name)

    def tearDown(self):
        self.dir.cleanup()

    def add(self, ts, t, a, h, line, final=None, status='Live'):
        self.store.add('20261117', 'g1', 'Away U', 'Home St', None, None, [150, 0], status, final, None if line is None else [ts, t, a, h, line, 0, -110, -110])

    def test_clock_glitch_is_dropped(self):
        self.add(1000, 12.5, 20, 14, 140.5)
        self.add(1060, 14.88, 21, 14, 137.5)    # 2.4 game minutes in 60 seconds
        self.add(1120, 13.0, 23, 14, 141.5)
        self.assertEqual([r[1] for r in self.store.day('20261117')['g1']['r']], [12.5, 13.0])

    def game(self, gaps, start=20, price=-110, a0=30, h0=32, pre=(150, 0), every=60, final=None):
        """A game where the book sits gaps[i] points under fair at reading i."""
        g = dict(id='g', date='20261117', away='Away U', home='Home St', pre=list(pre), final=final, r=[])
        for i, gap in enumerate(gaps):
            t = start + i * every / 60; a, h = a0 + i, h0 + i
            f = record.fair(pre[0], pre[1], t, a, h)
            g['r'].append([i * every, t, a, h, f['fa'] + f['fh'] - gap, a - h, price, price])
        return g

    def total(self, g, **kw):
        kw.setdefault('hold', 0)   # each other part of the rule is looked at with the hold switched off; the hold has a test of its own
        return [s for s in record.signals_for(g, **kw) if s['mkt'] == 'total']

    def test_the_signal_is_judged_on_a_three_minute_average(self):
        rows = record.rolled(self.game([0, 0, 0, 6, 0, 0, 0]))
        self.assertIsNone(rows[1]['avg'], 'no average until the line has been followed for most of three minutes')
        self.assertAlmostEqual(rows[3]['avg'][0], 6 / 4)
        self.assertAlmostEqual(rows[6]['avg'][0], 6 / 5, msg='the reading just before the window is carried forward')
        self.assertEqual(self.total(self.game([0, 0, 0, 6, 0, 0, 0])), [], 'one six-point reading is not a signal')
        self.assertEqual(len(self.total(self.game([0, 3, 3, 3, 3, 3]))), 1, 'three points that stay are')

    def test_a_signal_fires_once_and_settles(self):
        sig = self.total(self.game([0, 3, 3, 3, 3, 3, 3]))
        self.assertEqual(len(sig), 1)
        self.assertEqual((sig[0]['side'], sig[0]['result'], sig[0]['priced']), ('Over', 'Pending', 'DraftKings'))
        self.assertGreaterEqual(sig[0]['dev'], record.BUY_DEV)
        self.assertEqual([s['result'] for s in self.total(self.game([0, 3, 3, 3, 3, 3, 3], final=[90, 90]))], ['Won'])
        self.assertEqual([s['result'] for s in self.total(self.game([0, 3, 3, 3, 3, 3, 3], final=[50, 50]))], ['Lost'])
        self.assertEqual(self.total(self.game([0, -3, -3, -3, -3, -3]))[0]['side'], 'Under')

    def test_a_signal_waits_for_its_gap_to_hold_two_minutes(self):
        held = lambda g, **kw: [s for s in record.signals_for(g, **kw) if s['mkt'] == 'total']
        g = self.game([4] * 14, every=30)
        self.assertEqual([s['ts'] for s in self.total(g)], [150])
        self.assertEqual([s['ts'] for s in held(g)], [270])
        self.assertEqual(held(g)[0]['line'], g['r'][9][4], 'the line of the reading it is logged on')
        self.assertEqual([s['ts'] for s in held(g, hold=180)], [330])
        self.assertEqual(held(self.game([4] * 8 + [0] * 8, every=30)), [], 'the gap closed before the two minutes were up')
        again = self.game([4] * 7 + [-1] * 7 + [4] * 12, every=30)
        self.assertEqual(len(held(again)), 1)
        self.assertGreaterEqual(held(again)[0]['ts'], self.total(again)[0]['ts'] + 14 * 30, 'the count starts over')
        hole = self.game([4] * 22, every=30)
        for r in hole['r'][8:]: r[0] += 200
        self.assertGreaterEqual(held(hole)[0]['ts'], hole['r'][8][0] + record.HOLD - record.HOLD_SLACK, 'counted from after the hole')
        minute = self.game([4] * 8)
        self.assertEqual(held(minute)[0]['ts'] - self.total(minute)[0]['ts'], 120)

    def test_comparison_rules_count_the_hold_other_ways_and_leave_the_rule_alone(self):
        held = lambda g, **kw: [s for s in record.signals_for(g, **kw) if s['mkt'] == 'total']
        run = self.game([4] * 14, every=30)
        self.assertEqual([s['ts'] for s in held(run)], [270])
        self.assertEqual([s['ts'] for s in held(run, hold_by='live')], [270], 'play went on through the hold')
        self.assertGreaterEqual(held(run, hold_by='clock')[0]['ts'], 270)
        # a stoppage: from the sixth reading the clock and the score stand for three minutes while the gap stays
        stop = self.game([4] * 12, every=30)
        for r in stop['r'][6:]: r[1], r[2], r[3], r[4] = stop['r'][5][1], stop['r'][5][2], stop['r'][5][3], stop['r'][5][4]
        self.assertEqual(len(held(stop)), 1, 'two minutes by the wall clock is the rule, stoppage or not')
        self.assertEqual(held(stop, hold_by='live'), [], 'no play in the hold')
        self.assertEqual(held(stop, hold_by='clock'), [])
        # possessions: counted from box readings, and nothing without them
        self.assertEqual(held(run, hold_by='poss'), [])
        box = lambda i, n: [i * 30, 20 + i / 2, n, 0, 0, 0, 0, n, 0, 0, 0, 0]
        run['x'] = [box(i, i) for i in range(14)]          # two possessions a reading: four inside any two minutes
        self.assertEqual([s['ts'] for s in held(run, hold_by='poss')], [270])
        run['x'] = [box(i, 3) for i in range(14)]          # none played
        self.assertEqual(held(run, hold_by='poss'), [])
        self.assertEqual(record.poss_of([0, 10.0, 58, 7, 8, 6, 20, 43, 15, 8, 14, 13]), (58 - 8 + 6 + 0.475 * 7) + (43 - 8 + 14 + 0.475 * 15))
        self.assertIsNone(record.poss_of([0, 10.0, 58, 7, None, None, None, 43, 15, None, None, None]))
        # a hole in the live line inside the hold: the rule runs across it, the unbroken comparison starts again
        holed = self.game([4] * 20, every=30); del holed['r'][7:9]
        self.assertEqual([s['ts'] for s in held(holed)], [270])
        self.assertGreater(held(holed, run_break=45)[0]['ts'], 270)
        # the price test can be left out, as a comparison
        dear = self.game([4] * 14, every=30, price=-400)
        self.assertEqual(held(dear), [])
        self.assertEqual(len(held(dear, margin=None)), 1)
        # a sportsbook total that stands two minutes while six points go up is passed over by the fresh-line comparison
        stale = self.game([4] * 14, every=30)
        for r in stale['r'][5:]: r[4] = stale['r'][5][4]
        self.assertTrue(held(stale))
        self.assertFalse([s for s in held(stale, fresh=True) if s['ts'] <= held(stale)[0]['ts']])

    def test_box_readings_are_kept_beside_the_readings(self):
        with tempfile.TemporaryDirectory() as out:
            st = record.Store(out)
            st.add('20261126', 'g1', 'Away U', 'Home St', None, None, [150, 0], 'Live', None, [0, 5.0, 8, 9, 140.5, -1.5, -110, -110])
            shots = lambda ts: [ts, 5.0, 10, 2, None, None, None, 9, 3, None, None, None]
            full = lambda ts: [ts, 5.0, 10, 2, 1, 2, 3, 9, 3, 0, 1, 4]
            st.add_box('20261126', 'g1', shots(0)); st.add_box('20261126', 'g1', shots(30)); st.add_box('20261126', 'g1', full(60)); st.add_box('20261126', 'g1', full(90)); st.add_box('20261126', 'nope', full(90))
            x = st.day('20261126')['g1']['x']
            self.assertEqual([r[0] for r in x], [0, 60, 90], 'one a minute, and every reading that has rebounds and turnovers')
            self.assertEqual(st.day('20261126')['g1']['r'][0][:4], [0, 5.0, 8, 9], 'the readings themselves are untouched')

    def test_price_thresholds_windows_and_yardsticks(self):
        held = [2.7] * 5
        self.assertEqual(len(self.total(self.game(held))), 1)
        self.assertEqual(self.total(self.game(held, price=-180)), [], 'a steep price cancels it')
        self.assertEqual(self.total(self.game(held), k=3.0), [])
        self.assertEqual(self.total(self.game(held), yard={'total': 2, 'team': 2}), [], 'a wider yardstick makes the same gap ordinary')
        self.assertEqual([s['t'] for s in self.total(self.game([0, 0, 0, 6, 0]), window=0)], [23], 'the single-reading comparison rule')
        self.assertEqual([s['t'] for s in self.total(self.game([0, 0, 2.5, 6, 0]), window=0, arm=1.5)], [23])
        self.assertEqual(self.total(self.game([0, 0, 0, 6, 0]), window=0, arm=1.5), [])

    def test_no_signals_in_blowouts_big_spreads_or_outside_the_window(self):
        held = [4] * 6
        self.assertEqual(len(self.total(self.game(held))), 1)
        self.assertEqual(self.total(self.game(held, h0=30 + record.BLOW_LEAD)), [])
        self.assertEqual(self.total(self.game(held, pre=(150, -record.BLOW_SPREAD))), [])
        self.assertEqual(self.total(self.game(held, start=record.T1 + 0.5, every=20)), [])
        self.assertTrue(all(s['t'] >= record.T0 for s in record.signals_for(self.game(held, start=0, a0=0, h0=0, every=30), hold=0)))

    def test_a_run_hands_over_when_the_recorder_on_main_has_changed(self):
        import subprocess
        run = lambda cwd, *a: subprocess.run(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', *a], cwd=cwd, check=True, capture_output=True)
        origin, clone = os.path.join(self.dir.name, 'origin'), os.path.join(self.dir.name, 'clone')
        os.makedirs(os.path.join(origin, 'recorder')); run(origin, 'init', '-q', '-b', 'main')
        open(os.path.join(origin, 'recorder', 'record.py'), 'w').write('one'); open(os.path.join(origin, 'index.html'), 'w').write('site')
        run(origin, 'add', '-A'); run(origin, 'commit', '-q', '-m', 'start')
        run(self.dir.name, 'clone', '-q', 'file://' + origin, clone)
        self.assertFalse(record.superseded(clone), 'nothing has changed')
        open(os.path.join(origin, 'index.html'), 'w').write('site, restyled'); run(origin, 'commit', '-qam', 'site only')
        self.assertFalse(record.superseded(clone), 'a change to the site alone does not interrupt recording')
        open(os.path.join(origin, 'recorder', 'record.py'), 'w').write('two'); run(origin, 'commit', '-qam', 'new rule')
        self.assertTrue(record.superseded(clone), 'a change to the recorder does')
        self.assertFalse(record.superseded(os.path.join(self.dir.name, 'nowhere')), 'and a failure to check never stops a run')

    def test_the_quote_on_screen_must_still_carry_the_edge(self):
        self.assertEqual(self.total(self.game([5, 5, 5, 0.2])), [], 'the average is far out, but the book has just closed the gap: nothing to buy')
        s = self.total(self.game([5, 5, 5, 0.2, 5]))
        self.assertEqual(len(s), 1, 'it fires on the next reading that still offers the gap')
        self.assertEqual(s[0]['t'], 24.0)
        f = record.fair(150, 0, 24, 34, 36)
        self.assertEqual(s[0]['chance'], round(100 * (1 - record.cdf(-5 / f['sd_total']))), 'and the chance logged is the chance on that quote')

    def test_signals_fire_on_the_game_total_alone(self):
        g = self.game([4] * 6)
        self.assertEqual({s['mkt'] for s in record.signals_for(g, hold=0)}, {'total'})
        teams = record.signals_for(self.game([4] * 6, a0=24, h0=32), markets=('away', 'home'), hold=0)
        self.assertTrue(teams and all(s['mkt'] in ('away', 'home') and s['priced'] == 'Assumed' for s in teams), 'team totals are still judged when asked for, as a comparison')

    def test_one_fresh_reading_and_a_stale_one_are_not_an_average(self):
        g = self.game([5] * 4)                                   # readings at 0, 60, 120 and 180 seconds
        late = self.game([5] * 12)['r'][10:]                     # then nothing until two readings ten minutes on
        g['r'] += late
        rows = record.rolled(g)
        self.assertIsNotNone(rows[3]['avg'], 'four readings across three minutes are an average')
        self.assertIsNone(rows[4]['avg'], 'one reading after a long hole is not, even with the last one carried forward')
        self.assertIsNone(rows[5]['avg'], 'nor are two')
        dense = self.game([5] * 7, every=30)                     # the recorder now keeps a reading every 30 seconds
        self.assertEqual([r['avg'] is not None for r in record.rolled(dense)], [False] * 5 + [True] * 2, 'two and a half minutes of readings are needed')

    def test_a_reading_is_kept_every_thirty_seconds(self):
        self.add(1000, 10.0, 15, 15, 150.5); self.add(1020, 10.3, 17, 15, 151.5); self.add(1030, 10.5, 17, 15, 151.5); self.add(1060, 11.0, 19, 15, 152.5)
        self.assertEqual([r[0] for r in self.store.day('20261117')['g1']['r']], [1000, 1030, 1060])
        for ts in (1090, 1120, 1150): self.add(ts, 11.0, 19, 15, 152.5)   # halftime: nothing moves, and each poll is still a reading
        self.assertEqual(len(self.store.day('20261117')['g1']['r']), 6, 'so a stretch with no readings always means the line was not being read')

    def test_the_line_a_late_bettor_would_have_found_is_logged(self):
        g = self.game([5, 5, 5, 5, 5, 0.2, 5], every=30); g['r'] = [[r[0] + 1000] + r[1:] for r in g['r']]
        s = self.total(self.game([5, 5, 5, 5, 5, 5, 5, 5], every=30))[0]; s = dict(s, ts=s['ts'] + 1000)   # fired at the sixth reading
        g = self.game([5, 5, 5, 5, 5, 5, 0.2, 5, 5, 5], every=30); g['r'] = [[r[0] + 1000] + r[1:] for r in g['r']]
        later = record.later_of(g, s)
        self.assertEqual(sorted(later), ['120', '30', '60'])
        self.assertEqual((later['30'][0], later['30'][3]), (30, False), 'thirty seconds on the book had closed the gap')
        self.assertEqual((later['60'][0], later['60'][3]), (60, True), 'a minute on it was there again')
        self.assertEqual(later['60'][2], -110, 'at the price quoted then')
        self.assertIsNone(record.later_of(self.game([5] * 7, every=30), dict(s, ts=150))['120'], 'no reading that late: nothing is made up')
        for r in g['r']: r[6] = r[7] = None
        self.assertEqual(record.later_of(g, s)['60'][2:], [None, False], 'a game total with no price is off the board')
        self.assertEqual(record.later_of(g, dict(s, mkt='home'))['60'][2], -115, 'a team total is priced at the estimate')

    def feed(self, n, minute, pts=lambda i: 40 + i, gap=lambda i: 4, shift=lambda i: 0, final=None, date='20261117'):
        """Readings 30 seconds apart with the book gap(i) points under fair; minute(i) and pts(i) are the feed's clock and score."""
        g = dict(id='g', date=date, away='Away U', home='Home St', pre=[150, 0], final=final, r=[])
        for i in range(n):
            t = minute(i); p = pts(i); a = p // 2; h = p - a; f = record.fair(150, 0, t, a, h)
            g['r'].append([i * 30, t, a, h, f['fa'] + f['fh'] - gap(i) + shift(i), a - h, -110, -110])
        return g

    def test_nothing_is_judged_while_the_score_feed_is_stalled(self):
        moving = lambda i: 10 + i * 0.4
        stands = lambda i: moving(i) if i < 4 else moving(3); still = lambda i: 40 + min(i, 3)
        self.assertEqual(len(self.total(self.feed(14, moving))), 1)
        self.assertEqual(len(self.total(self.feed(14, stands, still))), 1, 'an ordinary stoppage does not block a signal')
        late = self.feed(24, stands, still, gap=lambda i: 0 if i < 16 else 4)
        self.assertEqual(len(self.total(late)), 0, 'a clock that has stood five minutes is a stalled feed')
        self.assertEqual(len(self.total(late, guard=False)), 1)
        self.assertEqual(len(self.total(self.feed(14, stands, lambda i: 40 + (i if i < 4 else 3 + 2 * (i - 3))))), 0, 'points going up while the clock stands')
        self.assertEqual(len(self.total(self.feed(14, stands, still, shift=lambda i: -4 if i == 5 else 0))), 0, 'the book moving four points while the clock stands')
        self.assertEqual(len(self.total(self.feed(14, lambda i: 12.7, lambda i: 41))), 0, 'a game first seen already standing still')
        resumes = self.total(self.feed(24, lambda i: 12.7 if i < 6 else 12.7 + (i - 5) * 0.4, lambda i: 41 + max(0, i - 5)))
        self.assertEqual(len(resumes), 1); self.assertGreaterEqual(resumes[0]['ts'], 6 * 30 + 150)
        self.assertEqual(len(self.total(self.feed(14, lambda i: 19.6 + i * 0.4 if i < 2 else 20, lambda i: 70 + min(i, 2)))), 1, 'halftime is not a stall')
        bare = self.feed(16, moving)
        bare['r'] = [[r[0], r[1], r[2], r[3], None, None, None, None] if i < 6 else r for i, r in enumerate(bare['r'])]
        self.assertEqual(len(self.total(bare)), 1, 'readings without a line still keep the clock moving')

    def test_a_signal_logged_on_a_stalled_feed_is_marked_and_kept(self):
        live = '20261120'
        for date, minute in ((live, lambda i: 12.7), ('20261121', lambda i: 10 + i * 0.4)):
            g = self.feed(8, minute, (lambda i: 41) if date == live else (lambda i: 40 + i), date=date)
            for r in g['r']: self.store.add(date, 'g-' + date, 'Away U', 'Home St', None, None, [150, 0], 'Live', None, r)
            self.store.add(date, 'g-' + date, 'Away U', 'Home St', None, None, [150, 0], 'Final', [70, 72], None)
        self.store.save()
        logged = lambda date: dict(id=f'g-{date}|total|Over', date=date, game='g-' + date, matchup='Away U at Home St', mkt='total', market='Game total', side='Over', spot='Book below fair',
                                   ts=150, t=12.7, score='20-21', line=140.5, price=-110, priced='DraftKings', fair=144.5, edge=4.0, dev=3.3, sigma=1.2, chance=62, final=None, result='Pending')
        json.dump([logged(live), logged('20261121')], open(os.path.join(self.dir.name, 'ledger.json'), 'w'))
        json.dump({'version': '2026-11-22.1'}, open(os.path.join(self.dir.name, 'rules.json'), 'w'))
        self.assertTrue(record.migrate(self.dir.name))
        ledger = {s['date']: s for s in json.load(open(os.path.join(self.dir.name, 'ledger.json')))}
        self.assertEqual((ledger[live].get('fault'), ledger[live]['result']), ('stalled', 'Won'), 'kept, settled and marked')
        self.assertNotIn('fault', ledger['20261121'], 'a signal logged in running play is not marked')

    def test_signals_logged_live_stand_when_the_rule_changes(self):
        live, before = '20261120', '20261117'
        self.assertEqual((record.rule_of(before), record.rule_of(live), record.rule_of(record.RULE_STARTS[-1][0])), (None, '2026-11-19.2', record.RULES_VERSION))
        self.assertEqual(record.RULE_STARTS[-1][1], record.RULES_VERSION, 'the newest entry in the history is the rule in force')
        for date in (live, before):
            for i in range(6): self.store.add(date, 'g-' + date, 'Away U', 'Home St', None, None, [150, 0], 'Live', None, [i * 60, 36 + i * 0.5, 60 + i, 60 + i, 141.5, 0, -110, -110])
            self.store.add(date, 'g-' + date, 'Away U', 'Home St', None, None, [150, 0], 'Final', [70, 72], None)
        self.store.save()
        logged = lambda date: dict(id=f'g-{date}|total|Over', date=date, game='g-' + date, matchup='Away U at Home St', mkt='total', market='Game total', side='Over', spot='Book below fair',
                                   ts=120, t=37.0, score='62-62', line=140.5, price=-110, priced='DraftKings', fair=143.0, edge=2.5, dev=2.1, sigma=1.2, chance=61, final=None, result='Pending')
        json.dump([logged(live), logged(before)], open(os.path.join(self.dir.name, 'ledger.json'), 'w'))
        json.dump({'version': '2026-11-19.2'}, open(os.path.join(self.dir.name, 'rules.json'), 'w'))
        self.assertTrue(record.migrate(self.dir.name))
        ledger = json.load(open(os.path.join(self.dir.name, 'ledger.json')))
        kept = [s for s in ledger if s['date'] == live]
        self.assertEqual([(s['t'], s['line'], s['rule'], s['result'], s['final']) for s in kept], [(37.0, 140.5, '2026-11-19.2', 'Won', 142)],
                         'a signal logged live at minute 37 stays in the record under the rule of its day, and is settled')
        self.assertIn('later', kept[0])
        self.assertEqual([s for s in ledger if s['date'] == before], [], 'a slate from before the record began is judged again: no signal after minute 34 now')
        rules = json.load(open(os.path.join(self.dir.name, 'rules.json')))
        self.assertEqual([h['version'] for h in rules['history']], [v for _, v, _ in record.RULE_STARTS])

    def test_the_watchdog_acts_only_when_games_are_on_and_nothing_is_saved(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'recorder')); import watchdog
        now = 1_800_000_000; iso = lambda t: __import__('datetime').datetime.fromtimestamp(t, __import__('datetime').timezone.utc).strftime('%Y-%m-%dT%H:%MZ')
        ev = lambda state, start=now: {'status': {'type': {'state': state}}, 'date': iso(start)}
        self.assertEqual(watchdog.verdict([ev('post'), ev('pre', now + 7200)], None, now)[0], 'idle', 'nothing on and nothing due: silence is fine')
        self.assertEqual(watchdog.verdict([ev('in')], now - 200, now)[0], 'ok')
        self.assertEqual(watchdog.verdict([ev('in')], now - 1200, now)[0], 'stale', 'a game is on and nothing has been saved for twenty minutes')
        self.assertEqual(watchdog.verdict([ev('in')], None, now)[0], 'stale', 'or nothing at all for this slate')
        self.assertEqual(watchdog.verdict([ev('pre', now + 600)], now - 5000, now)[0], 'stale', 'ten minutes before a tip the recorder should be up')
        self.assertEqual(watchdog.verdict([ev('pre', now + 600)], now - 100, now)[0], 'ok')

    def test_a_market_fires_once_a_game_unless_it_is_allowed_again_after_the_gap_closes(self):
        there_and_back = [4] * 6 + [0] * 6 + [4] * 6   # out, closed, out again
        once = self.total(self.game(there_and_back, start=10))
        twice = [s for s in record.signals_for(self.game(there_and_back, start=10), again=1.0, hold=0) if s['mkt'] == 'total']
        self.assertEqual(len(once), 1)
        self.assertEqual(len(twice), 2)
        self.assertEqual(twice[0]['id'], once[0]['id'], 'the first signal is the same one')
        self.assertNotEqual(twice[1]['id'], twice[0]['id'], 'and the second has its own id')
        stays_out = [s for s in record.signals_for(self.game([4] * 18, start=10), again=1.0, hold=0) if s['mkt'] == 'total']
        self.assertEqual(len(stays_out), 1, 'a gap that never closes is still one signal')

    def test_lopsided_spots_are_judged_apart_and_kept_out_of_the_yardstick(self):
        held = [4] * 6; shadow = lambda g: [s for s in record.signals_for(g, lopsided=True, hold=0) if s['mkt'] == 'total']
        wide, led, close = self.game(held, pre=(150, -record.BLOW_SPREAD)), self.game(held, h0=30 + record.BLOW_LEAD), self.game(held)
        self.assertEqual(len(shadow(wide)), 1, 'a wide spread fires only in the comparison')
        self.assertEqual(len(shadow(led)), 1, 'and so does a big lead')
        self.assertEqual(shadow(close), [], 'a close game never appears in the comparison')
        self.assertEqual(shadow(wide)[0]['t'], self.total(close)[0]['t'], 'it is the same rule, applied where the signal is off')
        self.assertEqual(record.devs_of(wide), [])
        self.assertEqual(record.devs_of(led), [])
        self.assertGreater(len(record.devs_of(close)), 0)

    def test_save_writes_tracks_ledger_and_index(self):
        self.add(0, 10, 15, 15, 150.5)
        self.add(60, 11, 17, 15, 150.5)
        self.store.save()
        day = json.load(open(os.path.join(self.dir.name, 'tracks', '20261117.json')))
        self.assertEqual(len(day['games'][0]['r']), 2)
        self.assertEqual(json.load(open(os.path.join(self.dir.name, 'index.json')))[0]['readings'], 2)
        self.assertIsInstance(json.load(open(os.path.join(self.dir.name, 'ledger.json'))), list)
        self.assertEqual(day['yardstick']['source'], 'model.json', 'no earlier slate, so the shipped yardstick is used and stored with the day')
        ladder = json.load(open(os.path.join(self.dir.name, 'ladder.json')))
        self.assertEqual({r['rule'] for r in ladder}, {v[0] for v in record.VARIANTS} | {record.SHADOW[0]} | {i[0] for i in record.IDEAS} | ({'signal-cb-' + k for k in record.CB_SPLITS} if record.PREDICTIONS_ON else set()))
        self.assertEqual(len(ladder), (len(record.VARIANTS) + 1 + len(record.IDEAS) + (len(record.CB_SPLITS) if record.PREDICTIONS_ON else 0)) * len(record.STAGES))

    def test_stored_slates_are_judged_again_when_the_rules_change(self):
        self.add(0, 10, 15, 15, 150.5)
        self.add(60, 11, 17, 15, 150.5)
        self.store.save()
        json.dump([{'date': '20261117', 'k': 2.0, 'n': 9}], open(os.path.join(self.dir.name, 'ladder.json'), 'w'))   # a ladder from older rules
        self.assertTrue(record.migrate(self.dir.name))
        ladder = json.load(open(os.path.join(self.dir.name, 'ladder.json')))
        self.assertTrue(all('rule' in r for r in ladder))
        self.assertEqual(json.load(open(os.path.join(self.dir.name, 'rules.json')))['version'], record.RULES_VERSION)
        self.assertEqual(len(json.load(open(os.path.join(self.dir.name, 'tracks', '20261117.json')))['games'][0]['r']), 2, 'readings are untouched')
        self.assertFalse(record.migrate(self.dir.name), 'and it only runs once per rules version')

    def test_a_slate_keeps_its_yardstick_when_the_rules_change(self):
        self.add(0, 10, 15, 15, 150.5)
        self.store.save()
        path = os.path.join(self.dir.name, 'tracks', '20261117.json'); day = json.load(open(path))
        day['yardstick'] = {'total': 1.5, 'team': 0.9, 'unit': 'points', 'source': 'recorded'}; json.dump(day, open(path, 'w'))
        json.dump({'version': 'older'}, open(os.path.join(self.dir.name, 'rules.json'), 'w'))
        self.assertTrue(record.migrate(self.dir.name))
        self.assertEqual(json.load(open(path))['yardstick']['total'], 1.5, 'signals already logged are not re-measured after the fact')
        day['yardstick'] = {'total': 0.14, 'team': 0.15}; json.dump(day, open(path, 'w'))   # an older unit
        json.dump({'version': 'older'}, open(os.path.join(self.dir.name, 'rules.json'), 'w'))
        self.assertTrue(record.migrate(self.dir.name))
        self.assertEqual(json.load(open(path))['yardstick']['unit'], 'points')

    def test_yardstick_comes_from_earlier_slates_only(self):
        import random; random.seed(7)
        for i in range(330):
            t = 4 + i * 0.09; a = h = int(t * 1.8)
            f = sum(record.fair(150, 0, t, a, h)[k] for k in ('fa', 'fh'))
            self.store.add('20261117', 'g1', 'Away U', 'Home St', None, None, [150, 0], 'Live', None, [i * 60, round(t, 2), a, h, round((f + random.gauss(0, 2)) * 2) / 2, 0, -110, -110])
        self.store.save()
        self.assertEqual(record.yardstick(self.dir.name, '20261117')['source'], 'model.json', 'a slate never measures itself')
        later = record.yardstick(self.dir.name, '20261118')
        self.assertEqual((later['source'], later['through'], later['unit']), ('recorded', '20261117', 'points'))
        self.assertGreaterEqual(later['readings'], 300)
        self.assertTrue(0.6 < later['total'] < 2.0, later)   # the average of three readings with 2 points of noise each


if __name__ == '__main__':
    unittest.main()
