// Alerts in the reader's browser: what counts as news, and what a reader's choices default to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOUNDS, WIN_SOUND, LOSS_SOUND, hasSound, loadPrefs, savePrefs, fresh, settledSince } from '../js/alerts.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

test('alerts are off until a reader turns them on, and the choices are remembered', () => {
  const st = mem();
  assert.deepEqual(loadPrefs(st), { on: false, sound: 'horn', results: true, awake: false });
  assert.equal(loadPrefs(st, true).awake, true, 'a touch screen keeps itself awake by default');
  savePrefs(st, { on: true, sound: 'duck', results: false, awake: false });
  assert.deepEqual(loadPrefs(st, true), { on: true, sound: 'duck', results: false, awake: false });
  st.setItem('csl.signal-alerts', '{"on":"yes","sound":"klaxon"}');
  assert.deepEqual(loadPrefs(st), { on: false, sound: 'horn', results: true, awake: false }, 'anything unrecognised falls back');
  st.setItem('csl.signal-alerts', 'not json');
  assert.equal(loadPrefs(st).on, false);
  assert.equal(loadPrefs(null).on, false, 'a browser with storage switched off');
});

test('every sound a reader can pick, and the two for results, can be played', () => {
  for (const k of Object.keys(SOUNDS)) assert.ok(hasSound(k), k);
  assert.ok(hasSound(WIN_SOUND) && hasSound(LOSS_SOUND));
  assert.ok(!hasSound('klaxon'));
});

test('a signal alerts once: the first time it stands', () => {
  const seen = new Set(['a']);
  assert.deepEqual(fresh(seen, [{ sid: 'a' }, { sid: 'b' }]).map((x) => x.sid), ['b']);
  assert.deepEqual(fresh(seen, []), []);
});

test('a result is news only if the signal was open at the last look', () => {
  const now = [{ key: 'a', result: 'Won' }, { key: 'b', result: 'Lost' }, { key: 'c', result: 'Pending' }, { key: 'd', result: 'Won' }];
  assert.deepEqual(settledSince(null, now), [], 'the first look announces nothing');
  const prev = new Map([['a', 'Pending'], ['b', 'Lost'], ['c', 'Pending']]);
  assert.deepEqual(settledSince(prev, now).map((x) => x.key), ['a'], 'b had already lost, c is still open, d was never seen open');
  assert.deepEqual(settledSince(prev, [{ key: 'a', result: 'Push' }]), [], 'a push makes no sound');
});

test('the worker caches nothing and answers no requests', () => {
  const sw = readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
  assert.doesNotMatch(sw, /addEventListener\('fetch'|caches\./);
  assert.match(sw, /notificationclick/);
});
