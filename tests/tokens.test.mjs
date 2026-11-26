// The palette is chosen by measurement. These checks fail the build if a colour change breaks legibility.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
const root = /:root\s*\{([^}]*)\}/.exec(css)[1];
const token = Object.fromEntries([...root.matchAll(/--([a-z-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [m[1], m[2]]));

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const linear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (hex) => { const [r, g, b] = channels(hex).map(linear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// Machado, Oliveira and Fernandes (2009), full dichromacy.
const VISION = {
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const lab = ([r, g, b]) => {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const seen = (hex, m) => { const c = channels(hex).map(linear); return m ? m.map((row) => Math.max(0, Math.min(1, row[0] * c[0] + row[1] * c[1] + row[2] * c[2]))) : c; };
const distance = (a, b, m) => Math.hypot(...lab(seen(a, m)).map((v, i) => v - lab(seen(b, m))[i]));

test('the stylesheet defines every colour the checks rely on', () => {
  for (const k of ['ground', 'panel', 'ink', 'sub', 'faint', 'book', 'fair', 'home', 'book-tint', 'fair-tint', 'rule-strong']) assert.match(token[k] || '', /^#/, k);
});

test('every text colour clears WCAG AA (4.5 to 1) on every surface it sits on', () => {
  for (const text of ['ink', 'sub', 'faint', 'book', 'fair', 'home']) {
    for (const surface of ['ground', 'panel']) {
      const ratio = contrast(token[text], token[surface]);
      assert.ok(ratio >= 4.5, `${text} on ${surface} is ${ratio.toFixed(2)} to 1`);
    }
  }
  for (const tint of ['book-tint', 'fair-tint']) assert.ok(contrast(token.ink, token[tint]) >= 7, `ink on ${tint}`);
});

test('body text clears AAA (7 to 1) on the page', () => {
  assert.ok(contrast(token.ink, token.ground) >= 7);
  assert.ok(contrast(token.sub, token.panel) >= 7);
});

test('graphic marks clear 3 to 1 against the panel', () => {
  for (const mark of ['book', 'fair', 'home', 'faint']) assert.ok(contrast(token[mark], token.panel) >= 3, mark);
});

test('book and fair are told apart by lightness alone, which no form of colour blindness removes', () => {
  // The site is black, white and greys. The sportsbook is black and fair is a mid grey; the lines also differ in kind.
  const L = (hex, m) => lab(seen(hex, m))[0];
  assert.ok(L(token.fair) - L(token.book) >= 40, 'full colour vision');
  for (const [name, m] of Object.entries(VISION)) assert.ok(L(token.fair, m) - L(token.book, m) >= 40, name);
  assert.ok(contrast(token.fair, token.panel) >= 4.5, 'fair is still dark enough to read');
});
