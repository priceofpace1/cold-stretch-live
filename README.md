# The Price of Pace

A live board for one question about college basketball totals: **when a team goes cold, does the book's live number drop further than it should?**

The site is served from this repository by GitHub Pages. Where it lives, and every way it pays for itself, is set in one file: `js/site.js`.

The board opens with the slate in one sentence: how far DraftKings' live total has run from a fair final-score estimate, and which way it missed. Under it, every game with a line gets a small chart of fair minus book by game minute, all on one scale: a shaded no-trade band, colour where a reading leaves it, and a dotted line two standard deviations out. A table view puts the same games on one row each. Open a game to see the book's number and the fair number minute by minute, above the score flow for both teams. A recorder saves every game's live line as it happens, and a ledger settles each signal against the final score.

## How it works

```
ESPN scoreboard, play-by-play          every 20 s, from the browser
ESPN odds feed (DraftKings pregame, DraftKings live)
        │
        ▼
index.html + js/      the board, the game view, the record
model.json            fair-total model, one row per game minute
        ▲
        │  recorded tracks, ledger, daily summary (raw files on the `data` branch)
        │
recorder/record.py    GitHub Action, every 30 s while games are on
```

There is no server. The page reads ESPN directly; the only stored data is what the recorder commits to the `data` branch. ESPN drops the live line at the final whistle and keeps no history, so recording it as it happens is the only way to keep it.

| Path | What it is |
| --- | --- |
| `index.html`, `css/app.css` | The page. |
| `js/model.js` | The model and the signal rules. Pure functions, shared with the tests. |
| `js/espn.js` | Fetching and parsing ESPN's feeds. |
| `js/charts.js` | The trend panels, the range plot, the histogram and the two-pane game chart. |
| `js/app.js` | State, polling, routing and rendering. |
| `model.json` | Coefficients by game minute, and the distribution used for chances. |
| `recorder/record.py` | The recorder. Standard library only. |
| `fonts/`, `vendor/` | IBM Plex Sans, Newsreader and d3, served from this site. No third-party requests except ESPN and the recorded data. |
| `tests/` | Model parity between JavaScript and Python, parsers against real ESPN responses, recorder behaviour, palette contrast. |

## The fair number

Fair is the current score plus a rest-of-game estimate. For each minute of the game the estimate uses:

- the pace the closing total and spread implied for the time left,
- how far each team is ahead of or behind that pace,
- the lead.

It was fitted on 16,086 Division I games with closing lines, 2022–23 through December 2025. The headline from that history: teams that fall behind their pace go back to scoring at about their normal rate, and almost none of the lost points come back. So a fair live total sits close to *current score + normal pace for the time left*, well above what the cold stretch alone would project.

The chance of an over comes from how far real games landed from the estimate, not from a bell curve.

## Signals

Signals are judged on a **three-minute rolling average** of fair minus book, recalculated at every reading (about every 60 seconds), and measured in **deviations**.

Why an average: across 16,086 games, ordinary scoring moves the fair number 2.3 points a minute at every stage of the game. A single reading's gap is mostly timing, the score updating before the line does. On the first recorded slate 76% of large single-reading gaps were gone a minute later, and it was fair that closed them, not the book. Averaging three minutes removes that at almost no cost in accuracy (a 14.2-point miss to the final against 14.1 at minute 10).

Why deviations: one deviation is the standard deviation of that average, in points, measured on completed slates: 1.23 for game totals and 0.78 for implied team totals on the first slate. It is about the same number of points early and late. What a point is worth is not: the model's rest-of-game standard deviation falls from 15 points at minute 4 to 8 at minute 34, so the same gap is a bigger edge late. The chance test covers that.

A signal is the first time the average sits **2 or more deviations from zero, at a price the model's chance beats by five points over break-even**. Readings from minute 2 feed the average; signals fire between minute 4 and minute 34, never at a 15-point lead, never on a 20-point pregame spread. A watch tier starts at 1.5. Both sides are logged:

- **Over**: the book is under fair. This is the cold-stretch case.
- **Under**: the book is over fair, usually a hot pace carried too far.

The recorder stores the yardstick with each day and re-estimates it from completed slates only, so a slate is never judged with its own data. It also runs nine rules on every slate (the three-minute average at 1.5, 2, 2.5 and 3 deviations; two- and five-minute averages at 2; single readings at 2, at 3, and at 2 after 1.5) and splits each by stage of the game (`ladder.json`), so the rule can be chosen on outcomes. When the rules change (`RULES_VERSION`), the recorder judges every stored slate again from its readings the next time it starts. A slate keeps the yardstick it was first judged with.

Lopsided spots (a 20-point pregame spread, a 15-point lead) are left out of the signal, the yardstick and the daily summary. Across 971 games with a 20-point spread in three seasons the fair number ran about a point high (final 1.35 under fair at halftime, standard error 0.34), against 0.1 in other games. The same rule is still run on those spots as a tenth row of the ladder (`lopsided`) and shown on the game page beside the signals, so the exclusion can be judged on results. On the trend charts those stretches are filled grey.

The average decides whether there is a signal and on which side; the chance is worked out on the reading's own gap, so the line and price logged are ones that still carry the edge when the signal fires. An average exists only when the window holds three readings reaching back two and a half minutes, and the recorder and the browser keep every poll as a reading, changed or not, so halftime is covered like any other stretch. Signals fire on the game total alone, between minute 4 and minute 34.

The record does not change when the rule does. `RULE_STARTS` in the recorder (and `RULE_HISTORY` in `js/model.js`, shown on the About page) lists every version of the rule with the first slate it was scored live on. A slate scored live keeps the signals logged that day: the recorder settles and annotates them and never judges them again. Slates from before `RULES.liveSince` are judged under the current rule after the fact and shown apart. On a past slate the board and game pages draw the ledger's signals, so every visitor sees the same list.

