// Alerts in the reader's own browser: a sound, a buzz and a notification when a signal fires while the page is open.
// Nothing here talks to a server. A page can only alert while the browser is running it, so on a phone the page has
// to be open on screen; an alert that reaches a locked phone has to be sent by the recorder, which is another piece.
//
// The sounds are synthesized here, a few oscillators each, so there is no audio file to load or to license.

const KEY = 'csl.signal-alerts';

/** The sounds a reader can choose for a new signal. A win and a loss have their own. */
export const SOUNDS = { horn: 'Arena horn', duck: 'Duck', boing: 'Boing', whistle: 'Slide whistle', register: 'Cash register' };
export const WIN_SOUND = 'register', LOSS_SOUND = 'trombone';

/** The reader's choices, remembered in this browser. `coarse`: a touch screen, where keeping the screen awake is the default. */
export function loadPrefs(store, coarse = false) {
  const base = { on: false, sound: 'horn', results: true, awake: !!coarse };
  try {
    const p = JSON.parse((store && store.getItem(KEY)) || 'null');
    if (!p || typeof p !== 'object') return base;
    return { on: p.on === true, sound: SOUNDS[p.sound] ? p.sound : base.sound, results: p.results !== false, awake: typeof p.awake === 'boolean' ? p.awake : base.awake };
  } catch { return base; }
}
export function savePrefs(store, p) { try { store.setItem(KEY, JSON.stringify(p)); } catch { /* not remembered */ } }

/** The standing signals not yet alerted. `seen` is a Set of signal ids; `on` is the list standing now, each with `sid`. */
export const fresh = (seen, on) => on.filter((x) => !seen.has(x.sid));

/**
 * The signals that settled since the last look: open then, won or lost now. A signal first seen already settled is not
 * news, which is what keeps a page from announcing the whole day when it loads. `prev` is a Map of key to result, or null.
 */
export function settledSince(prev, now) {
  if (!prev) return [];
  return now.filter((x) => prev.get(x.key) === 'Pending' && (x.result === 'Won' || x.result === 'Lost'));
}

/* ---------- sound ---------- */
let ctx = null;
/** The audio context, made on first use. A browser keeps it silent until the reader has touched the page once. */
export function audio() {
  if (!ctx) { const C = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext); if (!C) return null; ctx = new C(); }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export const audioReady = () => !!ctx && ctx.state === 'running';

function env(g, t, attack, peak, decay) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}
function tone(c, out, { type = 'sine', f, f2 = null, t, dur, peak = 0.3, attack = 0.012, vib = 0, vibHz = 6, vib2 = null, hold = false }) {
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  if (vib) {
    const l = c.createOscillator(), lg = c.createGain();
    l.frequency.value = vibHz; lg.gain.setValueAtTime(vib, t);
    if (vib2 != null) lg.gain.linearRampToValueAtTime(vib2, t + dur);
    l.connect(lg); lg.connect(o.frequency); l.start(t); l.stop(t + dur + 0.05);
  }
  // a held note (a horn, a whistle) stays at its level and lets go at the end; anything struck (a bell, a spring) dies away from the start
  if (hold) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + attack); g.gain.setValueAtTime(peak, t + Math.max(attack, dur - 0.09)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur); } else env(g, t, attack, peak, Math.max(0.02, dur - attack));
  o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.06);
}
function hiss(c, out, { t, dur, peak = 0.2, from = 2500 }) {
  const n = Math.ceil(c.sampleRate * dur), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < n; i += 1) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource(), hp = c.createBiquadFilter(), g = c.createGain();
  s.buffer = buf; hp.type = 'highpass'; hp.frequency.value = from;
  env(g, t, 0.004, peak, dur);
  s.connect(hp); hp.connect(g); g.connect(out); s.start(t); s.stop(t + dur + 0.02);
}
function through(c, out, type, freq, q = 1) { const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q; f.connect(out); return f; }

