#!/usr/bin/env python3
"""Checks that the recorder is saving while games are on. Prints one line: 'ok', 'idle', 'unknown' or 'stale', then why.
The watchdog workflow runs it every ten minutes and starts the recorder again on 'stale'. It acts only on evidence:
a scoreboard it could not read, or a data branch it could not read, is 'unknown' and nothing is done."""
import datetime, json, os, subprocess, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import record

STALE, SOON = 900, 1200   # seconds without a save that count as stopped; how long before a tip the recorder should be up

def verdict(events, updated, now):
    """events: ESPN scoreboard events for the slate. updated: unix time of the recorder's last save, or None if it has
    saved nothing for this slate. Returns (word, reason)."""
    live = sum(1 for e in events if e['status']['type']['state'] == 'in')
    def starts(e):
        try: return datetime.datetime.fromisoformat(e['date'].replace('Z', '+00:00')).timestamp()
        except Exception: return None
    soon = sum(1 for e in events if e['status']['type']['state'] == 'pre' and starts(e) is not None and starts(e) - now <= SOON)
    if not live and not soon: return 'idle', 'no game is on or about to start'
    age = None if updated is None else now - updated
    if age is not None and age < STALE: return 'ok', f'{live} live, {soon} about to start, last save {int(age)} seconds ago'
    return 'stale', f'{live} live, {soon} about to start, ' + ('nothing saved for this slate' if age is None else f'last save {int(age // 60)} minutes ago')

def main():
    now = int(time.time()); date = record.slate_date()
    try: events = record.get(record.SB % (date, now)).get('events', [])
    except Exception as e: print('unknown', 'scoreboard not read:', str(e)[:80]); return
    shown = subprocess.run(['git', 'show', f'FETCH_HEAD:tracks/{date}.json'], capture_output=True, text=True, cwd=record.ROOT)
    if shown.returncode != 0:
        listed = subprocess.run(['git', 'ls-tree', '--name-only', 'FETCH_HEAD', 'tracks/'], capture_output=True, text=True, cwd=record.ROOT)
        if listed.returncode != 0: print('unknown', 'data branch not read'); return
        updated = None   # the branch is there and this slate has no file yet
    else:
        try: updated = json.loads(shown.stdout).get('updated')
        except Exception: print('unknown', 'slate file not read'); return
    print(*verdict(events, updated, now))

if __name__ == '__main__': main()