Each logged signal also carries `later`: the line, price and whether the edge was still there at the first reading 30, 60 and 120 seconds on. The Record page uses it to show what someone a little late would have got.

Ideas under test (`IDEAS` in the recorder) are the signal with one thing changed: team totals (dropped on November 22), carrying on to minute 38 (the rule until then), firing again after the gap closes, and the original cold-stretch buy (the over when scoring is well behind pace), in ordinary and in lopsided games. They get their own table on the Record page and are never part of the record.

While a signal is open the site says whether it can still be bet: `signalNow` in `js/model.js` puts the signal's side through the same price test on the line showing now ("still on", or "edge gone" once the line or the game has moved; a game total showing no price counts as off the board). It reads "New" for three minutes after it fires, and the browser tab carries the number of open signals.

A reading taken at the end of regulation is dropped by the app: if the game is tied it already carries the overtime line.

Game totals are settled at DraftKings' live price. Team totals were implied from the live total and spread, (total ± spread) / 2, and priced at an estimated -115, because the feed carries no posted team-total market. They were dropped from the signal on November 22; the ones logged before then stay in the ledger and are counted apart.

`recorder/watchdog.py`, run every ten minutes by the `watchdog` workflow, checks that the recorder has saved in the last fifteen minutes whenever a game is on or about to start, and starts it again when it has not.

Readings where the game clock runs faster than the wall clock, or backwards, are dropped. ESPN's clock does that occasionally.

## Coinbase prices (switched off)

Coinbase's prediction markets trade Kalshi's contracts at Kalshi's prices, with Coinbase's own fee on top. With `coinbase.on` in `js/site.js`, or `?coinbase=1` in one browser, the page reads Kalshi's public market data (no login) for the men's college basketball total-points ladders (`KXNCAAMBTOTAL`, overtime counts) and, for each live game it can match by team names:

- puts the price beside an open game-total signal: the contract on that side with the biggest edge, `chance − price − fees`;
- shows five strikes around the fair number on the game page, the price to buy each side and the model's chance;
- calls it an **entry** when the site's own test holds on the three-minute average (2 deviations, inside the window, not lopsided) and a contract on that side beats its price plus fees by five cents. Entries are listed on the board, and the game page can raise a browser notification for each, once, while the page is open.

Fees are Kalshi's published taker fee (7% of p × (1 − p), rounded up to the cent) plus an estimate for Coinbase's, which it does not publish (`coinbase.fee`). Team totals have no matching Kalshi ladder, so they show no Coinbase price. The site never signs in anywhere and places nothing.

## Design

Two colours carry meaning and nothing else does. Orange is the sportsbook's number, blue is the fair number.

- **Colour.** Orange against blue stays far apart for red-green colour blindness, where red against green nearly collapses. Every text colour clears 4.5 to 1 against every surface, and body text clears 7 to 1. `tests/tokens.test.mjs` checks all of it against `css/app.css`, so a colour change that breaks legibility fails the build.
- **Type.** IBM Plex Sans for text and figures: its numerals are tabular by default, so columns align without a feature flag, and its width axis tightens number rows on a phone. Newsreader for headlines, with its optical-size axis so large sizes get the display cut.
- **Marks.** The book is always a stepped line (a posted number that jumps), fair is always a continuous one, so the two read apart without colour.

## Keys

| Where | Key | Does |
| --- | --- | --- |
| Board | `j` / `k` | Move down / up |
| Board | `Enter` | Open the game |
| Board | `[` / `]` / `t` | Previous day / next day / today |
| Board | `s` | Signals only |
| Game | `1` / `2` / `3` | Game total / away team / home team |
| Game | `Esc` | Back to the board |

Every view has its own link, so a game and market can be shared directly.

## Site settings (`js/site.js`)

Nothing else in the code names an owner or an address. Each slot draws nothing until it is filled in.

| Setting | What it does |
|---|---|
| `name`, `tagline` | Masthead and page title. |
| `data` | Address of the recorder's files. Needed on a custom domain; a github.io address works it out. |
| `source`, `contact` | Optional footer link to the code and a contact address on the About page. |
| `analytics` | Cloudflare Web Analytics token. Counts visits without cookies. |
| `newsletter.action` | The provider's plain HTML form address. Turns on the signup box under every view. |
| `support.url` | A payment page for readers who want to chip in. Adds one footer link and a line on the About page. |
| `book.name`, `book.url` | A sportsbook referral link shown beside a live signal and marked "paid link" where it is clicked. The About page discloses it. |

For a custom domain: add a `CNAME` file with the domain, set `data` to `https://raw.githubusercontent.com/<owner>/<repo>/data/`, and point DNS at GitHub Pages.

## Run it locally

```sh
python3 -m http.server 8000
# http://localhost:8000/?data=https://raw.githubusercontent.com/<owner>/<repo>/data/
```

```sh
node --test tests/model.test.mjs tests/espn.test.mjs tests/tokens.test.mjs tests/release.test.mjs
python3 -m unittest discover -s tests
python3 recorder/record.py --out store --minutes 5     # record five minutes of live games into ./store
```

After changing `model.json` or the model arithmetic, regenerate the parity fixture with `python3 tests/make_parity.py`. The JavaScript model must match the Python recorder on every case.

## Limits

- DraftKings only, through ESPN's unofficial feeds. They can lag, change or disappear.
- No posted team totals, no other books, no history of live lines before the recorder started on November 17, 2026.
- The model knows nothing about injuries, foul trouble or who is on the floor. A large gap can mean the book knows something.
- Information, not betting advice.