const PLAY = {
  // the horn at the end of a half: a stack of rough tones a little out of tune with each other
  horn(c, out, t) { const lp = through(c, out, 'lowpass', 1900); for (const f of [116.5, 233.1, 235.4, 277.2, 349.2, 351.9]) tone(c, lp, { type: 'sawtooth', f, t, dur: 1.2, peak: 0.1, attack: 0.03, hold: true }); },
  // two quacks: a buzzy tone falling fast through a nasal filter
  duck(c, out, t) { const bp = through(c, out, 'bandpass', 1150, 3.5); for (const at of [t, t + 0.21]) tone(c, bp, { type: 'sawtooth', f: 560, f2: 300, t: at, dur: 0.16, peak: 1.4, attack: 0.008, hold: true }); },
  // a spring: the pitch drops while it wobbles harder
  boing(c, out, t) { tone(c, out, { type: 'triangle', f: 480, f2: 105, t, dur: 0.85, peak: 0.45, attack: 0.005, vib: 12, vib2: 70, vibHz: 17 }); },
  // up the slide and back down
  whistle(c, out, t) { tone(c, out, { f: 430, f2: 1750, t, dur: 0.42, peak: 0.3, attack: 0.03, hold: true }); tone(c, out, { f: 1750, f2: 520, t: t + 0.43, dur: 0.38, peak: 0.3, attack: 0.01, hold: true }); },
  // the drawer, then two bells
  register(c, out, t) {
    hiss(c, out, { t, dur: 0.07, peak: 0.25 });
    for (const [at, f] of [[t + 0.09, 1568], [t + 0.23, 2093]]) { tone(c, out, { f, t: at, dur: 0.95, peak: 0.28, attack: 0.004 }); tone(c, out, { f: f * 2.01, t: at, dur: 0.5, peak: 0.1, attack: 0.004 }); }
  },
  // four notes down, the last one sagging
  trombone(c, out, t) {
    const lp = through(c, out, 'lowpass', 950, 2);
    [[233.1, 0.3], [220, 0.3], [207.7, 0.3]].forEach(([f, d], i) => tone(c, lp, { type: 'sawtooth', f, f2: f * 0.985, t: t + i * 0.34, dur: d, peak: 0.3, attack: 0.03, vib: 3, vibHz: 5.5, hold: true }));
    tone(c, lp, { type: 'sawtooth', f: 196, f2: 168, t: t + 1.02, dur: 1.1, peak: 0.32, attack: 0.03, vib: 5, vibHz: 5.5, hold: true });
  },
};
export const hasSound = (name) => !!PLAY[name];
/** Writes one sound into any audio context at time t; the page plays through `play`, and a check can render it offline. */
export const draw = (name, c, out, t) => PLAY[name](c, out, t);

/** Plays one of the sounds. False when the browser has no audio or the name is not one of them. */
export function play(name) {
  const c = audio();
  if (!c || !PLAY[name]) return false;
  const out = c.createGain(); out.gain.value = 0.85; out.connect(c.destination);
  PLAY[name](c, out, c.currentTime + 0.04);
  return true;
}

/** A phone that can buzz, buzzes. */
export function buzz() { try { return !!(navigator.vibrate && navigator.vibrate([180, 80, 180, 80, 420])); } catch { return false; } }

/* ---------- notifications ---------- */
export const canNotify = () => typeof Notification !== 'undefined';
export const notifyState = () => (canNotify() ? Notification.permission : 'unsupported');
export async function askNotify() {
  if (!canNotify()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return 'denied'; }
}
let reg = null;
/** The worker exists only to post notifications where a page is not allowed to (phones), and to open the game when one is tapped. */
export async function worker() {
  if (reg || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return reg;
  try { reg = await navigator.serviceWorker.register('sw.js'); } catch { reg = null; }
  return reg;
}
export async function notify(title, body, url, tag) {
  if (!canNotify() || Notification.permission !== 'granted') return false;
  const opt = { body, tag, renotify: true, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url } };
  try { const r = reg || await worker(); if (r && r.showNotification) { await r.showNotification(title, opt); return true; } } catch { /* fall through to the page's own */ }
  try { const n = new Notification(title, opt); n.onclick = () => { window.focus(); if (url) window.location.hash = url; n.close(); }; return true; } catch { return false; }
}

/* ---------- screen ---------- */
let lock = null;
/** Holds the screen awake while the page is in front, where the browser allows it. A lock is dropped whenever the page is hidden, so this is asked again each time it comes back. */
export async function keepAwake(on) {
  try {
    if (!on) { if (lock) await lock.release(); lock = null; return false; }
    if (typeof navigator === 'undefined' || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return false;
    if (lock && !lock.released) return true;
    lock = await navigator.wakeLock.request('screen');
    return true;
  } catch { lock = null; return false; }
}
export const canStayAwake = () => typeof navigator !== 'undefined' && 'wakeLock' in navigator;
