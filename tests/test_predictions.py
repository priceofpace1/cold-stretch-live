import json, os, sys, tempfile, unittest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'recorder')); sys.path.insert(0, os.path.dirname(__file__))
import predictions as pm, record
import test_recorder as tr

EVENTS = json.load(open(os.path.join(os.path.dirname(__file__), 'fixtures', 'predictions_events.json')))
MIA = next(e for e in EVENTS if 'Miami' in e['title']); UGA = next(e for e in EVENTS if 'Georgia' in e['title'])


class Predictions(unittest.TestCase):
    def test_games_are_matched_by_both_teams_and_never_by_one(self):
        self.assertEqual(pm.match(EVENTS, ['Georgia', 'UGA'], ['Cincinnati', 'CIN'], '20261126')[0]['event_ticker'], UGA['event_ticker'])
        self.assertEqual(pm.match(EVENTS, ['Cincinnati'], ['Georgia'], '20261126')[0]['event_ticker'], UGA['event_ticker'], 'either order')
        m = pm.match(EVENTS, ['Miami', 'MIA'], ['Michigan', 'MICH'], '20261126')
        self.assertEqual(m[0]['event_ticker'], MIA['event_ticker']); self.assertLess(m[1], 1, 'a bracketed name matched without its brackets scores lower')
        self.assertIsNone(pm.match(EVENTS, ['Georgia'], ['Michigan'], '20261126'))
        self.assertIsNone(pm.match(EVENTS, ['Georgia'], ['Cincinnati'], '20261201'), 'another week')
        self.assertEqual(pm.norm('Mississippi Valley St.'), pm.norm('Mississippi Valley State')); self.assertEqual(pm.norm("Saint Peter's"), 'st peters')
        twin = [UGA, dict(UGA, event_ticker=UGA['event_ticker'] + 'X')]
        self.assertIsNone(pm.match(twin, ['Georgia'], ['Cincinnati'], '20261126'), 'two events as close as each other: no match')

    def test_quotes_are_kept_as_listed_and_the_estimate_is_kept_apart(self):
        lad = pm.ladder(MIA)
        self.assertEqual([r[0] for r in lad], sorted(r[0] for r in lad)); self.assertEqual(len(lad), 21)
        r = next(r for r in lad if r[0] == 159.5); self.assertEqual(r[2:4], [48.0, 50.0]); self.assertIsInstance(r[9], int, 'the exchange timestamp is kept')
        est = pm.estimate(lad)
        self.assertEqual(est[0], 159.1); self.assertEqual((est[1][0], est[2][0]), (158.5, 159.5), 'read between the two contracts either side of 50 cents')
        self.assertIsNone(pm.estimate([[150.5, 'a', 0.0, 99.0, 1, 1, None, 0, 0, 0], [151.5, 'b', 1.0, 60.0, 1, 1, None, 0, 0, 0]]), 'no usable quote, no estimate')
        row = pm.row(1000, lad, 159.5)
        self.assertEqual(row, [1000, 159.1, 158.5, 51.0, 52.0, 159.5, 48.0, 50.0, 48.0, 50.0]); self.assertEqual(pm.row(1000, lad, 160.0)[8:], [None, None], 'no contract at that total')

    def test_fee_and_the_side_the_market_took(self):
        self.assertEqual(pm.fee(50), 1.75); self.assertEqual(pm.fee(56), 1.72); self.assertEqual(pm.fee(50, 0.5), 0.88); self.assertIsNone(pm.fee(None))
        self.assertEqual(pm.side_taken('Over', 152.5, 155.2), 'toward'); self.assertEqual(pm.side_taken('Over', 152.5, 152.9), 'level'); self.assertEqual(pm.side_taken('Over', 152.5, 151.0), 'away')
        self.assertEqual(pm.side_taken('Under', 152.5, 151.0), 'toward'); self.assertIsNone(pm.side_taken('Over', 152.5, None))

    def test_changed_quotes_are_stored_once(self):
        with tempfile.TemporaryDirectory() as out:
            mk = pm.Markets(out); mk.series = dict(fee_multiplier=1, fee_type='quadratic_with_maker_fees')
            live = [dict(id='g1', away=['Miami'], home=['Michigan'], line=159.5), dict(id='g2', away=['Nowhere'], home=['Elsewhere'], line=140.5)]
            rows = mk.update('20261126', 1000, live, EVENTS); g = mk.day('20261126')['games']['g1']
            self.assertEqual(rows['g1'][1], 159.1); self.assertNotIn('g2', rows); self.assertEqual(mk.day('20261126')['unmatched'], {'g2': ['Nowhere', 'Elsewhere']})
            n = len(g['q']); self.assertTrue(all(abs(q[1] - 159.5) <= pm.RANGE for q in g['q'])); self.assertEqual(len(g['q'][0]), 10)
            self.assertIn('rules_example', g); self.assertTrue(g['rules_secondary']); self.assertEqual(g['event'], MIA['event_ticker'])
            mk.update('20261126', 1060, live, EVENTS); self.assertEqual(len(g['q']), n, 'nothing changed, nothing stored')
            moved = json.loads(json.dumps(EVENTS)); m = next(q for e in moved if e['event_ticker'] == MIA['event_ticker'] for q in e['markets'] if q['floor_strike'] == 159.5); m['yes_bid_dollars'] = '0.4900'
            mk.update('20261126', 1120, live, moved); self.assertEqual(len(g['q']), n + 1); self.assertEqual(g['q'][-1][:4], [1120, 159.5, 49.0, 50.0])
            mk.update('20261126', 1000 + pm.FULL + 5, live, moved); self.assertEqual(len(g['q']), 2 * n + 1, 'every contract again after five minutes')
            mk.save(); self.assertEqual(json.load(open(mk.path('20261126')))['series']['taker_fee'], pm.TAKER)

    def test_a_signal_is_annotated_and_tallied_but_never_decided_by_the_market(self):
        g = tr.Recording('test_save_writes_tracks_ledger_and_index').game([4] * 14, every=30); before = [s for s in record.signals_for(g) if s['mkt'] == 'total']
        s = before[0]; g['c'] = [[s['ts'] - 400, 99.0, 1, 1, 1, 2, 1, 1, None, None], [s['ts'] - 30, s['line'] + 2.7, s['line'] - 1, 61.0, 62.0, s['line'] + 1, 55.0, 56.0, 57.0, 58.0]]
        self.assertEqual([x['ts'] for x in record.signals_for(g) if x['mkt'] == 'total'], [x['ts'] for x in before], 'the rule does not read the market')
        cb = pm.at_signal(g, s, record.break_even)
        self.assertEqual(cb['took'], 'toward'); self.assertIn(cb['nearer'], ('model', 'sportsbook')); self.assertEqual(cb['quote'], [57.0, 58.0]); self.assertEqual(cb['book'], round(100 * record.break_even(s['price']), 1))
        self.assertEqual(cb['cb'], round(58.0 + pm.fee(58.0), 1) if s['side'] == 'Over' else round(43.0 + pm.fee(43.0), 1))
        self.assertIsNone(pm.at_signal(dict(g, c=[[s['ts'] - 400, 1, 1, 1, 1, 2, 1, 1, None, None]]), s, record.break_even), 'nothing in the two minutes before')
        with tempfile.TemporaryDirectory() as out:
            self.assertFalse(record.PREDICTIONS_ON, 'off until the exchange has given written permission'); record.PREDICTIONS_ON = True; self.addCleanup(setattr, record, 'PREDICTIONS_ON', False)
            st = record.Store(out); st.days[g['date']] = {g['id']: g}; st.save()
            row = next(x for x in json.load(open(os.path.join(out, 'ledger.json'))) if x['mkt'] == 'total'); self.assertEqual(row['cb']['took'], 'toward')
            lad = [r for r in json.load(open(os.path.join(out, 'ladder.json'))) if r['rule'] == 'signal-cb-toward' and r['stage'] == json.load(open(os.path.join(out, 'ladder.json')))[0]['stage']]
            self.assertEqual(lad[0]['n'], 1)


if __name__ == '__main__':
    unittest.main()
