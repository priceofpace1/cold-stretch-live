// Where this copy of the site lives and how it pays for itself. One file to edit; nothing else names an owner.
// Every slot is off until its value is filled in, and a slot that is off draws nothing on the page.

export const SITE = {
  name: 'The Price of Pace',
  tagline: 'College basketball live totals, measured against a fair number',

  // Address the recorder's files are served from, ending in a slash.
  // Empty: worked out from a github.io address, which is all a site without its own domain needs.
  data: 'https://raw.githubusercontent.com/priceofpace1/cold-stretch-live/data/',

  // Public link to the code and recorded data. Empty: no link is shown.
  source: '',

  // Contact address shown on the About page, for example hello@example.com. Empty: none shown.
  contact: '',

  // Cloudflare Web Analytics token. Counts visits without cookies. Empty: nothing is loaded.
  analytics: '',

  // Email list. `action` is the address the provider gives for a plain HTML form; `field` is the name it expects
  // for the email input. Empty action: the signup box is not drawn.
  newsletter: {
    action: '',
    field: 'email',
    pitch: 'One short email on game days: the slate, any signals, and the running record.',
  },

  // Invite link to the alerts channel (a Discord invite, for example), drawn as a button beside the headline.
  // Empty url: no button is drawn.
  alerts: { label: 'Get alerts', url: '' },

  // Where the bet button on an open signal can send a reader. Each browser remembers its reader's choice.
  // `book` uses the link the odds feed carries for the exact live total; `hosts` lists where such a link may lead.
  // A prediction market is opened at the game's own page: {event} is the market's event ticker in lower case.
  // The Coinbase address has not been confirmed on a phone; if it does not open the game, correct it here.
  venues: {
    book: { name: 'Sportsbook', hosts: ['sportsbook.draftkings.com'] },
    coinbase: { name: 'Coinbase', event: 'https://www.coinbase.com/predictions/event/{event}' },
    kalshi: { name: 'Kalshi', event: 'https://kalshi.com/markets/kxncaambtotal/mens-college-basketball-total-points/{event}' },
  },

  // Sportsbook referral link, shown beside a live signal. Empty url: no link is drawn and the About page says the
  // site carries no paid links. Take flat per-signup terms only; the disclosure on the About page says so.
  book: { name: '', url: '' },

  // Coinbase prices beside the game total, read from Kalshi's public market data (Coinbase's prediction markets route to
  // Kalshi). Off: nothing is fetched or drawn. A visitor can turn it on for their own browser with ?coinbase=1 and off
  // with ?coinbase=0, so it can be tried on the live address before anyone else sees it. `fee` is the per-contract
  // estimate added for Coinbase on top of Kalshi's published fee, in dollars. `dev` and `margin` are the entry rule
  // for alerts: the three-minute average that far out, and a contract that beats its price plus fees by that much.
  // `allowed` is the master switch. While it is false nothing is fetched from the exchange or drawn for anyone, the
  // per-browser ?coinbase=1 included, and no prediction market is offered as a venue. It stays false until the exchange
  // has given written permission to display its market data.
  coinbase: { allowed: false, on: false, fee: 0.02, dev: 2, margin: 0.05 },

  // A link for readers who want to chip in (a payment page under the site's name, never a personal one).
  // Empty url: no link is drawn.
  support: { label: 'Support the site', url: '' },
};

/** The recorder's base address: an explicit ?data= wins, then the config, then a github.io address, then a local folder. */
export function dataBase(loc = globalThis.location, site = SITE) {
  const slash = (u) => u.replace(/\/?$/, '/');
  const q = new URLSearchParams(loc.search || '').get('data');
  if (q) return slash(q);
  if (site.data) return slash(site.data);
  const m = /^(.+)\.github\.io$/.exec(loc.hostname || ''), repo = (loc.pathname || '').split('/')[1];
  return m && repo ? `https://raw.githubusercontent.com/${m[1]}/${repo}/data/` : 'data/';
}

/** Whether this browser shows Coinbase prices: ?coinbase=1 or 0 sets it and is remembered; otherwise the setting. */
export function coinbaseOn(loc = globalThis.location, site = SITE, store = globalThis.localStorage) {
  if (!(site.coinbase && site.coinbase.allowed)) return false; // the master switch: off for everyone, whatever a browser remembers
  const q = new URLSearchParams((loc && loc.search) || '').get('coinbase');
  try {
    if (q === '1' || q === '0') store.setItem('csl.coinbase', q);
    const saved = store.getItem('csl.coinbase');
    if (saved === '1' || saved === '0') return saved === '1';
  } catch { /* no storage: the query string alone decides */ if (q === '1' || q === '0') return q === '1'; }
  return !!(site.coinbase && site.coinbase.on);
}

/** Only https links leave the site, and only a real-looking address is offered for mail. */
export const safeLink = (u) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : '');
export const safeMail = (a) => (/^[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}$/i.test(a || '') ? a : '');
